import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

import { fetchEdgeFunctionErrorAlerts, useEdgeFunctionErrorAlerts } from "./edge-health";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile, type CurrentProfile } from "@/lib/api/session";
import { createQueryWrapper } from "@/test/query-mocks";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: vi.fn() },
}));
vi.mock("@/lib/api/session", () => ({ useCurrentProfile: vi.fn() }));

const rpc = vi.mocked(supabase.rpc as unknown as (name: string) => Promise<unknown>);

function mockProfile(profile: Partial<CurrentProfile> | null) {
  vi.mocked(useCurrentProfile).mockReturnValue({
    data: profile,
  } as unknown as ReturnType<typeof useCurrentProfile>);
}

const ALERT = {
  function_name: "messaging",
  operation: "messaging.webhook.inbound",
  severity: "error" as const,
  errors_15m: 5,
  errors_prev_15m: 1,
  spike: true,
  last_error_code: "inbound_failed",
  last_message: "falha ao processar inbound",
  last_at: "2026-07-26T12:00:00.000Z",
};

describe("fetchEdgeFunctionErrorAlerts", () => {
  afterEach(() => vi.clearAllMocks());

  it("retorna a lista da RPC", async () => {
    rpc.mockResolvedValue({ data: [ALERT], error: null });
    await expect(fetchEdgeFunctionErrorAlerts()).resolves.toEqual([ALERT]);
    expect(rpc).toHaveBeenCalledWith("get_edge_function_error_alerts");
  });

  it("retorna lista vazia quando data é null", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await expect(fetchEdgeFunctionErrorAlerts()).resolves.toEqual([]);
  });

  it("propaga erro da RPC", async () => {
    rpc.mockResolvedValue({ data: null, error: new Error("boom") });
    await expect(fetchEdgeFunctionErrorAlerts()).rejects.toThrow("boom");
  });
});

describe("useEdgeFunctionErrorAlerts", () => {
  afterEach(() => vi.clearAllMocks());

  it("consulta quando o usuário é admin com tenant", async () => {
    mockProfile({ tenant_id: "t1", role: "admin" });
    rpc.mockResolvedValue({ data: [ALERT], error: null });
    const { result } = renderHook(() => useEdgeFunctionErrorAlerts(), {
      wrapper: createQueryWrapper(),
    });
    await waitFor(() => expect(result.current.data).toEqual([ALERT]));
  });

  it("não consulta para atendente", async () => {
    mockProfile({ tenant_id: "t1", role: "agent" });
    const { result } = renderHook(() => useEdgeFunctionErrorAlerts(), {
      wrapper: createQueryWrapper(),
    });
    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));
    expect(rpc).not.toHaveBeenCalled();
  });

  it("não consulta sem tenant", async () => {
    mockProfile(null);
    renderHook(() => useEdgeFunctionErrorAlerts(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(rpc).not.toHaveBeenCalled());
  });
});
