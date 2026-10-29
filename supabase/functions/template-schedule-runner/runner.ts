// runner.ts — lógica de negócio do template-schedule-runner (Fase 4 do PRD,
// user story C — broadcast agendado: 1 template -> N contatos numa janela).
// index.ts fica só com auth + wiring; toda regra de negócio mora aqui,
// testável importando direto (mesmo espírito dos módulos compartilhados
// _shared/messaging/*, que também recebem o `admin` client injetado em vez
// de criá-lo).
//
// Desvios deliberados do texto literal da tarefa (documentados, não
// silenciosos):
//
// 1. Corrida na GERAÇÃO de execuções: o texto da tarefa descreve "se ainda
//    não tem execuções geradas -> expande -> marca running" como 3 passos
//    separados. Duas invocações concorrentes do runner (cron sobreposto,
//    retry manual) poderiam ambas ver "nenhuma execução ainda" pro MESMO
//    schedule_id e ambas expandirem a audiência — dobrando o broadcast
//    inteiro (diferente do watchdog de SLA, onde "alertar 2x" é barato; aqui
//    2x = 2 disparos pra cada contato da base). Por isso o claim é atômico:
//    `UPDATE template_schedules SET status='running' WHERE id=X AND
//    status='pending' RETURNING *` (claimScheduleForGeneration) ANTES de
//    expandir a audiência — só quem ganha a corrida do UPDATE gera
//    execuções. Isso faz o claim já ser o "marca running", eliminando o
//    passo 3 separado do texto original (mesmo efeito, ordem segura contra
//    concorrência).
//
// 2. Guard de 24h/supressão/frequência olha o CONTATO (tenant_id+contact_id),
//    não uma conversa já criada — `findOrCreateConversation` só é chamado no
//    passo de Envio (depois de todos os guards passarem). Chamar antes
//    criaria uma conversa vazia pra todo contato bloqueado/suprimido/limitado
//    por frequência.
//
// 3. audience_filter vazio ou sem filtro reconhecido NUNCA gera uma query
//    sem filtro contra `contacts` — expandAudience retorna [] nesse caso
//    (nenhum predicado reconhecido = nenhum contato, nunca "a base toda").
//
// 4. Tipo de mensagem é explícito (provider-send.ts::OutboundMessage):
//    `freeform` sai como texto; `provider_approved` sai como
//    ProviderTemplateMessage (`type: "template"` na Meta Cloud, variáveis em
//    `components[body].parameters` na ordem de `messaging_templates.variables`).
//    Canal sem suporte a modelo aprovado (tudo que não é meta-cloud) falha a
//    execução com erro claro -- nunca manda o corpo como texto livre disfarçado.
//
// 5. Canal é da CAMPANHA (`template_schedules.channel_id`), não do template:
//    `messaging_templates.channel_id` nasce nulo em todo rascunho novo
//    (create_template_draft só herda do pai). Schedule sem canal falha na
//    geração, antes de criar qualquer execução -- inclusive agendamentos
//    antigos, anteriores à coluna, que ficariam pendentes quando o cron ligar.
//
// 6. O runner roda como service_role (RLS não protege): template e canal
//    carregados por id são conferidos contra o tenant do schedule antes de
//    qualquer envio.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { redactSecrets } from "../_shared/redact-secrets.ts";
import {
  isSupportedProviderSlug,
  loadProviderSecrets,
  type OutboundMessage,
  providerSupportsTemplates,
  type SendResult,
  sendMessageViaProvider,
} from "../_shared/messaging/provider-send.ts";
import {
  AUTOMATED_SEND_DAILY_LIMIT,
  AUTOMATED_SEND_WINDOW_HOURS,
  countRecentAutomatedSends,
  findOrCreateConversation,
  isPhoneSuppressed,
  logAutomatedSend,
} from "../_shared/messaging/conversation.ts";
// Reexportados: supabase/functions/tests/template-schedule-runner.test.ts
// importa estes nomes direto deste módulo. O guard de frequência mora em
// _shared/messaging/conversation.ts, fonte única com o nurture-runner.
export { AUTOMATED_SEND_DAILY_LIMIT, AUTOMATED_SEND_WINDOW_HOURS, isPhoneSuppressed };

const FREEFORM_WINDOW_HOURS = 24;

// Canais em que um envio "ok" significa mensagem entregue ao provedor real.
// telegram/discord/sms/email/push (multichannel-adapters.ts) devolvem sucesso
// SANDBOX quando não há credencial -- campanha neles contaria "Enviados" sem
// enviar nada. Espelhado em NovaCampanhaDialog (CAMPAIGN_PROVIDER_LABELS).
// manychat-* fica de fora de propósito: campanha em massa cai fora da janela
// de 24h e o ManyChat recusa (3011) sem message_tag, que não usamos.
export const CAMPAIGN_PROVIDER_SLUGS: ReadonlySet<string> = new Set([
  "meta-cloud",
  "twilio",
  "zapi",
  "evolution",
  "zappaz",
  "resend",
]);
const OFFICIAL_PROVIDER_SLUGS = new Set(["meta-cloud", "twilio"]);

// Batch default do claim de execuções -- evita reivindicar um número
// ilimitado de linhas pendentes numa única invocação (mesmo valor e mesmo
// motivo do nurture-runner, ver nurture-runner/runner.ts::DEFAULT_CLAIM_LIMIT).
// Sem isto, um broadcast pra audiência grande gera milhares de execuções
// pending e 1 invocação reivindicaria TODAS de uma vez.
const DEFAULT_CLAIM_LIMIT = 50;

export interface TemplateSchedule {
  id: string;
  tenant_id: string;
  template_id: string;
  channel_id: string | null;
  audience_filter: Record<string, unknown> | null;
  scheduled_for: string;
  status: string;
}

export interface TemplateScheduleExecution {
  id: string;
  schedule_id: string;
  contact_id: string;
  applied_variables: Record<string, unknown> | null;
  status: string;
  attempt_count: number;
  scheduled_for: string;
}

export interface AudienceFilter {
  tags?: string[];
  stage_id?: string;
  custom_field?: Record<string, unknown>;
}

interface TemplateRow {
  id: string;
  tenant_id?: string;
  body: string;
  kind: string;
  language?: string | null;
  variables?: string[] | null;
  provider_template_name: string | null;
  channel_id: string | null;
}

interface ChannelRow {
  id: string;
  tenant_id?: string;
  provider_slug: string;
}

export interface ContactRow {
  id: string;
  name?: string | null;
  phone: string | null;
  email: string | null;
  custom_fields?: Record<string, unknown> | null;
}

export type ExecutionOutcome = "sent" | "failed" | "skipped_suppressed" | "deferred";

export interface ProcessExecutionContext {
  tenantId: string;
  template: TemplateRow;
  channel: ChannelRow | null;
  contact: ContactRow | null;
}

/**
 * Renderização mínima de `{{variavel}}` a partir de `applied_variables`.
 * Placeholder sem valor correspondente é mantido literal (fail-safe: nunca
 * lança por variável faltante, só manda o texto sem substituir).
 */
export function renderTemplateBody(
  body: string,
  variables: Record<string, unknown> | null,
): string {
  const vars = variables ?? {};
  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? match : String(value);
  });
}

// `.is("deleted_at", null)`: contacts tem soft-delete/merge desde a Fase 1
// (20260709120000_fase1_nucleo_crm_schema.sql) — confirmado nesta sessão,
// não presumido. Sem este filtro, um contato soft-deletado/mergeado ainda
// entraria na expansão de audiência. O filtro por stage_id aplica o mesmo
// guard via join deals->contacts, para a contagem de execuções bater com a
// estimativa mostrada na tela (public.estimate_campaign_audience).
async function resolveTagContactIds(
  admin: SupabaseClient,
  tenantId: string,
  tags: string[],
): Promise<Set<string>> {
  const { data, error } = await admin
    .from("contacts")
    .select("id")
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .overlaps("tags", tags);
  if (error) throw new Error(`Falha ao expandir audiência por tags: ${error.message}`);
  return new Set((data ?? []).map((r: { id: string }) => r.id));
}

async function resolveStageContactIds(
  admin: SupabaseClient,
  tenantId: string,
  stageId: string,
): Promise<Set<string>> {
  const { data, error } = await admin
    .from("deals")
    .select("contact_id, contacts!inner(deleted_at)")
    .eq("tenant_id", tenantId)
    .eq("stage_id", stageId)
    .not("contact_id", "is", null)
    .is("contacts.deleted_at", null);
  if (error) throw new Error(`Falha ao expandir audiência por stage_id: ${error.message}`);
  return new Set(
    (data ?? [])
      .map((r: { contact_id: string | null }) => r.contact_id)
      .filter((id): id is string => !!id),
  );
}

async function resolveCustomFieldContactIds(
  admin: SupabaseClient,
  tenantId: string,
  customField: Record<string, unknown>,
): Promise<Set<string>> {
  const { data, error } = await admin
    .from("contacts")
    .select("id")
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .contains("custom_fields", customField);
  if (error) throw new Error(`Falha ao expandir audiência por custom_field: ${error.message}`);
  return new Set((data ?? []).map((r: { id: string }) => r.id));
}

/**
 * Expande `audience_filter` para uma lista de contact_id. Interseção (AND)
 * de todos os filtros PRESENTES no objeto — filtro ausente não participa da
 * interseção, filtro presente sempre restringe. Sem NENHUM filtro
 * reconhecido, retorna [] (nunca consulta `contacts` sem predicado — ver
 * desvio #3 no topo do arquivo).
 */
export async function expandAudience(
  admin: SupabaseClient,
  tenantId: string,
  filter: AudienceFilter,
): Promise<string[]> {
  const sets: Array<Set<string>> = [];

  if (Array.isArray(filter.tags) && filter.tags.length > 0) {
    sets.push(await resolveTagContactIds(admin, tenantId, filter.tags));
  }
  if (typeof filter.stage_id === "string" && filter.stage_id.length > 0) {
    sets.push(await resolveStageContactIds(admin, tenantId, filter.stage_id));
  }
  if (filter.custom_field && Object.keys(filter.custom_field).length > 0) {
    sets.push(await resolveCustomFieldContactIds(admin, tenantId, filter.custom_field));
  }

  if (sets.length === 0) return [];

  const [first, ...rest] = sets;
  return [...first].filter((id) => rest.every((s) => s.has(id)));
}

/**
 * Claim atômico de UM schedule pendente: só quem consegue transicionar
 * pending -> running recebe a linha de volta (ver desvio #1). Chamadas
 * concorrentes para o mesmo id: só uma retorna não-null.
 */
export async function claimScheduleForGeneration(
  admin: SupabaseClient,
  scheduleId: string,
): Promise<TemplateSchedule | null> {
  const { data, error } = await admin
    .from("template_schedules")
    .update({ status: "running" })
    .eq("id", scheduleId)
    .eq("status", "pending")
    .select()
    .maybeSingle();
  if (error) throw new Error(`Falha ao reivindicar agendamento ${scheduleId}: ${error.message}`);
  return (data as TemplateSchedule | null) ?? null;
}

/**
 * Marca o schedule como 'failed', logando um erro CRÍTICO destacado se o
 * próprio UPDATE falhar (blip de rede): o schedule já estava 'running' (claim
 * atômico anterior) e, sem visibilidade deste log, ficaria preso lá pra
 * sempre — generatePendingSchedules só revisita schedules status='pending'.
 * Sem retry automático aqui, só o log que permite reconciliação manual.
 */
async function markScheduleFailed(admin: SupabaseClient, scheduleId: string): Promise<void> {
  const { error } = await admin
    .from("template_schedules")
    .update({ status: "failed" })
    .eq("id", scheduleId);
  if (error) {
    console.error(
      `[template-schedule-runner] CRÍTICO: falha ao marcar schedule ${scheduleId} como failed (schedule fica preso em 'running' indefinidamente): ${error.message}`,
    );
  }
}

/**
 * Gera 1 execução pendente por contato da audiência expandida. Em qualquer
 * falha (expansão sem filtro reconhecido, erro de query, erro no insert) o
 * schedule é marcado 'failed' com o motivo em console.error — a tabela
 * template_schedules não tem coluna de mensagem de erro própria (schema
 * real: só status/sent_count/failed_count), então a mensagem clara pedida
 * pela tarefa vai pro log, não pra uma coluna que não existe.
 */
export async function generateExecutionsForSchedule(
  admin: SupabaseClient,
  schedule: TemplateSchedule,
): Promise<{ generated: number; failed: boolean }> {
  if (!schedule.channel_id) {
    console.error(
      `[template-schedule-runner] schedule ${schedule.id} sem channel_id — marcado como failed antes de gerar execuções.`,
    );
    await markScheduleFailed(admin, schedule.id);
    return { generated: 0, failed: true };
  }

  const filter = (schedule.audience_filter ?? {}) as AudienceFilter;

  let contactIds: string[];
  try {
    contactIds = await expandAudience(admin, schedule.tenant_id, filter);
  } catch (err) {
    const msg = redactSecrets(err);
    console.error(
      `[template-schedule-runner] expansão de audiência falhou p/ schedule ${schedule.id}: ${msg}`,
    );
    await markScheduleFailed(admin, schedule.id);
    return { generated: 0, failed: true };
  }

  if (contactIds.length === 0) {
    console.error(
      `[template-schedule-runner] audience_filter vazio ou sem filtros reconhecidos (tags/stage_id/custom_field) ` +
        `p/ schedule ${schedule.id} — marcado como failed. Não envia para a base toda por engano.`,
    );
    await markScheduleFailed(admin, schedule.id);
    return { generated: 0, failed: true };
  }

  // `applied_variables` nasce '{}' (default da coluna): as variáveis são
  // resolvidas no ENVIO, a partir do contato (resolveTemplateVariables).
  const rows = contactIds.map((contactId) => ({
    schedule_id: schedule.id,
    contact_id: contactId,
    scheduled_for: schedule.scheduled_for,
    status: "pending",
  }));

  const { error: insertError } = await admin.from("template_schedule_executions").insert(rows);
  if (insertError) {
    console.error(
      `[template-schedule-runner] falha ao inserir execuções p/ schedule ${schedule.id}: ${insertError.message}`,
    );
    await markScheduleFailed(admin, schedule.id);
    return { generated: 0, failed: true };
  }

  return { generated: rows.length, failed: false };
}

/**
 * Varre schedules pending vencidos e gera execuções para cada um (via claim
 * atômico — schedule já reivindicado por outra invocação é pulado em
 * silêncio, não é erro).
 */
export async function generatePendingSchedules(
  admin: SupabaseClient,
): Promise<{ generated: number; failedSchedules: number }> {
  const nowIso = new Date().toISOString();
  const { data: pending, error } = await admin
    .from("template_schedules")
    .select("id")
    .eq("status", "pending")
    .lte("scheduled_for", nowIso);
  if (error) throw new Error(`Falha ao buscar agendamentos pendentes: ${error.message}`);

  let generated = 0;
  let failedSchedules = 0;
  for (const row of (pending ?? []) as Array<{ id: string }>) {
    const claimed = await claimScheduleForGeneration(admin, row.id);
    if (!claimed) continue; // outra invocação já reivindicou este schedule
    const result = await generateExecutionsForSchedule(admin, claimed);
    if (result.failed) failedSchedules++;
    else generated += result.generated;
  }
  return { generated, failedSchedules };
}

/**
 * Claim atômico de execuções pendentes e vencidas — mesmo padrão de
 * `UPDATE ... WHERE ... RETURNING` usado pelo nurture-runner, previne
 * double-processing entre invocações concorrentes. `.order()+.limit()`
 * também copiado do nurture-runner (claimDueEnrollments): sem limite, um
 * broadcast pra audiência grande reivindicaria milhares de execuções numa
 * só invocação e, se a function estourar tempo de execução no meio, as
 * linhas já 'sending' ficariam órfãs (claim só filtra status='pending').
 */
export async function claimExecutions(
  admin: SupabaseClient,
  opts: { limit?: number } = {},
): Promise<TemplateScheduleExecution[]> {
  const limit = opts.limit ?? DEFAULT_CLAIM_LIMIT;
  const nowIso = new Date().toISOString();
  const { data, error } = await admin
    .from("template_schedule_executions")
    .update({ status: "sending", last_attempt_at: nowIso })
    .eq("status", "pending")
    .lte("scheduled_for", nowIso)
    .order("scheduled_for", { ascending: true })
    .limit(limit)
    .select();
  if (error) throw new Error(`Falha ao reivindicar execuções: ${error.message}`);
  return (data ?? []) as TemplateScheduleExecution[];
}

/**
 * true = existe mensagem INBOUND deste contato nas últimas
 * `FREEFORM_WINDOW_HOURS` horas (janela de 24h da API oficial ainda aberta).
 * Olha o CONTATO no CANAL da campanha (join messages -> conversations): a
 * janela da Meta é do número comercial, então inbound por outro canal (ex.:
 * Z-API) não abre a janela do WhatsApp oficial. Sem inbound, retorna false.
 */
export async function isFreeformWithinWindow(
  admin: SupabaseClient,
  tenantId: string,
  contactId: string,
  channelId: string,
): Promise<boolean> {
  const sinceIso = new Date(Date.now() - FREEFORM_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const { data, error } = await admin
    .from("messages")
    .select("id, conversations!inner(contact_id, tenant_id)")
    .eq("direction", "in")
    .eq("conversations.tenant_id", tenantId)
    .eq("conversations.contact_id", contactId)
    .eq("conversations.channel_id", channelId)
    .gte("created_at", sinceIso)
    .limit(1);
  if (error) throw new Error(`Falha ao checar janela de 24h: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

async function markExecution(
  admin: SupabaseClient,
  executionId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const { error } = await admin
    .from("template_schedule_executions")
    .update(fields)
    .eq("id", executionId);
  if (error) throw new Error(`Falha ao atualizar execução ${executionId}: ${error.message}`);
}

// Limite de taxa do provedor (HTTP 429 / Meta 130429): a mensagem NÃO saiu,
// então é seguro reenfileirar com espera crescente, com teto de tentativas.
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_BACKOFF_MINUTES = 15;

export const UNCERTAIN_DELIVERY_MESSAGE =
  "Resultado incerto: o provedor não respondeu a tempo. Não reenviado automaticamente para evitar mensagem duplicada.";

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export type ResolvedVariables =
  | { ok: true; values: Record<string, string> }
  | { ok: false; missing: string };

/**
 * Valor de cada variável para ESTE contato, nesta ordem de precedência:
 * `applied_variables` da execução > `contacts.custom_fields[chave]` > `nome`/
 * `name` = `contacts.name`. Variável sem valor não vira placeholder cru nem
 * parâmetro vazio (a Meta recusaria com 132000): a execução falha antes do envio.
 */
export function resolveTemplateVariables(
  names: string[],
  contact: ContactRow,
  applied: Record<string, unknown> | null,
): ResolvedVariables {
  const values: Record<string, string> = {};
  for (const name of names) {
    const raw =
      applied?.[name] ??
      contact.custom_fields?.[name] ??
      (name === "nome" || name === "name" ? contact.name : undefined);
    const text = raw === undefined || raw === null ? "" : String(raw).trim();
    if (!text) return { ok: false, missing: name };
    values[name] = text;
  }
  return { ok: true, values };
}

function bodyPlaceholders(body: string): string[] {
  return [...new Set([...body.matchAll(PLACEHOLDER_RE)].map((m) => m[1]))];
}

/**
 * Processa 1 execução já reivindicada (status='sending'): tipo de mensagem x
 * canal -> janela de 24h -> supressão -> frequência -> variáveis -> envio.
 * Erros de negócio esperados terminam em `markExecution` + retorno normal.
 * Erros inesperados (DB fora do ar) PODEM propagar -- quem isola a execução do
 * lote é o try/catch de `processClaimedExecutions`.
 */
export async function processExecution(
  admin: SupabaseClient,
  execution: TemplateScheduleExecution,
  ctx: ProcessExecutionContext,
): Promise<ExecutionOutcome> {
  const { tenantId, template, channel, contact } = ctx;
  const nextAttempt = execution.attempt_count + 1;
  const fail = async (error_message: string, extra: Record<string, unknown> = {}) => {
    await markExecution(admin, execution.id, {
      status: "failed",
      error_message,
      attempt_count: nextAttempt,
      ...extra,
    });
    return "failed" as const;
  };

  if (!contact) return await fail("Contato não encontrado.");
  if (!channel) return await fail("Campanha sem canal configurado.");

  const providerSlug = channel.provider_slug;
  const isProviderTemplate = template.kind === "provider_approved";
  const metrics = {
    provider_slug: providerSlug,
    message_kind: isProviderTemplate ? "provider_template" : "freeform",
  };

  if (!isSupportedProviderSlug(providerSlug) || !CAMPAIGN_PROVIDER_SLUGS.has(providerSlug)) {
    return await fail(`Canal com provedor de envio não suportado em campanhas: ${providerSlug}.`, metrics);
  }
  if (isProviderTemplate && !providerSupportsTemplates(providerSlug)) {
    return await fail(
      `O canal ${providerSlug} não envia modelo aprovado pelo provedor. Use o WhatsApp oficial (Meta).`,
      metrics,
    );
  }
  if (isProviderTemplate && !template.provider_template_name) {
    return await fail("Modelo aprovado sem o nome cadastrado na Meta.", metrics);
  }

  // Fora da janela de atendimento, canal oficial só entrega modelo aprovado.
  if (!isProviderTemplate && OFFICIAL_PROVIDER_SLUGS.has(providerSlug)) {
    const withinWindow = await isFreeformWithinWindow(admin, tenantId, contact.id, channel.id);
    if (!withinWindow) {
      return await fail(
        "Envio bloqueado: template freeform fora da janela de 24h do WhatsApp oficial — use um template aprovado (kind=provider_approved).",
        metrics,
      );
    }
  }

  if (await isPhoneSuppressed(admin, tenantId, contact.phone)) {
    await markExecution(admin, execution.id, {
      status: "skipped_suppressed",
      attempt_count: nextAttempt,
      ...metrics,
    });
    return "skipped_suppressed";
  }

  const recentSends = await countRecentAutomatedSends(admin, {
    tenantId,
    contactId: contact.id,
    windowHours: AUTOMATED_SEND_WINDOW_HOURS,
  });
  if (recentSends >= AUTOMATED_SEND_DAILY_LIMIT) {
    // Adia em vez de falhar terminal (mesmo padrão do nurture-runner). Teto de
    // tentativas evita adiamento infinito de um contato que nunca abrir a
    // janela de frequência.
    const MAX_DEFER_ATTEMPTS = 5;
    const DEFER_HOURS = 6;
    if (nextAttempt >= MAX_DEFER_ATTEMPTS) {
      return await fail(
        `Limite diário atingido em ${MAX_DEFER_ATTEMPTS} tentativas — desistindo do envio.`,
      );
    }
    const nextScheduledFor = new Date(Date.now() + DEFER_HOURS * 60 * 60 * 1000).toISOString();
    await markExecution(admin, execution.id, {
      status: "pending",
      scheduled_for: nextScheduledFor,
      error_message: `Limite diário atingido (${AUTOMATED_SEND_DAILY_LIMIT}/${AUTOMATED_SEND_WINDOW_HOURS}h) — adiado ${DEFER_HOURS}h.`,
      attempt_count: nextAttempt,
    });
    return "skipped_suppressed";
  }

  const templateVariables = template.variables ?? [];
  const variableNames = isProviderTemplate ? templateVariables : bodyPlaceholders(template.body);
  const resolved = resolveTemplateVariables(
    variableNames,
    contact,
    execution.applied_variables,
  );
  if (!resolved.ok) {
    return await fail(`Variável {{${resolved.missing}}} sem valor para este contato.`, metrics);
  }

  const content = renderTemplateBody(template.body, resolved.values);
  const message: OutboundMessage = isProviderTemplate
    ? {
        kind: "provider_template",
        name: template.provider_template_name as string,
        languageCode: template.language || "pt_BR",
        bodyParameters: templateVariables.map((name) => resolved.values[name]),
      }
    : { kind: "freeform", text: content };

  const cred = await loadProviderSecrets(admin, tenantId, providerSlug);
  const conversation = await findOrCreateConversation(admin, {
    tenantId,
    contactId: contact.id,
    channelId: channel.id,
    aiActive: true,
  });

  let result: SendResult;
  try {
    result = await sendMessageViaProvider({
      admin,
      providerSlug,
      cred,
      phone: contact.phone ?? undefined,
      email: contact.email ?? undefined,
      message,
    });
  } catch (err) {
    // Timeout/queda de rede: não dá para saber se a mensagem saiu. Reenviar
    // arrisca duplicar para o lead, então termina como falha "incerta".
    console.error(
      `[template-schedule-runner] execução ${execution.id} sem resposta do provedor: ${redactSecrets(err)}`,
    );
    return await fail(UNCERTAIN_DELIVERY_MESSAGE, metrics);
  }

  if (result.ok) {
    await logAutomatedSend(admin, {
      tenantId,
      conversationId: conversation.id,
      content,
      status: "sent",
      externalId: result.external_id ?? undefined,
    });
    await markExecution(admin, execution.id, {
      status: "sent",
      sent_at: new Date().toISOString(),
      error_message: null,
      attempt_count: nextAttempt,
      external_id: result.external_id,
      ...metrics,
    });
    return "sent";
  }

  if (result.retryable && nextAttempt < RATE_LIMIT_MAX_ATTEMPTS) {
    const waitMs = RATE_LIMIT_BACKOFF_MINUTES * nextAttempt * 60 * 1000;
    await markExecution(admin, execution.id, {
      status: "pending",
      scheduled_for: new Date(Date.now() + waitMs).toISOString(),
      error_message: result.error,
      attempt_count: nextAttempt,
      ...metrics,
    });
    return "deferred";
  }

  await logAutomatedSend(admin, {
    tenantId,
    conversationId: conversation.id,
    content,
    status: "failed",
    errorMessage: result.error,
  });
  return await fail(result.error, { sent_at: null, ...metrics });
}

export interface ProcessBatchSummary {
  sent: number;
  failed: number;
  skippedSuppressed: number;
  deferred: number;
  errors: string[];
}

/**
 * Pré-carrega schedule/template/channel/contact em lote (evita 1 query por
 * execução) e processa cada execução reivindicada. Erro inesperado numa
 * execução isolada é logado e a execução marcada 'failed' — nunca aborta o
 * lote (mesma regra do watchdog de SLA e do scanner de auto-enrollment).
 */
export async function processClaimedExecutions(
  admin: SupabaseClient,
  executions: TemplateScheduleExecution[],
): Promise<ProcessBatchSummary> {
  const summary: ProcessBatchSummary = {
    sent: 0,
    failed: 0,
    skippedSuppressed: 0,
    deferred: 0,
    errors: [],
  };
  if (executions.length === 0) return summary;

  const scheduleIds = [...new Set(executions.map((e) => e.schedule_id))];
  const { data: schedules, error: schedulesError } = await admin
    .from("template_schedules")
    .select("id, tenant_id, template_id, channel_id")
    .in("id", scheduleIds);
  if (schedulesError) throw new Error(`Falha ao carregar agendamentos: ${schedulesError.message}`);
  const scheduleById = new Map(
    (
      (schedules ?? []) as Array<{
        id: string;
        tenant_id: string;
        template_id: string;
        channel_id: string | null;
      }>
    ).map((s) => [s.id, s]),
  );

  const templateIds = [...new Set([...scheduleById.values()].map((s) => s.template_id))];
  const { data: templates, error: templatesError } = templateIds.length
    ? await admin
        .from("messaging_templates")
        .select("id, tenant_id, body, kind, language, variables, provider_template_name, channel_id")
        .in("id", templateIds)
    : { data: [] as TemplateRow[], error: null };
  if (templatesError) throw new Error(`Falha ao carregar templates: ${templatesError.message}`);
  const templateById = new Map(((templates ?? []) as TemplateRow[]).map((t) => [t.id, t]));

  const channelIds = [
    ...new Set(
      [...scheduleById.values()].map((s) => s.channel_id).filter((id): id is string => !!id),
    ),
  ];
  const { data: channels, error: channelsError } = channelIds.length
    ? await admin.from("channels").select("id, tenant_id, provider_slug").in("id", channelIds)
    : { data: [] as ChannelRow[], error: null };
  if (channelsError) throw new Error(`Falha ao carregar canais: ${channelsError.message}`);
  const channelById = new Map(((channels ?? []) as ChannelRow[]).map((c) => [c.id, c]));

  const contactIds = [...new Set(executions.map((e) => e.contact_id))];
  const { data: contacts, error: contactsError } = contactIds.length
    ? await admin
        .from("contacts")
        .select("id, name, phone, email, custom_fields")
        .in("id", contactIds)
        .is("deleted_at", null)
    : { data: [] as ContactRow[], error: null };
  if (contactsError) throw new Error(`Falha ao carregar contatos: ${contactsError.message}`);
  const contactById = new Map(((contacts ?? []) as ContactRow[]).map((c) => [c.id, c]));

  for (const execution of executions) {
    try {
      const schedule = scheduleById.get(execution.schedule_id);
      if (!schedule)
        throw new Error(
          `schedule ${execution.schedule_id} não encontrado para a execução ${execution.id}`,
        );
      const template = templateById.get(schedule.template_id);
      if (!template) throw new Error(`template ${schedule.template_id} não encontrado`);
      if (template.tenant_id !== schedule.tenant_id) {
        throw new Error(`template ${template.id} não pertence ao tenant do schedule`);
      }
      const channel = schedule.channel_id ? (channelById.get(schedule.channel_id) ?? null) : null;
      if (channel && channel.tenant_id !== schedule.tenant_id) {
        throw new Error(`canal ${channel.id} não pertence ao tenant do schedule`);
      }
      const contact = contactById.get(execution.contact_id) ?? null;

      const outcome = await processExecution(admin, execution, {
        tenantId: schedule.tenant_id,
        template,
        channel,
        contact,
      });
      if (outcome === "sent") summary.sent++;
      else if (outcome === "skipped_suppressed") summary.skippedSuppressed++;
      else if (outcome === "deferred") summary.deferred++;
      else summary.failed++;
    } catch (err) {
      const msg = redactSecrets(err);
      summary.errors.push(`${execution.id}: ${msg}`);
      console.error(
        `[template-schedule-runner] execução ${execution.id} falhou inesperadamente: ${msg}`,
      );
      try {
        await markExecution(admin, execution.id, {
          status: "failed",
          error_message: msg,
          attempt_count: execution.attempt_count + 1,
        });
      } catch (markErr) {
        console.error(
          `[template-schedule-runner] falha ao marcar execução ${execution.id} como failed após erro: ${redactSecrets(
            markErr,
          )}`,
        );
      }
      summary.failed++;
    }
  }
  return summary;
}

async function countExecutionsByStatus(
  admin: SupabaseClient,
  scheduleId: string,
  status?: string,
): Promise<number> {
  let query = admin
    .from("template_schedule_executions")
    .select("id", { count: "exact", head: true })
    .eq("schedule_id", scheduleId);
  if (status) query = query.eq("status", status);
  const { count, error } = await query;
  if (error)
    throw new Error(`Falha ao contar execuções do schedule ${scheduleId}: ${error.message}`);
  return count ?? 0;
}

/**
 * Recalcula sent_count/failed_count do schedule a partir da tabela de
 * execuções (fonte de verdade — evita corrida de read-increment-write em
 * JS) e marca o schedule 'completed' quando sent+failed+skipped_suppressed
 * cobre 100% do total. Só transiciona status se o schedule ainda está
 * 'running' (nunca sobrescreve um schedule já 'failed' na geração).
 */
export async function refreshScheduleCounts(
  admin: SupabaseClient,
  scheduleId: string,
): Promise<void> {
  const [total, sent, failed, skipped] = await Promise.all([
    countExecutionsByStatus(admin, scheduleId),
    countExecutionsByStatus(admin, scheduleId, "sent"),
    countExecutionsByStatus(admin, scheduleId, "failed"),
    countExecutionsByStatus(admin, scheduleId, "skipped_suppressed"),
  ]);

  const { error: countsError } = await admin
    .from("template_schedules")
    .update({ sent_count: sent, failed_count: failed })
    .eq("id", scheduleId);
  if (countsError)
    throw new Error(
      `Falha ao atualizar contadores do schedule ${scheduleId}: ${countsError.message}`,
    );

  const allTerminal = total > 0 && sent + failed + skipped === total;
  if (allTerminal) {
    const { error: completeError } = await admin
      .from("template_schedules")
      .update({ status: "completed" })
      .eq("id", scheduleId)
      .eq("status", "running");
    if (completeError) {
      throw new Error(`Falha ao concluir schedule ${scheduleId}: ${completeError.message}`);
    }
  }
}

export interface RunSummary {
  schedulesGenerated: number;
  schedulesFailed: number;
  executionsClaimed: number;
  sent: number;
  failed: number;
  skippedSuppressed: number;
  staleExecutions: number;
  staleSchedules: number;
  errors: string[];
}

// Isolate morto no meio do lote deixa execução em 'sending' e schedule em
// 'running' para sempre (o claim só olha 'pending'). Depois deste prazo o
// reaper fecha a execução como falha INCERTA -- nunca reenvia, porque a
// mensagem pode ter saído.
export const STALE_SENDING_MINUTES = 15;
export const STALE_EXECUTION_MESSAGE =
  "Resultado incerto: o processamento foi interrompido durante o envio. Não reenviado automaticamente para evitar mensagem duplicada.";

/**
 * Fecha execuções presas em 'sending' e schedules presos em 'running' sem
 * nenhuma execução (claim aconteceu, geração não). Devolve os schedules que
 * precisam ter os contadores recalculados.
 */
export async function reapStaleWork(admin: SupabaseClient): Promise<{
  staleExecutions: number;
  staleSchedules: number;
  touchedScheduleIds: string[];
}> {
  const cutoff = new Date(Date.now() - STALE_SENDING_MINUTES * 60 * 1000).toISOString();
  const { data: stale, error } = await admin
    .from("template_schedule_executions")
    .update({ status: "failed", error_message: STALE_EXECUTION_MESSAGE })
    .eq("status", "sending")
    .lt("last_attempt_at", cutoff)
    .select("schedule_id");
  if (error) throw new Error(`Falha ao recuperar execuções presas: ${error.message}`);
  const touched = new Set(((stale ?? []) as Array<{ schedule_id: string }>).map((r) => r.schedule_id));

  const { data: running, error: runningError } = await admin
    .from("template_schedules")
    .select("id")
    .eq("status", "running")
    .lt("scheduled_for", cutoff)
    .limit(DEFAULT_CLAIM_LIMIT);
  if (runningError) throw new Error(`Falha ao buscar agendamentos em execução: ${runningError.message}`);
  let staleSchedules = 0;
  for (const row of (running ?? []) as Array<{ id: string }>) {
    if (touched.has(row.id)) continue;
    if ((await countExecutionsByStatus(admin, row.id)) === 0) {
      console.error(
        `[template-schedule-runner] schedule ${row.id} em 'running' sem execuções há mais de ${STALE_SENDING_MINUTES} min — marcado como failed.`,
      );
      await markScheduleFailed(admin, row.id);
      staleSchedules++;
    }
  }
  return { staleExecutions: stale?.length ?? 0, staleSchedules, touchedScheduleIds: [...touched] };
}

/** Entry point único chamado por index.ts: recupera presos -> gera -> reivindica -> processa -> fecha contadores. */
export async function runTemplateScheduleRunner(admin: SupabaseClient): Promise<RunSummary> {
  const reaped = await reapStaleWork(admin);
  const generation = await generatePendingSchedules(admin);
  const executions = await claimExecutions(admin);
  const processing = await processClaimedExecutions(admin, executions);

  const touchedScheduleIds = [
    ...new Set([...executions.map((e) => e.schedule_id), ...reaped.touchedScheduleIds]),
  ];
  for (const scheduleId of touchedScheduleIds) {
    try {
      await refreshScheduleCounts(admin, scheduleId);
    } catch (err) {
      const msg = redactSecrets(err);
      processing.errors.push(`refresh ${scheduleId}: ${msg}`);
      console.error(
        `[template-schedule-runner] falha ao atualizar contadores do schedule ${scheduleId}: ${msg}`,
      );
    }
  }

  return {
    schedulesGenerated: generation.generated,
    schedulesFailed: generation.failedSchedules,
    executionsClaimed: executions.length,
    sent: processing.sent,
    failed: processing.failed,
    skippedSuppressed: processing.skippedSuppressed,
    staleExecutions: reaped.staleExecutions,
    staleSchedules: reaped.staleSchedules,
    errors: processing.errors,
  };
}
