// Comparação de strings em tempo constante — evita side-channel de timing em
// checagens de token/assinatura de webhooks (o `===` do JS faz short-circuit
// no primeiro byte diferente, permitindo em teoria que um atacante infira o
// segredo byte a byte medindo o tempo de resposta). Extraído de
// meta-ads-leadgen/index.ts (verifyMetaSignature) e reutilizado em todos os
// comparativos de segredo/assinatura do repo.
//
// Sempre percorre todos os caracteres do lado mais curto (não termina cedo).
// A comparação de comprimento no início vaza o tamanho do valor esperado, o
// que é aceitável — o tamanho de tokens/segredos é público por design (ex.:
// HMAC-SHA256 sempre produz 64 hex chars, verify tokens são gerados pelo
// próprio remix com tamanho fixo).
export function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
