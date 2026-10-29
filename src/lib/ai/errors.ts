// errors.ts — contrato de erro tipado de IA (GÊMEO do client/inbox).
// Fonte de verdade: supabase/functions/_shared/ai/errors.ts.
//
// Duplicado ao invés de importado porque Deno (edge functions) e o
// bundler do Vite (este arquivo) não compartilham resolução de módulo:
// Deno exige especificadores de import com extensão .ts e URLs completas
// (ver convenção deste repo em supabase/functions/**), o tsconfig deste
// projeto usa alias "@/*" sem extensão e não enxerga supabase/functions/**
// (fora de "include"). Forçar um import cross-runtime pra um arquivo puro
// e pequeno como este não vale a complexidade — mantenha os dois arquivos
// em sincronia manualmente ao mudar o contrato (mesmo shape AiError/
// AiErrorCode, mesma lógica de sanitizeProviderError/extractProviderErrorMeta).
//
// Usado no client (ex.: inbox) pra interpretar conversations.last_error
// (jsonb) com o MESMO contrato de código que o edge function grava.

/** Categorias de erro de IA que o resto do sistema sabe tratar. */
export type AiErrorCode =
  | "RATE_LIMIT"
  | "PROVIDER_AUTH"
  | "PROVIDER_QUOTA"
  | "PROVIDER_5XX"
  | "CONTENT_BLOCKED"
  | "TIMEOUT"
  | "SUPPRESSED"
  | "UNKNOWN";

/** Erro de IA normalizado — shape gravado em conversations.last_error (jsonb). */
export interface AiError {
  code: AiErrorCode;
  message: string;
  provider?: string;
  statusCode?: number;
  retryAfterSeconds?: number;
}

/** Shape mínimo que aceitamos ler de um erro desconhecido, sem afirmar o tipo real. */
interface ErrorLike {
  message?: unknown;
  status?: unknown;
  statusCode?: unknown;
  provider?: unknown;
  retryAfterSeconds?: unknown;
}

function toErrorLike(err: unknown): ErrorLike {
  return err !== null && typeof err === "object" ? (err as ErrorLike) : {};
}

/**
 * Extrai a mensagem crua (ainda não sanitizada) de um erro de shape
 * desconhecido: Error nativo, string, objeto com `.message`, ou fallback
 * pra JSON.stringify / String().
 */
function extractRawMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;

  const errLike = toErrorLike(err);
  if (typeof errLike.message === "string") return errLike.message;

  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

// Casa prefixos que costumam preceder um segredo (token/chave de API) e
// redige só o VALOR, preservando o prefixo pra manter a mensagem legível
// (ex.: "Authorization: Bearer sk-abc123" -> "Authorization: Bearer [REDACTED]").
// Também cobre segredos embutidos em URL (Z-API põe o token no PATH, Meta
// Graph API põe access_token na QUERY STRING) — quando o fetch falha em nível
// de rede, o Deno inclui a URL completa em err.message.
const SECRET_URL_PATH_PATTERN = /(\/token\/)[^/?\s"']+/gi;
const SECRET_QUERY_PATTERN =
  /([?&](?:access_token|auth_token|api[_-]?key|apikey|token|secret)=)[^&\s"'#]+/gi;
const SECRET_VALUE_PATTERN =
  /(bearer\s+|(?:api[_-]?)?key\s*[:=]\s*|token\s*[:=]\s*|secret\s*[:=]\s*)(\S+)/gi;

function redactSecrets(message: string): string {
  return message
    .replace(SECRET_URL_PATH_PATTERN, (_m, prefix: string) => `${prefix}[REDACTED]`)
    .replace(SECRET_QUERY_PATTERN, (_m, prefix: string) => `${prefix}[REDACTED]`)
    .replace(SECRET_VALUE_PATTERN, (_m, prefix: string) => `${prefix}[REDACTED]`);
}

function extractStatusCode(err: unknown): number | undefined {
  const errLike = toErrorLike(err);
  const raw = errLike.statusCode ?? errLike.status;
  return typeof raw === "number" ? raw : undefined;
}

/**
 * Classifica a mensagem crua (+ statusCode quando disponível) num
 * AiErrorCode. Heurística por regex — não é exaustiva pra todo provider,
 * mas cobre os casos que os handlers desta fase precisam distinguir
 * (rate limit vs auth vs 5xx vs timeout).
 */
function classify(rawMessage: string, statusCode: number | undefined): AiErrorCode {
  const lower = rawMessage.toLowerCase();

  if (statusCode === 429 || /rate.?limit|too many requests/.test(lower)) return "RATE_LIMIT";
  if (
    statusCode === 401 ||
    statusCode === 403 ||
    /unauthorized|invalid api key|authentication fail/.test(lower)
  ) {
    return "PROVIDER_AUTH";
  }
  if (statusCode === 402 || /quota|insufficient (?:quota|balance|credits)/.test(lower)) {
    return "PROVIDER_QUOTA";
  }
  if (statusCode !== undefined && statusCode >= 500 && statusCode < 600) return "PROVIDER_5XX";
  if (/content.?(?:filter|blocked|policy)|blocked by (?:safety|moderation)/.test(lower))
    return "CONTENT_BLOCKED";
  if (/timeout|timed out|aborted|etimedout/.test(lower)) return "TIMEOUT";

  return "UNKNOWN";
}

/**
 * Normaliza qualquer erro vindo de um provider de IA num AiError.
 *
 * NUNCA vaza texto de chave/token: mensagens contendo algo com cara de
 * segredo (ex.: "Bearer sk-...", "key=...") são redigidas antes de
 * qualquer outro uso (log, persistência).
 *
 * Função pura — não lança, não faz I/O.
 */
export function sanitizeProviderError(err: unknown): AiError {
  const rawMessage = extractRawMessage(err);
  const statusCode = extractStatusCode(err);
  const errLike = toErrorLike(err);
  const provider = typeof errLike.provider === "string" ? errLike.provider : undefined;
  const retryAfterSeconds =
    typeof errLike.retryAfterSeconds === "number" ? errLike.retryAfterSeconds : undefined;

  return {
    code: classify(rawMessage, statusCode),
    message: redactSecrets(rawMessage),
    ...(provider !== undefined ? { provider } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
}

/** Parseia o header Retry-After: aceita segundos inteiros OU data HTTP (RFC 7231). */
function parseRetryAfter(headerValue: string): number | undefined {
  const asSeconds = Number(headerValue);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) return asSeconds;

  const asTimestampMs = Date.parse(headerValue);
  if (Number.isNaN(asTimestampMs)) return undefined;

  return Math.max(0, Math.round((asTimestampMs - Date.now()) / 1000));
}

/**
 * Lê status HTTP + header Retry-After (quando presente) de uma Response
 * (ou de um objeto com o mesmo shape mínimo, útil em teste). Não lança —
 * headers ausentes/malformados resultam em campos omitidos.
 */
export function extractProviderErrorMeta(
  response: Response | { status?: number; headers?: Headers },
): { statusCode?: number; retryAfterSeconds?: number } {
  const statusCode = typeof response.status === "number" ? response.status : undefined;
  const retryAfterHeader = response.headers?.get("Retry-After") ?? undefined;
  const retryAfterSeconds =
    retryAfterHeader !== undefined ? parseRetryAfter(retryAfterHeader) : undefined;

  return {
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
}

/**
 * Guard: diz se um AiError (ou ausência dele) é um RATE_LIMIT — útil pra
 * decidir retry/backoff sem repetir a comparação de `.code` em todo caller.
 */
export function isRateLimitError(error: AiError | null | undefined): boolean {
  return error?.code === "RATE_LIMIT";
}
