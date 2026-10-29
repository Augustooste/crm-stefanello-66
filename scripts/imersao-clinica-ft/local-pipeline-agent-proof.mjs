#!/usr/bin/env node
// Prova local: RPC de evento -> pipeline-agent -> LLM real -> comando -> histórico.
// Nunca reseta o banco, ativa cron ou envia mensagens a WhatsApp/e-mail.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { createClient } from "@supabase/supabase-js";

const { values } = parseArgs({
  options: {
    "tenant-id": { type: "string" },
    "board-id": { type: "string" },
    "deal-id": { type: "string" },
    "target-stage-id": { type: "string" },
    output: {
      type: "string",
      default: "artifacts/imersao-clinica-ft/local-pipeline-agent-proof.json",
    },
    "prepare-env": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(`1. Aplique a migration 20261015100000_pipeline_agent_por_tenant.sql no banco local.
2. node scripts/imersao-clinica-ft/local-pipeline-agent-proof.mjs --prepare-env
3. pnpm exec supabase functions serve --env-file /tmp/imersao-pipeline-functions.env
4. node scripts/imersao-clinica-ft/local-pipeline-agent-proof.mjs [--tenant-id UUID]
Sem --board-id/--deal-id, cria um quadro/deal novos (e tenant isolado quando omitido).
Para filmar um card existente, passe --tenant-id UUID --board-id UUID --deal-id UUID
[--target-stage-id UUID]. Esse modo só lê a configuração: exige opt-in ativo,
autonomous/min0.80 e critérios configurados; não altera nem reseta o card.
O cron pipeline-agent deve estar desligado. A prova recusa deliveries fora do cenário.
O JSON em --output e stdout contém os IDs reais do evento, comando e histórico.
Não use supabase db reset.`);
  process.exit(0);
}
if (values["prepare-env"]) {
  const source = await readFile(
    `${homedir()}/freedomdigitalhub/clientes/acelera-ia/.env.local`,
    "utf8",
  );
  const keyLine = source
    .split(/\r?\n/)
    .find((line) => /^\s*(?:export\s+)?GEMINI_API_KEY\s*=/.test(line));
  const env = parseEnv(keyLine ?? "");
  assert(env.GEMINI_API_KEY, "GEMINI_API_KEY ausente no arquivo autorizado do cliente.");
  await writeFile(
    "/tmp/imersao-pipeline-functions.env",
    [
      "AI_GATEWAY_URL=https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      "AI_GATEWAY_MODEL=gemini-2.5-flash",
      `AI_GATEWAY_API_KEY=${env.GEMINI_API_KEY}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  console.log("Ambiente local pronto: /tmp/imersao-pipeline-functions.env (chave não exibida).");
  process.exit(0);
}

const status = JSON.parse(
  execFileSync("pnpm", ["exec", "supabase", "status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }),
);
const url = new URL(status.API_URL);
assert(
  ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
  "Prova recusada fora do stack local.",
);
assert(status.SERVICE_ROLE_KEY, "Service role local indisponível no supabase status.");
const admin = createClient(url.origin, status.SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const checked = (result, operation) => {
  if (result.error) throw new Error(`${operation}: ${result.error.message}`);
  return result.data;
};

assert.equal(
  Boolean(values["board-id"]),
  Boolean(values["deal-id"]),
  "--board-id e --deal-id devem ser informados juntos.",
);
const existingTarget = Boolean(values["deal-id"]);
assert(!existingTarget || values["tenant-id"], "Alvo existente exige --tenant-id.");
assert(!values["target-stage-id"] || existingTarget, "--target-stage-id exige um deal existente.");
const localSql = (sql, variables = []) =>
  execFileSync("psql", [status.DB_URL, "-At", "-v", "ON_ERROR_STOP=1", ...variables], {
    input: sql,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
assert.equal(
  localSql("select count(*) from cron.job where active and jobname='pipeline-agent';"),
  "0",
  "Desligue o cron local pipeline-agent antes da prova controlada.",
);
const ensureIsolatedQueue = (allowedEvent = "") => {
  // Inclui deliveries futuras e leases em curso para não disputar outro cenário.
  const count = localSql(
    `
    select count(*)
    from public.event_deliveries d
    join public.domain_events e on e.id=d.event_id
    join public.tenant_ai_features f on f.tenant_id=e.tenant_id
      and f.feature_key='pipeline_agent' and f.enabled and e.created_at>=f.enabled_at
    where d.subscriber_id='pipeline.agent'
      and ((d.status='pending' and d.attempts<d.max_attempts) or d.status='processing')
      and e.id::text <> :'allowed_event';
  `,
    ["-v", `allowed_event=${allowedEvent}`],
  );
  assert.equal(
    count,
    "0",
    "Há deliveries de pipeline fora do cenário; prova recusada sem processá-las.",
  );
};
ensureIsolatedQueue();
const runId = randomUUID();
let tenantId = values["tenant-id"];
if (!tenantId) {
  const created = checked(
    await admin.auth.admin.createUser({
      email: `pipeline-proof-${runId}@example.test`,
      password: `${randomUUID()}Aa!`,
      email_confirm: true,
      user_metadata: { name: "Prova local do pipeline" },
    }),
    "Criar usuário local de prova",
  );
  const profile = checked(
    await admin.from("profiles").select("tenant_id").eq("id", created.user.id).single(),
    "Ler tenant provisionado pelo Auth",
  );
  tenantId = profile.tenant_id;
}
const boardId = values["board-id"] ?? randomUUID();
const dealId = values["deal-id"] ?? randomUUID();
let fromStageId;
let toStageId;
let contactId = null;
if (existingTarget) {
  const target = checked(
    await admin
      .from("deals")
      .select("id,board_id,stage_id,status,automation_mode,contact_id")
      .eq("id", dealId)
      .eq("tenant_id", tenantId)
      .single(),
    "Ler card existente",
  );
  assert.equal(target.board_id, boardId, "Card não pertence ao quadro informado.");
  assert.equal(target.status, "open", "Card existente não está aberto.");
  assert(
    ["inherit", "autonomous"].includes(target.automation_mode),
    "Autonomia do card impede avanço automático.",
  );
  fromStageId = target.stage_id;
  contactId = target.contact_id;
  const tenant = checked(
    await admin.from("tenants").select("ai_enabled").eq("id", tenantId).single(),
    "Ler IA do tenant",
  );
  assert.equal(tenant.ai_enabled, true, "Habilite a IA do tenant antes da captura.");
  const transitions = checked(
    await admin
      .from("stage_transitions")
      .select("to_stage_id,autonomy_mode,min_confidence,requires_human_approval,ai_priority")
      .eq("tenant_id", tenantId)
      .eq("board_id", boardId)
      .eq("from_stage_id", fromStageId)
      .eq("enabled", true)
      .order("ai_priority")
      .order("created_at"),
    "Ler política do card",
  );
  const transition = transitions.find((row) => row.autonomy_mode !== "manual") ?? transitions[0];
  assert(transition, "Não há transição habilitada para o card.");
  assert.equal(
    transition.autonomy_mode,
    "autonomous",
    "Configure autonomous na transição antes da captura.",
  );
  assert.equal(
    Number(transition.min_confidence),
    0.8,
    "Configure min_confidence=0.80 antes da captura.",
  );
  assert.equal(
    transition.requires_human_approval,
    false,
    "Transição ainda exige aprovação humana.",
  );
  toStageId = transition.to_stage_id;
  if (values["target-stage-id"]) {
    assert.equal(
      toStageId,
      values["target-stage-id"],
      "Destino informado diverge da regra prioritária do pipeline.",
    );
  }
  const config = checked(
    await admin
      .from("stage_ai_config")
      .select("enabled,advancement_criteria")
      .eq("tenant_id", tenantId)
      .eq("stage_id", fromStageId)
      .single(),
    "Ler critérios do estágio",
  );
  assert(
    config.enabled &&
      Array.isArray(config.advancement_criteria) &&
      config.advancement_criteria.length,
    "Configure critérios de avanço antes da captura.",
  );
} else {
  checked(
    await admin.from("tenants").update({ ai_enabled: true }).eq("id", tenantId),
    "Ativar IA do tenant local",
  );
  fromStageId = randomUUID();
  toStageId = randomUUID();
  checked(
    await admin.from("boards").insert({
      id: boardId,
      tenant_id: tenantId,
      name: `Prova local pipeline ${runId.slice(0, 8)}`,
      automation_mode: "autonomous",
    }),
    "Criar quadro isolado",
  );
  checked(
    await admin.from("board_stages").insert([
      { id: fromStageId, board_id: boardId, name: "Pagamento aguardado", position: 0 },
      { id: toStageId, board_id: boardId, name: "Pagamento confirmado", position: 1 },
    ]),
    "Criar estágios da prova",
  );
  checked(
    await admin
      .from("stage_transitions")
      .update({
        enabled: true,
        autonomy_mode: "autonomous",
        min_confidence: 0.8,
        requires_human_approval: false,
        cooldown_minutes: 0,
        required_signals: { "payment.approved": true },
      })
      .eq("tenant_id", tenantId)
      .eq("board_id", boardId)
      .eq("from_stage_id", fromStageId)
      .eq("to_stage_id", toStageId),
    "Configurar política autonomous/0.80",
  );
  checked(
    await admin.from("stage_ai_config").insert({
      tenant_id: tenantId,
      stage_id: fromStageId,
      enabled: true,
      stage_goal: "Confirmar o pagamento a partir do sinal estruturado do provedor",
      advancement_criteria: [
        "O pagamento foi aprovado, comprovado pelo evento payment.approved e pelo sinal estruturado payment.approved=true.",
      ],
    }),
    "Configurar critério com evidência objetiva",
  );
  checked(
    await admin.from("deals").insert({
      id: dealId,
      tenant_id: tenantId,
      board_id: boardId,
      stage_id: fromStageId,
      title: `Prova local: pagamento confirmado ${runId.slice(0, 8)}`,
      status: "open",
      automation_mode: "inherit",
    }),
    "Criar negócio da prova",
  );
  checked(
    await admin.from("tenant_ai_features").upsert(
      {
        tenant_id: tenantId,
        feature_key: "pipeline_agent",
        enabled: true,
      },
      { onConflict: "tenant_id,feature_key" },
    ),
    "Opt-in do tenant local",
  );
}
const feature = checked(
  await admin
    .from("tenant_ai_features")
    .select("enabled, enabled_at")
    .eq("tenant_id", tenantId)
    .eq("feature_key", "pipeline_agent")
    .single(),
  "Confirmar opt-in",
);
assert(feature.enabled && feature.enabled_at, "Opt-in não registrado pelo banco.");
ensureIsolatedQueue();
const before = checked(
  await admin.from("deals").select("stage_id").eq("tenant_id", tenantId).eq("id", dealId).single(),
  "Ler estágio imediatamente antes do evento",
);
assert.equal(before.stage_id, fromStageId, "Card mudou antes de iniciar a prova.");
const eventId = checked(
  await admin.rpc("publish_pipeline_signal_event", {
    p_event_type: "payment.approved",
    p_deal_id: dealId,
    p_contact_id: contactId,
    p_payload: { payment_status: "approved", source: "prova-local-controlada" },
    p_idempotency_key: `pipeline-proof:${runId}`,
  }),
  "Publicar evento pela RPC legítima",
);
const event = checked(
  await admin.from("domain_events").select("created_at").eq("id", eventId).single(),
  "Ler instante do evento",
);
assert(new Date(event.created_at) >= new Date(feature.enabled_at), "Evento anterior ao opt-in.");

ensureIsolatedQueue(eventId);
const response = await fetch(`${url.origin}/functions/v1/pipeline-agent`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${status.SERVICE_ROLE_KEY}`,
    apikey: status.SERVICE_ROLE_KEY,
    "content-type": "application/json",
  },
  body: JSON.stringify({ limit: 1 }),
  signal: AbortSignal.timeout(150_000),
});
const batch = await response.json();
assert(response.ok, `pipeline-agent HTTP ${response.status}: ${JSON.stringify(batch)}`);
assert.equal(batch.claimed, 1, "Worker não reclamou exatamente o evento da prova.");
assert.equal(batch.failed, 0, "Worker relatou falha no processamento.");
const deal = checked(
  await admin.from("deals").select("stage_id").eq("tenant_id", tenantId).eq("id", dealId).single(),
  "Ler estágio após a execução do worker",
);
const commands = checked(
  await admin
    .from("deal_stage_transition_commands")
    .select("id,status,decision,actor_type,confidence,model_version,policy_snapshot,correlation_id")
    .eq("tenant_id", tenantId)
    .eq("deal_id", dealId)
    .eq("correlation_id", eventId),
  "Ler comando da IA",
);
const history = checked(
  await admin
    .from("deal_stage_history")
    .select(
      "id,from_stage_id,to_stage_id,actor_type,confidence,trigger_event,correlation_id,idempotency_key",
    )
    .eq("tenant_id", tenantId)
    .eq("deal_id", dealId)
    .eq("correlation_id", eventId),
  "Ler auditoria da transição",
);
const evidence = {
  status: "EM_VERIFICACAO_LOCAL",
  run_id: runId,
  api_url: url.origin,
  tenant_id: tenantId,
  board_id: boardId,
  deal_id: dealId,
  from_stage_id: fromStageId,
  to_stage_id: toStageId,
  enabled_at: feature.enabled_at,
  event_id: eventId,
  event_created_at: event.created_at,
  batch,
  commands,
  history,
  history_id: null,
  command_id: null,
  actor_type: null,
  observed_at: new Date().toISOString(),
};
const output = resolve(values.output);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
try {
  assert.equal(
    deal.stage_id,
    toStageId,
    `Negócio não avançou. Comandos: ${JSON.stringify(commands)}`,
  );
  assert.equal(history.length, 1, "A prova exige exatamente um movimento real no histórico.");
  assert.equal(history[0].actor_type, "ai");
  assert.equal(history[0].trigger_event, "payment.approved");
  assert.equal(history[0].correlation_id, eventId);
  assert(history[0].confidence >= 0.8, "Movimento abaixo da confiança permitida.");
  const accepted = commands.find(
    (command) =>
      command.status === "accepted" &&
      command.actor_type === "ai" &&
      command.policy_snapshot.min_confidence === 0.8 &&
      command.model_version === "gemini-2.5-flash",
  );
  assert(accepted, "Comando não comprova política e modelo local.");
  evidence.history_id = history[0].id;
  evidence.command_id = accepted.id;
  evidence.actor_type = history[0].actor_type;
  evidence.status = "COMPROVADO_LOCAL";
} catch (error) {
  evidence.status = "FALHOU_LOCAL";
  evidence.error = error.message;
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  throw error;
}
await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      status: evidence.status,
      tenant_id: tenantId,
      board_id: boardId,
      deal_id: dealId,
      from_stage_id: fromStageId,
      to_stage_id: toStageId,
      event_id: eventId,
      history_id: evidence.history_id,
      command_id: evidence.command_id,
      actor_type: evidence.actor_type,
      output,
    },
    null,
    2,
  ),
);
