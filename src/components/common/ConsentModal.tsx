import { useCallback, useEffect, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useCurrentProfile } from "@/lib/api/session";

// Suba esta versão quando o texto da política mudar — força novo aceite mesmo
// de quem já havia consentido a versão anterior.
const POLICY_VERSION = "2026-07-19";

// Aceite é por usuário + versão: outro usuário no mesmo navegador ainda vê o
// aviso, e um bump de POLICY_VERSION re-pede o aceite de todos.
function consentKey(userId: string): string {
  return `lgpd-consent:${userId}:${POLICY_VERSION}`;
}

function hasAcknowledged(userId: string): boolean {
  try {
    return localStorage.getItem(consentKey(userId)) === "true";
  } catch {
    return false; // Sem storage (Safari private mode) — fail-closed, mostra o aviso.
  }
}

// Assinantes em memória: outros modais (ex.: assistente de onboarding) precisam
// saber que o aceite ocorreu no mesmo render, sem recarregar a página.
const consentListeners = new Set<() => void>();

function markAcknowledged(userId: string): void {
  try {
    localStorage.setItem(consentKey(userId), "true");
  } catch {
    // Safari private mode — falha silenciosa, não é crítico não persistir.
  }
  consentListeners.forEach((notify) => notify());
}

/**
 * Indica se o usuário atual já aceitou o aviso de privacidade. Enquanto for
 * false, nenhum outro diálogo deve abrir: dois diálogos modais empilhados
 * bloqueiam o clique em ambos (o de cima intercepta os eventos de ponteiro).
 */
export function useConsentAcknowledged(): boolean {
  const { data: profile } = useCurrentProfile();
  const userId = profile?.id;
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    if (!userId) {
      setAcknowledged(false);
      return;
    }
    const sync = () => setAcknowledged(hasAcknowledged(userId));
    sync();
    consentListeners.add(sync);
    return () => {
      consentListeners.delete(sync);
    };
  }, [userId]);

  return acknowledged;
}

export function ConsentModal() {
  const { data: profile } = useCurrentProfile();
  const userId = profile?.id;
  // Estado inicial não lê localStorage no render (evita mismatch de hidratação
  // no SSR) — e só decide depois de ter o id do usuário, já que o aceite é
  // amarrado a cada usuário.
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!userId) return;
    setOpen(!hasAcknowledged(userId));
  }, [userId]);

  const handleAcknowledge = useCallback(() => {
    if (!userId) return;
    markAcknowledged(userId);
    setOpen(false);
  }, [userId]);

  return (
    <Dialog open={open}>
      <DialogContent
        className="[&>button]:hidden"
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Aviso de privacidade</DialogTitle>
          <DialogDescription>
            Usamos os dados que você cadastra aqui — contatos, conversas e atividades — apenas para
            operar as funcionalidades deste CRM, como organização de contatos, atendimento e
            automações. Nenhum dado é compartilhado com terceiros para fins alheios a essa operação.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={handleAcknowledge}>Entendi</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
