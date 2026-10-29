import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { dealChat } from "@/lib/api/ai-config";
import { DealChatDialog } from "./deal-chat-dialog";

vi.mock("@/lib/api/ai-config", () => ({
  dealChat: vi.fn(),
}));

// Mesma razão de _app.assistente.test.tsx: AiPersonaBadge usa useAiPersona
// (useQuery), que exigiria um QueryClientProvider só pra um badge cosmético.
vi.mock("@/components/ai/ai-persona-badge", () => ({
  AiPersonaBadge: () => <span>IA</span>,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

const DEAL = { id: "deal-1", title: "Plano anual Acme" };

describe("DealChatDialog", () => {
  it("fica fechado quando deal é null", () => {
    render(<DealChatDialog deal={null} onOpenChange={vi.fn()} />);
    expect(screen.queryByText("Falar com IA")).not.toBeInTheDocument();
  });

  it("abre com o título do negócio e desabilita enviar sem texto", () => {
    render(<DealChatDialog deal={DEAL} onOpenChange={vi.fn()} />);

    expect(screen.getByText("Falar com IA")).toBeInTheDocument();
    expect(screen.getByText('Negócio: "Plano anual Acme"')).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Enviar/ })).toBeDisabled();
    expect(
      screen.getByText("Envie a primeira mensagem como se você fosse o contato."),
    ).toBeInTheDocument();
  });

  it("envia uma mensagem e mostra a resposta da IA", async () => {
    vi.mocked(dealChat).mockResolvedValue({ reply: "Olá! Temos um plano ideal pra você." });
    const user = userEvent.setup();
    render(<DealChatDialog deal={DEAL} onOpenChange={vi.fn()} />);

    const textarea = screen.getByLabelText("Mensagem para a IA");
    await user.type(textarea, "Quero saber o preço");
    await user.click(screen.getByRole("button", { name: /Enviar/ }));

    expect(await screen.findByText("Olá! Temos um plano ideal pra você.")).toBeInTheDocument();
    expect(screen.getByText("Quero saber o preço")).toBeInTheDocument();
    expect(dealChat).toHaveBeenCalledWith({ deal_id: "deal-1", message: "Quero saber o preço" });
  });

  it("traduz [TRANSFERIR_HUMANO] em vez de mostrar o token cru", async () => {
    vi.mocked(dealChat).mockResolvedValue({ reply: "[TRANSFERIR_HUMANO]" });
    const user = userEvent.setup();
    render(<DealChatDialog deal={DEAL} onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText("Mensagem para a IA"), "pergunta fora do escopo");
    await user.click(screen.getByRole("button", { name: /Enviar/ }));

    expect(await screen.findByText(/transferiria para um humano/i)).toBeInTheDocument();
    expect(screen.queryByText(/TRANSFERIR_HUMANO/)).not.toBeInTheDocument();
  });

  it("envia a mensagem com Enter (sem shift)", async () => {
    vi.mocked(dealChat).mockResolvedValue({ reply: "Resposta rápida." });
    const user = userEvent.setup();
    render(<DealChatDialog deal={DEAL} onOpenChange={vi.fn()} />);

    const textarea = screen.getByLabelText("Mensagem para a IA");
    await user.type(textarea, "Oi{Enter}");

    expect(await screen.findByText("Resposta rápida.")).toBeInTheDocument();
  });

  it("mostra toast de erro quando a IA falha", async () => {
    const { toast } = await import("sonner");
    vi.mocked(dealChat).mockRejectedValue(new Error("Negócio não encontrado."));
    const user = userEvent.setup();
    render(<DealChatDialog deal={DEAL} onOpenChange={vi.fn()} />);

    const textarea = screen.getByLabelText("Mensagem para a IA");
    await user.type(textarea, "Teste de erro");
    await user.click(screen.getByRole("button", { name: /Enviar/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Negócio não encontrado."));
    expect(screen.getByText("Teste de erro")).toBeInTheDocument();
  });

  it("reinicia a conversa ao trocar de negócio", async () => {
    vi.mocked(dealChat).mockResolvedValue({ reply: "Resposta." });
    const user = userEvent.setup();
    const { rerender } = render(<DealChatDialog deal={DEAL} onOpenChange={vi.fn()} />);

    const textarea = screen.getByLabelText("Mensagem para a IA");
    await user.type(textarea, "Mensagem do negócio 1");
    await user.click(screen.getByRole("button", { name: /Enviar/ }));
    await screen.findByText("Resposta.");

    rerender(
      <DealChatDialog deal={{ id: "deal-2", title: "Outro negócio" }} onOpenChange={vi.fn()} />,
    );

    expect(screen.queryByText("Mensagem do negócio 1")).not.toBeInTheDocument();
    expect(
      screen.getByText("Envie a primeira mensagem como se você fosse o contato."),
    ).toBeInTheDocument();
  });

  it("não anexa resposta pendente do negócio antigo após trocar de negócio", async () => {
    // Regressão: resposta do deal-1 resolve DEPOIS da troca para deal-2 —
    // não pode ser anexada à conversa do deal-2 (misatribuição de conteúdo
    // gerado por IA a um negócio errado).
    let resolveReply: ((v: { reply: string }) => void) | undefined;
    vi.mocked(dealChat).mockReturnValue(
      new Promise((resolve) => {
        resolveReply = resolve;
      }),
    );
    const user = userEvent.setup();
    const { rerender } = render(<DealChatDialog deal={DEAL} onOpenChange={vi.fn()} />);

    const textarea = screen.getByLabelText("Mensagem para a IA");
    await user.type(textarea, "Mensagem do negócio 1");
    await user.click(screen.getByRole("button", { name: /Enviar/ }));

    rerender(
      <DealChatDialog deal={{ id: "deal-2", title: "Outro negócio" }} onOpenChange={vi.fn()} />,
    );
    expect(
      screen.getByText("Envie a primeira mensagem como se você fosse o contato."),
    ).toBeInTheDocument();

    // Flush explícito da continuation de `await dealChat(...)` — sem o
    // `act`+microtasks a asserção de ausência abaixo passaria mesmo com o
    // bug presente, só porque ainda não teve chance de rodar.
    await act(async () => {
      resolveReply?.({ reply: "Resposta atrasada do negócio 1" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText("Resposta atrasada do negócio 1")).not.toBeInTheDocument();
    expect(
      screen.getByText("Envie a primeira mensagem como se você fosse o contato."),
    ).toBeInTheDocument();
  });

  it("chama onOpenChange(false) ao fechar o dialog", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<DealChatDialog deal={DEAL} onOpenChange={onOpenChange} />);

    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
