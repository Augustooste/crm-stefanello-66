import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";

import { AgentAdvancedTab } from "./AgentAdvancedTab";
import { createQueryWrapper } from "@/test/query-mocks";

type QueryConfig = {
  data?: unknown;
  isLoading?: boolean;
  error?: { message: string } | null;
};

type MutationOptions = {
  onSuccess?: (data: unknown, variables: unknown) => void;
  onError?: (error: { message: string }, variables: unknown) => void;
};

const queryConfigs: Record<string, QueryConfig> = {};
// Ver AgentAdvancedTab.test.tsx: o spy precisa ser memoizado por action (não
// recriado a cada render) para não perder a chamada real quando o onSuccess
// muda estado local e re-renderiza o componente.
const mutationSpies: Record<string, ReturnType<typeof vi.fn>> = {};
const mutationOptionsByAction: Record<string, MutationOptions> = {};
const refetchSpies: Record<string, ReturnType<typeof vi.fn>> = {};

function setQuery(action: string, config: QueryConfig) {
  queryConfigs[action] = config;
}

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/api/agent-platform", () => ({
  useAgentPlatformQuery: (action: string) => {
    const cfg = queryConfigs[action] ?? {};
    const refetch = vi.fn();
    refetchSpies[action] = refetch;
    return {
      data: cfg.data,
      isLoading: cfg.isLoading ?? false,
      error: cfg.error ?? null,
      refetch,
    };
  },
  useAgentPlatformMutation: (action: string, options?: MutationOptions) => {
    mutationOptionsByAction[action] = options ?? {};
    if (!mutationSpies[action]) {
      mutationSpies[action] = vi.fn((variables: unknown) => {
        const opts = mutationOptionsByAction[action];
        opts.onSuccess?.({}, variables);
      });
    }
    return { mutate: mutationSpies[action], isPending: false };
  },
  useAgentPlatformConnection: () => ({
    data: {
      status: "active",
      lastError: null,
      lastCheckAt: null,
      connectedAt: null,
      workspaceIdConfigured: true,
    },
  }),
}));

function renderTab() {
  return render(<AgentAdvancedTab agentId="agent-1" />, { wrapper: createQueryWrapper() });
}

describe("AgentAdvancedTab — regras de transferência", () => {
  afterEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(queryConfigs)) delete queryConfigs[key];
    for (const key of Object.keys(mutationSpies)) delete mutationSpies[key];
    for (const key of Object.keys(mutationOptionsByAction)) delete mutationOptionsByAction[key];
  });

  it("cria uma regra de transferência para humano", async () => {
    setQuery("customFields.list", { data: [] });
    setQuery("transferRules.list", { data: [] });
    setQuery("idleActions.get", { data: { actions: [], finishOn: { seconds: 0 } } });
    setQuery("agent.behaviorHistory.list", { data: [] });
    const user = userEvent.setup();

    renderTab();

    await screen.findByText("Sem regras de transferência");
    await user.click(screen.getByRole("button", { name: "Nova regra" }));
    await user.type(screen.getByLabelText("Instruções *"), "Transferir quando pedir atendente");
    await user.type(screen.getByLabelText("ID do usuário de destino"), "user-99");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() =>
      expect(mutationSpies["transferRules.create"]).toHaveBeenCalledWith({
        params: { agentId: "agent-1" },
        body: {
          instructions: "Transferir quando pedir atendente",
          returnOnFinish: false,
          type: "HUMAN",
          userId: "user-99",
          agentId: null,
        },
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Regra criada");
  });

  it("edita uma regra existente (transferRule.update com transferRuleId)", async () => {
    setQuery("customFields.list", { data: [] });
    setQuery("transferRules.list", {
      data: [
        {
          id: "rule-1",
          instructions: "Antiga",
          returnOnFinish: false,
          type: "HUMAN",
          userId: "user-1",
          agentId: null,
        },
      ],
    });
    setQuery("idleActions.get", { data: { actions: [], finishOn: { seconds: 0 } } });
    setQuery("agent.behaviorHistory.list", { data: [] });
    const user = userEvent.setup();

    renderTab();

    await screen.findByText("Antiga");
    await user.click(screen.getByRole("button", { name: "Editar" }));
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() =>
      expect(mutationSpies["transferRule.update"]).toHaveBeenCalledWith({
        params: { agentId: "agent-1", transferRuleId: "rule-1" },
        body: {
          instructions: "Antiga",
          returnOnFinish: false,
          type: "HUMAN",
          userId: "user-1",
          agentId: null,
        },
      }),
    );
  });

  it("exclui uma regra de transferência após confirmar no AlertDialog", async () => {
    setQuery("customFields.list", { data: [] });
    setQuery("transferRules.list", {
      data: [
        {
          id: "rule-1",
          instructions: "Antiga",
          returnOnFinish: false,
          type: "HUMAN",
          userId: "user-1",
          agentId: null,
        },
      ],
    });
    setQuery("idleActions.get", { data: { actions: [], finishOn: { seconds: 0 } } });
    setQuery("agent.behaviorHistory.list", { data: [] });
    const user = userEvent.setup();

    renderTab();

    await screen.findByText("Antiga");
    await user.click(screen.getByRole("button", { name: "Excluir regra" }));

    expect(await screen.findByText("Excluir regra de transferência")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Excluir" }));

    await waitFor(() =>
      expect(mutationSpies["transferRule.delete"]).toHaveBeenCalledWith({
        params: { agentId: "agent-1", transferRuleId: "rule-1" },
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Regra removida");
  });

  it("mostra erro do provedor no card de erro e permite tentar de novo", async () => {
    setQuery("customFields.list", { data: [] });
    setQuery("transferRules.list", {
      data: null,
      error: { message: "Sem permissão para ver regras" },
    });
    setQuery("idleActions.get", { data: { actions: [], finishOn: { seconds: 0 } } });
    setQuery("agent.behaviorHistory.list", { data: [] });

    renderTab();

    expect(await screen.findByText("Sem permissão para ver regras")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(refetchSpies["transferRules.list"]).toHaveBeenCalled();
  });
});
