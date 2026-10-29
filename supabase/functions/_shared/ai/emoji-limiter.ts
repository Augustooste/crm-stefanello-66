/**
 * @fileoverview Limitador de emojis.
 *
 * Porta de clientes/pedro/medflow-v0/lib/ai/agent/emoji-limiter.ts, quase 1:1
 * (função pura, sem I/O). Limita a quantidade de emojis que a IA pode emitir
 * por mensagem. Aplicado UMA ÚNICA VEZ sobre o texto completo da resposta da
 * IA — este projeto não tem lógica de split/fragmentação de mensagem (ao
 * contrário do medflow-v0, que envia múltiplas bolhas no WhatsApp), então não
 * há risco de cada fragmento ganhar sua própria cota.
 *
 * Justificativa: regras só no prompt são ignoradas por parte dos modelos —
 * limite enforced em código evita o agente de IA do aceleraflow saturar a
 * resposta com 2-3 emojis por bolha, virando ruído visual.
 *
 * Nota de implementação: conta codepoints atômicos de Extended_Pictographic.
 * Sequências ZWJ como 👨‍⚕️ (man + ZWJ + medical_symbol) contam como 3, não 1.
 * Para precisão maior, trocar por `Intl.Segmenter({ granularity: 'grapheme' })`.
 *
 * @module supabase/functions/_shared/ai/emoji-limiter
 */

const EMOJI_REGEX = /\p{Extended_Pictographic}/gu;

/**
 * Limita a quantidade de emojis no texto. Mantém os primeiros `max` emojis;
 * remove o restante. Retorna o texto original inalterado quando já está
 * dentro do limite (zero alocações).
 *
 * @param text texto de entrada (pode conter separadores de parágrafo `\n\n`)
 * @param max quantidade máxima de emojis permitida (default 1)
 */
export function limitEmojis(text: string, max = 1): string {
  if (!text) return text;
  if (max < 0) max = 0; // clamp negativo
  let kept = 0;
  let stripped = false;
  // Single-pass: conta + remove em uma única travessia do regex. O espaço
  // seguinte é consumido junto com o emoji removido, evitando espaços
  // duplicados ou whitespace órfão.
  const replaced = text.replace(
    /(\p{Extended_Pictographic})(\s)?/gu,
    (_m, emoji: string, trailing?: string) => {
      kept++;
      if (kept <= max) return emoji + (trailing ?? "");
      stripped = true;
      return "";
    },
  );
  if (!stripped) return text; // fast-path: sem mudança, retorna referência original
  return replaced
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n");
}

/**
 * Conta emojis no texto. Exposto para telemetria/testes.
 */
export function countEmojis(text: string): number {
  if (!text) return 0;
  let count = 0;
  EMOJI_REGEX.lastIndex = 0;
  while (EMOJI_REGEX.exec(text)) count++;
  return count;
}
