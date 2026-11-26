import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "./AppSidebar";

const useRouterStateMock = vi.fn();
const useCurrentProfileMock = vi.fn();
const useTenantBrandMock = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
  useRouterState: (options: unknown) => useRouterStateMock(options),
}));
vi.mock("@/lib/api/session", () => ({ useCurrentProfile: () => useCurrentProfileMock() }));
vi.mock("@/lib/api/tenant-brand", () => ({ useTenantBrand: () => useTenantBrandMock() }));
vi.mock("@/lib/api/human-attention", () => ({ useHumanAttentionCount: () => 0 }));
vi.mock("@/lib/api/plugins", () => ({ useActivePlugins: () => ["companies", "catalogo", "agenda"] }));
vi.mock("@/lib/api/entitlements", () => ({ useMyCapabilities: () => ({ data: undefined }) }));

function renderSidebar(role: "admin" | "manager" | "finance" | "agent") {
  useCurrentProfileMock.mockReturnValue({ data: { role, tenant_id: "t1" } });
  return render(<SidebarProvider><AppSidebar /></SidebarProvider>);
}

function navigationLabels() {
  return screen.getAllByRole("link").map((link) => link.textContent);
}

beforeEach(() => {
  useRouterStateMock.mockImplementation((options: { select: (state: unknown) => unknown }) =>
    options.select({ location: { pathname: "/" } }),
  );
  useTenantBrandMock.mockReturnValue({ name: null, logoUrl: null, isLoading: false });
});

describe("menu por papel comercial", () => {
  it.each(["agent", "finance"] as const)("Vendedor e Financeiro veem somente os quatro itens operacionais", (role) => {
    renderSidebar(role);
    expect(navigationLabels()).toEqual(["Visão geral", "Funil", "Contatos", "Atividades"]);
  });

  it("Gestor também vê Relatórios, mas não Configurações", () => {
    renderSidebar("manager");
    expect(navigationLabels()).toEqual(["Visão geral", "Funil", "Contatos", "Atividades", "Relatórios"]);
    expect(screen.queryByText("Configurações")).not.toBeInTheDocument();
  });

  it("Administrador vê Relatórios, Configurações, Conversas e Acompanhamento automático", () => {
    renderSidebar("admin");
    expect(navigationLabels()).toEqual([
      "Visão geral", "Funil", "Conversas", "Contatos", "Atividades",
      "Acompanhamento automático", "Relatórios", "Configurações",
    ]);
  });

  it("esconde módulos e itens desligados mesmo para Administrador", () => {
    renderSidebar("admin");
    for (const label of ["Decisões", "Campanhas", "Ajuda", "Agentes IA", "Produtos", "Empresas", "Agenda"]) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
    expect(screen.queryByText("Powered by Acelera IA")).not.toBeInTheDocument();
  });

  it("mantém Conversas fora do menu do Gestor", () => {
    renderSidebar("manager");
    expect(screen.queryByText("Conversas")).not.toBeInTheDocument();
    expect(screen.queryByText("Acompanhamento automático")).not.toBeInTheDocument();
  });
});

describe("marca no menu", () => {
  it("usa a logo oficial", () => {
    renderSidebar("admin");
    expect(screen.getAllByAltText("Laticínio Stefanello")[0]).toHaveAttribute("src", "/stefanello-logo.png");
  });
});
