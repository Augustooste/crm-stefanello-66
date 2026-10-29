// uncertainty.ts — detecta se a RESPOSTA da IA sinaliza que ela não sabe
// responder (gatilho de handoff automático para atenção humana).
//
// Porta de clientes/pedro/medflow-v0/lib/ai/agent/conversation-signals.ts
// (função `detectAssistantUncertainty`), adaptada a este projeto: função
// isolada em arquivo próprio (lá vivia junto de outros detectores de sinal
// de conversa), sem dependência de tipos do agente (LeadContext etc.) — só
// a função pura de regex sobre a string de resposta.
//
// Diferente de detectores que analisam a mensagem do LEAD, esta função roda
// sobre o TEXTO GERADO PELA IA. A ideia: o prompt do assistente deve
// instruir algo como "se não souber responder, diga que vai verificar com a
// equipe" — então frases desse tipo na resposta são o sinal canônico de que
// a IA bateu no limite do que sabe e precisa de handoff humano.
//
// Heurística baseada em regex sobre frases comuns em PT-BR. NÃO é
// perfeita: pode ter falso positivo (ex.: resposta que cita "não sei" em
// contexto não literal — mitigado com guards abaixo) e falso negativo
// (fraseados que a IA use e não estejam cobertos aqui). Ajustar a lista
// conforme casos reais de produção aparecerem.

/**
 * Padrões que indicam que a resposta da IA sinaliza incerteza / não-saber.
 *
 * Guards anti-falso-positivo (herdados do port original):
 *  - "não sei SE ..." (uso especulativo: "não sei se ficou claro") NÃO casa;
 *  - "vou verificar" exige complemento "com/junto" (equipe/time/gerente) —
 *    "vou verificar os horários disponíveis" (fluxo normal) NÃO casa;
 *  - "seu problema, eu entendo" ou frases com "sei" fora de negação de
 *    conhecimento NÃO casam (nenhum padrão casa "sei" isolado).
 */
const ASSISTANT_UNCERTAINTY_PATTERNS: readonly RegExp[] = [
  /\bn[ãa]o\s+(?:sei|saberia)\b(?!\s+se\b)/i,
  /\bn[ãa]o\s+tenho\s+(?:(?:essa|esta|a)\s+)?(?:informa[çc][ãa]o|certeza)\b/i,
  /\bn[ãa]o\s+(?:consigo|posso)\s+(?:te\s+|lhe\s+)?(?:responder|informar|confirmar|dizer|precisar)\b/i,
  /\b(?:vou|preciso|tenho\s+que|vou\s+ter\s+que)\s+(?:verificar|confirmar|checar|perguntar)\s+(?:com|junto)\b/i,
  /\bn[ãa]o\s+tenho\s+como\s+(?:te\s+|lhe\s+)?(?:confirmar|informar|responder|dizer)\b/i,
];

/**
 * Detecta se a resposta gerada pela IA sinaliza que ela NÃO SABE responder
 * e portanto deve acionar handoff automático para atenção humana.
 *
 * Função PURA, sem I/O. Input limitado a 1000 chars (anti-ReDoS, mesma
 * técnica usada no port original para os demais detectores de sinal).
 *
 * @param text resposta gerada pela IA (texto puro, já sem markdown/HTML)
 * @returns true se a resposta sinaliza não-saber / incerteza
 */
export function detectAssistantUncertainty(text: string): boolean {
  const bounded = text.slice(0, 1000);
  return ASSISTANT_UNCERTAINTY_PATTERNS.some((pattern) => pattern.test(bounded));
}
