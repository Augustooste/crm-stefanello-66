import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AgentPlaygroundTab } from "./AgentPlaygroundTab";
import { AgentPlatformCallError } from "@/lib/api/agent-platform";

const conversationMutateAsync = vi.fn();
const addMessageMutateAsync = vi.fn();

// Mock parcial: mantém `AgentPlatformCallError` real (o componente faz
// `instanceof`) e só troca `useAgentPlatformMutation` por um stub controlável.
vi.mock("@/lib/api/agent-platform", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/agent-platform")>(
    "@/lib/api/agent-platform",
  );
  return {
    ...actual,
    useAgentPlatformMutation: vi.fn((action: string) => {
      if (action === "playground.conversation") {
        return { mutateAsync: conversationMutateAsync, isPending: false };
      }
      return { mutateAsync: addMessageMutateAsync, isPending: false };
    }),
  };
});

function renderTab() {
  return render(<AgentPlaygroundTab agentId="agent-1" />);
}

const INPUT_LABEL = "Mensagem de teste para o agente";
const SEND_LABEL = "Enviar mensagem de teste";

async function enviarMensagem(user: ReturnType<typeof userEvent.setup>, texto: string) {
  await user.type(screen.getByLabelText(INPUT_LABEL), texto);
  await user.click(screen.getByRole("button", { name: SEND_LABEL }));
}

describe("AgentPlaygroundTab", () => {
  beforeEach(() => {
    conversationMutateAsync.mockReset();
    addMessageMutateAsync.mockReset();
  });

  it("envia o prompt e mostra a resposta do agente", async () => {
    conversationMutateAsync.mockResolvedValue({ message: "Olá! Como posso ajudar?" });
    const user = userEvent.setup();
    renderTab();

    await enviarMensagem(user, "oi");

    expect(screen.getByText("oi")).toBeInTheDocument();
    expect(await screen.findByText("Olá! Como posso ajudar?")).toBeInTheDocument();
    expect(conversationMutateAsync).toHaveBeenCalledWith({
      params: { agentId: "agent-1" },
      body: { contextId: expect.any(String), prompt: "oi" },
    });
  });

  it("nunca envia callbackUrl/onFinishCallback no corpo da conversa", async () => {
    conversationMutateAsync.mockResolvedValue({ message: "ok" });
    const user = userEvent.setup();
    renderTab();

    await enviarMensagem(user, "oi");
    await waitFor(() => expect(conversationMutateAsync).toHaveBeenCalledTimes(1));

    const body = conversationMutateAsync.mock.calls[0][0].body as Record<string, unknown>;
    expect(Object.keys(body)).not.toContain("callbackUrl");
    expect(Object.keys(body)).not.toContain("onFinishCallback");
  });

  it("mantém o contextId estável entre duas mensagens e muda após Nova conversa", async () => {
    conversationMutateAsync.mockResolvedValue({ message: "ok" });
    const user = userEvent.setup();
    renderTab();

    const contextIdTexto = () =>
      screen.getByTestId("playground-context-id").querySelector("code")?.textContent ?? "";
    const primeiroContextId = contextIdTexto();

    await enviarMensagem(user, "primeira");
    await waitFor(() => expect(conversationMutateAsync).toHaveBeenCalledTimes(1));

    await enviarMensagem(user, "segunda");
    await waitFor(() => expect(conversationMutateAsync).toHaveBeenCalledTimes(2));

    const primeiroBody = conversationMutateAsync.mock.calls[0][0].body as { contextId: string };
    const segundoBody = conversationMutateAsync.mock.calls[1][0].body as { contextId: string };
    expect(primeiroBody.contextId).toBe(primeiroContextId);
    expect(segundoBody.contextId).toBe(primeiroContextId);
    expect(contextIdTexto()).toBe(primeiroContextId);

    await user.click(screen.getByRole("button", { name: "Nova conversa" }));

    expect(contextIdTexto()).not.toBe(primeiroContextId);
    expect(screen.queryByText("primeira")).not.toBeInTheDocument();
  });

  it("renderiza imagem, áudio e documento retornados na resposta", async () => {
    conversationMutateAsync.mockResolvedValue({
      images: ["https://cdn.example/img.png"],
      audios: ["https://cdn.example/audio.mp3"],
      documents: ["https://cdn.example/doc.pdf"],
    });
    const user = userEvent.setup();
    renderTab();

    await enviarMensagem(user, "manda anexos");

    expect(await screen.findByAltText("Imagem 1 da resposta do agente")).toHaveAttribute(
      "src",
      "https://cdn.example/img.png",
    );
    expect(screen.getByLabelText("Áudio 1 da resposta do agente")).toHaveAttribute(
      "src",
      "https://cdn.example/audio.mp3",
    );
    expect(screen.getByRole("link", { name: /Documento 1/ })).toHaveAttribute(
      "href",
      "https://cdn.example/doc.pdf",
    );
  });

  it("mostra erro em PT-BR quando a chamada falha", async () => {
    conversationMutateAsync.mockRejectedValue(
      new AgentPlatformCallError(
        "INSUFFICIENT_CREDITS",
        "Os créditos do workspace no provedor de agentes acabaram.",
      ),
    );
    const user = userEvent.setup();
    renderTab();

    await enviarMensagem(user, "oi");

    expect(
      await screen.findByText("Os créditos do workspace no provedor de agentes acabaram."),
    ).toBeInTheDocument();
  });

  it("grava mensagem no histórico do atendimento via playground.addMessage", async () => {
    conversationMutateAsync.mockResolvedValue({ message: "ok" });
    addMessageMutateAsync.mockResolvedValue({ message: "ok" });
    const user = userEvent.setup();
    renderTab();

    await enviarMensagem(user, "oi");
    await screen.findByText("ok");

    const botoesGravar = screen.getAllByRole("button", { name: "Gravar no histórico" });
    await user.click(botoesGravar[0]);

    await waitFor(() => expect(addMessageMutateAsync).toHaveBeenCalledTimes(1));
    expect(addMessageMutateAsync).toHaveBeenCalledWith({
      params: { agentId: "agent-1" },
      body: { contextId: expect.any(String), prompt: "oi", role: "user" },
    });
    expect(
      await screen.findByText("Mensagem gravada no histórico do atendimento."),
    ).toBeInTheDocument();
  });

  it('"Parar de esperar" avisa que a mensagem pode ter sido processada e libera o envio', async () => {
    let resolverPendente: (value: { message: string }) => void = () => {};
    conversationMutateAsync.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolverPendente = resolve;
        }),
    );
    const user = userEvent.setup();
    renderTab();

    await enviarMensagem(user, "oi");
    expect(screen.getByRole("button", { name: SEND_LABEL })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Parar de esperar" }));

    expect(
      screen.getByText(
        "Você parou de esperar. O provedor de agentes não tem cancelamento remoto: a mensagem pode ter sido processada de qualquer forma, e a resposta ainda pode aparecer aqui.",
      ),
    ).toBeInTheDocument();

    // pending=false libera o envio: digitando algo, o botão volta a habilitar.
    await user.type(screen.getByLabelText(INPUT_LABEL), "outra mensagem");
    expect(screen.getByRole("button", { name: SEND_LABEL })).not.toBeDisabled();

    resolverPendente({ message: "resposta tardia" });

    expect(await screen.findByText("resposta tardia")).toBeInTheDocument();
    expect(
      screen.getByText("Resposta chegou depois que você parou de esperar."),
    ).toBeInTheDocument();
  });
});
