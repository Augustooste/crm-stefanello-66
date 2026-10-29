import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Info, Loader2, Send } from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { AiPersonaBadge } from "@/components/ai/ai-persona-badge";
import { formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { dealChat } from "@/lib/api/ai-config";
import { renderPreviewReply } from "@/lib/ai/preview-reply";

interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string;
}

export interface DealChatTarget {
  id: string;
  title: string;
}

interface DealChatDialogProps {
  /** null = dialog fechado. Trocar de negócio (id diferente) reinicia a conversa. */
  deal: DealChatTarget | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * "Falar com IA": preview conversacional do negócio, com o contexto real
 * (contato, valor, atividades e notas recentes) montado no backend
 * (supabase/functions/ai-deal-chat). Cada envio é single-shot — a IA não
 * recebe o histórico da conversa, só a mensagem atual (ver dealChat em
 * @/lib/api/ai-config) — a lista abaixo é só apresentação pro vendedor.
 */
export function DealChatDialog({ deal, onOpenChange }: DealChatDialogProps) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  // Rastreia qual negócio está ativo AGORA, pra continuations de `send()`
  // pendentes saberem se ainda são relevantes quando resolvem — o dialog
  // fica montado entre negócios (só a prop `deal` muda), então uma resposta
  // que chega depois da troca não pode ser anexada à conversa do negócio
  // novo (ver deal-chat-dialog race de resposta cruzada entre negócios).
  const activeDealIdRef = useRef<string | null>(null);

  // Negócio diferente (ou dialog reaberto) começa com a conversa limpa —
  // não faz sentido reaproveitar mensagens de outro negócio.
  useEffect(() => {
    activeDealIdRef.current = deal?.id ?? null;
    setMessages([]);
    setDraft("");
    setSending(false);
  }, [deal?.id]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending || !deal) return;
    const dealId = deal.id;
    const now = new Date().toISOString();
    const userMsg: ChatMsg = { id: `u-${Date.now()}`, role: "user", text, at: now };
    setMessages((prev) => [...prev, userMsg]);
    setDraft("");
    setSending(true);
    try {
      const { reply } = await dealChat({ deal_id: dealId, message: text });
      // Negócio pode ter trocado enquanto a resposta estava pendente —
      // descarta silenciosamente em vez de misatribuir a resposta ao
      // negócio errado.
      if (activeDealIdRef.current !== dealId) return;
      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          text: renderPreviewReply(reply),
          at: new Date().toISOString(),
        },
      ]);
    } catch (e) {
      if (activeDealIdRef.current !== dealId) return;
      toast.error((e as Error).message || "Falha ao gerar resposta.");
    } finally {
      if (activeDealIdRef.current === dealId) setSending(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <Dialog open={!!deal} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Falar com IA</DialogTitle>
          <DialogDescription>{deal ? `Negócio: "${deal.title}"` : ""}</DialogDescription>
        </DialogHeader>

        <Alert>
          <Info className="h-4 w-4" />
          <AlertTitle>Prévia, não conversa real</AlertTitle>
          <AlertDescription>
            Digite como se você fosse o contato deste negócio — a IA responde usando o contexto real
            dele (valor, estágio, atividades e notas). Nada é enviado ao contato de verdade.
          </AlertDescription>
        </Alert>

        <div className="flex h-96 flex-col overflow-hidden rounded-lg border border-border bg-surface">
          <div className="flex-1 space-y-3 overflow-y-auto p-4">
            {messages.length === 0 && (
              <p className="text-center text-caption text-muted-foreground">
                Envie a primeira mensagem como se você fosse o contato.
              </p>
            )}
            {messages.map((m) => (
              <div
                key={m.id}
                className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}
              >
                <div
                  className={cn(
                    "max-w-[75%] rounded-lg border px-3 py-2 shadow-sm",
                    m.role === "user"
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-card text-card-foreground",
                  )}
                >
                  {m.role === "assistant" && (
                    <div className="mb-1 inline-flex items-center gap-1 rounded bg-accent px-1.5 py-0.5 text-caption font-medium text-accent-foreground">
                      <AiPersonaBadge size="xs" />
                    </div>
                  )}
                  <p className="whitespace-pre-wrap text-body">{m.text}</p>
                  <p
                    className={cn(
                      "mt-1 text-right text-caption",
                      m.role === "user" ? "text-primary-foreground/75" : "text-muted-foreground",
                    )}
                  >
                    {formatTime(m.at)}
                  </p>
                </div>
              </div>
            ))}
            {sending && (
              <div className="flex justify-start">
                <div className="rounded-lg border border-border bg-card px-3 py-2 text-body text-muted-foreground">
                  <AiPersonaBadge size="xs" className="mr-1" /> está pensando...
                </div>
              </div>
            )}
          </div>
          <div className="border-t border-border bg-card p-3">
            <div className="flex items-end gap-2">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKey}
                placeholder="Digite como se fosse o contato..."
                className="max-h-32 min-h-[44px] resize-none"
                rows={1}
                aria-label="Mensagem para a IA"
              />
              <Button onClick={send} disabled={!draft.trim() || sending}>
                {sending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                <span className="ml-2 hidden sm:inline">Enviar</span>
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
