import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";

import { Button } from "@/components/ui/button";

// Chave derivada do conteúdo (djb2) e não fixa: uma mensagem nova gera chave
// nova, então um aviso atualizado reaparece mesmo que o anterior já tenha sido
// dispensado na mesma sessão.
function hashMessage(message: string): string {
  let hash = 5381;
  for (let i = 0; i < message.length; i++) {
    hash = (hash * 33) ^ message.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function dismissKey(message: string): string {
  return `maintenance-banner-dismissed:${hashMessage(message)}`;
}

function isDismissed(message: string): boolean {
  try {
    return sessionStorage.getItem(dismissKey(message)) === "true";
  } catch {
    return false; // Safari private mode — sem storage, sempre mostra.
  }
}

function markDismissed(message: string): void {
  try {
    sessionStorage.setItem(dismissKey(message), "true");
  } catch {
    // Safari private mode — falha silenciosa, não é crítico não persistir.
  }
}

/**
 * Banner fino no topo do app quando VITE_MAINTENANCE_MESSAGE está definida.
 * Dispensa só dura a sessão (sessionStorage) — reaparece na próxima sessão
 * enquanto a env var continuar setada, diferente do ConsentModal (localStorage).
 */
export function MaintenanceBanner() {
  const message = import.meta.env.VITE_MAINTENANCE_MESSAGE;
  // Estado inicial não lê sessionStorage no render (evita mismatch de hidratação
  // no SSR) — só decide visibilidade depois de montar no cliente.
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    if (!message) return;
    setDismissed(isDismissed(message));
  }, [message]);

  const handleDismiss = useCallback(() => {
    if (!message) return;
    markDismissed(message);
    setDismissed(true);
  }, [message]);

  if (!message || dismissed) return null;

  return (
    <div
      role="alert"
      className="flex items-center gap-3 border-b border-amber-500/50 bg-amber-500/10 px-4 py-2 text-sm text-amber-800 dark:text-amber-400"
    >
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
      <p className="flex-1">{message}</p>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0"
        onClick={handleDismiss}
        aria-label="Dispensar aviso"
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
