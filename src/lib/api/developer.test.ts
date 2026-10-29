import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  useAllowedApiScopes,
  useAllowedWebhookEventTypes,
  useApiKeys,
  DeveloperApiError,
  useCanManageDeveloper,
  useCreateApiKey,
  useWebhookDeliveryStats,
  useWebhookEndpoint,
  useCreateWebhookEndpoint,
  useDeleteWebhookEndpoint,
  useRedeliver,
  useRevokeApiKey,
  useRotateWebhookSecret,
  useSendTestWebhook,
  useSetWebhookActive,
  useUpdateWebhookEndpoint,
  useWebhookDeliveries,
  useWebhookEndpoints,
} from "./developer";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile, type CurrentProfile } from "@/lib/api/session";
import { usePermissions } from "@/lib/api/workspaces";
import { createChain } from "@/test/query-mocks";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));
vi.mock("@/lib/api/session", () => ({ useCurrentProfile: vi.fn() }));
vi.mock("@/lib/api/workspaces", () => ({ usePermissions: vi.fn() }));

const SECRET = "whsec_super_secreto_123";
const TOKEN = "acf_live_token_super_secreto_456";
const rpcMock = vi.mocked(supabase.rpc) as unknown as ReturnType<typeof vi.fn>;
const fromMock = vi.mocked(supabase.from) as unknown as ReturnType<typeof vi.fn>;

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

function mockProfile(tenantId: string | null) {
  const profile: CurrentProfile | null = tenantId
    ? { id: "u1", tenant_id: tenantId, name: "Ana", role: "admin" }
    : null;
  vi.mocked(useCurrentProfile).mockReturnValue({
    data: profile,
  } as unknown as ReturnType<typeof useCurrentProfile>);
}

describe("developer hooks", () => {
  beforeEach(() => mockProfile("t1"));
  afterEach(() => vi.resetAllMocks());

  it("erro 42501 do banco vira erro visivel, nao lista vazia", async () => {
    fromMock.mockReturnValue(
      createChain({ data: null, error: { message: "permission denied", code: "42501" } }),
    );
    const { result } = renderHook(() => useWebhookEndpoints(), {
      wrapper: makeWrapper(makeClient()),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeInstanceOf(DeveloperApiError);
    expect(result.current.error).toMatchObject({
      code: "42501",
      message: "Sem permissão para esta ação.",
    });
  });

  it("erro em useApiKeys e em RPC tambem sobe", async () => {
    fromMock.mockReturnValue(createChain({ data: null, error: { message: "negado" } }));
    const keys = renderHook(() => useApiKeys(), { wrapper: makeWrapper(makeClient()) });
    await waitFor(() => expect(keys.result.current.isError).toBe(true));
    rpcMock.mockResolvedValue({ data: null, error: { message: "rpc negada" } });
    const scopes = renderHook(() => useAllowedApiScopes(), { wrapper: makeWrapper(makeClient()) });
    await waitFor(() => expect(scopes.result.current.isError).toBe(true));
  });

  it("listagens nao pedem colunas sensiveis nem select *", async () => {
    const chain = withRange(createChain({ data: [], error: null }));
    fromMock.mockReturnValue(chain);
    const client = makeClient();
    renderHook(() => useApiKeys(), { wrapper: makeWrapper(client) });
    renderHook(() => useWebhookEndpoints(), { wrapper: makeWrapper(client) });
    renderHook(() => useWebhookDeliveries("e1", {}), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(chain.select).toHaveBeenCalledTimes(3));
    for (const call of vi.mocked(chain.select).mock.calls) {
      const cols = String(call[0]);
      expect(cols).not.toContain("*");
      expect(cols).not.toContain("key_hash");
      expect(cols).not.toContain("vault_secret_id");
      expect(cols).not.toContain("locked_by");
    }
  });

  function withRange<T>(chain: T) {
    const c = chain as T & { range: ReturnType<typeof vi.fn> };
    c.range = vi.fn(() => c);
    return c;
  }

  it("send_test_webhook devolve o id e rejeita resposta que nao e string", async () => {
    const mk = () =>
      renderHook(() => useSendTestWebhook(), { wrapper: makeWrapper(makeClient()) }).result;
    rpcMock.mockResolvedValueOnce({ data: "d9", error: null });
    const ok = mk();
    await act(async () => {
      expect(await ok.current.mutateAsync("e1")).toBe("d9");
    });
    expect(rpcMock).toHaveBeenCalledWith("send_test_webhook", { p_id: "e1" });
    rpcMock.mockResolvedValueOnce({ data: null, error: null });
    const bad = mk();
    await act(async () => {
      const err: unknown = await bad.current.mutateAsync("e1").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DeveloperApiError);
    });
  });

  it("deliveries pagina por offset com ordem estavel por created_at e id", async () => {
    const chain = withRange(createChain({ data: [], error: null }));
    fromMock.mockReturnValue(chain);
    renderHook(() => useWebhookDeliveries("e1", { limit: 20, offset: 40 }), {
      wrapper: makeWrapper(makeClient()),
    });
    await waitFor(() => expect(chain.range).toHaveBeenCalledWith(40, 59));
    expect(vi.mocked(chain.order).mock.calls.map((c) => c[0])).toEqual(["created_at", "id"]);
  });

  it("deliveries aplica endpoint e filtros", async () => {
    const chain = withRange(createChain({ data: [], error: null }));
    fromMock.mockReturnValue(chain);
    renderHook(() => useWebhookDeliveries("e1", { status: "dead_letter", limit: 10 }), {
      wrapper: makeWrapper(makeClient()),
    });
    await waitFor(() => expect(chain.eq).toHaveBeenCalledWith("status", "dead_letter"));
    expect(chain.eq).toHaveBeenCalledWith("endpoint_id", "e1");
    expect(chain.range).toHaveBeenCalledWith(0, 9);
  });

  it("segredo criado nao persiste no cache de endpoints nem no cache de mutations", async () => {
    const client = makeClient();
    const wrapper = makeWrapper(client);
    fromMock.mockReturnValue(
      createChain({
        data: [{ id: "e1", url: "https://x.com/h", active: true, event_types: ["deal.won"] }],
        error: null,
      }),
    );
    rpcMock.mockResolvedValue({ data: [{ id: "e1", secret: SECRET }], error: null });
    const list = renderHook(() => useWebhookEndpoints(), { wrapper });
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));

    const create = renderHook(() => useCreateWebhookEndpoint(), { wrapper });
    let created: { id: string; secret: string } | undefined;
    await act(async () => {
      created = await create.result.current.mutateAsync({
        url: "https://x.com/h",
        eventTypes: ["deal.won"],
      });
    });
    expect(created).toEqual({ id: "e1", secret: SECRET });
    // sempre os 5 argumentos: o PostgREST escolhe a sobrecarga com filtros pelos nomes
    expect(rpcMock).toHaveBeenCalledWith("create_webhook_endpoint", {
      p_url: "https://x.com/h",
      p_event_types: ["deal.won"],
      p_description: null,
      p_board_ids: [],
      p_stage_ids: [],
    });
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain(SECRET);
    create.unmount();
    await waitFor(() => expect(client.getMutationCache().getAll()).toHaveLength(0));
  });

  it("rotacao devolve o novo segredo e o descarta do cache", async () => {
    const client = makeClient();
    rpcMock.mockResolvedValue({ data: SECRET, error: null });
    const rot = renderHook(() => useRotateWebhookSecret(), { wrapper: makeWrapper(client) });
    let out: string | undefined;
    await act(async () => {
      out = await rot.result.current.mutateAsync("e1");
    });
    expect(out).toBe(SECRET);
    expect(rpcMock).toHaveBeenCalledWith("rotate_webhook_endpoint_secret", { p_id: "e1" });
    rot.unmount();
    await waitFor(() => expect(client.getMutationCache().getAll()).toHaveLength(0));
  });

  it("rotacao com resposta vazia vira DeveloperApiError sem code", async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    const rot = renderHook(() => useRotateWebhookSecret(), {
      wrapper: makeWrapper(makeClient()),
    });
    await act(async () => {
      const err: unknown = await rot.result.current.mutateAsync("e1").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DeveloperApiError);
      expect(err).toMatchObject({
        code: null,
        message: "Não foi possível concluir a operação. Tente novamente.",
      });
    });
  });

  it("token da chave nao persiste em useApiKeys e create invalida a lista", async () => {
    const client = makeClient();
    const wrapper = makeWrapper(client);
    const chain = createChain({
      data: [{ id: "k1", name: "CRM", key_prefix: "acf_live_ab", scopes: ["deals:read"] }],
      error: null,
    });
    fromMock.mockReturnValue(chain);
    rpcMock.mockResolvedValue({ data: [{ id: "k1", token: TOKEN }], error: null });
    const list = renderHook(() => useApiKeys(), { wrapper });
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
    const create = renderHook(() => useCreateApiKey(), { wrapper });
    let out: { id: string; token: string } | undefined;
    await act(async () => {
      out = await create.result.current.mutateAsync({ name: "CRM", scopes: ["deals:read"] });
    });
    expect(out).toEqual({ id: "k1", token: TOKEN });
    expect(rpcMock).toHaveBeenCalledWith("create_api_key", {
      p_name: "CRM",
      p_scopes: ["deals:read"],
      p_expires_at: null,
    });
    // await no invalidate: a lista ja refez o fetch quando a mutation resolve
    expect(vi.mocked(chain.select).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain(TOKEN);
    create.unmount();
    await waitFor(() => expect(client.getMutationCache().getAll()).toHaveLength(0));
  });

  it.each([
    ["42501", "Sem permissão para esta ação."],
    ["22023", "Dados inválidos. Confira os campos, o tipo de evento ou o escopo informado."],
    [
      "54000",
      "Limite atingido: até 20 webhooks por workspace e até 10 envios de teste por minuto.",
    ],
    ["P0002", "Item não encontrado."],
    ["23514", "Dados inválidos."],
    ["XX000", "Não foi possível concluir a operação. Tente novamente."],
    [undefined, "Não foi possível concluir a operação. Tente novamente."],
  ])("codigo %s vira mensagem em portugues e mantem o code", async (code, message) => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: `raw postgres detail ${SECRET}`, code },
    });
    const del = renderHook(() => useDeleteWebhookEndpoint(), {
      wrapper: makeWrapper(makeClient()),
    });
    await act(async () => {
      const err: unknown = await del.result.current.mutateAsync("e1").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DeveloperApiError);
      expect(err).toMatchObject({ code: code ?? null, message });
      expect((err as Error).message).not.toContain(SECRET);
      expect((err as Error).message).not.toContain("raw postgres");
    });
  });

  it("22023 'filtro invalido' vira mensagem especifica de funil ou etapa", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "filtro invalido", code: "22023" } });
    const create = renderHook(() => useCreateWebhookEndpoint(), {
      wrapper: makeWrapper(makeClient()),
    });
    await act(async () => {
      const err: unknown = await create.result.current
        .mutateAsync({ url: "https://x.com/h", eventTypes: ["deal.won"], stageIds: ["s1"] })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({
        code: "22023",
        message: "Funil ou etapa inválido para este workspace.",
      });
    });
  });

  it("create envia os filtros informados", async () => {
    rpcMock.mockResolvedValue({ data: [{ id: "e1", secret: SECRET }], error: null });
    fromMock.mockReturnValue(createChain({ data: [], error: null }));
    const create = renderHook(() => useCreateWebhookEndpoint(), {
      wrapper: makeWrapper(makeClient()),
    });
    await act(async () => {
      await create.result.current.mutateAsync({
        url: "https://x.com/h",
        eventTypes: ["deal.won"],
        description: "Pago",
        boardIds: ["b1"],
        stageIds: ["s1"],
      });
    });
    expect(rpcMock).toHaveBeenCalledWith("create_webhook_endpoint", {
      p_url: "https://x.com/h",
      p_event_types: ["deal.won"],
      p_description: "Pago",
      p_board_ids: ["b1"],
      p_stage_ids: ["s1"],
    });
  });

  it("update envia os 6 argumentos e espera a lista ser invalidada", async () => {
    const client = makeClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    rpcMock.mockResolvedValue({ data: null, error: null });
    const update = renderHook(() => useUpdateWebhookEndpoint(), { wrapper: makeWrapper(client) });
    await act(async () => {
      await update.result.current.mutateAsync({
        id: "e1",
        url: "https://x.com/h2",
        eventTypes: ["deal.stage_changed"],
        description: null,
        boardIds: ["b1"],
        stageIds: [],
      });
    });
    expect(rpcMock).toHaveBeenCalledWith("update_webhook_endpoint", {
      p_id: "e1",
      p_url: "https://x.com/h2",
      p_event_types: ["deal.stage_changed"],
      p_description: null,
      p_board_ids: ["b1"],
      p_stage_ids: [],
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["webhook-endpoints", "t1"] });
  });

  it("lista de endpoints pede board_ids e stage_ids", async () => {
    const chain = createChain({ data: [], error: null });
    fromMock.mockReturnValue(chain);
    renderHook(() => useWebhookEndpoints(), { wrapper: makeWrapper(makeClient()) });
    await waitFor(() => expect(chain.select).toHaveBeenCalled());
    const cols = String(vi.mocked(chain.select).mock.calls[0][0]);
    expect(cols).toContain("board_ids");
    expect(cols).toContain("stage_ids");
  });

  it("mutation guarda o segredo ate o reset ou unmount, depois o cache nao o contem", async () => {
    const client = makeClient();
    fromMock.mockReturnValue(createChain({ data: [], error: null }));
    rpcMock.mockResolvedValue({ data: [{ id: "e1", secret: SECRET }], error: null });
    const create = renderHook(() => useCreateWebhookEndpoint(), { wrapper: makeWrapper(client) });
    await act(async () => {
      await create.result.current.mutateAsync({ url: "https://x.com/h", eventTypes: ["deal.won"] });
    });
    await waitFor(() => expect(create.result.current.data).toEqual({ id: "e1", secret: SECRET }));
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((q) => q.queryKey),
      ),
    ).not.toContain(SECRET);
    act(() => create.result.current.reset());
    await waitFor(() => expect(client.getMutationCache().getAll()).toHaveLength(0));
    expect(
      JSON.stringify(
        client
          .getMutationCache()
          .getAll()
          .map((m) => m.state.data),
      ),
    ).not.toContain(SECRET);
  });

  function slowRefetchChain(state: { refetchDone: boolean }) {
    let calls = 0;
    const chain = {
      select: () => chain,
      order: () => chain,
      then: (resolve: (v: unknown) => unknown) => {
        calls += 1;
        if (calls === 1) return Promise.resolve({ data: [], error: null }).then(resolve);
        return new Promise((r) =>
          setTimeout(() => {
            state.refetchDone = true;
            r({ data: [], error: null });
          }, 40),
        ).then(resolve);
      },
    };
    return chain;
  }

  it.each([
    [
      "create_webhook_endpoint",
      () => useCreateWebhookEndpoint(),
      { url: "https://x.com/h", eventTypes: ["deal.won"] },
      { data: [{ id: "e1", secret: SECRET }], error: null },
    ],
    [
      "rotate_webhook_endpoint_secret",
      () => useRotateWebhookSecret(),
      "e1",
      { data: SECRET, error: null },
    ],
  ] as const)("%s so resolve depois do refetch da lista", async (_fn, useMut, input, rpcResult) => {
    const state = { refetchDone: false };
    fromMock.mockReturnValue(slowRefetchChain(state));
    rpcMock.mockResolvedValue(rpcResult);
    const client = makeClient();
    const wrapper = makeWrapper(client);
    const list = renderHook(() => useWebhookEndpoints(), { wrapper });
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
    const mut = renderHook(
      () => (useMut as () => { mutateAsync: (v: unknown) => Promise<unknown> })(),
      { wrapper },
    );
    await act(async () => {
      await mut.result.current.mutateAsync(input);
    });
    expect(state.refetchDone).toBe(true);
  });

  it("deliveries limita o limit a 200", async () => {
    const chain = withRange(createChain({ data: [], error: null }));
    fromMock.mockReturnValue(chain);
    renderHook(() => useWebhookDeliveries("e1", { limit: 5000 }), {
      wrapper: makeWrapper(makeClient()),
    });
    await waitFor(() => expect(chain.range).toHaveBeenCalledWith(0, 199));
  });

  it("useWebhookEndpoint busca um endpoint por id sem colunas sensiveis", async () => {
    const chain = createChain({ data: { id: "e1", url: "https://x.com/h" }, error: null });
    fromMock.mockReturnValue(chain);
    const { result } = renderHook(() => useWebhookEndpoint("e1"), {
      wrapper: makeWrapper(makeClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toMatchObject({ id: "e1" });
    expect(chain.eq).toHaveBeenCalledWith("id", "e1");
    const cols = String(vi.mocked(chain.select).mock.calls[0]?.[0]);
    expect(cols).not.toContain("*");
    expect(cols).not.toContain("vault_secret_id");
  });

  it("useWebhookEndpoint propaga erro e devolve null quando nao existe", async () => {
    fromMock.mockReturnValue(createChain({ data: null, error: { message: "x", code: "42501" } }));
    const err = renderHook(() => useWebhookEndpoint("e1"), { wrapper: makeWrapper(makeClient()) });
    await waitFor(() => expect(err.result.current.isError).toBe(true));
    expect(err.result.current.error).toMatchObject({ code: "42501" });
    fromMock.mockReturnValue(createChain({ data: null, error: null }));
    const none = renderHook(() => useWebhookEndpoint("e2"), { wrapper: makeWrapper(makeClient()) });
    await waitFor(() => expect(none.result.current.isSuccess).toBe(true));
    expect(none.result.current.data).toBeNull();
  });

  function statsMock(counts: Record<string, number | "erro">) {
    const calls: { cols: string; opts: unknown; eqs: [string, string][] }[] = [];
    fromMock.mockImplementation(() => {
      const call = { cols: "", opts: undefined as unknown, eqs: [] as [string, string][] };
      calls.push(call);
      const q = {
        select: (cols: string, opts?: unknown) => {
          call.cols = cols;
          call.opts = opts;
          return q;
        },
        eq: (c: string, v: string) => {
          call.eqs.push([c, v]);
          return q;
        },
        then: (resolve: (v: unknown) => unknown) => {
          const status = call.eqs.find((e) => e[0] === "status")?.[1] ?? "";
          const n = counts[status] ?? 0;
          const result =
            n === "erro"
              ? { data: null, error: { message: "x", code: "42501" }, count: null }
              : { data: null, error: null, count: n };
          return Promise.resolve(result).then(resolve);
        },
      };
      return q;
    });
    return calls;
  }

  it("useWebhookDeliveryStats conta por status com head e count exact, sem linhas", async () => {
    const calls = statsMock({ delivered: 7, pending: 2, processing: 1, dead_letter: 3 });
    const { result } = renderHook(() => useWebhookDeliveryStats("e1"), {
      wrapper: makeWrapper(makeClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({
      delivered: 7,
      pending: 2,
      processing: 1,
      dead_letter: 3,
    });
    expect(calls).toHaveLength(4);
    for (const c of calls) {
      expect(c.opts).toEqual({ count: "exact", head: true });
      expect(c.eqs).toContainEqual(["endpoint_id", "e1"]);
    }
  });

  it("useWebhookDeliveryStats propaga erro de qualquer status", async () => {
    statsMock({ delivered: 1, dead_letter: "erro" });
    const { result } = renderHook(() => useWebhookDeliveryStats("e1"), {
      wrapper: makeWrapper(makeClient()),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ code: "42501" });
  });

  it.each([
    [
      "set_webhook_endpoint_active",
      () => useSetWebhookActive(),
      { id: "e1", active: false },
      { p_id: "e1", p_active: false },
    ],
    ["delete_webhook_endpoint", () => useDeleteWebhookEndpoint(), "e1", { p_id: "e1" }],
    ["redeliver_webhook", () => useRedeliver(), "d1", { p_delivery_id: "d1" }],
    ["revoke_api_key", () => useRevokeApiKey(), "k1", { p_id: "k1" }],
  ] as const)("%s chama a RPC com os parametros certos", async (fn, useHook, input, args) => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    const { result } = renderHook(
      () => (useHook as () => { mutateAsync: (v: unknown) => Promise<unknown> })(),
      {
        wrapper: makeWrapper(makeClient()),
      },
    );
    await act(async () => {
      await result.current.mutateAsync(input);
    });
    expect(rpcMock).toHaveBeenCalledWith(fn, args);
  });

  it("listas permitidas vem das RPCs", async () => {
    rpcMock.mockResolvedValueOnce({ data: ["deal.won"], error: null });
    const ev = renderHook(() => useAllowedWebhookEventTypes(), {
      wrapper: makeWrapper(makeClient()),
    });
    await waitFor(() => expect(ev.result.current.data).toEqual(["deal.won"]));
    expect(rpcMock).toHaveBeenCalledWith("webhook_allowed_event_types", undefined);
  });

  it.each([
    [undefined, true, { allowed: false, isLoading: true }],
    [["developer.manage"], false, { allowed: true, isLoading: false }],
    [["contacts.read"], false, { allowed: false, isLoading: false }],
  ])("useCanManageDeveloper com permissoes %j", (data, isPending, expected) => {
    vi.mocked(usePermissions).mockReturnValue({ data, isPending } as unknown as ReturnType<
      typeof usePermissions
    >);
    const { result } = renderHook(() => useCanManageDeveloper());
    expect(result.current).toEqual(expected);
  });
});
