import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ids = {
  tenant: "10000000-0000-4000-8000-000000000001",
  board: "10000000-0000-4000-8000-000000000002",
  deal: "10000000-0000-4000-8000-000000000003",
  from: "10000000-0000-4000-8000-000000000004",
  to: "10000000-0000-4000-8000-000000000005",
  event: "10000000-0000-4000-8000-000000000006",
};

async function runProof(t, { foreignAt = 0, existing = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pipeline-proof-test-"));
  const argv = process.argv;
  const fetch = globalThis.fetch;
  const logs = [];
  const writes = [];
  let workerCalls = 0;
  let isolationChecks = 0;
  let stageId = ids.from;
  t.mock.method(console, "log", (line) => logs.push(line));
  t.mock.method(childProcess, "execFileSync", (command, args, options) => {
    if (command === "pnpm")
      return JSON.stringify({
        API_URL: "http://127.0.0.1:54321",
        DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
        SERVICE_ROLE_KEY: "chave-local-de-teste",
      });
    assert.equal(command, "psql");
    if (options.input.includes("cron.job")) return "0\n";
    assert.match(options.input, /event_deliveries/);
    assert.match(options.input, /pipeline_agent/);
    assert.match(options.input, /enabled_at/);
    isolationChecks++;
    return isolationChecks === foreignAt ? "1\n" : "0\n";
  });
  syncBuiltinESMExports();
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.method !== "GET") writes.push(url.pathname);
    const json = (value) =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (url.pathname === "/rest/v1/deals") {
      assert.equal(url.searchParams.get("id"), `eq.${ids.deal}`);
      assert.equal(url.searchParams.get("tenant_id"), `eq.${ids.tenant}`);
      return json({
        id: ids.deal,
        board_id: ids.board,
        stage_id: stageId,
        status: "open",
        automation_mode: "inherit",
        contact_id: null,
      });
    }
    if (url.pathname === "/rest/v1/tenants") return json({ ai_enabled: true });
    if (url.pathname === "/rest/v1/stage_transitions")
      return json([
        {
          to_stage_id: ids.to,
          autonomy_mode: "autonomous",
          min_confidence: 0.8,
          requires_human_approval: false,
          ai_priority: 0,
        },
      ]);
    if (url.pathname === "/rest/v1/stage_ai_config")
      return json({
        enabled: true,
        advancement_criteria: ["Pagamento aprovado"],
      });
    if (url.pathname === "/rest/v1/tenant_ai_features")
      return json({ enabled: true, enabled_at: "2026-10-15T11:00:00Z" });
    if (url.pathname === "/rest/v1/rpc/publish_pipeline_signal_event") {
      const body = await request.json();
      assert.equal(body.p_deal_id, ids.deal);
      assert.equal(body.p_event_type, "payment.approved");
      return json(ids.event);
    }
    if (url.pathname === "/rest/v1/domain_events")
      return json({ created_at: "2026-10-15T12:00:00Z" });
    if (url.pathname === "/functions/v1/pipeline-agent") {
      workerCalls++;
      assert.deepEqual(await request.json(), { limit: 1 });
      stageId = ids.to;
      return json({ claimed: 1, delivered: 1, failed: 0 });
    }
    if (url.pathname === "/rest/v1/deal_stage_history") {
      assert.equal(url.searchParams.get("correlation_id"), `eq.${ids.event}`);
      return json([
        {
          id: "historico-da-prova",
          from_stage_id: ids.from,
          to_stage_id: ids.to,
          actor_type: "ai",
          confidence: 0.8,
          trigger_event: "payment.approved",
          correlation_id: ids.event,
        },
      ]);
    }
    if (url.pathname === "/rest/v1/deal_stage_transition_commands") {
      assert.equal(url.searchParams.get("correlation_id"), `eq.${ids.event}`);
      return json([
        {
          id: "comando-da-prova",
          status: "accepted",
          actor_type: "ai",
          confidence: 0.8,
          model_version: "gemini-2.5-flash",
          policy_snapshot: { min_confidence: 0.8 },
        },
      ]);
    }
    throw new Error(`Acesso inesperado na prova: ${request.method} ${url.pathname}`);
  };
  process.argv = [
    process.execPath,
    "local-pipeline-agent-proof.mjs",
    "--output",
    join(directory, "proof.json"),
  ];
  if (existing)
    process.argv.push(
      "--tenant-id",
      ids.tenant,
      "--board-id",
      ids.board,
      "--deal-id",
      ids.deal,
      "--target-stage-id",
      ids.to,
    );
  let error;
  let artifact;
  try {
    await import(`./local-pipeline-agent-proof.mjs?teste=${randomUUID()}`);
    artifact = JSON.parse(await readFile(join(directory, "proof.json"), "utf8"));
  } catch (cause) {
    error = cause;
  } finally {
    process.argv = argv;
    globalThis.fetch = fetch;
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  }
  return { error, writes, workerCalls, isolationChecks, logs, artifact };
}

test("recusa fila de outro cenário antes de criar fixtures ou invocar worker", async (t) => {
  const result = await runProof(t, { foreignAt: 1, existing: false });
  assert.match(result.error?.message ?? "", /deliveries.*fora do cenário/i);
  assert.deepEqual(result.writes, []);
  assert.equal(result.workerCalls, 0);
});

test("usa card existente sem alterar configuração e comprova somente auditoria do evento novo", async (t) => {
  const result = await runProof(t);
  assert.ifError(result.error);
  assert.equal(result.workerCalls, 1);
  assert.deepEqual(result.writes, [
    "/rest/v1/rpc/publish_pipeline_signal_event",
    "/functions/v1/pipeline-agent",
  ]);
  const proof = JSON.parse(result.logs.at(-1));
  assert.equal(proof.deal_id, ids.deal);
  assert.equal(proof.from_stage_id, ids.from);
  assert.equal(proof.to_stage_id, ids.to);
  assert.equal(proof.history_id, "historico-da-prova");
  assert.equal(proof.command_id, "comando-da-prova");
  assert.equal(proof.actor_type, "ai");
  for (const key of [
    "deal_id",
    "from_stage_id",
    "to_stage_id",
    "history_id",
    "command_id",
    "event_id",
    "actor_type",
  ]) {
    assert.equal(
      result.artifact[key],
      proof[key],
      `O arquivo precisa preservar ${key} para a captura`,
    );
  }
});

test("revalida fila imediatamente antes do worker mesmo após publicar o evento", async (t) => {
  const result = await runProof(t, { foreignAt: 3 });
  assert.match(result.error?.message ?? "", /deliveries.*fora do cenário/i);
  assert.deepEqual(result.writes, ["/rest/v1/rpc/publish_pipeline_signal_event"]);
  assert.equal(result.workerCalls, 0);
});
