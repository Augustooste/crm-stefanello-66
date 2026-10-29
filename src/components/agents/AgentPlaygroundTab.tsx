// Aba "Testar agente" (playground) do provedor de agentes.
//
// Única operação real de conversa: `POST /v2/agent/{agentId}/conversation`
// (ação `playground.conversation`), sempre síncrona. `callbackUrl` e
// `onFinishCallback` não são campos de UI — mesmo que fossem enviados, o
// proxy os descarta antes de repassar ao provedor (`prepareBody` em
// `supabase/functions/agent-platform-proxy/index.ts`), então não existe "modo
// assíncrono" aqui. O campo `phone` do contrato também não é exposto de
// propósito: informá-lo dispara atendimento real no WhatsApp do cliente, o
// que é incompatível com um teste automático/manual do agente.
//
// Não existe endpoint de histórico do playground no contrato do provedor de agentes:
// a conversa mostrada aqui vive só no estado deste componente e some ao
// recarregar a página ou ao iniciar uma nova conversa (ver Alert abaixo).
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { FileText, Loader2, RotateCcw, Save, Send, XCircle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { AgentPlatformCallError, useAgentPlatformMutation } from "@/lib/api/agent-platform";
import type {
  AgentPlatformConversation,
  AgentPlatformConversationInput,
  AgentPlatformRequestBody,
} from "@/lib/api/agent-platform-contract";

type AgentPlatformAddMessageInput = AgentPlatformRequestBody<"playground.addMessage">;

type PlaygroundRole = "user" | "assistant";

/** Uma troca real de conversa (enviada ou recebida via `playground.conversation`). */
interface PlaygroundMessage {
  id: string;
  kind: "mensagem";
  role: PlaygroundRole;
  text?: string;
  images?: string[];
  audios?: string[];
  documents?: string[];
  /** Resposta chegou depois que o usuário clicou em "Parar de esperar". */
  atrasada?: boolean;
}

/** Aviso local (ex.: confirmação de gravação no histórico) — nunca vira payload de API. */
interface PlaygroundNote {
  id: string;
  kind: "nota";
  text: string;
}

type PlaygroundEntry = PlaygroundMessage | PlaygroundNote;

function novoId(): string {
  return crypto.randomUUID();
}

function paraMensagemDoAgente(
  response: AgentPlatformConversation,
  atrasada: boolean,
): PlaygroundMessage {
  return {
    id: novoId(),
    kind: "mensagem",
    role: "assistant",
    text: response.message,
    images: response.images,
    audios: response.audios,
    documents: response.documents,
    atrasada,
  };
}

function paraMensagemDeErro(err: unknown): string {
  if (err instanceof AgentPlatformCallError) return err.message;
  if (err instanceof Error) return err.message;
  return "Erro desconhecido ao falar com o provedor de agentes.";
}

interface AgentPlaygroundTabProps {
  agentId: string;
}

/** Painel de teste do agente: conversa síncrona reaproveitando o contrato do playground. */
export function AgentPlaygroundTab({ agentId }: AgentPlaygroundTabProps) {
  const [contextId, setContextId] = useState<string>(() => novoId());
  const [entries, setEntries] = useState<PlaygroundEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef(0);
  const waitCancelledRef = useRef(false);

  const conversationMutation = useAgentPlatformMutation("playground.conversation");
  const addMessageMutation = useAgentPlatformMutation("playground.addMessage");

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, pending]);

  function addEntry(entry: PlaygroundEntry) {
    setEntries((prev) => [...prev, entry]);
  }

  function handleNewConversation() {
    sessionRef.current += 1;
    setContextId(novoId());
    setEntries([]);
    setDraft("");
    setPending(false);
    setErrorText(null);
  }

  /** Cancelamento é só visual: o contrato não tem cancelamento remoto. A
   * requisição já enviada segue em andamento e a resposta pode chegar depois
   * — quando chegar, entra no histórico marcada como atrasada. Por isso o
   * aviso vira uma nota persistente, não só o spinner sumindo. */
  function handleStopWaiting() {
    waitCancelledRef.current = true;
    setPending(false);
    addEntry({
      id: novoId(),
      kind: "nota",
      text: "Você parou de esperar. O provedor de agentes não tem cancelamento remoto: a mensagem pode ter sido processada de qualquer forma, e a resposta ainda pode aparecer aqui.",
    });
  }

  async function handleSend() {
    const text = draft.trim();
    if (!text || pending) return;

    const session = sessionRef.current;
    addEntry({ id: novoId(), kind: "mensagem", role: "user", text });
    setDraft("");
    setPending(true);
    setErrorText(null);
    waitCancelledRef.current = false;

    const body: AgentPlatformConversationInput = { contextId, prompt: text };

    try {
      const response = await conversationMutation.mutateAsync({ params: { agentId }, body });
      if (sessionRef.current !== session) return; // conversa trocada enquanto esperava
      addEntry(paraMensagemDoAgente(response, waitCancelledRef.current));
    } catch (err) {
      if (sessionRef.current !== session) return;
      setErrorText(paraMensagemDeErro(err));
    } finally {
      if (sessionRef.current === session) setPending(false);
    }
  }

  /** Injeta uma mensagem já trocada aqui no histórico real do atendimento
   * (`playground.addMessage`). Ação opcional e explícita: nada é gravado
   * automaticamente ao conversar. */
  async function handleSaveToHistory(entry: PlaygroundMessage) {
    if (!entry.text) return;
    setSavingId(entry.id);
    const body: AgentPlatformAddMessageInput = { contextId, prompt: entry.text, role: entry.role };
    try {
      await addMessageMutation.mutateAsync({ params: { agentId }, body });
      addEntry({
        id: novoId(),
        kind: "nota",
        text: "Mensagem gravada no histórico do atendimento.",
      });
    } catch (err) {
      addEntry({
        id: novoId(),
        kind: "nota",
        text: `Falha ao gravar no histórico: ${paraMensagemDeErro(err)}`,
      });
    } finally {
      setSavingId(null);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-card-title font-semibold text-foreground">Testar agente</h2>
          <p
            className="text-caption text-muted-foreground"
            data-testid="playground-context-id"
            title="ID da sessão de teste (contextId), estável durante esta conversa"
          >
            Sessão: <code>{contextId}</code>
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={handleNewConversation}>
          <RotateCcw className="h-4 w-4" />
          Nova conversa
        </Button>
      </div>

      <Alert>
        <AlertTitle>Sem histórico persistido</AlertTitle>
        <AlertDescription>
          O provedor de agentes não expõe endpoint de histórico do playground: esta conversa existe
          só nesta tela e some ao recarregar a página ou ao iniciar uma nova conversa.
        </AlertDescription>
      </Alert>

      <Card className="flex min-h-[420px] flex-1 flex-col overflow-hidden">
        <CardContent className="flex flex-1 flex-col gap-0 p-0">
          <div
            ref={scrollRef}
            role="log"
            aria-live="polite"
            aria-label="Histórico da conversa de teste"
            aria-busy={pending}
            className="flex-1 space-y-3 overflow-y-auto px-4 py-4"
          >
            {entries.length === 0 && !pending ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                Envie uma mensagem para começar a testar o agente.
              </p>
            ) : (
              entries.map((entry) => (
                <PlaygroundEntryView
                  key={entry.id}
                  entry={entry}
                  saving={savingId === entry.id}
                  onSaveToHistory={handleSaveToHistory}
                />
              ))
            )}
            {pending && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Aguardando resposta do agente…
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleStopWaiting}
                  title="Só para de mostrar o carregamento aqui: não cancela a requisição no provedor de agentes"
                >
                  <XCircle className="h-3.5 w-3.5" />
                  Parar de esperar
                </Button>
              </div>
            )}
          </div>

          {errorText && (
            <Alert variant="destructive" className="mx-4 mb-3">
              <AlertDescription>{errorText}</AlertDescription>
            </Alert>
          )}

          <div className="border-t border-border p-3">
            <div className="flex items-end gap-2">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Digite uma mensagem de teste…"
                className="max-h-32 min-h-[44px] resize-none"
                rows={1}
                aria-label="Mensagem de teste para o agente"
              />
              <Button
                type="button"
                onClick={() => void handleSend()}
                disabled={!draft.trim() || pending}
                size="icon"
                aria-label="Enviar mensagem de teste"
              >
                {pending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

interface PlaygroundEntryViewProps {
  entry: PlaygroundEntry;
  saving: boolean;
  onSaveToHistory: (entry: PlaygroundMessage) => void;
}

/** Renderiza uma troca de conversa (texto + anexos) ou uma nota local. */
function PlaygroundEntryView({ entry, saving, onSaveToHistory }: PlaygroundEntryViewProps) {
  if (entry.kind === "nota") {
    return <p className="text-center text-caption italic text-muted-foreground">{entry.text}</p>;
  }

  const hasContent =
    Boolean(entry.text) ||
    Boolean(entry.images?.length) ||
    Boolean(entry.audios?.length) ||
    Boolean(entry.documents?.length);

  return (
    <div className={cn("flex flex-col", entry.role === "user" ? "items-end" : "items-start")}>
      {entry.atrasada && (
        <p className="mb-1 text-caption italic text-muted-foreground">
          Resposta chegou depois que você parou de esperar.
        </p>
      )}
      <div
        className={cn(
          "max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm",
          entry.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
        )}
      >
        {entry.text}
        {!hasContent && entry.role === "assistant" && (
          <span className="italic text-muted-foreground">O agente respondeu sem conteúdo.</span>
        )}

        {entry.images && entry.images.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {entry.images.map((src, i) => (
              <img
                key={`${src}-${i}`}
                src={src}
                alt={`Imagem ${i + 1} da resposta do agente`}
                className="h-24 w-24 rounded-md object-cover"
              />
            ))}
          </div>
        )}

        {entry.audios && entry.audios.length > 0 && (
          <div className="mt-2 space-y-1">
            {entry.audios.map((src, i) => (
              <audio
                key={`${src}-${i}`}
                controls
                src={src}
                aria-label={`Áudio ${i + 1} da resposta do agente`}
                className="w-full"
              />
            ))}
          </div>
        )}

        {entry.documents && entry.documents.length > 0 && (
          <ul className="mt-2 space-y-1">
            {entry.documents.map((href, i) => (
              <li key={`${href}-${i}`}>
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-primary underline"
                >
                  <FileText className="h-3.5 w-3.5" />
                  Documento {i + 1}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>

      {entry.text && (
        <button
          type="button"
          onClick={() => onSaveToHistory(entry)}
          disabled={saving}
          className="mt-1 inline-flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground disabled:opacity-50"
          title="Opcional: grava esta mensagem no histórico real do atendimento (provedor de agentes)"
        >
          <Save className="h-3 w-3" />
          {saving ? "Gravando…" : "Gravar no histórico"}
        </button>
      )}
    </div>
  );
}
