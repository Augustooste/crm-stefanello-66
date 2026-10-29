import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type {
  CreateInboundRuleInput,
  InboundAction,
  InboundActionConfig,
  InboundCondition,
  InboundEventStatus,
  InboundIgnoredReason,
  InboundMatchField,
  InboundNotFoundMode,
  InboundRule,
  InboundTransform,
  InboundVerificationMode,
} from "@/lib/api/inbound-rules";
import { useCurrentProfile } from "@/lib/api/session";
import { INBOUND_PRESETS, type InboundPreset } from "@/lib/inbound-presets";

/**
 * Estado do assistente de regra de entrada e as validações que espelham o banco
 * (migration 20261021100000_inbound_rules.sql: assert_inbound_rule_config e
 * assert_inbound_verification; condição `in` na 20261022100000_inbound_v2_1.sql; match_fallback_path na
 * 20261023100000_inbound_v2_2.sql).
 * Mudou uma regra lá, muda aqui no mesmo commit.
 */

export const WIZARD_STEPS = ["Modelo", "Verificação", "Identificação", "Ação", "Revisar e testar"];

export const MAX_NAME_LENGTH = 120;
export const MAX_CONDITIONS = 5;
export const MAX_ALLOWED_STAGES = 20;
export const MAX_TEXT_LENGTH = 500;
export const MAX_EQUALS_LENGTH = 200;
/** Itens de "Qualquer um de" (in), mesmo teto do banco (v2.1). */
export const MAX_IN_ITEMS = 10;
export const MAX_DUE_HOURS = 720;
export const DEFAULT_DUE_HOURS = 24;
export const MIN_SECRET_LENGTH = 8;
export const MAX_SECRET_LENGTH = 512;
/** Padrão da tabela; o admin muda depois em Limites (set_inbound_rule_limits, v2.2). */
export const DEFAULT_MAX_PER_MINUTE = 30;
export const DEFAULT_MAX_PER_DAY = 500;
/** Mesmo teto de preview_inbound_rule (octet_length do jsonb). */
export const MAX_SAMPLE_BYTES = 64 * 1024;

const PATH_MAX_LENGTH = 200;
const PATH_MAX_SEGMENTS = 10;
const PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;
const HEADER_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const PREFIX_PATTERN = /^\+?[0-9]{1,4}$/;
const TEMPLATE_PATH = /\{\{([A-Za-z0-9_.-]{1,200})\}\}/g;
/** Mesma lista de RESERVED_TOKEN_HEADERS (handler.ts) e do banco. */
export const RESERVED_HEADERS = [
  "host",
  "content-length",
  "content-type",
  "authorization",
  "cookie",
];
/** Campo com esse nome no caminho de nota/motivo levaria o segredo para o histórico (M2, Task 4). */
const SECRET_SEGMENT = /hottok|token|secret|signature|authorization/i;

export const ACTION_LABEL: Record<InboundAction, string> = {
  move_stage: "Mover de etapa",
  mark_won: "Marcar como ganho",
  mark_lost: "Marcar como perdido",
  add_note: "Registrar nota",
  create_activity: "Criar atividade",
};
export const MODE_LABEL: Record<InboundVerificationMode, string> = {
  aceleraflow_hmac: "Assinatura do Aceleraflow (HMAC)",
  stripe_signature: "Assinatura do Stripe (Stripe-Signature)",
  header_token: "Token em header",
};

/** Motivos de record_inbound_ignored / process_inbound_event (v2.2), em português. */
export const IGNORED_REASON_LABEL: Record<InboundIgnoredReason, string> = {
  missing_event_id: "evento sem id",
  invalid_json: "JSON inválido",
  invalid_payload: "corpo não é objeto JSON",
  nul_payload: "caractere nulo no corpo",
};

/** "3 ignorados (último: evento sem id, 23/10/2026 10:00)"; null quando não há ignorados. */
export function ignoredSummary(
  rule: Pick<InboundRule, "ignoredCount" | "lastIgnoredAt" | "lastIgnoredReason">,
  formatDate: (iso: string | null) => string,
): string | null {
  if (rule.ignoredCount <= 0) return null;
  const noun = rule.ignoredCount === 1 ? "ignorado" : "ignorados";
  const reason = rule.lastIgnoredReason
    ? (IGNORED_REASON_LABEL[rule.lastIgnoredReason] ?? rule.lastIgnoredReason)
    : "motivo não informado";
  const when = rule.lastIgnoredAt ? `, ${formatDate(rule.lastIgnoredAt)}` : "";
  return `${rule.ignoredCount} ${noun} (último: ${reason}${when})`;
}

export const EVENT_STATUS_LABEL: Record<InboundEventStatus, string> = {
  processing: "Processando",
  processed: "Processado",
  ignored: "Ignorado",
  not_found: "Não encontrado",
  ambiguous: "Ambíguo",
  rate_limited: "Limite atingido",
  failed: "Falhou",
};

/**
 * O que cada gateway faz quando a URL responde 401 (regra pausada). Fonte: spike
 * docs/superpowers/spikes/2026-10-20-v2-gateways-webhooks.md (§1.3 Stripe, §2.3 Asaas,
 * §3.3 Hotmart, esta secundária). Nenhum gateway garante reenvio automático depois.
 */
export const GATEWAY_PAUSE_NOTES: ReadonlyArray<readonly [string, string]> = [
  [
    "Stripe",
    "reenvia por até 3 dias e depois para; passado isso, só o reenvio manual no Dashboard do Stripe (eventos dos últimos 15 dias).",
  ],
  [
    "Asaas",
    "pausa a fila após 15 falhas seguidas e guarda os eventos por 14 dias; a fila só volta quando alguém a retoma no painel do Asaas.",
  ],
  [
    "Hotmart",
    "pode desativar a configuração de webhook quando a URL falha; confira no painel se ela continua ativa.",
  ],
  [
    "Sistema próprio, n8n ou Make",
    "depende de como o envio trata falhas; reenvie o que tiver sido recusado.",
  ],
];

export const NO_TRANSFORM = "none";
export type MatchTransformChoice = InboundTransform | typeof NO_TRANSFORM;

export type WizardForm = {
  presetId: InboundPreset["id"];
  name: string;
  boardId: string;
  verificationMode: InboundVerificationMode;
  tokenHeaderName: string;
  /** Só na criação, nos modos externos. Nunca sai do assistente além do RPC. */
  secret: string;
  matchField: InboundMatchField;
  matchPath: string;
  matchTransform: MatchTransformChoice;
  matchPrefix: string;
  /** action_config.match_fallback_path (v2.2): só e-mail e telefone; vazio = sem alternativo. */
  matchFallbackPath: string;
  customFieldKey: string;
  eventIdPath: string;
  conditions: InboundCondition[];
  notFoundMode: InboundNotFoundMode;
  action: InboundAction;
  allowedStageIds: string[];
  toStageId: string;
  reasonPath: string;
  reasonText: string;
  noteText: string;
  activityTitle: string;
  dueInHours: string;
};

export const MATCH_LABEL: Record<InboundMatchField, string> = {
  email: "E-mail",
  phone: "Telefone",
  deal_custom_field: "Campo personalizado do negócio",
};
export const TRANSFORM_LABEL: Record<MatchTransformChoice, string> = {
  none: "Nenhuma",
  trim: "Remover espaços",
  lower: "Minúsculas",
  digits: "Só dígitos",
  cents_to_decimal: "Centavos para reais",
};
export const NOT_FOUND_LABEL: Record<InboundNotFoundMode, string> = {
  ignore: "Só registrar no histórico",
  record: "Registrar e guardar o identificador",
};
export const SECRET_FIELDS_WARNING =
  "Não use campos de segredo ou token (hottok, token, secret, signature, authorization) em {{caminho}}: o valor iria para o histórico do negócio.";

export type StageKind = { id: string; name: string; isWon: boolean; isLost: boolean };
export type DealCustomField = { key: string; label: string };
export type StepContext = {
  isEdit: boolean;
  stages: StageKind[] | undefined;
  customFields: DealCustomField[] | undefined;
};

export function isValidPath(path: string): boolean {
  if (!path || path.length > PATH_MAX_LENGTH) return false;
  const segments = path.split(".");
  return segments.length <= PATH_MAX_SEGMENTS && segments.every((s) => PATH_SEGMENT.test(s));
}

/** match_fallback_path só vale para e-mail e telefone (assert_inbound_rule_config v2.2). */
export function usesFallbackPath(field: InboundMatchField): boolean {
  return field === "email" || field === "phone";
}

export function isSecretLikePath(path: string): boolean {
  return path.split(".").some((segment) => SECRET_SEGMENT.test(segment));
}

export function isReservedHeader(name: string): boolean {
  return RESERVED_HEADERS.includes(name.trim().toLowerCase());
}

/** Caminhos {{...}} usados num modelo de texto. */
export function templatePaths(template: string): string[] {
  return Array.from(template.matchAll(TEMPLATE_PATH), (m) => m[1]);
}

function presetById(id: InboundPreset["id"]): InboundPreset {
  return INBOUND_PRESETS.find((p) => p.id === id) ?? INBOUND_PRESETS[INBOUND_PRESETS.length - 1];
}

export function emptyForm(presetId: InboundPreset["id"] = "custom"): WizardForm {
  return applyPreset(
    {
      presetId,
      name: "",
      boardId: "",
      verificationMode: "aceleraflow_hmac",
      tokenHeaderName: "",
      secret: "",
      matchField: "email",
      matchPath: "",
      matchTransform: NO_TRANSFORM,
      matchPrefix: "",
      matchFallbackPath: "",
      customFieldKey: "",
      eventIdPath: "",
      conditions: [],
      notFoundMode: "ignore",
      action: "move_stage",
      allowedStageIds: [],
      toStageId: "",
      reasonPath: "",
      reasonText: "",
      noteText: "",
      activityTitle: "",
      dueInHours: String(DEFAULT_DUE_HOURS),
    },
    presetId,
  );
}

/** Troca o modelo: sobrescreve verificação, identificação e condições; mantém nome, funil e ação. */
export function applyPreset(form: WizardForm, presetId: InboundPreset["id"]): WizardForm {
  const preset = presetById(presetId);
  return {
    ...form,
    presetId: preset.id,
    verificationMode: preset.verificationMode,
    tokenHeaderName: preset.tokenHeaderName ?? "",
    secret: "",
    matchField: preset.matchField,
    matchPath: preset.matchPath,
    matchTransform: NO_TRANSFORM,
    matchPrefix: "",
    matchFallbackPath: preset.matchFallbackPath ?? "",
    customFieldKey: "",
    eventIdPath: preset.eventIdPath,
    conditions: preset.conditions.map(copyCondition),
  };
}

function text(config: InboundActionConfig, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value : "";
}

export function formFromRule(rule: InboundRule): WizardForm {
  const cfg = rule.actionConfig;
  const transform = text(cfg, "match_transform");
  const due = cfg.due_in_hours;
  return {
    presetId: "custom",
    name: rule.name,
    boardId: rule.boardId,
    verificationMode: rule.verificationMode,
    tokenHeaderName: rule.tokenHeaderName ?? "",
    secret: "",
    matchField: rule.matchField,
    matchPath: rule.matchPath,
    matchTransform: (transform || NO_TRANSFORM) as MatchTransformChoice,
    matchPrefix: text(cfg, "match_prefix"),
    matchFallbackPath: text(cfg, "match_fallback_path"),
    customFieldKey: rule.matchCustomFieldKey ?? "",
    eventIdPath: rule.eventIdPath,
    conditions: rule.conditions.map(copyCondition),
    notFoundMode: rule.notFoundMode,
    action: rule.action,
    allowedStageIds: [...rule.allowedStageIds],
    toStageId: text(cfg, "to_stage_id"),
    reasonPath: text(cfg, "reason_path"),
    reasonText: text(cfg, "reason_text"),
    noteText: rule.action === "add_note" ? text(cfg, "text") : "",
    activityTitle: rule.action === "create_activity" ? text(cfg, "title") : "",
    dueInHours: typeof due === "number" ? String(due) : String(DEFAULT_DUE_HOURS),
  };
}

export const MOVES_DEAL: ReadonlySet<InboundAction> = new Set([
  "move_stage",
  "mark_won",
  "mark_lost",
]);

/** Etapas que podem ser destino da ação: só as permitidas e do tipo certo. */
export function destinationOptions(form: WizardForm, stages: StageKind[]): StageKind[] {
  return stages.filter((s) => {
    if (!form.allowedStageIds.includes(s.id)) return false;
    if (form.action === "mark_won") return s.isWon;
    if (form.action === "mark_lost") return s.isLost;
    return !s.isWon && !s.isLost;
  });
}

/** `where` já com a preposição: "na nota", "no motivo", "no título". */
function secretPathError(path: string, where: string): string {
  return `Não use campos de segredo ou token (${path}) ${where}: o valor iria para o histórico do negócio.`;
}

function templateError(template: string, where: string): string | null {
  for (const path of templatePaths(template)) {
    if (!isValidPath(path)) return `Caminho inválido ${where}: ${path}.`;
    if (isSecretLikePath(path)) return secretPathError(path, where);
  }
  return null;
}

/** Sem dados (carregando ou com erro) não é o mesmo que lista vazia. */
export const FIELDS_NOT_LOADED =
  "Os campos personalizados ainda não carregaram. Aguarde ou use Tentar novamente.";
export const STAGES_NOT_LOADED =
  "As etapas do funil ainda não carregaram. Aguarde ou use Tentar novamente.";

const PATH_HINT = "use letras, números, _ e -, separados por ponto (até 10 níveis)";

function stepModel(form: WizardForm): string | null {
  const name = form.name.trim();
  if (!name || name.length > MAX_NAME_LENGTH) {
    return `Informe o nome da regra (até ${MAX_NAME_LENGTH} caracteres).`;
  }
  if (!form.boardId) return "Escolha o funil da regra.";
  return null;
}

function stepVerification(form: WizardForm, ctx: StepContext): string | null {
  if (form.verificationMode === "header_token") {
    const header = form.tokenHeaderName.trim();
    if (!HEADER_PATTERN.test(header)) {
      return "Nome do header inválido: use letras, números e hífen (até 64).";
    }
    if (isReservedHeader(header)) {
      return "Esse nome de header é reservado. Escolha outro (ex.: asaas-access-token).";
    }
  }
  if (!ctx.isEdit && form.verificationMode !== "aceleraflow_hmac") {
    const length = form.secret.length;
    if (length < MIN_SECRET_LENGTH || length > MAX_SECRET_LENGTH) {
      return `Cole o segredo do gateway (de ${MIN_SECRET_LENGTH} a ${MAX_SECRET_LENGTH} caracteres).`;
    }
  }
  return null;
}

function stepIdentification(form: WizardForm, ctx: StepContext): string | null {
  if (!isValidPath(form.eventIdPath)) return `Caminho do id do evento inválido: ${PATH_HINT}.`;
  if (isSecretLikePath(form.eventIdPath)) {
    return secretPathError(form.eventIdPath, "no id do evento");
  }
  if (!isValidPath(form.matchPath)) return `Caminho do identificador inválido: ${PATH_HINT}.`;
  if (isSecretLikePath(form.matchPath)) return secretPathError(form.matchPath, "no identificador");
  if (form.matchField === "deal_custom_field") {
    const fields = ctx.customFields;
    if (fields === undefined) return FIELDS_NOT_LOADED;
    if (fields.length === 0) {
      return "Nenhum campo personalizado de negócio existe. Crie um em Configurações, Campos personalizados.";
    }
    if (!fields.some((f) => f.key === form.customFieldKey)) {
      return "Escolha o campo personalizado do negócio que guarda o identificador.";
    }
  }
  const fallback = form.matchFallbackPath.trim();
  if (usesFallbackPath(form.matchField) && fallback) {
    if (!isValidPath(fallback))
      return `Caminho alternativo do identificador inválido: ${PATH_HINT}.`;
    if (isSecretLikePath(fallback)) return secretPathError(fallback, "no caminho alternativo");
  }
  if (form.matchField === "phone" && form.matchPrefix && !PREFIX_PATTERN.test(form.matchPrefix)) {
    return "Prefixo inválido: use até 4 dígitos, como +55.";
  }
  if (form.conditions.length > MAX_CONDITIONS) return `Use no máximo ${MAX_CONDITIONS} condições.`;
  for (const [index, c] of form.conditions.entries()) {
    const error = conditionError(c, index);
    if (error) return error;
  }
  return null;
}

/** Problema de uma condição (índice base 0), espelho de assert_inbound_rule_config v2.1. */
export function conditionError(c: InboundCondition, index: number): string | null {
  const n = index + 1;
  const path = c.path.trim();
  if (!isValidPath(path)) return `Condição ${n}: caminho inválido, ${PATH_HINT}.`;
  if (isSecretLikePath(path)) return secretPathError(path, `na condição ${n}`);
  if ((c.equals !== undefined) === (c.in !== undefined)) {
    return `Condição ${n}: use "Igual a" ou "Qualquer um de", não os dois.`;
  }
  if (c.equals !== undefined) {
    // Vazio nunca casa: o motor extrai vazio como null, e a regra ignoraria todo evento.
    if (c.equals.length === 0) return `Condição ${n}: informe o valor de "Igual a".`;
    if (c.equals.length > MAX_EQUALS_LENGTH) {
      return `Condição ${n}: valor com até ${MAX_EQUALS_LENGTH} caracteres.`;
    }
    return null;
  }
  // Valida o que vai ao banco: os itens aparados (buildRuleInput).
  const items = (c.in ?? []).map((v) => v.trim());
  if (items.length === 0 || (items.length === 1 && items[0] === "")) {
    return `Condição ${n}: informe de 1 a ${MAX_IN_ITEMS} valores em "Qualquer um de".`;
  }
  if (items.length > MAX_IN_ITEMS) return `Condição ${n}: use no máximo ${MAX_IN_ITEMS} valores.`;
  for (const [i, item] of items.entries()) {
    if (!item) return `Condição ${n}: o valor ${i + 1} da lista está vazio.`;
    if (item.length > MAX_EQUALS_LENGTH) {
      return `Condição ${n}: valor ${i + 1} da lista com até ${MAX_EQUALS_LENGTH} caracteres.`;
    }
  }
  return null;
}

export type ConditionKind = "equals" | "in";

/** Troca "Igual a" por "Qualquer um de" (e vice-versa) sem deixar a outra chave no objeto. */
export function withConditionKind(c: InboundCondition, kind: ConditionKind): InboundCondition {
  const base: InboundCondition = c.transform
    ? { path: c.path, transform: c.transform }
    : { path: c.path };
  if (kind === "in") return { ...base, in: c.in ? [...c.in] : [c.equals ?? ""] };
  return { ...base, equals: c.equals ?? c.in?.[0] ?? "" };
}

/** Texto do resumo: "type = paid" ou "event é um de: A, B". */
export function conditionSummary(c: InboundCondition): string {
  if (c.in !== undefined) return `${c.path} é um de: ${c.in.map((v) => v.trim()).join(", ")}`;
  return `${c.path} = ${c.equals ?? ""}`;
}

function copyCondition(c: InboundCondition): InboundCondition {
  return c.in ? { ...c, in: [...c.in] } : { ...c };
}

function stepAction(form: WizardForm, ctx: StepContext): string | null {
  const count = form.allowedStageIds.length;
  if (count < 1 || count > MAX_ALLOWED_STAGES) {
    return `Marque de 1 a ${MAX_ALLOWED_STAGES} etapas permitidas.`;
  }
  if (MOVES_DEAL.has(form.action)) {
    if (ctx.stages === undefined) return STAGES_NOT_LOADED;
    const options = destinationOptions(form, ctx.stages);
    if (!options.some((s) => s.id === form.toStageId)) {
      return "Escolha a etapa de destino entre as etapas permitidas.";
    }
  }
  if (form.action === "mark_lost") {
    const reasonPath = form.reasonPath.trim();
    const reasonText = form.reasonText.trim();
    if (!reasonPath && !reasonText) {
      return "Informe o motivo da perda (caminho no evento ou texto fixo).";
    }
    if (reasonPath && !isValidPath(reasonPath)) return `Caminho do motivo inválido: ${PATH_HINT}.`;
    if (reasonPath && isSecretLikePath(reasonPath)) return secretPathError(reasonPath, "no motivo");
    if (reasonText.length > MAX_TEXT_LENGTH) return `Motivo com até ${MAX_TEXT_LENGTH} caracteres.`;
    return templateError(reasonText, "no motivo");
  }
  if (form.action === "add_note") {
    const note = form.noteText.trim();
    if (!note || note.length > MAX_TEXT_LENGTH) {
      return `Escreva o texto da nota (até ${MAX_TEXT_LENGTH} caracteres).`;
    }
    return templateError(note, "na nota");
  }
  if (form.action === "create_activity") {
    const title = form.activityTitle.trim();
    if (!title || title.length > MAX_TEXT_LENGTH) {
      return `Escreva o título da atividade (até ${MAX_TEXT_LENGTH} caracteres).`;
    }
    if (!/^[0-9]{1,3}$/.test(form.dueInHours) || Number(form.dueInHours) > MAX_DUE_HOURS) {
      return `Prazo em horas inteiras, de 0 a ${MAX_DUE_HOURS}.`;
    }
    return templateError(title, "no título");
  }
  return null;
}

/** Primeiro problema do passo (0 a 4), ou null. */
export function validateStep(step: number, form: WizardForm, ctx: StepContext): string | null {
  switch (step) {
    case 0:
      return stepModel(form);
    case 1:
      return stepVerification(form, ctx);
    case 2:
      return stepIdentification(form, ctx);
    case 3:
      return stepAction(form, ctx);
    default:
      return null;
  }
}

/** Monta o action_config só com as chaves aceitas pela ação; campo vazio é omitido. */
export function buildActionConfig(form: WizardForm): InboundActionConfig {
  const config: InboundActionConfig = {};
  if (form.matchTransform !== NO_TRANSFORM) config.match_transform = form.matchTransform;
  if (form.matchField === "phone" && form.matchPrefix) config.match_prefix = form.matchPrefix;
  const fallback = form.matchFallbackPath.trim();
  if (usesFallbackPath(form.matchField) && fallback) config.match_fallback_path = fallback;
  if (MOVES_DEAL.has(form.action)) config.to_stage_id = form.toStageId;
  if (form.action === "mark_lost") {
    if (form.reasonPath.trim()) config.reason_path = form.reasonPath.trim();
    if (form.reasonText.trim()) config.reason_text = form.reasonText.trim();
  } else if (form.action === "add_note") {
    config.text = form.noteText.trim();
  } else if (form.action === "create_activity") {
    config.title = form.activityTitle.trim();
    config.due_in_hours = Number(form.dueInHours);
  }
  return config;
}

export function buildRuleInput(form: WizardForm): CreateInboundRuleInput {
  const external = form.verificationMode !== "aceleraflow_hmac";
  return {
    name: form.name.trim(),
    verificationMode: form.verificationMode,
    tokenHeaderName: form.verificationMode === "header_token" ? form.tokenHeaderName.trim() : null,
    secret: external ? form.secret : null,
    boardId: form.boardId,
    allowedStageIds: form.allowedStageIds,
    action: form.action,
    actionConfig: buildActionConfig(form),
    matchField: form.matchField,
    matchPath: form.matchPath.trim(),
    customFieldKey: form.matchField === "deal_custom_field" ? form.customFieldKey : null,
    eventIdPath: form.eventIdPath.trim(),
    // Só path, equals OU in (itens aparados) e a transformação já gravada (a tela não cria
    // transformação de condição). O banco exige exatamente um de equals e in.
    conditions: form.conditions.map((c) => {
      const value =
        c.in !== undefined ? { in: c.in.map((v) => v.trim()) } : { equals: c.equals ?? "" };
      const out: InboundCondition = { path: c.path.trim(), ...value };
      return c.transform ? { ...out, transform: c.transform } : out;
    }),
    notFoundMode: form.notFoundMode,
  };
}

/** Assinatura do que vai ao banco, sem o segredo: compara formulário salvo e editado. */
export function ruleFingerprint(form: WizardForm): string {
  const { secret: _secret, ...rest } = buildRuleInput(form);
  return JSON.stringify(rest);
}

// --- dados auxiliares ---

/** Etapas do funil com ganho/perda (useBoardStagesForBoard não traz os dois). */
export function useBoardStageKinds(boardId: string | null | undefined) {
  return useQuery<StageKind[]>({
    queryKey: ["inbound-rule-stage-kinds", boardId],
    enabled: !!boardId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("board_stages")
        .select("id, name, position, is_won, is_lost")
        .eq("board_id", boardId as string)
        .order("position");
      if (error) throw error;
      return (data ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        isWon: !!s.is_won,
        isLost: !!s.is_lost,
      }));
    },
  });
}

/** Campos personalizados de negócio do tenant (o banco exige que a chave exista). */
export function useDealCustomFields() {
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id;
  return useQuery<DealCustomField[]>({
    queryKey: ["inbound-rule-deal-custom-fields", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("custom_field_definitions")
        .select("key, label")
        .eq("tenant_id", tenantId as string)
        .eq("entity", "deal")
        .order("position", { ascending: true });
      if (error) throw error;
      return (data ?? []).map((f) => ({ key: f.key, label: f.label }));
    },
  });
}
