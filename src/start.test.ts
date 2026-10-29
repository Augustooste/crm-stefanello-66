import { describe, expect, it, vi } from "vitest";
import { renderErrorPage } from "./lib/error-page";

const attachSupabaseAuthMarker = { __marker: "attachSupabaseAuth" };

vi.mock("@/integrations/supabase/auth-attacher", () => ({
  attachSupabaseAuth: attachSupabaseAuthMarker,
}));

// createMiddleware/createStart reais retornam classes internas do TanStack Start;
// substituímos por passthroughs simples que capturam os callbacks registrados.
vi.mock("@tanstack/react-start", () => ({
  createMiddleware: () => ({
    server: (fn: unknown) => fn,
    client: (fn: unknown) => fn,
  }),
  createStart: (factory: () => unknown) => ({
    getOptions: () => factory(),
  }),
}));

type NextFn = () => Promise<Response> | Response;
type ErrorMiddlewareArgs = { next: NextFn };
type ErrorMiddlewareFn = (args: ErrorMiddlewareArgs) => Promise<Response>;
interface StartOptions {
  functionMiddleware: unknown[];
  requestMiddleware: unknown[];
}

const { startInstance } = await import("./start");

function getOptions(): StartOptions {
  return (startInstance as unknown as { getOptions: () => StartOptions }).getOptions();
}

function getErrorMiddleware(): ErrorMiddlewareFn {
  return getOptions().requestMiddleware[0] as ErrorMiddlewareFn;
}

describe("startInstance", () => {
  it("registra o middleware de auth como functionMiddleware e o de erro como requestMiddleware", () => {
    const options = getOptions();

    expect(options.functionMiddleware).toEqual([attachSupabaseAuthMarker]);
    expect(options.requestMiddleware).toHaveLength(1);
  });
});

describe("errorMiddleware", () => {
  it("retorna a resposta de next() quando não há erro", async () => {
    const response = new Response("ok");
    const next = vi.fn().mockResolvedValue(response);

    const result = await getErrorMiddleware()({ next });

    expect(result).toBe(response);
  });

  it("relança erros que já possuem statusCode sem convertê-los", async () => {
    const httpError = Object.assign(new Error("nao encontrado"), { statusCode: 404 });
    const next = vi.fn().mockRejectedValue(httpError);

    await expect(getErrorMiddleware()({ next })).rejects.toBe(httpError);
  });

  it("converte erro genérico em Response HTML 500 e loga no console", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const genericError = new Error("boom");
    const next = vi.fn().mockRejectedValue(genericError);

    const response = await getErrorMiddleware()({ next });

    expect(consoleErrorSpy).toHaveBeenCalledWith(genericError);
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    await expect(response.text()).resolves.toBe(renderErrorPage());
  });
});
