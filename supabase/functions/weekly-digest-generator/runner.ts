// Motor de geração + envio do resumo semanal (Fase 4 do PRD —
// docs/PRD-CRM-IA-MULTINICHO.md, user story F). Lógica pura: SEM
// `Deno.serve`/`Deno.env` diretos — recebe `admin` (client-like, tipado só
// por `SupabaseClient` do supabase-js) injetado via `WeeklyDigestRunnerDeps`,
// mesmo padrão de DI de nurture-runner/runner.ts e
// template-schedule-runner/runner.ts. index.ts (I/O fino) monta o client
// real e chama `runWeeklyDigestGenerator`.
//
// Testável com o mesmo harness Deno (`createClient` real + `installFetchMock`
// interceptando `fetch`) usado por todos os arquivos-irmãos em
// supabase/functions/tests/ — ver supabase/functions/tests/_helpers.ts e
// docs/TESTING.md ("Edge functions (Deno) — deno test"). NÃO um arquivo
// Vitest: vitest.config.ts só inclui `src/**/*.test.{ts,tsx}` e estes módulos
// importam de esm.sh (URL), que o Vitest/Node não resolve.
//
// GAP de schema resolvido nesta sessão (documentado, não silencioso):
// public.dashboard_report(p_from, p_to, p_tz) resolve o tenant via
// `private.get_user_tenant_id()`, que lê `auth.uid()` — NULL numa function
// dormente chamada com a service role key (sem sessão de usuário). Chamar
// aquela RPC aqui sempre lançaria `unauthenticated` (confirmado rodando a
// RPC direto via query_database, que reproduz o mesmo contexto sem JWT).
// Nova migration `20260711100400_fase4_prb_dashboard_report_for_tenant.sql`
// adiciona `public.dashboard_report_for_tenant(p_tenant_id, p_from, p_to,
// p_tz)` — mesma lógica, tenant explícito, só service_role executa (aplicada
// e verificada na DB real desta sessão). Duplicação deliberada em vez de
// editar `dashboard_report` (usado pela UI, risco/blast-radius maior) — ver
// comentário no topo daquela migration.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { isPhoneSuppressed } from "../_shared/messaging/conversation.ts";
import {
  isSupportedProviderSlug,
  loadProviderSecrets,
  type ProviderSlug,
  sendViaProvider,
} from "../_shared/messaging/provider-send.ts";

export interface WeeklyDigestRunnerDeps {
  admin: SupabaseClient;
}

/** Espelha o CHECK de status em weekly_reports (migration 20260711100000_fase4_prb_weekly_digest_schema.sql). */
export type WeeklyReportStatus = "generated" | "sent" | "failed";
export type WeeklyDeliveryStatus = "pending" | "sending" | "sent" | "failed";

export interface WeeklyReportRow {
  id: string;
  tenant_id: string;
  period_start: string;
  period_end: string;
  metrics: WeeklyDigestMetrics;
  status: WeeklyReportStatus;
}

export interface RecipientRow {
  id: string;
  tenant_id: string;
  channel: "email" | "whatsapp";
  address: string;
  name: string | null;
  active: boolean;
}

interface DeliveryRow {
  id: string;
  report_id: string;
  recipient_id: string;
  channel: string;
  address: string;
  status: WeeklyDeliveryStatus;
  attempt_count: number;
}

export interface LeaderboardEntry {
  owner_id: string;
  owner_name: string;
  wins: number;
  decided: number;
  win_rate_pct: number | null;
  total_won_value: number | null;
}

export interface WeeklyDigestMetrics {
  dashboard: Record<string, unknown>;
  leaderboard: LeaderboardEntry[];
}

// SQLSTATE de violação de constraint única do Postgres -- checagem explícita
// de código, NUNCA de texto de mensagem de erro (risco #5 do PRD: o texto
// muda entre versões/idiomas do Postgres, o código não).
const UNIQUE_VIOLATION = "23505";

// Batch de tenants por invocação -- mesmo racional de DEFAULT_CLAIM_LIMIT dos
// runners irmãos (nurture/template-schedule): evita processar um número
// ilimitado de tenants numa única execução dormente.
const DEFAULT_TENANT_LIMIT = 200;

const DIGEST_WINDOW_DAYS = 7;
const LEADERBOARD_TOP_N = 5;

const WHATSAPP_PROVIDER_SLUGS: readonly ProviderSlug[] = ["zapi", "twilio", "meta-cloud"];

/**
 * Janela fixa de 7 dias corridos, truncada ao início do dia UTC corrente --
 * NÃO à hora exata de "agora". Isso é o que faz a idempotência do relatório
 * funcionar de verdade: 2 disparos no MESMO dia (cron duplicado, retry
 * manual) calculam o MESMO period_start/period_end e colidem no
 * unique(tenant_id, period_start, period_end) de weekly_reports. Se
 * usássemos `new Date()` bruto, 2 disparos com segundos de diferença
 * gerariam period_end distintos e NUNCA colidiriam -- quebrando a
 * idempotência pedida (risco #5 do PRD). Sem alinhamento a "última
 * sexta-feira" nem fuso por tenant (YAGNI -- não pedido; janela simples e
 * documentada, como o ticket permite).
 */
export function computeReportWindow(now: Date = new Date()): { periodStart: string; periodEnd: string } {
  const todayUtcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const periodEnd = todayUtcMidnight.toISOString();
  const periodStart = new Date(todayUtcMidnight.getTime() - DIGEST_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return { periodStart, periodEnd };
}

/** tenant_id distintos com pelo menos 1 destinatário ativo. */
export async function loadTenantsWithActiveRecipients(
  admin: SupabaseClient,
  opts: { limit?: number; periodStart?: string; periodEnd?: string } = {},
): Promise<string[]> {
  const limit = opts.limit ?? DEFAULT_TENANT_LIMIT;
  const { data, error } = await admin
    .from("weekly_report_recipients")
    .select("tenant_id")
    .eq("active", true)
    .order("tenant_id", { ascending: true }); // determinístico antes do dedupe
  if (error) throw new Error(`Falha ao buscar destinatários ativos: ${error.message}`);
  const uniqueTenantIds = [...new Set((data ?? []).map((r: { tenant_id: string }) => r.tenant_id))];
  if (uniqueTenantIds.length <= limit) return uniqueTenantIds;

  // Rotação anti-starvation (bug do lote 2, item 6): quando há >limit
  // tenants ativos, prioriza os que AINDA NÃO têm relatório para a janela
  // atual — assim o próximo tick pega os que ficaram de fora. Best-effort:
  // se a query auxiliar falhar, mantém a ordem determinística.
  if (opts.periodStart && opts.periodEnd) {
    const { data: existingReports, error: reportsErr } = await admin
      .from("weekly_reports")
      .select("tenant_id")
      .in("tenant_id", uniqueTenantIds)
      .eq("period_start", opts.periodStart)
      .eq("period_end", opts.periodEnd);
    if (!reportsErr) {
      const already = new Set(
        ((existingReports ?? []) as Array<{ tenant_id: string }>).map((r) => r.tenant_id),
      );
      uniqueTenantIds.sort((a, b) => {
        const aDone = already.has(a) ? 1 : 0;
        const bDone = already.has(b) ? 1 : 0;
        return aDone - bDone;
      });
    }
  }
  return uniqueTenantIds.slice(0, limit);
}

async function loadActiveRecipients(admin: SupabaseClient, tenantId: string): Promise<RecipientRow[]> {
  const { data, error } = await admin
    .from("weekly_report_recipients")
    .select("id, tenant_id, channel, address, name, active")
    .eq("tenant_id", tenantId)
    .eq("active", true);
  if (error) throw new Error(`Falha ao buscar destinatários ativos do tenant ${tenantId}: ${error.message}`);
  return (data ?? []) as RecipientRow[];
}

async function selectReport(
  admin: SupabaseClient,
  tenantId: string,
  periodStart: string,
  periodEnd: string,
): Promise<WeeklyReportRow | null> {
  const { data, error } = await admin
    .from("weekly_reports")
    .select("id, tenant_id, period_start, period_end, metrics, status")
    .eq("tenant_id", tenantId)
    .eq("period_start", periodStart)
    .eq("period_end", periodEnd)
    .maybeSingle();
  if (error) {
    throw new Error(`Falha ao buscar weekly_reports existente (tenant ${tenantId}): ${error.message}`);
  }
  return (data as WeeklyReportRow | null) ?? null;
}

/**
 * Combina dashboard_report_for_tenant + top N do leaderboard de owners num
 * único jsonb (mesma forma que weekly_reports.metrics grava). Só chamado
 * quando NENHUM relatório já existe para tenant/período (ver getOrCreateReport)
 * -- evita o custo desta agregação numa reexecução do mesmo dia.
 */
async function computeTenantMetrics(
  admin: SupabaseClient,
  tenantId: string,
  periodStart: string,
  periodEnd: string,
): Promise<WeeklyDigestMetrics> {
  const { data: dashboard, error: dashboardError } = await admin.rpc("dashboard_report_for_tenant", {
    p_tenant_id: tenantId,
    p_from: periodStart,
    p_to: periodEnd,
  });
  if (dashboardError) {
    throw new Error(
      `Falha ao calcular métricas do dashboard (tenant ${tenantId}): ${dashboardError.message}`,
    );
  }

  // deal_owner_leaderboard é `security_invoker = true`, mas o client aqui é
  // service_role -- service_role BYPASSA RLS, então a view NÃO se filtra
  // sozinha por tenant para este caller. Sem este `.eq("tenant_id", ...)`
  // explícito, viria o leaderboard de TODOS os tenants.
  const { data: leaderboardRows, error: leaderboardError } = await admin
    .from("deal_owner_leaderboard")
    .select("owner_id, owner_name, wins, decided, win_rate_pct, total_won_value")
    .eq("tenant_id", tenantId)
    .order("wins", { ascending: false })
    .limit(LEADERBOARD_TOP_N);
  if (leaderboardError) {
    throw new Error(`Falha ao calcular leaderboard de owners (tenant ${tenantId}): ${leaderboardError.message}`);
  }

  return {
    dashboard: (dashboard ?? {}) as Record<string, unknown>,
    leaderboard: (leaderboardRows ?? []) as LeaderboardEntry[],
  };
}

/**
 * Claim atômico do relatório: SELECT primeiro (evita recalcular métricas no
 * caso comum, sem corrida) -- se não achar, calcula métricas e faz o INSERT;
 * um 23505 nesse INSERT (corrida real entre 2 execuções concorrentes) faz um
 * SELECT de fallback para pegar o relatório que a OUTRA execução gravou, em
 * vez de usar as métricas que acabamos de calcular aqui. Nunca compara texto
 * de mensagem de erro (risco #5 do PRD) -- só `error.code`.
 */
export async function getOrCreateReport(
  admin: SupabaseClient,
  tenantId: string,
  periodStart: string,
  periodEnd: string,
): Promise<{ report: WeeklyReportRow; wasCreated: boolean }> {
  const existing = await selectReport(admin, tenantId, periodStart, periodEnd);
  if (existing) return { report: existing, wasCreated: false };

  const metrics = await computeTenantMetrics(admin, tenantId, periodStart, periodEnd);

  const { data: inserted, error: insertError } = await admin
    .from("weekly_reports")
    .insert({
      tenant_id: tenantId,
      period_start: periodStart,
      period_end: periodEnd,
      metrics,
      status: "generated",
    })
    .select("id, tenant_id, period_start, period_end, metrics, status")
    .single();

  if (!insertError) {
    return { report: inserted as WeeklyReportRow, wasCreated: true };
  }

  if ((insertError as { code?: string }).code !== UNIQUE_VIOLATION) {
    throw new Error(`Falha ao gravar weekly_reports (tenant ${tenantId}): ${insertError.message}`);
  }

  const winner = await selectReport(admin, tenantId, periodStart, periodEnd);
  if (!winner) {
    throw new Error(
      `weekly_reports ${tenantId}/${periodStart}/${periodEnd}: conflito 23505 mas SELECT de fallback não encontrou a linha (inconsistência inesperada).`,
    );
  }
  return { report: winner, wasCreated: false };
}

/**
 * Claim atômico da delivery: MESMO algoritmo do relatório (INSERT direto;
 * 23505 = já existe, não é erro -- SELECT pega a linha existente). Diferente
 * do relatório, aqui não pré-checamos com SELECT antes (volume por tenant é
 * pequeno -- N destinatários, não N tenants -- e o INSERT já é a operação
 * mais barata do caminho).
 *
 * Limitação de concorrência conhecida (não resolvida aqui, mesmo espírito do
 * caveat documentado em hitl-sla-monitor/index.ts): o ON CONFLICT protege a
 * LINHA (nunca 2 linhas de delivery para o mesmo report_id+recipient_id), não
 * o ENVIO -- 2 invocações verdadeiramente CONCORRENTES (não um retry
 * sequencial, que já vê status terminal) podem ambas cair no ramo "insert
 * conflitou -> SELECT" enquanto a linha ainda está 'pending' e as DUAS
 * tentarem enviar, duplicando o e-mail/WhatsApp. Function dormente sem cron
 * real torna essa janela de corrida rara; resolver exigiria um claim de 2
 * fases (pending -> sending, tipo nurture-runner) não pedido pela tarefa --
 * YAGNI aqui, documentado para quem ligar isso a um scheduler de verdade.
 */
async function claimOrGetDelivery(
  admin: SupabaseClient,
  reportId: string,
  recipient: RecipientRow,
): Promise<{ delivery: DeliveryRow; isNew: boolean }> {
  const { data: inserted, error: insertError } = await admin
    .from("weekly_report_deliveries")
    .insert({
      report_id: reportId,
      recipient_id: recipient.id,
      channel: recipient.channel,
      address: recipient.address,
      status: "pending",
    })
    .select("id, report_id, recipient_id, channel, address, status, attempt_count")
    .single();

  if (!insertError) {
    return { delivery: inserted as DeliveryRow, isNew: true };
  }

  if ((insertError as { code?: string }).code !== UNIQUE_VIOLATION) {
    throw new Error(
      `Falha ao gravar weekly_report_deliveries (report ${reportId}, recipient ${recipient.id}): ${insertError.message}`,
    );
  }

  const { data: existing, error: selectError } = await admin
    .from("weekly_report_deliveries")
    .select("id, report_id, recipient_id, channel, address, status, attempt_count")
    .eq("report_id", reportId)
    .eq("recipient_id", recipient.id)
    .maybeSingle();
  if (selectError || !existing) {
    throw new Error(
      `weekly_report_deliveries (report ${reportId}, recipient ${recipient.id}): conflito 23505 mas SELECT de fallback não encontrou a linha: ${
        selectError?.message ?? "sem retorno"
      }`,
    );
  }
  return { delivery: existing as DeliveryRow, isNew: false };
}

function formatCurrencyBRL(value: number): string {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

interface DashboardSlice {
  atendimento?: {
    conversas_novas?: number;
    primeira_resposta_min?: number | null;
    handoff?: number;
  };
  resultados?: {
    ganhos?: number;
    ganhos_valor?: number;
    perdidos?: number;
  };
}

/**
 * Resumo textual simples das métricas do período -- texto puro, não
 * HTML/bonito (MVP, user story F do PRD só pede o envio funcionar).
 */
export function renderDigestText(report: WeeklyReportRow): string {
  const dashboard = (report.metrics?.dashboard ?? {}) as DashboardSlice;
  const atendimento = dashboard.atendimento ?? {};
  const resultados = dashboard.resultados ?? {};
  const leaderboard = report.metrics?.leaderboard ?? [];

  const periodStartFmt = new Date(report.period_start).toLocaleDateString("pt-BR");
  const periodEndFmt = new Date(report.period_end).toLocaleDateString("pt-BR");

  const lines: string[] = [
    `Resumo semanal — ${periodStartFmt} a ${periodEndFmt}`,
    "",
    "Atendimento:",
    `- Conversas novas: ${atendimento.conversas_novas ?? 0}`,
    `- Primeira resposta média: ${
      atendimento.primeira_resposta_min != null ? `${atendimento.primeira_resposta_min} min` : "sem dados"
    }`,
    `- Handoff para humano: ${atendimento.handoff ?? 0}`,
    "",
    "Resultados:",
    `- Negócios ganhos: ${resultados.ganhos ?? 0} (${formatCurrencyBRL(resultados.ganhos_valor ?? 0)})`,
    `- Negócios perdidos: ${resultados.perdidos ?? 0}`,
    "",
    // "Top vendedores (ranking geral)" -- NÃO "da semana": deal_owner_leaderboard
    // não tem filtro de período (comentário da própria view: "A view nao fixa
    // periodo"), só `tenant_id` (exatamente como a tarefa pediu). Rotular como
    // semanal misturaria, sob o mesmo cabeçalho, métricas de período (atendimento/
    // resultados, via dashboard_report_for_tenant) com um ranking all-time --
    // seria enganoso pro leitor do e-mail.
    "Top vendedores (ranking geral):",
  ];

  if (leaderboard.length === 0) {
    lines.push("- Sem negócios decididos no período.");
  } else {
    leaderboard.forEach((entry, i) => {
      const winRate = entry.win_rate_pct != null ? `${entry.win_rate_pct}%` : "sem dados";
      lines.push(`${i + 1}. ${entry.owner_name} — ${entry.wins} vitórias (win rate ${winRate})`);
    });
  }

  return lines.join("\n");
}

/**
 * Descobre o provider de WhatsApp ativo do tenant -- mesma tabela
 * (tenant_integrations) e mesmo critério (status='active') de
 * messaging-send/index.ts, mas sem um channel_id de referência (o digest não
 * está ligado a um canal específico): varre os slugs de WhatsApp suportados e
 * usa o primeiro ativo encontrado. Sem integração ativa, retorna null (o
 * caller trata como falha isolada deste destinatário, nunca aborta o lote).
 */
async function resolveWhatsappProviderSlug(admin: SupabaseClient, tenantId: string): Promise<ProviderSlug | null> {
  const { data, error } = await admin
    .from("tenant_integrations")
    .select("slug")
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .in("slug", WHATSAPP_PROVIDER_SLUGS as string[])
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`Falha ao buscar integração de WhatsApp ativa (tenant ${tenantId}): ${error.message}`);
  }
  const slug = (data as { slug: string } | null)?.slug;
  return slug && isSupportedProviderSlug(slug) ? slug : null;
}

const WEEKLY_DIGEST_SUBJECT = "Resumo semanal do seu CRM";

type SendDigestResult = { ok: true } | { ok: false; error: string; suppressed: boolean };

/**
 * Envia (ou pula) o digest para 1 destinatário. Para whatsapp, checa
 * `messaging_phone_suppressions` ANTES de despachar (PRD Fase 4, user story
 * H: "bloquear qualquer envio automático... para um número suprimido, com
 * verificação no momento do envio") -- mesmo helper (`isPhoneSuppressed`) já
 * usado por nurture-runner e template-schedule-runner. `suppressed: true`
 * distingue este caminho de uma falha real de provider no outcome de
 * `processRecipient` (ver RecipientOutcome) -- sem isso, "supressão" e "falha
 * de envio" ficariam indistinguíveis no RunSummary.
 */
async function sendDigestToRecipient(
  admin: SupabaseClient,
  tenantId: string,
  recipient: RecipientRow,
  digestText: string,
): Promise<SendDigestResult> {
  let providerSlug: ProviderSlug;
  if (recipient.channel === "email") {
    providerSlug = "resend";
  } else {
    const suppressed = await isPhoneSuppressed(admin, tenantId, recipient.address);
    if (suppressed) {
      console.log(
        `[weekly-digest-generator] envio pulado por supressão de telefone: tenant=${tenantId} recipient=${recipient.id}`,
      );
      return { ok: false, suppressed: true, error: "Telefone suprimido (opt-out) -- envio bloqueado." };
    }
    const resolved = await resolveWhatsappProviderSlug(admin, tenantId);
    if (!resolved) {
      return { ok: false, suppressed: false, error: "Nenhuma integração de WhatsApp ativa configurada para este tenant." };
    }
    providerSlug = resolved;
  }

  const cred = await loadProviderSecrets(admin, tenantId, providerSlug);
  const result = await sendViaProvider({
    admin,
    providerSlug,
    cred,
    phone: recipient.channel === "whatsapp" ? recipient.address : undefined,
    email: recipient.channel === "email" ? recipient.address : undefined,
    content: digestText,
    subject: WEEKLY_DIGEST_SUBJECT,
  });
  return result.ok ? { ok: true } : { ok: false, suppressed: false, error: result.error };
}

type RecipientOutcome = "sent" | "failed" | "skipped_suppressed" | "already_terminal";

/**
 * Processa 1 destinatário já claimado. Delivery já em estado terminal
 * (sent/failed) de uma execução anterior -- não reenvia (idempotência:
 * "não duplica entrega se o worker reprocessar o mesmo relatório", comentário
 * da migration). Caso contrário (nova ou presa em pending/sending de uma
 * execução anterior que não completou), tenta enviar e grava sent/failed.
 */
async function processRecipient(
  admin: SupabaseClient,
  tenantId: string,
  reportId: string,
  recipient: RecipientRow,
  digestText: string,
): Promise<RecipientOutcome> {
  const { delivery, isNew } = await claimOrGetDelivery(admin, reportId, recipient);
  if (!isNew && (delivery.status === "sent" || delivery.status === "failed")) {
    return "already_terminal";
  }

  // Claim de 2 fases (bug do lote 2, item 5): transição atômica
  // pending -> sending. Só quem ganha o UPDATE envia; uma segunda invocação
  // vê status='sending' e desiste. Se `isNew` (recém-inserido pending) ou
  // era 'pending' de uma execução anterior órfã, ambos entram por aqui.
  const { data: claimed, error: claimError } = await admin
    .from("weekly_report_deliveries")
    .update({ status: "sending" as WeeklyDeliveryStatus })
    .eq("id", delivery.id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (claimError) {
    throw new Error(
      `Falha ao reivindicar delivery ${delivery.id} para envio: ${claimError.message}`,
    );
  }
  if (!claimed) {
    // Outra invocação está enviando (status='sending') OU já terminou
    // (sent/failed) — em qualquer caso, NÃO reenviar.
    return "already_terminal";
  }

  const result = await sendDigestToRecipient(admin, tenantId, recipient, digestText);
  const patch = {
    status: (result.ok ? "sent" : "failed") as WeeklyDeliveryStatus,
    attempt_count: delivery.attempt_count + 1,
  };

  const { error: updateError } = await admin.from("weekly_report_deliveries").update(patch).eq("id", delivery.id);
  if (updateError) {
    // Estado crítico: enviamos (ou falhamos deliberadamente) mas não
    // conseguimos gravar o estado terminal — a linha fica 'sending' e não
    // será reenviada por este runner (novo claim pending->sending não casa).
    // Mesmo protocolo do nurture-runner: LOG DESTACADO para reconciliação
    // manual, nunca reenviar automaticamente para não duplicar entrega.
    console.error(
      `[weekly-digest-generator] CRÍTICO: delivery ${delivery.id} enviada mas não pôde gravar estado terminal — ficará em 'sending' até intervenção manual: ${updateError.message}`,
    );
    throw new Error(`Falha crítica ao atualizar weekly_report_deliveries ${delivery.id}: ${updateError.message}`);
  }

  if (result.ok) return "sent";
  return result.suppressed ? "skipped_suppressed" : "failed";
}

interface DeliveryBatchSummary {
  sent: number;
  failed: number;
  skippedSuppressed: number;
  errors: string[];
}

/**
 * Processa todos os destinatários ativos de 1 tenant para 1 relatório. Erro
 * em 1 destinatário NUNCA aborta o processamento dos demais -- try/catch
 * isolado por linha, mesmo padrão dos runners irmãos (nurture/template-
 * schedule).
 */
async function processRecipientsForReport(
  admin: SupabaseClient,
  report: WeeklyReportRow,
  recipients: RecipientRow[],
): Promise<DeliveryBatchSummary> {
  const summary: DeliveryBatchSummary = { sent: 0, failed: 0, skippedSuppressed: 0, errors: [] };
  if (recipients.length === 0) return summary;

  const digestText = renderDigestText(report);

  for (const recipient of recipients) {
    try {
      const outcome = await processRecipient(admin, report.tenant_id, report.id, recipient, digestText);
      if (outcome === "sent") summary.sent++;
      else if (outcome === "failed") summary.failed++;
      else if (outcome === "skipped_suppressed") summary.skippedSuppressed++;
      // "already_terminal": já contabilizado numa execução anterior, não conta de novo aqui.
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[weekly-digest-generator] falha inesperada ao processar destinatário ${recipient.id}: ${message}`,
      );
      summary.errors.push(`${recipient.id}: ${message}`);
      summary.failed++;
    }
  }

  return summary;
}

/**
 * Recalcula (a partir da tabela de deliveries, fonte de verdade -- evita
 * corrida de read-increment-write em JS, mesmo padrão de
 * template-schedule-runner::refreshScheduleCounts) se TODAS as deliveries do
 * relatório estão em estado terminal (sent/failed) e, se sim, marca
 * weekly_reports.status='sent' -- reflete "o envio foi tentado/concluído",
 * NÃO "100% de sucesso" (delivery individual pode ter falhado).
 */
async function maybeMarkReportSent(admin: SupabaseClient, reportId: string): Promise<boolean> {
  const { count: total, error: totalError } = await admin
    .from("weekly_report_deliveries")
    .select("id", { count: "exact", head: true })
    .eq("report_id", reportId);
  if (totalError) throw new Error(`Falha ao contar deliveries do relatório ${reportId}: ${totalError.message}`);

  const { count: terminal, error: terminalError } = await admin
    .from("weekly_report_deliveries")
    .select("id", { count: "exact", head: true })
    .eq("report_id", reportId)
    .in("status", ["sent", "failed"]);
  if (terminalError) {
    throw new Error(`Falha ao contar deliveries terminais do relatório ${reportId}: ${terminalError.message}`);
  }

  if (!total || total !== terminal) return false;

  const { error: markError } = await admin.from("weekly_reports").update({ status: "sent" }).eq("id", reportId);
  if (markError) throw new Error(`Falha ao marcar weekly_reports ${reportId} como sent: ${markError.message}`);
  return true;
}

export interface RunSummary {
  tenantsProcessed: number;
  reportsGenerated: number;
  reportsReused: number;
  reportsMarkedSent: number;
  deliveriesSent: number;
  deliveriesFailed: number;
  deliveriesSkippedSuppressed: number;
  errors: string[];
}

/**
 * Ponto de entrada da lógica: para cada tenant com destinatário ativo,
 * gera/reaproveita o relatório da janela (7 dias, truncada ao dia UTC),
 * processa cada destinatário em isolamento e fecha o status do relatório.
 * Erro em 1 tenant nunca aborta o processamento dos demais.
 */
export async function runWeeklyDigestGenerator(
  deps: WeeklyDigestRunnerDeps,
  opts: { limit?: number } = {},
): Promise<RunSummary> {
  const { admin } = deps;
  const { periodStart, periodEnd } = computeReportWindow();
  const tenantIds = await loadTenantsWithActiveRecipients(admin, { ...opts, periodStart, periodEnd });

  const summary: RunSummary = {
    tenantsProcessed: 0,
    reportsGenerated: 0,
    reportsReused: 0,
    reportsMarkedSent: 0,
    deliveriesSent: 0,
    deliveriesFailed: 0,
    deliveriesSkippedSuppressed: 0,
    errors: [],
  };

  for (const tenantId of tenantIds) {
    summary.tenantsProcessed++;
    try {
      const { report, wasCreated } = await getOrCreateReport(admin, tenantId, periodStart, periodEnd);
      if (wasCreated) summary.reportsGenerated++;
      else summary.reportsReused++;

      const recipients = await loadActiveRecipients(admin, tenantId);
      const deliverySummary = await processRecipientsForReport(admin, report, recipients);
      summary.deliveriesSent += deliverySummary.sent;
      summary.deliveriesFailed += deliverySummary.failed;
      summary.deliveriesSkippedSuppressed += deliverySummary.skippedSuppressed;
      summary.errors.push(...deliverySummary.errors);

      const markedSent = await maybeMarkReportSent(admin, report.id);
      if (markedSent) summary.reportsMarkedSent++;
    } catch (err) {
      // Defesa extra: as funções internas já isolam erro por destinatário --
      // isto cobre falhas na própria geração/claim do relatório do tenant
      // (query dashboard_report_for_tenant, leaderboard, insert em
      // weekly_reports), que aí sim abortam SÓ este tenant, nunca os demais.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[weekly-digest-generator] falha ao processar tenant ${tenantId}: ${message}`);
      summary.errors.push(`tenant ${tenantId}: ${message}`);
    }
  }

  return summary;
}
