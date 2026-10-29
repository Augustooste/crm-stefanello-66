import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AgentSettingsTab } from "./AgentSettingsTab";
import { useAgentPlatformMutation, useAgentPlatformQuery } from "@/lib/api/agent-platform";
import type { AgentPlatformAgentSettings } from "@/lib/api/agent-platform-contract";

// Só os hooks do cliente provedor de agentes são mockados — o componente nunca fala
// direto com a API do provedor, então basta controlar o retorno de
// useAgentPlatformQuery/useAgentPlatformMutation.
vi.mock("@/lib/api/agent-platform", () => ({
  useAgentPlatformQuery: vi.fn(),
  useAgentPlatformMutation: vi.fn(),
}));

type QueryReturn = ReturnType<typeof useAgentPlatformQuery>;
type MutationReturn = ReturnType<typeof useAgentPlatformMutation>;

const AGENT_ID = "agent-1";

const REMOTE_SETTINGS: AgentPlatformAgentSettings = {
  prefferModel: "GPT_4_O",
  timezone: "America/Sao_Paulo",
  enabledHumanTransfer: true,
  enabledReminder: false,
  splitMessages: true,
  enabledEmoji: false,
  limitSubjects: true,
  messageGroupingTime: "TEN_SEC",
  maxDailyMessages: 100,
  maxDailyMessagesLimitAction: "TRANSFER",
  knowledgeByFunction: true,
  onLackKnowLedge: "https://exemplo.com/webhook",
};

function mockQuery(
  overrides: Partial<{
    data: AgentPlatformAgentSettings | undefined;
    isLoading: boolean;
    isError: boolean;
    error: unknown;
    refetch: () => void;
  }> = {},
) {
  const {
    data = REMOTE_SETTINGS,
    isLoading = false,
    isError = false,
    error = null,
    refetch = vi.fn(),
  } = overrides;
  vi.mocked(useAgentPlatformQuery).mockReturnValue({
    data,
    isLoading,
    isError,
    error,
    refetch,
  } as unknown as QueryReturn);
}

const mutateSpy = vi.fn();

function mockMutation(overrides: Partial<{ isPending: boolean }> = {}) {
  const { isPending = false } = overrides;
  vi.mocked(useAgentPlatformMutation).mockReturnValue({
    mutate: mutateSpy,
    isPending,
  } as unknown as MutationReturn);
}

/** Extrai o `body` enviado na última chamada de `mutate`. */
function lastPayload(): Record<string, unknown> {
  const call = mutateSpy.mock.calls.at(-1);
  if (!call) throw new Error("mutate não foi chamado");
  return (call[0] as { body: Record<string, unknown> }).body;
}

describe("AgentSettingsTab", () => {
  beforeEach(() => {
    vi.mocked(useAgentPlatformQuery).mockReset();
    vi.mocked(useAgentPlatformMutation).mockReset();
    mutateSpy.mockReset();
    mockQuery();
    mockMutation();
  });

  it("mostra skeleton enquanto a primeira leitura carrega", () => {
    mockQuery({ data: undefined, isLoading: true });
    const { container } = render(<AgentSettingsTab agentId={AGENT_ID} />);
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });

  it("mostra erro em PT-BR com ação 'Tentar de novo'", async () => {
    const refetch = vi.fn();
    mockQuery({
      data: undefined,
      isError: true,
      error: new Error("Não conseguimos falar com o servidor agora."),
      refetch,
    });
    const user = userEvent.setup();
    render(<AgentSettingsTab agentId={AGENT_ID} />);

    expect(screen.getByText("Não conseguimos falar com o servidor agora.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("carrega o formulário com os valores remotos", () => {
    render(<AgentSettingsTab agentId={AGENT_ID} />);

    expect(screen.getByLabelText("Fuso horário")).toHaveValue("America/Sao_Paulo");
    expect(screen.getByLabelText("Limite de mensagens por atendimento")).toHaveValue("100");
    expect(screen.getByLabelText("Webhook de falta de conhecimento")).toHaveValue(
      "https://exemplo.com/webhook",
    );
    expect(screen.getByRole("switch", { name: "Transferência para humano" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Lembretes" })).not.toBeChecked();
    // D3: signMessages nunca vem do GET — começa sempre desmarcado.
    expect(screen.getByRole("switch", { name: "Assinar mensagens" })).not.toBeChecked();
  });

  it("troca de modelo envia prefferModel com a grafia exata do contrato", async () => {
    const user = userEvent.setup();
    render(<AgentSettingsTab agentId={AGENT_ID} />);

    await user.click(screen.getByRole("combobox", { name: "Modelo de LLM preferido" }));
    await user.click(screen.getByRole("option", { name: "CLAUDE 4 5 SONNET" }));
    await user.click(screen.getByRole("button", { name: "Salvar configurações" }));

    expect(mutateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ params: { agentId: AGENT_ID } }),
    );
    expect(lastPayload().prefferModel).toBe("CLAUDE_4_5_SONNET");
  });

  it("maxDailyMessages vazio vira null e omite maxDailyMessagesLimitAction", async () => {
    const user = userEvent.setup();
    render(<AgentSettingsTab agentId={AGENT_ID} />);

    await user.clear(screen.getByLabelText("Limite de mensagens por atendimento"));
    await user.click(screen.getByRole("button", { name: "Salvar configurações" }));

    const payload = lastPayload();
    expect(payload.maxDailyMessages).toBeNull();
    expect(payload).not.toHaveProperty("maxDailyMessagesLimitAction");
  });

  it("com limite definido, envia a ação de limite escolhida", async () => {
    const user = userEvent.setup();
    render(<AgentSettingsTab agentId={AGENT_ID} />);

    await user.click(screen.getByRole("combobox", { name: "Ao atingir o limite de mensagens" }));
    await user.click(screen.getByRole("option", { name: "Bloquear a conversa" }));
    await user.click(screen.getByRole("button", { name: "Salvar configurações" }));

    const payload = lastPayload();
    expect(payload.maxDailyMessages).toBe(100);
    expect(payload.maxDailyMessagesLimitAction).toBe("BLOCK");
  });

  it("signMessages só entra no payload quando o usuário toca no switch", async () => {
    const user = userEvent.setup();
    render(<AgentSettingsTab agentId={AGENT_ID} />);

    // Deixa o form "sujo" sem tocar em signMessages.
    await user.type(screen.getByLabelText("Fuso horário"), "!");
    await user.click(screen.getByRole("button", { name: "Salvar configurações" }));
    expect(lastPayload()).not.toHaveProperty("signMessages");

    mutateSpy.mockClear();
    await user.click(screen.getByRole("switch", { name: "Assinar mensagens" }));
    await user.click(screen.getByRole("button", { name: "Salvar configurações" }));
    expect(lastPayload().signMessages).toBe(true);
  });

  it("signMessages tocado duas vezes envia false (liga e desliga antes de salvar)", async () => {
    const user = userEvent.setup();
    render(<AgentSettingsTab agentId={AGENT_ID} />);

    const toggle = screen.getByRole("switch", { name: "Assinar mensagens" });
    await user.click(toggle); // liga (true)
    await user.click(toggle); // desliga de novo (false), mas já "tocado"
    await user.click(screen.getByRole("button", { name: "Salvar configurações" }));

    expect(lastPayload().signMessages).toBe(false);
  });

  it("modelo desconhecido retornado pela API continua visível e selecionado", () => {
    mockQuery({
      // Valor fora do enum é exatamente o cenário sob teste (API ganha modelo
      // novo antes de regerarmos o contrato) — daí o duplo cast.
      data: {
        ...REMOTE_SETTINGS,
        prefferModel: "GPT_6_ULTRA",
      } as unknown as AgentPlatformAgentSettings,
    });
    render(<AgentSettingsTab agentId={AGENT_ID} />);

    expect(screen.getByRole("combobox", { name: "Modelo de LLM preferido" })).toHaveTextContent(
      "GPT 6 ULTRA",
    );
  });
});
