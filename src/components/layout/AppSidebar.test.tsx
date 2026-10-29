import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "./AppSidebar";

const useRouterStateMock = vi.fn();
const useCurrentProfileMock = vi.fn();
const useTenantBrandMock = vi.fn();
const useHumanAttentionCountMock = vi.fn();
const useActivePluginsMock = vi.fn();
const useMyCapabilitiesMock = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useRouterState: (opts: unknown) => useRouterStateMock(opts),
}));

vi.mock("@/lib/api/session", () => ({
  useCurrentProfile: () => useCurrentProfileMock(),
}));

vi.mock("@/lib/api/tenant-brand", () => ({
  useTenantBrand: () => useTenantBrandMock(),
}));

vi.mock("@/lib/api/human-attention", () => ({
  useHumanAttentionCount: (tenantId: string | null) => useHumanAttentionCountMock(tenantId),
}));

// Fase 6 -- nenhum item de baseItems hoje declara `plugin`, então o default
// [] não muda nenhum caso já existente; o mock cobre só a ligação com
// useActivePlugins (a lógica de resolução em si é testada em plugins.test.ts).
vi.mock("@/lib/api/plugins", () => ({
  useActivePlugins: () => useActivePluginsMock(),
}));

vi.mock("@/lib/api/entitlements", () => ({
  useMyCapabilities: () => useMyCapabilitiesMock(),
}));

function renderSidebar() {
  return render(
    <SidebarProvider>
      <AppSidebar />
    </SidebarProvider>,
  );
}

describe("AppSidebar", () => {
  beforeEach(() => {
    useRouterStateMock.mockReset();
    useCurrentProfileMock.mockReset();
    useTenantBrandMock.mockReset();
    useRouterStateMock.mockImplementation((opts: { select: (s: unknown) => unknown }) =>
      opts.select({ location: { pathname: "/" } }),
    );
    useTenantBrandMock.mockReturnValue({ name: null, logoUrl: null });
    useHumanAttentionCountMock.mockReset();
    useHumanAttentionCountMock.mockReturnValue(0);
    useActivePluginsMock.mockReset();
    useActivePluginsMock.mockReturnValue([]);
    useMyCapabilitiesMock.mockReset();
    useMyCapabilitiesMock.mockReturnValue({ data: undefined });
  });

  it("renderiza apenas os itens não-admin quando o perfil não é admin", () => {
    useCurrentProfileMock.mockReturnValue({ data: { role: "agent" } });

    renderSidebar();

    expect(screen.getByText("Visão geral")).toBeInTheDocument();
    expect(screen.getByText("Funil")).toBeInTheDocument();
    expect(screen.queryByText("Relatórios")).not.toBeInTheDocument();
    expect(screen.queryByText("Configurações")).not.toBeInTheDocument();
  });

  it('exibe "Decisões" mesmo para perfil não-admin (aprovar sugestão é operação, não administração)', () => {
    useCurrentProfileMock.mockReturnValue({ data: { role: "agent" } });

    renderSidebar();

    expect(screen.getByText("Decisões")).toBeInTheDocument();
  });

  it("renderiza itens admin quando o perfil é admin", () => {
    useCurrentProfileMock.mockReturnValue({ data: { role: "admin" } });

    renderSidebar();

    expect(screen.getByText("Relatórios")).toBeInTheDocument();
    expect(screen.getByText("Configurações")).toBeInTheDocument();
  });

  // Campanhas (/templates) voltou ao menu, admin-only como a rota e a RLS.
  it('exibe "Campanhas" para admin, apontando para /templates', () => {
    useCurrentProfileMock.mockReturnValue({ data: { role: "admin" } });

    renderSidebar();

    expect(screen.getByText("Campanhas").closest("a")).toHaveAttribute("href", "/templates");
  });

  it('oculta "Campanhas" para perfil agent', () => {
    useCurrentProfileMock.mockReturnValue({ data: { role: "agent" } });

    renderSidebar();

    expect(screen.queryByText("Campanhas")).not.toBeInTheDocument();
  });

  // Removidos do menu por decisão de produto -- as rotas seguem no ar por URL.
  // Admin é o caso forte: se sumiu para admin, sumiu para todo mundo.
  it("não exibe 'Mensagens' nem 'Formulários' nem para admin", () => {
    useCurrentProfileMock.mockReturnValue({ data: { role: "admin" } });

    renderSidebar();

    expect(screen.queryByText("Mensagens")).not.toBeInTheDocument();
    expect(screen.queryByText("Formulários")).not.toBeInTheDocument();
  });

  // A área de Agentes voltou ao ar em 2026-08-03 (AGENTES_IA_HABILITADO = true).
  // O item é admin-gated, então o par abaixo mede as duas coisas: aparece para
  // admin E continua escondido para agent. Testar só um dos papéis passaria por
  // acidente — foi o que o teste anterior evitava, e continua valendo.
  // Nem para admin: com AGENTES_IA_HABILITADO=false a área some para todo
  // mundo. Não é permissão, é área incompleta escondida por decisão de produto.
  it('oculta "Agentes IA" mesmo para admin com a flag desligada', () => {
    useCurrentProfileMock.mockReturnValue({ data: { role: "admin" } });

    renderSidebar();

    expect(screen.queryByText("Agentes IA")).not.toBeInTheDocument();
  });

  it('não exibe "Agentes IA" para perfil agent', () => {
    useCurrentProfileMock.mockReturnValue({ data: { role: "agent" } });

    renderSidebar();

    expect(screen.queryByText("Agentes IA")).not.toBeInTheDocument();
  });

  it("não mostra mais Assistente IA, Falhas de IA, Integrações, Conectar IA e Digest Semanal (absorvidas por Configurações)", () => {
    useCurrentProfileMock.mockReturnValue({ data: { role: "admin" } });

    renderSidebar();

    expect(screen.queryByText("Assistente IA")).not.toBeInTheDocument();
    expect(screen.queryByText("Falhas de IA")).not.toBeInTheDocument();
    expect(screen.queryByText("Integrações")).not.toBeInTheDocument();
    expect(screen.queryByText("Conectar IA")).not.toBeInTheDocument();
    expect(screen.queryByText("Digest Semanal")).not.toBeInTheDocument();
    expect(screen.queryByText("Agendamentos")).not.toBeInTheDocument();
  });

  it("sem perfil carregado, trata como não-admin", () => {
    useCurrentProfileMock.mockReturnValue({ data: undefined });

    renderSidebar();

    expect(screen.queryByText("Configurações")).not.toBeInTheDocument();
  });

  it("usa o nome de marca padrão quando não há tenant brand", () => {
    useCurrentProfileMock.mockReturnValue({ data: { role: "admin" } });
    useTenantBrandMock.mockReturnValue({ name: null, logoUrl: null });

    renderSidebar();

    expect(screen.getAllByText("Stefanello").length).toBeGreaterThan(0);
  });

  it("usa o nome do tenant quando fornecido pela marca", () => {
    useCurrentProfileMock.mockReturnValue({ data: { role: "admin" } });
    useTenantBrandMock.mockReturnValue({ name: "Clínica Vida", logoUrl: null });

    renderSidebar();

    expect(screen.getByText("Clínica Vida")).toBeInTheDocument();
  });

  it("enquanto o nome do workspace carrega, mostra placeholder neutro em vez da marca genérica", () => {
    useCurrentProfileMock.mockReturnValue({ data: { role: "admin" } });
    useTenantBrandMock.mockReturnValue({ name: null, logoUrl: null, isLoading: true });

    const { rerender } = renderSidebar();

    expect(screen.queryByText("Stefanello")).not.toBeInTheDocument();
    expect(screen.queryByText("C")).not.toBeInTheDocument();
    const placeholder = screen.getByText("Carregando…");
    expect(placeholder.closest("[aria-busy='true']")).not.toBeNull();

    useTenantBrandMock.mockReturnValue({ name: "Empresa X", logoUrl: null, isLoading: false });
    rerender(
      <SidebarProvider>
        <AppSidebar />
      </SidebarProvider>,
    );

    expect(screen.getByText("Empresa X")).toBeInTheDocument();
    expect(screen.queryByText("Carregando…")).not.toBeInTheDocument();
    expect(document.querySelector("[aria-busy='true']")).toBeNull();
  });

  it("renderiza a inicial da marca quando não há logo", () => {
    useCurrentProfileMock.mockReturnValue({ data: { role: "admin" } });
    useTenantBrandMock.mockReturnValue({ name: "zeta", logoUrl: null });

    renderSidebar();

    expect(screen.getByText("Z")).toBeInTheDocument();
  });

  it("renderiza a logo do tenant como imagem quando logoUrl é fornecido", () => {
    useCurrentProfileMock.mockReturnValue({ data: { role: "admin" } });
    useTenantBrandMock.mockReturnValue({
      name: "Clínica Vida",
      logoUrl: "https://logo.example/x.png",
    });

    renderSidebar();

    const img = screen.getByAltText("");
    expect(img).toHaveAttribute("src", "https://logo.example/x.png");
  });

  it("marca o item Dashboard como ativo apenas na rota raiz", () => {
    useCurrentProfileMock.mockReturnValue({ data: { role: "agent" } });
    useRouterStateMock.mockImplementation((opts: { select: (s: unknown) => unknown }) =>
      opts.select({ location: { pathname: "/pipeline" } }),
    );

    renderSidebar();

    const dashboardLink = screen.getByText("Visão geral").closest("a");
    const pipelineButton = screen.getByText("Funil").closest("[data-active]");
    expect(dashboardLink).toBeInTheDocument();
    expect(pipelineButton).toHaveAttribute("data-active", "true");
  });

  it("marca item de sub-rota como ativo via startsWith", () => {
    useCurrentProfileMock.mockReturnValue({ data: { role: "agent" } });
    useRouterStateMock.mockImplementation((opts: { select: (s: unknown) => unknown }) =>
      opts.select({ location: { pathname: "/contatos/123" } }),
    );

    renderSidebar();

    const contatosButton = screen.getByText("Contatos").closest("[data-active]");
    expect(contatosButton).toHaveAttribute("data-active", "true");
  });

  it("não exibe badge de atenção no Inbox quando não há conversas aguardando", () => {
    useCurrentProfileMock.mockReturnValue({ data: { role: "agent", tenant_id: "t1" } });
    useHumanAttentionCountMock.mockReturnValue(0);

    renderSidebar();

    expect(screen.queryByLabelText(/aguardando atendimento humano/i)).not.toBeInTheDocument();
  });

  it("exibe badge com a contagem no Inbox quando há conversas aguardando humano", () => {
    useCurrentProfileMock.mockReturnValue({ data: { role: "agent", tenant_id: "t1" } });
    useHumanAttentionCountMock.mockReturnValue(3);

    renderSidebar();

    const badge = screen.getByLabelText("3 conversas aguardando atendimento humano");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("3");
  });

  it("limita o badge a 99+ acima de 99", () => {
    useCurrentProfileMock.mockReturnValue({ data: { role: "agent", tenant_id: "t1" } });
    useHumanAttentionCountMock.mockReturnValue(150);

    renderSidebar();

    expect(screen.getByLabelText(/aguardando atendimento humano/i)).toHaveTextContent("99+");
  });

  it('exibe o texto "Powered by Acelera IA" no rodapé', () => {
    useCurrentProfileMock.mockReturnValue({ data: { role: "agent" } });

    renderSidebar();

    expect(screen.getByText("Powered by Acelera IA")).toBeInTheDocument();
  });

  it('esconde "Produtos" quando o plugin "catalogo" não está ativo', () => {
    useCurrentProfileMock.mockReturnValue({ data: { role: "agent" } });
    useActivePluginsMock.mockReturnValue([]);

    renderSidebar();

    expect(screen.queryByText("Produtos")).not.toBeInTheDocument();
  });

  it('exibe "Produtos" quando o plugin "catalogo" está ativo, mesmo para não-admin', () => {
    useCurrentProfileMock.mockReturnValue({ data: { role: "agent" } });
    useActivePluginsMock.mockReturnValue(["catalogo"]);

    renderSidebar();

    expect(screen.getByText("Produtos")).toBeInTheDocument();
  });

  it("compõe a navegação das três engines piloto sem alterar os gates legados", () => {
    useCurrentProfileMock.mockReturnValue({ data: { role: "agent" } });
    useActivePluginsMock.mockReturnValue(["companies", "catalogo", "agenda"]);

    renderSidebar();

    expect(screen.getByText("Empresas").closest("a")).toHaveAttribute("href", "/empresas");
    expect(screen.getByText("Produtos").closest("a")).toHaveAttribute("href", "/produtos");
    expect(screen.getByText("Agenda").closest("a")).toHaveAttribute("href", "/agenda");
  });

  it("mantém cada engine piloto isoladamente desativável pelo adapter legado", () => {
    useCurrentProfileMock.mockReturnValue({ data: { role: "agent" } });
    useActivePluginsMock.mockReturnValue(["agenda"]);

    renderSidebar();

    expect(screen.getByText("Agenda")).toBeInTheDocument();
    expect(screen.queryByText("Empresas")).not.toBeInTheDocument();
    expect(screen.queryByText("Produtos")).not.toBeInTheDocument();
  });

  it("usa entitlements como gate autoritativo quando o runtime novo respondeu", () => {
    useCurrentProfileMock.mockReturnValue({ data: { role: "agent" } });
    useActivePluginsMock.mockReturnValue(["companies", "catalogo"]);
    useMyCapabilitiesMock.mockReturnValue({
      data: [
        { capability_key: "crm.companies", enabled: false, source: "subscription" },
        { capability_key: "crm.catalog", enabled: true, source: "subscription" },
      ],
    });

    renderSidebar();

    expect(screen.queryByText("Empresas")).not.toBeInTheDocument();
    expect(screen.getByText("Produtos")).toBeInTheDocument();
  });
});
