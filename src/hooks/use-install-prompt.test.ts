import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useInstallPrompt } from "./use-install-prompt";

interface FakeBeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

function fireBeforeInstallPrompt(): FakeBeforeInstallPromptEvent {
  const event = new Event("beforeinstallprompt", {
    cancelable: true,
  }) as FakeBeforeInstallPromptEvent;
  event.prompt = vi.fn().mockResolvedValue(undefined);
  event.userChoice = Promise.resolve({ outcome: "accepted", platform: "web" });
  window.dispatchEvent(event);
  return event;
}

describe("useInstallPrompt", () => {
  it("começa sem prompt disponível", () => {
    const { result } = renderHook(() => useInstallPrompt());
    expect(result.current.canInstall).toBe(false);
  });

  it("fica instalável quando beforeinstallprompt dispara e cancela o default", async () => {
    const { result } = renderHook(() => useInstallPrompt());

    let event: FakeBeforeInstallPromptEvent | undefined;
    act(() => {
      event = fireBeforeInstallPrompt();
    });

    await waitFor(() => expect(result.current.canInstall).toBe(true));
    expect(event?.defaultPrevented).toBe(true);
  });

  it("promptInstall chama prompt() do evento e depois zera canInstall", async () => {
    const { result } = renderHook(() => useInstallPrompt());
    let event: FakeBeforeInstallPromptEvent | undefined;
    act(() => {
      event = fireBeforeInstallPrompt();
    });
    await waitFor(() => expect(result.current.canInstall).toBe(true));

    await act(async () => {
      await result.current.promptInstall();
    });

    expect(event?.prompt).toHaveBeenCalledTimes(1);
    expect(result.current.canInstall).toBe(false);
  });

  it("promptInstall não faz nada quando não há evento pendente", async () => {
    const { result } = renderHook(() => useInstallPrompt());
    await act(async () => {
      await result.current.promptInstall();
    });
    expect(result.current.canInstall).toBe(false);
  });

  it("zera canInstall quando appinstalled dispara", async () => {
    const { result } = renderHook(() => useInstallPrompt());
    act(() => {
      fireBeforeInstallPrompt();
    });
    await waitFor(() => expect(result.current.canInstall).toBe(true));

    act(() => {
      window.dispatchEvent(new Event("appinstalled"));
    });
    await waitFor(() => expect(result.current.canInstall).toBe(false));
  });

  it("remove os listeners ao desmontar", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() => useInstallPrompt());

    const addedEvents = addSpy.mock.calls.map((call) => call[0]);
    expect(addedEvents).toContain("beforeinstallprompt");
    expect(addedEvents).toContain("appinstalled");

    unmount();

    const removedEvents = removeSpy.mock.calls.map((call) => call[0]);
    expect(removedEvents).toContain("beforeinstallprompt");
    expect(removedEvents).toContain("appinstalled");
  });
});
