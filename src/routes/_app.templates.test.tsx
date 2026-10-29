import { describe, expect, it, vi, afterEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithQueryClient } from "@/test/render";
import { requireAdmin } from "@/lib/api/session";
import { Route } from "./_app.templates";

vi.mock("@/components/marketing/TemplatesTab", () => ({
  TemplatesTab: () => <div data-testid="tab-modelos" />,
}));
vi.mock("@/components/marketing/AgendamentosTab", () => ({
  AgendamentosTab: () => <div data-testid="tab-campanhas" />,
}));
vi.mock("@/lib/api/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/session")>();
  return { ...actual, requireAdmin: vi.fn() };
});

// useRouterState real exige RouterProvider (este arquivo renderiza
// <CampanhasPage /> isolado) -- mockado pra ler `window.location.hash`,
// mesmo padrão de _app.configuracoes.test.tsx.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useRouterState: (opts: { select: (s: { location: { hash: string } }) => unknown }) =>
      opts.select({ location: { hash: window.location.hash } }),
  };
});

const CampanhasPage = Route.options.component!;

describe("head() da rota de campanhas (/templates)", () => {
  it("define título e descrição de SEO", async () => {
    const head = await Route.options.head?.({} as never);
    const titleMeta = head?.meta?.find((m) => m && "title" in m);
    expect(titleMeta).toMatchObject({ title: "Campanhas" });
    expect(head?.links?.some((l) => l && "rel" in l && l.rel === "canonical")).toBe(true);
  });
});

describe("RBAC da rota /templates", () => {
  it("beforeLoad exige admin (criar e disparar campanha é admin-only)", async () => {
    const queryClient = {};
    await Route.options.beforeLoad?.({ context: { queryClient } } as never);
    expect(requireAdmin).toHaveBeenCalledWith(queryClient);
  });
});

describe("página de campanhas (/_app/templates) — composição de abas", () => {
  afterEach(() => {
    window.location.hash = "";
  });

  it("abre por padrão na aba Campanhas", () => {
    renderWithQueryClient(<CampanhasPage />);
    expect(screen.getByTestId("tab-campanhas")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Campanhas" })).toHaveAttribute("aria-selected", "true");
  });

  it("troca pra aba Modelos ao clicar", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<CampanhasPage />);

    await user.click(screen.getByRole("tab", { name: "Modelos" }));
    expect(await screen.findByTestId("tab-modelos")).toBeInTheDocument();
  });

  it("#modelos abre direto na aba Modelos", async () => {
    window.location.hash = "#modelos";
    renderWithQueryClient(<CampanhasPage />);
    expect(await screen.findByTestId("tab-modelos")).toBeInTheDocument();
  });

  it("#agendamentos (redirect da antiga /agendamentos) cai na aba Campanhas", async () => {
    window.location.hash = "#agendamentos";
    renderWithQueryClient(<CampanhasPage />);
    expect(await screen.findByTestId("tab-campanhas")).toBeInTheDocument();
  });

  it("ignora hash desconhecido e mantém Campanhas como padrão", () => {
    window.location.hash = "#nao-existe";
    renderWithQueryClient(<CampanhasPage />);
    expect(screen.getByTestId("tab-campanhas")).toBeInTheDocument();
  });
});
