// Guarda contra drift entre as duas cópias do contrato de erro de IA.
// src/lib/ai/errors.ts (client/inbox) e supabase/functions/_shared/ai/errors.ts
// (edge functions) são GÊMEOS mantidos em sincronia manual — decisão
// documentada no header de cada um (Deno e o bundler do Vite não
// compartilham resolução de módulo, ver comentários lá). Este teste não
// evita o drift, mas garante que ele não passe despercebido: falha
// imediatamente se o corpo dos dois arquivos divergir.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CLIENT_PATH = resolve(__dirname, "./errors.ts");
const EDGE_PATH = resolve(__dirname, "../../../supabase/functions/_shared/ai/errors.ts");

/**
 * Remove o bloco de comentário de header (linhas `//` e linhas em branco
 * contíguas a partir do topo do arquivo) — os headers dos dois arquivos
 * divergem de propósito (cada um explica a duplicação do seu próprio
 * ponto de vista), só o CORPO (tipos + lógica) precisa ficar idêntico.
 */
function stripHeaderComment(source: string): string {
  const lines = source.split("\n");
  const firstBodyLineIndex = lines.findIndex(
    (line) => line.trim() !== "" && !line.trim().startsWith("//"),
  );

  if (firstBodyLineIndex === -1) {
    throw new Error("arquivo é só comentário de header — nada de corpo pra comparar");
  }

  return lines.slice(firstBodyLineIndex).join("\n");
}

describe("src/lib/ai/errors.ts <-> supabase/functions/_shared/ai/errors.ts", () => {
  it("mantém o corpo (fora do header) idêntico entre as duas cópias do contrato de erro", () => {
    const clientBody = stripHeaderComment(readFileSync(CLIENT_PATH, "utf8"));
    const edgeBody = stripHeaderComment(readFileSync(EDGE_PATH, "utf8"));

    expect(
      clientBody,
      "os dois arquivos de contrato de erro divergiram, sincronize manualmente (src/lib/ai/errors.ts e supabase/functions/_shared/ai/errors.ts)",
    ).toBe(edgeBody);
  });
});
