// Receptor dos webhooks de ENTRADA (regras de entrada v2, Task 6).
// POST /functions/v1/inbound-webhook/<rule_id>. Contrato: task-4-review §G e D7/D8.
// Nunca logar segredo, header de assinatura, token nem corpo: log só com request_id,
// rule_id, status e o code do Postgres. A resposta nunca revela se a regra ou o
// negócio existem, qual modo falhou nem erro SQL.
import { readCapped } from "../_shared/http/read-capped.ts";
import {
  INBOUND_MAX_BODY_BYTES,
  type InboundAuth,
  verifyInbound,
} from "../_shared/inbound/verify.ts";

export type InboundDeps = {
  db: {
    rpc: (
      name: string,
      params: Record<string, unknown>,
    ) => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;
  };
  log: (entry: Record<string, unknown>) => void;
  now: () => number;
};

const RATE_LIMIT_MAX = 120;
const RATE_LIMIT_WINDOW_SECONDS = 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RULE_PATH_RE = /\/inbound-webhook\/([^/]+)\/?$/;
// m5 da Task 5: header que o runtime/proxy controla não pode carregar o token da regra.
// Mesma lista de private.assert_inbound_verification (20261021100000_inbound_rules.sql):
// mudou uma, muda a outra no mesmo commit.
const RESERVED_TOKEN_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "authorization",
  "cookie",
]);
const SUCCESS_STATUSES = new Set([
  "processed",
  "duplicate",
  "ignored",
  "not_found",
  "ambiguous",
  "failed",
]);

// Regra inexistente ou inativa: verifica contra um segredo fixo no mesmo modo para
// não abrir um caminho mais rápido (N4). O resultado é descartado.
const DUMMY_AUTH: InboundAuth = {
  verification_mode: "aceleraflow_hmac",
  token_header_name: null,
  current_secret: "whin_dummy_0000000000000000000000000000000000000000000000000000000000",
  previous_secret: null,
};

type AuthRow = InboundAuth & { tenant_id: string; active: boolean };

function respond(
  status: number,
  body: unknown,
  requestId: string,
  extra: Record<string, string> = {},
) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      ...(body === null ? {} : { "content-type": "application/json" }),
      "X-Request-Id": requestId,
      ...extra,
    },
  });
}

const unauthorized = (id: string) => respond(401, { error: "unauthorized" }, id);
const unavailable = (id: string) => respond(503, { error: "unavailable" }, id);
const badRequest = (id: string) => respond(400, { error: "bad_request" }, id);
const tooLarge = (id: string) => respond(413, { error: "payload_too_large" }, id);

function isAuthRow(row: unknown): row is AuthRow {
  if (!row || typeof row !== "object") return false;
  const r = row as Record<string, unknown>;
  return typeof r.active === "boolean" && typeof r.verification_mode === "string";
}

/** Algum texto (chave ou valor) com U+0000? O jsonb do Postgres recusa (22P05). */
function hasNul(value: unknown): boolean {
  if (typeof value === "string") return value.includes("\u0000");
  if (Array.isArray(value)) return value.some(hasNul);
  if (value && typeof value === "object") {
    return Object.entries(value).some(([k, v]) => k.includes("\u0000") || hasNul(v));
  }
  return false;
}

/** Chama a RPC e converte rejeição (rede, abort do prazo) em erro, sem a mensagem. */
async function callRpc(deps: InboundDeps, name: string, params: Record<string, unknown>) {
  try {
    return await deps.db.rpc(name, params);
  } catch {
    return { data: null, error: { code: "fetch_failed", message: "" } };
  }
}

export async function handleInbound(req: Request, deps: InboundDeps): Promise<Response> {
  const requestId = crypto.randomUUID();
  if (req.method === "OPTIONS") return respond(204, null, requestId, { Allow: "POST, OPTIONS" });
  if (req.method !== "POST") {
    return respond(405, { error: "method_not_allowed" }, requestId, { Allow: "POST, OPTIONS" });
  }
  try {
    return await handlePost(req, deps, requestId);
  } catch {
    // Nada do erro sai do processo: pode carregar dado da requisição.
    deps.log({ event: "inbound_unhandled", request_id: requestId });
    return unavailable(requestId);
  }
}

async function handlePost(req: Request, deps: InboundDeps, requestId: string): Promise<Response> {
  const ruleId = new URL(req.url).pathname.match(RULE_PATH_RE)?.[1] ?? "";
  if (!UUID_RE.test(ruleId)) return unauthorized(requestId);
  const log = (entry: Record<string, unknown>) =>
    deps.log({ request_id: requestId, rule_id: ruleId, ...entry });

  const authRes = await callRpc(deps, "get_inbound_rule_auth", { p_rule_id: ruleId });
  if (authRes.error) {
    log({ event: "inbound_auth_rpc_error", code: authRes.error.code ?? "none" });
    return unavailable(requestId);
  }
  const row = Array.isArray(authRes.data) ? authRes.data[0] : null;
  const known = isAuthRow(row) && row.active;
  const auth: InboundAuth = known ? row : DUMMY_AUTH;

  // Corpo com teto antes da assinatura (D7). Content-Length declarado acima: 413 sem ler.
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > INBOUND_MAX_BODY_BYTES) return tooLarge(requestId);
  let bytes: Uint8Array | null;
  try {
    bytes = await readCapped(req.body, INBOUND_MAX_BODY_BYTES);
  } catch {
    // Stream abortado pelo cliente (N2): resposta genérica, nunca 500 com stack.
    return badRequest(requestId);
  }
  if (bytes === null) return tooLarge(requestId);
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // N3: igual para regra existente ou não, então não revela nada.
    return badRequest(requestId);
  }

  const reserved =
    auth.verification_mode === "header_token" &&
    RESERVED_TOKEN_HEADERS.has((auth.token_header_name ?? "").toLowerCase());
  const signed = await verifyInbound(auth, req.headers, raw, deps.now());
  if (known && reserved) log({ event: "inbound_reserved_token_header" });
  if (!known || reserved || !signed) return unauthorized(requestId);

  // v2.1 Task B: gateway (Asaas só aceita 200 e pausa a fila após 15 falhas; Hotmart
  // desativa a URL que dá erro) recebe 200 "ignored" por problema de negócio já
  // autenticado. aceleraflow_hmac é o sistema do cliente: mantém o 400 para o dev ver.
  // Só chega aqui com `auth` = linha real (known), nunca DUMMY_AUTH.
  const isGateway =
    auth.verification_mode === "stripe_signature" || auth.verification_mode === "header_token";
  const ignored = (reason: string, hmacError: string) => {
    log({ event: "inbound_ignored", reason });
    return isGateway
      ? respond(200, { received: true, ignored: reason, request_id: requestId }, requestId)
      : respond(400, { error: hmacError }, requestId);
  };

  // Corpo que a edge descarta sozinha. `reason` vai na resposta (enum do openapi);
  // `recorded` é o motivo de record_inbound_ignored (o \u0000 conta como nul_payload).
  let local: { reason: string; recorded: string; hmacError: string } | null = null;
  let payload: unknown = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    local = { reason: "invalid_json", recorded: "invalid_json", hmacError: "bad_request" };
  }
  if (!local && (!payload || typeof payload !== "object" || Array.isArray(payload))) {
    local = { reason: "invalid_payload", recorded: "invalid_payload", hmacError: "bad_request" };
  } else if (!local && hasNul(payload)) {
    // Escape \u0000 assinado viraria 22P05 no jsonb e 503 em loop no reenvio do gateway.
    local = { reason: "invalid_payload", recorded: "nul_payload", hmacError: "invalid_payload" };
  }
  // aceleraflow_hmac: o evento é rejeitado (400), não ignorado. Não consome cota nem conta.
  if (local && !isGateway) return ignored(local.reason, local.hmacError);

  // D8 + I1 da review: só requisição assinada de regra ativa consome a cota. Sem
  // oráculo 429 x 401 e quem só conhece a URL não esgota o limite do remetente legítimo.
  // Corpo descartado no gateway também consome: o UPDATE do contador fica sob o limite.
  const limit = await callRpc(deps, "check_and_record_rate_limit", {
    p_key: `inbound-req:${ruleId}`,
    p_max_calls: RATE_LIMIT_MAX,
    p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
  });
  const verdict = limit.data as { allowed?: unknown; retryAfterSeconds?: unknown } | null;
  if (limit.error || !verdict || typeof verdict.allowed !== "boolean") {
    log({ event: "inbound_rate_limit_rpc_error", code: limit.error?.code ?? "bad_shape" });
    // Corpo descartado: o gateway recebe o 200 de sempre, sem contar (sem cota, sem UPDATE).
    if (local) return ignored(local.reason, local.hmacError);
    return unavailable(requestId);
  }
  if (!verdict.allowed && local) {
    // 429 pausaria a fila do Asaas por causa de um corpo que nunca vai ser processado.
    log({ event: "inbound_rate_limited", status: 200 });
    return ignored(local.reason, local.hmacError);
  }
  if (!verdict.allowed) {
    const retry =
      typeof verdict.retryAfterSeconds === "number"
        ? Math.max(1, Math.ceil(verdict.retryAfterSeconds))
        : RATE_LIMIT_WINDOW_SECONDS;
    log({ event: "inbound_rate_limited", status: 429 });
    return respond(429, { error: "rate_limited" }, requestId, { "Retry-After": String(retry) });
  }
  if (local) {
    // Best-effort: falha do contador nunca muda o 200 (o gateway reenviaria o mesmo lixo).
    const rec = await callRpc(deps, "record_inbound_ignored", {
      p_rule_id: ruleId,
      p_reason: local.recorded,
    });
    if (rec.error) log({ event: "inbound_ignored_record_error", code: rec.error.code ?? "none" });
    return ignored(local.reason, local.hmacError);
  }

  const res = await callRpc(deps, "process_inbound_event", {
    p_rule_id: ruleId,
    p_payload: payload,
  });
  if (res.error) {
    log({ event: "inbound_process_rpc_error", code: res.error.code ?? "none" });
    return unavailable(requestId);
  }
  const out = (res.data && typeof res.data === "object" ? res.data : {}) as Record<string, unknown>;
  const status = typeof out.status === "string" ? out.status : "invalid";
  log({ event: "inbound_processed", status, inbound_event_id: out.inbound_event_id ?? null });

  if (SUCCESS_STATUSES.has(status)) {
    // Ruling do coordenador (fix round 1): 200 em todo modo (o Asaas só aceita 200).
    return respond(200, { received: true, request_id: requestId }, requestId);
  }
  if (status === "inactive") return unauthorized(requestId);
  // Nenhum evento criado: a RPC retorna antes do insert, mas já somou ignored_count da
  // regra (por isso a edge não chama record_inbound_ignored aqui: contaria em dobro). A
  // cota da edge já foi consumida porque só o Postgres sabe onde está o id do evento.
  if (status === "missing_event_id") return ignored("missing_event_id", "bad_request");
  if (status === "rate_limited" && out.reason === "minute_limit") {
    const retry =
      typeof out.retry_after_seconds === "number"
        ? Math.max(1, Math.ceil(out.retry_after_seconds))
        : 60;
    return respond(429, { error: "rate_limited" }, requestId, { "Retry-After": String(retry) });
  }
  // daily_limit (a regra pausou: o gateway guarda e reenvia), reason ausente e status
  // desconhecido falham fechado em 503.
  return unavailable(requestId);
}
