import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useBoards } from "./boards";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile, type CurrentProfile } from "@/lib/api/session";
import { createChain, createQueryWrapper } from "@/test/query-mocks";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
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

describe("useBoards", () => {
  afterEach(() => vi.clearAllMocks());

  it("fica desabilitado sem tenant", () => {
    mockProfile(null);
    const { result } = renderHook(() => useBoards(), { wrapper: createQueryWrapper() });
    expect(result.current.data).toBeUndefined();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("lista os quadros do tenant ordenados por position", async () => {
    mockProfile("t1");
    const boards = [
      { id: "b1", name: "Vendas", is_default: true, position: 0 },
      { id: "b2", name: "Pós-venda", is_default: false, position: 1 },
    ];
    const chain = createChain({ data: boards, error: null });
    vi.mocked(supabase.from).mockReturnValue(chain as never);

    const { result } = renderHook(() => useBoards(), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.data).toEqual(boards));
    expect(supabase.from).toHaveBeenCalledWith("boards");
    expect(chain.order).toHaveBeenCalledWith("position");
  });

  it("propaga erro do banco", async () => {
    mockProfile("t1");
    const chain = createChain({ data: null, error: new Error("falhou") });
    vi.mocked(supabase.from).mockReturnValue(chain as never);

    const { result } = renderHook(() => useBoards(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
