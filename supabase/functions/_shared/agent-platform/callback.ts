// Derivação da URL de callback de treinamento do provedor de agentes.
//
// O contrato aceita `callbackUrl` na criação de treinamento mas NÃO documenta
// assinatura nem payload — então o segredo é nosso: a URL carrega uma chave
// derivada por tenant, e o receptor recusa qualquer chamada sem ela.
//
// A chave é HMAC-SHA256(segredo global, tenantId): a URL de um tenant não vale
// para outro, e vazar uma não expõe o segredo nem as demais.

export async function deriveCallbackKey(secret: string, tenantId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(tenantId));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * `https://<projeto>.supabase.co/functions/v1/agent-platform-training-callback?t=<tenant>&k=<hmac>`
 *
 * Devolve `null` quando o segredo não está configurado — nesse caso o
 * treinamento é criado sem `callbackUrl` (nunca com uma URL que não valida).
 */
export async function buildTrainingCallbackUrl(
  supabaseUrl: string,
  secret: string | undefined | null,
  tenantId: string,
): Promise<string | null> {
  const trimmed = (secret ?? "").trim();
  if (!trimmed) return null;
  const key = await deriveCallbackKey(trimmed, tenantId);
  const base = supabaseUrl.replace(/\/+$/, "");
  return `${base}/functions/v1/agent-platform-training-callback?t=${
    encodeURIComponent(tenantId)
  }&k=${key}`;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
