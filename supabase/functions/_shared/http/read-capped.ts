/**
 * Lê o stream em laço e cancela assim que passar de `maxBytes`; null = estourou.
 * Não confia em Content-Length (pode faltar no chunked ou mentir): conta o que chega.
 * O chunk que estoura o teto é descartado, então nunca guarda mais que `maxBytes`.
 * Stream nulo = corpo vazio.
 */
export async function readCapped(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array | null> {
  // NaN/Infinity/negativo fariam o teto sumir em silêncio.
  if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new RangeError("maxBytes inválido");
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
