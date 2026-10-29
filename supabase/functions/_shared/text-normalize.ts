// Normalização de texto genérica para comparação (ex.: detecção de
// palavra-chave em mensagens inbound). Função pura -- sem I/O, sem estado --
// fácil de testar isolada. NÃO embute tolerância a pontuação: isso é decisão
// de cada call site (ex.: opt-out/opt-in em messaging-webhook), não desta
// função compartilhada.
//
// Remoção de acentos: normalize("NFD") decompõe "á" em "a" + marca
// combinante separada; \p{M} (categoria Unicode "Mark") captura essa marca
// e qualquer outra marca combinante, então o replace abaixo remove o acento
// sem tocar a letra base.
const COMBINING_MARK = /\p{M}/gu;

export function normalizeMessagingText(text: string): string {
  return String(text ?? "")
    .normalize("NFD")
    .replace(COMBINING_MARK, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " "); // colapsa espaços múltiplos (incl. tabs/quebras de linha)
}
