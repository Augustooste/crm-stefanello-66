// Cliente HTTP do provedor de agentes — tipado contra o contrato
// versionado em contracts/agent-platform/openapi.json (tipos em ./schema.ts,
// gerados por `pnpm gen:agent-platform`).
//
// Sem I/O de ambiente: recebe baseUrl e token do caller (agent-platform-proxy), o que
// mantém a suite Deno offline e impede que o token vaze por import indireto.

import { computeBackoffMs, sleep } from "../backoff.ts";
import { redactSecrets } from "../redact-secrets.ts";

/** Interativo: o usuário está olhando o spinner. Mesmo valor dos testes de
 * credencial em integration-connect (PROVIDER_TEST_TIMEOUT_MS). */
export const AGENT_PLATFORM_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;

export type AgentPlatformErrorCode =
  | "AUTHENTICATION_FAILED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "RATE_LIMITED"
  | "INSUFFICIENT_CREDITS"
  | "REMOTE_SERVER_ERROR"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "UNSUPPORTED_BY_PUBLIC_API"
  | "UNKNOWN";

/** Mensagens em PT-BR para o usuário final. Nunca expõem token, header ou
 * corpo bruto do provedor — o detalhe técnico vai para system_events. */
export const AGENT_PLATFORM_ERROR_MESSAGES: Record<AgentPlatformErrorCode, string> = {
  AUTHENTICATION_FAILED:
    "A chave da API do provedor de agentes é inválida ou expirou. Reconecte a integração em Configurações.",
  FORBIDDEN: "Sua conta do provedor de agentes não tem permissão para esta operação.",
  NOT_FOUND: "O recurso não foi encontrado no workspace configurado do provedor de agentes.",
  VALIDATION_ERROR:
    "O provedor de agentes recusou os dados enviados. Revise os campos e tente novamente.",
  RATE_LIMITED: "Muitas chamadas ao provedor de agentes em pouco tempo. Aguarde alguns segundos.",
  INSUFFICIENT_CREDITS: "Os créditos do workspace no provedor de agentes acabaram.",
  REMOTE_SERVER_ERROR: "O provedor de agentes está instável agora. Tente novamente em instantes.",
  TIMEOUT: "O provedor de agentes não respondeu no tempo esperado. Tente novamente.",
  NETWORK_ERROR:
    "Não conseguimos falar com o provedor de agentes agora — tente novamente em instantes.",
  UNSUPPORTED_BY_PUBLIC_API:
    "Esta configuração não está disponível na API pública do provedor de agentes. Gerencie direto no painel do provedor de agentes.",
  UNKNOWN: "Não foi possível concluir a operação no provedor de agentes.",
};

export class AgentPlatformError extends Error {
  constructor(
    readonly code: AgentPlatformErrorCode,
    /** Mensagem crua do provedor, para telemetria. Nunca vai para a UI. */
    readonly detail: string | null = null,
    readonly httpStatus: number | null = null,
  ) {
    super(AGENT_PLATFORM_ERROR_MESSAGES[code]);
    this.name = "AgentPlatformError";
  }
}

/**
 * Todo path do contrato já começa com `/v2` e `servers[0].url` é
 * a base sem `/v2`. Concatenar uma base que já termina em `/v2`
 * produziria `/v2/v2/...` — 404 em absolutamente tudo. Aceita as duas grafias
 * porque o valor documentado no escopo do produto inclui o `/v2`.
 */
export class AgentPlatformConfigError extends Error {}

export function normalizeBaseUrl(raw?: string | null): string {
  const trimmed = (raw ?? "").trim();
  // SEM default. Já houve um host de provedor embutido aqui, e um deploy que
  // esquecesse `AGENT_PLATFORM_API_BASE_URL` mandava o Bearer token do tenant
  // para ele — em silêncio, porque tudo "funcionava". Config ausente é erro de
  // config: falha alto, não escolhe destino por conta própria.
  if (!trimmed) {
    throw new AgentPlatformConfigError(
      "AGENT_PLATFORM_API_BASE_URL não configurada. A integração de agentes não " +
        "tem provedor definido — nenhuma chamada remota é feita sem ela.",
    );
  }
  const noSlash = trimmed.replace(/\/+$/, "");
  return noSlash.replace(/\/v2$/i, "");
}

/** Detecta deadline pelo `name` do DOMException, não pela mensagem: o texto
 * varia por runtime ("Signal timed out." vs "The operation was aborted due to
 * timeout"), e classificar por substring já reportou provedor lento como
 * credencial ruim neste repo. */
function isTimeout(e: unknown): boolean {
  return e instanceof DOMException && e.name === "TimeoutError";
}

function looksLikeCredits(text: string): boolean {
  const lc = text.toLowerCase();
  return lc.includes("credit") || lc.includes("crédito") || lc.includes("saldo");
}

function classifyStatus(status: number, rawBody: string): AgentPlatformErrorCode {
  if (status === 401) return "AUTHENTICATION_FAILED";
  if (status === 403) {
    // O contrato usa 403 tanto para token inválido quanto para falta de
    // permissão/crédito; o corpo é `{error: string}`. Sem esta separação, chave
    // revogada aparecia como "sem permissão" e o usuário não reconectava.
    if (looksLikeCredits(rawBody)) return "INSUFFICIENT_CREDITS";
    const lc = rawBody.toLowerCase();
    if (lc.includes("token") || lc.includes("unauthor") || lc.includes("api key")) {
      return "AUTHENTICATION_FAILED";
    }
    return "FORBIDDEN";
  }
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  if (status === 402 || (status === 400 && looksLikeCredits(rawBody))) {
    return "INSUFFICIENT_CREDITS";
  }
  if (status >= 400 && status < 500) return "VALIDATION_ERROR";
  if (status >= 500) return "REMOTE_SERVER_ERROR";
  return "UNKNOWN";
}

const TRANSIENT: ReadonlySet<AgentPlatformErrorCode> = new Set([
  "TIMEOUT",
  "NETWORK_ERROR",
  "RATE_LIMITED",
  "REMOTE_SERVER_ERROR",
]);

export type QueryValue = string | number | boolean | null | undefined;

export interface AgentPlatformRequest {
  method: "get" | "post" | "put" | "delete";
  /** Path do contrato já resolvido (sem placeholders), ex.: `/v2/agent/abc`. */
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** Só é retentado quando o CALLER declara idempotência. Nunca inferir pelo
   * verbo: 4 operações mutantes do contrato usam GET (sync-tools,
   * tool/{id}/active, tool/{id}/inactive). */
  retryable?: boolean;
  correlationId?: string;
}

export interface AgentPlatformClientConfig {
  baseUrl?: string | null;
  token: string;
  timeoutMs?: number;
  /** Injetável para teste; default é o fetch global. */
  fetchImpl?: typeof fetch;
  /** Hook de log estruturado. Recebe apenas metadados — nunca corpo nem token. */
  onLog?: (entry: AgentPlatformLogEntry) => void;
}

export interface AgentPlatformLogEntry {
  method: string;
  path: string;
  status: number | null;
  durationMs: number;
  attempt: number;
  errorCode: AgentPlatformErrorCode | null;
  correlationId: string | null;
}

export interface AgentPlatformClient {
  request<T>(req: AgentPlatformRequest): Promise<T>;
  readonly baseUrl: string;
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, QueryValue>): string {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export function createAgentPlatformClient(config: AgentPlatformClientConfig): AgentPlatformClient {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const timeoutMs = config.timeoutMs ?? AGENT_PLATFORM_TIMEOUT_MS;
  const doFetch = config.fetchImpl ?? fetch;

  async function attempt<T>(req: AgentPlatformRequest, attemptIndex: number): Promise<T> {
    const started = Date.now();
    let status: number | null = null;
    try {
      const response = await doFetch(buildUrl(baseUrl, req.path, req.query), {
        method: req.method.toUpperCase(),
        headers: {
          Authorization: `Bearer ${config.token}`,
          Accept: "application/json",
          ...(req.body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = response.status;
      const text = await response.text();
      if (!response.ok) {
        const code = classifyStatus(response.status, text);
        config.onLog?.({
          method: req.method,
          path: req.path,
          status,
          durationMs: Date.now() - started,
          attempt: attemptIndex,
          errorCode: code,
          correlationId: req.correlationId ?? null,
        });
        throw new AgentPlatformError(code, redactSecrets(text).slice(0, 500), response.status);
      }
      config.onLog?.({
        method: req.method,
        path: req.path,
        status,
        durationMs: Date.now() - started,
        attempt: attemptIndex,
        errorCode: null,
        correlationId: req.correlationId ?? null,
      });
      // 204 e algumas escritas do contrato respondem sem corpo.
      if (!text) return null as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new AgentPlatformError(
          "REMOTE_SERVER_ERROR",
          `resposta não-JSON: ${redactSecrets(text).slice(0, 200)}`,
          response.status,
        );
      }
    } catch (e) {
      if (e instanceof AgentPlatformError) throw e;
      const code: AgentPlatformErrorCode = isTimeout(e) ? "TIMEOUT" : "NETWORK_ERROR";
      config.onLog?.({
        method: req.method,
        path: req.path,
        status,
        durationMs: Date.now() - started,
        attempt: attemptIndex,
        errorCode: code,
        correlationId: req.correlationId ?? null,
      });
      throw new AgentPlatformError(code, redactSecrets(e instanceof Error ? e.message : String(e)));
    }
  }

  return {
    baseUrl,
    async request<T>(req: AgentPlatformRequest): Promise<T> {
      const maxAttempts = req.retryable ? MAX_ATTEMPTS : 1;
      let lastError: unknown;
      for (let i = 0; i < maxAttempts; i++) {
        try {
          return await attempt<T>(req, i);
        } catch (e) {
          lastError = e;
          const retriable = e instanceof AgentPlatformError && TRANSIENT.has(e.code);
          if (!retriable || i === maxAttempts - 1) break;
          await sleep(computeBackoffMs(i));
        }
      }
      throw lastError;
    },
  };
}
