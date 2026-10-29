import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { NODE_VERIFY_SNIPPET, PYTHON_VERIFY_SNIPPET } from "./verify-snippets";

const DENO_SOURCE = resolve(process.cwd(), "supabase/functions/_shared/webhooks/docs-snippets.ts");
const present = existsSync(DENO_SOURCE);

if (!present && !process.env.CI) {
  console.warn(
    `[AVISO] ${DENO_SOURCE} não existe neste checkout: teste de paridade dos snippets PULADO.`,
  );
}

// Em CI o arquivo precisa existir: sumir em silêncio quebraria a garantia de paridade.
it.runIf(!present && !!process.env.CI)("arquivo de paridade dos snippets existe (CI)", () => {
  throw new Error(
    `Arquivo de paridade sumiu: ${DENO_SOURCE} não existe. Sem ele a UI pode divergir do contrato de assinatura.`,
  );
});

// Extrai o conteúdo do template String.raw`...` de uma constante exportada.
function denoSnippet(source: string, name: string): string {
  const start = source.indexOf(`export const ${name} = String.raw\``);
  if (start < 0) throw new Error(`${name} não encontrado no arquivo Deno`);
  const from = source.indexOf("`", start) + 1;
  return source.slice(from, source.indexOf("`;", from));
}

describe.skipIf(!present)("paridade dos snippets com docs-snippets.ts (Deno)", () => {
  const source = present ? readFileSync(DENO_SOURCE, "utf8") : "";

  it("snippet Node é idêntico ao do Deno", () => {
    expect(NODE_VERIFY_SNIPPET).toBe(denoSnippet(source, "NODE_VERIFY_SNIPPET"));
  });

  it("snippet Python é idêntico ao do Deno", () => {
    expect(PYTHON_VERIFY_SNIPPET).toBe(denoSnippet(source, "PYTHON_VERIFY_SNIPPET"));
  });
});

describe("snippets da interface", () => {
  it("não ficam vazios e citam o cabeçalho de assinatura", () => {
    expect(NODE_VERIFY_SNIPPET).toContain("X-Aceleraflow-Signature");
    expect(PYTHON_VERIFY_SNIPPET).toContain("X-Aceleraflow-Signature");
  });
});
