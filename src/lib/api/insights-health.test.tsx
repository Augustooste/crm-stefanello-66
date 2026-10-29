import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import {
  AI_INSIGHTS_ALERT_THRESHOLD,
  AI_INSIGHTS_ALERT_WINDOW_MINUTES,
  fetchAiInsightsFailureAlert,
  useAiInsightsFailureAlert,
} from "./insights-health";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile, type CurrentProfile } from "@/lib/api/session";
import { createQueryWrapper } from "@/test/query-mocks";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));
vi.mock("@/lib/api/session", () => ({ useCurrentProfile: vi.fn() }));

type Result = { data: Array<{ created_at: string }> | null; count: number | null; error: unknown };

function chain(result: Result) {
  // supabase-js style: select().gte().order().limit() → await
  const c = {
    select: vi.fn(() => c),
    gte: vi.fn(() => c),
    order: vi.fn(() => c),
    limit: vi.fn(() => Promise.resolve(result)),
  };
  return c;
}

function mockProfile(profile: CurrentProfile | null) {
  vi.mocked(useCurrentProfile).mockReturnValue({
    data: profile,
  } as unknown as ReturnType<typeof useCurrentProfile>);
}

describe("fetchAiInsightsFailureAlert", () => {
  afterEach(() => vi.clearAllMocks());

  it("consulta janela recente e devolve contagem", async () => {
    const c = chain({
      data: [{ created_at: "2026-07-07T12:00:00Z" }, { created_at: "2026-07-07T11:59:00Z" }],
      count: 4,
      error: null,
    });
    vi.mocked(supabase.from).mockReturnValue(c as unknown as ReturnType<typeof supabase.from>);

    const result = await fetchAiInsightsFailureAlert();

    expect(supabase.from).toHaveBeenCalledWith("ai_insights_write_failures");
    expect(c.select).toHaveBeenCalledWith("created_at", { count: "exact" });
    expect(c.gte).toHaveBeenCalledWith("created_at", expect.any(String));
    // O `since` deve ser aproximadamente `windowMinutes` atrás.
    const gteCall = c.gte.mock.calls[0] as unknown as [string, string];
    const sinceArg = gteCall[1];
    const diffMs = Date.now() - new Date(sinceArg).getTime();
    expect(diffMs).toBeGreaterThanOrEqual(AI_INSIGHTS_ALERT_WINDOW_MINUTES * 60_000 - 2_000);
    expect(diffMs).toBeLessThanOrEqual(AI_INSIGHTS_ALERT_WINDOW_MINUTES * 60_000 + 2_000);

    expect(result.count).toBe(4);
    expect(result.threshold).toBe(AI_INSIGHTS_ALERT_THRESHOLD);
    expect(result.windowMinutes).toBe(AI_INSIGHTS_ALERT_WINDOW_MINUTES);
    expect(result.latest).toHaveLength(2);
  });

  it("propaga erro do supabase", async () => {
    const c = chain({ data: null, count: null, error: new Error("rls block") });
    vi.mocked(supabase.from).mockReturnValue(c as unknown as ReturnType<typeof supabase.from>);
    await expect(fetchAiInsightsFailureAlert()).rejects.toThrow("rls block");
  });

  it("normaliza count nulo para 0", async () => {
    const c = chain({ data: [], count: null, error: null });
    vi.mocked(supabase.from).mockReturnValue(c as unknown as ReturnType<typeof supabase.from>);
    const result = await fetchAiInsightsFailureAlert();
    expect(result.count).toBe(0);
  });
});

describe("useAiInsightsFailureAlert", () => {
  afterEach(() => vi.clearAllMocks());

  it("fica desabilitado quando o perfil não é admin", async () => {
    mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "agent" });
    const { result } = renderHook(() => useAiInsightsFailureAlert(), {
      wrapper: createQueryWrapper(),
    });
    // enabled=false → nunca fetcha, data fica undefined
    await new Promise((r) => setTimeout(r, 10));
    expect(supabase.from).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });

  it("fica desabilitado sem perfil", () => {
    mockProfile(null);
    renderHook(() => useAiInsightsFailureAlert(), { wrapper: createQueryWrapper() });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("busca a contagem para admins com tenant", async () => {
    mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
    const c = chain({ data: [], count: 5, error: null });
    vi.mocked(supabase.from).mockReturnValue(c as unknown as ReturnType<typeof supabase.from>);
    const { result } = renderHook(() => useAiInsightsFailureAlert(), {
      wrapper: createQueryWrapper(),
    });
    await waitFor(() => expect(result.current.data?.count).toBe(5));
  });
});
