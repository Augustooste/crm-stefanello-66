import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consumeLastCapturedError } from "./error-capture";

describe("consumeLastCapturedError", () => {
  beforeEach(() => {
    // Flush estado residual deixado por outro teste (módulo é um singleton).
    consumeLastCapturedError();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retorna undefined quando nada foi capturado", () => {
    expect(consumeLastCapturedError()).toBeUndefined();
  });

  it("captura o erro de um evento 'error' e o consome uma única vez", () => {
    const err = new Error("boom");
    globalThis.dispatchEvent(new ErrorEvent("error", { error: err }));
    expect(consumeLastCapturedError()).toBe(err);
    expect(consumeLastCapturedError()).toBeUndefined();
  });

  it("usa o próprio evento quando não há propriedade error", () => {
    const event = new Event("error");
    globalThis.dispatchEvent(event);
    expect(consumeLastCapturedError()).toBe(event);
  });

  it("captura o motivo de um unhandledrejection", () => {
    const reason = new Error("rejeitada");
    const rejected = Promise.reject(reason);
    rejected.catch(() => {});
    globalThis.dispatchEvent(
      new PromiseRejectionEvent("unhandledrejection", { promise: rejected, reason }),
    );
    expect(consumeLastCapturedError()).toBe(reason);
  });

  it("expira após o TTL de 5s e não retorna mais o erro", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 0));
    const err = new Error("velho");
    globalThis.dispatchEvent(new ErrorEvent("error", { error: err }));
    vi.advanceTimersByTime(5001);
    expect(consumeLastCapturedError()).toBeUndefined();
  });
});

describe("registro de listeners globais no import", () => {
  it("não quebra quando addEventListener não existe no ambiente", async () => {
    vi.resetModules();
    vi.stubGlobal("addEventListener", undefined);
    const mod = await import("./error-capture");
    expect(mod.consumeLastCapturedError()).toBeUndefined();
    vi.unstubAllGlobals();
    vi.resetModules();
  });
});
