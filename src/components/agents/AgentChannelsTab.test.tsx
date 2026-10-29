// Cobre a aba "Canais" do agente provedor de agentes: listagem por workspace (com
// filtro `agentId` alternável), criação solta e já vinculada, vincular/
// desvincular via `channel.update`, exclusão com confirmação, QR Code parando
// de pollar ao conectar, cópia do embed do widget e erro em PT-BR.
//
// O mock fica na borda real (`supabase.functions.invoke`, o único ponto que
// `callAgentPlatform` toca) — os hooks `useAgentPlatformQuery`/`useAgentPlatformMutation`
// continuam de verdade, então as asserções batem no formato exato que sai
// para a edge function `agent-platform-proxy`.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";

import { AgentChannelsTab } from "./AgentChannelsTab";
import { qrRefetchInterval } from "./channel-qr-code-utils";

const invokeMock = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: {
      invoke: (...args: unknown[]) => invokeMock(...args),
    },
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const AGENT_ID = "agent-1";

interface ProxyRequestBody {
  action: string;
  params?: Record<string, unknown>;
  body?: Record<string, unknown>;
}

interface RawChannel {
  id: string;
  name: string;
  type: string;
  agentId: string | null;
  agentName: string | null;
  connected: boolean;
}

interface MockSetup {
  channels?: RawChannel[];
  failListWith?: { code: string; message?: string };
  qrResponse?: { value?: string } | { connected?: boolean };
  widgetLinks?: { float?: string; iframe?: string };
}

function setupMock({ channels = [], failListWith, qrResponse, widgetLinks }: MockSetup) {
  invokeMock.mockImplementation(async (_name: string, options: { body: ProxyRequestBody }) => {
    const { action } = options.body;
    if (action === "channels.list") {
      if (failListWith) return { data: { error: failListWith }, error: null };
      return { data: { data: { data: channels, count: channels.length } }, error: null };
    }
    if (
      action === "channels.create" ||
      action === "channels.createForAgent" ||
      action === "channel.update" ||
      action === "channel.delete" ||
      action === "channel.config.update" ||
      action === "channel.widgetSettings.update"
    ) {
      return { data: { data: { success: true } }, error: null };
    }
    if (action === "channel.config.get") {
      return {
        data: {
          data: { id: "cfg", tenant: "t", audioAction: null, startTrigger: null, endTrigger: null },
        },
        error: null,
      };
    }
    if (action === "channel.qrCode") {
      return { data: { data: qrResponse ?? { value: "abc123" } }, error: null };
    }
    if (action === "channel.widgetLinks") {
      return {
        data: { data: widgetLinks ?? { float: "FLOAT_EMBED", iframe: "IFRAME_EMBED" } },
        error: null,
      };
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

function renderTab() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentChannelsTab agentId={AGENT_ID} />
    </QueryClientProvider>,
  );
}

describe("AgentChannelsTab", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
    setupMock({});
  });

  afterEach(() => vi.clearAllMocks());

  it("lista os canais filtrando por este agente por padrão, e sem filtro em 'todos do workspace'", async () => {
    const user = userEvent.setup();
    setupMock({
      channels: [
        {
          id: "c1",
          name: "WhatsApp Principal",
          type: "WHATSAPP",
          agentId: AGENT_ID,
          agentName: "Ana",
          connected: true,
        },
      ],
    });
    renderTab();

    await screen.findByText("WhatsApp Principal");
    await waitFor(() =>
      expectInvoked("channels.list", { page: 1, pageSize: 25, agentId: AGENT_ID }),
    );

    await user.click(screen.getByRole("button", { name: "Todos do workspace" }));
    await waitFor(() => expectInvoked("channels.list", { page: 1, pageSize: 25 }));
  });

  it("cria canal solto do workspace (sem vincular a este agente)", async () => {
    const user = userEvent.setup();
    setupMock({ channels: [] });
    renderTab();

    await screen.findByText("Nenhum canal encontrado");
    await user.click(screen.getByRole("button", { name: "Novo canal" }));
    const dialog = await screen.findByRole("dialog");

    await user.type(within(dialog).getByLabelText("Nome *"), "Canal Solto");
    await user.click(within(dialog).getByRole("switch"));
    await user.click(within(dialog).getByRole("button", { name: "Criar canal" }));

    await waitFor(() =>
      expectInvoked("channels.create", {}, { name: "Canal Solto", type: "WHATSAPP" }),
    );
    expect(toast.success).toHaveBeenCalledWith("Canal criado.");
  });

  it("cria canal já vinculado a este agente", async () => {
    const user = userEvent.setup();
    setupMock({ channels: [] });
    renderTab();

    await screen.findByText("Nenhum canal encontrado");
    await user.click(screen.getByRole("button", { name: "Novo canal" }));
    const dialog = await screen.findByRole("dialog");

    // O switch "Vincular a este agente agora" já nasce ligado no modo criar.
    await user.type(within(dialog).getByLabelText("Nome *"), "Canal do Agente");
    await user.click(within(dialog).getByRole("button", { name: "Criar canal" }));

    await waitFor(() =>
      expectInvoked(
        "channels.createForAgent",
        { agentId: AGENT_ID, type: "WHATSAPP" },
        { name: "Canal do Agente" },
      ),
    );
    expect(toast.success).toHaveBeenCalledWith("Canal criado e vinculado a este agente.");
  });

  it("vincula um canal solto e desvincula um canal já vinculado a este agente", async () => {
    const user = userEvent.setup();
    setupMock({
      channels: [
        {
          id: "c-solto",
          name: "Solto",
          type: "WHATSAPP",
          agentId: null,
          agentName: null,
          connected: false,
        },
        {
          id: "c-vinc",
          name: "Vinculado",
          type: "WHATSAPP",
          agentId: AGENT_ID,
          agentName: "Ana",
          connected: true,
        },
      ],
    });
    renderTab();
    await screen.findByText("Solto");

    const soltoRow = screen.getByTestId("channel-row-c-solto");
    await user.click(within(soltoRow).getByRole("button", { name: "Vincular a este agente" }));
    await waitFor(() =>
      expectInvoked(
        "channel.update",
        { channelId: "c-solto" },
        { name: "Solto", agentId: AGENT_ID },
      ),
    );

    const vincRow = screen.getByTestId("channel-row-c-vinc");
    await user.click(within(vincRow).getByRole("button", { name: "Desvincular deste agente" }));
    await waitFor(() =>
      expectInvoked(
        "channel.update",
        { channelId: "c-vinc" },
        { name: "Vinculado", agentId: null },
      ),
    );
  });

  it("exclusão pede confirmação antes de chamar channel.delete", async () => {
    const user = userEvent.setup();
    setupMock({
      channels: [
        {
          id: "c1",
          name: "Canal X",
          type: "WHATSAPP",
          agentId: AGENT_ID,
          agentName: "Ana",
          connected: true,
        },
      ],
    });
    renderTab();
    await screen.findByText("Canal X");
    const row = screen.getByTestId("channel-row-c1");

    // Cancelar não deve excluir.
    await user.click(within(row).getByRole("button", { name: "Excluir" }));
    let dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    expect(invokeMock).not.toHaveBeenCalledWith(
      "agent-platform-proxy",
      expect.objectContaining({ body: expect.objectContaining({ action: "channel.delete" }) }),
    );

    // Confirmar chama o delete com o channelId certo.
    await user.click(within(row).getByRole("button", { name: "Excluir" }));
    dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Excluir" }));
    await waitFor(() => expectInvoked("channel.delete", { channelId: "c1" }));
  });

  it("QR Code mostra 'conectado' quando o canal já conectou", async () => {
    const user = userEvent.setup();
    setupMock({
      channels: [
        {
          id: "c1",
          name: "WhatsApp X",
          type: "WHATSAPP",
          agentId: AGENT_ID,
          agentName: "Ana",
          connected: false,
        },
      ],
      qrResponse: { connected: true },
    });
    renderTab();
    await screen.findByText("WhatsApp X");

    const row = screen.getByTestId("channel-row-c1");
    await user.click(within(row).getByRole("button", { name: "QR Code" }));
    await screen.findByText("Canal conectado.");
  });

  it("config: PUT só envia audioAction/startTrigger/endTrigger (D9), nunca id/tenant", async () => {
    const user = userEvent.setup();
    setupMock({
      channels: [
        {
          id: "c1",
          name: "Z-API Principal",
          type: "Z_API",
          agentId: AGENT_ID,
          agentName: "Ana",
          connected: true,
        },
      ],
    });
    renderTab();
    await screen.findByText("Z-API Principal");

    const row = screen.getByTestId("channel-row-c1");
    await user.click(within(row).getByRole("button", { name: "Configurar" }));
    const dialog = await screen.findByRole("dialog");

    await user.type(await within(dialog).findByLabelText("Ação de áudio"), "DISABLED");
    await user.type(
      within(dialog).getByLabelText("Gatilho de início"),
      "ONLY_WHEN_CALLING_BY_NAME",
    );
    await user.type(within(dialog).getByLabelText("Gatilho de encerramento"), "WHEN_SAY_GOODBYE");
    await user.click(within(dialog).getByRole("button", { name: "Salvar" }));

    await waitFor(() =>
      expectInvoked(
        "channel.config.update",
        { channelId: "c1" },
        {
          audioAction: "DISABLED",
          startTrigger: "ONLY_WHEN_CALLING_BY_NAME",
          endTrigger: "WHEN_SAY_GOODBYE",
        },
      ),
    );
  });

  it("widget: copia o código de incorporação do iframe", async () => {
    const user = userEvent.setup();
    const writeTextMock = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextMock },
      configurable: true,
    });
    setupMock({
      channels: [
        {
          id: "c-widget",
          name: "Site",
          type: "WIDGET",
          agentId: AGENT_ID,
          agentName: "Ana",
          connected: true,
        },
      ],
      widgetLinks: { float: "FLOAT_EMBED", iframe: "IFRAME_EMBED" },
    });
    renderTab();
    await screen.findByText("Site");

    const row = screen.getByTestId("channel-row-c-widget");
    await user.click(within(row).getByRole("button", { name: "Widget" }));
    const dialog = await screen.findByRole("dialog");

    await screen.findByText("IFRAME_EMBED");
    await user.click(
      within(dialog).getByRole("button", { name: "Copiar código de incorporação (Iframe)" }),
    );
    expect(writeTextMock).toHaveBeenCalledWith("IFRAME_EMBED");
  });

  it("mostra erro de listagem em PT-BR com opção de tentar de novo", async () => {
    setupMock({ failListWith: { code: "NOT_FOUND" } });
    renderTab();

    await screen.findByText("Não foi possível carregar os canais");
    expect(screen.getByText("Recurso não encontrado no provedor de agentes.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
  });
});

describe("qrRefetchInterval", () => {
  it("continua pollando enquanto não conectou nem falhou", () => {
    expect(qrRefetchInterval({ value: "abc" }, false)).toBe(4000);
    expect(qrRefetchInterval(undefined, false)).toBe(4000);
  });

  it("para de pollar quando connected é true", () => {
    expect(qrRefetchInterval({ connected: true }, false)).toBe(false);
  });

  it("para de pollar em erro", () => {
    expect(qrRefetchInterval({ value: "abc" }, true)).toBe(false);
  });
});
