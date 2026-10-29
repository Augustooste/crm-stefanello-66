// Assinatura de webhooks de saída: HMAC-SHA256 em hex sobre `${t}.${corpo}`.
// Header: X-Aceleraflow-Signature: t=<unix>,v1=<hex>[,v1=<hex>]
// Segundo v1 = assinatura com o segredo anterior (rotação). Segredo usado como veio,
// sem derivação por tenant (cada endpoint tem o seu).
export const SIGNATURE_HEADER = "X-Aceleraflow-Signature";
export const DEFAULT_TOLERANCE_SECONDS = 300;

const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", k, encoder.encode(message)));
}

/** Comparação em tempo constante (sempre percorre o maior comprimento). */
function timingSafeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function signWebhook(
  secret: string,
  timestamp: number,
  body: string,
): Promise<string> {
  if (!secret) throw new Error("webhook secret vazio");
  if (!Number.isInteger(timestamp) || timestamp < 0) throw new Error("timestamp inválido");
  return `v1=${await hmacHex(secret, `${timestamp}.${body}`)}`;
}

function parseHeader(header: string): { t: number; v1: string[] } | null {
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t" && /^\d+$/.test(v)) t = Number(v);
    else if (k === "v1" && v) v1.push(v);
  }
  return t === null || v1.length === 0 ? null : { t, v1 };
}

export async function verifyWebhook(
  secret: string,
  header: string,
  body: string,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  now = Date.now(),
): Promise<boolean> {
  if (!secret) return false;
  const parsed = parseHeader(header);
  if (!parsed) return false;
  if (!(Math.abs(now / 1000 - parsed.t) <= toleranceSeconds)) return false; // NaN falha fechado
  const expected = (await signWebhook(secret, parsed.t, body)).slice("v1=".length);
  // hex canônico é minúsculo: variante em MAIÚSCULAS é rejeitada de propósito.
  let ok = false;
  for (const candidate of parsed.v1) ok = timingSafeEqual(candidate, expected) || ok;
  return ok;
}
