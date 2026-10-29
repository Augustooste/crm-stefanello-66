import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";

import { useAgentPlatformMutation, useAgentPlatformQuery } from "@/lib/api/agent-platform";
import { AgentWebhooksTab } from "./AgentWebhooksTab";

vi.mock("@/lib/api/agent-platform", () => ({
  useAgentPlatformQuery: vi.fn(),
  useAgentPlatformMutation: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const queryMock = vi.mocked(useAgentPlatformQuery);
const mutationMock = vi.mocked(useAgentPlatformMutation);

interface MutateOptions {
  onSuccess?: (data: { success?: boolean }, variables: unknown) => void;
  onError?: (error: { message: string }, variables: unknown) => void;
}

const AGENT_ID = "agent-1";

function mockLoaded(data: Record<string, string> = {}) {
  queryMock.mockReturnValue({
    data,
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  } as never);
}

function mockMutation(mutate = vi.fn()) {
  mutationMock.mockReturnValue({ mutate, isPending: false } as never);
  return mutate;
}

function renderTab() {
  return render(<AgentWebhooksTab agentId={AGENT_ID} />);
}

describe("AgentWebhooksTab", () => {
  beforeEach(() => {
    queryMock.mockReset();
    mutationMock.mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it("mostra o skeleton enquanto os webhooks carregam", () => {
    queryMock.mockReturnValue({
      data: undefined,
      isPending: true,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as never);
    mockMutation();

    const { container } = renderTab();

    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Nova mensagem")).not.toBeInTheDocument();
  });

  it("carrega os valores remotos nos campos correspondentes", () => {
    mockLoaded({
      onNewMessage: "https://meusite.com/hooks/nova-mensagem",
      onCancelEvent: "https://meusite.com/hooks/cancelamento",
    });
    mockMutation();

    renderTab();

    expect(screen.getByLabelText("Nova mensagem")).toHaveValue(
      "https://meusite.com/hooks/nova-mensagem",
    );
    expect(screen.getByLabelText("Agendamento cancelado")).toHaveValue(
      "https://meusite.com/hooks/cancelamento",
    );
    // Campo sem valor remoto vem vazio -- nenhum campo é obrigatório no contrato.
    expect(screen.getByLabelText("IA sem resposta")).toHaveValue("");
  });

  it("mostra erro em PT-BR com botão 'Tentar de novo' quando a leitura falha", async () => {
    const refetch = vi.fn();
    queryMock.mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      error: { message: "Não foi possível falar com o provedor de agentes." },
      refetch,
    } as never);
    mockMutation();

    renderTab();

    expect(
      screen.getByText("Não foi possível falar com o provedor de agentes."),
    ).toBeInTheDocument();
    const retryButton = screen.getByRole("button", { name: "Tentar de novo" });
    await userEvent.click(retryButton);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("URL inválida bloqueia o envio com mensagem em PT-BR e não chama a mutação", async () => {
    mockLoaded({});
    const mutate = mockMutation();
    const user = userEvent.setup();

    renderTab();

    await user.type(screen.getByLabelText("Nova mensagem"), "isso-nao-e-uma-url");
    await user.click(screen.getByRole("button", { name: "Salvar webhooks" }));

    expect(
      screen.getByText("URL inválida. Use um endereço completo iniciado por https://."),
    ).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("URL http (sem https) também é bloqueada", async () => {
    mockLoaded({});
    const mutate = mockMutation();
    const user = userEvent.setup();

    renderTab();

    await user.type(screen.getByLabelText("Transferência para humano"), "http://sem-tls.com/hook");
    await user.click(screen.getByRole("button", { name: "Salvar webhooks" }));

    expect(
      screen.getByText("URL inválida. Use um endereço completo iniciado por https://."),
    ).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("salva enviando somente os campos preenchidos, com os nomes exatos do contrato", async () => {
    mockLoaded({});
    const mutate = mockMutation();
    const user = userEvent.setup();

    renderTab();

    await user.type(
      screen.getByLabelText("Nova mensagem"),
      "https://meusite.com/hooks/nova-mensagem",
    );
    await user.type(
      screen.getByLabelText("IA sem resposta"),
      "https://meusite.com/hooks/sem-resposta",
    );
    await user.click(screen.getByRole("button", { name: "Salvar webhooks" }));

    expect(mutate).toHaveBeenCalledTimes(1);
    const [variables] = mutate.mock.calls[0] as [
      { params: { agentId: string }; body: Record<string, string> },
    ];
    expect(variables.params).toEqual({ agentId: AGENT_ID });
    expect(variables.body).toEqual({
      onNewMessage: "https://meusite.com/hooks/nova-mensagem",
      onLackKnowLedge: "https://meusite.com/hooks/sem-resposta",
    });
    // Nenhum outro campo do contrato deve ser enviado vazio.
    expect(Object.keys(variables.body)).toHaveLength(2);
  });

  it("campo que já tinha valor remoto e foi limpo NÃO vai como string vazia no envio", async () => {
    mockLoaded({ onNewMessage: "https://antigo.com/hook" });
    const mutate = mockMutation();
    const user = userEvent.setup();

    renderTab();

    await user.clear(screen.getByLabelText("Nova mensagem"));
    await user.type(
      screen.getByLabelText("Transferência para humano"),
      "https://meusite.com/hooks/transferencia",
    );
    await user.click(screen.getByRole("button", { name: "Salvar webhooks" }));

    expect(mutate).toHaveBeenCalledTimes(1);
    const [variables] = mutate.mock.calls[0] as [{ body: Record<string, string> }];
    // onNewMessage foi limpo no formulário mas o contrato não documenta ""
    // como "remover webhook" -- por isso a chave não vai no corpo do PUT.
    expect(variables.body).not.toHaveProperty("onNewMessage");
    expect(variables.body).toEqual({
      onTransfer: "https://meusite.com/hooks/transferencia",
    });
  });

  it("mostra toast de sucesso em PT-BR quando a mutação é concluída", async () => {
    mockLoaded({});
    const mutate = vi.fn((_variables: unknown, options?: MutateOptions) =>
      options?.onSuccess?.({ success: true }, _variables),
    );
    mockMutation(mutate);
    const user = userEvent.setup();

    renderTab();

    await user.type(
      screen.getByLabelText("Fim de atendimento"),
      "https://meusite.com/hooks/fim-atendimento",
    );
    await user.click(screen.getByRole("button", { name: "Salvar webhooks" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Webhooks do agente salvos."));
  });

  it("mostra a mensagem de erro do provedor quando a mutação falha", async () => {
    mockLoaded({});
    const mutate = vi.fn((_variables: unknown, options?: MutateOptions) =>
      options?.onError?.({ message: "Token do provedor de agentes expirou." }, _variables),
    );
    mockMutation(mutate);
    const user = userEvent.setup();

    renderTab();

    await user.type(
      screen.getByLabelText("Agendamento criado"),
      "https://meusite.com/hooks/agendamento",
    );
    await user.click(screen.getByRole("button", { name: "Salvar webhooks" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Token do provedor de agentes expirou."),
    );
  });

  it("botão Salvar começa desabilitado e só habilita depois de editar um campo", async () => {
    mockLoaded({});
    mockMutation();
    const user = userEvent.setup();

    renderTab();

    const saveButton = screen.getByRole("button", { name: "Salvar webhooks" });
    expect(saveButton).toBeDisabled();

    await user.type(screen.getByLabelText("Início de atendimento"), "https://meusite.com/x");
    expect(saveButton).toBeEnabled();
  });
});
