import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { renderWithQueryClient } from "@/test/render";
import { SimulatorComposer } from "./SimulatorComposer";

const api = vi.hoisted(() => ({ invoke: vi.fn(), upload: vi.fn(), storage: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke: api.invoke }, storage: { from: api.storage } },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
  api.invoke.mockResolvedValue({
    data: { ok: true, conversation_id: "conversation-a" },
    error: null,
  });
  api.upload.mockResolvedValue({ error: null });
  api.storage.mockReturnValue({ upload: api.upload });
});

describe("Compositor do cliente simulado", () => {
  it("injeta pelo endpoint, sem transformar entrada do cliente em envio humano", async () => {
    const sent = vi.fn();
    const user = userEvent.setup();
    renderWithQueryClient(
      <SimulatorComposer
        tenantId="tenant-a"
        channelId="channel-a"
        conversationId="conversation-a"
        onSent={sent}
      />,
    );
    await user.type(
      screen.getByLabelText("Mensagem do cliente simulado"),
      "Quero agendar uma avaliação",
    );
    await user.click(screen.getByRole("button", { name: "Enviar como cliente" }));
    await waitFor(() => expect(sent).toHaveBeenCalledWith("conversation-a"));
    expect(api.invoke).toHaveBeenCalledWith("channel-simulator", {
      body: {
        action: "send",
        channel_id: "channel-a",
        conversation_id: "conversation-a",
        content: "Quero agendar uma avaliação",
      },
    });
    expect(screen.getByText("Simulação — não entregue no WhatsApp")).toBeInTheDocument();
    expect(screen.getByLabelText("Mensagem do cliente simulado")).toHaveValue("");
  });

  it("faz upload no prefixo tenant/canal e envia só a referência de storage", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(
      <SimulatorComposer
        tenantId="tenant-a"
        channelId="channel-a"
        conversationId="conversation-a"
      />,
    );
    const image = new File(["imagem"], "consulta.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Anexo do cliente simulado"), image);
    await user.click(screen.getByRole("button", { name: "Enviar como cliente" }));
    await waitFor(() => expect(api.invoke).toHaveBeenCalled());
    expect(api.storage).toHaveBeenCalledWith("simulator-media");
    expect(api.upload).toHaveBeenCalledWith(
      expect.stringMatching(/^tenant-a\/simulator\/channel-a\/[\w-]+\.png$/),
      image,
      { contentType: "image/png" },
    );
    expect(api.invoke.mock.calls[0][1].body.media).toEqual({
      storage_path: api.upload.mock.calls[0][0],
      type: "image/png",
    });
    expect(api.invoke.mock.calls[0][1].body).not.toHaveProperty("tenant_id");
  });

  it("preserva mensagem e não navega quando o servidor recusa o canal", async () => {
    api.invoke.mockResolvedValue({
      data: { ok: false, error: "Canal de demonstração não encontrado." },
      error: null,
    });
    const sent = vi.fn();
    const user = userEvent.setup();
    renderWithQueryClient(
      <SimulatorComposer tenantId="tenant-a" channelId="channel-a" onSent={sent} />,
    );
    await user.type(screen.getByLabelText("Mensagem do cliente simulado"), "Olá");
    await user.click(screen.getByRole("button", { name: "Enviar como cliente" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Canal de demonstração não encontrado."),
    );
    expect(sent).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Mensagem do cliente simulado")).toHaveValue("Olá");
  });
});
