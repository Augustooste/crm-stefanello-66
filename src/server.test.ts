import { afterEach, describe, expect, it, vi } from "vitest";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};
type ServerFetch = (request: Request, env: unknown, ctx: unknown) => Promise<Response>;

/** Carrega src/server.ts do zero, forçando a recriação do cache interno (serverEntryPromise). */
async function loadServer(): Promise<ServerFetch> {
  vi.resetModules();
  const mod = await import("./server");
  return (mod.default as { fetch: ServerFetch }).fetch;
}

function mockServerEntry(entry: ServerEntry, wrapInDefault = true) {
  // O mock virtual do Vitest lança ao acessar `.default` se a chave não existir
  // no objeto retornado pela factory — por isso o fallback inclui `default: undefined`
  // explicitamente, em vez de simplesmente omitir a chave.
  vi.doMock("@tanstack/react-start/server-entry", () =>
    wrapInDefault ? { default: entry } : { default: undefined, ...entry },
  );
}

afterEach(() => {
  vi.doUnmock("@tanstack/react-start/server-entry");
  vi.restoreAllMocks();
});

describe("server default.fetch", () => {
  it("repassa a resposta do handler SSR quando não há erro", async () => {
    const okResponse = new Response("ok", { status: 200 });
    mockServerEntry({ fetch: vi.fn().mockResolvedValue(okResponse) });

    const fetch = await loadServer();
    const result = await fetch(new Request("https://example.test"), {}, {});

    expect(result).toBe(okResponse);
  });

  it("adiciona CSP frame-ancestors e X-Frame-Options em respostas HTML", async () => {
    const html = new Response("<!doctype html><html></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    mockServerEntry({ fetch: vi.fn().mockResolvedValue(html) });

    const fetch = await loadServer();
    const result = await fetch(new Request("https://example.test"), {}, {});

    expect(result.headers.get("x-frame-options")).toBe("DENY");
    expect(result.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(result.status).toBe(200);
    await expect(result.text()).resolves.toBe("<!doctype html><html></html>");
  });

  it("não adiciona headers de segurança em respostas não-HTML (assets passam intactos)", async () => {
    const asset = new Response("console.log(1)", {
      status: 200,
      headers: { "content-type": "application/javascript" },
    });
    mockServerEntry({ fetch: vi.fn().mockResolvedValue(asset) });

    const fetch = await loadServer();
    const result = await fetch(new Request("https://example.test/asset.js"), {}, {});

    expect(result).toBe(asset);
    expect(result.headers.get("x-frame-options")).toBeNull();
  });

  it("usa o export direto do módulo quando não há `default` (fallback m.default ?? m)", async () => {
    const okResponse = new Response("sem-default", { status: 200 });
    mockServerEntry({ fetch: vi.fn().mockResolvedValue(okResponse) }, false);

    const fetch = await loadServer();
    const result = await fetch(new Request("https://example.test"), {}, {});

    expect(result).toBe(okResponse);
  });

  it("cacheia a entrada do servidor entre chamadas (import ocorre uma única vez)", async () => {
    const handlerFetch = vi.fn().mockResolvedValue(new Response("ok"));
    mockServerEntry({ fetch: handlerFetch });

    const fetch = await loadServer();
    await fetch(new Request("https://example.test"), {}, {});
    await fetch(new Request("https://example.test"), {}, {});

    expect(handlerFetch).toHaveBeenCalledTimes(2);
  });

  it("repassa respostas 500 que não são JSON sem alterá-las", async () => {
    const response = new Response("erro de infra", {
      status: 500,
      headers: { "content-type": "text/plain" },
    });
    mockServerEntry({ fetch: vi.fn().mockResolvedValue(response) });

    const fetch = await loadServer();
    const result = await fetch(new Request("https://example.test"), {}, {});

    expect(result).toBe(response);
  });

  it("repassa respostas 500 JSON que não têm o formato de erro engolido pelo h3", async () => {
    const response = new Response(JSON.stringify({ some: "other-shape" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
    mockServerEntry({ fetch: vi.fn().mockResolvedValue(response) });

    const fetch = await loadServer();
    const result = await fetch(new Request("https://example.test"), {}, {});

    expect(result).toBe(response);
  });

  it("repassa respostas 500 com corpo JSON inválido sem quebrar", async () => {
    const response = new Response("{not-valid-json", {
      status: 500,
      headers: { "content-type": "application/json" },
    });
    mockServerEntry({ fetch: vi.fn().mockResolvedValue(response) });

    const fetch = await loadServer();
    const result = await fetch(new Request("https://example.test"), {}, {});

    expect(result).toBe(response);
  });

  it("converte resposta 500 engolida pelo h3 em página de erro HTML, usando o erro capturado", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const swallowed = new Response(JSON.stringify({ unhandled: true, message: "HTTPError" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
    mockServerEntry({ fetch: vi.fn().mockResolvedValue(swallowed) });

    // O listener de captura é registrado no import de "./lib/error-capture" — como
    // loadServer() reseta os módulos, o dispatch precisa ocorrer só depois do reimport.
    const fetch = await loadServer();
    const capturedError = new Error("causa real");
    globalThis.dispatchEvent(new ErrorEvent("error", { error: capturedError }));

    const result = await fetch(new Request("https://example.test"), {}, {});

    expect(consoleErrorSpy).toHaveBeenCalledWith(capturedError);
    expect(result.status).toBe(500);
    expect(result.headers.get("content-type")).toBe("text/html; charset=utf-8");
    await expect(result.text()).resolves.toBe(renderErrorPage());
  });

  it("converte resposta 500 engolida pelo h3 usando erro genérico quando nada foi capturado", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const swallowed = new Response(JSON.stringify({ unhandled: true, message: "HTTPError" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
    mockServerEntry({ fetch: vi.fn().mockResolvedValue(swallowed) });

    const fetch = await loadServer();
    const result = await fetch(new Request("https://example.test"), {}, {});

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const [loggedError] = consoleErrorSpy.mock.calls[0] as [Error];
    expect(loggedError.message).toContain("h3 swallowed SSR error");
    expect(result.status).toBe(500);
    await expect(result.text()).resolves.toBe(renderErrorPage());
  });

  it("captura exceções lançadas pelo handler SSR e devolve página de erro HTML", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const thrown = new Error("handler explodiu");
    mockServerEntry({ fetch: vi.fn().mockRejectedValue(thrown) });

    const fetch = await loadServer();
    const result = await fetch(new Request("https://example.test"), {}, {});

    expect(consoleErrorSpy).toHaveBeenCalledWith(thrown);
    expect(result.status).toBe(500);
    expect(result.headers.get("content-type")).toBe("text/html; charset=utf-8");
    await expect(result.text()).resolves.toBe(renderErrorPage());
  });
});
