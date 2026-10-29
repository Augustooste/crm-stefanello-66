import { useRef, useState, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/common/StatusBadge";
import { cn } from "@/lib/utils";

const MS_PER_HOUR = 1000 * 60 * 60;
const MAX_DOTS = 10;
const CHANNEL_LABELS = {
  whatsapp: "WhatsApp",
  email: "E-mail",
  instagram: "Instagram",
  messenger: "Messenger",
  simulator: "Simulação",
} as const;

export interface FocusQueueItem {
  id: string;
  awaiting_human: boolean;
  last_message_at: string | null;
  last_message: { content: string | null; sender: string } | null;
  contact: { name: string } | null;
  channel: { type: "whatsapp" | "email" | "instagram" | "messenger" | "simulator" } | null;
}

export interface InboxFocusViewProps {
  currentItem: FocusQueueItem | null;
  currentIndex: number;
  totalItems: number;
  onReply: (content: string) => void;
  onSkip: () => void;
  onResolve: () => void;
  /** Esc sai do Modo Foco (volta pra Lista). Sem callback, Esc não faz nada. */
  onExitFocus?: () => void;
  replyPending: boolean;
}

/**
 * Modo Foco: 1 item por vez, mirror simplificado do `InboxFocusView` do
 * medflow SEM o `FocusContextPanel` de 1917 linhas (fora de escopo do épico).
 * "Resolver" só existe para itens `awaiting_human` — não há campo pra
 * persistir "atrasado resolvido sem responder" sem migration (ver riscos).
 */
export function InboxFocusView({
  currentItem,
  currentIndex,
  totalItems,
  onReply,
  onSkip,
  onResolve,
  onExitFocus,
  replyPending,
}: InboxFocusViewProps) {
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  if (!currentItem) return null;

  const overdueHours = currentItem.last_message_at
    ? Math.floor((Date.now() - new Date(currentItem.last_message_at).getTime()) / MS_PER_HOUR)
    : 0;

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    const isTextarea = target.tagName === "TEXTAREA";
    if ((e.key === "p" || e.key === "P") && !isTextarea) {
      onSkip();
      return;
    }
    if (e.key === "Enter" && !isTextarea) {
      // Foca o textarea em vez de enviar direto — evita conflito com o
      // Enter-envia do próprio textarea (que trata seu próprio onKeyDown).
      e.preventDefault();
      textareaRef.current?.focus();
      return;
    }
    if (e.key === "Escape") {
      onExitFocus?.();
    }
  }

  function handleReply() {
    const text = draft.trim();
    if (!text || replyPending) return;
    onReply(text);
    setDraft("");
  }

  function onDraftKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleReply();
    }
  }

  return (
    <div
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="mx-auto flex w-full max-w-xl flex-col gap-4 focus:outline-none"
    >
      <div className="flex items-center justify-center gap-1">
        {Array.from({ length: Math.min(totalItems, MAX_DOTS) }).map((_, i) => (
          <span
            key={i}
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              i === currentIndex ? "bg-primary" : "bg-muted",
            )}
          />
        ))}
        {totalItems > MAX_DOTS && (
          <span className="ml-1 text-caption text-muted-foreground">+{totalItems - MAX_DOTS}</span>
        )}
      </div>

      <div className="rounded-lg border border-border bg-card p-5">
        <div className="mb-3 flex items-center gap-2">
          {currentItem.awaiting_human ? (
            <StatusBadge variant="warning">Aguardando humano</StatusBadge>
          ) : (
            <StatusBadge variant="destructive">Atrasado {overdueHours}h</StatusBadge>
          )}
        </div>
        <h2 className="text-card-title font-semibold text-foreground">
          {currentItem.contact?.name ?? "Contato"}
        </h2>
        <p className="text-caption text-muted-foreground">
          {CHANNEL_LABELS[currentItem.channel?.type ?? "whatsapp"]}
        </p>
        <p className="mt-3 text-body text-muted-foreground">
          {currentItem.last_message?.content ?? "Sem mensagens"}
        </p>

        <Textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onDraftKeyDown}
          placeholder="Escreva sua resposta..."
          className="field-sizing-content mt-4 max-h-28 min-h-[44px] resize-none"
          rows={1}
          aria-label="Resposta rápida"
        />

        <div className="mt-3 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onSkip}>
            Pular
          </Button>
          {currentItem.awaiting_human && (
            <Button variant="outline" size="sm" onClick={onResolve}>
              Resolver
            </Button>
          )}
          <Button size="sm" onClick={handleReply} disabled={!draft.trim() || replyPending}>
            {replyPending ? "Enviando…" : "Responder"}
          </Button>
        </div>
      </div>
    </div>
  );
}
