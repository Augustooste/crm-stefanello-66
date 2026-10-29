import { normalizeMessagingText } from "../text-normalize.ts";

// "quero um atendente" já é pedido de transferência sem mais nada em volta:
// ninguém pede um atendente para outra finalidade. Por isso este grupo entra no
// padrão curto, que dispensa verbo de fala.
const HUMAN_TARGET = String.raw`(?:pessoa|humano|humana|atendente|agente)`;
// Cargos. "comercial" e "responsavel" estão no escopo do MVP como exemplos de
// intenção, e os outros são o mesmo pedido com outra palavra — mas "quero
// vendedor com experiencia" e "quero gerente de projeto" NÃO são pedido de
// transferência. Por isso o cargo só vale acompanhado de verbo de fala ou de
// transferência ("quero FALAR com o comercial", "me PASSA para o gerente").
const HUMAN_ROLE = String
  .raw`(?:pessoa|humano|humana|atendente|agente|comercial|vendedor|vendedora|responsavel|gerente|supervisor|supervisora)`;
// Como o lead chama o próprio robô ao recusá-lo. `\bia\b` só casa a palavra
// isolada — "familia", "dia" e "gestoria" não têm fronteira antes do "ia".
const AI_TARGET = String.raw`(?:robo|robot|(?:chat\s*)?bot|ia|inteligencia artificial)`;
const HUMAN_REQUEST_PATTERNS = [
  new RegExp(
    String
      .raw`\b(?:quero|gostaria|desejo|preciso|prefiro)\b.{0,40}\b(?:falar|conversar|atendimento|ajuda)\b.{0,40}\b${HUMAN_ROLE}\b`,
  ),
  new RegExp(
    String
      .raw`\b(?:quero|gostaria|desejo|preciso|prefiro)(?:\s+de|\s+por)?\s+(?:um|uma)?\s*${HUMAN_TARGET}\b`,
  ),
  new RegExp(
    String
      .raw`\b(?:me\s+)?(?:passa|passe|transfere|transfira|encaminha|encaminhe)\b.{0,40}\b${HUMAN_ROLE}\b`,
  ),
  // Recusa da IA. O intervalo `.{0,25}` cobre o que o lead insere entre o verbo
  // de vontade e o de fala ("nao quero CONTINUAR falando"), o gerúndio entra na
  // alternância e o artigo aceita definido — "com A ia", "com O bot" — que é
  // como a frase aparece de verdade.
  new RegExp(
    String
      .raw`\bnao\s+(?:quero|desejo|vou|consigo|pretendo)\b.{0,25}\b(?:fal(?:ar|ando)|convers(?:ar|ando))\s+com\s+(?:o|a|um|uma)?\s*${AI_TARGET}\b`,
  ),
];
const HUMAN_KEYWORD = /^(?:atendente|agente|humano|humana|pessoa(?: real)?|falar com humano)$/;
const SCHEDULING_KEYWORD = /^(?:agendar|marcar)$/;
const SCHEDULING_CONTEXT =
  /\b(?:agenda|agendamento|horario|consulta|reuniao|visita|demonstracao|demo|call|ligacao)\b/;

function isExplicitHumanRequest(text: string): boolean {
  if (HUMAN_REQUEST_PATTERNS.some((pattern) => pattern.test(text))) return true;
  const words = text.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/);
  return words.length <= 4 && words.some((word) => HUMAN_KEYWORD.test(word));
}

/**
 * Retorna um reason estável de handoff ou null. Keywords configuráveis seguem
 * funcionando por substring, mas termos amplos ("atendente", "marcar") exigem
 * intenção/contexto para não transferir simples menções históricas.
 */
export function matchHandoffReason(text: string, keywords: string[]): string | null {
  const normalizedText = normalizeMessagingText(text);
  const normalizedKeywords = keywords
    .filter((keyword) => typeof keyword === "string" && keyword.trim().length > 0)
    .map(normalizeMessagingText);
  const humanRequest = isExplicitHumanRequest(normalizedText);

  if (humanRequest) {
    const matched = normalizedKeywords.find((keyword) =>
      HUMAN_KEYWORD.test(keyword) && normalizedText.includes(keyword)
    );
    return `keyword:${matched ?? "human_handoff"}`;
  }

  for (const keyword of normalizedKeywords) {
    if (!normalizedText.includes(keyword)) continue;
    if (HUMAN_KEYWORD.test(keyword)) continue;
    if (SCHEDULING_KEYWORD.test(keyword) && !SCHEDULING_CONTEXT.test(normalizedText)) continue;
    return `keyword:${keyword}`;
  }
  return null;
}
