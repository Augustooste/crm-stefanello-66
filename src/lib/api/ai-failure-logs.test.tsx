import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import {
  AI_FAILURE_LOGS_PAGE_SIZE,
  AI_FAILURE_RECENT_WINDOW_HOURS,
  fetchAiFailureLogs,
  useAiFailureLogs,
  useRecentAiFailureCount,
  type AiFailureLogRow,
} from "./ai-failure-logs";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile, type CurrentProfile } from "@/lib/api/session";
import { createQueryWrapper } from "@/test/query-mocks";
import { createTestQueryClient } from "@/test/render";
import { createQueryBuilder } from "@/test/supabase-mock";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));
vi.mock("@/lib/api/session", () => ({ useCurrentProfile: vi.fn() }));

function mockProfile(profile: Partial<CurrentProfile> | null) {
  vi.mocked(useCurrentProfile).mockReturnValue({
    data: profile ? { id: "u1", tenant_id: "t1", name: "Ana", role: "admin", ...profile } : null,
  } as unknown as ReturnType<typeof useCurrentProfile>);
}

const ROW: AiFailureLogRow = {
  id: "log-1",
  route: "/webhook/whatsapp",
  provider: "openai",
  model: "gpt-4o-mini",
  status_code: 429,
  error_code: "RATE_LIMIT",
  error_message: "Rate limit exceeded",
  created_at: "2026-07-10T14:30:00.000Z",
};

describe("fetchAiFailureLogs", () => {
  afterEach(() => vi.clearAllMocks());

  it("busca na tabela ai_failure_logs com range da página 1 e sem filtro quando errorCode é null", async () => {
    const builder = createQueryBuilder({ data: [ROW], count: 1, error: null });
    vi.mocked(supabase.from).mockReturnValue(builder as never);

    const result = await fetchAiFailureLogs({ page: 1, errorCode: null });

    expect(supabase.from).toHaveBeenCalledWith("ai_failure_logs");
    expect(builder.range).toHaveBeenCalledWith(0, AI_FAILURE_LOGS_PAGE_SIZE - 1);
    expect(builder.eq).not.toHaveBeenCalled();
    expect(result).toEqual({ rows: [ROW], total: 1 });
  });

  it("calcula o range correto para páginas além da primeira", async () => {
    const builder = createQueryBuilder({ data: [], count: 0, error: null });
    vi.mocked(supabase.from).mockReturnValue(builder as never);

    await fetchAiFailureLogs({ page: 3, errorCode: null });

    const expectedFrom = (3 - 1) * AI_FAILURE_LOGS_PAGE_SIZE;
    expect(builder.range).toHaveBeenCalledWith(
      expectedFrom,
      expectedFrom + AI_FAILURE_LOGS_PAGE_SIZE - 1,
    );
  });

  it("filtra por error_code quando informado", async () => {
    const builder = createQueryBuilder({ data: [], count: 0, error: null });
    vi.mocked(supabase.from).mockReturnValue(builder as never);

    await fetchAiFailureLogs({ page: 1, errorCode: "TIMEOUT" });

    expect(builder.eq).toHaveBeenCalledWith("error_code", "TIMEOUT");
  });

  it("usa fallback rows=[] e total=0 quando data/count vêm null", async () => {
    const builder = createQueryBuilder({ data: null, error: null });
    vi.mocked(supabase.from).mockReturnValue(builder as never);

    const result = await fetchAiFailureLogs({ page: 1, errorCode: null });

    expect(result).toEqual({ rows: [], total: 0 });
  });

  it("lança o erro do supabase em vez de engolir", async () => {
    const builder = createQueryBuilder({ data: null, error: { message: "boom" } });
    vi.mocked(supabase.from).mockReturnValue(builder as never);

    await expect(fetchAiFailureLogs({ page: 1, errorCode: null })).rejects.toEqual({
      message: "boom",
    });
  });
});

describe("useAiFailureLogs", () => {
  afterEach(() => vi.clearAllMocks());

  it("fica desabilitado (não consulta) quando não há profile/tenant", () => {
    mockProfile(null);
    const { result } = renderHook(() => useAiFailureLogs(1, null), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.data).toBeUndefined();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("fica desabilitado quando o profile não é admin", () => {
    mockProfile({ role: "agent", tenant_id: "t1" });
    const { result } = renderHook(() => useAiFailureLogs(1, null), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current.data).toBeUndefined();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("busca a página quando habilitado (admin com tenant) e devolve rows/total", async () => {
    mockProfile({ role: "admin", tenant_id: "t1" });
    const builder = createQueryBuilder({ data: [ROW], count: 1, error: null });
    vi.mocked(supabase.from).mockReturnValue(builder as never);

    const { result } = renderHook(() => useAiFailureLogs(1, null), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.data).toEqual({ rows: [ROW], total: 1 }));
  });
});

describe("useRecentAiFailureCount", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("retorna 0 quando desabilitado (sem profile/tenant) e não consulta", () => {
    mockProfile(null);
    const { result } = renderHook(() => useRecentAiFailureCount(), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current).toBe(0);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("retorna 0 quando o profile não é admin e não consulta", () => {
    mockProfile({ role: "agent", tenant_id: "t1" });
    const { result } = renderHook(() => useRecentAiFailureCount(), {
      wrapper: createQueryWrapper(),
    });

    expect(result.current).toBe(0);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("consulta desde AI_FAILURE_RECENT_WINDOW_HOURS horas atrás (head-count) e retorna a contagem", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = new Date("2026-07-15T12:00:00.000Z");
    vi.setSystemTime(now);

    mockProfile({ role: "admin", tenant_id: "t1" });
    const builder = createQueryBuilder<null>({ data: null, count: 7, error: null });
    vi.mocked(supabase.from).mockReturnValue(builder as never);

    const { result } = renderHook(() => useRecentAiFailureCount(), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current).toBe(7));

    const expectedSince = new Date(
      now.getTime() - AI_FAILURE_RECENT_WINDOW_HOURS * 60 * 60 * 1000,
    ).toISOString();
    expect(builder.select).toHaveBeenCalledWith("id", { count: "exact", head: true });
    expect(builder.gte).toHaveBeenCalledWith("created_at", expectedSince);
  });

  it("não lança quando o supabase retorna erro — contagem cai para o default 0", async () => {
    mockProfile({ role: "admin", tenant_id: "t1" });
    const builder = createQueryBuilder<null>({
      data: null,
      error: { message: "boom" },
    });
    vi.mocked(supabase.from).mockReturnValue(builder as never);

    const queryClient = createTestQueryClient();
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    }

    const { result } = renderHook(() => useRecentAiFailureCount(), { wrapper: Wrapper });

    await waitFor(() =>
      expect(queryClient.getQueryState(["ai-failure-recent-count", "t1"])?.status).toBe("error"),
    );
    expect(result.current).toBe(0);
  });

  it("usa fallback 0 quando a consulta sucede mas o supabase não devolve count", async () => {
    mockProfile({ role: "admin", tenant_id: "t1" });
    const builder = createQueryBuilder<null>({ data: null, error: null });
    vi.mocked(supabase.from).mockReturnValue(builder as never);

    const queryClient = createTestQueryClient();
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    }

    const { result } = renderHook(() => useRecentAiFailureCount(), { wrapper: Wrapper });

    await waitFor(() =>
      expect(queryClient.getQueryState(["ai-failure-recent-count", "t1"])?.status).toBe("success"),
    );
    expect(result.current).toBe(0);
  });
});
