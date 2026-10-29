import { spawn } from "node:child_process";
import process from "node:process";

const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

function color(name, text) {
  return `${COLORS[name]}${text}${COLORS.reset}`;
}

function stripAnsi(output) {
  // oxlint-disable-next-line no-control-regex -- ESC (\x1b) é justamente o que se remove
  return output.replace(/\x1b\[[0-9;]*m/g, "");
}

function parseCounts(output, type) {
  const counts = { passed: 0, failed: 0, errors: 0 };

  if (type === "vitest") {
    // "Tests 1707 passed (1707)"  ou  "Tests 1700 passed | 7 failed"
    const testsMatch = output.match(/Tests\s+(\d+)\s+passed(?:\s*\|\s*(\d+)\s+failed)?/i);
    if (testsMatch) {
      counts.passed = parseInt(testsMatch[1], 10);
      counts.failed = parseInt(testsMatch[2] ?? "0", 10);
    }

    const errorsMatch = output.match(/Errors\s+(\d+)\s+errors?/i);
    if (errorsMatch) {
      counts.errors = parseInt(errorsMatch[1], 10);
    }
  } else {
    // Deno: "ok | 96 passed (916 steps) | 0 failed"
    const denoMatch = output.match(/(\d+)\s+passed\s*(?:\([^)]*\))?\s*\|\s*(\d+)\s+failed/i);
    if (denoMatch) {
      counts.passed = parseInt(denoMatch[1], 10);
      counts.failed = parseInt(denoMatch[2], 10);
    }
  }

  return counts;
}

function makePrefixer(prefix, stream) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      stream.write(`${prefix} ${line}\n`);
    }
  };
}

const WORKER_TIMEOUT_PATTERNS = [
  /Terminating worker thread/i,
  /Failed to terminate worker/i,
  /worker.*timed?\s*out/i,
  /Test timed out in \d+ms/i,
  /Timeout.*awaiting.*worker/i,
  /Tinypool.*(?:timeout|terminate)/i,
  /ERR_WORKER_OUT_OF_MEMORY/i,
];

function isWorkerTimeout(output) {
  return WORKER_TIMEOUT_PATTERNS.some((rx) => rx.test(output));
}

function runOnce(label, command, args, type, prefixColor, attemptLabel) {
  return new Promise((resolve) => {
    const start = Date.now();
    const displayLabel = attemptLabel ? `${label} ${attemptLabel}` : label;
    const prefix = color(prefixColor, `[${displayLabel}]`);
    console.log(color(prefixColor, `▶ ${displayLabel}`));
    console.log(color("dim", `  $ ${command} ${args.join(" ")}`));

    const child = spawn(command, args, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    const outWriter = makePrefixer(prefix, process.stdout);
    const errWriter = makePrefixer(prefix, process.stderr);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      outWriter(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      errWriter(chunk);
    });

    child.on("close", (code) => {
      const duration = ((Date.now() - start) / 1000).toFixed(1);
      const output = stripAnsi(stdout + stderr);
      const counts = parseCounts(output, type);
      resolve({
        label,
        exitCode: code ?? 1,
        duration,
        workerTimeout: isWorkerTimeout(output),
        ...counts,
      });
    });
  });
}

async function run(
  label,
  command,
  args,
  type,
  prefixColor = "cyan",
  retryConfig = { maxRetries: 0, baseMs: 1000 },
) {
  const { maxRetries, baseMs } = retryConfig;
  let attempt = 0;
  let last;

  while (true) {
    const attemptLabel = attempt === 0 ? "" : `(retry ${attempt}/${maxRetries})`;
    last = await runOnce(label, command, args, type, prefixColor, attemptLabel);

    const failed = last.exitCode !== 0 || last.failed > 0 || last.errors > 0;
    if (!failed || !last.workerTimeout || attempt >= maxRetries) break;

    const delay = baseMs * 2 ** attempt;
    console.log(
      color(
        "yellow",
        `⟳ [${label}] timeout de worker detectado — retry ${attempt + 1}/${maxRetries} em ${delay}ms`,
      ),
    );
    await new Promise((r) => setTimeout(r, delay));
    attempt += 1;
  }

  last.attempts = attempt + 1;
  return last;
}

async function runAll(tasks, concurrency) {
  const results = new Array(tasks.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= tasks.length) return;
      results[idx] = await tasks[idx]();
    }
  });
  await Promise.all(workers);
  return results;
}

function parseConcurrency() {
  const flag = process.argv.find((a) => a.startsWith("--concurrency="));
  if (flag) {
    const n = parseInt(flag.split("=")[1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const env = parseInt(process.env.SUITE_CONCURRENCY ?? "", 10);
  if (Number.isFinite(env) && env > 0) return env;
  return 2;
}

function padBoth(str, width) {
  const padding = Math.max(0, width - str.length);
  const left = Math.floor(padding / 2);
  const right = padding - left;
  return " ".repeat(left) + str + " ".repeat(right);
}

function parseIntEnv(name, fallback) {
  const flag = process.argv.find((a) =>
    a.startsWith(`--${name.toLowerCase().replace(/_/g, "-")}=`),
  );
  if (flag) {
    const n = parseInt(flag.split("=")[1], 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const env = parseInt(process.env[name] ?? "", 10);
  if (Number.isFinite(env) && env >= 0) return env;
  return fallback;
}

async function main() {
  const concurrency = parseConcurrency();
  const maxRetries = parseIntEnv("SUITE_MAX_RETRIES", 2);
  const baseMs = parseIntEnv("SUITE_RETRY_BASE_MS", 1000);
  const retryConfig = { maxRetries, baseMs };

  console.log(color("dim", `Concorrência: ${concurrency} (SUITE_CONCURRENCY / --concurrency=N)`));
  console.log(
    color(
      "dim",
      `Retries em timeout de worker: até ${maxRetries}× com backoff ${baseMs}ms×2^n (SUITE_MAX_RETRIES / SUITE_RETRY_BASE_MS)`,
    ),
  );

  const tasks = [
    () => run("Frontend (Vitest)", "pnpm", ["test"], "vitest", "cyan", retryConfig),
    () => run("Edge functions (Deno)", "pnpm", ["test:functions"], "deno", "yellow", retryConfig),
  ];

  const results = await runAll(tasks, concurrency);

  const totalPassed = results.reduce((sum, r) => sum + r.passed, 0);
  const totalFailed = results.reduce((sum, r) => sum + r.failed, 0);
  const totalErrors = results.reduce((sum, r) => sum + r.errors, 0);
  const anyFailed = results.some((r) => r.exitCode !== 0 || r.failed > 0 || r.errors > 0);

  const width = 70;
  const line = "═".repeat(width);
  const sep = "─".repeat(width);

  console.log("\n" + line);
  console.log(color("bold", padBoth("PLACAR CONSOLIDADO", width)));
  console.log(line);

  for (const r of results) {
    const ok = r.exitCode === 0 && r.failed === 0 && r.errors === 0;
    const status = ok ? color("green", "OK") : color("red", "FALHA");
    const passedStr = String(r.passed).padStart(5);
    const failedStr = String(r.failed).padStart(4);
    const errorsStr = String(r.errors).padStart(3);
    const retryNote = r.attempts && r.attempts > 1 ? color("yellow", `  ↻${r.attempts}x`) : "";
    console.log(
      `${r.label.padEnd(26)} ${passedStr} ✅   ${failedStr} ❌   ${errorsStr} ⚠️   ${status}   (${r.duration}s)${retryNote}`,
    );
  }

  console.log(sep);
  const totalStatus = anyFailed ? color("red", "FALHA") : color("green", "OK");
  console.log(
    `${color("bold", "Total").padEnd(26)} ${String(totalPassed).padStart(5)} ✅   ${String(totalFailed).padStart(4)} ❌   ${String(totalErrors).padStart(3)} ⚠️   ${totalStatus}`,
  );
  console.log(line + "\n");

  process.exit(anyFailed ? 1 : 0);
}

main().catch((err) => {
  console.error(color("red", "Erro inesperado ao orquestrar a suíte:"), err);
  process.exit(1);
});
