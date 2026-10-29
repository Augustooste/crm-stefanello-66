// manychat-client.ts — único ponto de HTTP com a API pública do ManyChat.
//
// Contrato conferido no Swagger oficial em 29/09/2026
// (https://api.manychat.com/swagger → /swagger/compileJson?type=Page_API) e
// em https://manychat.github.io/dynamic_block_docs/channels/:
//
//   Auth       Authorization: Bearer <API Key>  (Settings > API no ManyChat)
//   Validar    GET  /fb/page/getInfo            -> {status:"success", data:{id,name,...}}
//   Enviar     POST /fb/sending/sendContent     -> {status:"success"}  (limite 25 req/s)
//              body {subscriber_id, data:{version:"v2", content:{type?, messages:[...]}}}
//   Erro 400   {status:"error", message, code}  3011/3031 = fora da janela de 24h,
//              304X = conteúdo não pode ir por aquele canal
//
// `/fb/...` é o prefixo ATUAL de todas as rotas do Swagger, inclusive para
// Instagram e WhatsApp; a superfície vai em `content.type` ("instagram" |
// "whatsapp"). Messenger omite o campo (Response Reference for Facebook).
//
// A resposta de sucesso NÃO traz id de mensagem: external_id é sempre null.
// Nunca enviamos `message_tag` — isso burlaria a janela de 24h da Meta.

export const MANYCHAT_API_BASE = "https://api.manychat.com";

export const MANYCHAT_PROVIDER_SLUGS = [
  "manychat-whatsapp",
  "manychat-instagram",
  "manychat-messenger",
] as const;

export type ManyChatProviderSlug = (typeof MANYCHAT_PROVIDER_SLUGS)[number];
export type ManyChatSurface = "whatsapp" | "instagram" | "messenger";

export function isManyChatSlug(slug: string): slug is ManyChatProviderSlug {
  return (MANYCHAT_PROVIDER_SLUGS as readonly string[]).includes(slug);
}

export function manyChatSurfaceForSlug(slug: ManyChatProviderSlug): ManyChatSurface {
  return slug === "manychat-whatsapp"
    ? "whatsapp"
    : slug === "manychat-instagram"
    ? "instagram"
    : "messenger";
}

/**
 * O Swagger tipa subscriber_id como integer, mas os IDs reais têm 16-17 dígitos
 * e passam de Number.MAX_SAFE_INTEGER. Guardamos sempre como string de dígitos.
 */
export function isValidSubscriberId(value: string): boolean {
  return /^\d{1,30}$/.test(value);
}

// Mesmo teto dos outros providers (provider-send.ts, zappaz-client.ts).
const MANYCHAT_TIMEOUT_MS = 15_000;

/**
 * Limite de caracteres por mensagem de texto de cada superfície (limites da
 * Meta repassados pelo ManyChat). Texto maior vira várias mensagens no mesmo
 * sendContent — o Dynamic Block aceita até 10.
 */
const TEXT_LIMIT: Record<ManyChatSurface, number> = {
  whatsapp: 4096,
  messenger: 2000,
  instagram: 1000,
};
const MAX_MESSAGES_PER_SEND = 10;

export type ManyChatSendResult =
  | { ok: true; external_id: string | null }
  | { ok: false; error: string; retryable?: boolean };

export type ManyChatValidation =
  | { ok: true; page: { id: string | null; name: string | null } }
  | { ok: false; error: string };

export const MANYCHAT_MESSAGES = {
  invalidKey: "API Key do ManyChat inválida ou revogada. Gere uma nova em Settings > API e reconecte.",
  rateLimited: "O ManyChat pediu para aguardar antes de enviar de novo (limite de requisições).",
  unavailable: "O ManyChat está indisponível no momento. Tente de novo em instantes.",
  network: "Não conseguimos falar com o ManyChat agora — tente novamente em instantes.",
  window24h:
    "O ManyChat recusou: o contato não interage há mais de 24h. Só dá para responder depois que ele mandar mensagem de novo.",
  channelRefused:
    "O ManyChat recusou enviar por este canal para este contato (o contato não está inscrito nesta superfície).",
  subscriberNotFound: "Contato não encontrado no ManyChat. Confira se o subscriber_id está correto.",
  refused: "O ManyChat recusou a mensagem. Confira o contato e o conteúdo antes de reenviar.",
  tooLong: "Mensagem longa demais para o ManyChat (mais de 10 blocos). Encurte o texto.",
  missingKey: "Integração ManyChat sem API Key. Reconecte em Integrações.",
  invalidSubscriber: "Contato sem ID do ManyChat válido para responder por este canal.",
} as const;

function parseRetryAfterSeconds(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return Math.ceil(secs);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - Date.now()) / 1000)) : null;
}

function readErrorBody(bodyText: string): { code: number | null; message: string } {
  try {
    const parsed = JSON.parse(bodyText) as { code?: unknown; message?: unknown };
    return {
      code: typeof parsed.code === "number" ? parsed.code : null,
      message: typeof parsed.message === "string" ? parsed.message : "",
    };
  } catch {
    return { code: null, message: "" };
  }
}

/**
 * Traduz a resposta de erro do ManyChat para a mensagem do operador. `retryable`
 * só para 429/5xx: o ManyChat recusou sem enviar. 400/401/403/404/422 são
 * permanentes — retentar não muda nada.
 */
export function parseManyChatError(
  status: number,
  bodyText: string,
  retryAfterHeader: string | null = null,
): { error: string; retryable: boolean } {
  if (status === 401 || status === 403) return { error: MANYCHAT_MESSAGES.invalidKey, retryable: false };
  if (status === 429) {
    const wait = parseRetryAfterSeconds(retryAfterHeader);
    return {
      error: wait === null
        ? MANYCHAT_MESSAGES.rateLimited
        : `${MANYCHAT_MESSAGES.rateLimited} Nova tentativa em ${wait}s.`,
      retryable: true,
    };
  }
  if (status >= 500) return { error: MANYCHAT_MESSAGES.unavailable, retryable: true };
  if (status === 404) return { error: MANYCHAT_MESSAGES.subscriberNotFound, retryable: false };
  const { code, message } = readErrorBody(bodyText);
  if (code === 3011 || code === 3031) return { error: MANYCHAT_MESSAGES.window24h, retryable: false };
  if (code !== null && code >= 3040 && code <= 3049) {
    return { error: MANYCHAT_MESSAGES.channelRefused, retryable: false };
  }
  if (/subscriber.*(not found|does not exist)/i.test(message)) {
    return { error: MANYCHAT_MESSAGES.subscriberNotFound, retryable: false };
  }
  return { error: MANYCHAT_MESSAGES.refused, retryable: false };
}

// Corpo cru do erro só vai para o log, sem a chave e truncado. O Bearer nunca
// aparece no corpo, mas o ManyChat pode ecoar o que recebeu.
function logManyChatFailure(op: string, status: number, bodyText: string, apiKey: string): void {
  const safe = (apiKey ? bodyText.split(apiKey).join("[REDACTED]") : bodyText).slice(0, 500);
  console.error(`[manychat] ${op} falhou (HTTP ${status})`, safe);
}

/** Divide o texto em blocos ≤ limite, preferindo quebra de linha ou espaço. */
export function splitManyChatText(text: string, surface: ManyChatSurface): string[] {
  const limit = TEXT_LIMIT[surface];
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const at = cut > limit / 2 ? cut : limit;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * Corpo do sendContent como STRING: o subscriber_id entra como literal numérico
 * cru (o Swagger exige integer) sem passar por Number(), que arredondaria IDs
 * de 17 dígitos para o contato errado. Chamar só com ID já validado.
 */
export function buildSendContentBody(
  subscriberId: string,
  surface: ManyChatSurface,
  texts: string[],
): string {
  if (!isValidSubscriberId(subscriberId)) throw new Error("subscriber_id inválido");
  const content: Record<string, unknown> = {
    ...(surface === "messenger" ? {} : { type: surface }),
    messages: texts.map((text) => ({ type: "text", text })),
  };
  const data = JSON.stringify({ version: "v2", content });
  return `{"subscriber_id":${subscriberId},"data":${data}}`;
}

/** Valida a API Key com a rota read-only GET /fb/page/getInfo. */
export async function validateManyChatCredentials(apiKey: string): Promise<ManyChatValidation> {
  const key = apiKey.trim();
  if (!key) return { ok: false, error: "Cole a API Key do ManyChat." };
  let r: Response;
  try {
    r = await fetch(`${MANYCHAT_API_BASE}/fb/page/getInfo`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(MANYCHAT_TIMEOUT_MS),
    });
  } catch (e) {
    // Header com \n/\r (colou a chave com quebra de linha) quebra antes da rede.
    if (e instanceof TypeError && /header/i.test(e.message)) {
      return {
        ok: false,
        error: "A API Key tem caractere inválido (quebra de linha ou espaço). Copie e cole de novo.",
      };
    }
    return { ok: false, error: MANYCHAT_MESSAGES.network };
  }
  const bodyText = await r.text().catch(() => "");
  if (!r.ok) {
    logManyChatFailure("getInfo", r.status, bodyText, key);
    return { ok: false, error: parseManyChatError(r.status, bodyText, r.headers.get("retry-after")).error };
  }
  let parsed: { status?: unknown; data?: { id?: unknown; name?: unknown } } = {};
  try {
    parsed = JSON.parse(bodyText) as typeof parsed;
  } catch {
    return { ok: false, error: MANYCHAT_MESSAGES.unavailable };
  }
  if (parsed.status !== "success") {
    logManyChatFailure("getInfo", r.status, bodyText, key);
    return { ok: false, error: MANYCHAT_MESSAGES.invalidKey };
  }
  const id = parsed.data?.id;
  return {
    ok: true,
    page: {
      id: typeof id === "number" || typeof id === "string" ? String(id) : null,
      name: typeof parsed.data?.name === "string" ? parsed.data.name : null,
    },
  };
}

export interface SendManyChatTextParams {
  apiKey: string;
  subscriberId: string;
  surface: ManyChatSurface;
  text: string;
}

/**
 * Envia texto pelo sendContent. Nunca lança por erro do ManyChat: HTTP de erro
 * e `status != "success"` viram {ok:false}. Falha de rede/timeout propaga como
 * exceção — mesmo contrato de sendViaProvider, cujos callers já retentam só
 * isso (messaging-send) ou gravam send_error (send-dispatch).
 */
export async function sendManyChatText(params: SendManyChatTextParams): Promise<ManyChatSendResult> {
  const apiKey = params.apiKey.trim();
  if (!apiKey) return { ok: false, error: MANYCHAT_MESSAGES.missingKey };
  if (!isValidSubscriberId(params.subscriberId)) {
    return { ok: false, error: MANYCHAT_MESSAGES.invalidSubscriber };
  }
  const texts = splitManyChatText(params.text, params.surface);
  if (texts.length === 0) return { ok: false, error: "Mensagem vazia." };
  if (texts.length > MAX_MESSAGES_PER_SEND) return { ok: false, error: MANYCHAT_MESSAGES.tooLong };

  const r = await fetch(`${MANYCHAT_API_BASE}/fb/sending/sendContent`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: buildSendContentBody(params.subscriberId, params.surface, texts),
    signal: AbortSignal.timeout(MANYCHAT_TIMEOUT_MS),
  });
  const bodyText = await r.text().catch(() => "");
  if (!r.ok) {
    logManyChatFailure("sendContent", r.status, bodyText, apiKey);
    const parsed = parseManyChatError(r.status, bodyText, r.headers.get("retry-after"));
    return { ok: false, error: parsed.error, ...(parsed.retryable ? { retryable: true } : {}) };
  }
  // 200 com status != "success" (ou corpo ilegível) não é entrega confirmada.
  let status: unknown = null;
  try {
    status = (JSON.parse(bodyText) as { status?: unknown }).status;
  } catch {
    status = null;
  }
  if (status !== "success") {
    logManyChatFailure("sendContent", r.status, bodyText, apiKey);
    return { ok: false, error: parseManyChatError(400, bodyText).error };
  }
  return { ok: true, external_id: null };
}
