// Harness compartilhado para testar edge functions Deno sem subir servidor
// nem tocar rede real. NÃO editar a partir de subagentes — congelado após o
// piloto (ai-insights) validar o comportamento real do supabase-js.

export type Handler = (req: Request) => Response | Promise<Response>;

const captured = new Map<string, Handler>();

/**
 * Importa o módulo da function uma única vez, interceptando Deno.serve pra
 * capturar o callback do handler sem subir um listener real.
 */
export async function captureHandler(modulePath: string): Promise<Handler> {
  const cached = captured.get(modulePath);
  if (cached) return cached;

  const realServe = Deno.serve;
  let handler: Handler | undefined;
  // deno-lint-ignore no-explicit-any
  (Deno as any).serve = (h: Handler) => {
    handler = h;
    return { finished: Promise.resolve() };
  };
  try {
    await import(modulePath);
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).serve = realServe;
  }
  if (!handler) throw new Error(`Deno.serve não foi chamado ao importar ${modulePath}`);
  captured.set(modulePath, handler);
  return handler;
}

export interface MockRequest {
  url: string;
  pathname: string;
  method: string;
  headers: Headers;
  bodyText: string;
  bodyJson: unknown;
  /** Deadline do request, quando o caller passou um. Testes que exigem timeout
   * asseveram a presença dele aqui. */
  signal: AbortSignal | null;
}

export type FetchMatcher = (req: MockRequest) => Response | Promise<Response> | undefined;

/**
 * Instala um mock de fetch stateful. `matcher` é chamado por request; se
 * devolver undefined, cai no catch-all (loga e responde 501 — sinal de rota
 * não coberta pelo teste).
 */
export function installFetchMock(matcher: FetchMatcher): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let url: string;
    let method = "GET";
    let headers = new Headers();
    let bodyText = "";
    let signal: AbortSignal | null = init?.signal ?? null;
    if (input instanceof Request) {
      url = input.url;
      method = input.method;
      headers = input.headers;
      bodyText = await input.clone().text();
      signal = input.signal ?? signal;
    } else {
      url = input.toString();
      method = init?.method ?? "GET";
      headers = new Headers(init?.headers);
      bodyText = typeof init?.body === "string" ? init.body : "";
    }
    const pathname = new URL(url).pathname;
    let bodyJson: unknown = undefined;
    if (bodyText) {
      try {
        bodyJson = JSON.parse(bodyText);
      } catch {
        bodyJson = undefined;
      }
    }
    const mockReq: MockRequest = { url, pathname, method, headers, bodyText, bodyJson, signal };
    const res = matcher(mockReq);
    if (res === undefined) {
      console.error(`[fetchMock] rota não coberta: ${method} ${pathname}`, bodyText.slice(0, 300));
      return new Response(JSON.stringify({ message: `unmocked route: ${method} ${pathname}` }), {
        status: 501,
      });
    }
    return res;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * Respostas padrão do contrato RBAC usado por loadProfileOrFail. Suites de
 * handlers podem manter o profile como estado e delegar aqui as duas leituras
 * adicionais, sem duplicar fixtures de membership/role em cada router.
 */
export function activeMembershipResponse(
  req: MockRequest,
  profile: { tenant_id: string; role?: string } | null,
): Response | undefined {
  if (!profile) return undefined;
  if (req.pathname === "/rest/v1/tenant_memberships" && req.method === "GET") {
    return jsonResponse(200, [{
      tenant_id: profile.tenant_id,
      user_id: "user-1",
      role_id: "role-1",
      status: "active",
      revoked_at: null,
    }]);
  }
  if (req.pathname === "/rest/v1/roles" && req.method === "GET") {
    return jsonResponse(200, [{ role_key: profile.role ?? "agent" }]);
  }
  return undefined;
}

// 204/205/304 são "null body status": o construtor de Response LANÇA se receber
// corpo, mesmo string vazia — o próprio default desta função (204) estourava.
// Chamadores com 200/201 continuam idênticos.
const NULL_BODY_STATUS = new Set([204, 205, 304]);

export function emptyResponse(status = 204): Response {
  return new Response(NULL_BODY_STATUS.has(status) ? null : "", { status });
}

export const BASE_ENV: Record<string, string> = {
  SUPABASE_URL: "http://sb.local",
  SUPABASE_SERVICE_ROLE_KEY: "sr-key",
  SUPABASE_ANON_KEY: "anon-key",
};

export function setEnv(env: Record<string, string>): void {
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
}
