import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useHumanAttentionCount } from "./human-attention";
import { supabase } from "@/integrations/supabase/client";
import { createQueryBuilder, ok } from "@/test/supabase-mock";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(),
    channel: vi.fn(),
    removeChannel: vi.fn(),
  },
}));

function makeQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

/** Stub do RealtimeChannel: `on`/`subscribe` encadeiam (`this`), como o real. */
function mockChannel() {
  const channel = {
    on: vi.fn().mockReturnThis(),
    subscribe: vi.fn().mockReturnThis(),
  };
  vi.mocked(supabase.channel).mockReturnValue(
    channel as unknown as ReturnType<typeof supabase.channel>,
  );
  return channel;
}

describe("useHumanAttentionCount", () => {
  afterEach(() => vi.clearAllMocks());

  it("não consulta nem assina canal quando não há tenantId", () => {
    mockChannel();
    const { result } = renderHook(() => useHumanAttentionCount(null), {
      wrapper: createWrapper(makeQueryClient()),
    });

    expect(result.current).toBe(0);
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.channel).not.toHaveBeenCalled();
  });

  it("retorna a contagem de conversas aguardando humano aplicando os filtros corretos", async () => {
    mockChannel();
    const builder = createQueryBuilder<null>(ok(null, { count: 7 }));
    vi.mocked(supabase.from).mockReturnValue(
      builder as unknown as ReturnType<typeof supabase.from>,
    );

    const { result } = renderHook(() => useHumanAttentionCount("t1"), {
      wrapper: createWrapper(makeQueryClient()),
    });

    await waitFor(() => expect(result.current).toBe(7));
    expect(supabase.from).toHaveBeenCalledWith("conversations");
    expect(builder.select).toHaveBeenCalledWith("id", { count: "exact", head: true });
    expect(builder.eq).toHaveBeenCalledWith("awaiting_human", true);
    // Conversa fechada não conta como urgência ativa mesmo com o flag ligado.
    expect(builder.neq).toHaveBeenCalledWith("status", "closed");
  });

  it("retorna 0 quando a contagem vem null/undefined", async () => {
    mockChannel();
    const builder = createQueryBuilder<null>(ok(null));
    vi.mocked(supabase.from).mockReturnValue(
      builder as unknown as ReturnType<typeof supabase.from>,
    );

    const { result } = renderHook(() => useHumanAttentionCount("t1"), {
      wrapper: createWrapper(makeQueryClient()),
    });

    await waitFor(() => expect(builder.select).toHaveBeenCalled());
    expect(result.current).toBe(0);
  });

  it("retorna 0 quando a consulta falha (badge não trava a UI)", async () => {
    mockChannel();
    const builder = createQueryBuilder<null>({ data: null, error: { message: "falhou" } });
    vi.mocked(supabase.from).mockReturnValue(
      builder as unknown as ReturnType<typeof supabase.from>,
    );
    const queryClient = makeQueryClient();

    const { result } = renderHook(() => useHumanAttentionCount("t1"), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() =>
      expect(queryClient.getQueryState(["human-attention-count", "t1"])?.status).toBe("error"),
    );
    expect(result.current).toBe(0);
  });

  it("assina o canal realtime do tenant e remove ao desmontar", () => {
    const channel = mockChannel();
    const builder = createQueryBuilder<null>(ok(null, { count: 0 }));
    vi.mocked(supabase.from).mockReturnValue(
      builder as unknown as ReturnType<typeof supabase.from>,
    );

    const { unmount } = renderHook(() => useHumanAttentionCount("t1"), {
      wrapper: createWrapper(makeQueryClient()),
    });

    expect(supabase.channel).toHaveBeenCalledWith(
      expect.stringMatching(/^human-attention:t1:[0-9a-f-]{36}$/),
    );
    expect(channel.on).toHaveBeenCalledWith(
      "postgres_changes",
      { event: "*", schema: "public", table: "conversations", filter: "tenant_id=eq.t1" },
      expect.any(Function),
    );
    expect(channel.subscribe).toHaveBeenCalled();
    expect(supabase.removeChannel).not.toHaveBeenCalled();

    unmount();
    expect(supabase.removeChannel).toHaveBeenCalledWith(channel);
  });

  it("invalida a contagem quando o canal recebe um evento postgres_changes", async () => {
    const channel = mockChannel();
    const builder = createQueryBuilder<null>(ok(null, { count: 1 }));
    vi.mocked(supabase.from).mockReturnValue(
      builder as unknown as ReturnType<typeof supabase.from>,
    );
    const queryClient = makeQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    renderHook(() => useHumanAttentionCount("t1"), { wrapper: createWrapper(queryClient) });
    await waitFor(() => expect(builder.select).toHaveBeenCalled());

    const onEvent = channel.on.mock.calls[0]?.[2] as () => void;
    act(() => onEvent());

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["human-attention-count", "t1"] }),
    );
  });

  it("resubscreve num canal novo (nome com o novo tenant) quando o tenantId muda", () => {
    const channel = mockChannel();
    const builder = createQueryBuilder<null>(ok(null, { count: 0 }));
    vi.mocked(supabase.from).mockReturnValue(
      builder as unknown as ReturnType<typeof supabase.from>,
    );

    const { rerender } = renderHook(({ tenantId }) => useHumanAttentionCount(tenantId), {
      wrapper: createWrapper(makeQueryClient()),
      initialProps: { tenantId: "t1" as string | null },
    });
    expect(supabase.channel).toHaveBeenCalledWith(
      expect.stringMatching(/^human-attention:t1:[0-9a-f-]{36}$/),
    );

    rerender({ tenantId: "t2" });

    // Efeito antigo limpa o canal de t1 antes de assinar o de t2.
    expect(supabase.removeChannel).toHaveBeenCalledWith(channel);
    expect(supabase.channel).toHaveBeenCalledWith(
      expect.stringMatching(/^human-attention:t2:[0-9a-f-]{36}$/),
    );
  });
});
