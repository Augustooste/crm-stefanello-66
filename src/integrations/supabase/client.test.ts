import { afterEach, describe, expect, it, vi } from "vitest";

type CapturedCall = { url: unknown; key: unknown; options: SupabaseClientOptions };
type SupabaseClientOptions = {
  global: { fetch: typeof fetch };
  auth: { storage: unknown; persistSession: boolean; autoRefreshToken: boolean };
};

let lastCall: CapturedCall | undefined;
const createClientMock = vi.fn((url: unknown, key: unknown, options: SupabaseClientOptions) => {
  lastCall = { url, key, options };
  return { __fakeClient: true, url, key };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: createClientMock,
}));

/** Reimporta o módulo do zero — o client é um singleton em cache no proxy exportado. */
async function loadClientModule() {
  vi.resetModules();
  lastCall = undefined;
  createClientMock.mockClear();
  return import("./client");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("supabase client (proxy lazy)", () => {
  it("lança erro descritivo e loga no console quando faltam as env vars", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "");
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "");
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { supabase } = await loadClientModule();

    expect(() => supabase.auth).toThrow(
      /Missing Supabase environment variable\(s\): SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY/,
    );
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("usa import.meta.env (VITE_*) quando disponível e configura storage/persistência para o browser", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://vite.example.test");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_abc123");
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "");

    const { supabase } = await loadClientModule();
    // Qualquer acesso de propriedade dispara a criação lazy do client real.
    void supabase.auth;

    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(lastCall?.url).toBe("https://vite.example.test");
    expect(lastCall?.key).toBe("sb_publishable_abc123");
    expect(lastCall?.options.auth).toEqual({
      storage: localStorage,
      persistSession: true,
      autoRefreshToken: true,
    });
  });

  it("cria o client uma única vez e reutiliza a instância em acessos seguintes (proxy cacheado)", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://vite.example.test");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_abc123");

    const { supabase } = await loadClientModule();
    void supabase.auth;
    void supabase.from;

    expect(createClientMock).toHaveBeenCalledTimes(1);
  });

  it("cai para process.env quando as variáveis VITE_* não estão definidas", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "");
    vi.stubEnv("SUPABASE_URL", "https://server.example.test");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_server");

    const { supabase } = await loadClientModule();
    void supabase.auth;

    expect(lastCall?.url).toBe("https://server.example.test");
    expect(lastCall?.key).toBe("sb_publishable_server");
  });

  it("usa storage undefined quando não há `window` (contexto de servidor)", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://vite.example.test");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_abc123");
    vi.stubGlobal("window", undefined);

    const { supabase } = await loadClientModule();
    void supabase.auth;

    expect(lastCall?.options.auth.storage).toBeUndefined();
  });
});

describe("fetch customizado (createSupabaseFetch, exercitado via options.global.fetch)", () => {
  async function getConfiguredFetch(supabaseKey: string): Promise<typeof fetch> {
    vi.stubEnv("VITE_SUPABASE_URL", "https://vite.example.test");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", supabaseKey);
    const { supabase } = await loadClientModule();
    void supabase.auth;
    return lastCall!.options.global.fetch;
  }

  it("remove o header Authorization quando a chave nova (sb_publishable_) bate com o Bearer enviado", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", mockFetch);
    const customFetch = await getConfiguredFetch("sb_publishable_abc123");

    const request = new Request("https://api.test/rpc", {
      headers: { Authorization: "Bearer sb_publishable_abc123" },
    });
    await customFetch(request);

    const [, calledInit] = mockFetch.mock.calls[0] as [unknown, { headers: Headers }];
    expect(calledInit.headers.get("Authorization")).toBeNull();
    expect(calledInit.headers.get("apikey")).toBe("sb_publishable_abc123");
  });

  it("preserva o header Authorization quando a chave é o formato JWT legado", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", mockFetch);
    const legacyKey = "legacy.jwt.key";
    const customFetch = await getConfiguredFetch(legacyKey);

    const request = new Request("https://api.test/rpc", {
      headers: { Authorization: `Bearer ${legacyKey}` },
    });
    await customFetch(request);

    const [, calledInit] = mockFetch.mock.calls[0] as [unknown, { headers: Headers }];
    expect(calledInit.headers.get("Authorization")).toBe(`Bearer ${legacyKey}`);
    expect(calledInit.headers.get("apikey")).toBe(legacyKey);
  });

  it("preserva o Authorization de sessão de usuário mesmo com chave nova (Bearer não é o apikey)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", mockFetch);
    const customFetch = await getConfiguredFetch("sb_publishable_abc123");

    const request = new Request("https://api.test/rpc", {
      headers: { Authorization: "Bearer user-session-token" },
    });
    await customFetch(request);

    const [, calledInit] = mockFetch.mock.calls[0] as [unknown, { headers: Headers }];
    expect(calledInit.headers.get("Authorization")).toBe("Bearer user-session-token");
  });

  it("mescla headers de `init` por cima dos headers do input", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", mockFetch);
    const customFetch = await getConfiguredFetch("sb_publishable_abc123");

    const request = new Request("https://api.test/rpc", {
      headers: { "x-original": "1" },
    });
    await customFetch(request, { headers: { "x-extra": "2" } });

    const [, calledInit] = mockFetch.mock.calls[0] as [unknown, { headers: Headers }];
    expect(calledInit.headers.get("x-original")).toBe("1");
    expect(calledInit.headers.get("x-extra")).toBe("2");
    expect(calledInit.headers.get("apikey")).toBe("sb_publishable_abc123");
  });

  it("funciona quando o input não é uma instância de Request (ex.: string de URL)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", mockFetch);
    const customFetch = await getConfiguredFetch("sb_publishable_abc123");

    await customFetch("https://api.test/rpc");

    const [calledInput, calledInit] = mockFetch.mock.calls[0] as [string, { headers: Headers }];
    expect(calledInput).toBe("https://api.test/rpc");
    expect(calledInit.headers.get("apikey")).toBe("sb_publishable_abc123");
  });
});
