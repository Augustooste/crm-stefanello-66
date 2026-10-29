import { renderHook } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { supabase } from "@/integrations/supabase/client";
import { createTestQueryClient } from "@/test/render";
import { useChannelStatusEvents } from "./channel-status";

vi.mock("@/integrations/supabase/client", () => {
  const builder = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    limit: () => Promise.resolve({ data: [], error: null }),
  };
  return {
    supabase: {
      from: vi.fn(() => builder),
      channel: vi.fn(),
      removeChannel: vi.fn(),
    },
  };
});

/**
 * Imita o RealtimeClient de @supabase/realtime-js@2.110.0: `channel(nome)`
 * devolve o canal JÁ EXISTENTE para nomes iguais, e `.on()` lança quando o
 * canal já foi inscrito — a race de remontagem rápida antes do nome único.
 */
interface MockChannel {
  subscribed: boolean;
  on: Mock;
  subscribe: Mock;
}

function createChannelFactory() {
  const channels = new Map<string, MockChannel>();
  return (name: string) => {
    const existing = channels.get(name);
    if (existing) return existing;

    const ch = { subscribed: false, on: vi.fn(), subscribe: vi.fn() } as MockChannel;
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
  return <QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.mocked(supabase.channel).mockReset();
  vi.mocked(supabase.removeChannel).mockReset();
  vi.mocked(supabase.channel).mockImplementation(
    createChannelFactory() as unknown as typeof supabase.channel,
  );
  vi.mocked(supabase.removeChannel).mockReturnValue(Promise.resolve("ok"));
});

describe("useChannelStatusEvents (realtime)", () => {
  it("remontagem rápida com o mesmo canal gera nome distinto e não lança", () => {
    renderHook(() => useChannelStatusEvents("c1"), { wrapper }).unmount();
    // Reabrir o diagnóstico do mesmo canal antes do removeChannel assíncrono
    // concluir: com nome fixo, `.on()` lançava dentro do efeito.
    renderHook(() => useChannelStatusEvents("c1"), { wrapper }).unmount();

    const names = vi.mocked(supabase.channel).mock.calls.map((call) => call[0] as string);
    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);
    expect(names.every((n) => n.startsWith("channel-status-c1:"))).toBe(true);
    expect(vi.mocked(supabase.removeChannel)).toHaveBeenCalledTimes(2);
  });

  it("não assina realtime sem canal ou desabilitado", () => {
    renderHook(() => useChannelStatusEvents(null), { wrapper }).unmount();
    renderHook(() => useChannelStatusEvents("c1", false), { wrapper }).unmount();

    expect(vi.mocked(supabase.channel)).not.toHaveBeenCalled();
  });
});
