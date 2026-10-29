import { afterEach, describe, expect, it, vi } from "vitest";

type CapturedCall = { url: unknown; key: unknown; options: SupabaseClientOptions };
type SupabaseClientOptions = {
  global: { fetch: typeof fetch };
  auth: { storage: unknown; persistSession: boolean; autoRefreshToken: boolean };
};

let lastCall: CapturedCall | undefined;
const createClientMock = vi.fn((url: unknown, key: unknown, options: SupabaseClientOptions) => {
  lastCall = { url, key, options };
  return { __fakeAdminClient: true, url, key };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: createClientMock,
}));

async function loadClientServerModule() {
  vi.resetModules();
  lastCall = undefined;
  createClientMock.mockClear();
  return import("./client.server");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("supabaseAdmin (proxy lazy, service role)", () => {
  it("lança erro descritivo e loga no console quando faltam as env vars de servidor", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { supabaseAdmin } = await loadClientServerModule();

    expect(() => supabaseAdmin.auth).toThrow(
      /Missing Supabase environment variable\(s\): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY/,
    );
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("cria o client admin com a service role key, sem storage/persistência de sessão", async () => {
    vi.stubEnv("SUPABASE_URL", "https://server.example.test");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_service_role");

    const { supabaseAdmin } = await loadClientServerModule();
    void supabaseAdmin.auth;

    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(lastCall?.url).toBe("https://server.example.test");
    expect(lastCall?.key).toBe("sb_secret_service_role");
    expect(lastCall?.options.auth).toEqual({
      storage: undefined,
      persistSession: false,
      autoRefreshToken: false,
    });
  });

  it("cria o client uma única vez e reutiliza a instância cacheada no proxy", async () => {
    vi.stubEnv("SUPABASE_URL", "https://server.example.test");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_service_role");

    const { supabaseAdmin } = await loadClientServerModule();
    void supabaseAdmin.auth;
    void supabaseAdmin.from;

    expect(createClientMock).toHaveBeenCalledTimes(1);
  });

  it("relata apenas a variável que está faltando quando só uma delas está ausente", async () => {
    vi.stubEnv("SUPABASE_URL", "https://server.example.test");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");

    const { supabaseAdmin } = await loadClientServerModule();

    expect(() => supabaseAdmin.auth).toThrow(
      /Missing Supabase environment variable\(s\): SUPABASE_SERVICE_ROLE_KEY(?!, )/,
    );
  });
});

describe("fetch customizado do client admin (createSupabaseFetch)", () => {
  async function getConfiguredFetch(serviceRoleKey: string): Promise<typeof fetch> {
    vi.stubEnv("SUPABASE_URL", "https://server.example.test");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", serviceRoleKey);
    const { supabaseAdmin } = await loadClientServerModule();
    void supabaseAdmin.auth;
    return lastCall!.options.global.fetch;
  }

  it("remove Authorization Bearer quando a chave nova (sb_secret_) bate com o header", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", mockFetch);
    const customFetch = await getConfiguredFetch("sb_secret_abc123");

    const request = new Request("https://api.test/rpc", {
      headers: { Authorization: "Bearer sb_secret_abc123" },
    });
    await customFetch(request);

    const [, calledInit] = mockFetch.mock.calls[0] as [unknown, { headers: Headers }];
    expect(calledInit.headers.get("Authorization")).toBeNull();
    expect(calledInit.headers.get("apikey")).toBe("sb_secret_abc123");
  });

  it("preserva Authorization para chave em formato JWT legado e mescla headers de init", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", mockFetch);
    const legacyKey = "legacy.jwt.key";
    const customFetch = await getConfiguredFetch(legacyKey);

    const request = new Request("https://api.test/rpc", {
      headers: { Authorization: `Bearer ${legacyKey}`, "x-original": "1" },
    });
    await customFetch(request, { headers: { "x-extra": "2" } });

    const [, calledInit] = mockFetch.mock.calls[0] as [unknown, { headers: Headers }];
    expect(calledInit.headers.get("Authorization")).toBe(`Bearer ${legacyKey}`);
    expect(calledInit.headers.get("x-original")).toBe("1");
    expect(calledInit.headers.get("x-extra")).toBe("2");
    expect(calledInit.headers.get("apikey")).toBe(legacyKey);
  });

  it("funciona quando o input não é uma instância de Request", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", mockFetch);
    const customFetch = await getConfiguredFetch("sb_secret_abc123");

    await customFetch("https://api.test/rpc");

    const [calledInput, calledInit] = mockFetch.mock.calls[0] as [string, { headers: Headers }];
    expect(calledInput).toBe("https://api.test/rpc");
    expect(calledInit.headers.get("apikey")).toBe("sb_secret_abc123");
  });
});
