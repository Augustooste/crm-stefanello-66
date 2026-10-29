export type ApiErrorCode =
  | "auth_missing"
  | "auth_invalid"
  | "insufficient_scope"
  | "tenant_inactive"
  | "not_found"
  | "method_not_allowed"
  | "validation_error"
  | "payload_too_large"
  | "rate_limited"
  | "service_unavailable"
  | "internal_error";

const STATUS: Record<ApiErrorCode, number> = {
  auth_missing: 401,
  auth_invalid: 401,
  insufficient_scope: 403,
  tenant_inactive: 403,
  not_found: 404,
  method_not_allowed: 405,
  validation_error: 422,
  payload_too_large: 413,
  rate_limited: 429,
  service_unavailable: 503,
  internal_error: 500,
};

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "x-api-key, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Expose-Headers": "Retry-After, Allow",
};

export function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", ...extraHeaders },
  });
}

/** Mensagens são fixas ou vêm do código: nunca ecoar entrada do cliente (token). */
export function apiError(
  code: ApiErrorCode,
  message: string,
  requestId: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return jsonResponse(
    STATUS[code],
    { error: { code, message, request_id: requestId } },
    extraHeaders,
  );
}
