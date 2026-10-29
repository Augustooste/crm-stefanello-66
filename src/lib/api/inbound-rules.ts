import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { DeveloperApiError } from "@/lib/api/developer";
import { assertPublicSupabaseEnv } from "@/lib/env";
import { useCurrentProfile } from "@/lib/api/session";

/**
 * Regras de entrada (v2, Task 7): webhooks de ENTRADA configuráveis na tela.
 *
 * `types.ts` (gerado) ainda não conhece as tabelas/RPCs novas e não pode ser
 * editado. Mesmo padrão de `developer.ts`: UM cast controlado para uma interface
 * estreita; quando `types.ts` for regenerado, basta trocar `db` por `supabase`.
 */
type DbError = { message: string; code?: string } | null;
type DbResult = { data: unknown; error: DbError };
interface DbQuery extends PromiseLike<DbResult> {
  select(columns: string): DbQuery;
  eq(column: string, value: string): DbQuery;
  gte(column: string, value: string): DbQuery;
  order(column: string, options?: { ascending: boolean }): DbQuery;
  range(from: number, to: number): DbQuery;
  maybeSingle(): PromiseLike<DbResult>;
}
interface InboundDb {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<DbResult>;
  from(table: string): DbQuery;
}
const db = supabase as unknown as InboundDb;

// --- erros (mensagens reais das migrations 20261021100000/110000/131000 e 20261022100000) ---

/** Tetos de set_inbound_rule_limits (c_minute_cap/c_day_cap); 120/min = RATE_LIMIT_MAX da edge. */
export const MAX_LIMIT_PER_MINUTE = 120;
export const MAX_LIMIT_PER_DAY = 5000;

const DEFAULT_ERROR_MESSAGE = "Não foi possível concluir a operação. Tente novamente.";
const PERMISSION_MESSAGE = "Você não tem permissão para gerenciar integrações.";

/** 22023 serve a muitos erros: a mensagem do banco escolhe o texto. */
const INVALID_MESSAGES: ReadonlyMap<string, string> = new Map([
  ["nome invalido", "Nome inválido: use de 1 a 120 caracteres."],
  ["modo para nao encontrado invalido", "Escolha o que fazer quando o negócio não for encontrado."],
  ["modo de verificacao invalido", "Modo de verificação inválido."],
  ["header do token invalido", "Nome do header inválido: use letras, números e hífen (até 64)."],
  [
    "header do token reservado: escolha outro nome (ex.: asaas-access-token)",
    "Esse nome de header é reservado. Escolha outro (ex.: asaas-access-token).",
  ],
  ["segredo invalido (8 a 512 caracteres)", "Segredo inválido: use de 8 a 512 caracteres."],
  ["funil invalido", "Funil inválido para este workspace."],
  ["etapas invalidas", "Etapas inválidas: escolha de 1 a 20 etapas do funil selecionado."],
  ["acao invalida", "Ação inválida."],
  ["configuracao da acao invalida", "Configuração da ação inválida."],
  ["transformacao invalida", "Transformação inválida."],
  ["prefixo invalido", "Prefixo inválido: use só em telefone, como +55."],
  ["destino invalido", "Etapa de destino inválida para esta ação."],
  ["motivo invalido", "Motivo inválido: use de 1 a 500 caracteres."],
  ["motivo obrigatorio", "Informe o motivo da perda (caminho no evento ou texto fixo)."],
  ["texto da nota invalido", "Texto da nota inválido: use de 1 a 500 caracteres."],
  [
    "atividade invalida",
    "Atividade inválida: título de 1 a 500 caracteres e prazo de 0 a 720 horas.",
  ],
  ["campo de identificacao invalido", "Campo de identificação inválido."],
  [
    "caminho invalido",
    "Caminho inválido: use letras, números, _ e -, separados por ponto (até 10 níveis).",
  ],
  ["campo personalizado invalido", "Campo personalizado inválido para identificar o negócio."],
  ["condicoes invalidas", "Condições inválidas: até 5, cada uma com caminho e valor."],
  [
    "condicao invalida: use exatamente um de equals ou in",
    'Condição inválida: use "Igual a" ou "Qualquer um de", não os dois.',
  ],
  [
    "condicao invalida: in deve ser lista de 1 a 10 textos nao vazios (ate 200 caracteres cada)",
    'Condição inválida: "Qualquer um de" aceita de 1 a 10 valores não vazios, com até 200 caracteres cada.',
  ],
  ["active obrigatorio", "Informe se a regra deve ficar ativa."],
  // v2.2 (20261023100000): set_inbound_rule_limits e match_fallback_path.
  [
    "limite por minuto invalido",
    `Limite por minuto inválido: use um número inteiro de 1 a ${MAX_LIMIT_PER_MINUTE}.`,
  ],
  [
    "limite diario invalido",
    `Limite diário inválido: use um número inteiro de 1 a ${MAX_LIMIT_PER_DAY}.`,
  ],
  [
    "caminho alternativo invalido",
    "Caminho alternativo inválido: só para e-mail ou telefone, com letras, números, _ e -, separados por ponto.",
  ],
  ["amostra invalida (maximo 64 KB)", "Amostra inválida: envie um JSON de até 64 KB."],
]);

function inboundMessage(code: string | null | undefined, original?: string): string {
  switch (code) {
    case "42501":
      return PERMISSION_MESSAGE;
    case "P0002":
      return "Regra não encontrada.";
    case "54000":
      return "Limite atingido: até 20 regras de entrada por workspace.";
    case "22023":
      return (
        (original ? INVALID_MESSAGES.get(original) : undefined) ??
        "Dados inválidos. Confira os campos da regra."
      );
    default:
      return DEFAULT_ERROR_MESSAGE;
  }
}

/**
 * Erro das regras de entrada. É um `DeveloperApiError` (a UI de desenvolvedor
 * trata os dois igual, por `code`), com `message` em português. O texto cru do
 * Postgres fica só em `cause`.
 */
export class InboundRuleApiError extends DeveloperApiError {
  constructor(code: string | null | undefined, originalMessage?: string) {
    super(code, originalMessage);
    this.message = inboundMessage(code, originalMessage);
    this.name = "InboundRuleApiError";
  }
}

async function callRpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new InboundRuleApiError(error.code, error.message);
  return data;
}

async function runQuery(query: DbQuery): Promise<unknown[]> {
  const { data, error } = await query;
  if (error) throw new InboundRuleApiError(error.code, error.message);
  return (data ?? []) as unknown[];
}

/** RPC `returns table` vem como array de uma linha. */
function firstRow<T>(data: unknown, label: string): T {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new InboundRuleApiError(null, `Resposta vazia de ${label}`);
  return row as T;
}

// --- tipos ---

export type InboundVerificationMode = "aceleraflow_hmac" | "stripe_signature" | "header_token";
export type InboundAction =
  "move_stage" | "mark_won" | "mark_lost" | "add_note" | "create_activity";
export type InboundMatchField = "email" | "phone" | "deal_custom_field";
export type InboundNotFoundMode = "ignore" | "record";
export type InboundTransform = "trim" | "lower" | "digits" | "cents_to_decimal";
/**
 * Exatamente um de `equals` (igual a) ou `in` (qualquer um de, 1 a 10 textos), como exige
 * assert_inbound_rule_config (migration 20261022100000). Comparação de texto sensível a maiúsculas.
 */
export type InboundCondition = {
  path: string;
  equals?: string;
  in?: string[];
  transform?: InboundTransform;
};
/** Chaves aceitas por ação: ver o contrato no cabeçalho da migration 20261021100000. */
export type InboundActionConfig = Record<string, unknown>;

export type InboundRule = {
  id: string;
  tenantId: string;
  name: string;
  active: boolean;
  /** 'manual' (pausa do admin) ou 'daily_limit' (limite diário estourado); null = ativa. */
  disabledReason: "manual" | "daily_limit" | null;
  verificationMode: InboundVerificationMode;
  tokenHeaderName: string | null;
  previousSecretExpiresAt: string | null;
  boardId: string;
  allowedStageIds: string[];
  action: InboundAction;
  actionConfig: InboundActionConfig;
  matchField: InboundMatchField;
  matchPath: string;
  matchCustomFieldKey: string | null;
  eventIdPath: string;
  conditions: InboundCondition[];
  notFoundMode: InboundNotFoundMode;
  maxActionsPerMinute: number;
  maxActionsPerDay: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  reactivatedAt: string | null;
  /** Eventos ignorados antes de virar evento (v2.2): sem id e, com a edge nova, corpo inválido. */
  ignoredCount: number;
  lastIgnoredAt: string | null;
  lastIgnoredReason: InboundIgnoredReason | null;
};

/** Lista fechada de record_inbound_ignored (migration 20261023100000). */
export type InboundIgnoredReason =
  "missing_event_id" | "invalid_json" | "invalid_payload" | "nul_payload";

export type InboundEventStatus =
  "processing" | "processed" | "ignored" | "not_found" | "ambiguous" | "rate_limited" | "failed";

export type InboundEvent = {
  id: string;
  ruleId: string;
  externalEventId: string;
  status: InboundEventStatus;
  attempts: number;
  actionTaken: string | null;
  dealId: string | null;
  errorCode: string | null;
  /** Só valores extraídos, nunca o corpo recebido. */
  extracted: unknown;
  receivedAt: string;
  processedAt: string | null;
  /** Reenvios respondidos como repetidos (v2.1); 0 no primeiro recebimento. */
  duplicateCount: number;
  lastDuplicateAt: string | null;
};

export type InboundPreviewOutcome =
  | "missing_event_id"
  | "ignored"
  | "not_found"
  | "ambiguous"
  | "deal_not_open"
  | "already_in_stage"
  | "act";

/** Resultado do dry run (`preview_inbound_rule`): nada é gravado. */
export type InboundPreview = {
  externalEventId: string | null;
  conditionsOk: boolean | null;
  identifier: string | null;
  outcome: InboundPreviewOutcome;
  dealId: string | null;
  dealTitle: string | null;
  fromStageId: string | null;
  targetStageId: string | null;
  reason: string | null;
  noteText: string | null;
};

type Raw = Record<string, unknown>;

// Colunas explícitas: as únicas com grant (nunca vault_secret_id nem previous_vault_secret_id).
const RULE_COLUMNS =
  "id, tenant_id, name, active, disabled_reason, verification_mode, token_header_name, previous_secret_expires_at, board_id, allowed_stage_ids, action, action_config, match_field, match_path, match_custom_field_key, event_id_path, conditions, not_found_mode, max_actions_per_minute, max_actions_per_day, created_by, created_at, updated_at, reactivated_at, ignored_count, last_ignored_at, last_ignored_reason";
const EVENT_COLUMNS =
  "id, rule_id, external_event_id, status, attempts, action_taken, deal_id, error_code, extracted, received_at, processed_at, duplicate_count, last_duplicate_at";

function toRule(r: Raw): InboundRule {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    name: r.name as string,
    active: r.active as boolean,
    disabledReason: (r.disabled_reason ?? null) as InboundRule["disabledReason"],
    verificationMode: r.verification_mode as InboundVerificationMode,
    tokenHeaderName: (r.token_header_name ?? null) as string | null,
    previousSecretExpiresAt: (r.previous_secret_expires_at ?? null) as string | null,
    boardId: r.board_id as string,
    allowedStageIds: r.allowed_stage_ids as string[],
    action: r.action as InboundAction,
    actionConfig: r.action_config as InboundActionConfig,
    matchField: r.match_field as InboundMatchField,
    matchPath: r.match_path as string,
    matchCustomFieldKey: (r.match_custom_field_key ?? null) as string | null,
    eventIdPath: r.event_id_path as string,
    conditions: r.conditions as InboundCondition[],
    notFoundMode: r.not_found_mode as InboundNotFoundMode,
    maxActionsPerMinute: r.max_actions_per_minute as number,
    maxActionsPerDay: r.max_actions_per_day as number,
    createdBy: (r.created_by ?? null) as string | null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    reactivatedAt: (r.reactivated_at ?? null) as string | null,
    ignoredCount: (r.ignored_count ?? 0) as number,
    lastIgnoredAt: (r.last_ignored_at ?? null) as string | null,
    lastIgnoredReason: (r.last_ignored_reason ?? null) as InboundIgnoredReason | null,
  };
}

function toEvent(r: Raw): InboundEvent {
  return {
    id: r.id as string,
    ruleId: r.rule_id as string,
    externalEventId: r.external_event_id as string,
    status: r.status as InboundEventStatus,
    attempts: r.attempts as number,
    actionTaken: (r.action_taken ?? null) as string | null,
    dealId: (r.deal_id ?? null) as string | null,
    errorCode: (r.error_code ?? null) as string | null,
    extracted: r.extracted ?? null,
    receivedAt: r.received_at as string,
    processedAt: (r.processed_at ?? null) as string | null,
    duplicateCount: (r.duplicate_count ?? 0) as number,
    lastDuplicateAt: (r.last_duplicate_at ?? null) as string | null,
  };
}

function toPreview(r: Raw): InboundPreview {
  return {
    externalEventId: (r.external_event_id ?? null) as string | null,
    conditionsOk: (r.conditions_ok ?? null) as boolean | null,
    identifier: (r.identifier ?? null) as string | null,
    outcome: r.outcome as InboundPreviewOutcome,
    dealId: (r.deal_id ?? null) as string | null,
    dealTitle: (r.deal_title ?? null) as string | null,
    fromStageId: (r.from_stage_id ?? null) as string | null,
    targetStageId: (r.target_stage_id ?? null) as string | null,
    reason: (r.reason ?? null) as string | null,
    noteText: (r.note_text ?? null) as string | null,
  };
}

// --- URL pública ---

/** URL que o gateway chama: `<VITE_SUPABASE_URL>/functions/v1/inbound-webhook/<ruleId>`. */
export function inboundWebhookUrl(ruleId: string): string {
  const { url } = assertPublicSupabaseEnv();
  return `${url.replace(/\/+$/, "")}/functions/v1/inbound-webhook/${encodeURIComponent(ruleId)}`;
}

// --- chaves de cache ---

export const INBOUND_EVENTS_PAGE_SIZE = 50;
/** Teto de linhas navegáveis no histórico (4 páginas de 50). */
export const INBOUND_EVENTS_MAX_ROWS = 200;

const keys = {
  rules: (tenantId: string | undefined) => ["inbound-rules", tenantId] as const,
  rule: (tenantId: string | undefined, id: string) => ["inbound-rules", tenantId, id] as const,
  eventsAll: ["inbound-events"] as const,
  events: (tenantId: string | undefined, ruleId: string, filters: InboundEventFilters) =>
    ["inbound-events", tenantId, ruleId, filters] as const,
  counts: (tenantId: string | undefined) => ["inbound-events", tenantId, "counts-24h"] as const,
};

/** Mutations que devolvem segredo: `gcTime: 0` tira o resultado do cache ao desmontar. */
const NO_RETAIN = { gcTime: 0 } as const;

// --- leitura ---

export function useInboundRules() {
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id;
  return useQuery<InboundRule[]>({
    queryKey: keys.rules(tenantId),
    enabled: !!tenantId,
    queryFn: async () =>
      (
        await runQuery(
          db.from("inbound_rules").select(RULE_COLUMNS).order("created_at", { ascending: false }),
        )
      ).map((r) => toRule(r as Raw)),
  });
}

/** Detalhe de uma regra; `null` quando não existe (ou RLS oculta). */
export function useInboundRule(id: string) {
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id;
  return useQuery<InboundRule | null>({
    queryKey: keys.rule(tenantId, id),
    enabled: !!tenantId && !!id,
    queryFn: async () => {
      const { data, error } = await db
        .from("inbound_rules")
        .select(RULE_COLUMNS)
        .eq("id", id)
        .maybeSingle();
      if (error) throw new InboundRuleApiError(error.code, error.message);
      return data ? toRule(data as Raw) : null;
    },
  });
}

export type InboundEventFilters = { status?: InboundEventStatus; offset?: number };

/** Histórico de uma regra: página de 50, até 200 linhas (offset máximo 150). */
export function useInboundEvents(ruleId: string, filters: InboundEventFilters = {}) {
  const { data: profile } = useCurrentProfile();
  const offset = Math.min(
    Math.max(filters.offset ?? 0, 0),
    INBOUND_EVENTS_MAX_ROWS - INBOUND_EVENTS_PAGE_SIZE,
  );
  const normalized: InboundEventFilters = { status: filters.status, offset };
  return useQuery<InboundEvent[]>({
    queryKey: keys.events(profile?.tenant_id, ruleId, normalized),
    enabled: !!profile?.tenant_id && !!ruleId,
    queryFn: async () => {
      // received_at + id: ordem estável entre páginas.
      let query = db
        .from("inbound_events")
        .select(EVENT_COLUMNS)
        .eq("rule_id", ruleId)
        .order("received_at", { ascending: false })
        .order("id", { ascending: false })
        .range(offset, offset + INBOUND_EVENTS_PAGE_SIZE - 1);
      if (normalized.status) query = query.eq("status", normalized.status);
      return (await runQuery(query)).map((r) => toEvent(r as Raw));
    },
  });
}

export type InboundEventCounts = {
  byRule: Record<string, Partial<Record<InboundEventStatus, number>>>;
};

// --- RPCs da v2.2 (migration 20261023100000) ---

// shortcut: cast local até o Lovable regenerar types.ts; remover quando as RPCs aparecerem em Database['public']['Functions']
type InboundV22Rpcs = {
  set_inbound_rule_limits: {
    args: { p_id: string; p_per_minute: number; p_per_day: number };
    row: null;
  };
  inbound_rule_stats_tenant: {
    args: Record<string, never>;
    row: { rule_id: string; status: InboundEventStatus; total: number | string }[];
  };
};

/** Chamada tipada das RPCs novas; erro do Postgres sobe como InboundRuleApiError (callRpc). */
async function callV22Rpc<F extends keyof InboundV22Rpcs>(
  fn: F,
  args: InboundV22Rpcs[F]["args"],
): Promise<InboundV22Rpcs[F]["row"]> {
  return (await callRpc(fn, args)) as unknown as InboundV22Rpcs[F]["row"];
}

/** Eventos das últimas 24 h por regra e status, para a lista: uma RPC agregada para o tenant. */
export function useInboundEventCounts24h() {
  const { data: profile } = useCurrentProfile();
  return useQuery<InboundEventCounts>({
    queryKey: keys.counts(profile?.tenant_id),
    enabled: !!profile?.tenant_id,
    queryFn: async () => {
      const rows = (await callV22Rpc("inbound_rule_stats_tenant", {})) ?? [];
      const byRule: InboundEventCounts["byRule"] = {};
      for (const row of rows) {
        const byStatus = (byRule[row.rule_id] ??= {});
        // bigint pode chegar como texto no PostgREST.
        byStatus[row.status] = (byStatus[row.status] ?? 0) + Number(row.total);
      }
      return { byRule };
    },
  });
}

// --- escrita ---

export type InboundRuleInput = {
  name: string;
  tokenHeaderName?: string | null;
  boardId: string;
  allowedStageIds: string[];
  action: InboundAction;
  actionConfig: InboundActionConfig;
  matchField: InboundMatchField;
  matchPath: string;
  customFieldKey?: string | null;
  eventIdPath: string;
  conditions: InboundCondition[];
  notFoundMode: InboundNotFoundMode;
};

export type CreateInboundRuleInput = InboundRuleInput & {
  verificationMode: InboundVerificationMode;
  /** Segredo colado pelo admin (stripe_signature e header_token); ignorado no HMAC. */
  secret?: string | null;
};

/** `secret` só vem preenchido no modo HMAC (`whin_...`), uma única vez. */
export function useCreateInboundRule() {
  const queryClient = useQueryClient();
  const { data: profile } = useCurrentProfile();
  return useMutation<
    { id: string; secret: string | null },
    InboundRuleApiError,
    CreateInboundRuleInput
  >({
    ...NO_RETAIN,
    mutationFn: async (input) => {
      const data = await callRpc("create_inbound_rule", {
        p_name: input.name,
        p_verification_mode: input.verificationMode,
        p_token_header_name: input.tokenHeaderName ?? null,
        p_secret: input.secret ?? null,
        p_board_id: input.boardId,
        p_allowed_stage_ids: input.allowedStageIds,
        p_action: input.action,
        p_action_config: input.actionConfig,
        p_match_field: input.matchField,
        p_match_path: input.matchPath,
        p_custom_field_key: input.customFieldKey ?? null,
        p_event_id_path: input.eventIdPath,
        p_conditions: input.conditions,
        p_not_found_mode: input.notFoundMode,
      });
      const row = firstRow<{ id: string; secret: string | null }>(data, "create_inbound_rule");
      return { id: row.id, secret: row.secret ?? null };
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.rules(profile?.tenant_id) });
    },
  });
}

/** O modo de verificação não muda na edição. */
export function useUpdateInboundRule() {
  const queryClient = useQueryClient();
  const { data: profile } = useCurrentProfile();
  return useMutation<void, InboundRuleApiError, InboundRuleInput & { id: string }>({
    mutationFn: async (input) => {
      await callRpc("update_inbound_rule", {
        p_id: input.id,
        p_name: input.name,
        p_token_header_name: input.tokenHeaderName ?? null,
        p_board_id: input.boardId,
        p_allowed_stage_ids: input.allowedStageIds,
        p_action: input.action,
        p_action_config: input.actionConfig,
        p_match_field: input.matchField,
        p_match_path: input.matchPath,
        p_custom_field_key: input.customFieldKey ?? null,
        p_event_id_path: input.eventIdPath,
        p_conditions: input.conditions,
        p_not_found_mode: input.notFoundMode,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.rules(profile?.tenant_id) });
    },
  });
}

export function useSetInboundRuleActive() {
  const queryClient = useQueryClient();
  const { data: profile } = useCurrentProfile();
  return useMutation<void, InboundRuleApiError, { id: string; active: boolean }>({
    mutationFn: async (input) => {
      await callRpc("set_inbound_rule_active", { p_id: input.id, p_active: input.active });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.rules(profile?.tenant_id) });
    },
  });
}

/** Limites de ações por minuto e por dia da regra (o banco valida e confere o tenant). */
export function useSetInboundRuleLimits() {
  const queryClient = useQueryClient();
  const { data: profile } = useCurrentProfile();
  return useMutation<void, InboundRuleApiError, { id: string; perMinute: number; perDay: number }>({
    mutationFn: async (input) => {
      await callV22Rpc("set_inbound_rule_limits", {
        p_id: input.id,
        p_per_minute: input.perMinute,
        p_per_day: input.perDay,
      });
    },
    // Prefixo ["inbound-rules", tenant] cobre a lista e o detalhe da regra.
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.rules(profile?.tenant_id) });
    },
  });
}

/**
 * HMAC: o banco gera o segredo novo e o devolve uma vez (`newSecret` é ignorado).
 * Modos externos: `newSecret` é obrigatório e o retorno é `null`. O segredo anterior vale 24 h.
 */
export function useRotateInboundRuleSecret() {
  const queryClient = useQueryClient();
  const { data: profile } = useCurrentProfile();
  return useMutation<string | null, InboundRuleApiError, { id: string; newSecret?: string | null }>(
    {
      ...NO_RETAIN,
      mutationFn: async (input) => {
        const data = await callRpc("rotate_inbound_rule_secret", {
          p_id: input.id,
          p_new_secret: input.newSecret ?? null,
        });
        if (data !== null && typeof data !== "string") {
          throw new InboundRuleApiError(null, "Resposta inesperada de rotate_inbound_rule_secret");
        }
        return data;
      },
      // previous_secret_expires_at muda na listagem
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: keys.rules(profile?.tenant_id) });
      },
    },
  );
}

export function useDeleteInboundRule() {
  const queryClient = useQueryClient();
  const { data: profile } = useCurrentProfile();
  return useMutation<void, InboundRuleApiError, string>({
    mutationFn: async (ruleId) => {
      await callRpc("delete_inbound_rule", { p_id: ruleId });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.rules(profile?.tenant_id) }),
        queryClient.invalidateQueries({ queryKey: keys.eventsAll }),
      ]);
    },
  });
}

/** Dry run: a amostra colada pode ter dado pessoal, então o resultado não fica no cache. */
export function usePreviewInboundRule() {
  return useMutation<InboundPreview, InboundRuleApiError, { ruleId: string; sample: unknown }>({
    ...NO_RETAIN,
    mutationFn: async (input) => {
      const data = await callRpc("preview_inbound_rule", {
        p_rule_id: input.ruleId,
        p_sample: input.sample,
      });
      return toPreview(firstRow<Raw>(data, "preview_inbound_rule"));
    },
  });
}
