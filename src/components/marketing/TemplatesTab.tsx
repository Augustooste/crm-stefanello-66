import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Plus, Send } from "lucide-react";

import { PageHeader } from "@/components/common/PageHeader";
import { EmptyState } from "@/components/common/EmptyState";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCurrentProfile } from "@/lib/api/session";
import {
  useApproveTemplateVersion,
  useCreateTemplateDraft,
  useMessagingTemplates,
  type MessagingTemplateRow,
  type TemplateKind,
} from "@/hooks/use-messaging-templates";
import { NovaCampanhaDialog } from "./NovaCampanhaDialog";

/**
 * Corpo da antiga rota /templates -- gate de admin fica no `beforeLoad` da
 * rota combinada (ver _app.templates.tsx), que também renderiza a aba
 * Campanhas (AgendamentosTab). "Criar campanha" abre o mesmo NovaCampanhaDialog
 * da aba Campanhas, com o modelo pré-selecionado.
 */
export function TemplatesTab() {
  const { data: profile } = useCurrentProfile();
  // Defesa em profundidade -- a rota já bloqueia não-admin no beforeLoad
  // (requireAdmin), mas a ação de aprovar fica escondida de novo aqui para
  // não depender só do guard de rota se este componente algum dia for
  // reaproveitado fora da rota.
  const isAdmin = profile?.role === "admin";

  const templatesQ = useMessagingTemplates();
  const [dialogState, setDialogState] = useState<{ basedOn: MessagingTemplateRow | null } | null>(
    null,
  );
  const [scheduleTarget, setScheduleTarget] = useState<MessagingTemplateRow | null>(null);

  const templatesData = templatesQ.data;
  const templates = useMemo(() => templatesData ?? [], [templatesData]);
  const approved = useMemo(() => templates.filter((t) => !t.is_draft), [templates]);
  const drafts = useMemo(() => templates.filter((t) => t.is_draft), [templates]);
  const versionById = useMemo(
    () => new Map(templates.map((t) => [t.id, t.version] as const)),
    [templates],
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Modelos"
        description="Rascunhos, versões e aprovação dos modelos de mensagem da empresa."
        actions={
          isAdmin && (
            <Button size="sm" onClick={() => setDialogState({ basedOn: null })}>
              <Plus className="h-4 w-4" />
              Novo modelo
            </Button>
          )
        }
      />

      {templatesQ.isLoading ? (
        <>
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </>
      ) : templatesQ.isError ? (
        <EmptyState
          title="Erro ao carregar"
          description={(templatesQ.error as Error).message}
          actionLabel="Tentar novamente"
          onAction={() => templatesQ.refetch()}
        />
      ) : (
        <Tabs defaultValue="aprovados" className="w-full">
          <TabsList>
            <TabsTrigger value="aprovados">Aprovados</TabsTrigger>
            <TabsTrigger value="pendentes">Pendentes de aprovação ({drafts.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="aprovados" className="flex flex-col gap-3">
            {approved.length === 0 ? (
              <EmptyState
                title="Nenhum modelo aprovado"
                description="Crie um rascunho e aprove-o para que ele apareça aqui."
              />
            ) : (
              approved.map((t) => (
                <TemplateCard
                  key={t.id}
                  row={t}
                  isAdmin={isAdmin}
                  parentVersion={t.parent_id ? versionById.get(t.parent_id) : undefined}
                  onNewVersion={() => setDialogState({ basedOn: t })}
                  onSchedule={() => setScheduleTarget(t)}
                />
              ))
            )}
          </TabsContent>

          <TabsContent value="pendentes" className="flex flex-col gap-3">
            {drafts.length === 0 ? (
              <EmptyState
                title="Nenhum rascunho pendente"
                description="Rascunhos criados aparecem aqui até serem aprovados."
              />
            ) : (
              drafts.map((t) => (
                <TemplateCard
                  key={t.id}
                  row={t}
                  isAdmin={isAdmin}
                  parentVersion={t.parent_id ? versionById.get(t.parent_id) : undefined}
                />
              ))
            )}
          </TabsContent>
        </Tabs>
      )}

      <CreateDraftDialog
        open={dialogState !== null}
        basedOn={dialogState?.basedOn ?? null}
        onOpenChange={(open) => !open && setDialogState(null)}
      />

      <NovaCampanhaDialog
        open={scheduleTarget !== null}
        initialTemplateId={scheduleTarget?.id ?? null}
        onOpenChange={(open) => !open && setScheduleTarget(null)}
      />
    </div>
  );
}

const statusLabel: Record<MessagingTemplateRow["status"], string> = {
  pending: "Rascunho",
  approved: "Aprovado",
  rejected: "Rejeitado",
};

const statusVariant: Record<MessagingTemplateRow["status"], "success" | "neutral" | "destructive"> =
  {
    pending: "neutral",
    approved: "success",
    rejected: "destructive",
  };

function TemplateCard({
  row,
  isAdmin,
  parentVersion,
  onNewVersion,
  onSchedule,
}: {
  row: MessagingTemplateRow;
  isAdmin: boolean;
  parentVersion?: number;
  onNewVersion?: () => void;
  onSchedule?: () => void;
}) {
  const approveMut = useApproveTemplateVersion();

  const approve = () => {
    approveMut.mutate(row.id, {
      onSuccess: () => toast.success("Modelo aprovado"),
      onError: (e: Error) => toast.error(e.message || "Erro ao aprovar template"),
    });
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{row.language}</Badge>
          <StatusBadge variant="neutral" showDot={false}>
            v{row.version}
          </StatusBadge>
          <StatusBadge variant={statusVariant[row.status]}>{statusLabel[row.status]}</StatusBadge>
          {row.kind === "provider_approved" && (
            <Badge variant="outline">
              Aprovado no provedor
              {row.provider_template_name ? `: ${row.provider_template_name}` : ""}
            </Badge>
          )}
          {row.parent_id && (
            <span className="text-caption text-muted-foreground">
              {parentVersion ? `Baseado na v${parentVersion}` : "Baseado em outra versão"}
            </span>
          )}
        </div>

        <div className="text-body font-medium text-foreground">{row.name}</div>
        <p className="text-body text-muted-foreground">{row.body}</p>

        {row.variables.length > 0 && (
          <p className="text-caption text-muted-foreground">
            Variáveis: {row.variables.join(", ")}
          </p>
        )}

        {row.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {row.tags.map((tag) => (
              <Badge key={tag} variant="outline">
                {tag}
              </Badge>
            ))}
          </div>
        )}

        {isAdmin && (
          <div className="flex flex-wrap gap-2 pt-1">
            {row.is_draft && (
              <Button size="sm" disabled={approveMut.isPending} onClick={approve}>
                Aprovar
              </Button>
            )}
            {!row.is_draft && onNewVersion && (
              <Button size="sm" variant="outline" onClick={onNewVersion}>
                Nova versão
              </Button>
            )}
            {!row.is_draft && row.status === "approved" && onSchedule && (
              <Button size="sm" variant="outline" onClick={onSchedule}>
                <Send className="h-4 w-4" />
                Criar campanha
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Diálogo de criação de rascunho ─────────────────────────────────────────

function parseCommaList(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

const createDraftSchema = z
  .object({
    name: z.string().trim().min(1, "Nome é obrigatório"),
    language: z.string().trim().min(1, "Idioma é obrigatório"),
    body: z.string().trim().min(1, "Corpo é obrigatório"),
    variables: z.string(),
    tags: z.string(),
    kind: z.enum(["freeform", "provider_approved"]),
    providerTemplateName: z.string().trim(),
  })
  .refine((data) => data.kind !== "provider_approved" || data.providerTemplateName.length > 0, {
    message: "Obrigatório quando o modelo é aprovado pelo provedor",
    path: ["providerTemplateName"],
  });
type CreateDraftForm = z.infer<typeof createDraftSchema>;

function CreateDraftDialog({
  open,
  basedOn,
  onOpenChange,
}: {
  open: boolean;
  basedOn: MessagingTemplateRow | null;
  onOpenChange: (v: boolean) => void;
}) {
  const createMut = useCreateTemplateDraft();
  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors },
  } = useForm<CreateDraftForm>({
    resolver: zodResolver(createDraftSchema),
    defaultValues: {
      name: "",
      language: "pt_BR",
      body: "",
      variables: "",
      tags: "",
      kind: "freeform",
      providerTemplateName: "",
    },
  });

  const kind = watch("kind");

  // Prefill só ao ABRIR o diálogo (não a cada render) -- reset() aqui dentro
  // de `values` do useForm reexecutaria a cada keystroke e apagaria o que o
  // admin acabou de digitar.
  useEffect(() => {
    if (open) {
      reset({
        name: basedOn?.name ?? "",
        language: basedOn?.language ?? "pt_BR",
        body: basedOn?.body ?? "",
        variables: basedOn?.variables.join(", ") ?? "",
        tags: basedOn?.tags.join(", ") ?? "",
        kind: basedOn?.kind ?? "freeform",
        providerTemplateName: basedOn?.provider_template_name ?? "",
      });
    }
  }, [open, basedOn, reset]);

  const submit = (data: CreateDraftForm) => {
    createMut.mutate(
      {
        name: data.name,
        language: data.language,
        body: data.body,
        variables: parseCommaList(data.variables),
        tags: parseCommaList(data.tags),
        parentId: basedOn?.id ?? null,
        kind: data.kind,
        providerTemplateName: data.kind === "provider_approved" ? data.providerTemplateName : null,
      },
      {
        onSuccess: () => {
          toast.success("Rascunho criado");
          onOpenChange(false);
          reset();
        },
        onError: (e: Error) => toast.error(e.message || "Erro ao criar rascunho"),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{basedOn ? `Nova versão de ${basedOn.name}` : "Novo template"}</DialogTitle>
          <DialogDescription>
            O rascunho fica pendente de aprovação e não afeta o template aprovado em uso.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(submit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="template-name">Nome *</Label>
            <Input id="template-name" {...register("name")} aria-invalid={!!errors.name} />
            {errors.name && <p className="text-caption text-destructive">{errors.name.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="template-language">Idioma *</Label>
            <Input
              id="template-language"
              {...register("language")}
              aria-invalid={!!errors.language}
            />
            {errors.language && (
              <p className="text-caption text-destructive">{errors.language.message}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="template-kind">Tipo de modelo</Label>
            <Select value={kind} onValueChange={(v) => setValue("kind", v as TemplateKind)}>
              <SelectTrigger id="template-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="freeform">Corpo livre</SelectItem>
                <SelectItem value="provider_approved">Aprovado pelo provedor</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {kind === "provider_approved" && (
            <div className="space-y-1.5 rounded-md border border-warning/40 bg-warning/10 p-3">
              <Label htmlFor="template-provider-name">Nome do modelo aprovado na Meta *</Label>
              <Input
                id="template-provider-name"
                placeholder="ex.: confirmacao_pedido_pt_br"
                {...register("providerTemplateName")}
                aria-invalid={!!errors.providerTemplateName}
              />
              <p className="text-caption text-muted-foreground">
                Use exatamente o nome cadastrado na Meta e o idioma exato do modelo (ex.: pt_BR). O
                corpo abaixo é só referência interna. As variáveis, na ordem em que você listar,
                preenchem {"{{1}}"}, {"{{2}}"}… do modelo aprovado (formato posicional).
              </p>
              {errors.providerTemplateName && (
                <p className="text-caption text-destructive">
                  {errors.providerTemplateName.message}
                </p>
              )}
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="template-body">Corpo *</Label>
            <Textarea
              id="template-body"
              rows={4}
              {...register("body")}
              aria-invalid={!!errors.body}
            />
            {errors.body && <p className="text-caption text-destructive">{errors.body.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="template-variables">Variáveis (separadas por vírgula)</Label>
            <Input
              id="template-variables"
              placeholder="nome, produto, prazo"
              {...register("variables")}
            />
            <p className="text-caption text-muted-foreground">
              Cada variável vem do contato: campo personalizado com a mesma chave, ou "nome" para o
              nome do contato.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="template-tags">Tags (livres, separadas por vírgula)</Label>
            <Input id="template-tags" placeholder="pos-venda, urgente, vip" {...register("tags")} />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={createMut.isPending}>
              {createMut.isPending ? "Criando…" : "Criar rascunho"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
