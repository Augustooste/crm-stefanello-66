import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Bot, Loader2, Send, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { formatCopilotText } from "@/components/ai/copilot-text";
import { Textarea } from "@/components/ui/textarea";
import * as VisuallyHiddenPrimitive from "@radix-ui/react-visually-hidden";
import { copilotChat } from "@/lib/api/ai-config";
import { cn } from "@/lib/utils";

interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  text: string;
}

interface AiAssistantPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const SUGGESTIONS = [
  {
    icon: "🔎",
    label: "Buscar negócios",
    prompt: "Quais são os negócios abertos com maior valor no funil?",
  },
  { icon: "👤", label: "Buscar contatos", prompt: "Liste os contatos mais recentes cadastrados." },
  {
    icon: "✅",
    label: "Próximas tarefas",
    prompt: "Quais são minhas próximas tarefas e retornos?",
  },
];

/**
 * Painel lateral do assistente de IA, aberto pelo botão Sparkles do topbar.
 * Fala com a edge function `ai-copilot`, que consulta o CRM de verdade. NÃO usa
 * `ai-playground`: aquele simula o agente que atende o lead, e era por isso que
 * o painel respondia em personagem. Sem persistência — o histórico vive só no
 * estado do painel durante a sessão.
 */
export function AiAssistantPanel({ open, onOpenChange }: AiAssistantPanelProps) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, sending]);

  const send = async (textOverride?: string) => {
    const text = (textOverride ?? draft).trim();
    if (!text || sending) return;
    const userMsg: ChatMsg = { id: `u-${Date.now()}`, role: "user", text };
    const next = [...messages, userMsg];
    setMessages(next);
    setDraft("");
    setSending(true);
    try {
      const { reply } = await copilotChat({
        messages: next.map((m) => ({ role: m.role, content: m.text })),
      });
      setMessages((prev) => [...prev, { id: `a-${Date.now()}`, role: "assistant", text: reply }]);
    } catch (e) {
      toast.error((e as Error).message || "Falha ao gerar resposta.");
    } finally {
      setSending(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const reset = () => {
    setMessages([]);
    setDraft("");
  };

  // Nome fixo de propósito: a persona do tenant é a do agente que fala com o
  // LEAD. Exibi-la aqui era metade do engano — o painel se apresentava como
  // "Clara, assistente da equipe" e respondia qualificando quem perguntava.
  const displayName = "Copiloto";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        id="ai-assistant-panel"
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-md"
      >
        <VisuallyHiddenPrimitive.Root>
          <SheetTitle>Assistente IA</SheetTitle>
          <SheetDescription>
            Converse com o assistente de IA para buscar deals, contatos e próximas tarefas.
          </SheetDescription>
        </VisuallyHiddenPrimitive.Root>

        {/* Header */}
        <header className="flex items-center gap-3 border-b border-border bg-surface px-4 py-3">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-primary/15 text-body font-semibold text-primary">
            <Sparkles className="h-4 w-4" />
          </span>
          <div className="flex-1 min-w-0">
            <p className="truncate text-body font-semibold text-foreground">{displayName}</p>
            <p className="text-caption text-muted-foreground">AI Assistant</p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-caption font-medium text-emerald-500">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Pronto
          </span>
        </header>

        {/* Messages */}
        <div
          ref={scrollRef}
          role="log"
          aria-live="polite"
          aria-label="Histórico da conversa"
          aria-busy={sending}
          className="flex-1 overflow-y-auto px-4 py-6"
        >
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <span className="mb-4 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/15 text-primary">
                <Bot className="h-7 w-7" />
              </span>
              <p className="text-body font-semibold text-foreground">Como posso ajudar?</p>
              <p className="mt-1 text-caption text-muted-foreground">
                Negócios · Contatos · Tarefas
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    onClick={() => send(s.prompt)}
                    disabled={sending}
                    aria-label={`Sugestão: ${s.label}`}
                    className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-caption text-foreground transition-colors hover:bg-muted disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
                  >
                    <span aria-hidden>{s.icon}</span>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}
                >
                  <div
                    className={cn(
                      "max-w-[85%] whitespace-pre-wrap text-body",
                      m.role === "user"
                        ? "rounded-2xl bg-primary px-3 py-2 text-primary-foreground"
                        : "text-foreground",
                    )}
                  >
                    {m.role === "assistant" ? formatCopilotText(m.text) : m.text}
                  </div>
                </div>
              ))}
              {sending && (
                <div className="flex items-center gap-2 text-caption text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {displayName} está pensando…
                </div>
              )}
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="border-t border-border bg-surface p-3">
          {messages.length > 0 && (
            <div className="mb-2 flex justify-end">
              <button
                type="button"
                onClick={reset}
                className="rounded text-caption text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
              >
                Nova conversa
              </button>
            </div>
          )}
          <div className="flex items-end gap-2">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKey}
              placeholder="Pergunte algo..."
              className="max-h-32 min-h-[44px] resize-none"
              rows={1}
              aria-label="Mensagem para a IA"
              autoFocus
            />
            <Button
              onClick={() => send()}
              disabled={!draft.trim() || sending}
              size="icon"
              aria-label="Enviar"
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
