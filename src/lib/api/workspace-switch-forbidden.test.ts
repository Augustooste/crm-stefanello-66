import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";

import { useSwitchWorkspace } from "./workspaces";
import { useDashboardReport } from "./reports";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile, type CurrentProfile } from "@/lib/api/session";
import { createQueryWrapper } from "@/test/query-mocks";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { refreshSession: vi.fn(), getSession: vi.fn() },
    from: vi.fn(),
    rpc: vi.fn(),
  },
}));

vi.mock("@/lib/api/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/session")>();
  return { ...actual, useCurrentProfile: vi.fn() };
});

const perfil = (role: string): { data: CurrentProfile } =>
  ({ data: { tenant_id: "tenant-1", role } }) as unknown as { data: CurrentProfile };

/**
 * Regressão do `forbidden` medido em produção em 2026-08-10 18:47:37
 * (`system_events`, `operation: "/app"`, `dashboard-report`): conta que é admin
 * num workspace e atendente no outro levava P0001 ao trocar de workspace.
 */
describe("troca de workspace não pode disparar RPC admin-only", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useCurrentProfile).mockReturnValue(perfil("admin") as never);
  });

  it("o switch NÃO refetcha as queries ativas — quem limpa é o reload", async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: true, error: null } as never);
    vi.mocked(supabase.auth.refreshSession).mockResolvedValue({
      data: { session: null, user: null },
      error: null,
    } as never);
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    // A causa raiz: `invalidateQueries` refetcha com a sessão JÁ no tenant novo
    // e o profile ainda em cache do anterior. Espionar é o jeito de provar que
    // ninguém reintroduz a chamada.
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    // Wrapper próprio, NÃO o `createQueryWrapper()` do helper: ele cria o
    // QueryClient dele por dentro, então o spy acima seria num cliente que o
    // hook nunca usa — o teste passaria sem testar nada.
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    const { result } = renderHook(() => useSwitchWorkspace(), { wrapper });
    result.current.mutate("tenant-2");

    await waitFor(() => expect(assign).toHaveBeenCalledWith("/app"));
    expect(
      invalidate,
      "invalidateQueries refetcha antes do reload e gera o forbidden",
    ).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("useDashboardReport fica desabilitado para quem não é admin", async () => {
    vi.mocked(useCurrentProfile).mockReturnValue(perfil("agent") as never);
    const rpc = vi.mocked(supabase.rpc);

    const { result } = renderHook(
      () => useDashboardReport(new Date("2026-08-01"), new Date("2026-08-10")),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));
    expect(
      rpc,
      "atendente não pode chamar dashboard_report — a RPC nega com forbidden",
    ).not.toHaveBeenCalled();
  });

  it("useDashboardReport continua habilitado para admin (controle positivo)", async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: {}, error: null } as never);

    const { result } = renderHook(
      () => useDashboardReport(new Date("2026-08-01"), new Date("2026-08-10")),
      { wrapper: createQueryWrapper() },
    );

    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith("dashboard_report", expect.any(Object)),
    );
    expect(result.current.isError).toBe(false);
  });
});
