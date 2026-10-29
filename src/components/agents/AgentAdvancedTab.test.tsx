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
// `mutate` precisa ser o MESMO objeto em toda a vida do teste: um onSuccess
// que muda estado local (ex.: fecha dialog / limpa seleção) re-renderiza o
// componente e recria a mutation — se o spy fosse recriado a cada render, a
// chamada real ficaria presa numa referência descartada e o teste veria "0
// chamadas" mesmo com a mutation tendo disparado. Por isso memoizamos o spy
// por action e só atualizamos as `options` (para pegar o onSuccess/onError
// mais recente) a cada render.
const mutationSpies: Record<string, ReturnType<typeof vi.fn>> = {};
const mutationOptionsByAction: Record<string, MutationOptions> = {};
const mutationOutcomes: Record<string, "success" | "error"> = {};
const mutationErrors: Record<string, { message: string }> = {};

function setQuery(action: string, config: QueryConfig) {
  queryConfigs[action] = config;
}

function setMutationOutcome(action: string, outcome: "success" | "error", message?: string) {
  mutationOutcomes[action] = outcome;
  if (message) mutationErrors[action] = { message };
}

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/api/agent-platform", () => ({
  useAgentPlatformQuery: (action: string) => {
    const cfg = queryConfigs[action] ?? {};
    return {
      data: cfg.data,
      isLoading: cfg.isLoading ?? false,
      error: cfg.error ?? null,
      refetch: vi.fn(),
    };
  },
  useAgentPlatformMutation: (action: string, options?: MutationOptions) => {
    mutationOptionsByAction[action] = options ?? {};
    if (!mutationSpies[action]) {
      mutationSpies[action] = vi.fn((variables: unknown) => {
        const outcome = mutationOutcomes[action] ?? "success";
        const opts = mutationOptionsByAction[action];
        if (outcome === "success") opts.onSuccess?.({}, variables);
        else opts.onError?.(mutationErrors[action] ?? { message: "Erro" }, variables);
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

describe("AgentAdvancedTab", () => {
  afterEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(queryConfigs)) delete queryConfigs[key];
    for (const key of Object.keys(mutationOutcomes)) delete mutationOutcomes[key];
    for (const key of Object.keys(mutationErrors)) delete mutationErrors[key];
    for (const key of Object.keys(mutationSpies)) delete mutationSpies[key];
    for (const key of Object.keys(mutationOptionsByAction)) delete mutationOptionsByAction[key];
  });

  it("abre todas as seções por padrão (accordion multiple) para as queries dispararem sem clique", () => {
    setQuery("customFields.list", { data: [] });
    setQuery("transferRules.list", { data: [] });
    setQuery("idleActions.get", { data: { actions: [], finishOn: { seconds: 0 } } });
    setQuery("agent.behaviorHistory.list", { data: [] });

    renderTab();

    expect(screen.getByText("Campos customizados")).toBeInTheDocument();
    expect(screen.getByText("Regras de transferência")).toBeInTheDocument();
    expect(screen.getByText("Ações de inatividade")).toBeInTheDocument();
    expect(screen.getByText("Histórico de comportamento")).toBeInTheDocument();
    // conteúdo (não só o gatilho) já está no DOM sem precisar clicar
    expect(screen.getByText("Sem campos customizados")).toBeInTheDocument();
    expect(screen.getByText("Sem regras de transferência")).toBeInTheDocument();
  });

  it("mostra informações técnicas: agentId e workspace configurado", () => {
    setQuery("customFields.list", { data: [] });
    setQuery("transferRules.list", { data: [] });
    setQuery("idleActions.get", { data: { actions: [], finishOn: { seconds: 0 } } });
    setQuery("agent.behaviorHistory.list", { data: [] });

    renderTab();

    expect(screen.getByText("agent-1")).toBeInTheDocument();
    expect(screen.getByText("Sim")).toBeInTheDocument();
    expect(screen.getByText("Ativo")).toBeInTheDocument();
  });

  describe("campos customizados", () => {
    it("lista campos vindos como array (formato defensivo)", async () => {
      setQuery("customFields.list", {
        data: [
          {
            id: "cf1",
            name: "Nome do cliente",
            jsonName: "nome_cliente",
            type: "STRING",
            archived: false,
          },
        ],
      });
      setQuery("transferRules.list", { data: [] });
      setQuery("idleActions.get", { data: { actions: [], finishOn: { seconds: 0 } } });
      setQuery("agent.behaviorHistory.list", { data: [] });

      renderTab();

      expect(await screen.findByText("Nome do cliente")).toBeInTheDocument();
    });

    it("ACHADO: normaliza resposta de objeto único (contrato documenta customFields.list sem array)", async () => {
      setQuery("customFields.list", {
        data: {
          id: "cf1",
          name: "Campo único",
          jsonName: "campo_unico",
          type: "NUMBER",
          archived: false,
        },
      });
      setQuery("transferRules.list", { data: [] });
      setQuery("idleActions.get", { data: { actions: [], finishOn: { seconds: 0 } } });
      setQuery("agent.behaviorHistory.list", { data: [] });

      renderTab();

      expect(await screen.findByText("Campo único")).toBeInTheDocument();
    });

    it("esconde campos arquivados por padrão e mostra ao ligar o switch", async () => {
      setQuery("customFields.list", {
        data: [
          {
            id: "cf1",
            name: "Campo visível",
            jsonName: "visivel",
            type: "STRING",
            archived: false,
          },
          {
            id: "cf2",
            name: "Campo arquivado",
            jsonName: "arquivado",
            type: "STRING",
            archived: true,
          },
        ],
      });
      setQuery("transferRules.list", { data: [] });
      setQuery("idleActions.get", { data: { actions: [], finishOn: { seconds: 0 } } });
      setQuery("agent.behaviorHistory.list", { data: [] });
      const user = userEvent.setup();

      renderTab();

      await screen.findByText("Campo visível");
      expect(screen.queryByText("Campo arquivado", { exact: false })).not.toBeInTheDocument();

      await user.click(screen.getByRole("switch"));
      expect(await screen.findByText("Campo arquivado", { exact: false })).toBeInTheDocument();
    });

    it("cria um campo customizado com name/jsonName/description/type", async () => {
      setQuery("customFields.list", { data: [] });
      setQuery("transferRules.list", { data: [] });
      setQuery("idleActions.get", { data: { actions: [], finishOn: { seconds: 0 } } });
      setQuery("agent.behaviorHistory.list", { data: [] });
      const user = userEvent.setup();

      renderTab();

      await screen.findByText("Sem campos customizados");
      await user.click(screen.getByRole("button", { name: "Novo campo" }));
      await user.type(screen.getByLabelText("Nome *"), "Data de nascimento");
      await user.type(screen.getByLabelText("jsonName *"), "data_nascimento");
      await user.click(screen.getByRole("button", { name: "Salvar" }));

      await waitFor(() =>
        expect(mutationSpies["customFields.create"]).toHaveBeenCalledWith({
          body: {
            name: "Data de nascimento",
            jsonName: "data_nascimento",
            description: "",
            type: "STRING",
          },
        }),
      );
      expect(toast.success).toHaveBeenCalledWith("Campo criado");
    });

    it("mostra o erro do provedor (PT-BR) quando criar o campo falha, sem fechar o dialog", async () => {
      setMutationOutcome("customFields.create", "error", "Já existe um campo com este jsonName");
      setQuery("customFields.list", { data: [] });
      setQuery("transferRules.list", { data: [] });
      setQuery("idleActions.get", { data: { actions: [], finishOn: { seconds: 0 } } });
      setQuery("agent.behaviorHistory.list", { data: [] });
      const user = userEvent.setup();

      renderTab();

      await screen.findByText("Sem campos customizados");
      await user.click(screen.getByRole("button", { name: "Novo campo" }));
      await user.type(screen.getByLabelText("Nome *"), "Duplicado");
      await user.type(screen.getByLabelText("jsonName *"), "duplicado");
      await user.click(screen.getByRole("button", { name: "Salvar" }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith("Já existe um campo com este jsonName"),
      );
      // erro não mascara: dialog continua aberto para o usuário corrigir e tentar de novo
      expect(screen.getByRole("button", { name: "Salvar" })).toBeInTheDocument();
    });

    it("edita um campo customizado existente (customField.update com customfieldId)", async () => {
      setQuery("customFields.list", {
        data: [
          {
            id: "cf1",
            name: "Nome",
            jsonName: "nome",
            description: "",
            type: "STRING",
            archived: false,
          },
        ],
      });
      setQuery("transferRules.list", { data: [] });
      setQuery("idleActions.get", { data: { actions: [], finishOn: { seconds: 0 } } });
      setQuery("agent.behaviorHistory.list", { data: [] });
      const user = userEvent.setup();

      renderTab();

      await screen.findByText("Nome");
      await user.click(screen.getByRole("button", { name: "Editar" }));
      await user.click(screen.getByRole("button", { name: "Salvar" }));

      await waitFor(() =>
        expect(mutationSpies["customField.update"]).toHaveBeenCalledWith({
          params: { customfieldId: "cf1" },
          body: { name: "Nome", jsonName: "nome", description: "", type: "STRING" },
        }),
      );
    });

    it("arquiva um campo customizado (customField.toggleArchive)", async () => {
      setQuery("customFields.list", {
        data: [{ id: "cf1", name: "Nome", jsonName: "nome", type: "STRING", archived: false }],
      });
      setQuery("transferRules.list", { data: [] });
      setQuery("idleActions.get", { data: { actions: [], finishOn: { seconds: 0 } } });
      setQuery("agent.behaviorHistory.list", { data: [] });
      const user = userEvent.setup();

      renderTab();

      await screen.findByText("Nome");
      await user.click(screen.getByRole("button", { name: "Arquivar Nome" }));

      await waitFor(() =>
        expect(mutationSpies["customField.toggleArchive"]).toHaveBeenCalledWith({
          params: { customfieldId: "cf1", archived: true },
        }),
      );
    });
  });
});

// Testes de "regras de transferência" ficam em
// AgentAdvancedTab.transfer-rules.test.tsx — arquivo único ultrapassava
// 400 linhas.
