import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";

import { navigateMock, routerOverrides } from "@/test/router-mocks";
import type { AgentPlatformAgent } from "@/lib/api/agent-platform-contract";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, ...routerOverrides() };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const useAgentPlatformQueryMock = vi.fn();
const useAgentPlatformMutationMock = vi.fn();

vi.mock("@/lib/api/agent-platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/agent-platform")>();
  return {
    ...actual,
    useAgentPlatformQuery: (...args: unknown[]) => useAgentPlatformQueryMock(...args),
    useAgentPlatformMutation: (...args: unknown[]) => useAgentPlatformMutationMock(...args),
  };
});

import { AgentOverviewTab, AgentSessionStatusProvider } from "./AgentOverviewTab";
import { useAgentSessionStatus } from "./agent-session-status";

const AGENT: AgentPlatformAgent = {
  id: "a1",
  name: "Sofia",
  behavior: "Atenciosa",
  avatar: undefined,
  communicationType: "FORMAL",
  type: "SALE",
  jobName: "Acelera IA",
  jobSite: "https://acelera.ia",
  jobDescription: "Vende cursos",
};

function makeQueryResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    dataUpdatedAt: 0,
    refetch: vi.fn(),
    ...overrides,
  };
}

function makeMutationResult(overrides: Partial<Record<string, unknown>> = {}) {
  return { mutate: vi.fn(), isPending: false, ...overrides };
}

function mockQueries({
  agent = makeQueryResult({ data: AGENT, dataUpdatedAt: Date.now() }),
  credits = makeQueryResult({ data: { total: 42, data: [] } }),
}: {
  agent?: ReturnType<typeof makeQueryResult>;
  credits?: ReturnType<typeof makeQueryResult>;
} = {}) {
  useAgentPlatformQueryMock.mockImplementation((action: string) => {
    if (action === "agent.get") return agent;
    if (action === "agent.creditsSpent") return credits;
    throw new Error(`ação não mockada: ${action}`);
  });
}

let activateMock: ReturnType<typeof makeMutationResult>;
let deactivateMock: ReturnType<typeof makeMutationResult>;
let deleteMock: ReturnType<typeof makeMutationResult>;

function mockMutations() {
  activateMock = makeMutationResult();
  deactivateMock = makeMutationResult();
  deleteMock = makeMutationResult();
  useAgentPlatformMutationMock.mockImplementation(
    (action: string, options: { onSuccess?: (data: unknown) => void }) => {
      if (action === "agent.activate") {
        activateMock.mutate.mockImplementation(() => options.onSuccess?.({ success: true }));
        return activateMock;
      }
      if (action === "agent.deactivate") {
        deactivateMock.mutate.mockImplementation(() => options.onSuccess?.({ success: true }));
        return deactivateMock;
      }
      if (action === "agent.delete") {
        deleteMock.mutate.mockImplementation(() => options.onSuccess?.({ success: true }));
        return deleteMock;
      }
      throw new Error(`mutação não mockada: ${action}`);
    },
  );
}

describe("AgentOverviewTab", () => {
  beforeEach(() => {
    useAgentPlatformQueryMock.mockReset();
    useAgentPlatformMutationMock.mockReset();
    navigateMock.mockReset();
    mockMutations();
  });

  it("mostra skeleton enquanto o agente carrega", () => {
    mockQueries({ agent: makeQueryResult({ isLoading: true }) });

    render(<AgentOverviewTab agentId="a1" />);

    expect(screen.queryByText("Resumo do agente")).not.toBeInTheDocument();
  });

  it("mostra erro e permite tentar de novo", async () => {
    const refetch = vi.fn();
    mockQueries({
      agent: makeQueryResult({ isError: true, error: { message: "Falha remota" }, refetch }),
    });

    render(<AgentOverviewTab agentId="a1" />);
    const user = userEvent.setup();

    expect(screen.getByText("Erro ao carregar o agente")).toBeInTheDocument();
    expect(screen.getByText("Falha remota")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(refetch).toHaveBeenCalled();
  });

  it("exibe nome, objetivo, tipo de comunicação e empresa/produto em PT-BR", () => {
    mockQueries();

    render(<AgentOverviewTab agentId="a1" />);

    expect(screen.getByText("Sofia")).toBeInTheDocument();
    expect(screen.getByText("Vendas")).toBeInTheDocument();
    expect(screen.getByText("Formal")).toBeInTheDocument();
    expect(screen.getByText("Acelera IA")).toBeInTheDocument();
  });

  it('exibe "—" quando campos do agente estão ausentes', () => {
    mockQueries({
      agent: makeQueryResult({
        data: { id: "a1", name: undefined, type: undefined, communicationType: undefined },
        dataUpdatedAt: Date.now(),
      }),
    });

    render(<AgentOverviewTab agentId="a1" />);

    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("mostra o total de créditos gastos", () => {
    mockQueries();

    render(<AgentOverviewTab agentId="a1" />);

    expect(screen.getByText(/42 créditos gastos/)).toBeInTheDocument();
  });

  it("mostra a última carga quando há timestamp de leitura", () => {
    mockQueries();

    render(<AgentOverviewTab agentId="a1" />);

    expect(screen.getByText(/Última carga:/)).toBeInTheDocument();
  });

  it("ativa o agente e sinaliza o estado da sessão para o header (via Context)", async () => {
    mockQueries();
    const user = userEvent.setup();

    render(
      <AgentSessionStatusProvider>
        <StatusProbe />
        <AgentOverviewTab agentId="a1" />
      </AgentSessionStatusProvider>,
    );

    expect(screen.getByTestId("status-probe")).toHaveTextContent("nenhum");
    await user.click(screen.getByRole("button", { name: "Ativar" }));

    expect(activateMock.mutate).toHaveBeenCalledWith({ params: { agentId: "a1" } });
    await waitFor(() => expect(screen.getByTestId("status-probe")).toHaveTextContent("active"));
    expect(toast.success).toHaveBeenCalledWith("Agente ativado.");
  });

  it("inativa o agente e sinaliza o estado da sessão", async () => {
    mockQueries();
    const user = userEvent.setup();

    render(
      <AgentSessionStatusProvider>
        <StatusProbe />
        <AgentOverviewTab agentId="a1" />
      </AgentSessionStatusProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Inativar" }));

    expect(deactivateMock.mutate).toHaveBeenCalledWith({ params: { agentId: "a1" } });
    await waitFor(() => expect(screen.getByTestId("status-probe")).toHaveTextContent("inactive"));
    expect(toast.success).toHaveBeenCalledWith("Agente inativado.");
  });

  it("exige confirmação por AlertDialog antes de excluir e navega para /agentes ao concluir", async () => {
    mockQueries();
    const user = userEvent.setup();

    render(<AgentOverviewTab agentId="a1" />);

    await user.click(screen.getByRole("button", { name: "Excluir agente" }));
    expect(screen.getByRole("heading", { name: "Excluir agente" })).toBeInTheDocument();
    expect(deleteMock.mutate).not.toHaveBeenCalled();

    // `name` como RegExp ancorada: `exact` não é opção de ByRole (só de ByText),
    // e "Excluir" casaria também com "Excluir agente" do gatilho.
    await user.click(screen.getByRole("button", { name: /^Excluir$/ }));
    expect(deleteMock.mutate).toHaveBeenCalledWith({ params: { agentId: "a1" } });
    expect(navigateMock).toHaveBeenCalledWith({ to: "/agentes" });
    expect(toast.success).toHaveBeenCalledWith("Agente excluído.");
  });
});

function StatusProbe() {
  const status = useAgentSessionStatus();
  return <div data-testid="status-probe">{status ?? "nenhum"}</div>;
}
