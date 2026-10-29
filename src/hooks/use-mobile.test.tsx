import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useIsMobile } from "./use-mobile";

type ChangeListener = () => void;

function mockMatchMedia() {
  const listeners: ChangeListener[] = [];
  const addEventListener = vi.fn((_event: string, cb: ChangeListener) => {
    listeners.push(cb);
  });
  const removeEventListener = vi.fn();
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener,
    removeEventListener,
  }) as unknown as typeof window.matchMedia;
  return { addEventListener, removeEventListener, listeners };
}

function setInnerWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    writable: true,
    configurable: true,
    value: width,
  });
}

describe("useIsMobile", () => {
  afterEach(() => {
    setInnerWidth(1024);
  });

  it("retorna true quando a largura inicial é menor que o breakpoint", async () => {
    mockMatchMedia();
    setInnerWidth(500);
    const { result } = renderHook(() => useIsMobile());
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("retorna false quando a largura inicial é maior ou igual ao breakpoint", async () => {
    mockMatchMedia();
    setInnerWidth(1024);
    const { result } = renderHook(() => useIsMobile());
    await waitFor(() => expect(result.current).toBe(false));
  });

  it("atualiza o valor quando a media query dispara change", async () => {
    const { listeners } = mockMatchMedia();
    setInnerWidth(1024);
    const { result } = renderHook(() => useIsMobile());
    await waitFor(() => expect(result.current).toBe(false));

    setInnerWidth(400);
    act(() => {
      listeners.forEach((cb) => cb());
    });
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("remove o listener de change ao desmontar", () => {
    const { addEventListener, removeEventListener } = mockMatchMedia();
    setInnerWidth(1024);
    const { unmount } = renderHook(() => useIsMobile());
    unmount();
    expect(removeEventListener).toHaveBeenCalledWith("change", addEventListener.mock.calls[0][1]);
  });
});
