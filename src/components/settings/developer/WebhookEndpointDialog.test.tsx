import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { useBoardStagesForBoard } from "@/hooks/use-decision-queue";
import { useBoards } from "@/lib/api/boards";
import { useAllowedWebhookEventTypes, type WebhookEndpoint } from "@/lib/api/developer";
import { renderWithQueryClient } from "@/test/render";
import { queryResult } from "./test-helpers";
import { WebhookEndpointDialog } from "./WebhookEndpointDialog";

vi.mock("@/lib/api/developer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/developer")>()),
  useAllowedWebhookEventTypes: vi.fn(),
}));
vi.mock("@/lib/api/boards", () => ({ useBoards: vi.fn() }));
vi.mock("@/hooks/use-decision-queue", () => ({ useBoardStagesForBoard: vi.fn() }));

const STAGES: Record<string, { id: string; name: string; position: number }[]> = {
  "b-evento": [
    { id: "s-proposta", name: "Proposta", position: 0 },
    { id: "s-pago", name: "Pago", position: 1 },
  ],
  "b-vendas": [{ id: "s-novo", name: "Novo", position: 0 }],
};

const EDITING: WebhookEndpoint = {
  id: "e1",
  url: "https://erp.exemplo.com.br/hook",
  description: "ERP",
  event_types: ["deal.won"],
  board_ids: ["b-evento"],
  stage_ids: ["s-pago"],
  active: false,
  disabled_reason: "filter_target_deleted",
  previous_secret_expires_at: null,
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-01T10:00:00Z",
};

function setup(initial?: WebhookEndpoint) {
  vi.mocked(useAllowedWebhookEventTypes).mockReturnValue(
    queryResult(["deal.won", "deal.stage_changed"]) as unknown as ReturnType<
      typeof useAllowedWebhookEventTypes
    >,
  );
  vi.mocked(useBoards).mockReturnValue(
    queryResult([
      { id: "b-evento", name: "Evento", is_default: false, position: 0 },
      { id: "b-vendas", name: "Vendas", is_default: true, position: 1 },
    ]) as unknown as ReturnType<typeof useBoards>,
  );
  vi.mocked(useBoardStagesForBoard).mockImplementation(
    (boardId) =>
      queryResult(boardId ? (STAGES[boardId] ?? []) : undefined) as unknown as ReturnType<
        typeof useBoardStagesForBoard
      >,
  );
  const onSubmit = vi.fn(async (_input: unknown) => undefined);
  renderWithQueryClient(
    <WebhookEndpointDialog open onOpenChange={vi.fn()} onSubmit={onSubmit} initial={initial} />,
  );
  return { onSubmit, dialog: screen.getByRole("dialog") };
}

async function chooseBoard(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("combobox", { name: "Funil" }));
  await user.click(await screen.findByRole("option", { name }));
}

beforeEach(() => vi.clearAllMocks());

describe("WebhookEndpointDialog: filtro por funil e etapa", () => {
  it("funil e etapa Pago escolhidos vão no onSubmit", async () => {
    const user = userEvent.setup();
    const { onSubmit, dialog } = setup();
    await user.type(within(dialog).getByLabelText("URL de destino"), "https://a.exemplo.com.br/h");
    await user.click(within(dialog).getByRole("checkbox", { name: "deal.won" }));
    await chooseBoard(user, "Evento");
    await user.click(within(dialog).getByRole("checkbox", { name: "Pago" }));
    await user.click(within(dialog).getByRole("button", { name: "Criar webhook" }));
    expect(onSubmit).toHaveBeenCalledWith({
      url: "https://a.exemplo.com.br/h",
      eventTypes: ["deal.won"],
      description: null,
      boardIds: ["b-evento"],
      stageIds: ["s-pago"],
    });
  });

  it("Todos os funis desabilita etapas e envia arrays vazios", async () => {
    const user = userEvent.setup();
    const { onSubmit, dialog } = setup();
    expect(within(dialog).getByRole("combobox", { name: "Funil" })).toHaveTextContent(
      "Todos os funis",
    );
    expect(within(dialog).queryAllByRole("checkbox", { name: "Pago" })).toHaveLength(0);
    expect(within(dialog).getByText(/Escolha um funil para filtrar por etapa/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("URL de destino"), "https://a.exemplo.com.br/h");
    await user.click(within(dialog).getByRole("checkbox", { name: "deal.won" }));
    await user.click(within(dialog).getByRole("button", { name: "Criar webhook" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ boardIds: [], stageIds: [] }));
  });

  it("trocar de funil limpa as etapas marcadas", async () => {
    const user = userEvent.setup();
    const { onSubmit, dialog } = setup();
    await user.type(within(dialog).getByLabelText("URL de destino"), "https://a.exemplo.com.br/h");
    await user.click(within(dialog).getByRole("checkbox", { name: "deal.won" }));
    await chooseBoard(user, "Evento");
    await user.click(within(dialog).getByRole("checkbox", { name: "Pago" }));
    await chooseBoard(user, "Vendas");
    expect(within(dialog).getByRole("checkbox", { name: "Novo" })).not.toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: "Criar webhook" }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ boardIds: ["b-vendas"], stageIds: [] }),
    );
  });

  it("modo edição preenche url, eventos e filtros e salva", async () => {
    const user = userEvent.setup();
    const { onSubmit, dialog } = setup(EDITING);
    expect(within(dialog).getByRole("heading", { name: "Editar webhook" })).toBeInTheDocument();
    expect(within(dialog).getByLabelText("URL de destino")).toHaveValue(EDITING.url);
    expect(within(dialog).getByRole("checkbox", { name: "deal.won" })).toBeChecked();
    expect(within(dialog).getByRole("combobox", { name: "Funil" })).toHaveTextContent("Evento");
    expect(within(dialog).getByRole("checkbox", { name: "Pago" })).toBeChecked();
    expect(
      within(dialog).getByText(/você recebe deal.won e deal.stage_changed/),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Salvar" }));
    expect(onSubmit).toHaveBeenCalledWith({
      url: EDITING.url,
      eventTypes: ["deal.won"],
      description: "ERP",
      boardIds: ["b-evento"],
      stageIds: ["s-pago"],
    });
  });
});

describe("WebhookEndpointDialog: etapa apagada no filtro", () => {
  const WITH_GHOST: WebhookEndpoint = { ...EDITING, stage_ids: ["s-pago", "s-apagada"] };

  it("id que não existe mais aparece como Etapa apagada marcada e bloqueia salvar", async () => {
    const user = userEvent.setup();
    const { onSubmit, dialog } = setup(WITH_GHOST);
    const ghost = within(dialog).getByRole("checkbox", { name: "Etapa apagada" });
    expect(ghost).toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: "Salvar" }));
    expect(
      await within(dialog).findByText("Desmarque as etapas apagadas para salvar."),
    ).toBeVisible();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("desmarcar a etapa apagada permite salvar sem o id inválido", async () => {
    const user = userEvent.setup();
    const { onSubmit, dialog } = setup(WITH_GHOST);
    await user.click(within(dialog).getByRole("checkbox", { name: "Etapa apagada" }));
    expect(within(dialog).queryByRole("checkbox", { name: "Etapa apagada" })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Salvar" }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ boardIds: ["b-evento"], stageIds: ["s-pago"] }),
    );
  });

  it("desmarcar tudo avisa que o filtro vale para todas as etapas do funil", async () => {
    const user = userEvent.setup();
    const { onSubmit, dialog } = setup({ ...EDITING, stage_ids: ["s-apagada"] });
    expect(within(dialog).queryByText(/vale para todas as etapas do funil/)).toBeNull();
    await user.click(within(dialog).getByRole("checkbox", { name: "Etapa apagada" }));
    expect(
      within(dialog).getByText("Nenhuma etapa marcada: vale para todas as etapas do funil Evento."),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Salvar" }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ boardIds: ["b-evento"], stageIds: [] }),
    );
  });

  it("enquanto os funis carregam mostra carregando no lugar do seletor", () => {
    vi.mocked(useAllowedWebhookEventTypes).mockReturnValue(
      queryResult(["deal.won"]) as unknown as ReturnType<typeof useAllowedWebhookEventTypes>,
    );
    vi.mocked(useBoards).mockReturnValue(
      queryResult(undefined, { isLoading: true }) as unknown as ReturnType<typeof useBoards>,
    );
    vi.mocked(useBoardStagesForBoard).mockReturnValue(
      queryResult(undefined) as unknown as ReturnType<typeof useBoardStagesForBoard>,
    );
    renderWithQueryClient(<WebhookEndpointDialog open onOpenChange={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.getByRole("status", { name: "Carregando funis" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Funil" })).toBeNull();
  });
});
