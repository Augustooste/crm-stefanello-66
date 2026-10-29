import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const REPOSITORY_ROOT = process.cwd();
const OUTPUT_PATH = path.resolve(
  REPOSITORY_ROOT,
  process.env.T14_EVIDENCE_PATH ?? "docs/evidence/T14-controlled-e2e-2026-07-28.json",
);
const REPORT_PATH = path.resolve(
  REPOSITORY_ROOT,
  process.env.T14_REPORT_PATH ?? "docs/E2E-CONTROLADO-2026-07-28.md",
);
const ROUNDS = 3;

const DENO = ["deno", ["test", "--allow-env", "--allow-read", "--allow-import"]];
const DB = ["supabase", ["test", "db", "--local"]];

const TENANT_FIXTURES = {
  rag_tenant_a_user_id: "c1000000-0000-0000-0000-000000000001",
  rag_tenant_b_user_id: "d1000000-0000-0000-0000-000000000001",
};

const JOURNEYS = [
  {
    slug: "text-inbound",
    title: "texto inbound",
    acceptance: "uma resposta persistida e enviada",
    cleanup: "fetch mocks restaurados em finally; nenhuma escrita externa",
    commands: [
      [
        ...DENO,
        [
          "supabase/functions/tests/messaging-webhook.test.ts",
          "supabase/functions/tests/ai-respond.test.ts",
        ],
      ],
    ],
  },
  {
    slug: "human-handoff",
    title: "handoff humano",
    acceptance: "zero resposta da IA",
    cleanup: "fetch mocks restaurados em finally; nenhuma escrita externa",
    commands: [[...DENO, ["supabase/functions/tests/gates.test.ts"]]],
  },
  {
    slug: "meta-audio",
    title: "áudio Meta",
    acceptance: "mídia → transcript → resposta",
    cleanup: "Graph/ElevenLabs simulados; fetch mocks restaurados em finally",
    commands: [
      [
        ...DENO,
        [
          "supabase/functions/tests/messaging-webhook.test.ts",
          "supabase/functions/tests/ai-respond.test.ts",
          "supabase/functions/tests/voice-send.test.ts",
        ],
      ],
    ],
  },
  {
    slug: "worker-retry",
    title: "retry de worker",
    acceptance: "uma resposta, sem duplicata",
    cleanup: "fetch mocks restaurados em finally; nenhuma fila persistente",
    commands: [[...DENO, ["supabase/functions/tests/ai-response-worker.test.ts"]]],
  },
  {
    slug: "kanban-concurrent",
    title: "Kanban concorrente",
    acceptance: "avanço de uma etapa",
    cleanup: "pgTAP executado dentro de BEGIN/ROLLBACK",
    commands: [[...DB, ["supabase/tests/database/autonomous_pipeline_kanban.sql"]]],
  },
  {
    slug: "rag-tenant-a-b",
    title: "RAG tenant A/B",
    acceptance: "recall correto e zero vazamento",
    cleanup: "mocks restaurados e fixtures pgTAP revertidos com ROLLBACK",
    commands: [
      [...DENO, ["supabase/functions/tests/knowledge-rag.test.ts"]],
      [...DB, ["supabase/tests/database/mvp_rag_tenant_isolation.sql"]],
    ],
  },
  {
    slug: "revoked-user",
    title: "usuário revogado",
    acceptance: "Edge e banco negam",
    cleanup: "mocks restaurados e fixtures pgTAP revertidos com ROLLBACK",
    commands: [
      [...DENO, ["supabase/functions/tests/load-profile.test.ts"]],
      [...DB, ["supabase/tests/database/tenant_memberships_rbac.sql"]],
    ],
  },
  {
    slug: "forced-failures",
    title: "falhas forçadas",
    acceptance: "ai_failure_logs/system_events recebem evento",
    cleanup: "endpoints REST simulados; fetch mocks restaurados em finally",
    commands: [
      [
        ...DENO,
        [
          "supabase/functions/tests/failure-log.test.ts",
          "supabase/functions/tests/telemetry.test.ts",
        ],
      ],
    ],
  },
];

const CLEANUP_SQL = `
select json_build_object(
  'auth_users', (
    select count(*) from auth.users
    where id in (
      'a1000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-000000000001',
      'd1000000-0000-0000-0000-000000000001',
      '81111111-1111-1111-1111-111111111111',
      '82222222-2222-2222-2222-222222222222'
    )
  ),
  'profiles', (
    select count(*) from public.profiles
    where id in (
      'a1000000-0000-0000-0000-000000000001',
      'c1000000-0000-0000-0000-000000000001',
      'd1000000-0000-0000-0000-000000000001',
      '81111111-1111-1111-1111-111111111111',
      '82222222-2222-2222-2222-222222222222'
    )
  ),
  'tenant_memberships', (
    select count(*) from public.tenant_memberships
    where user_id in (
      'c1000000-0000-0000-0000-000000000001',
      'd1000000-0000-0000-0000-000000000001',
      '81111111-1111-1111-1111-111111111111',
      '82222222-2222-2222-2222-222222222222'
    )
  ),
  'kb_documents', (
    select count(*) from public.kb_documents
    where id in (
      'c2000000-0000-0000-0000-000000000001',
      'd2000000-0000-0000-0000-000000000001'
    )
  ),
  'boards', (
    select count(*) from public.boards
    where id = 'b1000000-0000-0000-0000-000000000001'
  ),
  'deals', (
    select count(*) from public.deals
    where id = 'd1000000-0000-0000-0000-000000000001'
  )
)::text;
`;

function isoNow() {
  return new Date().toISOString();
}

function displayCommand(command, args) {
  return [command, ...args].join(" ");
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const startedAt = isoNow();
    const startedMs = Date.now();
    const child = spawn(command, args, {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      stderr += `\n${error.message}`;
    });
    child.on("close", (code) => {
      resolve({
        command: options.display ?? displayCommand(command, args),
        started_at: startedAt,
        finished_at: isoNow(),
        duration_ms: Date.now() - startedMs,
        exit_code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

function parseAssertions(output) {
  const deno = output.match(/(\d+)\s+passed(?:\s+\((\d+)\s+steps\))?\s+\|\s+0\s+failed/i);
  if (deno) {
    return {
      runner: "deno",
      passed: Number(deno[1]),
      steps: deno[2] ? Number(deno[2]) : null,
      failed: 0,
    };
  }

  const pgtap = output.match(/Files=(\d+),\s+Tests=(\d+),[^]*Result:\s+PASS/i);
  if (pgtap) {
    return {
      runner: "pgtap",
      files: Number(pgtap[1]),
      passed: Number(pgtap[2]),
      failed: 0,
    };
  }

  return null;
}

function compactCommandResult(result) {
  const combined = `${result.stdout}\n${result.stderr}`;
  return {
    command: result.command,
    started_at: result.started_at,
    finished_at: result.finished_at,
    duration_ms: result.duration_ms,
    exit_code: result.exit_code,
    assertions: parseAssertions(combined),
  };
}

async function loadLocalDatabaseUrl() {
  const result = await runCommand("supabase", ["status", "-o", "env"], {
    display: "supabase status -o env",
  });
  if (result.exit_code !== 0) {
    throw new Error("supabase status -o env falhou");
  }

  const line = result.stdout.split(/\r?\n/).find((entry) => entry.startsWith("DB_URL="));
  if (!line) {
    throw new Error("DB_URL local não encontrada");
  }

  const encoded = line.slice("DB_URL=".length).trim();
  if (encoded.startsWith('"')) return JSON.parse(encoded);
  return encoded.replace(/^'|'$/g, "");
}

async function cleanupProbe() {
  let databaseUrl;
  try {
    databaseUrl = await loadLocalDatabaseUrl();
  } catch (error) {
    return {
      checked_at: isoNow(),
      exit_code: 1,
      zero_residues: false,
      residues: null,
      error: error instanceof Error ? error.message : "falha ao resolver banco local",
    };
  }

  const result = await runCommand(
    "psql",
    [databaseUrl, "--no-align", "--tuples-only", "--quiet", `--command=${CLEANUP_SQL}`],
    {
      display: "psql local-postgres --cleanup-probe",
    },
  );

  let residues = null;
  try {
    residues = JSON.parse(result.stdout.trim());
  } catch {
    // A saída bruta é preservada apenas em caso de falha, sem segredos.
  }
  const zeroResidues =
    result.exit_code === 0 &&
    residues !== null &&
    Object.values(residues).every((count) => Number(count) === 0);

  return {
    checked_at: result.finished_at,
    exit_code: result.exit_code,
    zero_residues: zeroResidues,
    residues,
    error: zeroResidues ? null : result.stderr.trim() || result.stdout.trim(),
  };
}

async function gitValue(args) {
  const result = await runCommand("git", args);
  return result.exit_code === 0 ? result.stdout.trim() : null;
}

function markdownReport(evidence) {
  const status = evidence.summary.approved ? "APROVADO" : "REPROVADO";
  const rows = evidence.rounds.flatMap((round) =>
    round.journeys.map(
      (journey) =>
        `| ${round.round} | \`${journey.correlation_id}\` | ${journey.title} | ${journey.started_at} | ${journey.duration_ms} | ${journey.status} |`,
    ),
  );
  const cleanupRows = evidence.rounds.map(
    (round) =>
      `| ${round.round} | ${round.cleanup.checked_at} | ${round.cleanup.zero_residues ? "0" : "FALHA"} | ${round.cleanup.zero_residues ? "PASS" : "FAIL"} |`,
  );

  return `# E2E controlado T14 — 2026-07-28

**Veredito:** **${status}: ${evidence.summary.passed_journeys}/${evidence.summary.total_journeys} jornadas e ${evidence.summary.clean_rounds}/${ROUNDS} cleanups sem resíduos.**

## Escopo e limite da prova

- SHA: \`${evidence.repository.sha}\`; branch: \`${evidence.repository.branch}\`.
- Ambiente: Supabase local em \`127.0.0.1:54322\`.
- Meta, Z-API, Twilio, ElevenLabs, Lovable AI e Resend foram simulados nos testes dos handlers.
- Nenhuma mensagem real foi enviada e nenhuma escrita foi feita em produção.
- Os dois tenants sintéticos do RAG foram criados por rodada a partir dos usuários \`${TENANT_FIXTURES.rag_tenant_a_user_id}\` e \`${TENANT_FIXTURES.rag_tenant_b_user_id}\`, dentro de transação revertida.

## Matriz 8 × 3

| Rodada | Correlação | Jornada | Início UTC | ms | Status |
| -----: | ---------- | ------- | ---------- | -: | ------ |
${rows.join("\n")}

## Aceites executados

| Jornada | Aceite | Prova executada |
| ------- | ------ | --------------- |
${JOURNEYS.map((journey) => {
  const commands = journey.commands
    .map(([command, baseArgs, files]) => `\`${displayCommand(command, [...baseArgs, ...files])}\``)
    .join("<br>");
  return `| ${journey.title} | ${journey.acceptance} | ${commands} |`;
}).join("\n")}

## Cleanup

| Rodada | Verificado em UTC | resíduos conhecidos | Status |
| -----: | ----------------- | ------------------: | ------ |
${cleanupRows.join("\n")}

Cada arquivo pgTAP abre \`BEGIN\` e termina em \`ROLLBACK\`. Após cada rodada,
uma consulta independente confirmou zero fixtures remanescentes em
\`auth.users\`, \`profiles\`, \`tenant_memberships\`, \`kb_documents\`,
\`boards\` e \`deals\`. Os testes Deno restauram os mocks em \`finally\`.

## Resultado

Run ID: \`${evidence.run_id}\`. Início: ${evidence.started_at}. Fim:
${evidence.finished_at}. Evidência estruturada:
\`docs/evidence/T14-controlled-e2e-2026-07-28.json\`.

Este gate aprova somente T14 local. Produção continua bloqueada até T15–T17,
incluindo reconciliação read-only, backup, autorização explícita, deploy,
canário real e relatório final.
`;
}

async function main() {
  const runId = randomUUID();
  const startedAt = isoNow();
  const sha = await gitValue(["rev-parse", "HEAD"]);
  const branch = await gitValue(["branch", "--show-current"]);
  const rounds = [];

  console.log(`T14 ${runId}: ${ROUNDS} rodadas × ${JOURNEYS.length} jornadas`);

  for (let roundNumber = 1; roundNumber <= ROUNDS; roundNumber += 1) {
    const roundCorrelation = `t14-r${roundNumber}-${runId.slice(0, 8)}`;
    const journeys = [];
    console.log(`\nRodada ${roundNumber}/${ROUNDS} — ${roundCorrelation}`);

    for (const journey of JOURNEYS) {
      const journeyStartedAt = isoNow();
      const journeyStartedMs = Date.now();
      const commandResults = [];
      console.log(`  ▶ ${journey.title}`);

      for (const [command, baseArgs, files] of journey.commands) {
        const args = [...baseArgs, ...files];
        const result = await runCommand(command, args);
        commandResults.push(compactCommandResult(result));
        if (result.exit_code !== 0) {
          const failure = `${result.stdout}\n${result.stderr}`
            .trim()
            .split("\n")
            .slice(-50)
            .join("\n");
          console.error(failure);
        }
      }

      const passed = commandResults.every((result) => result.exit_code === 0);
      const journeyResult = {
        slug: journey.slug,
        title: journey.title,
        acceptance: journey.acceptance,
        correlation_id: `${roundCorrelation}:${journey.slug}`,
        started_at: journeyStartedAt,
        finished_at: isoNow(),
        duration_ms: Date.now() - journeyStartedMs,
        status: passed ? "PASS" : "FAIL",
        cleanup_strategy: journey.cleanup,
        commands: commandResults,
      };
      journeys.push(journeyResult);
      console.log(`  ${passed ? "✓" : "✗"} ${journey.title} (${journeyResult.duration_ms} ms)`);
    }

    const cleanup = await cleanupProbe();
    console.log(`  ${cleanup.zero_residues ? "✓" : "✗"} cleanup sem resíduos`);
    rounds.push({
      round: roundNumber,
      correlation_id: roundCorrelation,
      synthetic_tenant_fixtures: TENANT_FIXTURES,
      journeys,
      cleanup,
    });
  }

  const allJourneys = rounds.flatMap((round) => round.journeys);
  const passedJourneys = allJourneys.filter((journey) => journey.status === "PASS").length;
  const cleanRounds = rounds.filter((round) => round.cleanup.zero_residues).length;
  const approved = passedJourneys === allJourneys.length && cleanRounds === ROUNDS;
  const evidence = {
    schema_version: 1,
    gate: "T14",
    run_id: runId,
    started_at: startedAt,
    finished_at: isoNow(),
    repository: { sha, branch },
    environment: {
      database: "Supabase local",
      database_endpoint: "127.0.0.1:54322",
      provider_transports: "mocked",
      production_writes: false,
      real_customer_messages: false,
    },
    rounds,
    summary: {
      total_journeys: allJourneys.length,
      passed_journeys: passedJourneys,
      failed_journeys: allJourneys.length - passedJourneys,
      clean_rounds: cleanRounds,
      approved,
    },
  };

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  await writeFile(REPORT_PATH, markdownReport(evidence), "utf8");

  console.log(
    `\nResultado: ${passedJourneys}/${allJourneys.length} jornadas; ${cleanRounds}/${ROUNDS} cleanups`,
  );
  console.log(`Evidência: ${path.relative(REPOSITORY_ROOT, OUTPUT_PATH)}`);
  console.log(`Relatório: ${path.relative(REPOSITORY_ROOT, REPORT_PATH)}`);

  if (!approved) process.exitCode = 1;
}

await main();
