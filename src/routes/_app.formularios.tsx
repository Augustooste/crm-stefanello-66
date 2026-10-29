import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Copy, Pencil, Plus, Trash2 } from "lucide-react";

import { PageHeader } from "@/components/common/PageHeader";
import { EmptyState } from "@/components/common/EmptyState";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { requireAdmin, useCurrentProfile } from "@/lib/api/session";
import {
  addLeadFormField,
  buildPublicFormUrl,
  moveLeadFormField,
  removeLeadFormField,
  slugify,
  updateLeadFormField,
  useContactCustomFieldDefinitions,
  useCreateLeadForm,
  useDeleteLeadForm,
  useLeadForms,
  useToggleLeadFormActive,
  useUpdateLeadForm,
  LEAD_FORM_FIELD_TYPES,
  type LeadFormField,
  type LeadFormRow,
} from "@/hooks/use-lead-forms";

export const Route = createFileRoute("/_app/formularios")({
  beforeLoad: ({ context }) => requireAdmin(context.queryClient),
  head: () => ({
    meta: [
      { title: "Formulários de captura" },
      {
        name: "description",
        content: "Crie e edite formulários públicos de captura de leads.",
      },
      { property: "og:title", content: "Formulários de captura" },
      {
        property: "og:description",
        content: "Crie e edite formulários públicos de captura de leads.",
      },
      { property: "og:url", content: "https://aceleraflow.lovable.app/formularios" },
      { name: "twitter:title", content: "Formulários de captura" },
      {
        name: "twitter:description",
        content: "Crie e edite formulários públicos de captura de leads.",
      },
    ],
    links: [{ rel: "canonical", href: "https://aceleraflow.lovable.app/formularios" }],
  }),
  component: FormulariosPage,
});

function FormulariosPage() {
  const { data: profile } = useCurrentProfile();
  // Defesa em profundidade -- a rota já bloqueia não-admin no beforeLoad
  // (requireAdmin), mesmo padrão de _app.templates.tsx.
  const isAdmin = profile?.role === "admin";

  const formsQ = useLeadForms();
  const forms = formsQ.data ?? [];

  const [editing, setEditing] = useState<LeadFormRow | null | "new">(null);
  const [deleting, setDeleting] = useState<LeadFormRow | null>(null);

  const toggleMut = useToggleLeadFormActive();
  const deleteMut = useDeleteLeadForm();

  const copyUrl = async (formId: string) => {
    try {
      await navigator.clipboard.writeText(buildPublicFormUrl(formId));
      toast.success("URL copiada");
    } catch {
      toast.error("Não foi possível copiar a URL — copie manualmente do campo ao lado.");
    }
  };

  return (
    <div className="col-span-12 flex flex-col gap-4">
      <PageHeader
        title="Formulários de captura"
        description="Crie páginas públicas de captura de lead e mapeie os campos para o CRM."
        actions={
          isAdmin && (
            <Button size="sm" onClick={() => setEditing("new")}>
              <Plus className="h-4 w-4" />
              Novo formulário
            </Button>
          )
        }
      />

      {formsQ.isLoading ? (
        <>
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </>
      ) : formsQ.isError ? (
        <EmptyState
          title="Erro ao carregar"
          description={(formsQ.error as Error).message}
          actionLabel="Tentar novamente"
          onAction={() => formsQ.refetch()}
        />
      ) : forms.length === 0 ? (
        <EmptyState
          title="Nenhum formulário criado"
          description="Crie o primeiro formulário para começar a capturar leads pela sua página pública."
          actionLabel={isAdmin ? "Novo formulário" : undefined}
          onAction={isAdmin ? () => setEditing("new") : undefined}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {forms.map((form) => (
            <Card key={form.id}>
              <CardContent className="flex flex-col gap-2 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge variant={form.is_active ? "success" : "neutral"}>
                    {form.is_active ? "Ativo" : "Inativo"}
                  </StatusBadge>
                  <span className="text-body font-medium text-foreground">{form.name}</span>
                  <span className="text-caption text-muted-foreground">{form.slug}</span>
                </div>

                <div className="flex items-center gap-2">
                  <Input readOnly value={buildPublicFormUrl(form.id)} className="max-w-md" />
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label="Copiar URL pública"
                    onClick={() => copyUrl(form.id)}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>

                <p className="text-caption text-muted-foreground">
                  {form.fields.length} campo{form.fields.length === 1 ? "" : "s"} configurado
                  {form.fields.length === 1 ? "" : "s"}
                </p>

                {isAdmin && (
                  <div className="flex flex-wrap items-center gap-3 pt-1">
                    <label className="flex items-center gap-2">
                      <Switch
                        checked={form.is_active}
                        onCheckedChange={(checked) =>
                          toggleMut.mutate(
                            { id: form.id, isActive: checked },
                            {
                              onSuccess: () =>
                                toast.success(
                                  checked ? "Formulário ativado" : "Formulário desativado",
                                ),
                              onError: (e: Error) => toast.error(e.message || "Erro ao atualizar"),
                            },
                          )
                        }
                        aria-label="Ativar ou desativar formulário"
                      />
                      <span className="text-caption text-muted-foreground">Ativo</span>
                    </label>
                    <Button size="sm" variant="outline" onClick={() => setEditing(form)}>
                      <Pencil className="h-4 w-4" />
                      Editar
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeleting(form)}>
                      <Trash2 className="h-4 w-4" />
                      Excluir
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <LeadFormDialog
        open={editing !== null}
        editing={editing === "new" ? null : editing}
        tenantId={profile?.tenant_id}
        onOpenChange={(open) => !open && setEditing(null)}
      />

      <AlertDialog open={deleting !== null} onOpenChange={(v) => !v && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir formulário</AlertDialogTitle>
            <AlertDialogDescription>
              Tem certeza que deseja excluir "{deleting?.name}"? A URL pública deixa de funcionar e
              as submissões já recebidas não são afetadas.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancelar
            </Button>
            <Button
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteMut.isPending}
              onClick={() =>
                deleting &&
                deleteMut.mutate(deleting.id, {
                  onSuccess: () => {
                    toast.success("Formulário excluído");
                    setDeleting(null);
                  },
                  onError: (e: Error) => toast.error(e.message || "Erro ao excluir formulário"),
                })
              }
            >
              Excluir
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── Diálogo de criação/edição ───────────────────────────────────────────────

const leadFormSchema = z.object({
  name: z.string().trim().min(1, "Nome é obrigatório"),
  slug: z
    .string()
    .trim()
    .min(1, "Slug é obrigatório")
    .regex(/^[a-z0-9-]+$/, "Use só letras minúsculas, números e hífen"),
  successMessage: z.string().trim(),
  isActive: z.boolean(),
});
type LeadFormValues = z.infer<typeof leadFormSchema>;

function emptyField(): LeadFormField {
  return { key: "", label: "", type: "text", required: false, maps_to_custom_field_id: null };
}

function LeadFormDialog({
  open,
  editing,
  tenantId,
  onOpenChange,
}: {
  open: boolean;
  editing: LeadFormRow | null;
  tenantId: string | undefined;
  onOpenChange: (v: boolean) => void;
}) {
  const createMut = useCreateLeadForm();
  const updateMut = useUpdateLeadForm();
  const customFieldsQ = useContactCustomFieldDefinitions();
  const [fields, setFields] = useState<LeadFormField[]>([]);
  const [slugTouched, setSlugTouched] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors },
  } = useForm<LeadFormValues>({
    resolver: zodResolver(leadFormSchema),
    defaultValues: { name: "", slug: "", successMessage: "", isActive: true },
  });

  const name = watch("name");
  const slug = watch("slug");
  const isActive = watch("isActive");

  // Prefill só ao ABRIR o diálogo -- reset() dentro de `values` do useForm
  // reexecutaria a cada keystroke e apagaria o que o admin acabou de digitar
  // (mesmo cuidado de _app.templates.tsx::CreateDraftDialog).
  useEffect(() => {
    if (open) {
      reset({
        name: editing?.name ?? "",
        slug: editing?.slug ?? "",
        successMessage: editing?.success_message ?? "",
        isActive: editing?.is_active ?? true,
      });
      setFields(editing?.fields ?? []);
      setSlugTouched(!!editing);
    }
  }, [open, editing, reset]);

  // Slug auto-gerado do nome enquanto o admin não editar o slug manualmente.
  useEffect(() => {
    if (!slugTouched) setValue("slug", slugify(name));
  }, [name, slugTouched, setValue]);

  const submit = (data: LeadFormValues) => {
    const invalidField = fields.find((f) => !f.key.trim() || !f.label.trim());
    if (invalidField) {
      toast.error("Todo campo precisa de chave e rótulo preenchidos");
      return;
    }

    const payload = {
      name: data.name,
      slug: data.slug,
      isActive: data.isActive,
      successMessage: data.successMessage.trim() || null,
      fields,
    };

    const onSettled = {
      onSuccess: () => {
        toast.success(editing ? "Formulário atualizado" : "Formulário criado");
        onOpenChange(false);
      },
      onError: (e: Error) => toast.error(e.message || "Erro ao salvar formulário"),
    };

    if (editing) {
      updateMut.mutate({ id: editing.id, ...payload }, onSettled);
    } else if (tenantId) {
      createMut.mutate({ tenantId, ...payload }, onSettled);
    } else {
      toast.error("Perfil ainda carregando, tente novamente em instantes");
    }
  };

  const isPending = createMut.isPending || updateMut.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? `Editar ${editing.name}` : "Novo formulário"}</DialogTitle>
          <DialogDescription>
            Configure os campos que aparecem na página pública de captura.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(submit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="lead-form-name">Nome *</Label>
            <Input id="lead-form-name" {...register("name")} aria-invalid={!!errors.name} />
            {errors.name && <p className="text-caption text-destructive">{errors.name.message}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="lead-form-slug">Endereço da página *</Label>
            <Input
              id="lead-form-slug"
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setValue("slug", e.target.value);
              }}
              aria-invalid={!!errors.slug}
            />
            {errors.slug && <p className="text-caption text-destructive">{errors.slug.message}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="lead-form-success">Mensagem de sucesso</Label>
            <Textarea
              id="lead-form-success"
              rows={2}
              placeholder="Obrigado! Em breve entraremos em contato."
              {...register("successMessage")}
            />
          </div>

          <label className="flex items-center gap-2">
            <Switch
              checked={isActive}
              onCheckedChange={(checked) => setValue("isActive", checked)}
              aria-label="Formulário ativo"
            />
            <span className="text-body text-foreground">Formulário ativo</span>
          </label>

          <div className="space-y-2 rounded-md border p-3">
            <div className="flex items-center justify-between">
              <Label>Campos do formulário</Label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setFields((prev) => addLeadFormField(prev, emptyField()))}
              >
                <Plus className="h-4 w-4" />
                Adicionar campo
              </Button>
            </div>

            {fields.length === 0 ? (
              <p className="text-caption text-muted-foreground">Nenhum campo adicionado ainda.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {fields.map((field, index) => (
                  <FieldRow
                    key={index}
                    field={field}
                    index={index}
                    total={fields.length}
                    customFieldOptions={customFieldsQ.data ?? []}
                    onChange={(patch) =>
                      setFields((prev) => updateLeadFormField(prev, index, patch))
                    }
                    onRemove={() => setFields((prev) => removeLeadFormField(prev, index))}
                    onMove={(direction) =>
                      setFields((prev) => moveLeadFormField(prev, index, direction))
                    }
                  />
                ))}
              </ul>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Salvando…" : editing ? "Salvar alterações" : "Criar formulário"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function FieldRow({
  field,
  index,
  total,
  customFieldOptions,
  onChange,
  onRemove,
  onMove,
}: {
  field: LeadFormField;
  index: number;
  total: number;
  customFieldOptions: { id: string; key: string; label: string }[];
  onChange: (patch: Partial<LeadFormField>) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
}) {
  return (
    <li className="flex flex-col gap-2 rounded-md border border-border p-2 sm:flex-row sm:items-start">
      <div className="flex flex-row gap-0.5 sm:flex-col">
        <button
          type="button"
          className="text-muted-foreground disabled:opacity-30"
          disabled={index === 0}
          onClick={() => onMove(-1)}
          aria-label={`Mover campo ${index + 1} para cima`}
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="text-muted-foreground disabled:opacity-30"
          disabled={index === total - 1}
          onClick={() => onMove(1)}
          aria-label={`Mover campo ${index + 1} para baixo`}
        >
          <ArrowDown className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="grid flex-1 grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`field-label-${index}`}>Rótulo *</Label>
          <Input
            id={`field-label-${index}`}
            value={field.label}
            onChange={(e) => onChange({ label: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`field-key-${index}`}>Chave *</Label>
          <Input
            id={`field-key-${index}`}
            value={field.key}
            onChange={(e) => onChange({ key: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`field-type-${index}`}>Tipo</Label>
          <Select
            value={field.type}
            onValueChange={(v) => onChange({ type: v as LeadFormField["type"] })}
          >
            <SelectTrigger id={`field-type-${index}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LEAD_FORM_FIELD_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`field-map-${index}`}>Mapear para campo do contato</Label>
          <Select
            value={field.maps_to_custom_field_id ?? "none"}
            onValueChange={(v) => onChange({ maps_to_custom_field_id: v === "none" ? null : v })}
          >
            <SelectTrigger id={`field-map-${index}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Nenhum</SelectItem>
              {customFieldOptions.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <label className="flex items-center gap-2 sm:col-span-2">
          <Checkbox
            checked={field.required}
            onCheckedChange={(checked) => onChange({ required: checked === true })}
          />
          <span className="text-caption text-muted-foreground">Obrigatório</span>
        </label>
      </div>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onRemove}
        aria-label={`Remover campo ${index + 1}`}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </li>
  );
}
