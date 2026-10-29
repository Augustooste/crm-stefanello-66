import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile } from "@/lib/api/session";
import { useDashboardReport } from "@/lib/api/reports";
import { formatBRL } from "@/lib/format";
import { useGlobalPeriod } from "@/lib/view-prefs/use-global-period";
import { renderWithQueryClient } from "@/test/render";
import {
  asFromMock,
  createFromQueue,
  createPendingQueryBuilder,
  fail,
  ok,
} from "@/test/supabase-mock";
import { Route } from "./_app.app";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { routerOverrides } = await import("@/test/router-mocks");
  return { ...actual, ...routerOverrides() };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(() => Promise.resolve({ data: null, error: null })) },
}));

vi.mock("@/lib/api/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/session")>();
  return {
    ...actual,
    useCurrentProfile: vi.fn(() => ({ data: undefined })),
    useTenantProfiles: vi.fn(() => ({ data: [] })),
  };
});

vi.mock("@/lib/api/boards", () => ({
  useBoards: vi.fn(() => ({ data: [] })),
}));

vi.mock("@/lib/api/reports", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/reports")>();
  return {
    ...actual,
    useDashboardReport: vi.fn(() => ({ isLoading: false, isError: false, data: undefined })),
  };
});

// Período global controlável por teste; por padrão delega ao hook real.
vi.mock("@/lib/view-prefs/use-global-period", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/view-prefs/use-global-period")>();
  return { ...actual, useGlobalPeriod: vi.fn(actual.useGlobalPeriod) };
});

// Filtros simplificados: botões que acionam os mesmos callbacks do componente real.
vi.mock("@/components/dashboard/dashboard-filters", () => ({
  DashboardFilters: ({
    onOwnerChange,
    onBoardChange,
  }: {
    onOwnerChange: (ownerId: string | null) => void;
    onBoardChange: (boardId: string | null) => void;
  }) => (
    <div>
      <button type="button" onClick={() => onBoardChange("quadro-a")}>
        filtrar quadro A
      </button>
      <button type="button" onClick={() => onBoardChange(null)}>
        todos os quadros
      </button>
      <button type="button" onClick={() => onOwnerChange("dono-b")}>
        filtrar responsável B
      </button>
    </div>
  ),
}));

type FakeRow = Record<string, unknown>;

/** Valores em um caminho com pontos ("deal.board_id"), achatando relações 1:N. */
function valuesAt(value: unknown, path: string[]): unknown[] {
  if (Array.isArray(value)) return value.flatMap((v) => valuesAt(v, path));
  if (path.length === 0) return [value];
  if (value === null || typeof value !== "object") return [];
  return valuesAt((value as FakeRow)[path[0]], path.slice(1));
}

/**
 * Tabela em memória que aplica de verdade eq/is/gte/gt/lte/lt/limit, para
 * que o teste verifique o RESULTADO dos filtros (e não a ordem das chamadas).
 * Métodos não modelados devolvem o próprio builder.
 */
function fakeTable(rows: FakeRow[]) {
  const predicates: Array<(row: FakeRow) => boolean> = [];
  let head = false;
  let limit: number | undefined;
  const at = (row: FakeRow, column: string) => valuesAt(row, column.split("."));
  const compare = (column: string, value: string, test: (a: number, b: number) => boolean) =>
    predicates.push((row) =>
      at(row, column).some((v) => typeof v === "string" && test(Date.parse(v), Date.parse(value))),
    );
  const result = () => {
    const filtered = rows.filter((row) => predicates.every((p) => p(row)));
    return {
      data: head ? null : filtered.slice(0, limit ?? filtered.length),
      count: filtered.length,
      error: null,
    };
  };
  const impl: Record<string, (...args: never[]) => unknown> = {
    select: (_columns: string, options?: { head?: boolean }) => {
      head = Boolean(options?.head);
      return proxy;
    },
    eq: (column: string, value: unknown) => {
      predicates.push((row) => at(row, column).some((v) => v === value));
      return proxy;
    },
    is: (column: string, value: null) => {
      predicates.push((row) => at(row, column).every((v) => v === value || v === undefined));
      return proxy;
    },
    gte: (column: string, value: string) => (compare(column, value, (a, b) => a >= b), proxy),
    gt: (column: string, value: string) => (compare(column, value, (a, b) => a > b), proxy),
    lte: (column: string, value: string) => (compare(column, value, (a, b) => a <= b), proxy),
    lt: (column: string, value: string) => (compare(column, value, (a, b) => a < b), proxy),
    limit: (n: number) => ((limit = n), proxy),
    single: () => Promise.resolve({ ...result(), data: result().data?.[0] ?? null }),
    maybeSingle: () => Promise.resolve({ ...result(), data: result().data?.[0] ?? null }),
    then: ((onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(result()).then(onFulfilled, onRejected)) as never,
  };
  const proxy: unknown = new Proxy(impl, {
    get: (target, prop) => {
      if (typeof prop === "symbol") return undefined;
      return target[prop] ?? (() => proxy);
    },
  });
  return proxy;
}

/** Texto exibido por formatBRL, com espaços normalizados como o Testing Library faz. */
function brl(value: number) {
  return formatBRL(value).replace(/\s/g, " ");
}

const DashboardPage = Route.options.component!;

describe("head() da rota do dashboard", () => {
  it("define título e descrição de SEO", async () => {
    const head = await Route.options.head?.({} as never);
    const titleMeta = head?.meta?.find((m) => m && "title" in m);
    expect(titleMeta).toMatchObject({ title: "Visão Geral" });
    const descriptionMeta = head?.meta?.find((m) => m && "name" in m && m.name === "description");
    expect(descriptionMeta).toMatchObject({
      content: "O pulso do seu negócio em tempo real: funil, receita, saúde da carteira e IA.",
    });
  });
});

describe("dashboard (/_app/app)", () => {
  beforeEach(() => {
    vi.mocked(useCurrentProfile).mockReturnValue({ data: undefined } as never);
    vi.mocked(useDashboardReport).mockReturnValue({
      isLoading: false,
      isError: false,
      data: undefined,
    } as never);
  });

  it("mostra o título 'Visão Geral' e skeletons enquanto os KPIs carregam", () => {
    vi.mocked(supabase.from).mockImplementation(asFromMock(() => createPendingQueryBuilder()));
    renderWithQueryClient(<DashboardPage />);
    expect(screen.getByText("Visão Geral")).toBeInTheDocument();
  });

  it("renderiza os KPIs monetários com valores derivados dos deals", async () => {
    // Ordem exata das 5 queries de useDashboardKpis (Promise.all):
    //   1) openDealsRes  (values + count)
    //   2) wonCurrentRes (values + count)
    //   3) lostCurrentRes (count)
    //   4) wonPrevRes    (values + count)
    //   5) lostPrevRes   (count)
    // Seguidas de useTodayActivities e useUnansweredLeads (2 chamadas).
    vi.mocked(supabase.from).mockImplementation(
      createFromQueue([
        ok([{ value: "1000" }, { value: "2000" }], { count: 5 }), // openDeals → pipeline 3000, ativos 5
        ok([{ value: "500" }], { count: 2 }), // won atual → receita 500, wonCount 2
        ok(null, { count: 2 }), // lost atual → lostCount 2 → win-rate 50%
        ok([{ value: "200" }], { count: 1 }), // won prev
        ok(null, { count: 1 }), // lost prev
        ok([]), // today activities
        ok(null, { count: 0 }), // unanswered count
        ok([]), // unanswered list
      ]),
    );

    renderWithQueryClient(<DashboardPage />);

    expect(await screen.findByText("Negócios ativos")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("Taxa de ganho (coorte)")).toBeInTheDocument();
    expect(screen.getByText("50.0%")).toBeInTheDocument();
    expect(screen.getByText("Tudo em dia")).toBeInTheDocument();
  });

  it("mostra estado de erro com botão para tentar novamente quando os KPIs falham", async () => {
    vi.mocked(supabase.from).mockImplementation(
      createFromQueue(Array(6).fill(fail("erro de rede"))),
    );

    renderWithQueryClient(<DashboardPage />);

    expect(await screen.findByText("Erro ao carregar indicadores")).toBeInTheDocument();
    expect(
      within(screen.getByText("Erro ao carregar indicadores").closest("div")!).getByText(
        "erro de rede",
      ),
    ).toBeInTheDocument();
  });

  it("aciona novo carregamento ao clicar em Tentar novamente após erro", async () => {
    vi.mocked(supabase.from).mockImplementation(
      createFromQueue(Array(6).fill(fail("erro de rede"))),
    );

    renderWithQueryClient(<DashboardPage />);

    const kpiErrorCard = (await screen.findByText("Erro ao carregar indicadores")).closest("div")!;
    const retryButton = within(kpiErrorCard).getByRole("button", { name: "Tentar novamente" });
    fireEvent.click(retryButton);

    expect(await screen.findByText("Erro ao carregar indicadores")).toBeInTheDocument();
  });

  it("esconde as seções agregadas do mês para vendedores (não-admin)", async () => {
    vi.mocked(supabase.from).mockImplementation(
      createFromQueue([
        ok([], { count: 0 }),
        ok([], { count: 0 }),
        ok(null, { count: 0 }),
        ok([], { count: 0 }),
        ok(null, { count: 0 }),
        ok([]),
        ok(null, { count: 0 }),
        ok([]),
      ]),
    );

    renderWithQueryClient(<DashboardPage />);

    expect(await screen.findByText("Tudo em dia")).toBeInTheDocument();
    expect(screen.queryByText("Saúde da carteira — funil")).not.toBeInTheDocument();
  });
});

describe("indicadores do topo seguem os filtros do dashboard", () => {
  const actualPeriod = vi.mocked(useGlobalPeriod).getMockImplementation()!;

  function mockPeriod(from: string, to: string) {
    vi.mocked(useGlobalPeriod).mockReturnValue({
      period: "last_30d",
      range: { from: new Date(from), to: new Date(to) },
      setPeriod: vi.fn(),
      tenantDefault: "last_30d",
      isSessionOverride: false,
      clearSessionOverride: vi.fn(),
    });
  }

  const todayNoon = new Date();
  todayNoon.setHours(12, 0, 0, 0);

  // Dois quadros e dois responsáveis genéricos; datas fixas fora do mês corrente.
  // [id, status, valor, quadro, responsável, entrada no estágio]
  const deals: FakeRow[] = (
    [
      ["d1", "open", 1000, "quadro-a", "dono-a", "2026-01-05T12:00:00.000Z"],
      ["d2", "open", 2000, "quadro-b", "dono-b", "2026-01-05T12:00:00.000Z"],
      ["d3", "won", 500, "quadro-a", "dono-a", "2026-01-15T12:00:00.000Z"],
      ["d4", "won", 700, "quadro-b", "dono-b", "2026-01-20T12:00:00.000Z"],
      ["d5", "lost", 900, "quadro-a", "dono-a", "2026-01-10T12:00:00.000Z"],
      ["d6", "won", 300, "quadro-a", "dono-a", "2025-06-10T12:00:00.000Z"],
      ["d7", "lost", 400, "quadro-b", "dono-b", "2025-06-12T12:00:00.000Z"],
    ] as const
  ).map(([id, status, value, board_id, owner_id, stage_entered_at]) => ({
    id,
    status,
    value,
    board_id,
    owner_id,
    stage_entered_at,
  }));
  // [id, título, tipo, responsável, quadro do negócio]
  const activities: FakeRow[] = (
    [
      ["a1", "Ligar", "call", "dono-a", "quadro-a"],
      ["a2", "Enviar proposta", "task", "dono-b", "quadro-b"],
    ] as const
  ).map(([id, title, type, owner_id, board_id]) => ({
    id,
    title,
    type,
    due_at: todayNoon.toISOString(),
    completed_at: null,
    owner_id,
    deal: { board_id },
  }));
  // [id, nome do contato, dono do contato, quadro do negócio do contato]
  const conversations: FakeRow[] = (
    [
      ["c1", "Contato Um", "dono-a", "quadro-a"],
      ["c2", "Contato Dois", "dono-b", "quadro-b"],
    ] as const
  ).map(([id, name, owner_id, board_id]) => ({
    id,
    status: "open",
    deleted_at: null,
    last_message_at: todayNoon.toISOString(),
    contact: { id: `contato-${id}`, name, deleted_at: null, owner_id, deals: [{ board_id }] },
    channel: { type: "whatsapp" },
  }));

  beforeEach(() => {
    const tables: Record<string, FakeRow[]> = { deals, activities, conversations };
    vi.mocked(supabase.from).mockImplementation(
      asFromMock((table: string) => fakeTable(tables[table] ?? [])),
    );
  });

  afterEach(() => {
    vi.mocked(useGlobalPeriod).mockImplementation(actualPeriod);
  });

  it("recalcula receita e taxa de ganho pela janela do período global, não pelo mês corrente", async () => {
    mockPeriod("2026-01-01T00:00:00.000Z", "2026-01-31T23:59:59.999Z");
    const { rerender, queryClient } = renderWithQueryClient(<DashboardPage />);

    // Janeiro/2026: ganhos 500 + 700, 1 perdido → 66,7%.
    expect(await screen.findByText(brl(1200))).toBeInTheDocument();
    expect(screen.getByText("66.7%")).toBeInTheDocument();
    // Estado atual não é recortado pelo período.
    expect(screen.getByText(brl(3000))).toBeInTheDocument();

    mockPeriod("2025-06-01T00:00:00.000Z", "2025-06-30T23:59:59.999Z");
    rerender(
      <QueryClientProvider client={queryClient}>
        <DashboardPage />
      </QueryClientProvider>,
    );

    // Junho/2025: ganho 300, 1 perdido → 50%.
    expect(await screen.findByText(brl(300))).toBeInTheDocument();
    expect(screen.getByText("50.0%")).toBeInTheDocument();
    expect(screen.getByText(brl(3000))).toBeInTheDocument();
    expect(screen.getByLabelText("Indicadores do período")).toBeInTheDocument();
  });

  it("aplica quadro e responsável a todos os indicadores do topo e ao resumo", async () => {
    mockPeriod("2026-01-01T00:00:00.000Z", "2026-01-31T23:59:59.999Z");
    renderWithQueryClient(<DashboardPage />);

    expect(await screen.findByText("2 negócios em negociação")).toBeInTheDocument();
    expect(await screen.findByText("2 leads aguardando resposta")).toBeInTheDocument();
    expect(await screen.findByText("2 atividades para hoje")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "filtrar quadro A" }));
    });

    // Quadro A: aberto 1000, ganho 500, perdido 1 → 50%.
    expect(await screen.findByText(brl(1000))).toBeInTheDocument();
    expect(await screen.findByText(brl(500))).toBeInTheDocument();
    expect(screen.getByText("50.0%")).toBeInTheDocument();
    expect(await screen.findByText("1 negócio em negociação")).toBeInTheDocument();
    expect(await screen.findByText("1 lead aguardando resposta")).toBeInTheDocument();
    expect(await screen.findByText("1 atividade para hoje")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "todos os quadros" }));
      fireEvent.click(screen.getByRole("button", { name: "filtrar responsável B" }));
    });

    // Responsável B: aberto 2000, ganho 700, nenhum perdido → 100%.
    expect(await screen.findByText(brl(2000))).toBeInTheDocument();
    expect(await screen.findByText(brl(700))).toBeInTheDocument();
    expect(screen.getByText("100.0%")).toBeInTheDocument();
    expect(await screen.findByText("1 negócio em negociação")).toBeInTheDocument();
    expect(await screen.findByText("1 lead aguardando resposta")).toBeInTheDocument();
    expect(await screen.findByText("1 atividade para hoje")).toBeInTheDocument();
    const leadsCard = screen.getByText("Leads sem resposta").closest("div")!.parentElement!;
    expect(within(leadsCard).getByText("Contato Dois")).toBeInTheDocument();
    expect(within(leadsCard).queryByText("Contato Um")).not.toBeInTheDocument();
  });
});
