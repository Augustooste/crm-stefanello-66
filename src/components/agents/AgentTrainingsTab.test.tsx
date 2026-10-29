// Cobre a aba "Treinamentos" do agente provedor de agentes: a listagem sempre manda
// `type` (divergência D2), a criação usa o corpo exato de cada variante do
// `oneOf`, edição só existe para TEXT, "substituir" só exclui+abre criação
// após confirmação explícita, exclusão pede confirmação e erro aparece em
// PT-BR.
//
// O mock fica na borda real (`supabase.functions.invoke`, o único ponto que
// `callAgentPlatform` toca) — os hooks `useAgentPlatformQuery`/`useAgentPlatformMutation`
// continuam de verdade, então as asserções batem no formato exato que sai
// para a edge function `agent-platform-proxy`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";

import { AgentTrainingsTab } from "./AgentTrainingsTab";

const invokeMock = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: {
      invoke: (...args: unknown[]) => invokeMock(...args),
    },
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const AGENT_ID = "agent-1";

interface ProxyRequestBody {
  action: string;
  params?: Record<string, unknown>;
  body?: Record<string, unknown>;
}

function renderTab() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentTrainingsTab agentId={AGENT_ID} />
    </QueryClientProvider>,
  );
}

interface MockSetup {
  trainingsByType?: Record<string, unknown[]>;
  failListWith?: { code: string; message?: string };
}

function setupMock({ trainingsByType = {}, failListWith }: MockSetup) {
  invokeMock.mockImplementation(async (_name: string, options: { body: ProxyRequestBody }) => {
    const { action, params } = options.body;
    if (action === "trainings.list") {
      if (failListWith) return { data: { error: failListWith }, error: null };
      const type = String(params?.type ?? "TEXT");
      return { data: { data: trainingsByType[type] ?? [] }, error: null };
    }
    if (
      action === "trainings.create" ||
      action === "training.update" ||
      action === "training.delete"
    ) {
      return { data: { data: { success: true } }, error: null };
    }
    throw new Error(`ação não mockada no teste: ${action}`);
  });
}

function expectInvoked(
  action: string,
  params?: Record<string, unknown>,
  body?: Record<string, unknown>,
) {
  return expect(invokeMock).toHaveBeenCalledWith("agent-platform-proxy", {
    body: { action, params: params ?? {}, body },
  });
}

async function selectOption(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  option: string,
) {
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

describe("AgentTrainingsTab", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
    setupMock({});
  });

  afterEach(() => vi.clearAllMocks());

  it("sempre manda o tipo ativo na listagem, inclusive ao trocar de sub-aba", async () => {
    const user = userEvent.setup();
    renderTab();

    await waitFor(() =>
      expectInvoked("trainings.list", { agentId: AGENT_ID, type: "TEXT", page: 1, pageSize: 20 }),
    );

    await user.click(screen.getByRole("tab", { name: "Site" }));

    await waitFor(() =>
      expectInvoked("trainings.list", {
        agentId: AGENT_ID,
        type: "WEBSITE",
        page: 1,
        pageSize: 20,
      }),
    );
  });

  it("cria treinamento de TEXTO com o corpo do contrato", async () => {
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Nenhum treinamento de texto");
    await user.click(screen.getByRole("button", { name: "Novo treinamento" }));
    await screen.findByText("Novo treinamento de texto");

    await user.type(screen.getByLabelText("Texto do treinamento"), "Política de trocas: 30 dias.");
    await user.click(screen.getByRole("button", { name: "Adicionar treinamento" }));

    await waitFor(() =>
      expectInvoked(
        "trainings.create",
        { agentId: AGENT_ID },
        { type: "TEXT", text: "Política de trocas: 30 dias.", image: undefined },
      ),
    );
    expect(toast.success).toHaveBeenCalled();
  });

  it("cria treinamento de SITE com o corpo do contrato (subpáginas e intervalo)", async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(screen.getByRole("tab", { name: "Site" }));
    await screen.findByText("Nenhum treinamento de site");
    await user.click(screen.getByRole("button", { name: "Novo treinamento" }));
    await screen.findByText("Novo treinamento de site");

    await user.type(screen.getByLabelText("Endereço do site"), "https://empresa.com.br");
    await selectOption(user, "Subpáginas", "Ativado");
    await selectOption(user, "Intervalo de atualização", "1 dia");
    await user.click(screen.getByRole("button", { name: "Adicionar treinamento" }));

    await waitFor(() =>
      expectInvoked(
        "trainings.create",
        { agentId: AGENT_ID },
        {
          type: "WEBSITE",
          website: "https://empresa.com.br",
          trainingSubPages: "ACTIVE",
          trainingInterval: "ONE_DAY",
        },
      ),
    );
  });

  it("cria treinamento de VÍDEO com o corpo do contrato", async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(screen.getByRole("tab", { name: "Vídeo" }));
    await screen.findByText("Nenhum treinamento de vídeo");
    await user.click(screen.getByRole("button", { name: "Novo treinamento" }));
    await screen.findByText("Novo treinamento de vídeo");

    await user.type(
      screen.getByLabelText("Link do vídeo"),
      "https://www.youtube.com/watch?v=abc123",
    );
    await user.click(screen.getByRole("button", { name: "Adicionar treinamento" }));

    await waitFor(() =>
      expectInvoked(
        "trainings.create",
        { agentId: AGENT_ID },
        { type: "VIDEO", video: "https://www.youtube.com/watch?v=abc123" },
      ),
    );
  });

  it("cria treinamento de DOCUMENTO com o corpo do contrato", async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(screen.getByRole("tab", { name: "Documento" }));
    await screen.findByText("Nenhum treinamento de documento");
    await user.click(screen.getByRole("button", { name: "Novo treinamento" }));
    await screen.findByText("Novo treinamento de documento");

    await user.type(screen.getByLabelText("URL do documento"), "https://cdn.com/manual.pdf");
    await user.type(screen.getByLabelText("Nome do documento"), "Manual.pdf");
    await user.type(screen.getByLabelText("Tipo MIME"), "application/pdf");
    await user.click(screen.getByRole("button", { name: "Adicionar treinamento" }));

    await waitFor(() =>
      expectInvoked(
        "trainings.create",
        { agentId: AGENT_ID },
        {
          type: "DOCUMENT",
          documentUrl: "https://cdn.com/manual.pdf",
          documentName: "Manual.pdf",
          documentMimetype: "application/pdf",
        },
      ),
    );
  });

  it("edita treinamento de TEXTO existente", async () => {
    const user = userEvent.setup();
    setupMock({
      trainingsByType: {
        TEXT: [{ id: "t1", type: "TEXT", text: "Texto original" }],
      },
    });
    renderTab();

    await screen.findByText("Texto original");
    await user.click(screen.getByRole("button", { name: "Editar" }));
    await screen.findByText("Editar treinamento de texto");

    const textarea = screen.getByLabelText("Texto do treinamento") as HTMLTextAreaElement;
    expect(textarea.value).toBe("Texto original");
    await user.clear(textarea);
    await user.type(textarea, "Texto atualizado");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() =>
      expectInvoked(
        "training.update",
        { agentId: AGENT_ID, trainingId: "t1" },
        { type: "TEXT", text: "Texto atualizado", image: undefined },
      ),
    );
  });

  it("substituir só exclui e abre a criação depois de confirmação explícita", async () => {
    const user = userEvent.setup();
    setupMock({
      trainingsByType: {
        WEBSITE: [
          {
            id: "w1",
            type: "WEBSITE",
            website: "https://antigo.com.br",
            trainingSubPages: "DISABLED",
            trainingInterval: "NEVER",
          },
        ],
      },
    });
    renderTab();

    await user.click(screen.getByRole("tab", { name: "Site" }));
    await screen.findByText("https://antigo.com.br");

    // Cancelar não deve excluir nem criar nada.
    await user.click(screen.getByRole("button", { name: "Substituir" }));
    await screen.findByText("Substituir treinamento de site");
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(invokeMock).not.toHaveBeenCalledWith(
      "agent-platform-proxy",
      expect.objectContaining({ body: expect.objectContaining({ action: "training.delete" }) }),
    );

    // Confirmar exclui e SÓ ENTÃO abre o formulário de criação (sem auto-criar).
    await user.click(screen.getByRole("button", { name: "Substituir" }));
    await screen.findByText("Substituir treinamento de site");
    await user.click(screen.getByRole("button", { name: "Excluir e cadastrar novo" }));

    await waitFor(() => expectInvoked("training.delete", { agentId: AGENT_ID, trainingId: "w1" }));
    await screen.findByText("Novo treinamento de site");
    expect(invokeMock).not.toHaveBeenCalledWith(
      "agent-platform-proxy",
      expect.objectContaining({ body: expect.objectContaining({ action: "trainings.create" }) }),
    );
  });

  it("exclusão pede confirmação antes de chamar training.delete", async () => {
    const user = userEvent.setup();
    setupMock({
      trainingsByType: {
        TEXT: [{ id: "t1", type: "TEXT", text: "Texto a excluir" }],
      },
    });
    renderTab();

    await screen.findByText("Texto a excluir");

    // Cancelar não deve chamar o delete.
    await user.click(screen.getByRole("button", { name: "Excluir" }));
    let dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    expect(invokeMock).not.toHaveBeenCalledWith(
      "agent-platform-proxy",
      expect.objectContaining({ body: expect.objectContaining({ action: "training.delete" }) }),
    );

    // Confirmar chama o delete com agentId + trainingId.
    await user.click(screen.getByRole("button", { name: "Excluir" }));
    dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Excluir" }));

    await waitFor(() => expectInvoked("training.delete", { agentId: AGENT_ID, trainingId: "t1" }));
  });

  it("mostra erro de listagem em PT-BR com opção de tentar de novo", async () => {
    setupMock({ failListWith: { code: "NOT_FOUND" } });
    renderTab();

    await screen.findByText("Não foi possível carregar os treinamentos");
    expect(screen.getByText("Recurso não encontrado no provedor de agentes.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
  });
});
