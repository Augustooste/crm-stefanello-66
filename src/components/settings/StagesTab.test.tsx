import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { StagesTab } from "./StagesTab";

const boardMaybeSingleMock = vi.fn();
const stagesOrderMock = vi.fn();
const stageUpdateEqMock = vi.fn();
const stageUpdateMock = vi.fn();
const stageInsertMock = vi.fn();
const stageDeleteEqMock = vi.fn();
const stageDeleteMock = vi.fn();
const dealsCountHeadMock = vi.fn();
const dealsUpdateEqMock = vi.fn();
const dealsUpdateMock = vi.fn();
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

function boardsTable() {
  return {
    select: () => ({
      eq: () => ({ maybeSingle: () => boardMaybeSingleMock() }),
    }),
  };
}

function boardStagesTable() {
  return {
    select: () => ({
      eq: () => ({ order: () => stagesOrderMock() }),
    }),
    update: stageUpdateMock,
    insert: stageInsertMock,
    delete: stageDeleteMock,
  };
}

function renderTab() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
  const utils = render(
    <QueryClientProvider client={qc}>
      <StagesTab />
    </QueryClientProvider>,
  );
  return { ...utils, invalidateSpy };
}

describe("StagesTab", () => {
  beforeEach(() => {
    boardMaybeSingleMock.mockReset();
    stagesOrderMock.mockReset();
    stageUpdateEqMock.mockReset();
    stageUpdateMock.mockReset();
    stageInsertMock.mockReset();
    stageDeleteEqMock.mockReset();
    stageDeleteMock.mockReset();
    dealsCountHeadMock.mockReset();
    dealsUpdateEqMock.mockReset();
    dealsUpdateMock.mockReset();
    rpcMock.mockReset();
    fromMock.mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();

    boardMaybeSingleMock.mockResolvedValue({
      data: { id: "board-1", name: "Funil de vendas" },
      error: null,
    });
    stagesOrderMock.mockResolvedValue({ data: [], error: null });
    stageUpdateEqMock.mockResolvedValue({ error: null });
    stageUpdateMock.mockReturnValue({ eq: stageUpdateEqMock });
    stageInsertMock.mockResolvedValue({ error: null });
    stageDeleteEqMock.mockResolvedValue({ error: null });
    stageDeleteMock.mockReturnValue({ eq: stageDeleteEqMock });
    dealsUpdateEqMock.mockResolvedValue({ error: null });
    dealsUpdateMock.mockReturnValue({ eq: dealsUpdateEqMock });
    rpcMock.mockResolvedValue({ data: { success: true, status: "accepted" }, error: null });

    fromMock.mockImplementation((table: string) => {
      if (table === "boards") return boardsTable();
      if (table === "board_stages") return boardStagesTable();
      // "deals" table: select(...).eq(...) resolves the count query directly.
      return {
        select: () => ({ eq: () => dealsCountHeadMock() }),
        update: dealsUpdateMock,
      };
    });
    dealsCountHeadMock.mockResolvedValue({ count: 0, error: null });
  });

  it("mostra o skeleton enquanto a query do board carrega", () => {
    boardMaybeSingleMock.mockImplementation(() => new Promise(() => {}));

    renderTab();

    expect(screen.queryByText(/Etapas do funil/)).not.toBeInTheDocument();
  });

  it("mostra EmptyState quando não há board padrão configurado", async () => {
    boardMaybeSingleMock.mockResolvedValue({ data: null, error: null });

    renderTab();

    expect(await screen.findByText("Nenhum funil configurado")).toBeInTheDocument();
  });

  it("mostra EmptyState quando a query do board falha (data permanece indefinido)", async () => {
    boardMaybeSingleMock.mockResolvedValue({
      data: null,
      error: new Error("Falha ao buscar board"),
    });

    renderTab();

    expect(await screen.findByText("Nenhum funil configurado")).toBeInTheDocument();
  });

  it("trata data nulo da query de etapas como lista vazia", async () => {
    stagesOrderMock.mockResolvedValue({ data: null, error: null });

    renderTab();

    expect(await screen.findByText("Sem etapas")).toBeInTheDocument();
  });

  it("não quebra quando a query de etapas falha — mostra o EmptyState de etapas", async () => {
    stagesOrderMock.mockResolvedValue({ data: null, error: new Error("Falha ao buscar etapas") });

    renderTab();

    expect(await screen.findByText("Sem etapas")).toBeInTheDocument();
  });

  it("renderiza o título com o nome do board e o EmptyState de etapas quando vazio", async () => {
    renderTab();

    expect(await screen.findByText("Etapas do funil — Funil de vendas")).toBeInTheDocument();
    expect(await screen.findByText("Sem etapas")).toBeInTheDocument();
  });

  it("lista as etapas com o rótulo correto por tipo", async () => {
    stagesOrderMock.mockResolvedValue({
      data: [
        {
          id: "s1",
          name: "Novo lead",
          position: 1,
          is_won: false,
          is_lost: false,
          board_id: "board-1",
        },
        { id: "s2", name: "Ganho", position: 2, is_won: true, is_lost: false, board_id: "board-1" },
        {
          id: "s3",
          name: "Perdido",
          position: 3,
          is_won: false,
          is_lost: true,
          board_id: "board-1",
        },
      ],
      error: null,
    });

    renderTab();

    expect(await screen.findByText("Novo lead")).toBeInTheDocument();
    expect(screen.getByText("Etapa intermediária")).toBeInTheDocument();
    expect(screen.getByText("Etapa de ganho")).toBeInTheDocument();
    expect(screen.getByText("Etapa de perda")).toBeInTheDocument();
  });

  it("desabilita mover para cima na primeira etapa e para baixo na última", async () => {
    stagesOrderMock.mockResolvedValue({
      data: [
        { id: "s1", name: "A", position: 1, is_won: false, is_lost: false, board_id: "board-1" },
        { id: "s2", name: "B", position: 2, is_won: false, is_lost: false, board_id: "board-1" },
      ],
      error: null,
    });

    renderTab();
    await screen.findByText("A");

    const upButtons = screen.getAllByRole("button", { name: "Mover para cima" });
    const downButtons = screen.getAllByRole("button", { name: "Mover para baixo" });
    expect(upButtons[0]).toBeDisabled();
    expect(downButtons[downButtons.length - 1]).toBeDisabled();
    expect(upButtons[1]).not.toBeDisabled();
    expect(downButtons[0]).not.toBeDisabled();
  });

  it("reordena ao mover uma etapa para cima, trocando as posições", async () => {
    stagesOrderMock.mockResolvedValue({
      data: [
        { id: "s1", name: "A", position: 1, is_won: false, is_lost: false, board_id: "board-1" },
        { id: "s2", name: "B", position: 2, is_won: false, is_lost: false, board_id: "board-1" },
      ],
      error: null,
    });
    const user = userEvent.setup();
    const { invalidateSpy } = renderTab();
    await screen.findByText("A");

    const upButtons = screen.getAllByRole("button", { name: "Mover para cima" });
    await user.click(upButtons[1]);

    await waitFor(() => expect(stageUpdateMock).toHaveBeenCalledWith({ position: 1 }));
    expect(stageUpdateMock).toHaveBeenCalledWith({ position: 2 });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["board-stages"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["deals"] });
  });

  it("reordena ao mover uma etapa para baixo, trocando as posições", async () => {
    stagesOrderMock.mockResolvedValue({
      data: [
        { id: "s1", name: "A", position: 1, is_won: false, is_lost: false, board_id: "board-1" },
        { id: "s2", name: "B", position: 2, is_won: false, is_lost: false, board_id: "board-1" },
      ],
      error: null,
    });
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("A");

    const downButtons = screen.getAllByRole("button", { name: "Mover para baixo" });
    await user.click(downButtons[0]);

    await waitFor(() => expect(stageUpdateMock).toHaveBeenCalledWith({ position: 2 }));
    expect(stageUpdateMock).toHaveBeenCalledWith({ position: 1 });
  });

  it("mostra toast de erro quando reordenar falha", async () => {
    stagesOrderMock.mockResolvedValue({
      data: [
        { id: "s1", name: "A", position: 1, is_won: false, is_lost: false, board_id: "board-1" },
        { id: "s2", name: "B", position: 2, is_won: false, is_lost: false, board_id: "board-1" },
      ],
      error: null,
    });
    stageUpdateEqMock.mockResolvedValue({ error: new Error("Falha ao reordenar etapas") });
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("A");

    const upButtons = screen.getAllByRole("button", { name: "Mover para cima" });
    await user.click(upButtons[1]);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Falha ao reordenar etapas"));
  });

  it('usa a mensagem padrão "Erro ao reordenar" quando o erro não tem mensagem', async () => {
    stagesOrderMock.mockResolvedValue({
      data: [
        { id: "s1", name: "A", position: 1, is_won: false, is_lost: false, board_id: "board-1" },
        { id: "s2", name: "B", position: 2, is_won: false, is_lost: false, board_id: "board-1" },
      ],
      error: null,
    });
    stageUpdateEqMock.mockResolvedValue({ error: {} });
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("A");

    const upButtons = screen.getAllByRole("button", { name: "Mover para cima" });
    await user.click(upButtons[1]);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Erro ao reordenar"));
  });

  it("abre o dialog de nova etapa, cria com nome e tipo padrão (normal)", async () => {
    const user = userEvent.setup();
    const { invalidateSpy } = renderTab();
    await screen.findByText("Sem etapas");

    await user.click(screen.getByRole("button", { name: "Nova etapa" }));
    expect(await screen.findByText("Nova etapa", { selector: "h2" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Nome *"), "Qualificação");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() =>
      expect(stageInsertMock).toHaveBeenCalledWith({
        name: "Qualificação",
        is_won: false,
        is_lost: false,
        board_id: "board-1",
        position: 1,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Etapa criada");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["board-stages"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["deals"] });
  });

  it("calcula nextPosition com base na última etapa existente", async () => {
    stagesOrderMock.mockResolvedValue({
      data: [
        { id: "s1", name: "A", position: 5, is_won: false, is_lost: false, board_id: "board-1" },
      ],
      error: null,
    });
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("A");

    await user.click(screen.getByRole("button", { name: "Nova etapa" }));
    await user.type(screen.getByLabelText("Nome *"), "Fechamento");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() =>
      expect(stageInsertMock).toHaveBeenCalledWith(expect.objectContaining({ position: 6 })),
    );
  });

  it("marca o tipo 'ganho' e desmarca automaticamente ao marcar 'perda'", async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("Sem etapas");

    await user.click(screen.getByRole("button", { name: "Nova etapa" }));
    await user.type(screen.getByLabelText("Nome *"), "Fim");

    const wonCheckbox = screen.getByRole("checkbox", { name: "Etapa de ganho" });
    const lostCheckbox = screen.getByRole("checkbox", { name: "Etapa de perda" });

    await user.click(wonCheckbox);
    expect(wonCheckbox).toBeChecked();

    await user.click(lostCheckbox);
    expect(lostCheckbox).toBeChecked();
    expect(wonCheckbox).not.toBeChecked();

    await user.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() =>
      expect(stageInsertMock).toHaveBeenCalledWith(
        expect.objectContaining({ is_won: false, is_lost: true }),
      ),
    );
  });

  it("desmarca 'perda' ao clicar novamente (volta para tipo normal)", async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("Sem etapas");

    await user.click(screen.getByRole("button", { name: "Nova etapa" }));
    const lostCheckbox = screen.getByRole("checkbox", { name: "Etapa de perda" });
    await user.click(lostCheckbox);
    expect(lostCheckbox).toBeChecked();
    await user.click(lostCheckbox);
    expect(lostCheckbox).not.toBeChecked();
  });

  it("desmarca 'ganho' ao clicar novamente (volta para tipo normal)", async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("Sem etapas");

    await user.click(screen.getByRole("button", { name: "Nova etapa" }));
    const wonCheckbox = screen.getByRole("checkbox", { name: "Etapa de ganho" });
    await user.click(wonCheckbox);
    expect(wonCheckbox).toBeChecked();
    await user.click(wonCheckbox);
    expect(wonCheckbox).not.toBeChecked();
  });

  it("abre o dialog em modo edição com o tipo pré-selecionado e salva", async () => {
    stagesOrderMock.mockResolvedValue({
      data: [
        { id: "s1", name: "Ganho", position: 1, is_won: true, is_lost: false, board_id: "board-1" },
      ],
      error: null,
    });
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("Ganho");

    await user.click(screen.getByRole("button", { name: "Editar Ganho" }));
    expect(await screen.findByText("Editar etapa")).toBeInTheDocument();
    expect(screen.getByLabelText("Nome *")).toHaveValue("Ganho");
    expect(screen.getByRole("checkbox", { name: "Etapa de ganho" })).toBeChecked();

    await user.clear(screen.getByLabelText("Nome *"));
    await user.type(screen.getByLabelText("Nome *"), "Fechado");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() =>
      expect(stageUpdateMock).toHaveBeenCalledWith({
        name: "Fechado",
        is_won: true,
        is_lost: false,
      }),
    );
    expect(stageUpdateEqMock).toHaveBeenCalledWith("id", "s1");
    expect(toast.success).toHaveBeenCalledWith("Etapa atualizada");
  });

  it("abre o dialog em modo edição para uma etapa de perda com o checkbox correto pré-selecionado", async () => {
    stagesOrderMock.mockResolvedValue({
      data: [
        {
          id: "s1",
          name: "Perdido",
          position: 1,
          is_won: false,
          is_lost: true,
          board_id: "board-1",
        },
      ],
      error: null,
    });
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("Perdido");

    await user.click(screen.getByRole("button", { name: "Editar Perdido" }));
    expect(await screen.findByText("Editar etapa")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Etapa de perda" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Etapa de ganho" })).not.toBeChecked();
  });

  it("mostra toast de erro quando editar (mudando o nome) uma etapa falha ao atualizar", async () => {
    stagesOrderMock.mockResolvedValue({
      data: [
        { id: "s1", name: "Ganho", position: 1, is_won: true, is_lost: false, board_id: "board-1" },
      ],
      error: null,
    });
    stageUpdateEqMock.mockResolvedValue({ error: new Error("Falha ao atualizar etapa") });
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("Ganho");

    await user.click(screen.getByRole("button", { name: "Editar Ganho" }));
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Falha ao atualizar etapa"));
  });

  it("botão Salvar do dialog de etapa fica desabilitado sem nome", async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("Sem etapas");

    await user.click(screen.getByRole("button", { name: "Nova etapa" }));

    expect(screen.getByRole("button", { name: "Salvar" })).toBeDisabled();
  });

  it("cancela o dialog de etapa sem salvar", async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("Sem etapas");

    await user.click(screen.getByRole("button", { name: "Nova etapa" }));
    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    await waitFor(() =>
      expect(screen.queryByText("Nova etapa", { selector: "h2" })).not.toBeInTheDocument(),
    );
    expect(stageInsertMock).not.toHaveBeenCalled();
  });

  it("mostra toast de erro ao salvar etapa com mensagem da exceção", async () => {
    stageInsertMock.mockResolvedValue({ error: new Error("Nome já existe") });
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("Sem etapas");

    await user.click(screen.getByRole("button", { name: "Nova etapa" }));
    await user.type(screen.getByLabelText("Nome *"), "Duplicada");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Nome já existe"));
  });

  it('usa a mensagem padrão "Erro ao salvar" quando o erro da etapa não tem mensagem', async () => {
    stageInsertMock.mockResolvedValue({ error: {} });
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("Sem etapas");

    await user.click(screen.getByRole("button", { name: "Nova etapa" }));
    await user.type(screen.getByLabelText("Nome *"), "Duplicada");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Erro ao salvar"));
  });

  it('mostra "Salvando…" enquanto a mutation de salvar etapa está pendente', async () => {
    let resolveInsert: (value: { error: null }) => void = () => {};
    stageInsertMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInsert = resolve;
        }),
    );
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("Sem etapas");

    await user.click(screen.getByRole("button", { name: "Nova etapa" }));
    await user.type(screen.getByLabelText("Nome *"), "Pendente");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    expect(await screen.findByRole("button", { name: "Salvando…" })).toBeInTheDocument();
    resolveInsert({ error: null });
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it("abre a confirmação de exclusão sem negócios na etapa e exclui direto", async () => {
    stagesOrderMock.mockResolvedValue({
      data: [
        {
          id: "s1",
          name: "Vazia",
          position: 1,
          is_won: false,
          is_lost: false,
          board_id: "board-1",
        },
      ],
      error: null,
    });
    dealsCountHeadMock.mockResolvedValue({ count: 0, error: null });
    const user = userEvent.setup();
    const { invalidateSpy } = renderTab();
    await screen.findByText("Vazia");

    await user.click(screen.getByRole("button", { name: "Excluir Vazia" }));
    expect(await screen.findByText("Excluir etapa")).toBeInTheDocument();
    expect(screen.getByText("Nenhum negócio nesta etapa.")).toBeInTheDocument();

    const confirmButton = screen.getByRole("button", { name: "Excluir" });
    expect(confirmButton).not.toBeDisabled();
    await user.click(confirmButton);

    await waitFor(() => expect(stageDeleteEqMock).toHaveBeenCalledWith("id", "s1"));
    expect(dealsUpdateMock).not.toHaveBeenCalled();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Etapa removida"));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["board-stages"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["deals"] });
  });

  it("trata count nulo da contagem de negócios como zero", async () => {
    stagesOrderMock.mockResolvedValue({
      data: [
        {
          id: "s1",
          name: "Vazia",
          position: 1,
          is_won: false,
          is_lost: false,
          board_id: "board-1",
        },
      ],
      error: null,
    });
    dealsCountHeadMock.mockResolvedValue({ count: null, error: null });
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("Vazia");

    await user.click(screen.getByRole("button", { name: "Excluir Vazia" }));

    expect(await screen.findByText("Nenhum negócio nesta etapa.")).toBeInTheDocument();
  });

  it("não quebra quando a contagem de negócios na etapa falha", async () => {
    stagesOrderMock.mockResolvedValue({
      data: [
        {
          id: "s1",
          name: "Vazia",
          position: 1,
          is_won: false,
          is_lost: false,
          board_id: "board-1",
        },
      ],
      error: null,
    });
    dealsCountHeadMock.mockResolvedValue({ count: null, error: new Error("Falha na contagem") });
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("Vazia");

    await user.click(screen.getByRole("button", { name: "Excluir Vazia" }));

    expect(await screen.findByText("Excluir etapa")).toBeInTheDocument();
    // dealsCount cai para 0 (dealsCountQ.data undefined ?? 0), então trata como sem negócios.
    expect(await screen.findByText("Nenhum negócio nesta etapa.")).toBeInTheDocument();
  });

  it("exige escolher etapa destino quando há negócios e move os deals antes de excluir", async () => {
    stagesOrderMock.mockResolvedValue({
      data: [
        {
          id: "s1",
          name: "Cheia",
          position: 1,
          is_won: false,
          is_lost: false,
          board_id: "board-1",
        },
        {
          id: "s2",
          name: "Destino",
          position: 2,
          is_won: false,
          is_lost: false,
          board_id: "board-1",
        },
      ],
      error: null,
    });
    dealsCountHeadMock.mockResolvedValue({
      count: 3,
      data: [
        { id: "d1", stage_id: "s1" },
        { id: "d2", stage_id: "s1" },
        { id: "d3", stage_id: "s1" },
      ],
      error: null,
    });
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("Cheia");

    await user.click(screen.getByRole("button", { name: "Excluir Cheia" }));
    expect(await screen.findByText("Excluir etapa")).toBeInTheDocument();
    expect(await screen.findByText(/Existem/)).toBeInTheDocument();

    const confirmButton = screen.getByRole("button", { name: "Excluir" });
    expect(confirmButton).toBeDisabled();

    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Destino" }));

    expect(confirmButton).not.toBeDisabled();
    await user.click(confirmButton);

    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(3));
    expect(rpcMock).toHaveBeenCalledWith(
      "transition_deal_stage",
      expect.objectContaining({
        p_deal_id: "d1",
        p_expected_stage_id: "s1",
        p_target_stage_id: "s2",
      }),
    );
    await waitFor(() => expect(stageDeleteEqMock).toHaveBeenCalledWith("id", "s1"));
  });

  it("cancela a exclusão de etapa sem remover nada", async () => {
    stagesOrderMock.mockResolvedValue({
      data: [
        {
          id: "s1",
          name: "Vazia",
          position: 1,
          is_won: false,
          is_lost: false,
          board_id: "board-1",
        },
      ],
      error: null,
    });
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("Vazia");

    await user.click(screen.getByRole("button", { name: "Excluir Vazia" }));
    await screen.findByText("Excluir etapa");
    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    await waitFor(() => expect(screen.queryByText("Excluir etapa")).not.toBeInTheDocument());
    expect(stageDeleteMock).not.toHaveBeenCalled();
  });

  it("fecha a confirmação de exclusão ao pressionar Escape, limpando o estado", async () => {
    stagesOrderMock.mockResolvedValue({
      data: [
        {
          id: "s1",
          name: "Vazia",
          position: 1,
          is_won: false,
          is_lost: false,
          board_id: "board-1",
        },
      ],
      error: null,
    });
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("Vazia");

    await user.click(screen.getByRole("button", { name: "Excluir Vazia" }));
    await screen.findByText("Excluir etapa");
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByText("Excluir etapa")).not.toBeInTheDocument());
    expect(stageDeleteMock).not.toHaveBeenCalled();
  });

  it('mostra "Excluindo…" e desabilita o botão enquanto a exclusão está pendente', async () => {
    stagesOrderMock.mockResolvedValue({
      data: [
        {
          id: "s1",
          name: "Vazia",
          position: 1,
          is_won: false,
          is_lost: false,
          board_id: "board-1",
        },
      ],
      error: null,
    });
    let resolveDelete: (value: { error: null }) => void = () => {};
    stageDeleteEqMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDelete = resolve;
        }),
    );
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("Vazia");

    await user.click(screen.getByRole("button", { name: "Excluir Vazia" }));
    await screen.findByText("Excluir etapa");
    await user.click(screen.getByRole("button", { name: "Excluir" }));

    const pendingButton = await screen.findByRole("button", { name: "Excluindo…" });
    expect(pendingButton).toBeDisabled();

    resolveDelete({ error: null });
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it("mostra toast de erro quando mover os negócios antes de excluir falha", async () => {
    stagesOrderMock.mockResolvedValue({
      data: [
        {
          id: "s1",
          name: "Cheia",
          position: 1,
          is_won: false,
          is_lost: false,
          board_id: "board-1",
        },
        {
          id: "s2",
          name: "Destino",
          position: 2,
          is_won: false,
          is_lost: false,
          board_id: "board-1",
        },
      ],
      error: null,
    });
    dealsCountHeadMock.mockResolvedValue({
      count: 2,
      data: [
        { id: "d1", stage_id: "s1" },
        { id: "d2", stage_id: "s1" },
      ],
      error: null,
    });
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: "Falha ao mover negócios" },
    });
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("Cheia");

    await user.click(screen.getByRole("button", { name: "Excluir Cheia" }));
    await screen.findByText("Excluir etapa");
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Destino" }));
    await user.click(screen.getByRole("button", { name: "Excluir" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Falha ao mover negócios"));
    expect(stageDeleteMock).not.toHaveBeenCalled();
  });

  it("mostra toast de erro quando excluir a etapa falha", async () => {
    stagesOrderMock.mockResolvedValue({
      data: [
        {
          id: "s1",
          name: "Vazia",
          position: 1,
          is_won: false,
          is_lost: false,
          board_id: "board-1",
        },
      ],
      error: null,
    });
    stageDeleteEqMock.mockResolvedValue({ error: new Error("Falha ao excluir etapa") });
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("Vazia");

    await user.click(screen.getByRole("button", { name: "Excluir Vazia" }));
    await screen.findByText("Excluir etapa");
    await user.click(screen.getByRole("button", { name: "Excluir" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Falha ao excluir etapa"));
  });

  it('usa a mensagem padrão "Erro ao remover" quando o erro de exclusão de etapa não tem mensagem', async () => {
    stagesOrderMock.mockResolvedValue({
      data: [
        {
          id: "s1",
          name: "Vazia",
          position: 1,
          is_won: false,
          is_lost: false,
          board_id: "board-1",
        },
      ],
      error: null,
    });
    stageDeleteEqMock.mockResolvedValue({ error: {} });
    const user = userEvent.setup();
    renderTab();
    await screen.findByText("Vazia");

    await user.click(screen.getByRole("button", { name: "Excluir Vazia" }));
    await screen.findByText("Excluir etapa");
    await user.click(screen.getByRole("button", { name: "Excluir" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Erro ao remover"));
  });
});
