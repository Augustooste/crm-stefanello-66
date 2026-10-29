import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import { createTestQueryClient } from "@/test/render";
import { asFromMock, createFromByTable, ok } from "@/test/supabase-mock";
import { useColdDeals, useHotLeadsWithoutFollowup } from "./inbox-risk-opportunities";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = createTestQueryClient();
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const NOW = new Date("2026-07-13T12:00:00.000Z");

describe("useColdDeals", () => {
  it("filtra deals abertos sem mudança de estágio há mais de 10 dias", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { supabase } = await import("@/integrations/supabase/client");
    vi.mocked(supabase.from).mockImplementation(
      asFromMock(
        createFromByTable({
          deals: ok([
            {
              id: "d1",
              title: "Frio",
              value: 100,
              stage_id: "s1",
              contact_id: "c1",
              stage_entered_at: new Date(NOW.getTime() - 15 * 86_400_000).toISOString(),
              contact: { id: "c1", name: "Ana" },
            },
            {
              id: "d2",
              title: "Quente",
              value: 200,
              stage_id: "s1",
              contact_id: "c2",
              stage_entered_at: new Date(NOW.getTime() - 2 * 86_400_000).toISOString(),
              contact: { id: "c2", name: "Bia" },
            },
          ]),
        }),
      ),
    );

    const { result } = renderHook(() => useColdDeals("t1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.coldDeals.map((d) => d.id)).toEqual(["d1"]);
    vi.useRealTimers();
  });

  it("exclui deal frio cujo contato já tem follow-up pendente (mesma dedup do painel Oportunidades)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { supabase } = await import("@/integrations/supabase/client");
    vi.mocked(supabase.from).mockImplementation(
      asFromMock(
        createFromByTable({
          deals: ok([
            {
              id: "d1",
              title: "Frio sem follow-up",
              value: 100,
              stage_id: "s1",
              contact_id: "c1",
              stage_entered_at: new Date(NOW.getTime() - 15 * 86_400_000).toISOString(),
              contact: { id: "c1", name: "Ana" },
            },
            {
              id: "d2",
              title: "Frio com follow-up já agendado",
              value: 200,
              stage_id: "s1",
              contact_id: "c2",
              stage_entered_at: new Date(NOW.getTime() - 20 * 86_400_000).toISOString(),
              contact: { id: "c2", name: "Bia" },
            },
          ]),
          deal_followups: ok([
            {
              id: "f1",
              tenant_id: "t1",
              deal_id: "d2",
              contact_id: "c2",
              scheduled_at: new Date(NOW.getTime() + 86_400_000).toISOString(),
              description: null,
              status: "pending",
              ai_suggested: true,
              source: "ai_suggested",
              created_at: NOW.toISOString(),
              contact: { id: "c2", name: "Bia" },
              deal: { id: "d2", title: "Frio com follow-up já agendado" },
            },
          ]),
        }),
      ),
    );

    const { result } = renderHook(() => useColdDeals("t1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // d2 tem follow-up pendente pro mesmo contato — some do painel Risco.
    await waitFor(() => expect(result.current.coldDeals.map((d) => d.id)).toEqual(["d1"]));
    vi.useRealTimers();
  });
});

describe("useHotLeadsWithoutFollowup", () => {
  it("exclui contatos com follow-up pendente, deletados e duplicados", async () => {
    const { supabase } = await import("@/integrations/supabase/client");
    vi.mocked(supabase.from).mockImplementation(
      asFromMock(
        createFromByTable({
          ai_lead_verdicts: ok([
            {
              contact_id: "c1",
              verdict: "hot",
              rationale: "engajado",
              created_at: NOW.toISOString(),
              contact: { id: "c1", name: "Ana", phone: null, email: null, deleted_at: null },
            },
            {
              contact_id: "c2",
              verdict: "hot",
              rationale: null,
              created_at: NOW.toISOString(),
              contact: { id: "c2", name: "Bia", phone: null, email: null, deleted_at: null },
            },
            {
              contact_id: "c3",
              verdict: "hot",
              rationale: null,
              created_at: NOW.toISOString(),
              contact: {
                id: "c3",
                name: "Removida",
                phone: null,
                email: null,
                deleted_at: NOW.toISOString(),
              },
            },
          ]),
          deal_followups: ok([
            {
              id: "f1",
              tenant_id: "t1",
              deal_id: null,
              contact_id: "c2",
              scheduled_at: new Date(NOW.getTime() + 86_400_000).toISOString(),
              description: null,
              status: "pending",
              ai_suggested: false,
              source: "manual",
              created_at: NOW.toISOString(),
              contact: { id: "c2", name: "Bia" },
              deal: null,
            },
          ]),
        }),
      ),
    );

    const { result } = renderHook(() => useHotLeadsWithoutFollowup("t1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // c2 tem follow-up pendente (excluído), c3 está deletado (excluído) — só c1 sobra.
    await waitFor(() => expect(result.current.hotLeads.map((h) => h.contact_id)).toEqual(["c1"]));
  });
});
