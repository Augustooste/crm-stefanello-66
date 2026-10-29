import { useCallback, useEffect, useState } from "react";
import { Download, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { useInstallPrompt } from "@/hooks/use-install-prompt";

const DISMISSED_UNTIL_KEY = "af_install_banner_dismissed_until";
const DISMISS_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

function isDismissed(): boolean {
  try {
    const until = localStorage.getItem(DISMISSED_UNTIL_KEY);
    return until !== null && Date.now() < Number(until);
  } catch {
    return false;
  }
}

function markDismissed(): void {
  try {
    localStorage.setItem(DISMISSED_UNTIL_KEY, String(Date.now() + DISMISS_DURATION_MS));
  } catch {
    // Safari private mode — falha silenciosa, não é crítico não persistir.
  }
}

export function InstallBanner() {
  const { canInstall, promptInstall } = useInstallPrompt();
  // Estado inicial não lê localStorage no render (evita mismatch de hidratação
  // no SSR) — só decide se está dispensado depois de montar no cliente.
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(isDismissed());
  }, []);

  const handleDismiss = useCallback(() => {
    markDismissed();
    setDismissed(true);
  }, []);

  const handleInstall = useCallback(() => {
    void promptInstall();
  }, [promptInstall]);

  if (!canInstall || dismissed) return null;

  return (
    <div
      className={cn(
        "fixed inset-x-0 bottom-0 z-50 flex flex-col gap-2 border-t p-3 sm:flex-row sm:items-center sm:justify-between",
        "border-border bg-surface text-foreground shadow-lg",
      )}
      role="alert"
      aria-live="polite"
    >
      <div className="flex items-center gap-2">
        <Download className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <p className="text-sm font-medium">Instale o CRM IA para acesso rápido</p>
      </div>
      <div className="flex items-center gap-2 self-end sm:self-auto">
        <button
          type="button"
          onClick={handleInstall}
          className="rounded-lg bg-primary px-3 py-1.5 text-caption font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Instalar app
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dispensar"
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
