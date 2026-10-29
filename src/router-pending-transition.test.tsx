import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { RouterPendingFallback } from "./components/common/RouterPendingFallback";

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Regressão do bug corrigido em RouterPendingFallback.tsx.
 *
 * `defaultPendingComponent` é renderizado POR MATCH (cada rota tem seu
 * próprio Suspense boundary local), não como overlay global no root -- ver
 * comentário no componente. Os testes de router.test.tsx e
 * RouterPendingFallback.test.tsx só checam "a opção está configurada" e "o
 * componente isolado renderiza um spinner"; nenhum exercitava uma transição
 * de rota real com beforeLoad lento através do router completo, então
 * nenhum pegava o bug de layout: sem `fixed inset-0`, o fallback montado
 * dentro do grid de 12 colunas do layout (src/routes/_app.tsx) virava um
 * item estreito de ~1/12 da largura ao lado da sidebar já renderizada, em
 * vez do overlay full-screen pretendido.
 *
 * Este teste reproduz a estrutura de src/routes/_app.tsx (layout com
 * sidebar + <Outlet/> dentro de `grid grid-cols-12`) e monta uma rota
 * filha com `beforeLoad` lento -- o cenário dominante do bug relatado
 * (guard de rede lento em /_app/agenda, /_app/empresas, /_app/produtos).
 */
describe("RouterPendingFallback em transição de rota real", () => {
  it("aparece como overlay full-screen (fixed inset-0) mesmo montado dentro do grid do layout pai, quando a rota filha tem beforeLoad lento", async () => {
    const rootRoute = createRootRoute({
      component: () => (
        <div className="flex min-h-screen w-full">
          <aside data-testid="sidebar">sidebar</aside>
          <main>
            <div className="grid grid-cols-12 gap-6">
              <Outlet />
            </div>
          </main>
        </div>
      ),
    });

    const slowChildRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/slow",
      beforeLoad: () => delay(50),
      component: () => <div data-testid="slow-page">carregado</div>,
    });

    const routeTree = rootRoute.addChildren([slowChildRoute]);
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ["/slow"] }),
      // Zerado para o teste não depender do defaultPendingMs real (~1s) --
      // queremos afirmar o que aparece no DOM assim que o pending state
      // entra, não esperar o timing de produção.
      defaultPendingMs: 0,
      defaultPendingMinMs: 0,
      defaultPendingComponent: RouterPendingFallback,
    });

    render(<RouterProvider router={router} />);

    // Fallback aparece (regressão da tela em branco em deep-link com
    // beforeLoad lento).
    const overlay = await screen.findByRole("status");

    // E aparece como overlay full-screen -- não como item estreito de
    // grid. `fixed inset-0` tira o nó do fluxo/grid do <main>, então mesmo
    // montado dentro de `grid grid-cols-12` ele cobre a tela inteira em
    // vez de ocupar uma coluna estreita ao lado da sidebar.
    expect(overlay.className).toContain("fixed");
    expect(overlay.className).toContain("inset-0");
    // A sidebar do layout pai já está montada -- confirma que este é de
    // fato o cenário aninhado (guard lento na rota FILHA), não um root
    // vazio ainda sem nada renderizado.
    expect(screen.getByTestId("sidebar")).toBeInTheDocument();

    await waitFor(() => expect(screen.getByTestId("slow-page")).toBeInTheDocument());
  });
});
