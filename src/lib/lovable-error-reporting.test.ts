import { afterEach, describe, expect, it, vi } from "vitest";
import { reportLovableError } from "./lovable-error-reporting";

describe("reportLovableError", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete window.__lovableEvents;
  });

  it("não faz nada quando window é undefined", () => {
    vi.stubGlobal("window", undefined);
    expect(() => reportLovableError(new Error("x"))).not.toThrow();
  });

  it("não lança quando __lovableEvents não está definido", () => {
    expect(() => reportLovableError(new Error("x"))).not.toThrow();
  });

  it("não lança quando captureException não está definido", () => {
    window.__lovableEvents = {};
    expect(() => reportLovableError(new Error("x"))).not.toThrow();
  });

  it("chama captureException com contexto mesclado e opções fixas", () => {
    const captureException = vi.fn();
    window.__lovableEvents = { captureException };
    const err = new Error("boom");
    reportLovableError(err, { extra: "dado" });
    expect(captureException).toHaveBeenCalledWith(
      err,
      { source: "react_error_boundary", route: window.location.pathname, extra: "dado" },
      { mechanism: "react_error_boundary", handled: false, severity: "error" },
    );
  });

  it("usa contexto vazio por padrão quando nenhum é passado", () => {
    const captureException = vi.fn();
    window.__lovableEvents = { captureException };
    reportLovableError(new Error("boom"));
    expect(captureException).toHaveBeenCalledWith(
      expect.anything(),
      { source: "react_error_boundary", route: window.location.pathname },
      expect.anything(),
    );
  });
});
