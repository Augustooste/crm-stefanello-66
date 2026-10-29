import { useCallback, useEffect, useState } from "react";

// Não faz parte do lib.dom.d.ts do TypeScript (evento experimental) —
// declarado localmente em vez de brigar com WindowEventMap.
interface BeforeInstallPromptEvent extends Event {
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  prompt(): Promise<void>;
}

interface UseInstallPromptResult {
  canInstall: boolean;
  promptInstall: () => Promise<void>;
}

export function useInstallPrompt(): UseInstallPromptResult {
  const [deferredEvent, setDeferredEvent] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredEvent(event as BeforeInstallPromptEvent);
    };
    const handleAppInstalled = () => {
      setDeferredEvent(null);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferredEvent) return;
    try {
      await deferredEvent.prompt();
      await deferredEvent.userChoice;
    } catch (error) {
      // Ex.: InvalidStateError em double-invoke do mesmo evento — sem isso
      // vira unhandled promise rejection, sem sinal nenhum pro usuário/dev.
      console.error("Falha ao exibir prompt de instalação:", error);
    } finally {
      setDeferredEvent(null);
    }
  }, [deferredEvent]);

  return { canInstall: deferredEvent !== null, promptInstall };
}
