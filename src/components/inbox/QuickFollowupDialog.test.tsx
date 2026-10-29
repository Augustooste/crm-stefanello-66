import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { format } from "date-fns";

import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { renderWithQueryClient } from "@/test/render";
import { createQueryBuilder, fail, ok, type QueryBuilderMock } from "@/test/supabase-mock";
import { QuickFollowupDialog } from "./QuickFollowupDialog";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const BASE_PROPS = {
  open: true,
  contactId: "ct1",
  dealId: "d1" as string | null,
  tenantId: "t1",
  createdBy: "u1",
};

/** Horário agendado esperado para os defaults do form: hoje às 10:00 local. */
function expectedDefaultScheduledAt(): string {
  const today = format(new Date(), "yyyy-MM-dd");
  const [yy, mm, dd] = today.split("-").map(Number);
  return new Date(yy, mm - 1, dd, 10, 0, 0, 0).toISOString();
}

describe("QuickFollowupDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renderiza o diálogo com título e descrição quando aberto", () => {
    renderWithQueryClient(<QuickFollowupDialog {...BASE_PROPS} onOpenChange={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Criar retorno" })).toBeInTheDocument();
    expect(screen.getByText("Agende um recontato com este contato.")).toBeInTheDocument();
  });

  it("botão Cancelar fecha o diálogo sem criar follow-up", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithQueryClient(<QuickFollowupDialog {...BASE_PROPS} onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("cria follow-up com os valores padrão (sem descrição) e fecha o diálogo ao concluir", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const builder: QueryBuilderMock = createQueryBuilder(ok(null));
    vi.mocked(supabase.from).mockImplementation(
      () => builder as unknown as ReturnType<typeof supabase.from>,
    );

    renderWithQueryClient(<QuickFollowupDialog {...BASE_PROPS} onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole("button", { name: "Criar retorno" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Retorno criado"));
    expect(supabase.from).toHaveBeenCalledWith("deal_followups");
    expect(builder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        contact_id: "ct1",
        deal_id: "d1",
        tenant_id: "t1",
        created_by: "u1",
        description: null,
        status: "pending",
        source: "manual",
        ai_suggested: false,
        scheduled_at: expectedDefaultScheduledAt(),
      }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("inclui a descrição digitada no payload quando preenchida", async () => {
    const user = userEvent.setup();
    const builder: QueryBuilderMock = createQueryBuilder(ok(null));
    vi.mocked(supabase.from).mockImplementation(
      () => builder as unknown as ReturnType<typeof supabase.from>,
    );

    renderWithQueryClient(<QuickFollowupDialog {...BASE_PROPS} onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText("Descrição"), "Confirmar interesse na proposta");
    await user.click(screen.getByRole("button", { name: "Criar retorno" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(builder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Confirmar interesse na proposta" }),
    );
  });

  it("envia deal_id nulo quando a conversa não tem negócio vinculado", async () => {
    const user = userEvent.setup();
    const builder: QueryBuilderMock = createQueryBuilder(ok(null));
    vi.mocked(supabase.from).mockImplementation(
      () => builder as unknown as ReturnType<typeof supabase.from>,
    );

    renderWithQueryClient(
      <QuickFollowupDialog {...BASE_PROPS} dealId={null} onOpenChange={vi.fn()} />,
    );

    await user.click(screen.getByRole("button", { name: "Criar retorno" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(builder.insert).toHaveBeenCalledWith(expect.objectContaining({ deal_id: null }));
  });

  it("mostra erro via toast e mantém o diálogo aberto quando a criação falha", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    vi.mocked(supabase.from).mockImplementation(
      () =>
        createQueryBuilder(fail("tenant inválido")) as unknown as ReturnType<typeof supabase.from>,
    );

    renderWithQueryClient(<QuickFollowupDialog {...BASE_PROPS} onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole("button", { name: "Criar retorno" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("tenant inválido"));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("não envia quando o horário é limpo (validação client-side impede o submit)", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<QuickFollowupDialog {...BASE_PROPS} onOpenChange={vi.fn()} />);

    const timeInput = screen.getByLabelText(/hora/i);
    await user.clear(timeInput);
    await user.click(screen.getByRole("button", { name: "Criar retorno" }));

    await waitFor(() => expect(timeInput).toHaveAttribute("aria-invalid", "true"));
    expect(supabase.from).not.toHaveBeenCalled();
  });
});
