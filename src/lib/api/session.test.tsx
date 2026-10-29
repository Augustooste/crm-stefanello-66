import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { User } from "@supabase/supabase-js";
import type { QueryClient } from "@tanstack/react-query";
import { useCurrentProfile, useTenantProfiles, requireAdmin, type CurrentProfile } from "./session";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth/AuthProvider";
import { createChain, createQueryWrapper } from "@/test/query-mocks";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), auth: { getSession: vi.fn() } },
}));
vi.mock("@/lib/auth/AuthProvider", () => ({
  useAuth: vi.fn(),
}));

function makeUser(id: string): User {
  return { id } as User;
}

describe("useCurrentProfile", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fica desabilitado quando isReady é falso", () => {
    vi.mocked(useAuth).mockReturnValue({ user: null, isReady: false });
    const { result } = renderHook(() => useCurrentProfile(), { wrapper: createQueryWrapper() });
    expect(result.current.data).toBeUndefined();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("fica desabilitado quando não há usuário mesmo pronto", () => {
    vi.mocked(useAuth).mockReturnValue({ user: null, isReady: true });
    const { result } = renderHook(() => useCurrentProfile(), { wrapper: createQueryWrapper() });
    expect(result.current.data).toBeUndefined();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("busca o perfil do usuário autenticado", async () => {
    const profile: CurrentProfile = { id: "u1", tenant_id: "t1", name: "Ana", role: "admin" };
    vi.mocked(useAuth).mockReturnValue({ user: makeUser("u1"), isReady: true });
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: profile, error: null }) as unknown as ReturnType<typeof supabase.from>,
    );

    const { result } = renderHook(() => useCurrentProfile(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.data).toEqual(profile));
    expect(supabase.from).toHaveBeenCalledWith("profiles");
  });

  it("retorna null quando não há linha correspondente", async () => {
    vi.mocked(useAuth).mockReturnValue({ user: makeUser("u1"), isReady: true });
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: null, error: null }) as unknown as ReturnType<typeof supabase.from>,
    );

    const { result } = renderHook(() => useCurrentProfile(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it("propaga erro da consulta", async () => {
    vi.mocked(useAuth).mockReturnValue({ user: makeUser("u1"), isReady: true });
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: null, error: new Error("falhou") }) as unknown as ReturnType<
        typeof supabase.from
      >,
    );

    const { result } = renderHook(() => useCurrentProfile(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it("guard defensivo: refetch manual após o usuário sumir não consulta o Supabase", async () => {
    vi.mocked(useAuth).mockReturnValue({ user: makeUser("u1"), isReady: true });
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: null, error: null }) as unknown as ReturnType<typeof supabase.from>,
    );

    const { result, rerender } = renderHook(() => useCurrentProfile(), {
      wrapper: createQueryWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    vi.mocked(useAuth).mockReturnValue({ user: null, isReady: true });
    rerender();
    vi.mocked(supabase.from).mockClear();

    await result.current.refetch();

    expect(supabase.from).not.toHaveBeenCalled();
  });
});

describe("requireAdmin", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function fakeClient(profile: CurrentProfile | null): QueryClient {
    return { ensureQueryData: vi.fn().mockResolvedValue(profile) } as unknown as QueryClient;
  }

  // Ramo RBAC: ensureQueryData resolve o array de permissões (get_my_permissions),
  // exercitando `access.includes("tenant.settings.manage")` em requireAdmin — o
  // caminho novo, distinto do fallback de objeto/role coberto acima.
  function fakeClientAccess(access: string[]): QueryClient {
    return { ensureQueryData: vi.fn().mockResolvedValue(access) } as unknown as QueryClient;
  }

  function mockSession(userId: string | null) {
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: { session: userId ? { user: { id: userId } } : null },
    } as never);
  }

  it("deixa passar quando o perfil é admin", async () => {
    mockSession("u1");
    const client = fakeClient({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
    await expect(requireAdmin(client)).resolves.toBeUndefined();
  });

  it("redireciona (lança) quando o usuário não é admin", async () => {
    mockSession("u2");
    const client = fakeClient({ id: "u2", tenant_id: "t1", name: "Bruno", role: "agent" });
    await expect(requireAdmin(client)).rejects.toBeDefined();
  });

  it("redireciona quando não há perfil", async () => {
    mockSession(null);
    const client = fakeClient(null);
    await expect(requireAdmin(client)).rejects.toBeDefined();
  });

  it("deixa passar quando o RBAC concede tenant.settings.manage", async () => {
    mockSession("u1");
    const client = fakeClientAccess(["tenant.settings.manage"]);
    await expect(requireAdmin(client)).resolves.toBeUndefined();
  });

  it("redireciona (lança) quando o RBAC não concede tenant.settings.manage", async () => {
    mockSession("u2");
    const client = fakeClientAccess(["contacts.read", "deals.read"]);
    await expect(requireAdmin(client)).rejects.toBeDefined();
  });
});

describe("useTenantProfiles", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fica desabilitado quando não está pronto", () => {
    vi.mocked(useAuth).mockReturnValue({ user: null, isReady: false });
    const { result } = renderHook(() => useTenantProfiles(), { wrapper: createQueryWrapper() });
    expect(result.current.data).toBeUndefined();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("lista os perfis do tenant ordenados por nome", async () => {
    vi.mocked(useAuth).mockReturnValue({ user: makeUser("u1"), isReady: true });
    const rows = [{ id: "1", name: "Ana", role: "admin" }];
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: rows, error: null }) as unknown as ReturnType<typeof supabase.from>,
    );

    const { result } = renderHook(() => useTenantProfiles(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.data).toEqual(rows));
  });

  it("retorna array vazio quando data é null", async () => {
    vi.mocked(useAuth).mockReturnValue({ user: makeUser("u1"), isReady: true });
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: null, error: null }) as unknown as ReturnType<typeof supabase.from>,
    );

    const { result } = renderHook(() => useTenantProfiles(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });

  it("propaga erro", async () => {
    vi.mocked(useAuth).mockReturnValue({ user: makeUser("u1"), isReady: true });
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: null, error: new Error("boom") }) as unknown as ReturnType<
        typeof supabase.from
      >,
    );
    const { result } = renderHook(() => useTenantProfiles(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
