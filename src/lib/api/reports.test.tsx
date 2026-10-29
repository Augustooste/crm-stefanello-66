import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import {
  computeHandoffSlaPercentiles,
  computePeriodOverPeriod,
  fetchAiInsights,
  useDashboardReport,
  useDealOwnerLeaderboard,
  type DashboardReport,
  type DealOwnerLeaderboardRow,
  type HandoffSlaEvent,
} from "./reports";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile, type CurrentProfile } from "@/lib/api/session";
import { createChain, createQueryWrapper } from "@/test/query-mocks";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: { invoke: vi.fn() },
    rpc: vi.fn(),
    from: vi.fn(),
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: {} }, error: null }) },
  },
}));
vi.mock("@/lib/api/session", () => ({ useCurrentProfile: vi.fn() }));

function mockProfile(tenantId: string | null) {
  const profile: CurrentProfile | null = tenantId
    ? { id: "u1", tenant_id: tenantId, name: "Ana", role: "admin" }
    : null;
  vi.mocked(useCurrentProfile).mockReturnValue({
    data: profile,
  } as unknown as ReturnType<typeof useCurrentProfile>);
}

describe("fetchAiInsights", () => {
  afterEach(() => vi.clearAllMocks());

  it("invoca a edge function com o range de datas em ISO e força quando pedido", async () => {
    const response = { insights: [], cached: false, generated_at: "2026-01-01T00:00:00Z" };
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: response, error: null });

    const from = new Date(2026, 0, 1);
    const to = new Date(2026, 0, 31);
    const result = await fetchAiInsights(from, to, true);

    expect(result).toEqual(response);
    expect(supabase.functions.invoke).toHaveBeenCalledWith("ai-insights", {
      body: { from: from.toISOString(), to: to.toISOString(), force: true },
    });
  });

  it("usa force=false por padrão", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: { insights: [], cached: true, generated_at: "x" },
      error: null,
    });
    await fetchAiInsights(new Date(2026, 0, 1), new Date(2026, 0, 2));
    expect(supabase.functions.invoke).toHaveBeenCalledWith(
      "ai-insights",
      expect.objectContaining({ body: expect.objectContaining({ force: false }) }),
    );
  });

  // Antes este teste fixava o comportamento quebrado: repassar o texto do erro
  // do SDK. O supabase-js descarta o corpo em não-2xx e lança sempre a mesma
  // string em inglês, então o 429 de teto de uso chegava ao usuário como
  // "Edge Function returned a non-2xx status code". O que sobrevive é o status.
  it("traduz o 429 do teto de uso em mensagem de tela", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: null,
      error: new Error("Edge Function returned a non-2xx status code"),
      response: { status: 429 },
    } as never);
    await expect(fetchAiInsights(new Date(), new Date())).rejects.toThrow(
      "Limite de requisições de IA atingido",
    );
  });

  it("cai na mensagem padrão quando não há status", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: null,
      error: new Error("boom"),
    } as never);
    await expect(fetchAiInsights(new Date(), new Date())).rejects.toThrow(
      "Não foi possível gerar a resposta.",
    );
  });
});

describe("useDashboardReport", () => {
  afterEach(() => vi.clearAllMocks());

  it("fica desabilitado sem tenant", () => {
    mockProfile(null);
    const { result } = renderHook(
      () => useDashboardReport(new Date(2026, 0, 1), new Date(2026, 0, 31)),
      { wrapper: createQueryWrapper() },
    );
    expect(result.current.data).toBeUndefined();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("busca o relatório do dashboard via RPC", async () => {
    mockProfile("t1");
    const report: DashboardReport = {
      atendimento: {
        conversas_novas: 3,
        primeira_resposta_min: 2,
        handoff: 1,
        msgs_recebidas: 10,
        msgs_enviadas: 8,
        msgs_ia: 6,
        msgs_humano: 2,
      },
      mensagens_por_dia: [{ dia: "2026-01-01", recebidas: 5, enviadas: 4 }],
      funil: [],
      resultados: {
        ganhos: 1,
        ganhos_valor: 1000,
        perdidos: 0,
        ciclo_medio_dias: 3,
        motivos_perda: [],
      },
    };
    vi.mocked(supabase.rpc).mockResolvedValue({ data: report, error: null } as never);

    const from = new Date(2026, 0, 1);
    const to = new Date(2026, 0, 31);
    const { result } = renderHook(() => useDashboardReport(from, to), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.data).toEqual(report));
    expect(supabase.rpc).toHaveBeenCalledWith("dashboard_report", {
      p_from: from.toISOString(),
      p_to: to.toISOString(),
    });
  });

  it("propaga erro do RPC", async () => {
    mockProfile("t1");
    vi.mocked(supabase.rpc).mockResolvedValue({ data: null, error: new Error("falhou") } as never);
    const { result } = renderHook(
      () => useDashboardReport(new Date(2026, 0, 1), new Date(2026, 0, 2)),
      { wrapper: createQueryWrapper() },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  // Regressão de 2026-08-10: a RPC saía antes do token da sessão anexar e o
  // PostgREST resolvia o papel como `anon` (42501). Sem esta trava a chamada
  // dispara em paralelo com a hidratação da sessão em vez de esperar por ela.
  it("espera a sessão hidratar antes de disparar a RPC", async () => {
    mockProfile("t1");
    let resolveSession!: (value: Awaited<ReturnType<typeof supabase.auth.getSession>>) => void;
    vi.mocked(supabase.auth.getSession).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSession = resolve;
      }),
    );
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: {
        atendimento: {
          conversas_novas: 0,
          primeira_resposta_min: null,
          handoff: 0,
          msgs_recebidas: 0,
          msgs_enviadas: 0,
          msgs_ia: 0,
          msgs_humano: 0,
        },
        mensagens_por_dia: [],
        funil: [],
        resultados: {
          ganhos: 0,
          ganhos_valor: 0,
          perdidos: 0,
          ciclo_medio_dias: null,
          motivos_perda: [],
        },
      },
      error: null,
    } as never);

    renderHook(() => useDashboardReport(new Date(2026, 0, 1), new Date(2026, 0, 2)), {
      wrapper: createQueryWrapper(),
    });

    // getSession() ainda pendente → a RPC não pode ter saído.
    await Promise.resolve();
    expect(supabase.rpc).not.toHaveBeenCalled();

    resolveSession({ data: { session: {} }, error: null } as Awaited<
      ReturnType<typeof supabase.auth.getSession>
    >);
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalled());
  });
});

describe("computeHandoffSlaPercentiles", () => {
  const START = new Date("2026-01-01T00:00:00.000Z");

  function eventWithLatency(latencyMin: number): HandoffSlaEvent {
    return {
      awaiting_human_since: START.toISOString(),
      resolved_at: new Date(START.getTime() + latencyMin * 60_000).toISOString(),
    };
  }

  it("retorna null sem eventos (não quebra, não mostra NaN)", () => {
    expect(computeHandoffSlaPercentiles([])).toBeNull();
  });

  it("com 1 evento, p50 e p95 são a mesma latência observada", () => {
    expect(computeHandoffSlaPercentiles([eventWithLatency(45)])).toEqual({ p50: 45, p95: 45 });
  });

  it("com N eventos, usa nearest-rank (não interpolação)", () => {
    // 4 eventos [10,20,30,40]min: mediana "interpolada" seria 25, mas
    // nearest-rank (mesmo método de k6/Grafana) retorna sempre uma
    // latência real observada — aqui, 20.
    const events = [10, 20, 30, 40].map(eventWithLatency);
    expect(computeHandoffSlaPercentiles(events)).toEqual({ p50: 20, p95: 40 });
  });

  it("ordem de entrada dos eventos não importa (ordena internamente)", () => {
    const ordered = [10, 20, 30, 40].map(eventWithLatency);
    const shuffled = [30, 10, 40, 20].map(eventWithLatency);
    expect(computeHandoffSlaPercentiles(shuffled)).toEqual(computeHandoffSlaPercentiles(ordered));
  });

  it("com 20 eventos, p95 captura a cauda (rank 19 de 20, 0-indexed)", () => {
    const events = Array.from({ length: 20 }, (_, i) => eventWithLatency(i + 1)); // 1..20 min
    expect(computeHandoffSlaPercentiles(events)).toEqual({ p50: 10, p95: 19 });
  });

  it("descarta eventos com latência negativa (relógio inconsistente) mas mantém os válidos", () => {
    const events = [eventWithLatency(30), { ...eventWithLatency(-5) }];
    expect(computeHandoffSlaPercentiles(events)).toEqual({ p50: 30, p95: 30 });
  });

  it("retorna null quando todos os eventos têm latência negativa", () => {
    const events = [eventWithLatency(-1), eventWithLatency(-10)];
    expect(computeHandoffSlaPercentiles(events)).toBeNull();
  });
});

describe("useDealOwnerLeaderboard", () => {
  afterEach(() => vi.clearAllMocks());

  it("fica desabilitado sem tenant", () => {
    mockProfile(null);
    const { result } = renderHook(() => useDealOwnerLeaderboard(), {
      wrapper: createQueryWrapper(),
    });
    expect(result.current.data).toBeUndefined();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("busca o ranking filtrado por tenant e ordenado por vitórias", async () => {
    mockProfile("t1");
    const rows: DealOwnerLeaderboardRow[] = [
      {
        owner_id: "o1",
        owner_name: "Ana",
        wins: 5,
        decided: 6,
        win_rate_pct: 83.3,
        total_won_value: 10000,
      },
    ];
    const chain = createChain({ data: rows, error: null });
    vi.mocked(supabase.from).mockReturnValue(chain as never);

    const { result } = renderHook(() => useDealOwnerLeaderboard(), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.data).toEqual(rows));
    expect(supabase.from).toHaveBeenCalledWith("deal_owner_leaderboard");
    expect(chain.eq).toHaveBeenCalledWith("tenant_id", "t1");
    expect(chain.order).toHaveBeenCalledWith("wins", { ascending: false });
  });

  it("propaga erro da query", async () => {
    mockProfile("t1");
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: null, error: new Error("falhou") }) as never,
    );
    const { result } = renderHook(() => useDealOwnerLeaderboard(), {
      wrapper: createQueryWrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("computePeriodOverPeriod", () => {
  it("previous=0 e current=0 → sem base de comparação, nunca divide por zero", () => {
    expect(computePeriodOverPeriod(0, 0)).toEqual({ pct: null, label: "sem dados" });
  });

  it("previous=0 e current>0 → dado novo, nunca divide por zero", () => {
    expect(computePeriodOverPeriod(10, 0)).toEqual({ pct: null, label: "novo" });
  });

  it("variação normal de alta, arredondada ao inteiro mais próximo", () => {
    // (11 - 7) / 7 * 100 = 57.142... → arredonda para 57
    expect(computePeriodOverPeriod(11, 7)).toEqual({ pct: 57, label: "+57%" });
  });

  it("variação normal de queda", () => {
    expect(computePeriodOverPeriod(5, 10)).toEqual({ pct: -50, label: "-50%" });
  });

  it("sem variação quando current === previous (ambos > 0)", () => {
    expect(computePeriodOverPeriod(10, 10)).toEqual({ pct: 0, label: "0%" });
  });
});
