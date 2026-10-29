import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import {
  useTenantIntegrations,
  useIntegration,
  useTenantChannels,
  type TenantIntegrationRow,
  type ChannelRow,
} from "./integrations";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile, type CurrentProfile } from "@/lib/api/session";
import { createChain, createQueryWrapper } from "@/test/query-mocks";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock("@/lib/api/session", () => ({ useCurrentProfile: vi.fn() }));

function mockProfile(tenantId: string | null) {
  const profile: CurrentProfile | null = tenantId
    ? { id: "u1", tenant_id: tenantId, name: "Ana", role: "admin" }
    : null;
  vi.mocked(useCurrentProfile).mockReturnValue({
    data: profile,
  } as unknown as ReturnType<typeof useCurrentProfile>);
}

describe("useTenantIntegrations", () => {
  afterEach(() => vi.clearAllMocks());

  it("fica desabilitado sem tenant", () => {
    mockProfile(null);
    const { result } = renderHook(() => useTenantIntegrations(), {
      wrapper: createQueryWrapper(),
    });
    expect(result.current.data).toBeUndefined();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("busca as integrações do tenant", async () => {
    mockProfile("t1");
    const rows: TenantIntegrationRow[] = [
      {
        slug: "whatsapp",
        status: "active",
        config: { foo: "bar" },
        connected_at: "2026-01-01",
        last_check_at: null,
        last_error: null,
        webhook_token: "tok",
      },
    ];
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: rows, error: null }) as unknown as ReturnType<typeof supabase.from>,
    );
    const { result } = renderHook(() => useTenantIntegrations(), {
      wrapper: createQueryWrapper(),
    });
    await waitFor(() => expect(result.current.data).toEqual(rows));
    expect(supabase.from).toHaveBeenCalledWith("tenant_integrations");
  });

  it("retorna array vazio quando data é null", async () => {
    mockProfile("t1");
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: null, error: null }) as unknown as ReturnType<typeof supabase.from>,
    );
    const { result } = renderHook(() => useTenantIntegrations(), {
      wrapper: createQueryWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });

  it("propaga erro", async () => {
    mockProfile("t1");
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: null, error: new Error("boom") }) as unknown as ReturnType<
        typeof supabase.from
      >,
    );
    const { result } = renderHook(() => useTenantIntegrations(), {
      wrapper: createQueryWrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("useTenantChannels", () => {
  afterEach(() => vi.clearAllMocks());

  function mockChannelsSelect(data: unknown[] | null, error: unknown = null) {
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data, error }) as unknown as ReturnType<typeof supabase.from>,
    );
  }

  it("faz merge do webhook_token vindo da RPC get_channel_webhook_tokens", async () => {
    mockProfile("t1");
    mockChannelsSelect([
      {
        id: "c1",
        provider_slug: "evolution",
        status: "connected",
        config: null,
        webhook_health: "ok",
        last_connected_at: "2026-01-01",
        status_message: null,
      },
    ]);
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: [{ channel_id: "c1", webhook_token: "tok-abc" }],
      error: null,
    } as never);

    const { result } = renderHook(() => useTenantChannels(), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(supabase.rpc).toHaveBeenCalledWith("get_channel_webhook_tokens");
    const rows = result.current.data as ChannelRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "c1", webhook_token: "tok-abc" });
  });

  it("retorna webhook_token null quando a RPC não devolve token pro canal (ex.: usuário não-admin)", async () => {
    mockProfile("t1");
    mockChannelsSelect([
      {
        id: "c1",
        provider_slug: "evolution",
        status: "connected",
        config: null,
        webhook_health: "ok",
        last_connected_at: null,
        status_message: null,
      },
    ]);
    vi.mocked(supabase.rpc).mockResolvedValue({ data: [], error: null } as never);

    const { result } = renderHook(() => useTenantChannels(), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const rows = result.current.data as ChannelRow[];
    expect(rows[0].webhook_token).toBeNull();
  });

  it("propaga erro do select de channels", async () => {
    mockProfile("t1");
    mockChannelsSelect(null, new Error("boom"));
    vi.mocked(supabase.rpc).mockResolvedValue({ data: [], error: null } as never);

    const { result } = renderHook(() => useTenantChannels(), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it("propaga erro da RPC get_channel_webhook_tokens", async () => {
    mockProfile("t1");
    mockChannelsSelect([]);
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: null,
      error: new Error("rpc boom"),
    } as never);

    const { result } = renderHook(() => useTenantChannels(), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("useIntegration", () => {
  afterEach(() => vi.clearAllMocks());

  it("retorna status disabled sem tenant", () => {
    mockProfile(null);
    const { result } = renderHook(() => useIntegration("whatsapp"), {
      wrapper: createQueryWrapper(),
    });
    expect(result.current.status).toBe("disabled");
    expect(result.current.isActive).toBe(false);
    expect(result.current.config).toBeNull();
  });

  it("retorna a integração correspondente pelo slug", async () => {
    mockProfile("t1");
    const rows: TenantIntegrationRow[] = [
      {
        slug: "whatsapp",
        status: "active",
        config: { number: "123" },
        connected_at: null,
        last_check_at: null,
        last_error: null,
        webhook_token: null,
      },
    ];
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: rows, error: null }) as unknown as ReturnType<typeof supabase.from>,
    );
    const { result } = renderHook(() => useIntegration("whatsapp"), {
      wrapper: createQueryWrapper(),
    });
    await waitFor(() => expect(result.current.status).toBe("active"));
    expect(result.current.isActive).toBe(true);
    expect(result.current.config).toEqual({ number: "123" });
  });

  it("retorna disabled quando o slug não existe entre as integrações", async () => {
    mockProfile("t1");
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: [], error: null }) as unknown as ReturnType<typeof supabase.from>,
    );
    const { result } = renderHook(() => useIntegration("elevenlabs"), {
      wrapper: createQueryWrapper(),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.status).toBe("disabled");
    expect(result.current.config).toBeNull();
  });
});
