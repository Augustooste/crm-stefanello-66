import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { useCurrentProfile } from "@/lib/api/session";
import { renderWithQueryClient } from "@/test/render";
import { Route } from "./_app.configuracoes";

vi.mock("@/lib/api/session", () => ({ requireAdmin: vi.fn(), useCurrentProfile: vi.fn() }));
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useRouterState: (options: { select: (state: { location: { hash: string } }) => unknown }) =>
      options.select({ location: { hash: window.location.hash } }),
  };
});
vi.mock("@/components/settings/AppearanceTab", () => ({ AppearanceTab: () => <div data-testid="tab-aparencia" /> }));
vi.mock("@/components/settings/CompanyTab", () => ({
  CompanyTab: () => <div data-testid="tab-empresa"><input aria-label="Nome da empresa" defaultValue="" /></div>,
}));
vi.mock("@/components/settings/StagesTab", () => ({ StagesTab: () => <div data-testid="tab-funil" /> }));
vi.mock("@/components/settings/TagsTab", () => ({ TagsTab: () => <div data-testid="tab-tags" /> }));
vi.mock("@/components/settings/TeamTab", () => ({ TeamTab: () => <div data-testid="tab-equipe" /> }));
vi.mock("@/components/settings/NotificationsTab", () => ({ NotificationsTab: () => <div data-testid="tab-notificacoes" /> }));

const ConfiguracoesPage = Route.options.component!;

beforeEach(() => {
  window.location.hash = "";
  vi.mocked(useCurrentProfile).mockReturnValue({ data: { role: "admin" }, isLoading: false } as ReturnType<typeof useCurrentProfile>);
});

describe("configurações do Administrador", () => {
  it("oferece somente as seis abas liberadas", () => {
    renderWithQueryClient(<ConfiguracoesPage />);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Empresa", "Funil de vendas", "Etiquetas", "Equipe", "Aparência", "Notificações",
    ]);
    for (const hidden of ["Perfil do negócio", "IA", "Integrações e Plugins", "Visualização", "Desenvolvedores", "Supressões", "Erros do app", "Incidentes", "Ambiente"]) {
      expect(screen.queryByRole("tab", { name: hidden })).not.toBeInTheDocument();
    }
  });

  it("abre Equipe e Notificações", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<ConfiguracoesPage />);
    await user.click(screen.getByRole("tab", { name: "Equipe" }));
    expect(await screen.findByTestId("tab-equipe")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Notificações" }));
    expect(await screen.findByTestId("tab-notificacoes")).toBeInTheDocument();
  });

  it("mantém o texto de Empresa ao trocar de aba", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<ConfiguracoesPage />);
    await user.click(screen.getByRole("tab", { name: "Empresa" }));
    await user.type(screen.getByLabelText("Nome da empresa"), "Stefanello");
    await user.click(screen.getByRole("tab", { name: "Aparência" }));
    await user.click(screen.getByRole("tab", { name: "Empresa" }));
    expect(screen.getByLabelText("Nome da empresa")).toHaveValue("Stefanello");
  });

  it("ignora hash de aba escondida e mantém Aparência", () => {
    window.location.hash = "#ia";
    renderWithQueryClient(<ConfiguracoesPage />);
    expect(screen.getByTestId("tab-aparencia")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Aparência" })).toHaveAttribute("aria-selected", "true");
  });
});
