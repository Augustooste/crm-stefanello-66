import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";

import { renderWithQueryClient } from "@/test/render";
import { PhoneSuppressionsTab } from "./PhoneSuppressionsTab";

const selectOrderMock = vi.fn();
const rpcMock = vi.fn();
const fromMock = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (...args: unknown[]) => fromMock(...args),
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function suppressionsTable() {
  return {
    select: () => ({ order: () => selectOrderMock() }),
  };
}

const ROW_ACTIVE = {
  id: "supp-1",
  phone: "+5511900000000",
  reason: "Reclamou de excesso de mensagens",
  source: "manual",
  suppressed_at: "2026-07-01T10:00:00.000Z",
  reactivated_at: null,
};

const ROW_REACTIVATED = {
  id: "supp-2",
  phone: "+5511911111111",
  reason: "Respondeu PARAR por engano",
  source: "keyword",
  suppressed_at: "2026-06-01T10:00:00.000Z",
  reactivated_at: "2026-06-15T10:00:00.000Z",
};

describe("PhoneSuppressionsTab", () => {
  beforeEach(() => {
    selectOrderMock.mockReset();
    rpcMock.mockReset();
    fromMock.mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();

    fromMock.mockImplementation(() => suppressionsTable());
    rpcMock.mockResolvedValue({ data: null, error: null });
  });

  it("lista as supressões e mostra a supressão ativa por padrão (filtro 'Ativas')", async () => {
    selectOrderMock.mockResolvedValue({ data: [ROW_ACTIVE, ROW_REACTIVATED], error: null });

    renderWithQueryClient(<PhoneSuppressionsTab />);

    expect(await screen.findByText("+5511900000000")).toBeInTheDocument();
    expect(screen.getByText("Reclamou de excesso de mensagens")).toBeInTheDocument();
    expect(screen.getByText("Manual")).toBeInTheDocument();
    expect(screen.getByText("Ativa")).toBeInTheDocument();
    expect(screen.queryByText("+5511911111111")).not.toBeInTheDocument();
  });

  it("mostra estado vazio quando não há supressões", async () => {
    selectOrderMock.mockResolvedValue({ data: [], error: null });

    renderWithQueryClient(<PhoneSuppressionsTab />);

    expect(await screen.findByText("Nenhuma supressão encontrada")).toBeInTheDocument();
  });

  it("adiciona uma supressão manual chamando add_manual_phone_suppression com p_phone/p_reason corretos", async () => {
    selectOrderMock.mockResolvedValue({ data: [], error: null });
    const user = userEvent.setup();
    renderWithQueryClient(<PhoneSuppressionsTab />);

    await screen.findByText("Nenhuma supressão encontrada");
    await user.click(screen.getByRole("button", { name: "Adicionar supressão manual" }));

    await user.type(screen.getByLabelText("Telefone *"), "+5511922222222");
    await user.type(screen.getByLabelText("Motivo *"), "Pediu para não receber mais");
    await user.click(screen.getByRole("button", { name: "Adicionar" }));

    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));
    expect(rpcMock).toHaveBeenCalledWith("add_manual_phone_suppression", {
      p_phone: "+5511922222222",
      p_reason: "Pediu para não receber mais",
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Supressão adicionada"));
  });

  it("reativa uma supressão ativa chamando reactivate_phone_suppression com p_suppression_id correto", async () => {
    selectOrderMock.mockResolvedValue({ data: [ROW_ACTIVE], error: null });
    const user = userEvent.setup();
    renderWithQueryClient(<PhoneSuppressionsTab />);

    const reactivateButton = await screen.findByRole("button", { name: "Reativar" });
    await user.click(reactivateButton);

    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));
    expect(rpcMock).toHaveBeenCalledWith("reactivate_phone_suppression", {
      p_suppression_id: "supp-1",
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("+5511900000000 reativado"));
  });

  it("não mostra o botão Reativar para uma supressão já reativada (filtro 'Todas')", async () => {
    selectOrderMock.mockResolvedValue({ data: [ROW_REACTIVATED], error: null });
    const user = userEvent.setup();
    renderWithQueryClient(<PhoneSuppressionsTab />);

    await user.click(screen.getByRole("combobox", { name: "Filtrar por situação" }));
    await user.click(screen.getByRole("option", { name: "Todas" }));

    expect(await screen.findByText("+5511911111111")).toBeInTheDocument();
    expect(screen.getByText("Reativada")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reativar" })).not.toBeInTheDocument();
  });

  it("traduz o jargão do Postgres no estado de erro em vez de exibi-lo cru", async () => {
    // O Supabase devolve PostgrestError: objeto simples, não `Error`.
    selectOrderMock.mockResolvedValue({
      data: null,
      error: { message: "permission denied for table phone_suppressions", code: "42501" },
    });

    renderWithQueryClient(<PhoneSuppressionsTab />);

    expect(
      await screen.findByText("Você não tem permissão para fazer isso. Peça a um administrador."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/permission denied/i)).not.toBeInTheDocument();
  });
});
