import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, X, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { detectFollowUpIntent } from "@/lib/follow-up-detector";
import { useCreateFollowup } from "@/hooks/use-followup-queue";

// ─── Utilitários de dismissal (localStorage por contactId) ──────────────────

const STORAGE_KEY_PREFIX = "af_followup_banner_dismissed_";

function dismissKey(contactId: string): string {
  return `${STORAGE_KEY_PREFIX}${contactId}`;
}

function isDismissed(contactId: string): boolean {
  try {
    return localStorage.getItem(dismissKey(contactId)) === "1";
  } catch {
    return false;
  }
}

function markDismissed(contactId: string): void {
  try {
    localStorage.setItem(dismissKey(contactId), "1");
  } catch {
    // Safari private mode — falha silenciosa, não é crítico não persistir.
  }
}

function formatSuggestedDate(date: Date): string {
  return date.toLocaleDateString("pt-BR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
  });
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface BannerMessage {
  sender: "contact" | "agent" | "ai";
  content: string | null;
}

interface FollowUpSuggestionBannerProps {
  /** Mensagens da conversa em ordem cronológica (mín. 3 no total para ativar a análise). */
  messages: BannerMessage[];
  contactId: string;
  dealId: string | null;
  tenantId: string;
  createdBy: string;
}

/**
 * Sugestão de follow-up detectada na ÚLTIMA MENSAGEM DO LEAD (não em
 * qualquer mensagem antiga da conversa — evita reabrir a sugestão para um
 * padrão já resolvido há várias trocas de mensagem). Exige >=3 mensagens no
 * total na conversa (PRD, critérios de aceite — "Fila de follow-up").
 *
 * Isto é heurística (regex determinístico), não IA de verdade — o botão
 * manual de criar follow-up (ver QuickFollowupDialog) precisa continuar
 * sempre visível na tela; este banner é um atalho, nunca o único caminho
 * (PRD, riscos/armadilhas #7).
 */
export function FollowUpSuggestionBanner({
  messages,
  contactId,
  dealId,
  tenantId,
  createdBy,
}: FollowUpSuggestionBannerProps) {
  const [visible, setVisible] = useState(() => !isDismissed(contactId));
  const createFollowup = useCreateFollowup();

  // A conversa selecionada muda sem desmontar o InboxPage (SPA) — sem este
  // efeito, o dismissal (ou a falta dele) do primeiro contato aberto
  // "vazaria" para os próximos contatos selecionados na mesma sessão.
  useEffect(() => {
    setVisible(!isDismissed(contactId));
  }, [contactId]);

  const lastContactMessage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].sender === "contact") return messages[i];
    }
    return null;
  }, [messages]);

  const suggestion = useMemo(() => {
    if (!visible || messages.length < 3 || !lastContactMessage?.content) return null;
    const result = detectFollowUpIntent([lastContactMessage.content]);
    return result.detected ? result : null;
  }, [visible, messages.length, lastContactMessage]);

  const handleDismiss = useCallback(() => {
    markDismissed(contactId);
    setVisible(false);
  }, [contactId]);

  const handleCreate = useCallback(() => {
    if (!suggestion?.suggestedDate) return;
    createFollowup.mutate(
      {
        tenantId,
        contactId,
        dealId,
        scheduledAt: suggestion.suggestedDate.toISOString(),
        description: `IA detectou: "${suggestion.phrases.join(", ")}"`,
        createdBy,
        source: "ai_suggested",
        aiSuggested: true,
      },
      {
        onSuccess: () => {
          toast.success("Retorno criado a partir da sugestão");
          markDismissed(contactId);
          setVisible(false);
        },
        onError: (e: Error) => toast.error(e.message ?? "Erro ao criar retorno"),
      },
    );
  }, [suggestion, createFollowup, tenantId, contactId, dealId, createdBy]);

  if (!visible || !suggestion) return null;

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-xl border p-3",
        "bg-amber-50 border-amber-200 dark:bg-amber-950/30 dark:border-amber-700/40",
      )}
      role="alert"
      aria-live="polite"
    >
      <div className="flex items-start gap-2">
        <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            Possível retorno detectado
          </p>
          {suggestion.suggestedDate && (
            <p className="mt-0.5 text-caption text-amber-700 dark:text-amber-300">
              Data sugerida:{" "}
              <span className="font-medium">{formatSuggestedDate(suggestion.suggestedDate)}</span>
            </p>
          )}
          {suggestion.phrases.length > 0 && (
            <p className="mt-0.5 truncate text-caption text-amber-600/80 dark:text-amber-400/70">
              Detectado: &ldquo;{suggestion.phrases.slice(0, 2).join(", ")}&rdquo;
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Ignorar sugestão"
          className="shrink-0 rounded p-0.5 text-amber-500 hover:bg-amber-100 dark:text-amber-400 dark:hover:bg-amber-800/40"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex items-center gap-2 pl-6">
        <button
          type="button"
          onClick={handleCreate}
          disabled={createFollowup.isPending}
          className={cn(
            "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-caption font-semibold",
            "bg-amber-600 text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50",
            "transition-colors",
          )}
        >
          {createFollowup.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
          Criar retorno
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          className="text-caption text-amber-600/70 hover:text-amber-700 dark:text-amber-400/60 dark:hover:text-amber-300"
        >
          Ignorar
        </button>
      </div>
    </div>
  );
}
