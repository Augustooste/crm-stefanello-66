import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import {
  useAiHitlPerformance,
  useMessagingPerformance,
  usePendingReturns,
  useWalletHealth,
  type AiHitlPerformance,
  type MessagingPerformance,
  type WalletHealth,
} from "./dashboard-widgets";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile, type CurrentProfile } from "@/lib/api/session";
import { createChain, createQueryWrapper } from "@/test/query-mocks";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
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

describe("useWalletHealth", () => {
  afterEach(() => vi.clearAllMocks());

  it("fica desabilitado sem tenant", () => {
    mockProfile(null);
    const { result } = renderHook(() => useWalletHealth(null), {
      wrapper: createQueryWrapper(),
    });
    expect(result.current.data).toBeUndefined();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("busca via RPC repassando o owner opcional", async () => {
    mockProfile("t1");
    const health: WalletHealth = {
      contatos_ativos: 5,
      contatos_inativos: 2,
      contatos_total: 7,
      negocios_parados: 1,
      negocios_parados_valor: 500,
      ltv_medio: 300,
      inactive_days_threshold: 30,
      stagnant_days_threshold: 10,
    };
    vi.mocked(supabase.rpc).mockResolvedValue({ data: health, error: null } as never);

    const { result } = renderHook(() => useWalletHealth("owner1"), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.data).toEqual(health));
    expect(supabase.rpc).toHaveBeenCalledWith("dashboard_wallet_health", {
      p_owner_id: "owner1",
    });
  });

  it("propaga erro do RPC", async () => {
    mockProfile("t1");
    vi.mocked(supabase.rpc).mockResolvedValue({ data: null, error: new Error("falhou") } as never);
    const { result } = renderHook(() => useWalletHealth(null), {
      wrapper: createQueryWrapper(),
    });
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
        contatos_ativos: 0,
        contatos_inativos: 0,
        contatos_total: 0,
        negocios_parados: 0,
        negocios_parados_valor: 0,
        ltv_medio: null,
        inactive_days_threshold: 30,
        stagnant_days_threshold: 10,
      },
      error: null,
    } as never);

    renderHook(() => useWalletHealth(null), { wrapper: createQueryWrapper() });

    // getSession() ainda pendente → a RPC não pode ter saído.
    await Promise.resolve();
    expect(supabase.rpc).not.toHaveBeenCalled();

    resolveSession({ data: { session: {} }, error: null } as Awaited<
      ReturnType<typeof supabase.auth.getSession>
    >);
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalled());
  });
});

describe("useMessagingPerformance", () => {
  afterEach(() => vi.clearAllMocks());

  it("chama o RPC com from/to em ISO e owner opcional", async () => {
    mockProfile("t1");
    const perf: MessagingPerformance = {
      frt_mediana_seg: 120,
      conversas_com_frt: 4,
      msgs_ia: 10,
      msgs_humano: 3,
      taxa_resposta_pct: 80,
      conversas_total: 5,
    };
    vi.mocked(supabase.rpc).mockResolvedValue({ data: perf, error: null } as never);

    const from = new Date(2026, 0, 1);
    const to = new Date(2026, 0, 31);
    const { result } = renderHook(() => useMessagingPerformance(from, to, null), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.data).toEqual(perf));
    expect(supabase.rpc).toHaveBeenCalledWith("dashboard_messaging_performance", {
      p_from: from.toISOString(),
      p_to: to.toISOString(),
      p_owner_id: undefined,
    });
  });
});

describe("useAiHitlPerformance", () => {
  afterEach(() => vi.clearAllMocks());

  it("chama o RPC com from/to/owner", async () => {
    mockProfile("t1");
    const perf: AiHitlPerformance = {
      aguardando_humano: 2,
      auto_avancos: 3,
      drafts_aprovados_sem_edicao: 3,
      drafts_editados: 1,
      sugestoes_pendentes: 5,
      avancos_auto_aprovados: 3,
      avancos_aprovados_humano: 4,
      avancos_rejeitados: 1,
      taxa_aprovacao_pct: 80,
      cobertura_24h_pct: 75,
    };
    vi.mocked(supabase.rpc).mockResolvedValue({ data: perf, error: null } as never);

    const from = new Date(2026, 0, 1);
    const to = new Date(2026, 0, 8);
    const { result } = renderHook(() => useAiHitlPerformance(from, to, "owner9"), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.data).toEqual(perf));
    expect(supabase.rpc).toHaveBeenCalledWith("dashboard_ai_hitl_performance", {
      p_from: from.toISOString(),
      p_to: to.toISOString(),
      p_owner_id: "owner9",
    });
  });
});

describe("usePendingReturns", () => {
  afterEach(() => vi.clearAllMocks());

  it("mescla activities e deal_followups pendentes, ordenados por data e marcando vencidos", async () => {
    mockProfile("t1");
    const now = Date.now();
    const past = new Date(now - 86_400_000).toISOString();
    const future = new Date(now + 2 * 86_400_000).toISOString();

    vi.mocked(supabase.from).mockImplementation((table: string) => {
      if (table === "activities") {
        return createChain({
          data: [{ id: "a1", title: "Ligar de volta", due_at: past, contact_id: "c1", deal: null }],
          error: null,
        }) as never;
      }
      if (table === "deal_followups") {
        return createChain({
          data: [
            {
              id: "f1",
              description: "Retorno agendado",
              scheduled_at: future,
              contact_id: "c2",
              deal: null,
            },
          ],
          error: null,
        }) as never;
      }
      throw new Error(`tabela inesperada: ${table}`);
    });

    const { result } = renderHook(() => usePendingReturns(null, null), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.data).toHaveLength(2));
    const [first, second] = result.current.data!;
    expect(first).toMatchObject({ id: "a1", kind: "activity", overdue: true });
    expect(second).toMatchObject({ id: "f1", kind: "followup", overdue: false });
  });

  it("filtra por responsável quando ownerId é informado", async () => {
    mockProfile("t1");
    const activitiesChain = createChain({ data: [], error: null });
    const followupsChain = createChain({ data: [], error: null });
    vi.mocked(supabase.from).mockImplementation((table: string) => {
      if (table === "activities") return activitiesChain as never;
      if (table === "deal_followups") return followupsChain as never;
      throw new Error(`tabela inesperada: ${table}`);
    });

    const { result } = renderHook(() => usePendingReturns("owner7", null), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.data).toEqual([]));
    expect(activitiesChain.eq).toHaveBeenCalledWith("owner_id", "owner7");
    expect(followupsChain.eq).toHaveBeenCalledWith("created_by", "owner7");
  });

  it("filtra client-side por board quando boardId é informado, ocultando itens sem negócio vinculado", async () => {
    mockProfile("t1");
    const now = Date.now();
    const future = new Date(now + 2 * 86_400_000).toISOString();

    vi.mocked(supabase.from).mockImplementation((table: string) => {
      if (table === "activities") {
        return createChain({
          data: [
            {
              id: "a1",
              title: "Do board certo",
              due_at: future,
              contact_id: "c1",
              deal: { board_id: "board-1" },
            },
            {
              id: "a2",
              title: "De outro board",
              due_at: future,
              contact_id: "c2",
              deal: { board_id: "board-2" },
            },
            {
              id: "a3",
              title: "Sem negócio vinculado",
              due_at: future,
              contact_id: "c3",
              deal: null,
            },
          ],
          error: null,
        }) as never;
      }
      if (table === "deal_followups") {
        return createChain({ data: [], error: null }) as never;
      }
      throw new Error(`tabela inesperada: ${table}`);
    });

    const { result } = renderHook(() => usePendingReturns(null, "board-1"), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(result.current.data![0]).toMatchObject({ id: "a1" });
  });

  it("sem boardId (todos os quadros), inclui itens com e sem negócio vinculado", async () => {
    mockProfile("t1");
    const now = Date.now();
    const future = new Date(now + 2 * 86_400_000).toISOString();

    vi.mocked(supabase.from).mockImplementation((table: string) => {
      if (table === "activities") {
        return createChain({
          data: [
            {
              id: "a1",
              title: "Com board",
              due_at: future,
              contact_id: "c1",
              deal: { board_id: "board-1" },
            },
            { id: "a2", title: "Sem board", due_at: future, contact_id: "c2", deal: null },
          ],
          error: null,
        }) as never;
      }
      if (table === "deal_followups") {
        return createChain({ data: [], error: null }) as never;
      }
      throw new Error(`tabela inesperada: ${table}`);
    });

    const { result } = renderHook(() => usePendingReturns(null, null), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.data).toHaveLength(2));
  });
});

describe("boardId parameter support", () => {
  afterEach(() => vi.clearAllMocks());

  it("useWalletHealth passa p_board_id quando informado", async () => {
    mockProfile("t1");
    const health: WalletHealth = {
      contatos_ativos: 3,
      contatos_inativos: 0,
      contatos_total: 3,
      negocios_parados: 0,
      negocios_parados_valor: 0,
      ltv_medio: null,
      inactive_days_threshold: 30,
      stagnant_days_threshold: 10,
    };
    vi.mocked(supabase.rpc).mockResolvedValue({ data: health, error: null } as never);

    const { result } = renderHook(() => useWalletHealth("owner1", "board-uuid-123"), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.data).toEqual(health));
    expect(supabase.rpc).toHaveBeenCalledWith("dashboard_wallet_health", {
      p_owner_id: "owner1",
      p_board_id: "board-uuid-123",
    });
  });

  it("useMessagingPerformance passa p_board_id quando informado", async () => {
    mockProfile("t1");
    const perf: MessagingPerformance = {
      frt_mediana_seg: 45.5,
      conversas_com_frt: 10,
      msgs_ia: 45,
      msgs_humano: 23,
      taxa_resposta_pct: 95.5,
      conversas_total: 12,
    };
    vi.mocked(supabase.rpc).mockResolvedValue({ data: perf, error: null } as never);

    const from = new Date(2026, 0, 1);
    const to = new Date(2026, 0, 8);
    const boardId = "board-uuid-456";

    const { result } = renderHook(() => useMessagingPerformance(from, to, "owner2", boardId), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.data).toEqual(perf));
    expect(supabase.rpc).toHaveBeenCalledWith("dashboard_messaging_performance", {
      p_from: from.toISOString(),
      p_to: to.toISOString(),
      p_owner_id: "owner2",
      p_board_id: boardId,
    });
  });

  it("useAiHitlPerformance passa p_board_id e preserva métricas anteriores junto às novas", async () => {
    mockProfile("t1");
    const perf: AiHitlPerformance = {
      aguardando_humano: 2,
      auto_avancos: 3,
      drafts_aprovados_sem_edicao: 3,
      drafts_editados: 1,
      sugestoes_pendentes: 5,
      avancos_auto_aprovados: 3,
      avancos_aprovados_humano: 4,
      avancos_rejeitados: 1,
      taxa_aprovacao_pct: 80,
      cobertura_24h_pct: 75,
    };
    vi.mocked(supabase.rpc).mockResolvedValue({ data: perf, error: null } as never);

    const from = new Date(2026, 0, 1);
    const to = new Date(2026, 0, 8);
    const boardId = "board-uuid-789";

    const { result } = renderHook(() => useAiHitlPerformance(from, to, "owner3", boardId), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.data).toEqual(perf));
    expect(supabase.rpc).toHaveBeenCalledWith("dashboard_ai_hitl_performance", {
      p_from: from.toISOString(),
      p_to: to.toISOString(),
      p_owner_id: "owner3",
      p_board_id: boardId,
    });
  });

  it("useAiHitlPerformance com null board_id não passa parâmetro", async () => {
    mockProfile("t1");
    const perf: AiHitlPerformance = {
      aguardando_humano: 0,
      auto_avancos: 0,
      drafts_aprovados_sem_edicao: 0,
      drafts_editados: 0,
      sugestoes_pendentes: 0,
      avancos_auto_aprovados: 0,
      avancos_aprovados_humano: 0,
      avancos_rejeitados: 0,
      taxa_aprovacao_pct: null,
      cobertura_24h_pct: 0,
    };
    vi.mocked(supabase.rpc).mockResolvedValue({ data: perf, error: null } as never);

    const from = new Date(2026, 0, 1);
    const to = new Date(2026, 0, 8);

    const { result } = renderHook(() => useAiHitlPerformance(from, to, null, null), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.data).toEqual(perf));
    expect(supabase.rpc).toHaveBeenCalledWith("dashboard_ai_hitl_performance", {
      p_from: from.toISOString(),
      p_to: to.toISOString(),
      p_owner_id: undefined,
      p_board_id: undefined,
    });
  });
});
