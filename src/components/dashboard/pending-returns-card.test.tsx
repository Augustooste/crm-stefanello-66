import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { usePendingReturns, type PendingReturn } from "@/lib/api/dashboard-widgets";
import { PendingReturnsCard } from "./pending-returns-card";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { routerOverrides } = await import("@/test/router-mocks");
  return { ...actual, ...routerOverrides() };
});

vi.mock("@/lib/api/dashboard-widgets", () => ({ usePendingReturns: vi.fn() }));

const pendingReturnsMock = vi.mocked(usePendingReturns);

function renderCard(ownerId: string | null = null, boardId: string | null = null) {
  return render(<PendingReturnsCard ownerId={ownerId} boardId={boardId} />);
}

describe("PendingReturnsCard", () => {
  it("mostra 4 skeletons enquanto carrega", () => {
    pendingReturnsMock.mockReturnValue({
      isLoading: true,
      isError: false,
      data: undefined,
    } as never);

    const { container } = renderCard();

    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(4);
  });

  it("mostra estado de erro com a mensagem do erro", () => {
    pendingReturnsMock.mockReturnValue({
      isLoading: false,
      isError: true,
      error: new Error("Falha ao buscar retornos"),
      data: undefined,
    } as never);

    renderCard();

    expect(screen.getByText("Não foi possível carregar")).toBeInTheDocument();
    expect(screen.getByText("Falha ao buscar retornos")).toBeInTheDocument();
  });

  it("mostra mensagem padrão de erro quando o erro não tem 'message'", () => {
    pendingReturnsMock.mockReturnValue({
      isLoading: false,
      isError: true,
      error: {},
      data: undefined,
    } as never);

    renderCard();

    expect(screen.getByText("Tente novamente em instantes.")).toBeInTheDocument();
  });

  it("mostra estado vazio quando não há retornos pendentes", () => {
    pendingReturnsMock.mockReturnValue({ isLoading: false, isError: false, data: [] } as never);

    renderCard();

    expect(screen.getByText("Nenhum retorno pendente")).toBeInTheDocument();
    expect(
      screen.getByText("Todos os retornos e tarefas agendadas nos próximos 14 dias estão em dia."),
    ).toBeInTheDocument();
  });

  it("mostra estado vazio quando data é undefined (query desabilitada, ex.: sem tenant ainda)", () => {
    pendingReturnsMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: undefined,
    } as never);

    renderCard();

    expect(screen.getByText("Nenhum retorno pendente")).toBeInTheDocument();
  });

  it("renderiza itens vencidos com badge 'Vencido' e link para o contato", () => {
    const now = Date.now();
    const past = new Date(now - 2 * 86_400_000).toISOString();
    const items: PendingReturn[] = [
      {
        id: "a1",
        kind: "activity",
        title: "Ligar de volta",
        contactId: "c1",
        scheduledAt: past,
        overdue: true,
      },
    ];
    pendingReturnsMock.mockReturnValue({ isLoading: false, isError: false, data: items } as never);

    renderCard();

    expect(screen.getByText("Ligar de volta")).toBeInTheDocument();
    expect(screen.getByText("Vencido")).toBeInTheDocument();
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/contatos/c1");
  });

  it("renderiza itens não vencidos com tempo relativo e sem link quando não há contactId", () => {
    const future = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const items: PendingReturn[] = [
      {
        id: "f1",
        kind: "followup",
        title: "Retorno agendado",
        contactId: null,
        scheduledAt: future,
        overdue: false,
      },
    ];
    pendingReturnsMock.mockReturnValue({ isLoading: false, isError: false, data: items } as never);

    renderCard();

    expect(screen.getByText("Retorno agendado")).toBeInTheDocument();
    expect(screen.queryByText("Vencido")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
