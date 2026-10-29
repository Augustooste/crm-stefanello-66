import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Regressão de `_app.contatos.tsx`, `_app.produtos.tsx` e `_app.empresas.tsx`:
 * uma rota-pai com rotas-filhas (arquivo `_app.X.algo.tsx`) mas sem
 * `<Outlet/>` no seu `component` -- TanStack Router trata como rota-folha, a
 * URL/título da rota filha casam mas o conteúdo dela nunca monta (renderiza
 * o componente do pai por trás). Nenhum teste de componente isolado pega
 * isso (eles montam `Route.options.component` direto via
 * `renderWithQueryClient`, nunca através do matching real do router -- ver
 * revisão da PR #88). Este teste varre `src/routes/*.tsx`, acha toda família
 * pai/filho pela convenção de nome de arquivo e garante que o pai renderiza
 * `Outlet`.
 */
const ROUTES_DIR = path.resolve(__dirname, "routes");

function listRouteFiles(): string[] {
  return readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"));
}

const files = listRouteFiles();
const singleSegmentParents = files.filter((f) => /^_app\.[a-zA-Z0-9-]+\.tsx$/.test(f));
const parentsWithChildren = singleSegmentParents.filter((parent) => {
  const prefix = parent.replace(/\.tsx$/, ".");
  return files.some((f) => f !== parent && f.startsWith(prefix));
});

describe("rota-pai com filhas sempre renderiza <Outlet/>", () => {
  // Trava de sanidade: se isso falhar, a convenção de nome mudou (ou os
  // arquivos foram renomeados) e o teste abaixo ficaria "verde por vazio",
  // mascarando a próxima regressão em vez de pegá-la.
  it("encontra as 3 famílias pai/filho conhecidas", () => {
    expect(parentsWithChildren.sort()).toEqual([
      "_app.agentes.tsx",
      "_app.contatos.tsx",
      "_app.empresas.tsx",
      "_app.produtos.tsx",
    ]);
  });

  it.each(parentsWithChildren)("%s renderiza <Outlet/>", (parent) => {
    const source = readFileSync(path.join(ROUTES_DIR, parent), "utf-8");
    expect(source).toContain("Outlet");
  });
});
