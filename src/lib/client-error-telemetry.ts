// client-error-telemetry.ts — envia erro de frontend para public.system_events
// (source = 'client') via a RPC log_client_error, para responder "qual página
// deu erro" sem depender do console do navegador.
//
// Contexto: /pipeline ficou quebrada em produção por dias com system_events
// vazio, porque erro de cliente não tinha caminho de escrita. Ver
// supabase/migrations/20260730210000_client_error_telemetry.sql.
//
// Regras deste módulo, em ordem de importância:
//  1. NUNCA lança e NUNCA retorna promessa rejeitada. Telemetria não pode ser
//     a causa de um segundo erro em cima do primeiro.
//  2. Redige dado sensível antes de sair da máquina do usuário (segredo em URL
//     de provider, e-mail, telefone, CPF/CNPJ, JWT).
//  3. Rate limit e dedupe no cliente, para não transformar um loop de render
//     em enxurrada de INSERT. O limite que vale de verdade é o do servidor
//     (30/min por usuário, dentro da RPC); este aqui só economiza rede.

import { supabase } from "@/integrations/supabase/client";

/** Máximo de envios por janela de 1 minuto (o servidor corta em 30/min). */
export const CLIENT_ERROR_MAX_PER_MINUTE = 10;
/** Mesma mensagem na mesma rota só vai de novo depois desta janela. */
export const CLIENT_ERROR_DEDUPE_WINDOW_MS = 60_000;
/** Teto de texto enviado (mensagem e stack); o servidor trunca de novo. */
export const CLIENT_ERROR_MAX_TEXT = 4000;
/** Teto dos campos auxiliares que vão no context jsonb. */
const CONTEXT_FIELD_MAX = 300;

const RATE_WINDOW_MS = 60_000;
/** Trava o crescimento do mapa de dedupe num loop de rotas dinâmicas. */
const DEDUPE_MAX_KEYS = 200;

// A RPC já está em types.ts (arquivo gerado) — sem shim local.
const clientErrorRpc = supabase;

/** De onde o erro foi capturado — vira `context.origin` na linha gravada. */
export type ClientErrorOrigin =
  "query" | "mutation" | "window_error" | "unhandled_rejection" | "error_boundary";

export type ClientErrorMeta = {
  origin: ClientErrorOrigin;
  /** Nome do error boundary, quando origin = "error_boundary". */
  boundary?: string;
  /** Rota; default é window.location.pathname no momento da captura. */
  route?: string;
  /**
   * Identificador de execução (traceId) — quando o erro de tela nasce de uma
   * mensagem específica, é o id da mensagem de ENTRADA. Vira
   * system_events.correlation_id e casa com ai_failure_logs.trace_id na visão
   * unificada de incidentes.
   */
  traceId?: string;
  /**
   * O que falhou, em nome legível — queryKey serializada, nome da RPC ou da
   * mutation. Sem isto, `origin: "query"` não diz QUAL query quebrou, que foi
   * exatamente o que atrasou o diagnóstico do 42501 em get_my_capabilities.
   */
  operation?: string;
};

export type ClientAuthTransition = "stable" | "signing_in" | "signing_out";

type ErrorObservation = {
  observedAt: string;
  route: string;
  origin: ClientErrorOrigin;
  boundary?: string;
  operation?: string;
  authTransition: ClientAuthTransition;
  reference: string;
};

let authTransition: ClientAuthTransition = "stable";
let observations = new WeakMap<object, ErrorObservation>();
let references = new WeakMap<object, string>();

export function setClientAuthTransition(transition: ClientAuthTransition): void {
  authTransition = transition;
}

export function getClientErrorObservation(error: unknown): ErrorObservation | null {
  if (typeof error !== "object" || error === null) return null;
  return observations.get(error) ?? null;
}

/**
 * Referência curta do incidente, estável por objeto de erro: a mesma string é
 * gravada em system_events.correlation_id e mostrada na tela, para qualquer
 * usuário (não só admin) poder citá-la no suporte.
 */
const REFERENCE_KEY = "__aceleraflowRef";

export function errorReference(error: unknown): string {
  const holder = (typeof error === "object" && error !== null ? error : null) as
    (Record<string, unknown> & { [REFERENCE_KEY]?: string }) | null;
  const existing = holder?.[REFERENCE_KEY];
  if (typeof existing === "string") return existing;
  if (holder) {
    const remembered = references.get(holder);
    if (remembered) return remembered;
  }

  const ref = Array.from({ length: 8 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  if (holder) {
    references.set(holder, ref);
    try {
      Object.defineProperty(holder, REFERENCE_KEY, { value: ref, enumerable: false });
    } catch {
      // Erro congelado: a referência ainda é útil, só não persiste.
    }
  }
  return ref;
}

// -----------------------------------------------------------------------------
// Redação
// -----------------------------------------------------------------------------

// Segredos: mesmos formatos cobertos por supabase/functions/_shared/
// redact-secrets.ts (token no path da Z-API, access_token na query, Bearer,
// "key: valor"). Duplicado de propósito — aquele arquivo é Deno e o build do
// Vite não o alcança; são poucas linhas e as duas cópias evoluem por motivos
// diferentes.
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(\/token\/)[^/?\s"']+/gi, "$1[REDIGIDO]"],
  [
    /([?&](?:access_token|auth_token|api[_-]?key|apikey|token|secret)=)[^&\s"'#]+/gi,
    "$1[REDIGIDO]",
  ],
  [/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDIGIDO]"],
  // "api_key: valor" / "token=valor" / "secret: valor". O valor exclui
  // parênteses, aspas e vírgula: sem isso o `\S+` do original engolia o resto
  // de mensagens do Postgres do tipo `duplicate key: (email)=(...)`, apagando
  // justamente a parte diagnóstica.
  [/((?:api[_-]?)?key\s*[:=]\s*)[^\s(),;"']+/gi, "$1[REDIGIDO]"],
  [/(token\s*[:=]\s*)[^\s(),;"']+/gi, "$1[REDIGIDO]"],
  [/(secret\s*[:=]\s*)[^\s(),;"']+/gi, "$1[REDIGIDO]"],
];

// Dado pessoal: mensagem de erro de CRM carrega e-mail e telefone de lead com
// frequência (ex.: violação de unique key vem com o valor no texto).
const PII_PATTERNS: Array<[RegExp, string]> = [
  // JWT (3 blocos base64url) — antes do e-mail para não ser comido por ele.
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, "[JWT_REDIGIDO]"],
  [/\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "[EMAIL_REDIGIDO]"],
  // CPF/CNPJ formatados.
  [/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, "[CPF_REDIGIDO]"],
  [/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g, "[CNPJ_REDIGIDO]"],
  // Telefone e sequências longas de dígitos (CPF sem máscara tem 11). UUID não
  // casa (tem hífen e letras) e código de erro do PostgREST tem 5 dígitos.
  [/\+?\d[\d\s().-]{9,}\d/g, "[TELEFONE_REDIGIDO]"],
];

/**
 * Remove segredo e dado pessoal de um texto de erro. Puro, idempotente e
 * nunca lança.
 */
export function redactClientErrorText(input: unknown): string {
  let out = typeof input === "string" ? input : String(input ?? "");
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  for (const [re, rep] of PII_PATTERNS) out = out.replace(re, rep);
  return out;
}

function clean(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  const text = redactClientErrorText(value).trim();
  return text ? text.slice(0, max) : null;
}

// -----------------------------------------------------------------------------
// Extração
// -----------------------------------------------------------------------------

type ExtractedError = {
  message: string;
  code: string | null;
  stack: string | null;
  details: string | null;
  hint: string | null;
  name: string | null;
  /** status HTTP, quando o erro veio de fetch/FunctionsHttpError. PostgrestError não tem. */
  status: string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Normaliza qualquer coisa lançada (Error, PostgrestError, string, objeto
 * solto) no conjunto de campos que a tabela guarda. `code` é o que torna o
 * caso motivador diagnosticável: PostgREST devolve 42703/PGRST204 quando a
 * coluna não existe no banco.
 */
export function extractClientError(error: unknown): ExtractedError {
  const record = asRecord(error);
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : typeof record.message === "string"
          ? record.message
          : String(error ?? "");

  return {
    message: clean(rawMessage, CLIENT_ERROR_MAX_TEXT) ?? "(sem mensagem)",
    code: clean(record.code ?? (error instanceof Error ? error.name : null), 100),
    stack: clean(error instanceof Error ? error.stack : null, CLIENT_ERROR_MAX_TEXT),
    details: clean(record.details, CONTEXT_FIELD_MAX),
    hint: clean(record.hint, CONTEXT_FIELD_MAX),
    name: clean(error instanceof Error ? error.name : record.name, CONTEXT_FIELD_MAX),
    status: clean(record.status, 20),
  };
}

// -----------------------------------------------------------------------------
// Rate limit + dedupe (estado de módulo, por aba)
// -----------------------------------------------------------------------------

let sentAt: number[] = [];
const lastSeenByKey = new Map<string, number>();

/** Zera o estado entre testes. */
export function resetClientErrorTelemetry(): void {
  sentAt = [];
  lastSeenByKey.clear();
  observations = new WeakMap<object, ErrorObservation>();
  references = new WeakMap<object, string>();
  authTransition = "stable";
}

/**
 * Decide se o evento deve ir para o servidor. Exportada para teste: é a única
 * lógica com risco real de regressão silenciosa (um bug aqui vira enxurrada de
 * INSERT ou telemetria muda).
 */
export function shouldSendClientError(route: string, message: string, now: number): boolean {
  const key = `${route}|${message}`;
  const lastSeen = lastSeenByKey.get(key);
  if (lastSeen !== undefined && now - lastSeen < CLIENT_ERROR_DEDUPE_WINDOW_MS) return false;

  sentAt = sentAt.filter((t) => now - t < RATE_WINDOW_MS);
  if (sentAt.length >= CLIENT_ERROR_MAX_PER_MINUTE) return false;

  if (lastSeenByKey.size >= DEDUPE_MAX_KEYS) lastSeenByKey.clear();
  lastSeenByKey.set(key, now);
  sentAt.push(now);
  return true;
}

// -----------------------------------------------------------------------------
// Orçamento de tamanho do contexto
// -----------------------------------------------------------------------------

/**
 * Margem abaixo do corte de 4000 caracteres da RPC — que, se estourado,
 * descarta o contexto INTEIRO (vira `{truncated: true}`) em vez de truncar
 * campo a campo. Ver supabase/migrations/20260730233448_*.sql.
 */
const CONTEXT_TOTAL_BUDGET = 3000;

/** Ordem de descarte quando o contexto passa do orçamento: menos essencial primeiro. */
const CONTEXT_DROP_ORDER = ["hint", "details", "user_agent", "message"] as const;

/** Exportada para teste direto — é a única defesa contra o corte "tudo ou nada" do servidor. */
export function shrinkContextToBudget(context: Record<string, string>): Record<string, string> {
  let out = context;
  for (const key of CONTEXT_DROP_ORDER) {
    if (JSON.stringify(out).length <= CONTEXT_TOTAL_BUDGET) break;
    if (key in out) {
      const rest = { ...out };
      delete rest[key];
      out = rest;
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Envio
// -----------------------------------------------------------------------------

/** 42501 (Postgres) e 401 (PostgREST) = a chamada não tinha identidade válida. */
export function isPermissionErrorCode(code: string | null, message: string): boolean {
  return code === "42501" || code === "401" || /permission denied/i.test(message);
}

/**
 * Registra um erro de frontend. Sempre resolve: `true` quando a linha foi
 * enviada, `false` quando foi descartada (SSR, dedupe, rate limit ou falha da
 * própria RPC). Nunca rejeita — quem chama pode ignorar o retorno.
 */
export async function logClientError(error: unknown, meta: ClientErrorMeta): Promise<boolean> {
  try {
    if (typeof window === "undefined") return false;

    const holder = typeof error === "object" && error !== null ? error : null;
    const now = Date.now();
    const existingObservation = holder ? observations.get(holder) : undefined;
    const observation: ErrorObservation = existingObservation ?? {
      observedAt: new Date(now).toISOString(),
      route: meta.route ?? window.location.pathname,
      origin: meta.origin,
      ...(meta.boundary ? { boundary: clean(meta.boundary, CONTEXT_FIELD_MAX) ?? undefined } : {}),
      ...(meta.operation
        ? { operation: clean(meta.operation, CONTEXT_FIELD_MAX) ?? undefined }
        : {}),
      authTransition,
      reference: errorReference(error),
    };
    if (holder && !existingObservation) observations.set(holder, observation);

    const route = observation.route;
    const extracted = extractClientError(error);

    // A RPC é deliberadamente restrita a usuários autenticados. Depois do
    // logout não tentamos chamá-la como anon: isso só geraria outro 42501 em
    // cima do erro original. Falha ao consultar a sessão continua fail-open
    // para não perder telemetria por uma indisponibilidade transitória local.
    let hasSession: boolean | null = null;
    try {
      const auth = (clientErrorRpc as { auth?: { getSession?: () => Promise<unknown> } }).auth;
      if (typeof auth?.getSession === "function") {
        const result = (await auth.getSession()) as { data?: { session?: unknown } } | undefined;
        hasSession = Boolean(result?.data?.session);
        if (!hasSession) return false;
      }
    } catch {
      hasSession = null;
    }

    if (!shouldSendClientError(route, extracted.message, now)) return false;

    // Context é uma lista fechada de campos curtos, nunca um dump do objeto —
    // é por um dump livre que dado sensível costuma vazar para telemetria.
    // `user_id` não vai daqui: a RPC preenche a partir de auth.uid().
    const context: Record<string, string> = {
      origin: observation.origin,
      user_agent: navigator.userAgent.slice(0, CONTEXT_FIELD_MAX),
      observed_at: observation.observedAt,
      reported_at: new Date(now).toISOString(),
      report_delay_ms: String(Math.max(0, now - Date.parse(observation.observedAt))),
      auth_transition: observation.authTransition,
    };
    if (observation.boundary) context.boundary = observation.boundary;
    if (observation.operation) context.operation = observation.operation;
    if (extracted.name) context.name = extracted.name;
    if (extracted.details) context.details = extracted.details;
    if (extracted.hint) context.hint = extracted.hint;
    // Duplicado de propósito: `message` já vai na coluna própria (autoritativa),
    // mas repetir aqui evita reconstruir a query com JOIN só pra ver a mensagem
    // ao lado do resto do contexto de diagnóstico.
    context.message = extracted.message.slice(0, CONTEXT_FIELD_MAX);
    if (extracted.status) context.status = extracted.status;

    // Contexto de identidade: distingue "erro de regra de negócio" de "chamada
    // saiu sem sessão e o banco respondeu como anon" — o caso do 42501 em
    // get_my_capabilities logo após o login. Falha aqui NÃO pode impedir o
    // registro do erro original, então a leitura é opcional e isolada.
    if (hasSession !== null) context.has_session = hasSession ? "true" : "false";
    if (isPermissionErrorCode(extracted.code, extracted.message)) context.permission_error = "true";

    const reference = meta.traceId ?? observation.reference;

    const { error: rpcError } = await clientErrorRpc.rpc("log_client_error", {
      p_route: route,
      p_message: extracted.message,
      // Os parâmetros opcionais só viajam quando existem: a RPC já assume null.
      ...(extracted.code ? { p_error_code: extracted.code } : {}),
      ...(extracted.stack ? { p_stack: extracted.stack } : {}),
      p_correlation_id: reference,
      p_context: shrinkContextToBudget(context),
    });

    // Sem retry e sem propagar: enquanto a migration não estiver aplicada em
    // produção a RPC responde PGRST202 (function not found), e insistir só
    // multiplicaria o ruído.
    return !rpcError;
  } catch {
    return false;
  }
}

/**
 * Liga os handlers globais (erro não tratado e promessa rejeitada). Idempotente
 * e client-only; devolve a função de remoção.
 */
export function installClientErrorHandlers(): () => void {
  if (typeof window === "undefined") return () => {};

  const onError = (event: ErrorEvent) => {
    void logClientError(event.error ?? event.message, { origin: "window_error" });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    void logClientError(event.reason, { origin: "unhandled_rejection" });
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
