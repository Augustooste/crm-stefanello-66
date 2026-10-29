import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

const rpc = vi.fn().mockResolvedValue({ error: null });
const getSession = vi.fn().mockResolvedValue({ data: { session: null } });

// A árvore de rotas real importa componentes que dependem do client Supabase;
// mocamos para evitar a criação do client real (exige env vars) neste teste.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: () => getSession(),
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
    },
    from: vi.fn(),
    rpc: (...args: unknown[]) => rpc(...args),
  },
}));

import { getRouter } from "./router";
import { RouterPendingFallback } from "./components/common/RouterPendingFallback";

describe("getRouter", () => {
  it("cria um router com QueryClient próprio no context e opções de scroll/preload", () => {
    const router = getRouter();

    expect(router.options.context?.queryClient).toBeInstanceOf(QueryClient);
    expect(router.options.scrollRestoration).toBe(true);
    // Query controla frescor; o Router não mantém um segundo cache de preload.
    expect(router.options.defaultPreloadStaleTime).toBe(0);
  });

  it("QueryClient tem staleTime configurado (mata refetch a cada mount/foco)", () => {
    const router = getRouter();
    const qc = router.options.context?.queryClient as QueryClient;
    const opts = qc.getDefaultOptions().queries;

    expect(opts?.staleTime).toBe(60_000);
    expect(opts?.refetchOnWindowFocus).toBe(false);
  });

  it("cada chamada produz uma instância nova de router e de queryClient", () => {
    const routerA = getRouter();
    const routerB = getRouter();

    expect(routerA).not.toBe(routerB);
    expect(routerA.options.context?.queryClient).not.toBe(routerB.options.context?.queryClient);
  });

  it("configura RouterPendingFallback como defaultPendingComponent (evita tela em branco em deep-link com beforeLoad lento)", () => {
    const router = getRouter();

    expect(router.options.defaultPendingComponent).toBe(RouterPendingFallback);
  });

  // Regressão: 27 das 28 mutations do app não declaram `mutationKey`, então
  // `context.operation` ficava simplesmente ausente para quase todo erro de
  // mutation em produção (caso /configuracoes). O marcador torna a lacuna
  // visível em vez de omitir o campo.
  it("mutation sem mutationKey grava marcador honesto em context.operation", async () => {
    rpc.mockClear();
    getSession.mockResolvedValue({ data: { session: { user: { id: "u1" } } } });
    const router = getRouter();
    const queryClient = router.options.context?.queryClient as QueryClient;

    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: async () => {
        throw new Error("falha sem mutationKey");
      },
    });

    await expect(mutation.execute(undefined)).rejects.toThrow("falha sem mutationKey");
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));

    const [, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    const context = args.p_context as Record<string, string>;
    expect(context.operation).toBe("(sem mutationKey)");
  });
});
