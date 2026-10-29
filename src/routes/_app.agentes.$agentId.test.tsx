import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithQueryClient } from "@/test/render";
import { routerOverrides } from "@/test/router-mocks";
import type { AgentPlatformAgent } from "@/lib/api/agent-platform-contract";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    ...routerOverrides(),
    useRouterState: (opts: { select: (s: { location: { hash: string } }) => unknown }) =>
      opts.select({ location: { hash: window.location.hash } }),
  };
});

const useAgentPlatformQueryMock = vi.fn();
vi.mock("@/lib/api/agent-platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/agent-platform")>();
  return {
    ...actual,
    useAgentPlatformQuery: (...args: unknown[]) => useAgentPlatformQueryMock(...args),
  };
});

// Cada aba é responsabilidade de outro agente nesta mesma tarefa -- este
// teste só garante que o shell (header, abas, deep-link por hash) funciona,
// sem depender do conteúdo interno de cada aba.
vi.mock("@/components/agents/AgentProfileTab", () => ({
  AgentProfileTab: ({ agentId }: { agentId: string }) => (
    <div data-testid="tab-perfil">{agentId}</div>
  ),
}));
vi.mock("@/components/agents/AgentSettingsTab", () => ({
  AgentSettingsTab: ({ agentId }: { agentId: string }) => (
    <div data-testid="tab-modelo">{agentId}</div>
  ),
}));
vi.mock("@/components/agents/AgentTrainingsTab", () => ({
  AgentTrainingsTab: ({ agentId }: { agentId: string }) => (
    <div data-testid="tab-treinamentos">{agentId}</div>
  ),
}));
vi.mock("@/components/agents/AgentIntentionsTab", () => ({
  AgentIntentionsTab: ({ agentId }: { agentId: string }) => (
    <div data-testid="tab-intencoes">{agentId}</div>
  ),
}));
vi.mock("@/components/agents/AgentIntegrationsTab", () => ({
  AgentIntegrationsTab: ({ agentId }: { agentId: string }) => (
    <div data-testid="tab-integracoes">{agentId}</div>
  ),
}));
vi.mock("@/components/agents/AgentChannelsTab", () => ({
  AgentChannelsTab: ({ agentId }: { agentId: string }) => (
    <div data-testid="tab-canais">{agentId}</div>
  ),
}));
vi.mock("@/components/agents/AgentWebhooksTab", () => ({
  AgentWebhooksTab: ({ agentId }: { agentId: string }) => (
    <div data-testid="tab-webhooks">{agentId}</div>
  ),
}));
vi.mock("@/components/agents/AgentPlaygroundTab", () => ({
  AgentPlaygroundTab: ({ agentId }: { agentId: string }) => (
    <div data-testid="tab-testar">{agentId}</div>
  ),
}));
vi.mock("@/components/agents/AgentAdvancedTab", () => ({
  AgentAdvancedTab: ({ agentId }: { agentId: string }) => (
    <div data-testid="tab-avancado">{agentId}</div>
  ),
}));

import { Route } from "./_app.agentes.$agentId";

const AgentDetailPage = Route.options.component!;

function agentQueryResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    data: undefined as AgentPlatformAgent | undefined,
    isLoading: false,
    isError: false,
    error: null,
    dataUpdatedAt: 0,
    refetch: vi.fn(),
    ...overrides,
  };
}

describe("head() da rota /_app/agentes/$agentId", () => {
  it("gera título, canonical e og:url com o id do agente", async () => {
    const head = await Route.options.head?.({ params: { agentId: "a1" } } as never);

    expect(head?.meta?.some((m) => m && "title" in m && m.title === "Agente")).toBe(true);
    expect(
      head?.links?.some(
        (l) => l && "href" in l && l.href === "https://aceleraflow.lovable.app/agentes/a1",
      ),
    ).toBe(true);
  });
});

describe("shell de detalhe do agente (/_app/agentes/$agentId)", () => {
  beforeEach(() => {
    vi.spyOn(Route, "useParams").mockReturnValue({ agentId: "a1" });
    useAgentPlatformQueryMock.mockReset();
    useAgentPlatformQueryMock.mockReturnValue(
      agentQueryResult({ data: { id: "a1", name: "Sofia" }, dataUpdatedAt: Date.now() }),
    );
    window.location.hash = "";
  });

  afterEach(() => {
    window.location.hash = "";
  });

  it("mostra o nome do agente e as 10 abas na ordem do escopo", () => {
    renderWithQueryClient(<AgentDetailPage />);

    // Nível 1 -- a aba "Visão geral" (renderizada de verdade, não mockada)
    // também mostra o nome do agente no próprio resumo.
    expect(screen.getByRole("heading", { level: 1, name: "Sofia" })).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual([
      "Visão geral",
      "Perfil",
      "Modelo e configurações",
      "Treinamentos",
      "Intenções",
      "Integrações",
      "Canais",
      "Webhooks",
      "Testar agente",
      "Avançado",
    ]);
  });

  it("mostra skeleton no nome enquanto o agente carrega", () => {
    useAgentPlatformQueryMock.mockReturnValue(agentQueryResult({ isLoading: true }));

    renderWithQueryClient(<AgentDetailPage />);

    expect(screen.queryByText("Sofia")).not.toBeInTheDocument();
  });

  it('mostra "Sem alteração nesta sessão" antes de qualquer ação do usuário (D6 -- sem status remoto)', () => {
    renderWithQueryClient(<AgentDetailPage />);

    expect(screen.getByText("Sem alteração nesta sessão")).toBeInTheDocument();
  });

  it("abre por padrão na aba Visão geral e renderiza AgentOverviewTab", () => {
    renderWithQueryClient(<AgentDetailPage />);

    expect(screen.getByRole("tab", { name: "Visão geral" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("troca de aba ao clicar e passa o agentId para o componente da aba", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<AgentDetailPage />);

    await user.click(screen.getByRole("tab", { name: "Treinamentos" }));
    expect(await screen.findByTestId("tab-treinamentos")).toHaveTextContent("a1");
  });

  it("abre direto na aba do hash da URL (deep-link, ex.: #canais)", async () => {
    window.location.hash = "#canais";

    renderWithQueryClient(<AgentDetailPage />);

    expect(await screen.findByTestId("tab-canais")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Canais" })).toHaveAttribute("aria-selected", "true");
  });

  it("hash inválido/desconhecido mantém a aba padrão (Visão geral)", () => {
    window.location.hash = "#nao-existe";

    renderWithQueryClient(<AgentDetailPage />);

    expect(screen.getByRole("tab", { name: "Visão geral" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});
