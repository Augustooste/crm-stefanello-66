import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  BookOpenText,
  FileText,
  Loader2,
  RefreshCw,
  Trash2,
  Upload,
  UploadCloud,
  X,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { EmptyState } from "@/components/common/EmptyState";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { userFacingFailureMessage } from "@/lib/integrations/friendly-errors";
import { useCurrentProfile } from "@/lib/api/session";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  formatBytes,
  KNOWLEDGE_ACCEPT_ATTRIBUTE,
  KNOWLEDGE_FORMAT_GROUPS,
  KNOWLEDGE_MAX_MB,
  knowledgeMimeFor,
  validateKnowledgeFile,
} from "@/lib/knowledge-files";

type DocumentStatus = "uploaded" | "processing" | "ready" | "failed";

export interface KnowledgeDocument {
  id: string;
  title: string;
  source_type: "text" | "upload";
  mime_type: string | null;
  bytes: number;
  status: DocumentStatus;
  error_message: string | null;
  chunk_count: number;
  created_at: string;
  updated_at: string;
}

type DocumentAction =
  | { action: "list" }
  | {
      action: "upload";
      title: string;
      sourceType: "text";
      text: string;
    }
  | {
      action: "upload";
      title: string;
      sourceType: "upload";
      fileName: string;
      mimeType: string;
      base64: string;
    }
  | { action: "reprocess"; documentId: string }
  | { action: "delete"; documentId: string };

async function invokeDocuments<T>(body: DocumentAction): Promise<T> {
  const { data, error } = await supabase.functions.invoke("kb-documents", { body });
  if (error) throw error;
  if (!data?.ok) throw new Error(data?.error ?? "A operação da base de conhecimento falhou.");
  return data as T;
}

async function fileAsBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Espelha KNOWLEDGE_CLAIM_LEASE_MS de supabase/functions/_shared/ai/knowledge-ingest.ts.
// O servidor continua sendo a autoridade: se a lease ainda estiver viva ele
// recusa o claim e devolve "Documento já está sendo processado.".
const KNOWLEDGE_CLAIM_LEASE_MS = 5 * 60 * 1_000;

function canReprocess(document: KnowledgeDocument): boolean {
  if (document.status === "ready" || document.status === "failed") return true;
  if (document.status !== "processing") return false;
  const updatedAt = Date.parse(document.updated_at);
  return Number.isFinite(updatedAt) && Date.now() - updatedAt > KNOWLEDGE_CLAIM_LEASE_MS;
}

function progressFor(status: DocumentStatus): number {
  if (status === "uploaded") return 15;
  if (status === "processing") return 65;
  return 100;
}

// Espelha LLAMA_PENDING_MESSAGE de supabase/functions/_shared/ai/knowledge-ingest.ts.
// O parse continua rodando no provedor; é aviso, não erro.
export function isParsePending(document: Pick<KnowledgeDocument, "status" | "error_message">) {
  return (
    document.status === "failed" &&
    (document.error_message ?? "").includes("ainda está processando")
  );
}

function statusMeta(document: Pick<KnowledgeDocument, "status" | "error_message">) {
  const status = document.status;
  if (status === "ready") return { label: "Disponível", variant: "success" as const };
  if (status === "failed") {
    return isParsePending(document)
      ? { label: "Aguardando o provedor", variant: "warning" as const }
      : { label: "Falhou", variant: "destructive" as const };
  }
  if (status === "processing") return { label: "Processando", variant: "warning" as const };
  return { label: "Na fila", variant: "neutral" as const };
}

/**
 * Espelha o que `ai_feature_catalog` guarda para a base de conhecimento: o
 * catálogo traz o padrão e `tenant_ai_features` traz a escolha da empresa,
 * que vence quando existe. Mesmo formato lido por AiFeaturesTab.
 */
type ConsultaDaBaseRow = {
  default_enabled: boolean;
  tenant_ai_features: { enabled: boolean }[] | null;
};

/**
 * A base só é consultada quando a empresa liga "Base de conhecimento RAG" em
 * Configurações → IA → Features: com ela desligada,
 * `supabase/functions/_shared/ai/knowledge-context.ts` devolve string vazia e
 * a IA responde como se não houvesse documento nenhum. O padrão de fábrica é
 * desligado, então sem aviso o dono sobe arquivo, lê "Disponível" em verde e
 * conclui que está no ar.
 */
function useConsultaDaBaseLigada(tenantId: string | null) {
  return useQuery({
    queryKey: ["kb-consulta-ligada", tenantId],
    enabled: !!tenantId,
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase
        .from("ai_feature_catalog")
        .select("default_enabled, tenant_ai_features(enabled)")
        .eq("feature_key", "knowledge_rag")
        .maybeSingle();
      if (error) throw error;
      const row = (data ?? null) as ConsultaDaBaseRow | null;
      return row?.tenant_ai_features?.[0]?.enabled ?? row?.default_enabled ?? false;
    },
  });
}

export function KnowledgeBaseTab() {
  const profile = useCurrentProfile();
  const tenantId = profile.data?.tenant_id ?? null;
  const consultaLigada = useConsultaDaBaseLigada(tenantId);
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [tab, setTab] = useState<"text" | "file">("text");
  const [dragging, setDragging] = useState(false);

  const selectFile = (selected: File | null) => {
    if (!selected) {
      setFile(null);
      return;
    }
    const problem = validateKnowledgeFile(selected);
    if (problem) {
      toast.error(problem);
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    setFile(selected);
    setText("");
  };

  const documents = useQuery({
    queryKey: ["kb-documents", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const result = await invokeDocuments<{ ok: true; documents: KnowledgeDocument[] }>({
        action: "list",
      });
      return result.documents;
    },
    refetchInterval: (query) =>
      query.state.data?.some((doc) => doc.status === "uploaded" || doc.status === "processing")
        ? 3_000
        : false,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["kb-documents", tenantId] });
  const upload = useMutation({
    mutationFn: async () => {
      const cleanTitle = title.trim() || file?.name.replace(/\.[^.]+$/, "") || "Documento";
      if (file) {
        const problem = validateKnowledgeFile(file);
        if (problem) throw new Error(problem);
        return await invokeDocuments({
          action: "upload",
          title: cleanTitle,
          sourceType: "upload",
          fileName: file.name,
          mimeType: knowledgeMimeFor(file),
          base64: await fileAsBase64(file),
        });
      }
      const cleanText = text.trim();
      if (!cleanText) throw new Error("Cole um texto ou selecione um arquivo.");
      return await invokeDocuments({
        action: "upload",
        title: cleanTitle,
        sourceType: "text",
        text: cleanText,
      });
    },
    onSuccess: async () => {
      toast.success("Documento enviado para processamento.");
      setTitle("");
      setText("");
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      await invalidate();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const action = useMutation({
    mutationFn: (input: { action: "reprocess" | "delete"; documentId: string }) =>
      invokeDocuments({ ...input }),
    onSuccess: async (_, input) => {
      toast.success(
        input.action === "delete" ? "Documento removido." : "Reprocessamento iniciado.",
      );
      await invalidate();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <div className="space-y-4">
      {/* Só quando a resposta chegou e é "desligada": em carregamento ou erro
          o aviso seria um palpite, e palpite aqui vira desinformação. */}
      {consultaLigada.isSuccess && !consultaLigada.data && (
        <Alert>
          <AlertTriangle className="h-4 w-4" aria-hidden />
          <AlertTitle>A IA ainda não consulta esta base</AlertTitle>
          <AlertDescription>
            Os documentos abaixo ficam guardados, mas a IA não olha para eles enquanto a base de
            conhecimento estiver desligada — mesmo os que aparecem como “Disponível”. Ligue em
            Configurações → IA → Features.{" "}
            <Link to="/configuracoes" hash="ia/features" className="underline">
              Ligar agora
            </Link>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="h-4 w-4" aria-hidden />
            Adicionar conhecimento
          </CardTitle>
          <CardDescription>
            Cole um texto ou envie um arquivo. Documentos, planilhas e imagens são extraídos pelo
            LlamaParse e o assistente consulta apenas os trechos relevantes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="kb-title">Título</Label>
            <Input
              id="kb-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Ex.: Política comercial 2026"
              maxLength={160}
            />
          </div>

          <Tabs value={tab} onValueChange={(value) => setTab(value as "text" | "file")}>
            <TabsList className="grid w-full grid-cols-2 sm:w-72">
              <TabsTrigger value="text">Colar texto</TabsTrigger>
              <TabsTrigger value="file">Enviar arquivo</TabsTrigger>
            </TabsList>

            <TabsContent value="text" className="mt-4 space-y-1.5">
              <Label htmlFor="kb-text">Texto</Label>
              <Textarea
                id="kb-text"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="Cole aqui FAQs, políticas ou instruções que a IA pode consultar."
                rows={8}
                maxLength={200_000}
                disabled={!!file}
              />
              {file && (
                <p className="text-caption text-muted-foreground">
                  Remova o arquivo selecionado para digitar um texto.
                </p>
              )}
            </TabsContent>

            <TabsContent value="file" className="mt-4 space-y-3">
              <Label htmlFor="kb-file" className="sr-only">
                Selecionar arquivo
              </Label>
              <input
                ref={fileRef}
                id="kb-file"
                type="file"
                className="sr-only"
                accept={KNOWLEDGE_ACCEPT_ATTRIBUTE}
                onChange={(event) => selectFile(event.target.files?.[0] ?? null)}
              />
              {file ? (
                <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 p-4">
                  <FileText className="h-5 w-5 shrink-0 text-primary" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{file.name}</p>
                    <p className="text-caption text-muted-foreground">{formatBytes(file.size)}</p>
                  </div>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label="Remover arquivo"
                    onClick={() => {
                      setFile(null);
                      if (fileRef.current) fileRef.current.value = "";
                    }}
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragging(false);
                    selectFile(event.dataTransfer.files?.[0] ?? null);
                  }}
                  className={cn(
                    "flex w-full flex-col items-center gap-2 rounded-lg border-2 border-dashed border-border px-6 py-10 text-center transition-colors",
                    "hover:border-primary/60 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    dragging && "border-primary bg-primary/5",
                  )}
                >
                  <UploadCloud className="h-7 w-7 text-muted-foreground" aria-hidden />
                  <span className="text-sm font-medium text-foreground">
                    Arraste um arquivo ou clique para selecionar
                  </span>
                  <span className="text-caption text-muted-foreground">
                    Até {KNOWLEDGE_MAX_MB} MB por arquivo
                  </span>
                </button>
              )}
              <dl className="grid gap-2 sm:grid-cols-3">
                {KNOWLEDGE_FORMAT_GROUPS.map((group) => (
                  <div key={group.label} className="rounded-md border border-border/60 p-3">
                    <dt className="text-caption font-medium text-foreground">{group.label}</dt>
                    <dd className="text-caption text-muted-foreground">{group.items}</dd>
                  </div>
                ))}
              </dl>
            </TabsContent>
          </Tabs>

          <Button
            onClick={() => upload.mutate()}
            disabled={upload.isPending || (!text.trim() && !file)}
          >
            {upload.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Processar documento
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BookOpenText className="h-4 w-4" aria-hidden />
            Documentos disponíveis
          </CardTitle>
          <CardDescription>Cada documento e trecho fica isolado na empresa ativa.</CardDescription>
        </CardHeader>
        <CardContent>
          {documents.isPending ? (
            <div className="space-y-3">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : documents.isError ? (
            <EmptyState
              icon={BookOpenText}
              title="Não foi possível carregar os documentos"
              description={(documents.error as Error).message}
              actionLabel="Tentar novamente"
              onAction={() => documents.refetch()}
            />
          ) : documents.data.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="Nenhum documento processado"
              description="Adicione o primeiro conteúdo acima para ativar respostas com base documental."
            />
          ) : (
            <div className="space-y-3">
              {documents.data.map((document) => {
                const status = statusMeta(document);
                const pending = isParsePending(document);
                return (
                  <article key={document.id} className="rounded-lg border border-border p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="truncate font-medium text-foreground">{document.title}</h3>
                        <p className="text-caption text-muted-foreground">
                          {document.chunk_count} trechos · {formatDateTime(document.created_at)}
                        </p>
                      </div>
                      <StatusBadge variant={status.variant}>{status.label}</StatusBadge>
                    </div>
                    <Progress
                      value={progressFor(document.status)}
                      className="mt-3"
                      aria-label={`Processamento de ${document.title}`}
                    />
                    {document.error_message && (
                      <p
                        className={`mt-2 text-caption ${pending ? "text-warning" : "text-destructive"}`}
                      >
                        {userFacingFailureMessage(document.error_message)}
                      </p>
                    )}
                    <div className="mt-3 flex justify-end gap-2">
                      {canReprocess(document) && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={action.isPending}
                          onClick={() =>
                            action.mutate({ action: "reprocess", documentId: document.id })
                          }
                        >
                          <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                          Reprocessar
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={action.isPending}
                        onClick={() => {
                          if (
                            globalThis.confirm(`Excluir "${document.title}" e todos os trechos?`)
                          ) {
                            action.mutate({ action: "delete", documentId: document.id });
                          }
                        }}
                      >
                        <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                        Excluir
                      </Button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
