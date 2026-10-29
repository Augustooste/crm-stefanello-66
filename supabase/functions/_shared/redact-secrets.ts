// redact-secrets.ts — remove substrings com "cara de segredo" antes de
// logar (console.error/log) ou persistir texto de erro (send_error,
// last_error, ai_failure_logs.error_message).
//
// Motivação: quando um fetch falha em nível de rede, o Deno inclui a URL
// completa em err.message. URLs de provider carregam token no path
// (Z-API: https://api.z-api.io/instances/<id>/token/<TOKEN>/...) ou na
// query (Meta Graph API: ...?access_token=...). Sem redação, o token cru
// vaza para logs e para o banco. Este módulo cobre esses padrões E os
// prefixos já cobertos por sanitizeProviderError (Bearer/key/token/secret).
//
// Puro, sem I/O, nunca lança. Idempotente: aplicar duas vezes é seguro.

const PATTERNS: Array<[RegExp, string]> = [
  // Z-API: /token/<hex>/ no path da URL.
  [/(\/token\/)[^/?\s"']+/gi, "$1[REDACTED]"],
  // Query string: ?access_token=..., ?token=..., ?api_key=..., ?secret=...
  [
    /([?&](?:access_token|auth_token|api[_-]?key|apikey|token|secret)=)[^&\s"'#]+/gi,
    "$1[REDACTED]",
  ],
  // Authorization: Bearer <token>
  [/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]"],
  // "api_key: <val>", "token=<val>", "secret: <val>" (formato chave: valor).
  [/((?:api[_-]?)?key\s*[:=]\s*)\S+/gi, "$1[REDACTED]"],
  // JSON: "access_token": "<val>" (corpo de erro de provedor ecoando a
  // credencial). As regras de chave: valor acima não casam por causa das aspas.
  [
    /("(?:access_token|auth_token|token|api[_-]?key|apikey|secret|client_secret|password)"\s*:\s*")[^"]*/gi,
    "$1[REDACTED]",
  ],
  [/(token\s*[:=]\s*)\S+/gi, "$1[REDACTED]"],
  [/(secret\s*[:=]\s*)\S+/gi, "$1[REDACTED]"],
];

export function redactSecrets(msg: unknown): string {
  let out = typeof msg === "string" ? msg : msg instanceof Error ? msg.message : String(msg ?? "");
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}
