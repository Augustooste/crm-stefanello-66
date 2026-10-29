import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { createTestQueryClient } from "@/test/render";
import { createFromByTable, ok } from "@/test/supabase-mock";
import {
  deriveStageAdvancePriority,
  mergeAndSortQueue,
  useDecisionQueue,
  useResolveHitlDecision,
  useResolveStageAdvance,
  type HitlDecisionRow,
  type StageAdvanceRow,
} from "./use-decision-queue";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = createTestQueryClient();
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function makeDecision(overrides: Partial<HitlDecisionRow> = {}): HitlDecisionRow {
  return {
    id: "dec-1",
    tenant_id: "t1",
    type: "follow_up_suggestion",
    priority: "medium",
    category: "follow_up",
    title: "Recontatar João",
    description: null,
    reasoning: "Sem resposta há 3 dias",
    deal_id: null,
    contact_id: "c1",
    activity_id: null,
    suggested_action: {},
    alternative_actions: [],
    status: "pending",
    created_at: "2026-07-01T10:00:00.000Z",
    expires_at: null,
    snooze_until: null,
    deal: null,
    contact: { id: "c1", name: "João" },
    activity: null,
    ...overrides,
  };
}

function makeAdvance(overrides: Partial<StageAdvanceRow> = {}): StageAdvanceRow {
  return {
    id: "adv-1",
    tenant_id: "t1",
    deal_id: "d1",
    conversation_id: null,
    current_stage_id: "stage-1",
    suggested_stage_id: "stage-2",
    confidence: 0.75,
    reason: "Contato confirmou interesse em fechar",
    criteria_evaluation: [],
    status: "pending",
    created_at: "2026-07-01T09:00:00.000Z",
    expires_at: "2026-07-02T09:00:00.000Z",
    deal: { id: "d1", title: "Negócio Y", board_id: "b1", contact: null },
    ...overrides,
  };
}

describe("deriveStageAdvancePriority (heurística de banda de confiança)", () => {
  it("confidence >= 0.7 -> 'medium' (perto do auto_threshold, revisão é rubber-stamp)", () => {
    expect(deriveStageAdvancePriority(0.7)).toBe("medium");
    expect(deriveStageAdvancePriority(0.89)).toBe("medium");
  });

  it("confidence < 0.7 -> 'high' (perto do reject_threshold, mais incerto)", () => {
    expect(deriveStageAdvancePriority(0.69)).toBe("high");
    expect(deriveStageAdvancePriority(0.4)).toBe("high");
  });

  it("aceita confidence como string (numeric do Postgres pode chegar não-coagida)", () => {
    expect(deriveStageAdvancePriority("0.8" as unknown as number)).toBe("medium");
  });
});

describe("mergeAndSortQueue — ordenação combinada por prioridade e depois created_at", () => {
  it("ordena por prioridade (crítica > alta > média > baixa), ignorando a origem (decision vs advance)", () => {
    const decisions = [
      makeDecision({ id: "low-1", priority: "low", created_at: "2026-07-01T08:00:00.000Z" }),
      makeDecision({
        id: "critical-1",
        priority: "critical",
        created_at: "2026-07-01T08:00:00.000Z",
      }),
    ];
    const advances = [
      // confidence 0.5 -> 'high' derivada
      makeAdvance({ id: "high-1", confidence: 0.5, created_at: "2026-07-01T08:00:00.000Z" }),
    ];

    const result = mergeAndSortQueue(decisions, advances);

    expect(result.map((i) => i.id)).toEqual(["critical-1", "high-1", "low-1"]);
  });

  it("dentro da mesma prioridade, desempata por created_at ASCENDENTE (mais antigo primeiro)", () => {
    const decisions = [
      makeDecision({ id: "newer", priority: "high", created_at: "2026-07-05T00:00:00.000Z" }),
      makeDecision({ id: "older", priority: "high", created_at: "2026-07-01T00:00:00.000Z" }),
    ];

    const result = mergeAndSortQueue(decisions, []);

    expect(result.map((i) => i.id)).toEqual(["older", "newer"]);
  });

  it("mistura decisions e advances na mesma faixa de prioridade, respeitando created_at entre as duas origens", () => {
    const decisions = [
      makeDecision({
        id: "decision-medium",
        priority: "medium",
        created_at: "2026-07-03T00:00:00.000Z",
      }),
    ];
    const advances = [
      // confidence 0.8 -> 'medium' derivada, criada antes da decision acima
      makeAdvance({
        id: "advance-medium",
        confidence: 0.8,
        created_at: "2026-07-01T00:00:00.000Z",
      }),
    ];

    const result = mergeAndSortQueue(decisions, advances);

    expect(result.map((i) => i.id)).toEqual(["advance-medium", "decision-medium"]);
    expect(result.map((i) => i.kind)).toEqual(["stage_advance", "decision"]);
  });

  it("MUTATION CHECK: inverter o sinal do desempate por created_at quebra o teste anterior", () => {
    // Mutante manual: mesmo cenário do teste anterior, mas comparando com a
    // ORDEM INVERTIDA esperada -- se alguém trocar `a - b` por `b - a` no
    // comparador de desempate (ou inverter PRIORITY_RANK), a asserção abaixo
    // passaria a falhar (o par ["advance-medium","decision-medium"] viraria
    // ["decision-medium","advance-medium"]), provando que o teste anterior
    // de fato exercita o sentido da comparação, não só a presença dos itens.
    const decisions = [
      makeDecision({
        id: "decision-medium",
        priority: "medium",
        created_at: "2026-07-03T00:00:00.000Z",
      }),
    ];
    const advances = [
      makeAdvance({
        id: "advance-medium",
        confidence: 0.8,
        created_at: "2026-07-01T00:00:00.000Z",
      }),
    ];

    const result = mergeAndSortQueue(decisions, advances);

    expect(result.map((i) => i.id)).not.toEqual(["decision-medium", "advance-medium"]);
  });

  it("array vazio nas duas origens retorna array vazio", () => {
    expect(mergeAndSortQueue([], [])).toEqual([]);
  });
});

describe("useDecisionQueue — combina as duas tabelas já ordenadas", () => {
  it("busca hitl_decisions e ai_pending_stage_advances e devolve a fila combinada ordenada", async () => {
    const decision = makeDecision({ id: "d-critical", priority: "critical" });
    const advance = makeAdvance({ id: "a-medium", confidence: 0.9 });
    vi.mocked(supabase.from).mockImplementation(
      createFromByTable({
        hitl_decisions: ok([decision]),
        ai_pending_stage_advances: ok([advance]),
      }),
    );

    const { result } = renderHook(() => useDecisionQueue(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.items.map((i) => i.id)).toEqual(["d-critical", "a-medium"]);
    expect(supabase.from).toHaveBeenCalledWith("hitl_decisions");
    expect(supabase.from).toHaveBeenCalledWith("ai_pending_stage_advances");
  });

  it("propaga erro se qualquer uma das duas queries falhar", async () => {
    vi.mocked(supabase.from).mockImplementation(
      createFromByTable({
        hitl_decisions: { data: null, error: { message: "falhou" } },
        ai_pending_stage_advances: ok([]),
      }),
    );

    const { result } = renderHook(() => useDecisionQueue(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("useResolveStageAdvance — chama a RPC certa com os parâmetros certos", () => {
  it("approve simples chama resolve_pending_stage_advance sem p_modifications", async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: { success: true }, error: null } as never);
    const { result } = renderHook(() => useResolveStageAdvance(), { wrapper });

    await result.current.mutateAsync({ advanceId: "adv-1", action: "approve" });

    expect(supabase.rpc).toHaveBeenCalledWith("resolve_pending_stage_advance", {
      p_advance_id: "adv-1",
      p_action: "approve",
      p_reason: undefined,
      p_modifications: null,
    });
  });

  it("approve com edição de estágio chama a RPC com p_modifications.suggested_stage_id", async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: { success: true }, error: null } as never);
    const { result } = renderHook(() => useResolveStageAdvance(), { wrapper });

    await result.current.mutateAsync({
      advanceId: "adv-1",
      action: "approve",
      suggestedStageId: "stage-9",
    });

    expect(supabase.rpc).toHaveBeenCalledWith("resolve_pending_stage_advance", {
      p_advance_id: "adv-1",
      p_action: "approve",
      p_reason: undefined,
      p_modifications: { suggested_stage_id: "stage-9" },
    });
  });

  it("reject chama a RPC com p_action='reject' e o motivo", async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: { success: true }, error: null } as never);
    const { result } = renderHook(() => useResolveStageAdvance(), { wrapper });

    await result.current.mutateAsync({
      advanceId: "adv-1",
      action: "reject",
      reason: "Deal esfriou",
    });

    expect(supabase.rpc).toHaveBeenCalledWith("resolve_pending_stage_advance", {
      p_advance_id: "adv-1",
      p_action: "reject",
      p_reason: "Deal esfriou",
      p_modifications: null,
    });
  });

  it("propaga o erro da RPC (ex.: guarda otimista 'Deal stage mudou desde a sugestão')", async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: null,
      error: { message: "Deal stage mudou desde a sugestão -- recarregue" },
    } as never);
    const { result } = renderHook(() => useResolveStageAdvance(), { wrapper });

    await expect(
      result.current.mutateAsync({ advanceId: "adv-1", action: "approve" }),
    ).rejects.toMatchObject({ message: "Deal stage mudou desde a sugestão -- recarregue" });
  });
});

describe("useResolveHitlDecision — chama a RPC certa com os parâmetros certos", () => {
  it("snooze chama resolve_hitl_decision com p_action='snooze' e p_snooze_until", async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: { success: true }, error: null } as never);
    const { result } = renderHook(() => useResolveHitlDecision(), { wrapper });

    await result.current.mutateAsync({
      decisionId: "dec-1",
      action: "snooze",
      snoozeUntil: "2026-07-10T00:00:00.000Z",
    });

    expect(supabase.rpc).toHaveBeenCalledWith("resolve_hitl_decision", {
      p_decision_id: "dec-1",
      p_action: "snooze",
      p_reason: undefined,
      p_snooze_until: "2026-07-10T00:00:00.000Z",
      p_modifications: null,
    });
  });

  it("reject chama a RPC com o motivo obrigatório repassado", async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: { success: true }, error: null } as never);
    const { result } = renderHook(() => useResolveHitlDecision(), { wrapper });

    await result.current.mutateAsync({
      decisionId: "dec-1",
      action: "reject",
      reason: "Sem contexto suficiente",
    });

    expect(supabase.rpc).toHaveBeenCalledWith("resolve_hitl_decision", {
      p_decision_id: "dec-1",
      p_action: "reject",
      p_reason: "Sem contexto suficiente",
      p_snooze_until: undefined,
      p_modifications: null,
    });
  });
});
