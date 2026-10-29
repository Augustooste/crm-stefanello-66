import { act } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { routerOverrides } from "@/test/router-mocks";
import type { AgentPlatformAgent } from "@/lib/api/agent-platform-contract";
import type { AgentPlatformConnection } from "@/lib/api/agent-platform";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, ...routerOverrides() };
});

const useAgentPlatformConnectionMock = vi.fn();
const useAgentPlatformQueryMock = vi.fn();
vi.mock("@/lib/api/agent-platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/agent-platform")>();
  return {
    ...actual,
    useAgentPlatformConnection: () => useAgentPlatformConnectionMock(),
    useAgentPlatformQuery: (...args: unknown[]) => useAgentPlatformQueryMock(...args),
  };
});

vi.mock("@/components/agents/AgentCreateWizard", () => ({
  AgentCreateWizard: ({ open }: { open: boolean }) => (
    <div data-testid="agent-create-wizard">{open ? "aberto" : "fechado"}</div>
  ),
}));

import { Route } from "./_app.agentes.index";

const AgentesPage = Route.options.component!;

function connectionResult(overrides: Partial<AgentPlatformConnection> | null): {
  data: AgentPlatformConnection | null | undefined;
  isPending: boolean;
} {
  if (overrides === null) return { data: null, isPending: false };
  return {
    data: {
      status: "active",
      lastError: null,
      lastCheckAt: null,
      connectedAt: null,
      workspaceIdConfigured: true,
      ...overrides,
    },
    isPending: false,
  };
}

function agentsQueryResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    data: [] as AgentPlatformAgent[],
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    ...overrides,
  };
}

const AGENT_A: AgentPlatformAgent = {
  id: "a1",
  name: "Sofia",
  behavior: "Atenciosa",
  communicationType: "FORMAL",
  type: "SALE",
  jobName: "Acelera IA",
  jobSite: "https://acelera.ia",
  jobDescription: "Vende cursos",
};

describe("head() da rota /_app/agentes/ (índice)", () => {
  it("gera título e descrição da SEO", async () => {
    const head = await Route.options.head?.({} as never);
    expect(head?.meta?.some((m) => m && "title" in m && m.title === "Agentes de IA")).toBe(true);
  });
});

describe("página de agentes (/_app/agentes/)", () => {
  beforeEach(() => {
    useAgentPlatformConnectionMock.mockReset();
    useAgentPlatformQueryMock.mockReset();
  });

  it("mostra skeleton enquanto a conexão do provedor de agentes carrega", () => {
    useAgentPlatformConnectionMock.mockReturnValue({ data: undefined, isPending: true });

    render(<AgentesPage />);

    expect(screen.getByText("Agentes de IA")).toBeInTheDocument();
    expect(screen.queryByText("provedor de agentes não conectado")).not.toBeInTheDocument();
  });

  it("mostra estado de não conectado quando não há integração configurada", () => {
    useAgentPlatformConnectionMock.mockReturnValue(connectionResult(null));

    render(<AgentesPage />);

    expect(screen.getByText("provedor de agentes não conectado")).toBeInTheDocument();
  });

  it('mostra estado de não conectado quando o status não é "active"', () => {
    useAgentPlatformConnectionMock.mockReturnValue(connectionResult({ status: "pending" }));

    render(<AgentesPage />);

    expect(screen.getByText("provedor de agentes não conectado")).toBeInTheDocument();
  });

  describe("com conexão ativa", () => {
    beforeEach(() => {
      useAgentPlatformConnectionMock.mockReturnValue(connectionResult({ status: "active" }));
    });

    it("mostra skeleton enquanto os agentes carregam", () => {
      useAgentPlatformQueryMock.mockReturnValue(agentsQueryResult({ isLoading: true }));

      render(<AgentesPage />);

      expect(screen.queryByRole("list")).not.toBeInTheDocument();
    });

    it("mostra erro e permite tentar de novo", async () => {
      const refetch = vi.fn();
      useAgentPlatformQueryMock.mockReturnValue(
        agentsQueryResult({ isError: true, error: { message: "Falha remota" }, refetch }),
      );
      const user = userEvent.setup();

      render(<AgentesPage />);

      expect(screen.getByText("Erro ao carregar agentes")).toBeInTheDocument();
      expect(screen.getByText("Falha remota")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Tentar de novo" }));
      expect(refetch).toHaveBeenCalled();
    });

    it('mostra "Nenhum agente ainda" e abre o wizard de criação', async () => {
      useAgentPlatformQueryMock.mockReturnValue(agentsQueryResult({ data: [] }));
      const user = userEvent.setup();

      render(<AgentesPage />);

      expect(screen.getByText("Nenhum agente ainda")).toBeInTheDocument();
      expect(screen.getByTestId("agent-create-wizard")).toHaveTextContent("fechado");

      // Duas ações levam ao mesmo wizard aqui: o botão do cabeçalho e o da
      // EmptyState (lista vazia) -- ambas com o mesmo texto "Criar agente".
      const [firstCreateButton] = screen.getAllByRole("button", { name: "Criar agente" });
      await user.click(firstCreateButton);
      expect(screen.getByTestId("agent-create-wizard")).toHaveTextContent("aberto");
    });

    it("lista os agentes com nome, objetivo, tipo de comunicação e empresa", () => {
      useAgentPlatformQueryMock.mockReturnValue(agentsQueryResult({ data: [AGENT_A] }));

      render(<AgentesPage />);

      expect(screen.getByText("Sofia")).toBeInTheDocument();
      expect(screen.getByText(/Objetivo: Venda/)).toBeInTheDocument();
      expect(screen.getByText(/Comunicação: Formal/)).toBeInTheDocument();
      expect(screen.getByText(/Empresa: Acelera IA/)).toBeInTheDocument();
      expect(screen.getByText("Sofia").closest("a")).toHaveAttribute("href", "/agentes/a1");
    });

    it("ignora agentes sem id retornados pelo contrato (nunca linka pra rota inválida)", () => {
      useAgentPlatformQueryMock.mockReturnValue(
        agentsQueryResult({ data: [{ ...AGENT_A, id: undefined }] }),
      );

      render(<AgentesPage />);

      expect(screen.getByText("Nenhum agente ainda")).toBeInTheDocument();
    });

    it("botão Sincronizar chama o refetch da lista", async () => {
      const refetch = vi.fn();
      useAgentPlatformQueryMock.mockReturnValue(agentsQueryResult({ data: [AGENT_A], refetch }));
      const user = userEvent.setup();

      render(<AgentesPage />);

      await user.click(screen.getByRole("button", { name: "Sincronizar" }));
      expect(refetch).toHaveBeenCalled();
    });

    it('desabilita "Próxima" quando a página veio incompleta', () => {
      useAgentPlatformQueryMock.mockReturnValue(agentsQueryResult({ data: [AGENT_A] }));

      render(<AgentesPage />);

      expect(screen.getByRole("button", { name: "Próxima" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Anterior" })).toBeDisabled();
    });

    it('habilita "Próxima" quando a página veio cheia e avança para a página 2', async () => {
      const fullPage = Array.from({ length: 25 }, (_, i) => ({ ...AGENT_A, id: `a${i}` }));
      useAgentPlatformQueryMock.mockReturnValue(agentsQueryResult({ data: fullPage }));
      const user = userEvent.setup();

      render(<AgentesPage />);

      const nextButton = screen.getByRole("button", { name: "Próxima" });
      expect(nextButton).toBeEnabled();
      await user.click(nextButton);

      const lastCall = useAgentPlatformQueryMock.mock.calls.at(-1) as [
        string,
        { params: { page: number } },
      ];
      expect(lastCall[1].params.page).toBe(2);
    });

    // Regressão do flake que só aparecia no CI (runner de 32 cores): o timer do
    // debounce agendado no mount continuava pendente e, 300 ms depois do clique,
    // chamava `setPage(1)`. O teste acima só pega isso quando o clique demora
    // mais que o debounce; este pega sempre, com timer falso.
    it("mantém a página 2 quando o debounce agendado no mount dispara depois do clique", () => {
      vi.useFakeTimers();
      const fullPage = Array.from({ length: 25 }, (_, i) => ({ ...AGENT_A, id: `a${i}` }));
      useAgentPlatformQueryMock.mockReturnValue(agentsQueryResult({ data: fullPage }));

      render(<AgentesPage />);
      fireEvent.click(screen.getByRole("button", { name: "Próxima" }));

      act(() => {
        vi.advanceTimersByTime(1_000); // bem além dos 300 ms do debounce
      });

      const lastCall = useAgentPlatformQueryMock.mock.calls.at(-1) as [
        string,
        { params: { page: number } },
      ];
      expect(lastCall[1].params.page).toBe(2);

      vi.useRealTimers();
    });

    it("comita a busca após o debounce e reinicia a paginação", () => {
      vi.useFakeTimers();
      useAgentPlatformQueryMock.mockReturnValue(agentsQueryResult({ data: [AGENT_A] }));

      render(<AgentesPage />);
      fireEvent.change(screen.getByLabelText("Buscar agente pelo nome"), {
        target: { value: "sofia" },
      });

      act(() => {
        vi.advanceTimersByTime(300);
      });

      const lastCall = useAgentPlatformQueryMock.mock.calls.at(-1) as [
        string,
        { params: { query?: string; page: number } },
      ];
      expect(lastCall[1].params.query).toBe("sofia");
      expect(lastCall[1].params.page).toBe(1);

      vi.useRealTimers();
    });
  });
});
