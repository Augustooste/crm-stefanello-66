import type { ReactElement } from "react";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { Route } from "./__root";
import { appearanceBootScript } from "../lib/appearance-boot";

// Mock isolado (arquivo próprio) para cobrir shellComponent/component sem
// depender do mock parcial de useRouter já usado em __root.test.tsx —
// HeadContent e Scripts do TanStack Router exigem um router real completo
// (stores.matches, options.ssr, etc.), então aqui trocamos ambos por stubs.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Outlet: () => <div data-testid="outlet" />,
    HeadContent: () => <meta data-testid="head-content" />,
    Scripts: () => <div data-testid="scripts" />,
  };
});

describe("RootShell", () => {
  it("renderiza o documento em pt-BR com tema dark e injeta o script de tema salvo", () => {
    // `shellComponent` vem de RootRouteOptionsExtensions (módulo do TanStack
    // Router) e não aparece no tipo genérico de `Route.options` — daí o cast
    // via `unknown` (sem `any`) para acessar o valor real em runtime.
    const { shellComponent: RootShell } = Route.options as unknown as {
      shellComponent: (props: { children: ReactElement }) => ReactElement;
    };

    // React reconcilia <html>/<head>/<body> com os elementos singleton reais
    // do document (não cria nós aninhados) — por isso as asserções abaixo
    // consultam document.documentElement/document.head, não o container do RTL.
    render(
      <RootShell>
        <div data-testid="conteudo">conteúdo</div>
      </RootShell>,
    );

    expect(document.documentElement).toHaveAttribute("lang", "pt-BR");
    expect(document.documentElement).toHaveClass("dark");

    // O que o script FAZ é testado em lib/appearance-boot.test.ts (que executa
    // a string); aqui só importa que o shell injeta exatamente aquele script.
    const themeScript = document.head.querySelector("script:not([src])");
    expect(themeScript?.innerHTML).toBe(appearanceBootScript());

    // <head> fica fora do escopo de `screen` (ligado a document.body) — consultado à parte.
    expect(document.head.querySelector('[data-testid="head-content"]')).not.toBeNull();
    expect(screen.getByTestId("scripts")).toBeInTheDocument();
    expect(screen.getByTestId("conteudo")).toBeInTheDocument();
  });
});

describe("RootComponent", () => {
  it("provê o QueryClient do contexto da rota e renderiza as rotas filhas", () => {
    const queryClient = new QueryClient();
    vi.spyOn(Route, "useRouteContext").mockReturnValue({ queryClient });

    const RootComponent = Route.options.component as () => ReactElement;
    render(<RootComponent />);

    expect(screen.getByTestId("outlet")).toBeInTheDocument();
  });
});
