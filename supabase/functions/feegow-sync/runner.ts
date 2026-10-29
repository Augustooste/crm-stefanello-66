// runner.ts — lógica pura do feegow-sync (Fase 6, Sub-feature 2): busca
// agendamentos Feegow por tenant com integração 'feegow' ativa, mapeia para
// o schema genérico public.appointments (idempotente via ON CONFLICT em
// tenant_id/external_source/external_ref -- índice parcial
// appointments_external_dedupe, migration 20260712130000) e grava 1 linha
// por tenant em feegow_sync_log. Mesmo padrão de DI (admin injetado) de
// messaging-channels-reconcile/runner.ts, nurture-runner/runner.ts etc --
// index.ts (I/O fino) monta o client real e chama runFeegowSync.
//
// Testável com o mesmo harness Deno (createClient real + installFetchMock
// interceptando fetch) usado por todos os arquivos-irmãos em
// supabase/functions/tests/ -- ver supabase/functions/tests/_helpers.ts e
// docs/TESTING.md ("Edge functions (Deno) — deno test").
//
// Isolamento por tenant via Promise.allSettled (critério de aceite do PRD:
// "falha de rede/API não derruba o cron para outros tenants") -- cada
// syncTenant() já captura seus próprios erros e nunca lança (sempre devolve
// um TenantSyncOutcome), e syncTenantAndLog() sempre tenta gravar esse
// outcome em feegow_sync_log; o allSettled por cima garante que mesmo uma
// falha inesperada NESSA gravação (ex.: erro de rede no insert do log) não
// aborta o processamento dos tenants irmãos.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { searchAppointments, type FeegowAppointment, type FeegowCredentials } from "../_shared/feegow/client.ts";

export interface FeegowSyncDeps {
  admin: SupabaseClient;
}

interface FeegowIntegrationRow {
  tenant_id: string;
}

// Batch/janela -- não pedidos explicitamente, mas evitam processar volume
// ilimitado numa única execução (mesmo racional de DEFAULT_CHANNEL_LIMIT em
// messaging-channels-reconcile/runner.ts) e mantêm a busca por um período
// razoável em torno de hoje (mesmos defaults usados em medflow-v0
// lib/integrations/feegow/appointments-sync.ts).
const DEFAULT_TENANT_LIMIT = 200;
const DAYS_BACK = 90;
const DAYS_FORWARD = 30;
const UPSERT_CHUNK_SIZE = 100;

/** Espelha o CHECK de public.appointments.status (migration 20260712130000_fase6_agenda_appointments.sql). */
export type AppointmentStatus =
  | "scheduled"
  | "confirmed"
  | "completed"
  | "no_show"
  | "cancelled"
  | "rescheduled";

/**
 * status_id da Feegow -> enum deste CRM (defaults documentados pela
 * Feegow) -- mesmo mapa usado em medflow-v0
 * lib/integrations/feegow/appointments-sync.ts (FEEGOW_STATUS_MAP).
 * Qualquer status_id desconhecido cai em 'scheduled' (default seguro) --
 * NUNCA lança, para um código novo/custom da clínica não derrubar o sync.
 */
export const FEEGOW_STATUS_MAP: Record<number, AppointmentStatus> = {
  1: "scheduled", // Agendado
  2: "confirmed", // Confirmado
  3: "completed", // Atendido / Finalizado
  6: "no_show", // Faltou
  7: "cancelled", // Cancelado / Desmarcado
  8: "rescheduled", // Remarcado
};

export function mapFeegowStatus(statusId: number): AppointmentStatus {
  return FEEGOW_STATUS_MAP[statusId] ?? "scheduled";
}

/** "dd-mm-YYYY" -> "YYYY-MM-DD". null se ausente/inválido -- sem data não dá para persistir. */
export function parseFeegowDate(data: string | undefined): string | null {
  if (!data) return null;
  const m = data.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** "HH:MM:SS" ou "HH:MM" -> "HH:MM:SS". Default "00:00:00" se ausente/inválido. */
export function normalizeTime(horario: string | undefined): string {
  if (!horario) return "00:00:00";
  const m = horario.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return "00:00:00";
  return `${m[1].padStart(2, "0")}:${m[2]}:${m[3] ?? "00"}`;
}

/** Soma `minutes` a "HH:MM:SS" sem virar o dia. null se minutes ausente/inválido/<=0. */
export function addMinutes(timeStart: string, minutes: number | null): string | null {
  if (!minutes || minutes <= 0) return null;
  const m = timeStart.match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const total = Number(m[1]) * 60 + Number(m[2]) + minutes;
  const hh = Math.floor((total % (24 * 60)) / 60);
  const mm = total % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${m[3]}`;
}

function toDuration(d: number | string | null | undefined): number | null {
  if (d == null) return null;
  const n = typeof d === "number" ? d : Number(d);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

export interface AppointmentUpsertRow {
  tenant_id: string;
  title: string;
  date: string;
  time_start: string;
  time_end: string | null;
  modality: "presencial" | "online";
  status: AppointmentStatus;
  notes: null;
  external_ref: string;
  external_source: "feegow";
}

/**
 * Mapeia 1 agendamento Feegow -> linha upsertável de public.appointments.
 * null se faltar data ou agendamento_id (nada para persistir/deduplicar).
 *
 * `notes` é sempre null e `title` é um rótulo genérico fixo ("Consulta") --
 * decisão espelhada de medflow-v0 (mesma justificativa): o campo `notas` da
 * Feegow pode conter informação clínica (PII) e não deve ser replicado fora
 * do sistema de origem; um título com nome de paciente/procedimento exigiria
 * uma chamada extra a /procedures/list, fora do corte de escopo desta
 * sub-feature (PRD, linha 2559).
 */
export function mapFeegowAppointment(tenantId: string, raw: FeegowAppointment): AppointmentUpsertRow | null {
  const date = parseFeegowDate(raw.data);
  if (!date || !raw.agendamento_id) return null;

  const timeStart = normalizeTime(raw.horario);
  const duration = toDuration(raw.duracao);

  return {
    tenant_id: tenantId,
    title: "Consulta",
    date,
    time_start: timeStart,
    time_end: addMinutes(timeStart, duration),
    modality: raw.telemedicina ? "online" : "presencial",
    status: mapFeegowStatus(raw.status_id),
    notes: null,
    external_ref: String(raw.agendamento_id),
    external_source: "feegow",
  };
}

function fmtFeegowDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${d.getFullYear()}`;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function loadActiveFeegowIntegrations(
  admin: SupabaseClient,
  limit: number,
): Promise<FeegowIntegrationRow[]> {
  const { data, error } = await admin
    .from("tenant_integrations")
    .select("tenant_id")
    .eq("slug", "feegow")
    .eq("status", "active");
  if (error) throw new Error(`Falha ao buscar integrações Feegow ativas: ${error.message}`);
  const rows = (data ?? []) as FeegowIntegrationRow[];
  if (rows.length <= limit) return rows;

  // Rotação anti-starvation (bug do lote 2, item 6): quando há >limit tenants
  // ativos, prioriza os que sincronizaram há mais tempo (ou nunca), lendo
  // max(created_at) por tenant de feegow_sync_log. Nulls (nunca sincronizou)
  // vão primeiro. Best-effort: se a query auxiliar falhar, cai para a ordem
  // natural (comportamento antigo).
  const tenantIds = rows.map((r) => r.tenant_id);
  const { data: logRows, error: logErr } = await admin
    .from("feegow_sync_log")
    .select("tenant_id, created_at")
    .in("tenant_id", tenantIds)
    .order("created_at", { ascending: false });
  if (logErr) return rows.slice(0, limit);
  const lastByTenant = new Map<string, string>();
  for (const r of (logRows ?? []) as Array<{ tenant_id: string; created_at: string }>) {
    if (!lastByTenant.has(r.tenant_id)) lastByTenant.set(r.tenant_id, r.created_at);
  }
  const sorted = [...rows].sort((a, b) => {
    const la = lastByTenant.get(a.tenant_id);
    const lb = lastByTenant.get(b.tenant_id);
    if (!la && !lb) return 0;
    if (!la) return -1;
    if (!lb) return 1;
    return la.localeCompare(lb);
  });
  return sorted.slice(0, limit);
}

/**
 * Mesma leitura de integration_secrets (tenant_id+slug) de
 * loadProviderSecrets em _shared/messaging/provider-send.ts -- duplicada
 * aqui (não é messaging-específico) para manter este adapter de nicho
 * sem depender do subsistema de mensageria.
 */
async function loadFeegowSecrets(
  admin: SupabaseClient,
  tenantId: string,
): Promise<{ clinicId: string; accessToken: string }> {
  const { data, error } = await admin
    .from("integration_secrets")
    .select("key, value")
    .eq("tenant_id", tenantId)
    .eq("slug", "feegow");
  if (error) {
    throw new Error(`Falha ao carregar credenciais Feegow do tenant ${tenantId}: ${error.message}`);
  }
  const cred: Record<string, string> = {};
  for (const row of data ?? []) cred[row.key as string] = row.value as string;
  return { clinicId: cred.clinic_id ?? "", accessToken: cred.access_token ?? "" };
}

export interface TenantSyncOutcome {
  status: "success" | "partial" | "error";
  syncedCount: number;
  errorDetail: string | null;
}

/**
 * Sincroniza 1 tenant: busca a janela [-DAYS_BACK, +DAYS_FORWARD] dias em
 * torno de `now` na Feegow, mapeia e faz upsert em lotes idempotentes.
 * NUNCA lança -- qualquer erro (credenciais ausentes, API fora do ar,
 * upsert falhando) vira status='error'/'partial' no retorno, nunca uma
 * exceção não tratada. Isso garante que syncTenantAndLog sempre tenha o que
 * gravar em feegow_sync_log, mesmo quando tudo dá errado.
 */
async function syncTenant(
  admin: SupabaseClient,
  tenantId: string,
  now: Date,
): Promise<TenantSyncOutcome> {
  try {
    const secrets = await loadFeegowSecrets(admin, tenantId);
    if (!secrets.clinicId || !secrets.accessToken) {
      return {
        status: "error",
        syncedCount: 0,
        errorDetail: "Credenciais Feegow incompletas (clinic_id/access_token ausentes).",
      };
    }

    // `apiBaseUrl` de FeegowCredentials NUNCA é preenchido aqui, deliberadamente
    // -- é só um override para teste unitário direto do client.ts. Preenchê-lo a
    // partir de tenant_integrations.config permitiria um admin do próprio tenant
    // (via UPDATE REST direto, não pela UI) apontar o sync para uma URL
    // arbitrária com o access_token da Feegow anexado (SSRF) -- achado do
    // review de segurança da Fase 6, corrigido antes do merge.
    const credentials: FeegowCredentials = {
      clinicId: secrets.clinicId,
      accessToken: secrets.accessToken,
    };

    const start = new Date(now.getTime() - DAYS_BACK * 86_400_000);
    const end = new Date(now.getTime() + DAYS_FORWARD * 86_400_000);

    let appts: FeegowAppointment[];
    try {
      appts = await searchAppointments(credentials, {
        data_start: fmtFeegowDate(start),
        data_end: fmtFeegowDate(end),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: "error", syncedCount: 0, errorDetail: message };
    }

    const rows = appts
      .map((appt) => mapFeegowAppointment(tenantId, appt))
      .filter((row): row is AppointmentUpsertRow => row !== null);

    let syncedCount = 0;
    const upsertErrors: string[] = [];
    for (const batch of chunk(rows, UPSERT_CHUNK_SIZE)) {
      // RPC dedicada (feegow_upsert_appointments, migration
      // 20260712150000_fase6_feegow_sync_log.sql), não .upsert(onConflict:...)
      // direto -- appointments_external_dedupe é um índice ÚNICO PARCIAL
      // (where external_ref is not null), e o parâmetro on_conflict do
      // PostgREST não consegue expressar esse predicado (verificado
      // empiricamente: ON CONFLICT com lista de colunas nua falha com 42P10
      // contra um índice parcial). A RPC repete o predicado em SQL puro.
      const { error } = await admin.rpc("feegow_upsert_appointments", { p_rows: batch });
      if (error) upsertErrors.push(error.message);
      else syncedCount += batch.length;
    }

    if (upsertErrors.length === 0) return { status: "success", syncedCount, errorDetail: null };
    return {
      status: syncedCount > 0 ? "partial" : "error",
      syncedCount,
      errorDetail: upsertErrors.join("; "),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: "error", syncedCount: 0, errorDetail: message };
  }
}

async function syncTenantAndLog(
  admin: SupabaseClient,
  integration: FeegowIntegrationRow,
  now: Date,
): Promise<TenantSyncOutcome> {
  const outcome = await syncTenant(admin, integration.tenant_id, now);
  const { error } = await admin.from("feegow_sync_log").insert({
    tenant_id: integration.tenant_id,
    status: outcome.status,
    synced_count: outcome.syncedCount,
    error_detail: outcome.errorDetail,
  });
  if (error) {
    throw new Error(`Falha ao gravar feegow_sync_log do tenant ${integration.tenant_id}: ${error.message}`);
  }
  return outcome;
}

export interface RunSummary {
  tenantsProcessed: number;
  tenantsFailed: number;
  totalSynced: number;
  errors: Array<{ tenantId: string; message: string }>;
}

/**
 * Ponto de entrada da lógica: para cada tenant com integração 'feegow'
 * ativa, sincroniza agendamentos em paralelo (Promise.allSettled) -- a
 * falha de 1 tenant (rede, credencial, upsert) nunca impede o processamento
 * dos demais (critério de aceite do PRD).
 */
export async function runFeegowSync(
  deps: FeegowSyncDeps,
  opts: { limit?: number; now?: Date } = {},
): Promise<RunSummary> {
  const { admin } = deps;
  const now = opts.now ?? new Date();
  const integrations = await loadActiveFeegowIntegrations(admin, opts.limit ?? DEFAULT_TENANT_LIMIT);

  const settled = await Promise.allSettled(
    integrations.map((integration) => syncTenantAndLog(admin, integration, now)),
  );

  const summary: RunSummary = {
    tenantsProcessed: integrations.length,
    tenantsFailed: 0,
    totalSynced: 0,
    errors: [],
  };

  settled.forEach((result, i) => {
    const tenantId = integrations[i].tenant_id;
    if (result.status === "fulfilled") {
      summary.totalSynced += result.value.syncedCount;
      if (result.value.status === "error") summary.tenantsFailed++;
    } else {
      summary.tenantsFailed++;
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      console.error(`[feegow-sync] falha ao sincronizar/gravar log do tenant ${tenantId}:`, message);
      summary.errors.push({ tenantId, message });
    }
  });

  return summary;
}
