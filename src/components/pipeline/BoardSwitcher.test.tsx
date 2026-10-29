import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { renderWithQueryClient } from "@/test/render";
import { asFromMock, createQueryBuilder, fail, ok } from "@/test/supabase-mock";
import { BoardSwitcher, boardStorageKey, type Board } from "./BoardSwitcher";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const BOARDS: Board[] = [{ id: "b0", name: "Padrão", is_default: true, position: 0 }];

beforeEach(() => {
  localStorage.clear();
});

describe("BoardSwitcher — criação de quadro", () => {
  it("remove o quadro recém-criado se a criação das etapas falhar (sem quadro órfão)", async () => {
    const boardsCalls: Array<ReturnType<typeof createQueryBuilder>> = [];
    vi.mocked(supabase.from).mockImplementation(
      asFromMock((table: string) => {
        if (table === "boards") {
          const builder = createQueryBuilder(ok({ id: "novo-board" }));
          boardsCalls.push(builder);
          return builder;
        }
        if (table === "board_stages") {
          return createQueryBuilder(fail("stage insert falhou"));
        }
        return createQueryBuilder(ok(null));
      }),
    );

    renderWithQueryClient(
      <BoardSwitcher
        tenantId="t1"
        isAdmin
        boards={BOARDS}
        boardsLoading={false}
        selectedBoardId="b0"
        onSelect={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Gerenciar quadros" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /novo quadro/i }));
    await userEvent.type(screen.getByLabelText(/nome do quadro/i), "Quadro extra");
    await userEvent.click(screen.getByRole("button", { name: "Criar quadro" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());

    // 1ª chamada em "boards" = insert do quadro; 2ª = delete de rollback.
    expect(boardsCalls).toHaveLength(2);
    expect(boardsCalls[1].delete).toHaveBeenCalled();
    expect(boardsCalls[1].eq).toHaveBeenCalledWith("id", "novo-board");
  });
});

const BOARD_WITH_GOAL: Board[] = [
  {
    id: "b0",
    name: "Padrão",
    is_default: true,
    position: 0,
    goal_target: 10,
    goal_period: "monthly",
  },
];

describe("BoardSwitcher — meta do quadro", () => {
  it("mostra a barra de progresso 'X/meta' quando o board tem goal_target", () => {
    renderWithQueryClient(
      <BoardSwitcher
        tenantId="t1"
        isAdmin={false}
        boards={BOARD_WITH_GOAL}
        boardsLoading={false}
        selectedBoardId="b0"
        onSelect={vi.fn()}
        activeDealsCount={3}
      />,
    );

    expect(screen.getByText(/Objetivo \(mensal\): 3\/10/)).toBeInTheDocument();
    expect(screen.getByText("30%")).toBeInTheDocument();
  });

  it("não mostra a barra de progresso quando o board não tem meta definida", () => {
    renderWithQueryClient(
      <BoardSwitcher
        tenantId="t1"
        isAdmin={false}
        boards={BOARDS}
        boardsLoading={false}
        selectedBoardId="b0"
        onSelect={vi.fn()}
        activeDealsCount={3}
      />,
    );

    expect(screen.queryByText(/Objetivo/)).not.toBeInTheDocument();
  });

  it("admin edita e salva goal_target/goal_period do board selecionado", async () => {
    const boardsCalls: Array<ReturnType<typeof createQueryBuilder>> = [];
    vi.mocked(supabase.from).mockImplementation(
      asFromMock((table: string) => {
        if (table === "boards") {
          const builder = createQueryBuilder(ok(null));
          boardsCalls.push(builder);
          return builder;
        }
        return createQueryBuilder(ok(null));
      }),
    );

    renderWithQueryClient(
      <BoardSwitcher
        tenantId="t1"
        isAdmin
        boards={BOARDS}
        boardsLoading={false}
        selectedBoardId="b0"
        onSelect={vi.fn()}
        activeDealsCount={5}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Gerenciar quadros" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /editar meta/i }));

    await userEvent.type(screen.getByLabelText(/quantidade de negócios ativos/i), "25");
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(boardsCalls).toHaveLength(1));
    expect(boardsCalls[0].update).toHaveBeenCalledWith({ goal_target: 25, goal_period: null });
    expect(boardsCalls[0].eq).toHaveBeenCalledWith("id", "b0");
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Meta do quadro atualizada."));
  });

  it("rejeita meta <= 0 sem chamar o update", async () => {
    renderWithQueryClient(
      <BoardSwitcher
        tenantId="t1"
        isAdmin
        boards={BOARDS}
        boardsLoading={false}
        selectedBoardId="b0"
        onSelect={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Gerenciar quadros" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /editar meta/i }));

    await userEvent.type(screen.getByLabelText(/quantidade de negócios ativos/i), "0");
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));

    expect(toast.error).toHaveBeenCalledWith("Meta deve ser um número maior que zero.");
    expect(supabase.from).not.toHaveBeenCalledWith("boards");
  });

  it("remove a meta ao limpar o campo (goal_target vira null)", async () => {
    const boardsCalls: Array<ReturnType<typeof createQueryBuilder>> = [];
    vi.mocked(supabase.from).mockImplementation(
      asFromMock((table: string) => {
        if (table === "boards") {
          const builder = createQueryBuilder(ok(null));
          boardsCalls.push(builder);
          return builder;
        }
        return createQueryBuilder(ok(null));
      }),
    );

    renderWithQueryClient(
      <BoardSwitcher
        tenantId="t1"
        isAdmin
        boards={BOARD_WITH_GOAL}
        boardsLoading={false}
        selectedBoardId="b0"
        onSelect={vi.fn()}
        activeDealsCount={3}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Gerenciar quadros" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /editar meta/i }));

    await userEvent.clear(screen.getByLabelText(/quantidade de negócios ativos/i));
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(boardsCalls).toHaveLength(1));
    expect(boardsCalls[0].update).toHaveBeenCalledWith({
      goal_target: null,
      goal_period: "monthly",
    });
    expect(boardsCalls[0].eq).toHaveBeenCalledWith("id", "b0");
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Meta do quadro atualizada."));
  });

  it("salva a cadência escolhida (não-default) junto com a meta", async () => {
    const boardsCalls: Array<ReturnType<typeof createQueryBuilder>> = [];
    vi.mocked(supabase.from).mockImplementation(
      asFromMock((table: string) => {
        if (table === "boards") {
          const builder = createQueryBuilder(ok(null));
          boardsCalls.push(builder);
          return builder;
        }
        return createQueryBuilder(ok(null));
      }),
    );

    renderWithQueryClient(
      <BoardSwitcher
        tenantId="t1"
        isAdmin
        boards={BOARDS}
        boardsLoading={false}
        selectedBoardId="b0"
        onSelect={vi.fn()}
        activeDealsCount={5}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Gerenciar quadros" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /editar meta/i }));

    await userEvent.type(screen.getByLabelText(/quantidade de negócios ativos/i), "20");
    await userEvent.click(screen.getByLabelText(/cadência/i));
    await userEvent.click(await screen.findByRole("option", { name: "Semanal" }));
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(boardsCalls).toHaveLength(1));
    expect(boardsCalls[0].update).toHaveBeenCalledWith({
      goal_target: 20,
      goal_period: "weekly",
    });
    expect(boardsCalls[0].eq).toHaveBeenCalledWith("id", "b0");
  });

  it("mostra toast de erro quando salvar a meta falha", async () => {
    vi.mocked(supabase.from).mockImplementation(
      asFromMock(() => createQueryBuilder(fail("permissão negada"))),
    );

    renderWithQueryClient(
      <BoardSwitcher
        tenantId="t1"
        isAdmin
        boards={BOARDS}
        boardsLoading={false}
        selectedBoardId="b0"
        onSelect={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Gerenciar quadros" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /editar meta/i }));
    await userEvent.type(screen.getByLabelText(/quantidade de negócios ativos/i), "15");
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));

    // getErrorMessage só usa error.message quando `error instanceof Error` —
    // o erro do Postgrest é um objeto plano ({message}), então cai sempre no
    // fallback genérico (nunca mostra a mensagem real do banco).
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Não foi possível atualizar a meta do quadro."),
    );
  });
});

const BOARDS_TWO: Board[] = [
  { id: "b0", name: "Padrão", is_default: true, position: 0 },
  { id: "b1", name: "Extra", is_default: false, position: 1 },
];

describe("BoardSwitcher — seleção de quadro", () => {
  it("seleciona um quadro pelo combobox principal, persiste no localStorage e chama onSelect", async () => {
    const onSelect = vi.fn();
    renderWithQueryClient(
      <BoardSwitcher
        tenantId="t1"
        isAdmin={false}
        boards={BOARDS_TWO}
        boardsLoading={false}
        selectedBoardId="b0"
        onSelect={onSelect}
      />,
    );

    await userEvent.click(screen.getByRole("combobox", { name: "Selecionar quadro" }));
    await userEvent.click(await screen.findByRole("option", { name: "Extra" }));

    expect(onSelect).toHaveBeenCalledWith("b1");
    expect(localStorage.getItem(boardStorageKey("t1"))).toBe("b1");
  });

  it("não renderiza nada enquanto os quadros ainda estão carregando", () => {
    renderWithQueryClient(
      <BoardSwitcher
        tenantId="t1"
        isAdmin
        boards={[]}
        boardsLoading
        selectedBoardId={undefined}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("não renderiza nada quando não há nenhum quadro (mesmo com boardsLoading=false)", () => {
    renderWithQueryClient(
      <BoardSwitcher
        tenantId="t1"
        isAdmin
        boards={[]}
        boardsLoading={false}
        selectedBoardId={undefined}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("esconde o menu de gestão (criar/renomear/remover/meta) para usuário não-admin", () => {
    renderWithQueryClient(
      <BoardSwitcher
        tenantId="t1"
        isAdmin={false}
        boards={BOARDS_TWO}
        boardsLoading={false}
        selectedBoardId="b0"
        onSelect={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Gerenciar quadros" })).not.toBeInTheDocument();
  });
});

describe("BoardSwitcher — criação de quadro (fluxo completo)", () => {
  it("cria um quadro com sucesso: toast, fecha o diálogo e seleciona o novo quadro", async () => {
    const onSelect = vi.fn();
    vi.mocked(supabase.from).mockImplementation(
      asFromMock((table: string) => {
        if (table === "boards") return createQueryBuilder(ok({ id: "novo-board" }));
        return createQueryBuilder(ok(null));
      }),
    );

    renderWithQueryClient(
      <BoardSwitcher
        tenantId="t1"
        isAdmin
        boards={BOARDS}
        boardsLoading={false}
        selectedBoardId="b0"
        onSelect={onSelect}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Gerenciar quadros" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /novo quadro/i }));
    await userEvent.type(screen.getByLabelText(/nome do quadro/i), "Pós-venda");
    await userEvent.click(screen.getByRole("button", { name: "Criar quadro" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Quadro criado."));
    expect(onSelect).toHaveBeenCalledWith("novo-board");
    expect(localStorage.getItem(boardStorageKey("t1"))).toBe("novo-board");
    expect(screen.queryByRole("heading", { name: "Novo quadro" })).not.toBeInTheDocument();
  });

  it("mostra 'Tenant não identificado.' e não chama a API quando tenantId está ausente", async () => {
    renderWithQueryClient(
      <BoardSwitcher
        tenantId={undefined}
        isAdmin
        boards={BOARDS}
        boardsLoading={false}
        selectedBoardId="b0"
        onSelect={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Gerenciar quadros" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /novo quadro/i }));
    await userEvent.type(screen.getByLabelText(/nome do quadro/i), "Pós-venda");
    await userEvent.click(screen.getByRole("button", { name: "Criar quadro" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Empresa não identificada."));
    expect(supabase.from).not.toHaveBeenCalled();
  });
});

describe("BoardSwitcher — cancelar sem persistir", () => {
  it("fecha cada diálogo de gestão ao clicar em Cancelar, sem chamar a API", async () => {
    renderWithQueryClient(
      <BoardSwitcher
        tenantId="t1"
        isAdmin
        boards={BOARDS_TWO}
        boardsLoading={false}
        selectedBoardId="b1"
        onSelect={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Gerenciar quadros" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /novo quadro/i }));
    expect(await screen.findByRole("heading", { name: "Novo quadro" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Novo quadro" })).not.toBeInTheDocument(),
    );

    await userEvent.click(screen.getByRole("button", { name: "Gerenciar quadros" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /renomear quadro/i }));
    expect(await screen.findByRole("heading", { name: "Renomear quadro" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Renomear quadro" })).not.toBeInTheDocument(),
    );

    await userEvent.click(screen.getByRole("button", { name: "Gerenciar quadros" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /remover quadro/i }));
    expect(await screen.findByRole("heading", { name: "Remover quadro" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Remover quadro" })).not.toBeInTheDocument(),
    );

    await userEvent.click(screen.getByRole("button", { name: "Gerenciar quadros" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /editar meta/i }));
    expect(
      await screen.findByRole("heading", { name: "Editar meta do quadro" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Editar meta do quadro" }),
      ).not.toBeInTheDocument(),
    );

    expect(supabase.from).not.toHaveBeenCalled();
  });
});

describe("BoardSwitcher — renomear quadro", () => {
  it("renomeia um quadro com sucesso", async () => {
    const boardsCalls: Array<ReturnType<typeof createQueryBuilder>> = [];
    vi.mocked(supabase.from).mockImplementation(
      asFromMock((table: string) => {
        if (table === "boards") {
          const builder = createQueryBuilder(ok(null));
          boardsCalls.push(builder);
          return builder;
        }
        return createQueryBuilder(ok(null));
      }),
    );

    renderWithQueryClient(
      <BoardSwitcher
        tenantId="t1"
        isAdmin
        boards={BOARDS}
        boardsLoading={false}
        selectedBoardId="b0"
        onSelect={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Gerenciar quadros" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /renomear quadro/i }));
    await userEvent.clear(screen.getByLabelText(/nome do quadro/i));
    await userEvent.type(screen.getByLabelText(/nome do quadro/i), "Padrão renomeado");
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(boardsCalls).toHaveLength(1));
    expect(boardsCalls[0].update).toHaveBeenCalledWith({ name: "Padrão renomeado" });
    expect(boardsCalls[0].eq).toHaveBeenCalledWith("id", "b0");
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Quadro renomeado."));
    expect(screen.queryByRole("heading", { name: "Renomear quadro" })).not.toBeInTheDocument();
  });

  it("mostra toast de erro quando renomear falha", async () => {
    vi.mocked(supabase.from).mockImplementation(
      asFromMock(() => createQueryBuilder(fail("nome duplicado"))),
    );

    renderWithQueryClient(
      <BoardSwitcher
        tenantId="t1"
        isAdmin
        boards={BOARDS}
        boardsLoading={false}
        selectedBoardId="b0"
        onSelect={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Gerenciar quadros" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /renomear quadro/i }));
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));

    // Erro do Postgrest é um objeto plano, não `instanceof Error` — o toast
    // sempre mostra o fallback genérico, nunca a mensagem real do banco.
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Não foi possível renomear o quadro."),
    );
    expect(screen.getByRole("heading", { name: "Renomear quadro" })).toBeInTheDocument();
  });
});

describe("BoardSwitcher — remover quadro", () => {
  it("remove um quadro com sucesso e seleciona o quadro remanescente (fallback)", async () => {
    const onSelect = vi.fn();
    const boardsCalls: Array<ReturnType<typeof createQueryBuilder>> = [];
    vi.mocked(supabase.from).mockImplementation(
      asFromMock((table: string) => {
        if (table === "boards") {
          const builder = createQueryBuilder(ok(null));
          boardsCalls.push(builder);
          return builder;
        }
        return createQueryBuilder(ok(null));
      }),
    );

    renderWithQueryClient(
      <BoardSwitcher
        tenantId="t1"
        isAdmin
        boards={BOARDS_TWO}
        boardsLoading={false}
        selectedBoardId="b1"
        onSelect={onSelect}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Gerenciar quadros" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /remover quadro/i }));
    expect(screen.getByText(/todos os negócios de.*extra.*serão removidos/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remover" }));

    await waitFor(() => expect(boardsCalls).toHaveLength(1));
    expect(boardsCalls[0].delete).toHaveBeenCalled();
    expect(boardsCalls[0].eq).toHaveBeenCalledWith("id", "b1");
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Quadro removido."));
    // Fallback: único quadro restante é "b0" (Padrão).
    expect(onSelect).toHaveBeenCalledWith("b0");
  });

  it("mostra toast de erro quando remover falha", async () => {
    vi.mocked(supabase.from).mockImplementation(
      asFromMock(() => createQueryBuilder(fail("negócios vinculados"))),
    );

    renderWithQueryClient(
      <BoardSwitcher
        tenantId="t1"
        isAdmin
        boards={BOARDS_TWO}
        boardsLoading={false}
        selectedBoardId="b1"
        onSelect={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Gerenciar quadros" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /remover quadro/i }));
    await userEvent.click(screen.getByRole("button", { name: "Remover" }));

    // Mesma limitação de getErrorMessage: erro do Postgrest não é
    // `instanceof Error`, então cai no fallback genérico.
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Não foi possível remover o quadro."),
    );
  });
});
