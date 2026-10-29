#!/usr/bin/env node
// Prova real no stack local: Auth/RLS/RPC -> nurture-runner HTTP -> simulador -> histórico.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";

const { values } = parseArgs({
  options: {
    output: { type: "string", default: "artifacts/imersao-clinica-ft/local-followup-proof.json" },
  },
});
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
assert(status.SERVICE_ROLE_KEY && status.ANON_KEY, "Chaves locais indisponíveis.");
const cronCount = execFileSync(
  "psql",
  [
    status.DB_URL,
    "-At",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    "select count(*) from cron.job where active and jobname in ('nurture-runner','nurture-auto-enroll-scanner')",
  ],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
).trim();
assert.equal(cronCount, "0", "Desative os crons locais de nurture antes da prova controlada.");
const auth = { persistSession: false, autoRefreshToken: false };
const admin = createClient(url.origin, status.SERVICE_ROLE_KEY, { auth });
const user = createClient(url.origin, status.ANON_KEY, { auth });
const checked = (result, operation) => {
  if (result.error) throw new Error(`${operation}: ${result.error.message}`);
  return result.data;
};
const runId = randomUUID();
const evidence = { status: "EM_VERIFICACAO_LOCAL", runId, apiUrl: url.origin, etapas: [] };
let enrollmentId;
let sequenceId;
let tenantId;
const output = resolve(values.output);
const saveEvidence = async () => {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
};
const enrollment = async () =>
  checked(
    await user
      .from("nurture_enrollments")
      .select("id,status,current_step,next_send_at,completed_at,attempts")
      .eq("tenant_id", tenantId)
      .eq("id", enrollmentId)
      .single(),
    "Ler inscrição com RLS",
  );
const messages = async () =>
  checked(
    await user
      .from("messages")
      .select("id,conversation_id,sender,status,external_id,content,created_at")
      .eq("tenant_id", tenantId)
      .eq("sender", "automation")
      .order("created_at"),
    "Ler mensagens do simulador",
  );
const history = async () =>
  checked(
    await user
      .from("nurture_execution_history")
      .select("id,enrollment_id,step_number,outcome,executed_at,detail")
      .eq("tenant_id", tenantId)
      .eq("enrollment_id", enrollmentId)
      .order("executed_at"),
    "Ler histórico com RLS",
  );
const forceDue = async () => {
  const past = new Date(Date.now() - 3_600_000).toISOString();
  checked(
    await admin
      .from("nurture_enrollments")
      .update({ next_send_at: past })
      .eq("tenant_id", tenantId)
      .eq("id", enrollmentId),
    "Antecipar somente o relógio da prova",
  );
  return past;
};
const ensureIsolatedQueue = async () => {
  const due = checked(
    await admin
      .from("nurture_enrollments")
      .select("id")
      .eq("status", "active")
      .lte("next_send_at", new Date().toISOString()),
    "Inspecionar fila local",
  );
  assert(
    due.every((row) => row.id === enrollmentId),
    "Há outra inscrição vencida: a prova se recusa a processar dados de outro tenant.",
  );
};
const invokeRunner = async () => {
  await ensureIsolatedQueue();
  const response = await fetch(`${url.origin}/functions/v1/nurture-runner`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${status.SERVICE_ROLE_KEY}`,
      apikey: status.SERVICE_ROLE_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({ limit: 1 }),
    signal: AbortSignal.timeout(60_000),
  });
  const batch = await response.json();
  assert(response.ok, `nurture-runner HTTP ${response.status}: ${JSON.stringify(batch)}`);
  assert.deepEqual(batch.errors, [], `Runner retornou falha: ${JSON.stringify(batch)}`);
  return { httpStatus: response.status, ...batch };
};
const changeStatus = async (next) =>
  checked(
    await user.rpc("set_nurture_enrollment_status", {
      p_enrollment_id: enrollmentId,
      p_status: next,
    }),
    `Alterar inscrição para ${next} pela RPC autenticada`,
  );

try {
  await ensureIsolatedQueue();
  const email = `followup-proof-${runId}@example.test`;
  const password = `${randomUUID()}Aa!`;
  const created = checked(
    await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name: "Prova local de acompanhamento" },
    }),
    "Criar usuário local isolado",
  );
  checked(await user.auth.signInWithPassword({ email, password }), "Autenticar usuário da prova");
  const profile = checked(
    await user.from("profiles").select("tenant_id").eq("id", created.user.id).single(),
    "Ler tenant provisionado pelo Auth",
  );
  tenantId = profile.tenant_id;
  evidence.tenantId = tenantId;
  const hours = (enabled) =>
    Object.fromEntries(
      ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => [
        day,
        { enabled, open: "00:00", close: "24:00" },
      ]),
    );
  checked(
    await user
      .from("tenants")
      .update({ ai_enabled: false, business_profile: { hours: hours(false) } })
      .eq("id", tenantId),
    "Configurar horário fechado no tenant isolado",
  );
  const channelId = checked(
    await user.rpc("create_simulator_channel"),
    "Criar canal pelo caminho oficial",
  );
  const channel = checked(
    await user
      .from("channels")
      .select("id,type,provider_slug,status")
      .eq("tenant_id", tenantId)
      .eq("id", channelId)
      .single(),
    "Verificar canal sem transporte externo",
  );
  assert.equal(channel.provider_slug, "simulator");
  assert.equal(channel.type, "simulator");
  assert.equal(channel.status, "connected");
  evidence.channel = channel;
  const contact = checked(
    await user
      .from("contacts")
      .insert({
        tenant_id: tenantId,
        name: "Pessoa fictícia da prova F8",
        ai_paused: true,
      })
      .select("id")
      .single(),
    "Criar contato com RLS",
  );
  const sequence = checked(
    await user
      .from("nurture_sequences")
      .insert({
        tenant_id: tenantId,
        name: `Prova temporal F8 ${runId.slice(0, 8)}`,
        channel_id: channelId,
        trigger_type: "manual",
        is_active: true,
      })
      .select("id")
      .single(),
    "Criar sequência com RLS",
  );
  sequenceId = sequence.id;
  checked(
    await user.from("nurture_steps").insert([
      {
        sequence_id: sequenceId,
        step_number: 1,
        delay_hours: 0,
        message_template: "[Prova local] Olá {{contact.name}}, mensagem do primeiro passo.",
      },
      {
        sequence_id: sequenceId,
        step_number: 2,
        delay_hours: 48,
        message_template:
          "[Prova local] Esta mensagem não pode sair enquanto a inscrição estiver interrompida.",
      },
    ]),
    "Criar passos com RLS",
  );
  assert.equal(
    checked(
      await user.rpc("enroll_manual_nurture_sequence", {
        p_contact_id: contact.id,
        p_appointment_at: new Date(Date.now() + 172_800_000).toISOString(),
      }),
      "Inscrever pela RPC legítima",
    ),
    true,
  );
  const enrolled = checked(
    await user
      .from("nurture_enrollments")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("sequence_id", sequenceId)
      .eq("contact_id", contact.id)
      .single(),
    "Ler inscrição criada",
  );
  enrollmentId = enrolled.id;
  Object.assign(evidence, { sequenceId, enrollmentId, contactId: contact.id });

  const firstDue = await forceDue();
  const closedBatch = await invokeRunner();
  const closedState = await enrollment();
  assert.equal(closedBatch.deferredWindow, 1);
  assert.equal(closedState.current_step, 0);
  assert(new Date(closedState.next_send_at).getTime() > Date.now());
  assert.equal((await messages()).length, 0);
  evidence.etapas.push({
    caso: "horário comercial fechado impede envio",
    next_send_at_vencido: firstDue,
    batch: closedBatch,
    inscrição: closedState,
  });

  checked(
    await user
      .from("tenants")
      .update({ business_profile: { hours: hours(true) } })
      .eq("id", tenantId),
    "Abrir horário somente no tenant isolado",
  );
  const sendDue = await forceDue();
  const sendStarted = Date.now();
  const sentBatch = await invokeRunner();
  const sentState = await enrollment();
  const sentMessages = await messages();
  assert.equal(sentBatch.sent, 1);
  assert.equal(sentState.current_step, 1);
  assert.equal(sentState.status, "active");
  assert(new Date(sentState.next_send_at).getTime() >= sendStarted + 48 * 3_600_000);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].status, "sent");
  assert(sentMessages[0].external_id.startsWith("simulator:"));
  assert.equal(
    sentMessages[0].content,
    "[Prova local] Olá Pessoa fictícia da prova F8, mensagem do primeiro passo.",
  );
  const conversation = checked(
    await user
      .from("conversations")
      .select("channel_id")
      .eq("tenant_id", tenantId)
      .eq("id", sentMessages[0].conversation_id)
      .single(),
    "Conferir canal da mensagem",
  );
  assert.equal(conversation.channel_id, channelId);
  const executions = await history();
  assert.deepEqual(
    executions.map((row) => row.outcome),
    ["deferred_window", "sent"],
  );
  assert(
    executions.every(
      (row) => row.step_number === 1 && row.enrollment_id === enrollmentId && row.executed_at,
    ),
  );
  evidence.etapas.push({
    caso: "envio real no simulador e avanço de 48h",
    next_send_at_vencido: sendDue,
    batch: sentBatch,
    inscrição: sentState,
    mensagens: sentMessages,
    histórico: executions,
  });

  await changeStatus("paused");
  await forceDue();
  const pausedBatch = await invokeRunner();
  const pausedState = await enrollment();
  assert.equal(pausedBatch.processed, 0);
  assert.equal(pausedState.status, "paused");
  assert.equal(pausedState.current_step, 1);
  assert.equal((await messages()).length, 1);
  assert.equal((await history()).length, 2);
  evidence.etapas.push({
    caso: "pausa impede o segundo envio mesmo vencido",
    batch: pausedBatch,
    inscrição: pausedState,
    total_mensagens: 1,
  });

  const resumed = await changeStatus("active");
  assert(new Date(resumed.next_send_at).getTime() > Date.now());
  await forceDue();
  await changeStatus("cancelled");
  const cancelledBatch = await invokeRunner();
  const cancelledState = await enrollment();
  assert.equal(cancelledBatch.processed, 0);
  assert.equal(cancelledState.status, "cancelled");
  assert.equal(cancelledState.current_step, 1);
  assert.equal(cancelledState.next_send_at, null);
  assert(cancelledState.completed_at);
  assert.equal((await messages()).length, 1);
  assert.equal((await history()).length, 2);
  evidence.etapas.push({
    caso: "cancelamento impede o segundo envio",
    batch: cancelledBatch,
    inscrição: cancelledState,
    total_mensagens: 1,
  });
  evidence.status = "COMPROVADO_LOCAL";
  evidence.observedAt = new Date().toISOString();
} catch (error) {
  evidence.status = "FALHOU_LOCAL";
  evidence.error = error.message;
  throw error;
} finally {
  if (enrollmentId) {
    const current = await enrollment();
    if (["active", "paused", "sending"].includes(current.status)) await changeStatus("cancelled");
  }
  if (sequenceId)
    checked(
      await user
        .from("nurture_sequences")
        .update({ is_active: false })
        .eq("tenant_id", tenantId)
        .eq("id", sequenceId),
      "Desativar sequência isolada após a prova",
    );
  await saveEvidence();
  console.log(JSON.stringify(evidence, null, 2));
}
