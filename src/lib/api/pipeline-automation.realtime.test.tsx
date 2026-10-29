import { renderHook } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { supabase } from "@/integrations/supabase/client";
import { createTestQueryClient } from "@/test/render";
import { usePipelineRealtime } from "./pipeline-automation";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    channel: vi.fn(),
    removeChannel: vi.fn(),
  },
}));

/**
 * Reproduz o comportamento do RealtimeClient de @supabase/realtime-js@2.110.0:
 * `supabase.channel(nome)` devolve o canal JÁ EXISTENTE para nomes iguais, e
 * `RealtimeChannel.on()` lança "cannot add postgres_changes callbacks after
 * subscribe()" quando o canal já foi inscrito. É exatamente a race que o
 * `usePipelineRealtime` corrigiu ao gerar nome único por subscribe.
 */
interface MockChannel {
  name: string;
  subscribed: boolean;
  on: Mock;
  subscribe: Mock;
}

function createChannelFactory() {
  const channels = new Map<string, MockChannel>();
  return (name: string) => {
    const existing = channels.get(name);
    if (existing) return existing;

    const ch = { name, subscribed: false, on: vi.fn(), subscribe: vi.fn() } as MockChannel;
    ch.on.mockImplementation(() => {
      if (ch.subscribed) {
        throw new Error("cannot add postgres_changes callbacks after subscribe()");
      }
      return ch;
    });
    ch.subscribe.mockImplementation(() => {
      ch.subscribed = true;
      return ch;
    });
    channels.set(name, ch);
    return ch;
  };
}

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = createTestQueryClient();
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.mocked(supabase.channel).mockImplementation(
    createChannelFactory() as unknown as typeof supabase.channel,
  );
  vi.mocked(supabase.removeChannel).mockReturnValue(Promise.resolve("ok"));
});

describe("usePipelineRealtime", () => {
  it("remontagem rápida com o mesmo tenant+board gera nome distinto e não lança", () => {
    // 1ª montagem: cria o canal e inscreve.
    const first = renderHook(() => usePipelineRealtime({ tenantId: "t1", boardId: "b1" }), {
      wrapper,
    });
    first.unmount();

    // 2ª montagem, mesmo tenant+board (StrictMode/trocar de rota e voltar).
    // Antes do fix o nome era determinístico → `channel()` devolvia o canal já
    // inscrito → `.on()` lançava dentro do efeito e estourava a árvore React.
    const second = renderHook(() => usePipelineRealtime({ tenantId: "t1", boardId: "b1" }), {
      wrapper,
    });
    second.unmount();

    const names = vi.mocked(supabase.channel).mock.calls.map((call) => call[0] as string);
    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);
    expect(names[0]).toMatch(/^pipeline:t1:b1:/);
    expect(names[1]).toMatch(/^pipeline:t1:b1:/);

    // cleanup de cada montagem removeu o canal respectivo.
    expect(vi.mocked(supabase.removeChannel)).toHaveBeenCalledTimes(2);
  });

  it("não cria canal quando tenantId ou boardId ausente", () => {
    const { unmount } = renderHook(() => usePipelineRealtime({ tenantId: undefined }), {
      wrapper,
    });
    unmount();

    expect(vi.mocked(supabase.channel)).not.toHaveBeenCalled();
  });
});
