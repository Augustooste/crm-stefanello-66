#!/usr/bin/env node
// Mensagens legítimas no transporte simulado; somente o LLM recebe chamada externa.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";

const { values } = parseArgs({
  options: {
    "tenant-id": { type: "string" },
    qualify: { type: "boolean", default: false },
    output: { type: "string", default: "/tmp/imersao-local-enrichment-proof.json" },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(`1. Aplique 20261015130000_ficha_extracao_automatica.sql no stack local.
2. Use o functions serve já coordenado com Gemini (AI_GATEWAY_MODEL=gemini-2.5-flash).
3. node scripts/imersao-clinica-ft/local-enrichment-proof.mjs [--tenant-id UUID] [--qualify]
Sem tenant-id cria um tenant isolado pela Auth Admin. Com tenant-id ativa o opt-in
somente nesse tenant local, criando contato e conversa novos sem tocar no seed.
--qualify também cria negócio aberto e ativa config.auto_qualify.
Não reseta banco, não altera credenciais e não envia WhatsApp/e-mail.
Exige o cron contact-enrichment-dispatcher pausado e uso exclusivo do stack local;
recusa fila, recibos ou eventos de enriquecimento fora das mensagens desta prova.`);
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
  "Execução recusada fora do stack local.",
);
assert(status.SERVICE_ROLE_KEY, "Chave service_role local indisponível.");
assert(
  status.DB_URL && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(status.DB_URL).hostname),
  "Inspeção recusada fora do banco local.",
);
const admin = createClient(url.origin, status.SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const checked = (result, operation) => {
  if (result.error) throw new Error(`${operation}: ${result.error.message}`);
  return result.data;
};
const runId = randomUUID();
let tenantId = values["tenant-id"];
const contactId = randomUUID();
const sourceIds = Array.from({ length: 5 }, () => randomUUID());
const ensureIsolatedWork = () => {
  // O worker não aceita escopo: inclusive trabalho em debounce pode vencer durante o LLM.
  const state = JSON.parse(
    execFileSync(
      "psql",
      [
        status.DB_URL,
        "-X",
        "-At",
        "-v",
        "ON_ERROR_STOP=1",
        "-v",
        `proof_tenant=${tenantId ?? ""}`,
        "-v",
        `proof_contact=${contactId}`,
        "-v",
        `proof_sources={${sourceIds.join(",")}}`,
      ],
      {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        input: `
select json_build_object(
  'active_cron', exists(select 1 from cron.job where active and jobname='contact-enrichment-dispatcher'),
  'external_deliveries', exists(
    select 1 from public.event_deliveries d
    join public.domain_events e on e.id=d.event_id
    join public.tenant_ai_features f on f.tenant_id=e.tenant_id and f.feature_key='contact_auto_enrichment'
    where d.subscriber_id='contact.enrichment' and d.status in ('pending','processing')
      and e.event_type in ('message.received','message.sent') and f.enabled and e.created_at>=f.enabled_at
      and (e.tenant_id is distinct from nullif(:'proof_tenant','')::uuid
        or not (e.aggregate_id=any(:'proof_sources'::uuid[])))),
  'external_contacts', exists(
    select 1 from public.contact_extraction_queue q
    join public.tenant_ai_features f on f.tenant_id=q.tenant_id and f.feature_key='contact_auto_enrichment'
    where f.enabled and f.enabled_at=q.enabled_at and q.message_count>0
      and (q.tenant_id is distinct from nullif(:'proof_tenant','')::uuid or q.contact_id<>:'proof_contact'::uuid)),
  'external_receipts', exists(
    select 1 from public.contact_enrichment_receipts r
    join public.tenant_ai_features f on f.tenant_id=r.tenant_id and f.feature_key='contact_auto_enrichment'
    where f.enabled and f.enabled_at=r.enabled_at and r.processed_at is null
      and (r.tenant_id is distinct from nullif(:'proof_tenant','')::uuid
        or r.contact_id<>:'proof_contact'::uuid or not (r.message_id=any(:'proof_sources'::uuid[]))))
);`,
      },
    ),
  );
  assert.equal(
    state.active_cron,
    false,
    "Pause o cron local de enriquecimento antes da prova controlada.",
  );
  for (const key of ["external_deliveries", "external_contacts", "external_receipts"]) {
    assert.equal(
      state[key],
      false,
      `Há trabalho fora do cenário (${key}); a prova se recusa a executar o worker global.`,
    );
  }
};
ensureIsolatedWork();
// Falha antes de criar dados quando o worker não estiver disponível.
const probe = await fetch(`${url.origin}/functions/v1/contact-enrichment-dispatcher`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
  signal: AbortSignal.timeout(15_000),
});
assert.equal(
  probe.status,
  401,
  `Worker local indisponível: HTTP ${probe.status}. Inicie functions serve com a configuração Gemini coordenada.`,
);
if (!tenantId) {
  const { user } = checked(
    await admin.auth.admin.createUser({
      email: `enrichment-proof-${runId}@example.test`,
      password: `${randomUUID()}Aa!`,
      email_confirm: true,
      user_metadata: { name: "Prova local de enriquecimento" },
    }),
    "Criar usuário de prova",
  );
  tenantId = checked(
    await admin.from("profiles").select("tenant_id").eq("id", user.id).single(),
    "Ler tenant",
  ).tenant_id;
}
checked(
  await admin.from("tenants").select("id").eq("id", tenantId).single(),
  "Confirmar tenant local",
);
const previousFlag = checked(
  await admin
    .from("tenant_ai_features")
    .select("config")
    .eq("tenant_id", tenantId)
    .eq("feature_key", "contact_auto_enrichment")
    .maybeSingle(),
  "Ler configuração",
);
checked(
  await admin.from("tenant_ai_features").upsert(
    {
      tenant_id: tenantId,
      feature_key: "contact_auto_enrichment",
      enabled: true,
      config: { ...previousFlag?.config, auto_qualify: values.qualify },
    },
    { onConflict: "tenant_id,feature_key" },
  ),
  "Ativar enriquecimento local",
);
checked(
  await admin.from("custom_field_definitions").upsert(
    {
      tenant_id: tenantId,
      entity: "contact",
      key: "servico_interesse",
      label: "Serviço de interesse",
      field_type: "text",
    },
    { onConflict: "tenant_id,entity,key", ignoreDuplicates: true },
  ),
  "Garantir definição de campo da prova",
);
let channel = checked(
  await admin
    .from("channels")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("provider_slug", "simulator")
    .maybeSingle(),
  "Ler canal simulado",
);
if (!channel)
  channel = checked(
    await admin
      .from("channels")
      .insert({
        tenant_id: tenantId,
        type: "simulator",
        provider_slug: "simulator",
        status: "connected",
        config: { simulated: true, display_name: "Prova de ficha (SIMULAÇÃO)" },
      })
      .select("id")
      .single(),
    "Criar canal simulado",
  );
const conversationId = randomUUID();
checked(
  await admin.from("contacts").insert({
    id: contactId,
    tenant_id: tenantId,
    name: `Ana | Prova de extração ${runId.slice(0, 8)}`,
    ai_paused: true,
  }),
  "Criar contato vazio",
);
checked(
  await admin.from("conversations").insert({
    id: conversationId,
    tenant_id: tenantId,
    contact_id: contactId,
    channel_id: channel.id,
  }),
  "Criar conversa legítima",
);
let dealId;
if (values.qualify) {
  const boardId = randomUUID();
  const stageId = randomUUID();
  dealId = randomUUID();
  checked(
    await admin.from("boards").insert({
      id: boardId,
      tenant_id: tenantId,
      name: "Prova local de qualificação",
      automation_mode: "shadow",
    }),
    "Criar quadro da prova",
  );
  checked(
    await admin
      .from("board_stages")
      .insert({ id: stageId, board_id: boardId, name: "Triagem", position: 0 }),
    "Criar etapa da prova",
  );
  checked(
    await admin.from("deals").insert({
      id: dealId,
      tenant_id: tenantId,
      board_id: boardId,
      stage_id: stageId,
      contact_id: contactId,
      title: "Avaliação de implante (prova)",
      status: "open",
    }),
    "Criar negócio aberto",
  );
}
const texts = [
  "Olá, sou Ana. Meu e-mail é ana.prova@example.test.",
  "Moro em Curitiba.",
  "Tenho interesse em implante dentário.",
  "Prefiro atendimento à tarde e contato por WhatsApp.",
  "Eu decido o tratamento, posso investir 3500 reais e quero agendar uma avaliação na próxima semana.",
];
checked(
  await admin.from("messages").insert(
    texts.map((content, index) => ({
      id: sourceIds[index],
      tenant_id: tenantId,
      conversation_id: conversationId,
      sender: "contact",
      direction: "in",
      content,
      status: "received",
    })),
  ),
  "Inserir cinco mensagens legítimas",
);
const invoke = async () => {
  ensureIsolatedWork();
  const response = await fetch(`${url.origin}/functions/v1/contact-enrichment-dispatcher`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${status.SERVICE_ROLE_KEY}`,
      apikey: status.SERVICE_ROLE_KEY,
      "content-type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(150_000),
  });
  const body = await response.json();
  assert(response.ok, `Processamento HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
};
const batch = await invoke();
const contact = checked(
  await admin
    .from("contacts")
    .select("email,address_city,custom_fields,ai_memory")
    .eq("tenant_id", tenantId)
    .eq("id", contactId)
    .single(),
  "Ler ficha preenchida",
);
const history = checked(
  await admin
    .from("contact_field_extractions")
    .select(
      "id,field_name,field_type,extracted_value,previous_value,confidence,source_message_ids,model,applied,apply_reason,created_at",
    )
    .eq("tenant_id", tenantId)
    .eq("contact_id", contactId),
  "Ler histórico",
);
const summaries = checked(
  await admin
    .from("ai_conversation_summaries")
    .select("summary,messages_covered")
    .eq("tenant_id", tenantId)
    .eq("contact_id", contactId),
  "Ler resumos",
);
const qualifications = dealId
  ? checked(
      await admin
        .from("deal_qualification_snapshots")
        .select("id,confidence,executive_summary")
        .eq("tenant_id", tenantId)
        .eq("deal_id", dealId),
      "Ler qualificação automática",
    )
  : [];
const evidence = {
  status: "EM_VERIFICACAO_LOCAL",
  runId,
  tenantId,
  contactId,
  conversationId,
  dealId,
  sourceIds,
  batch,
  contact,
  history,
  summaries,
  qualifications,
  observedAt: new Date().toISOString(),
};
const output = resolve(values.output);
await mkdir(dirname(output), { recursive: true });
try {
  assert.equal(contact.email, "ana.prova@example.test");
  assert.equal(contact.address_city, "Curitiba");
  assert.match(String(contact.custom_fields.servico_interesse), /implante/i);
  assert.match(
    String(contact.ai_memory?.history_summary),
    /implante/i,
    "Memória não consolidou o interesse real informado.",
  );
  assert(
    summaries.some(
      (summary) => summary.messages_covered === 5 && /implante|Curitiba/i.test(summary.summary),
    ),
    "Resumo factual das cinco mensagens ausente.",
  );
  assert(history.filter((row) => row.applied).length >= 3, "Menos de três campos foram aplicados.");
  assert(
    history.every(
      (row) =>
        row.model === "gemini-2.5-flash" &&
        row.source_message_ids.every((id) => sourceIds.includes(id)),
    ),
    "Modelo ou evidência incompatível com a prova.",
  );
  if (values.qualify)
    assert.equal(qualifications.length, 1, "Qualificação automática não foi gerada.");
  evidence.replay = await invoke();
  const replayHistory = checked(
    await admin
      .from("contact_field_extractions")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("contact_id", contactId),
    "Verificar idempotência",
  );
  assert.equal(replayHistory.length, history.length, "Reexecução duplicou histórico.");
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
      tenantId,
      contactId,
      conversationId,
      campos: contact,
      historico: history,
      resumos: summaries.length,
      qualificacoes: qualifications.length,
      output,
    },
    null,
    2,
  ),
);
