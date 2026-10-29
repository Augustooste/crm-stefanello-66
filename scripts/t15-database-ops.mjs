import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const REPOSITORY_ROOT = process.cwd();
const DEFAULT_DATABASE_ENV = "ACELERAFLOW_PROD_DATABASE_URL";
const INVENTORY_SQL = path.join(REPOSITORY_ROOT, "scripts/t15-production-inventory.sql");
const EXPECTED_INVENTORY_SECTIONS = [
  "migrations",
  "extensions",
  "tables",
  "functions",
  "triggers",
  "policies",
  "grants",
  "cron",
  "feature_flags",
  "backlog",
  "telemetry_last_hour",
];

function parseArguments() {
  const [mode, ...rawArgs] = process.argv.slice(2);
  const values = new Map();
  const flags = new Set();

  for (const arg of rawArgs) {
    if (!arg.startsWith("--")) throw new Error(`argumento inválido: ${arg}`);
    const separator = arg.indexOf("=");
    if (separator === -1) flags.add(arg.slice(2));
    else values.set(arg.slice(2, separator), arg.slice(separator + 1));
  }

  return { mode, values, flags };
}

function help() {
  return `Uso:
  node scripts/t15-database-ops.mjs inventory --output=/caminho/inventory.json [--database-env=NOME] [--project-ref=REF] [--allow-local]
  node scripts/t15-database-ops.mjs backup --output-dir=/caminho/seguro [--database-env=NOME] [--project-ref=REF] [--allow-local] [--ack-managed-restore-limit]

O URL do banco é lido somente do ambiente (padrão: ${DEFAULT_DATABASE_ENV}).
Ele nunca é aceito por argumento nem gravado na saída.

O dump lógico é backup secundário. Em Supabase gerenciado, o restore integral
exige snapshot nativo ou um alvo com privilégios de plataforma equivalentes.`;
}

function valueOr(values, name, fallback) {
  const value = values.get(name);
  return value === undefined || value === "" ? fallback : value;
}

async function projectRefFromConfig() {
  const config = await readFile(path.join(REPOSITORY_ROOT, "supabase/config.toml"), "utf8");
  const match = config.match(/^\s*project_id\s*=\s*"([^"]+)"\s*$/m);
  if (!match) throw new Error("project_id não encontrado em supabase/config.toml");
  return match[1];
}

function validateDatabaseTarget(databaseUrl, projectRef, allowLocal) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("URL do banco inválido");
  }

  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("o URL precisa usar postgres:// ou postgresql://");
  }

  const hostname = parsed.hostname.toLowerCase();
  const username = decodeURIComponent(parsed.username);
  const local = hostname === "127.0.0.1" || hostname === "localhost";
  if (local && !allowLocal) {
    throw new Error("alvo local exige --allow-local");
  }
  if (
    !local &&
    !hostname.includes(projectRef.toLowerCase()) &&
    !username.toLowerCase().endsWith(`.${projectRef.toLowerCase()}`)
  ) {
    throw new Error(`o URL não corresponde ao project ref ${projectRef}`);
  }

  return { hostname, local };
}

function redact(text, secret) {
  return String(text).split(secret).join("[DATABASE_URL_REDACTED]");
}

function databaseEnvironment(databaseUrl) {
  const parsed = new URL(databaseUrl);
  const connection = {
    ...process.env,
    PGAPPNAME: "aceleraflow-t15",
    PGCONNECT_TIMEOUT: "15",
    PGDATABASE: decodeURIComponent(parsed.pathname.replace(/^\/+/, "")) || "postgres",
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || "5432",
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGUSER: decodeURIComponent(parsed.username),
  };
  const parameterEnvironment = {
    channel_binding: "PGCHANNELBINDING",
    gssencmode: "PGGSSENCMODE",
    sslcert: "PGSSLCERT",
    sslkey: "PGSSLKEY",
    sslmode: "PGSSLMODE",
    sslrootcert: "PGSSLROOTCERT",
    target_session_attrs: "PGTARGETSESSIONATTRS",
  };
  for (const [parameter, environmentName] of Object.entries(parameterEnvironment)) {
    const value = parsed.searchParams.get(parameter);
    if (value) connection[environmentName] = value;
  }
  return connection;
}

function run(command, args, { databaseUrl, capture = true, connect = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: REPOSITORY_ROOT,
      env: connect ? databaseEnvironment(databaseUrl) : process.env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    if (capture) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
    }
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const safeError = redact(stderr, databaseUrl);
      if (code !== 0) {
        reject(new Error(`${command} falhou com exit ${code}: ${safeError.trim()}`));
        return;
      }
      resolve({ stdout, stderr: safeError });
    });
  });
}

async function gitSha(databaseUrl) {
  const result = await run("git", ["rev-parse", "HEAD"], { databaseUrl });
  return result.stdout.trim();
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function safeTimestamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function ensureAbsolute(target, label) {
  if (!target || !path.isAbsolute(target)) {
    throw new Error(`${label} deve ser um caminho absoluto`);
  }
  return path.normalize(target);
}

function ensureBackupOutsideRepository(outputDirectory) {
  if (outputDirectory === path.parse(outputDirectory).root) {
    throw new Error("backup não pode usar a raiz do filesystem");
  }
  const relative = path.relative(REPOSITORY_ROOT, outputDirectory);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("backup deve ficar fora do repositório");
  }
}

async function runInventory({ databaseUrl, projectRef, target, targetInfo }) {
  const outputPath = ensureAbsolute(target, "--output");
  const result = await run(
    "psql",
    [
      "--no-psqlrc",
      "--no-password",
      "--set=ON_ERROR_STOP=1",
      "--no-align",
      "--tuples-only",
      "--quiet",
      `--file=${INVENTORY_SQL}`,
    ],
    { databaseUrl, connect: true },
  );
  const sections = {};
  const sectionAvailability = {};
  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    const parsed = JSON.parse(line);
    if (!parsed.section || !Array.isArray(parsed.rows)) {
      throw new Error("linha inesperada no inventário SQL");
    }
    if (Object.hasOwn(sections, parsed.section)) {
      throw new Error(`seção duplicada no inventário SQL: ${parsed.section}`);
    }
    sections[parsed.section] = parsed.rows;
    sectionAvailability[parsed.section] = parsed.available !== false;
  }
  const missingSections = EXPECTED_INVENTORY_SECTIONS.filter(
    (section) => !Object.hasOwn(sections, section),
  );
  const unexpectedSections = Object.keys(sections).filter(
    (section) => !EXPECTED_INVENTORY_SECTIONS.includes(section),
  );
  if (missingSections.length > 0 || unexpectedSections.length > 0) {
    throw new Error(
      `seções inválidas no inventário: ausentes=${missingSections.join(",") || "nenhuma"}; inesperadas=${unexpectedSections.join(",") || "nenhuma"}`,
    );
  }

  const manifest = {
    schema_version: 1,
    kind: "t15-production-inventory",
    captured_at: new Date().toISOString(),
    git_sha: await gitSha(databaseUrl),
    project_ref: projectRef,
    database_host: targetInfo.hostname,
    local_validation: targetInfo.local,
    contains_business_rows: false,
    section_availability: sectionAvailability,
    sections,
  };
  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await chmod(outputPath, 0o600);
  console.log(`Inventário criado: ${outputPath}`);
  console.log(`Seções: ${Object.keys(sections).length}`);
}

async function runBackup({ databaseUrl, projectRef, target, targetInfo }) {
  const outputDirectory = ensureAbsolute(target, "--output-dir");
  ensureBackupOutsideRepository(outputDirectory);
  const createdDirectory = await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  if (createdDirectory) await chmod(outputDirectory, 0o700);

  const prefix = `aceleraflow-${projectRef}-${safeTimestamp()}`;
  const dumpPath = path.join(outputDirectory, `${prefix}.dump`);
  const listPath = path.join(outputDirectory, `${prefix}.restore-list.txt`);
  const manifestPath = path.join(outputDirectory, `${prefix}.manifest.json`);

  try {
    await writeFile(dumpPath, "", { mode: 0o600, flag: "wx" });
    await chmod(dumpPath, 0o600);
    await run(
      "pg_dump",
      ["--no-password", "--format=custom", "--compress=9", `--file=${dumpPath}`],
      {
        databaseUrl,
        connect: true,
      },
    );
    await chmod(dumpPath, 0o600);

    const restore = await run("pg_restore", ["--list", dumpPath], { databaseUrl });
    await writeFile(listPath, restore.stdout, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(listPath, 0o600);

    const dumpStats = await stat(dumpPath);
    const archiveEntries = restore.stdout
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith(";")).length;
    if (dumpStats.size === 0 || archiveEntries === 0) {
      throw new Error("backup vazio ou sem entradas indexadas");
    }

    const version = await run("pg_dump", ["--version"], { databaseUrl });
    const manifest = {
      schema_version: 1,
      kind: "t15-production-backup",
      created_at: new Date().toISOString(),
      git_sha: await gitSha(databaseUrl),
      project_ref: projectRef,
      database_host: targetInfo.hostname,
      local_validation: targetInfo.local,
      backup_role: "secondary-logical-fallback",
      managed_restore_requires_native_snapshot_or_equivalent_platform_privileges: true,
      dump_file: path.basename(dumpPath),
      restore_list_file: path.basename(listPath),
      bytes: dumpStats.size,
      archive_entries: archiveEntries,
      sha256: await sha256File(dumpPath),
      pg_dump_version: version.stdout.trim(),
      format: "custom",
      owner_and_acl_included: true,
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(manifestPath, 0o600);

    console.log(`Backup criado: ${dumpPath}`);
    console.log(`Manifesto: ${manifestPath}`);
    console.log(`Bytes: ${dumpStats.size}; entradas indexadas: ${archiveEntries}`);
    console.log(`SHA-256: ${manifest.sha256}`);
    console.log("Limite: backup lógico secundário; snapshot nativo continua obrigatório.");
  } catch (error) {
    await Promise.all([
      unlink(dumpPath).catch(() => {}),
      unlink(listPath).catch(() => {}),
      unlink(manifestPath).catch(() => {}),
    ]);
    throw error;
  }
}

async function main() {
  const { mode, values, flags } = parseArguments();
  if (mode === "--help" || flags.has("help") || mode === undefined) {
    console.log(help());
    return;
  }
  if (!["inventory", "backup"].includes(mode)) {
    throw new Error(`modo inválido: ${mode}\n${help()}`);
  }

  const databaseEnv = valueOr(values, "database-env", DEFAULT_DATABASE_ENV);
  if (!/^[A-Z][A-Z0-9_]*$/.test(databaseEnv)) {
    throw new Error("--database-env deve ser o nome de uma variável de ambiente");
  }
  const databaseUrl = process.env[databaseEnv];
  if (!databaseUrl) throw new Error(`variável ${databaseEnv} ausente`);

  const projectRef = valueOr(values, "project-ref", await projectRefFromConfig());
  const targetInfo = validateDatabaseTarget(databaseUrl, projectRef, flags.has("allow-local"));
  if (mode === "backup" && !targetInfo.local && !flags.has("ack-managed-restore-limit")) {
    throw new Error(
      "backup remoto exige --ack-managed-restore-limit; snapshot nativo continua obrigatório",
    );
  }

  if (mode === "inventory") {
    await runInventory({
      databaseUrl,
      projectRef,
      target: values.get("output"),
      targetInfo,
    });
  } else {
    await runBackup({
      databaseUrl,
      projectRef,
      target: values.get("output-dir"),
      targetInfo,
    });
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
