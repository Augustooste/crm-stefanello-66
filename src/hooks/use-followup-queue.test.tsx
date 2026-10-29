import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { createTestQueryClient } from "@/test/render";
import {
  createFromQueue,
  createQueryBuilder,
  ok,
  type QueryBuilderMock,
} from "@/test/supabase-mock";
import {
  todayEndIn,
  useFollowupQueue,
  useCreateFollowup,
  useCompleteFollowup,
  FOLLOWUP_TZ,
  type FollowupRow,
} from "./use-followup-queue";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = createTestQueryClient();
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function makeRow(overrides: Partial<FollowupRow>): FollowupRow {
  return {
    id: "f1",
    tenant_id: "t1",
    deal_id: null,
    contact_id: "c1",
    scheduled_at: new Date().toISOString(),
    description: null,
    status: "pending",
    ai_suggested: false,
    source: "manual",
    created_at: new Date().toISOString(),
    contact: { id: "c1", name: "Ana" },
    deal: null,
    ...overrides,
  };
}

describe("todayEndIn (bounds tz-aware — LIMITAÇÃO: America/Sao_Paulo hardcoded)", () => {
  it("horário de borda 23h: servidor UTC já em 'amanhã', mas ainda 'hoje' em SP (23h)", () => {
    // 2026-07-09T02:00:00Z = 2026-07-08T23:00:00-03:00 (23h em SP, ainda dia 8)
    const now = new Date("2026-07-09T02:00:00.000Z");
    const end = todayEndIn(FOLLOWUP_TZ, now);
    expect(end.toISOString()).toBe("2026-07-09T02:59:59.999Z");
  });

  it("horário de borda 1h: servidor UTC ainda 'hoje', mas já é 'ontem' em SP (22h30 do dia anterior)", () => {
    // 2026-07-08T01:30:00Z = 2026-07-07T22:30:00-03:00 (dia 7 em SP, não dia 8)
    const now = new Date("2026-07-08T01:30:00.000Z");
    const end = todayEndIn(FOLLOWUP_TZ, now);
    expect(end.toISOString()).toBe("2026-07-08T02:59:59.999Z");
  });
});

describe("useFollowupQueue — baldes mutuamente exclusivos", () => {
  beforeEach(() => {
    // Só congela `Date` — deixa setTimeout real, senão o polling interno do
    // `waitFor` (testing-library) e o retry do react-query travam esperando
    // um timer que nunca avança sozinho.
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("atrasados = pending AND scheduled_at < now(), nunca aparece em hoje/proximos", async () => {
    vi.setSystemTime(new Date("2026-07-08T15:00:00.000Z")); // meio da tarde UTC/SP
    const rows = [
      makeRow({ id: "overdue-1", scheduled_at: "2026-07-08T10:00:00.000Z" }), // já passou
      makeRow({ id: "today-1", scheduled_at: "2026-07-08T18:00:00.000Z" }), // ainda hoje
    ];
    vi.mocked(supabase.from).mockImplementation(createFromQueue([ok(rows)]));

    const { result } = renderHook(() => useFollowupQueue(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.atrasados.map((r) => r.id)).toEqual(["overdue-1"]);
    expect(result.current.hoje.map((r) => r.id)).toEqual(["today-1"]);
    expect(result.current.proximos).toEqual([]);
  });

  it("horário de borda: item às 23h30 SP de hoje cai em 'hoje', não em 'proximos'", async () => {
    // now = 2026-07-09T02:00:00Z = 23h em SP do dia 8 (ainda não virou o dia)
    vi.setSystemTime(new Date("2026-07-09T02:00:00.000Z"));
    const rows = [
      // 23h30 SP do dia 8 = 2026-07-09T02:30:00Z (30min à frente de "agora")
      makeRow({ id: "edge-today", scheduled_at: "2026-07-09T02:30:00.000Z" }),
      // 00h30 SP do dia 9 = 2026-07-09T03:30:00Z (já é amanhã em SP -> proximos)
      makeRow({ id: "edge-tomorrow", scheduled_at: "2026-07-09T03:30:00.000Z" }),
    ];
    vi.mocked(supabase.from).mockImplementation(createFromQueue([ok(rows)]));

    const { result } = renderHook(() => useFollowupQueue(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.hoje.map((r) => r.id)).toEqual(["edge-today"]);
    expect(result.current.proximos.map((r) => r.id)).toEqual(["edge-tomorrow"]);
    expect(result.current.atrasados).toEqual([]);
  });

  it("proximos respeita o horizonte de N dias (fora da janela não entra em nenhum balde)", async () => {
    vi.setSystemTime(new Date("2026-07-08T12:00:00.000Z"));
    const rows = [
      makeRow({ id: "within", scheduled_at: "2026-07-12T12:00:00.000Z" }), // +4 dias
      makeRow({ id: "beyond", scheduled_at: "2026-08-01T12:00:00.000Z" }), // muito além do horizonte
    ];
    vi.mocked(supabase.from).mockImplementation(createFromQueue([ok(rows)]));

    const { result } = renderHook(() => useFollowupQueue(7), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.proximos.map((r) => r.id)).toEqual(["within"]);
    const allIds = [
      ...result.current.atrasados,
      ...result.current.hoje,
      ...result.current.proximos,
    ].map((r) => r.id);
    expect(allIds).not.toContain("beyond");
  });
});

describe("useCreateFollowup", () => {
  it("cria follow-up manual com source='manual' e ai_suggested=false, e invalida a fila", async () => {
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    vi.mocked(supabase.from).mockImplementation(createFromQueue([ok(null)]));

    const { result } = renderHook(() => useCreateFollowup(), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    });

    await result.current.mutateAsync({
      tenantId: "t1",
      contactId: "c1",
      scheduledAt: "2026-07-10T12:00:00.000Z",
      createdBy: "u1",
      source: "manual",
      aiSuggested: false,
    });

    expect(supabase.from).toHaveBeenCalledWith("deal_followups");
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["followups"] }));
  });

  it("cria follow-up sugerido pela IA com source='ai_suggested' e ai_suggested=true", async () => {
    const builder: QueryBuilderMock = createQueryBuilder(ok(null));
    vi.mocked(supabase.from).mockImplementation(
      () => builder as unknown as ReturnType<typeof supabase.from>,
    );

    const { result } = renderHook(() => useCreateFollowup(), { wrapper });

    await result.current.mutateAsync({
      tenantId: "t1",
      contactId: "c1",
      dealId: "d1",
      scheduledAt: "2026-07-10T12:00:00.000Z",
      description: 'IA detectou: "semana que vem"',
      createdBy: "u1",
      source: "ai_suggested",
      aiSuggested: true,
    });

    expect(builder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ source: "ai_suggested", ai_suggested: true, deal_id: "d1" }),
    );
  });
});

describe("useCompleteFollowup", () => {
  it("marca como completed e invalida a fila", async () => {
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    vi.mocked(supabase.from).mockImplementation(createFromQueue([ok(null)]));

    const { result } = renderHook(() => useCompleteFollowup(), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    });

    await result.current.mutateAsync({ id: "f1", completedBy: "u1" });

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["followups"] }));
  });
});
