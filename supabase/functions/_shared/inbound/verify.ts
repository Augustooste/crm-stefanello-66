// Verificação de autenticidade dos webhooks de ENTRADA (regras de entrada v2).
// Três modos (Ruling Q1, formatos confirmados no spike 2026-10-20-v2-gateways-webhooks):
// - aceleraflow_hmac: mesmo esquema da v1 (`t=<unix>,v1=<hex>`, HMAC-SHA256 de `${t}.${corpo}`).
// - stripe_signature: header `Stripe-Signature`, mesmo esquema; `v0` ignorado, várias `v1` aceitas.
// - header_token: token estático num header configurável (Asaas, Hotmart).
// Segredos vêm de get_inbound_rule_auth; nunca logar nem devolver.
import { DEFAULT_TOLERANCE_SECONDS, verifyWebhook } from "../webhooks/sign.ts";
import { timingSafeEqualStrings } from "../timing-safe-equal.ts";

export const INBOUND_SIGNATURE_HEADER = "X-Aceleraflow-Signature";
export const STRIPE_SIGNATURE_HEADER = "Stripe-Signature";
// D7: corpo acima de 64 KB => 413 (o "1 MB" do Review Focus é onde o stream tem de ser cancelado).
export const INBOUND_MAX_BODY_BYTES = 64 * 1024;

export type InboundAuth = {
  verification_mode: string;
  token_header_name: string | null;
  current_secret: string | null;
  previous_secret: string | null;
};

// token de RFC 9110 §5.6.2; limite de tamanho evita header name absurdo vindo do banco.
const HTTP_TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;

const encoder = new TextEncoder();

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function secrets(auth: InboundAuth): string[] {
  return [auth.current_secret, auth.previous_secret].filter((s): s is string => !!s);
}

/** `t=` repetido (ex.: header duplicado juntado por vírgula) falha fechado. Mesma regra de chave do parseHeader da v1. */
function hasSingleTimestamp(header: string): boolean {
  return (
    header.split(",").filter((p) => p.includes("=") && p.slice(0, p.indexOf("=")).trim() === "t")
      .length === 1
  );
}

async function verifySigned(
  auth: InboundAuth,
  header: string | null,
  rawBody: string,
  now: number,
): Promise<boolean> {
  if (!header || !hasSingleTimestamp(header)) return false;
  let ok = false;
  // Testa todos os segredos sem curto-circuito: o tempo não revela qual casou.
  for (const s of secrets(auth)) {
    ok = (await verifyWebhook(s, header, rawBody, DEFAULT_TOLERANCE_SECONDS, now)) || ok;
  }
  return ok;
}

async function verifyHeaderToken(auth: InboundAuth, headers: Headers): Promise<boolean> {
  const name = auth.token_header_name;
  if (!name || !HTTP_TOKEN_RE.test(name)) return false;
  const received = headers.get(name); // Headers.get é case-insensitive
  if (!received) return false;
  // Compara digests de tamanho fixo: não vaza o comprimento do token esperado.
  const receivedHash = await sha256Hex(received);
  let ok = false;
  for (const s of secrets(auth)) {
    ok = timingSafeEqualStrings(receivedHash, await sha256Hex(s)) || ok;
  }
  return ok;
}

/** true só se a requisição prova conhecer o segredo da regra. Qualquer dúvida = false. */
export async function verifyInbound(
  auth: InboundAuth,
  headers: Headers,
  rawBody: string,
  now: number = Date.now(),
): Promise<boolean> {
  switch (auth.verification_mode) {
    case "aceleraflow_hmac":
      return await verifySigned(auth, headers.get(INBOUND_SIGNATURE_HEADER), rawBody, now);
    case "stripe_signature":
      return await verifySigned(auth, headers.get(STRIPE_SIGNATURE_HEADER), rawBody, now);
    case "header_token":
      return await verifyHeaderToken(auth, headers);
    default:
      return false;
  }
}
