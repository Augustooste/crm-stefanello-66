import { afterEach, describe, expect, it, vi } from "vitest";

type CapturedCall = { options: SupabaseClientOptions };
type SupabaseClientOptions = {
  global: { fetch: typeof fetch; headers: Record<string, string> };
  auth: { storage: unknown; persistSession: boolean; autoRefreshToken: boolean };
};

let lastCall: CapturedCall | undefined;
const getClaimsMock = vi.fn();
const createClientMock = vi.fn((_url: unknown, _key: unknown, options: SupabaseClientOptions) => {
  lastCall = { options };
  return { auth: { getClaims: getClaimsMock } };
});
const getRequestMock = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: createClientMock,
}));

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: getRequestMock,
}));

vi.mock("@tanstack/react-start", () => ({
  createMiddleware: () => ({
    server: (fn: unknown) => fn,
  }),
}));

const { requireSupabaseAuth } = await import("./auth-middleware");

type NextFn = (opts: {
  context: { supabase: unknown; userId: string; claims: unknown };
}) => unknown;
type MiddlewareFn = (args: { next: NextFn }) => Promise<unknown>;
const middleware = requireSupabaseAuth as unknown as MiddlewareFn;

function makeRequest(headers: Record<string, string>): { headers: Headers } {
  return { headers: new Headers(headers) };
}

const VALID_TOKEN = "aaa.bbb.ccc";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  createClientMock.mockClear();
  getClaimsMock.mockReset();
  getRequestMock.mockReset();
  lastCall = undefined;
});

describe("requireSupabaseAuth — validações antes de consultar o Supabase", () => {
  it("lança erro descritivo quando faltam as env vars", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "");
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(middleware({ next: vi.fn() })).rejects.toThrow(
      /Missing Supabase environment variable\(s\): SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY/,
    );
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("rejeita quando getRequest() não devolve uma request com headers", async () => {
    vi.stubEnv("SUPABASE_URL", "https://server.example.test");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_abc");
    getRequestMock.mockReturnValue(undefined);

    await expect(middleware({ next: vi.fn() })).rejects.toThrow(
      "Unauthorized: No request headers available",
    );
  });

  it("rejeita quando não há header authorization", async () => {
    vi.stubEnv("SUPABASE_URL", "https://server.example.test");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_abc");
    getRequestMock.mockReturnValue(makeRequest({}));

    await expect(middleware({ next: vi.fn() })).rejects.toThrow(
      "Unauthorized: No authorization header provided",
    );
  });

  it("rejeita quando o header não é um Bearer token", async () => {
    vi.stubEnv("SUPABASE_URL", "https://server.example.test");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_abc");
    getRequestMock.mockReturnValue(makeRequest({ authorization: "Basic abc123" }));

    await expect(middleware({ next: vi.fn() })).rejects.toThrow(
      "Unauthorized: Only Bearer tokens are supported",
    );
  });

  // Headers.get() apara espaço no fim, então "Bearer " vira "Bearer" e o prefixo
  // "Bearer " deixa de casar — cai em "Only Bearer tokens are supported".
  // Consequência: o guard `if (!token)` (No token provided) é inalcançável via
  // Headers reais e fica sem cobertura por ser defensivo/código morto.
  it("rejeita 'Bearer' sem token como esquema não suportado", async () => {
    vi.stubEnv("SUPABASE_URL", "https://server.example.test");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_abc");
    getRequestMock.mockReturnValue(makeRequest({ authorization: "Bearer " }));

    await expect(middleware({ next: vi.fn() })).rejects.toThrow(
      "Unauthorized: Only Bearer tokens are supported",
    );
  });

  it("rejeita quando o token não tem o formato JWT (3 segmentos)", async () => {
    vi.stubEnv("SUPABASE_URL", "https://server.example.test");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_abc");
    getRequestMock.mockReturnValue(makeRequest({ authorization: "Bearer nao-e-jwt" }));

    await expect(middleware({ next: vi.fn() })).rejects.toThrow("Unauthorized: Invalid token");
    expect(createClientMock).not.toHaveBeenCalled();
  });
});

describe("requireSupabaseAuth — validação via Supabase (getClaims)", () => {
  it("rejeita quando o Supabase retorna erro ao validar claims", async () => {
    vi.stubEnv("SUPABASE_URL", "https://server.example.test");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_abc");
    getRequestMock.mockReturnValue(makeRequest({ authorization: `Bearer ${VALID_TOKEN}` }));
    getClaimsMock.mockResolvedValue({ data: null, error: new Error("token expirado") });

    await expect(middleware({ next: vi.fn() })).rejects.toThrow("Unauthorized: Invalid token");
  });

  it("rejeita quando não há claims no retorno", async () => {
    vi.stubEnv("SUPABASE_URL", "https://server.example.test");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_abc");
    getRequestMock.mockReturnValue(makeRequest({ authorization: `Bearer ${VALID_TOKEN}` }));
    getClaimsMock.mockResolvedValue({ data: null, error: null });

    await expect(middleware({ next: vi.fn() })).rejects.toThrow("Unauthorized: Invalid token");
  });

  it("rejeita quando as claims não têm `sub`", async () => {
    vi.stubEnv("SUPABASE_URL", "https://server.example.test");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_abc");
    getRequestMock.mockReturnValue(makeRequest({ authorization: `Bearer ${VALID_TOKEN}` }));
    getClaimsMock.mockResolvedValue({ data: { claims: { sub: "" } }, error: null });

    await expect(middleware({ next: vi.fn() })).rejects.toThrow(
      "Unauthorized: No user ID found in token",
    );
  });

  it("chama next() com supabase, userId e claims quando o token é válido", async () => {
    vi.stubEnv("SUPABASE_URL", "https://server.example.test");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_abc");
    getRequestMock.mockReturnValue(makeRequest({ authorization: `Bearer ${VALID_TOKEN}` }));
    const claims = { sub: "user-42", role: "authenticated" };
    getClaimsMock.mockResolvedValue({ data: { claims }, error: null });
    const next = vi.fn().mockReturnValue("next-result");

    const result = await middleware({ next });

    expect(createClientMock).toHaveBeenCalledWith(
      "https://server.example.test",
      "sb_publishable_abc",
      expect.objectContaining({
        global: expect.objectContaining({ headers: { Authorization: `Bearer ${VALID_TOKEN}` } }),
      }),
    );
    expect(next).toHaveBeenCalledWith({
      context: { supabase: expect.anything(), userId: "user-42", claims },
    });
    expect(result).toBe("next-result");
  });
});

describe("fetch customizado passado para createClient (createSupabaseFetch)", () => {
  async function getConfiguredFetch(): Promise<typeof fetch> {
    vi.stubEnv("SUPABASE_URL", "https://server.example.test");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_abc");
    getRequestMock.mockReturnValue(makeRequest({ authorization: `Bearer ${VALID_TOKEN}` }));
    getClaimsMock.mockResolvedValue({ data: { claims: { sub: "user-1" } }, error: null });
    await middleware({ next: vi.fn() });
    return lastCall!.options.global.fetch;
  }

  it("remove Authorization quando a chave nova bate com o Bearer e injeta apikey", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", mockFetch);
    const customFetch = await getConfiguredFetch();

    const request = new Request("https://api.test/rpc", {
      headers: { Authorization: "Bearer sb_publishable_abc" },
    });
    await customFetch(request);

    const [, calledInit] = mockFetch.mock.calls[0] as [unknown, { headers: Headers }];
    expect(calledInit.headers.get("Authorization")).toBeNull();
    expect(calledInit.headers.get("apikey")).toBe("sb_publishable_abc");
  });

  it("preserva Authorization de sessão e mescla headers de init quando input não é Request", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", mockFetch);
    const customFetch = await getConfiguredFetch();

    await customFetch("https://api.test/rpc", { headers: { "x-extra": "1" } });

    const [, calledInit] = mockFetch.mock.calls[0] as [unknown, { headers: Headers }];
    expect(calledInit.headers.get("x-extra")).toBe("1");
    expect(calledInit.headers.get("apikey")).toBe("sb_publishable_abc");
  });
});
