import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useCan } from "./workspaces";
import { useAuth } from "@/lib/auth/AuthProvider";
import { supabase } from "@/integrations/supabase/client";
import { createQueryWrapper } from "@/test/query-mocks";

vi.mock("@/lib/auth/AuthProvider", () => ({ useAuth: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: vi.fn(), auth: { refreshSession: vi.fn() } },
}));

describe("useCan", () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      user: { id: "u1", app_metadata: { active_tenant_id: "t1" } } as never,
      isReady: true,
    });
  });

  it("permite capability retornada pelo servidor", async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: ["crm.contacts.write"],
      error: null,
    } as never);
    const { result } = renderHook(() => useCan("crm.contacts.write"), {
      wrapper: createQueryWrapper(),
    });
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("nega por padrão capability ausente", async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: ["crm.contacts.read"],
      error: null,
    } as never);
    const { result } = renderHook(() => useCan("tenant.settings.manage"), {
      wrapper: createQueryWrapper(),
    });
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });
});
