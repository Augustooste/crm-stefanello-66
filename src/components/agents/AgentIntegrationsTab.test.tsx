import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";

import { useAgentPlatformMutation, useAgentPlatformQuery } from "@/lib/api/agent-platform";
import { renderWithQueryClient } from "@/test/render";
import { AgentIntegrationsTab } from "./AgentIntegrationsTab";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api/agent-platform", () => ({
  useAgentPlatformQuery: vi.fn(),
  useAgentPlatformMutation: vi.fn(),
}));

const AGENT_ID = "agent-1";

// Mensagem exigida verbatim para as quatro integrações nativas — copiada
// literalmente do componente, nunca reconstruída, para o teste não mascarar
// uma mudança acidental de texto.
const UNAVAILABLE_MESSAGE =
  "Configuração não disponibilizada pela API pública do provedor de agentes. Gerencie esta integração diretamente no provedor de agentes.";

type SuccessCallback = (data: unknown) => void;
type ErrorCallback = (error: Error) => void;

interface MutateCallOptions {
  onSuccess?: SuccessCallback;
  onError?: ErrorCallback;
  onSettled?: () => void;
}

interface MutationStub {
  mutate: ReturnType<typeof vi.fn>;
  isPending: boolean;
}

interface HookOptions {
  onSuccess?: SuccessCallback;
  onError?: ErrorCallback;
}

/**
 * `useAgentPlatformMutation` é chamado várias vezes na mesma árvore, uma vez por
 * ação (mcp.add, mcp.connect, mcp.delete, mcp.tools.sync, ...). O mock
 * precisa distinguir por ação: guarda um stub de `mutate` por ação (para
 * asserir com o que foi chamada) e as `options` de nível de hook passadas
 * pelo componente (para simular o `onSuccess`/`onError` que o React Query
 * chamaria de verdade após a mutação resolver).
 */
function mockMutations(initialStubs: Record<string, MutationStub> = {}) {
  const stubs = new Map<string, MutationStub>(Object.entries(initialStubs));
  const hookOptions = new Map<string, HookOptions>();

  function fakeUseAgentPlatformMutation(action: string, options?: HookOptions) {
    hookOptions.set(action, options ?? {});
    if (!stubs.has(action)) {
      // Sem stub customizado: simula sucesso imediato (dado `undefined`)
      // chamando o onSuccess de nível de hook E o onSuccess por chamada —
      // cobre as ações cujo componente não precisa do payload de resposta
      // (mcp.tools.sync/activate/deactivate, mcp.delete). Ações que
      // dependem do payload (mcp.add/mcp.connect) recebem stub customizado
      // via `mutationStub(impl)` em cada teste que exercita a resposta.
      stubs.set(action, {
        mutate: vi.fn((_vars: unknown, callOptions?: MutateCallOptions) => {
          hookOptions.get(action)?.onSuccess?.(undefined);
          callOptions?.onSuccess?.(undefined);
        }),
        isPending: false,
      });
    }
    return stubs.get(action);
  }

  vi.mocked(useAgentPlatformMutation).mockImplementation(
    fakeUseAgentPlatformMutation as unknown as typeof useAgentPlatformMutation,
  );

  return { stubs, hookOptions };
}

function mutationStub(
  impl?: (variables: unknown, options?: MutateCallOptions) => void,
): MutationStub {
  return { mutate: vi.fn(impl), isPending: false };
}

interface QueryStub {
  data?: unknown;
  isLoading: boolean;
  isError: boolean;
  error?: Error;
  refetch: ReturnType<typeof vi.fn>;
}

function queryStub(overrides: Partial<QueryStub> = {}): QueryStub {
  return { isLoading: false, isError: false, refetch: vi.fn(), ...overrides };
}

function mockQueries(byAction: Record<string, QueryStub>) {
  vi.mocked(useAgentPlatformQuery).mockImplementation(
    ((action: string) =>
      byAction[action] ?? queryStub()) as unknown as typeof useAgentPlatformQuery,
  );
}

describe("AgentIntegrationsTab", () => {
  describe("Integrações nativas do provedor de agentes", () => {
    it("mostra as quatro integrações nativas com o aviso de indisponibilidade e sem formulário de credencial", () => {
      mockMutations();
      mockQueries({});

      renderWithQueryClient(<AgentIntegrationsTab agentId={AGENT_ID} />);

      expect(screen.getByText("Integrações nativas do provedor de agentes")).toBeInTheDocument();

      const slugs = ["elevenlabs", "google-agenda", "plug-chat", "e-vendi"];
      const messages = screen.getAllByText(UNAVAILABLE_MESSAGE);
      expect(messages).toHaveLength(4);

      for (const slug of slugs) {
        const card = screen.getByTestId(`native-integration-${slug}`);
        // Nenhum input/textarea de credencial — só o aviso e o link para o painel oficial.
        expect(within(card).queryByRole("textbox")).not.toBeInTheDocument();
        expect(within(card).queryByRole("button")).not.toBeInTheDocument();
        expect(
          within(card).getByRole("link", { name: /Abrir painel do provedor de agentes/i }),
        ).toHaveAttribute("href", "https://app.agent-platform.ai");
      }
    });
  });

  describe("MCP — criar conexão", () => {
    it("cria uma conexão MCP com o corpo exigido pelo contrato (sem OAuth)", async () => {
      const addMutate = vi.fn((_vars: unknown, opts?: MutateCallOptions) => {
        opts?.onSuccess?.({ id: "mcp-123" });
      });
      mockMutations({ "mcp.add": mutationStub(addMutate) });
      mockQueries({ "mcp.tools.list": queryStub({ data: [] }) });
      const user = userEvent.setup({ delay: null });

      renderWithQueryClient(<AgentIntegrationsTab agentId={AGENT_ID} />);

      await user.type(screen.getByLabelText("Nome"), "Zapier");
      await user.type(screen.getByLabelText("Descrição"), "Conecta ferramentas externas");
      await user.type(screen.getByLabelText("URL de conexão MCP"), "https://mcp.example.com/sse");
      await user.click(screen.getByRole("button", { name: "Criar conexão" }));

      expect(addMutate).toHaveBeenCalledWith(
        {
          params: { agentId: AGENT_ID },
          body: {
            name: "Zapier",
            description: "Conecta ferramentas externas",
            mcpUrl: "https://mcp.example.com/sse",
            urlType: "SSE",
            authType: "NO_OAUTH",
          },
        },
        expect.anything(),
      );
      // Conexão criada sem exigir OAuth: foca direto nela (id vem da resposta).
      expect(await screen.findByText("mcp-123")).toBeInTheDocument();
      expect(toast.success).toHaveBeenCalledWith("Conexão MCP criada.");
    });

    it("mostra o passo de autorização OAuth quando a resposta traz `url` e conclui com mcp.connect", async () => {
      const addMutate = vi.fn((_vars: unknown, opts?: MutateCallOptions) => {
        opts?.onSuccess?.({ url: "https://provider.example.com/oauth/authorize" });
      });
      const connectMutate = vi.fn((_vars: unknown, opts?: MutateCallOptions) => {
        opts?.onSuccess?.({ mcpId: "mcp-999" });
      });
      mockMutations({
        "mcp.add": mutationStub(addMutate),
        "mcp.connect": mutationStub(connectMutate),
      });
      mockQueries({ "mcp.tools.list": queryStub({ data: [] }) });
      const user = userEvent.setup({ delay: null });

      renderWithQueryClient(<AgentIntegrationsTab agentId={AGENT_ID} />);

      await user.type(screen.getByLabelText("Nome"), "Cloudflare Observability");
      await user.type(screen.getByLabelText("Descrição"), "Integração com OAuth");
      await user.type(
        screen.getByLabelText("URL de conexão MCP"),
        "https://observability.mcp.cloudflare.com/sse",
      );
      await user.click(screen.getByRole("button", { name: "Criar conexão" }));

      const authLink = await screen.findByRole("link", { name: /Abrir URL de autorização/i });
      expect(authLink).toHaveAttribute("href", "https://provider.example.com/oauth/authorize");

      await user.type(screen.getByLabelText("code"), "codigo-abc");
      await user.type(screen.getByLabelText("state"), "estado-xyz");
      await user.click(screen.getByRole("button", { name: "Concluir autorização" }));

      expect(connectMutate).toHaveBeenCalledWith(
        { body: { code: "codigo-abc", state: "estado-xyz" } },
        expect.anything(),
      );
      expect(await screen.findByText("mcp-999")).toBeInTheDocument();
      expect(toast.success).toHaveBeenCalledWith("Conexão MCP autorizada.");
      // Timeout explícito: este é o caso mais pesado do arquivo (formulário de
      // conexão + passo OAuth + conclusão) e, sob a suíte inteira em paralelo, o
      // padrão de 5s estoura. Teste truncado por timeout não é abortado de fato:
      // as teclas em voo continuam disparando em `document.activeElement` e
      // vazam para o teste seguinte (foi exatamente o que aconteceu em
      // AgentIntentionsTab antes do mesmo remédio).
    }, 15_000);

    it("não afirma sucesso quando OAuth foi escolhido mas a resposta não trouxe `url`", async () => {
      const addMutate = vi.fn((_vars: unknown, opts?: MutateCallOptions) => {
        opts?.onSuccess?.({ id: "mcp-orphan" });
      });
      mockMutations({ "mcp.add": mutationStub(addMutate) });
      mockQueries({ "mcp.tools.list": queryStub({ data: [] }) });
      const user = userEvent.setup({ delay: null });

      renderWithQueryClient(<AgentIntegrationsTab agentId={AGENT_ID} />);

      await user.type(screen.getByLabelText("Nome"), "Provedor sem URL");
      await user.type(screen.getByLabelText("Descrição"), "Cenário de contrato incompleto");
      await user.type(screen.getByLabelText("URL de conexão MCP"), "https://mcp.example.com/sse");
      await user.click(screen.getByRole("combobox", { name: "Autenticação" }));
      await user.click(await screen.findByRole("option", { name: "OAuth" }));
      await user.click(screen.getByRole("button", { name: "Criar conexão" }));

      expect(addMutate).toHaveBeenCalledWith(
        expect.objectContaining({ body: expect.objectContaining({ authType: "OAUTH" }) }),
        expect.anything(),
      );
      // Sem `url` na resposta, o fluxo OAuth não pode terminar — nunca afirma sucesso.
      expect(toast.error).toHaveBeenCalledWith(
        "O provedor de agentes não devolveu a URL de autorização OAuth. Confira esta conexão diretamente no painel do provedor de agentes.",
      );
      expect(toast.success).not.toHaveBeenCalled();
      // O id órfão fica visível (para inspeção/exclusão), mas não há passo de OAuth nem "conectado".
      expect(await screen.findByText("mcp-orphan")).toBeInTheDocument();
      expect(
        screen.queryByRole("link", { name: /Abrir URL de autorização/i }),
      ).not.toBeInTheDocument();
    });
  });

  describe("MCP — ferramentas de uma conexão já em foco", () => {
    async function focusExistingConnection(user: ReturnType<typeof userEvent.setup>) {
      await user.type(
        screen.getByPlaceholderText("Identificador da conexão (mcpId)"),
        "mcp-existing",
      );
      await user.click(screen.getByRole("button", { name: "Gerenciar" }));
    }

    it("sincroniza, ativa e inativa ferramentas chamando as ações corretas", async () => {
      const { stubs } = mockMutations();
      mockQueries({
        "mcp.tools.list": queryStub({
          data: [
            { id: "tool-1", name: "Buscar clima", description: "Consulta previsão", active: false },
            { id: "tool-2", name: "Enviar e-mail", description: "Dispara e-mail", active: true },
          ],
        }),
      });
      const user = userEvent.setup({ delay: null });

      renderWithQueryClient(<AgentIntegrationsTab agentId={AGENT_ID} />);
      await focusExistingConnection(user);

      await user.click(screen.getByRole("button", { name: "Sincronizar" }));
      expect(stubs.get("mcp.tools.sync")?.mutate).toHaveBeenCalledWith({
        params: { agentId: AGENT_ID, mcpId: "mcp-existing" },
      });
      expect(toast.success).toHaveBeenCalledWith("Ferramentas sincronizadas.");

      await user.click(screen.getByLabelText("Ativar Buscar clima"));
      expect(stubs.get("mcp.tool.activate")?.mutate).toHaveBeenCalledWith(
        { params: { agentId: AGENT_ID, mcpId: "mcp-existing", toolId: "tool-1" } },
        expect.anything(),
      );
      expect(toast.success).toHaveBeenCalledWith("Ferramenta ativada.");

      await user.click(screen.getByLabelText("Inativar Enviar e-mail"));
      expect(stubs.get("mcp.tool.deactivate")?.mutate).toHaveBeenCalledWith(
        { params: { agentId: AGENT_ID, mcpId: "mcp-existing", toolId: "tool-2" } },
        expect.anything(),
      );
      expect(toast.success).toHaveBeenCalledWith("Ferramenta inativada.");
    });

    it("mostra erro com botão de tentar de novo quando a listagem de ferramentas falha", async () => {
      mockMutations();
      mockQueries({
        "mcp.tools.list": queryStub({ isError: true, error: new Error("Falha ao listar") }),
      });
      const user = userEvent.setup({ delay: null });

      renderWithQueryClient(<AgentIntegrationsTab agentId={AGENT_ID} />);
      await focusExistingConnection(user);

      expect(screen.getByText("Falha ao listar")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
    });
  });

  describe("MCP — excluir conexão", () => {
    it("exige confirmação por AlertDialog antes de excluir", async () => {
      // `mcp.delete` usa onSuccess/onError de nível de hook (não por
      // chamada) — o stub padrão (sem impl customizada) já simula sucesso
      // imediato chamando esse onSuccess.
      const { stubs } = mockMutations();
      mockQueries({ "mcp.tools.list": queryStub({ data: [] }) });
      const user = userEvent.setup({ delay: null });

      renderWithQueryClient(<AgentIntegrationsTab agentId={AGENT_ID} />);
      await user.type(
        screen.getByPlaceholderText("Identificador da conexão (mcpId)"),
        "mcp-existing",
      );
      await user.click(screen.getByRole("button", { name: "Gerenciar" }));

      await user.click(screen.getByRole("button", { name: /Excluir conexão/i }));
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Excluir" }));

      expect(stubs.get("mcp.delete")?.mutate).toHaveBeenCalledWith({
        params: { agentId: AGENT_ID, mcpId: "mcp-existing" },
      });
      expect(toast.success).toHaveBeenCalledWith("Conexão MCP excluída.");
      // Volta para a tela de criação/gerenciamento (conexão focada foi limpa).
      expect(screen.getByText("Conectar um novo MCP")).toBeInTheDocument();
    });
  });
});
