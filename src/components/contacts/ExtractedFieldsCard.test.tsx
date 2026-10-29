import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { supabase } from "@/integrations/supabase/client";
import { renderWithQueryClient } from "@/test/render";
import { createFromByTable, createPendingQueryBuilder, fail, ok } from "@/test/supabase-mock";
import { ExtractedFieldsCard } from "./ExtractedFieldsCard";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: vi.fn() } }));
const extraction = {
  id: "extraction-1",
  field_name: "email",
  field_label: "E-mail",
  extracted_value: "ana@example.test",
  confidence: 0.98,
  created_at: "2026-10-15T12:00:00Z",
  applied: false,
  apply_reason: "Campo editado após a mensagem-fonte",
  source_message_ids: ["message-1"],
};

describe("Informações extraídas pela IA", () => {
  beforeEach(() => vi.clearAllMocks());
  it("mostra valor, confiança, decisão e a mensagem-fonte real", async () => {
    vi.mocked(supabase.from).mockImplementation(
      createFromByTable({
        contact_field_extractions: ok([extraction]),
        messages: ok({
          id: "message-1",
          content: "Meu e-mail é ana@example.test",
          created_at: "2026-10-15T11:59:00Z",
          conversation_id: "conversation-1",
        }),
      }),
    );
    renderWithQueryClient(<ExtractedFieldsCard tenantId="tenant-1" contactId="contact-1" />);
    expect(await screen.findByText("ana@example.test")).toBeInTheDocument();
    expect(screen.getByText("Confiança: 98%")).toBeInTheDocument();
    expect(screen.getByText(/Ignorado: Campo editado/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "Ver mensagem-fonte 1" }));
    expect(await screen.findByText("Meu e-mail é ana@example.test")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Abrir conversa" })).toHaveAttribute(
      "href",
      "/inbox?conversationId=conversation-1&mode=lista",
    );
    expect(document.getElementById("contact-extraction-source")).not.toBeNull();
  });
  it("não confunde falha de permissão com histórico vazio", async () => {
    vi.mocked(supabase.from).mockImplementation(
      createFromByTable({ contact_field_extractions: fail("permission denied") }),
    );
    renderWithQueryClient(<ExtractedFieldsCard tenantId="tenant-1" contactId="contact-1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Não foi possível carregar as informações extraídas.",
    );
    expect(screen.queryByText("Nenhuma extração registrada.")).not.toBeInTheDocument();
  });
  it("exibe estado vazio e como ativar a extração", async () => {
    vi.mocked(supabase.from).mockImplementation(
      createFromByTable({ contact_field_extractions: ok([]) }),
    );
    renderWithQueryClient(<ExtractedFieldsCard tenantId="tenant-1" contactId="contact-1" />);
    expect(await screen.findByText("Nenhuma extração registrada.")).toBeInTheDocument();
    expect(screen.getByText(/Configurações → IA → Features/)).toBeInTheDocument();
  });
  it("identifica o carregamento sem mostrar vazio prematuro", () => {
    vi.mocked(supabase.from).mockImplementation(() => createPendingQueryBuilder() as never);
    renderWithQueryClient(<ExtractedFieldsCard tenantId="tenant-1" contactId="contact-1" />);
    expect(screen.getByRole("status")).toHaveTextContent("Carregando informações extraídas");
    expect(screen.queryByText("Nenhuma extração registrada.")).not.toBeInTheDocument();
  });
});
