import { apiError } from "./errors.ts";
import type { ApiContext, ApiDeps } from "./types.ts";

const API_KEY_HEADER = "x-api-key";
const RATE_LIMIT_MAX = 120;
const RATE_LIMIT_WINDOW_SECONDS = 60;

export type AuthResult =
  | { ok: true; ctx: ApiContext }
  | { ok: false; response: Response };

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isApiContext(row: unknown): row is { key_id: string; tenant_id: string; scopes: string[] } {
  if (!row || typeof row !== "object") return false;
  const r = row as Record<string, unknown>;
  return typeof r.key_id === "string" && typeof r.tenant_id === "string" &&
    Array.isArray(r.scopes);
}

/** Valida X-Api-Key via RPC (sha256), tenant ativo e rate limit. Falha fechada. */
export async function authenticateRequest(
  req: Request,
  deps: ApiDeps,
  requestId: string,
): Promise<AuthResult> {
  const token = req.headers.get(API_KEY_HEADER)?.trim();
  if (!token) {
    return { ok: false, response: apiError("auth_missing", "Cabeçalho X-Api-Key ausente.", requestId) };
  }

  const auth = await deps.db.rpc("authenticate_api_key", { p_key_hash: await sha256Hex(token) });
  if (auth.error) {
    deps.log({ event: "auth_rpc_error", request_id: requestId });
    return { ok: false, response: apiError("service_unavailable", "Serviço indisponível.", requestId) };
  }
  const row = Array.isArray(auth.data) ? auth.data[0] : null;
  if (!isApiContext(row)) {
    return { ok: false, response: apiError("auth_invalid", "Chave de API inválida.", requestId) };
  }
  const ctx: ApiContext = { tenantId: row.tenant_id, keyId: row.key_id, scopes: row.scopes };

  const limit = await deps.db.rpc("check_and_record_rate_limit", {
    p_key: `public-api:${ctx.keyId}`,
    p_max_calls: RATE_LIMIT_MAX,
    p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
  });
  const verdict = limit.data as { allowed?: unknown; retryAfterSeconds?: unknown } | null;
  if (limit.error || !verdict || typeof verdict.allowed !== "boolean") {
    deps.log({ event: "rate_limit_rpc_error", request_id: requestId, key_id: ctx.keyId });
    return { ok: false, response: apiError("service_unavailable", "Serviço indisponível.", requestId) };
  }
  if (!verdict.allowed) {
    const retry = typeof verdict.retryAfterSeconds === "number" ? Math.max(1, verdict.retryAfterSeconds) : RATE_LIMIT_WINDOW_SECONDS;
    return {
      ok: false,
      response: apiError("rate_limited", "Limite de requisições excedido.", requestId, {
        "Retry-After": String(retry),
      }),
    };
  }
  return { ok: true, ctx };
}

export function hasScope(ctx: ApiContext, scope: string): boolean {
  return ctx.scopes.includes(scope);
}
