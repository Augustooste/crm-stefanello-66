import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Pause, Pencil, Play, Plus, Trash2, XCircle } from "lucide-react";

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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { useCurrentProfile } from "@/lib/api/session";
import { formatDateTime } from "@/lib/format";
import {
  useBoardStagesForNurture,
  useCreateNurtureSequence,
  useCreateNurtureStep,
  useDeleteNurtureStep,
  useNurtureEnrollments,
  useNurtureExecutionHistory,
  useNurtureSequences,
  useSetNurtureEnrollmentStatus,
  useUpdateNurtureSequence,
  useUpdateNurtureStep,
  type NurtureEnrollmentRow,
  type NurtureEnrollmentStatus,
  type NurtureExecutionRow,
  type NurtureSequenceRow,
  type NurtureStepRow,
  type NurtureTriggerType,
  type SettableNurtureEnrollmentStatus,
} from "@/hooks/use-nurture";

export const Route = createFileRoute("/_app/nurture")({
  head: () => ({
    meta: [
      { title: "Acompanhamento automático" },
      {
        name: "description",
        content: "Sequências automáticas de nutrição e inscrições de contatos.",
      },
      { property: "og:title", content: "Acompanhamento automático" },
      {
        property: "og:description",
        content: "Sequências automáticas de nutrição e inscrições de contatos.",
      },
      { property: "og:url", content: "https://aceleraflow.lovable.app/nurture" },
      { name: "twitter:title", content: "Acompanhamento automático" },
      {
        name: "twitter:description",
        content: "Sequências automáticas de nutrição e inscrições de contatos.",
      },
    ],
    links: [{ rel: "canonical", href: "https://aceleraflow.lovable.app/nurture" }],
  }),
  component: NurturePage,
});

const triggerLabels: Record<NurtureTriggerType, string> = {
  manual: "Manual",
  stage_change: "Mudança de etapa",
  stagnant: "Estagnado",
  periodic: "Periódico",
  won: "Negócio ganho",
  birthday: "Aniversário",
};

const enrollmentStatusLabel: Record<NurtureEnrollmentStatus, string> = {
  active: "Ativa",
  sending: "Enviando",
  paused: "Pausada",
  completed: "Concluída",
  cancelled: "Cancelada",
};

const executionOutcomeLabel: Record<NurtureExecutionRow["outcome"], string> = {
  sent: "Mensagem enviada",
  completed: "Sequência concluída",
  retry: "Falha no envio; nova tentativa agendada",
  exhausted: "Cancelada por limite de tentativas",
  skipped_suppressed: "Cancelada por bloqueio do contato",
  skipped_cancelled: "Envio interrompido",
  deferred_frequency: "Adiada pelo limite de frequência",
  deferred_handoff: "Adiada durante atendimento humano",
  deferred_window: "Adiada para o horário de atendimento",
};

const enrollmentStatusVariant: Record<
  NurtureEnrollmentStatus,
  "success" | "warning" | "neutral" | "destructive"
> = {
  active: "success",
  sending: "warning",
  paused: "neutral",
  completed: "neutral",
  cancelled: "destructive",
};

function NurturePage() {
  const { data: profile } = useCurrentProfile();
  // Defesa em profundidade -- ver comentário equivalente em _app.templates.tsx.
  // Ao contrário de /templates, a NAVEGAÇÃO para /nurture é visível a todos os
  // papéis (ver AppSidebar); só as ações de escrita ficam atrás de isAdmin.
  const isAdmin = profile?.role === "admin";

  const sequencesQ = useNurtureSequences();
  const enrollmentsQ = useNurtureEnrollments();

  const sequences = useMemo(() => sequencesQ.data ?? [], [sequencesQ.data]);
  const enrollments = useMemo(() => enrollmentsQ.data ?? [], [enrollmentsQ.data]);

  // Contagem de inscrições ativas por sequência derivada de UM único fetch já
  // carregado (useNurtureEnrollments) -- nunca 1 query de count por sequência.
  const activeCountBySequence = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of enrollments) {
      if (e.status !== "active") continue;
      map.set(e.sequence_id, (map.get(e.sequence_id) ?? 0) + 1);
    }
    return map;
  }, [enrollments]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = sequences.find((s) => s.id === selectedId) ?? null;
  const selectedEnrollments = useMemo(
    () => enrollments.filter((e) => e.sequence_id === selectedId),
    [enrollments, selectedId],
  );

  const [sequenceDialog, setSequenceDialog] = useState<{
    sequence: NurtureSequenceRow | null;
  } | null>(null);

  return (
    <div className="col-span-12 flex flex-col gap-4">
      <PageHeader
        title="Acompanhamento automático"
        description="Sequências automáticas de mensagens e inscrições de contatos."
        actions={
          isAdmin && (
            <Button size="sm" onClick={() => setSequenceDialog({ sequence: null })}>
              <Plus className="h-4 w-4" />
              Nova sequência
            </Button>
          )
        }
      />

      {sequencesQ.isLoading ? (
        <>
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </>
      ) : sequencesQ.isError ? (
        <EmptyState
          title="Erro ao carregar"
          description={(sequencesQ.error as Error).message}
          actionLabel="Tentar novamente"
          onAction={() => sequencesQ.refetch()}
        />
      ) : sequences.length === 0 ? (
        <EmptyState
          title="Nenhuma sequência de acompanhamento"
          description="Crie a primeira sequência para começar a nutrir contatos automaticamente."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {sequences.map((s) => (
            <SequenceCard
              key={s.id}
              row={s}
              activeCount={activeCountBySequence.get(s.id) ?? 0}
              isSelected={s.id === selectedId}
              onSelect={() => setSelectedId(s.id === selectedId ? null : s.id)}
              isAdmin={isAdmin}
              onEdit={() => setSequenceDialog({ sequence: s })}
            />
          ))}
        </div>
      )}

      {selected &&
        (enrollmentsQ.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : enrollmentsQ.isError ? (
          <EmptyState
            title="Erro ao carregar inscrições"
            description={enrollmentsQ.error.message}
            actionLabel="Tentar novamente"
            onAction={() => enrollmentsQ.refetch()}
          />
        ) : (
          <SequenceDetail sequence={selected} enrollments={selectedEnrollments} isAdmin={isAdmin} />
        ))}

      <SequenceFormDialog
        open={sequenceDialog !== null}
        sequence={sequenceDialog?.sequence ?? null}
        tenantId={profile?.tenant_id ?? null}
        onOpenChange={(open) => !open && setSequenceDialog(null)}
      />
    </div>
  );
}

// ─── Card da lista ──────────────────────────────────────────────────────────

function SequenceCard({
  row,
  activeCount,
  isSelected,
  onSelect,
  isAdmin,
  onEdit,
}: {
  row: NurtureSequenceRow;
  activeCount: number;
  isSelected: boolean;
  onSelect: () => void;
  isAdmin: boolean;
  onEdit: () => void;
}) {
  return (
    <Card className={isSelected ? "border-primary" : undefined}>
      <CardContent className="flex flex-wrap items-center gap-3 p-4">
        <button
          type="button"
          className="flex flex-1 flex-col items-start gap-1 text-left"
          onClick={onSelect}
          aria-expanded={isSelected}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-body font-medium text-foreground">{row.name}</span>
            <StatusBadge variant={row.is_active ? "success" : "neutral"}>
              {row.is_active ? "Ativa" : "Inativa"}
            </StatusBadge>
            <Badge variant="outline">{triggerLabels[row.trigger_type]}</Badge>
          </div>
          <span className="text-caption text-muted-foreground">
            {row.nurture_steps.length} passo(s) · {activeCount} inscrição(ões) ativa(s)
          </span>
        </button>
        {isAdmin && (
          <Button size="sm" variant="outline" onClick={onEdit}>
            <Pencil className="h-4 w-4" />
            Editar
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Detalhe: passos + inscrições ──────────────────────────────────────────

function SequenceDetail({
  sequence,
  enrollments,
  isAdmin,
}: {
  sequence: NurtureSequenceRow;
  enrollments: NurtureEnrollmentRow[];
  isAdmin: boolean;
}) {
  const [stepDialog, setStepDialog] = useState<{ step: NurtureStepRow | null } | null>(null);
  const [deletingStep, setDeletingStep] = useState<NurtureStepRow | null>(null);
  const deleteStepMut = useDeleteNurtureStep();

  const nextStepNumber = (sequence.nurture_steps.at(-1)?.step_number ?? 0) + 1;

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-4">
        <div className="text-card-title font-medium text-foreground">{sequence.name}</div>
        <Tabs defaultValue="passos" className="w-full">
          <TabsList>
            <TabsTrigger value="passos">Passos ({sequence.nurture_steps.length})</TabsTrigger>
            <TabsTrigger value="inscricoes">Inscrições ({enrollments.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="passos" className="flex flex-col gap-3">
            {isAdmin && (
              <Button
                size="sm"
                variant="outline"
                className="self-start"
                onClick={() => setStepDialog({ step: null })}
              >
                <Plus className="h-4 w-4" />
                Adicionar passo
              </Button>
            )}
            {sequence.nurture_steps.length === 0 ? (
              <EmptyState
                title="Nenhum passo configurado"
                description="Adicione o primeiro passo desta sequência."
              />
            ) : (
              <ul className="divide-y divide-border">
                {sequence.nurture_steps.map((step) => (
                  <li key={step.id} className="flex items-center gap-3 py-2">
                    <StatusBadge variant="neutral" showDot={false}>
                      #{step.step_number}
                    </StatusBadge>
                    <div className="min-w-0 flex-1">
                      <p className="text-body text-foreground">{step.message_template}</p>
                      <p className="text-caption text-muted-foreground">
                        {/* O passo 1 é a única exceção e a tela precisa dizer:
                            os gatilhos automáticos inscrevem com next_send_at =
                            now(), então o atraso configurado nele nunca é
                            respeitado — o envio sai na primeira janela de
                            atendimento depois da inscrição. */}
                        {step.step_number === 1
                          ? "Sai na primeira janela de atendimento após a inscrição"
                          : `Aguarda ${step.delay_hours}h após o passo anterior`}
                      </p>
                    </div>
                    {isAdmin && (
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Editar passo ${step.step_number}`}
                          onClick={() => setStepDialog({ step })}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Excluir passo ${step.step_number}`}
                          onClick={() => setDeletingStep(step)}
                        >
                          <Trash2 className="h-4 w-4 text-muted-foreground" />
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>

          <TabsContent value="inscricoes" className="flex flex-col gap-3">
            {enrollments.length === 0 ? (
              <EmptyState
                title="Nenhuma inscrição"
                description="Contatos inscritos nesta sequência aparecem aqui."
              />
            ) : (
              <ul className="divide-y divide-border">
                {enrollments.map((e) => (
                  <EnrollmentRow key={e.id} row={e} />
                ))}
              </ul>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>

      {isAdmin && (
        <StepFormDialog
          open={stepDialog !== null}
          step={stepDialog?.step ?? null}
          sequenceId={sequence.id}
          nextStepNumber={nextStepNumber}
          onOpenChange={(open) => !open && setStepDialog(null)}
        />
      )}

      {isAdmin && (
        <AlertDialog open={!!deletingStep} onOpenChange={(v) => !v && setDeletingStep(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Excluir passo</AlertDialogTitle>
              <AlertDialogDescription>
                Tem certeza que deseja excluir o passo #{deletingStep?.step_number}? Contatos já
                inscritos que já passaram deste ponto não são afetados.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button variant="ghost" onClick={() => setDeletingStep(null)}>
                Cancelar
              </Button>
              <Button
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                disabled={deleteStepMut.isPending}
                onClick={() =>
                  deletingStep &&
                  deleteStepMut.mutate(deletingStep.id, {
                    onSuccess: () => {
                      toast.success("Passo removido");
                      setDeletingStep(null);
                    },
                    onError: (e: Error) => toast.error(e.message || "Erro ao remover passo"),
                  })
                }
              >
                {deleteStepMut.isPending ? "Excluindo…" : "Excluir"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </Card>
  );
}

// Ação disponível por status corrente (a RPC set_nurture_enrollment_status
// rejeita transições ilegais -- ver supabase/migrations/
// 20260710140000_fase4_nurture_schema.sql linhas 232-260): pausar só a partir
// de active, reativar só a partir de paused, cancelar a partir de qualquer
// estado não-terminal. Não é ação admin-only -- a própria RPC só valida
// tenant, igual à ação operacional "Decisões" no AppSidebar.
function EnrollmentRow({ row }: { row: NurtureEnrollmentRow }) {
  const setStatusMut = useSetNurtureEnrollmentStatus();
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyQ = useNurtureExecutionHistory(row.id, historyOpen);

  const act = (status: SettableNurtureEnrollmentStatus, successMessage: string) => {
    setStatusMut.mutate(
      { enrollmentId: row.id, status },
      {
        onSuccess: () => toast.success(successMessage),
        onError: (e: Error) => toast.error(e.message || "Erro ao atualizar inscrição"),
      },
    );
  };

  return (
    <li className="flex flex-wrap items-center gap-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-body font-medium text-foreground">
          {row.contact?.name ?? "Contato removido"}
        </p>
        <p className="text-caption text-muted-foreground">
          {row.deal?.title ? `${row.deal.title} · ` : ""}Passo {row.current_step}
        </p>
        {row.status === "paused" ? (
          <p className="text-caption text-muted-foreground">Sem envio enquanto estiver pausada.</p>
        ) : row.status === "active" && row.next_send_at ? (
          <p className="text-caption text-muted-foreground">
            Próximo envio:{" "}
            <time dateTime={row.next_send_at}>{formatDateTime(row.next_send_at)}</time>
          </p>
        ) : row.completed_at ? (
          <p className="text-caption text-muted-foreground">
            Encerrada em <time dateTime={row.completed_at}>{formatDateTime(row.completed_at)}</time>
          </p>
        ) : null}
      </div>
      <StatusBadge variant={enrollmentStatusVariant[row.status]}>
        {enrollmentStatusLabel[row.status]}
      </StatusBadge>
      <div className="flex gap-1">
        <Button size="sm" variant="outline" onClick={() => setHistoryOpen(true)}>
          Histórico
        </Button>
        {row.status === "active" && (
          <Button
            size="sm"
            variant="outline"
            disabled={setStatusMut.isPending}
            onClick={() => act("paused", "Inscrição pausada")}
          >
            <Pause className="h-4 w-4" />
            Pausar
          </Button>
        )}
        {row.status === "paused" && (
          <Button
            size="sm"
            variant="outline"
            disabled={setStatusMut.isPending}
            onClick={() => act("active", "Inscrição reativada")}
          >
            <Play className="h-4 w-4" />
            Reativar
          </Button>
        )}
        {(row.status === "active" || row.status === "paused" || row.status === "sending") && (
          <Button
            size="sm"
            variant="ghost"
            disabled={setStatusMut.isPending}
            onClick={() => act("cancelled", "Inscrição cancelada")}
          >
            <XCircle className="h-4 w-4" />
            Cancelar
          </Button>
        )}
      </div>
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Histórico de acompanhamento</DialogTitle>
            <DialogDescription>
              {row.contact?.name ?? "Contato removido"}: até 100 execuções mais recentes desta
              inscrição.
            </DialogDescription>
          </DialogHeader>
          {historyQ.isLoading ? (
            <p role="status" className="text-body text-muted-foreground">
              Carregando execuções…
            </p>
          ) : historyQ.isError ? (
            <EmptyState
              title="Erro ao carregar histórico"
              description={historyQ.error.message}
              actionLabel="Tentar novamente"
              onAction={() => historyQ.refetch()}
            />
          ) : !historyQ.data?.length ? (
            <EmptyState
              title="Nenhuma execução registrada"
              description="O histórico começa na ativação deste recurso. Envios anteriores não são reconstruídos."
            />
          ) : (
            <ol className="max-h-96 overflow-y-auto divide-y divide-border">
              {historyQ.data.map((execution) => (
                <li key={execution.id} className="space-y-1 py-3">
                  <p className="text-body font-medium">
                    Passo {execution.step_number}: {executionOutcomeLabel[execution.outcome]}
                  </p>
                  <time
                    className="text-caption text-muted-foreground"
                    dateTime={execution.executed_at}
                    title={execution.executed_at}
                  >
                    {formatDateTime(execution.executed_at)}
                  </time>
                  {execution.detail && (
                    <p className="break-words text-caption text-muted-foreground">
                      {execution.detail}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          )}
        </DialogContent>
      </Dialog>
    </li>
  );
}

// ─── Diálogo de sequência (criar/editar) ────────────────────────────────────

const sequenceFormSchema = z
  .object({
    name: z.string().trim().min(1, "Nome é obrigatório"),
    triggerType: z.enum(["manual", "stage_change", "stagnant", "periodic", "won", "birthday"]),
    triggerStageId: z.string().trim(),
    stagnantDays: z.string().trim(),
    periodicDays: z.string().trim(),
    notifyOwner: z.boolean(),
  })
  .superRefine((data, ctx) => {
    // trigger_stage_id: o CHECK do banco só exige para stage_change, mas o
    // scanner (enroll_stagnant_and_periodic_nurture) também casa por
    // trigger_stage_id para 'stagnant' -- sem etapa, a sequence nunca inscreve
    // ninguém em silêncio. Exigir aqui é fail-fast (CLAUDE.md).
    if (
      (data.triggerType === "stage_change" || data.triggerType === "stagnant") &&
      !data.triggerStageId
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["triggerStageId"],
        message: "Etapa é obrigatória para este gatilho",
      });
    }
    if (data.triggerType === "stagnant" && !data.stagnantDays) {
      ctx.addIssue({
        code: "custom",
        path: ["stagnantDays"],
        message: "Obrigatório para o gatilho estagnado",
      });
    }
    if (data.triggerType === "periodic" && !data.periodicDays) {
      ctx.addIssue({
        code: "custom",
        path: ["periodicDays"],
        message: "Obrigatório para o gatilho periódico",
      });
    }
  });
type SequenceForm = z.infer<typeof sequenceFormSchema>;

function SequenceFormDialog({
  open,
  sequence,
  tenantId,
  onOpenChange,
}: {
  open: boolean;
  sequence: NurtureSequenceRow | null;
  tenantId: string | null;
  onOpenChange: (v: boolean) => void;
}) {
  const createMut = useCreateNurtureSequence();
  const updateMut = useUpdateNurtureSequence();
  const stagesQ = useBoardStagesForNurture();
  const stages = stagesQ.data ?? [];

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors },
  } = useForm<SequenceForm>({
    resolver: zodResolver(sequenceFormSchema),
    defaultValues: {
      name: "",
      triggerType: "manual",
      triggerStageId: "",
      stagnantDays: "",
      periodicDays: "",
      notifyOwner: false,
    },
  });

  // Mesmo cuidado de _app.templates.tsx: prefill só ao ABRIR, nunca a cada
  // render (reset() em `values` reexecutaria a cada keystroke).
  useEffect(() => {
    if (open) {
      reset({
        name: sequence?.name ?? "",
        triggerType: sequence?.trigger_type ?? "manual",
        triggerStageId: sequence?.trigger_stage_id ?? "",
        stagnantDays: sequence?.stagnant_days ? String(sequence.stagnant_days) : "",
        periodicDays: sequence?.periodic_days ? String(sequence.periodic_days) : "",
        notifyOwner: sequence?.notify_owner ?? false,
      });
    }
  }, [open, sequence, reset]);

  const triggerType = watch("triggerType");
  const triggerStageId = watch("triggerStageId");
  const notifyOwner = watch("notifyOwner");
  const isPending = createMut.isPending || updateMut.isPending;

  const submit = (data: SequenceForm) => {
    const shared = {
      name: data.name,
      triggerType: data.triggerType,
      triggerStageId: data.triggerStageId || null,
      stagnantDays: data.stagnantDays ? Number(data.stagnantDays) : null,
      periodicDays: data.periodicDays ? Number(data.periodicDays) : null,
      notifyOwner: data.notifyOwner,
    };

    if (sequence) {
      updateMut.mutate(
        { id: sequence.id, isActive: sequence.is_active, ...shared },
        {
          onSuccess: () => {
            toast.success("Sequência atualizada");
            onOpenChange(false);
          },
          onError: (e: Error) => toast.error(e.message || "Erro ao atualizar sequência"),
        },
      );
      return;
    }

    if (!tenantId) {
      toast.error("Sessão inválida");
      return;
    }
    createMut.mutate(
      { tenantId, ...shared },
      {
        onSuccess: () => {
          toast.success("Sequência criada");
          onOpenChange(false);
          reset();
        },
        onError: (e: Error) => toast.error(e.message || "Erro ao criar sequência"),
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
          <DialogTitle>{sequence ? `Editar ${sequence.name}` : "Nova sequência"}</DialogTitle>
          <DialogDescription>
            Configure o gatilho e as regras de inscrição automática.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(submit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="sequence-name">Nome *</Label>
            <Input id="sequence-name" {...register("name")} aria-invalid={!!errors.name} />
            {errors.name && <p className="text-caption text-destructive">{errors.name.message}</p>}
          </div>

          <div className="space-y-1.5">
            <Label>Gatilho *</Label>
            <Select
              value={triggerType}
              onValueChange={(v) => setValue("triggerType", v as NurtureTriggerType)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="manual">Manual</SelectItem>
                <SelectItem value="stage_change">Mudança de etapa</SelectItem>
                <SelectItem value="stagnant">Estagnado</SelectItem>
                <SelectItem value="periodic">Periódico</SelectItem>
                <SelectItem value="won">Negócio ganho</SelectItem>
                {/* Desabilitado, não removido: nenhum código processa
                    `trigger_type='birthday'`, então criar uma sequência assim
                    monta algo que nunca envia. O item continua na lista para
                    que uma sequência antiga com esse gatilho ainda apareça pelo
                    nome ao ser editada — removê-lo deixaria o campo em branco e
                    a edição travaria na validação. */}
                <SelectItem value="birthday" disabled>
                  Aniversário (indisponível)
                </SelectItem>
              </SelectContent>
            </Select>
            {triggerType === "birthday" && (
              <p className="text-caption text-muted-foreground">
                Este gatilho não dispara nada: o envio por aniversário ainda não foi implementado.
                Escolha outro gatilho para que a sequência funcione.
              </p>
            )}
          </div>

          {(triggerType === "stage_change" || triggerType === "stagnant") && (
            <div className="space-y-1.5">
              <Label>Etapa *</Label>
              <Select value={triggerStageId} onValueChange={(v) => setValue("triggerStageId", v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecione a etapa" />
                </SelectTrigger>
                <SelectContent>
                  {stages.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.triggerStageId && (
                <p className="text-caption text-destructive">{errors.triggerStageId.message}</p>
              )}
            </div>
          )}

          {triggerType === "stagnant" && (
            <div className="space-y-1.5">
              <Label htmlFor="stagnant-days">Dias parado *</Label>
              <Input
                id="stagnant-days"
                type="number"
                min={1}
                {...register("stagnantDays")}
                aria-invalid={!!errors.stagnantDays}
              />
              {errors.stagnantDays && (
                <p className="text-caption text-destructive">{errors.stagnantDays.message}</p>
              )}
            </div>
          )}

          {triggerType === "periodic" && (
            <div className="space-y-1.5">
              <Label htmlFor="periodic-days">Intervalo em dias *</Label>
              <Input
                id="periodic-days"
                type="number"
                min={1}
                {...register("periodicDays")}
                aria-invalid={!!errors.periodicDays}
              />
              {errors.periodicDays && (
                <p className="text-caption text-destructive">{errors.periodicDays.message}</p>
              )}
            </div>
          )}

          <label className="flex cursor-pointer items-center gap-2 text-body">
            <Checkbox
              checked={notifyOwner}
              onCheckedChange={(v) => setValue("notifyOwner", v === true)}
            />
            Notificar responsável do negócio
          </label>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Salvando…" : "Salvar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Diálogo de passo (criar/editar) ────────────────────────────────────────

const stepFormSchema = z.object({
  stepNumber: z.string().trim().min(1, "Obrigatório"),
  delayHours: z.string().trim().min(1, "Obrigatório"),
  messageTemplate: z.string().trim().min(1, "Mensagem é obrigatória"),
});
type StepForm = z.infer<typeof stepFormSchema>;

function StepFormDialog({
  open,
  step,
  sequenceId,
  nextStepNumber,
  onOpenChange,
}: {
  open: boolean;
  step: NurtureStepRow | null;
  sequenceId: string;
  nextStepNumber: number;
  onOpenChange: (v: boolean) => void;
}) {
  const createMut = useCreateNurtureStep();
  const updateMut = useUpdateNurtureStep();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<StepForm>({
    resolver: zodResolver(stepFormSchema),
    defaultValues: { stepNumber: String(nextStepNumber), delayHours: "24", messageTemplate: "" },
  });

  useEffect(() => {
    if (open) {
      reset({
        stepNumber: String(step?.step_number ?? nextStepNumber),
        delayHours: String(step?.delay_hours ?? 24),
        messageTemplate: step?.message_template ?? "",
      });
    }
  }, [open, step, nextStepNumber, reset]);

  const isPending = createMut.isPending || updateMut.isPending;

  const submit = (data: StepForm) => {
    const payload = {
      stepNumber: Number(data.stepNumber),
      delayHours: Number(data.delayHours),
      messageTemplate: data.messageTemplate,
    };
    if (step) {
      updateMut.mutate(
        { id: step.id, ...payload },
        {
          onSuccess: () => {
            toast.success("Passo atualizado");
            onOpenChange(false);
          },
          onError: (e: Error) => toast.error(e.message || "Erro ao atualizar passo"),
        },
      );
      return;
    }
    createMut.mutate(
      { sequenceId, ...payload },
      {
        onSuccess: () => {
          toast.success("Passo criado");
          onOpenChange(false);
          reset();
        },
        onError: (e: Error) => toast.error(e.message || "Erro ao criar passo"),
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{step ? `Editar passo #${step.step_number}` : "Novo passo"}</DialogTitle>
          <DialogDescription>Ordem e atraso são relativos ao passo anterior.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(submit)} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="step-number">Número *</Label>
              <Input
                id="step-number"
                type="number"
                min={1}
                {...register("stepNumber")}
                aria-invalid={!!errors.stepNumber}
              />
              {errors.stepNumber && (
                <p className="text-caption text-destructive">{errors.stepNumber.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="step-delay">Atraso (horas) *</Label>
              <Input
                id="step-delay"
                type="number"
                min={0}
                {...register("delayHours")}
                aria-invalid={!!errors.delayHours}
              />
              {errors.delayHours && (
                <p className="text-caption text-destructive">{errors.delayHours.message}</p>
              )}
              <p className="text-caption text-muted-foreground">
                Contado a partir do passo anterior. No passo 1 não se aplica: ele sai assim que a
                inscrição acontece, na primeira janela de atendimento.
              </p>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="step-message">Mensagem *</Label>
            <Textarea
              id="step-message"
              rows={4}
              {...register("messageTemplate")}
              aria-invalid={!!errors.messageTemplate}
            />
            {errors.messageTemplate && (
              <p className="text-caption text-destructive">{errors.messageTemplate.message}</p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Salvando…" : "Salvar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
