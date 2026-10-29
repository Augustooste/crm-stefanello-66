import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { ArrowRightCircle } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";

import { PageHeader } from "@/components/common/PageHeader";
import { EmptyState } from "@/components/common/EmptyState";
import { StatusBadge } from "@/components/common/StatusBadge";
import { formatDate } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useBoardStagesForBoard,
  useDecisionQueue,
  useResolveHitlDecision,
  useResolveStageAdvance,
  type BoardStageOption,
  type DecisionCategory,
  type HitlDecisionRow,
  type Priority,
  type QueueItem,
  type StageAdvanceRow,
  deriveStageAdvancePriority,
} from "@/hooks/use-decision-queue";

export const Route = createFileRoute("/_app/decisions")({
  head: () => ({
    meta: [
      { title: "Decisões" },
      {
        name: "description",
        content:
          "Fila única de sugestões da IA aguardando aprovação, edição, rejeição ou adiamento.",
      },
      { property: "og:title", content: "Decisões" },
      {
        property: "og:description",
        content:
          "Fila única de sugestões da IA aguardando aprovação, edição, rejeição ou adiamento.",
      },
      { property: "og:url", content: "https://aceleraflow.lovable.app/decisions" },
      { name: "twitter:title", content: "Decisões" },
      {
        name: "twitter:description",
        content:
          "Fila única de sugestões da IA aguardando aprovação, edição, rejeição ou adiamento.",
      },
    ],
    links: [{ rel: "canonical", href: "https://aceleraflow.lovable.app/decisions" }],
  }),
  component: DecisionsPage,
});

const categoryLabel: Record<DecisionCategory, string> = {
  follow_up: "Retorno",
  deadline: "Prazo",
  opportunity: "Oportunidade",
  risk: "Risco",
  routine: "Rotina",
};

const priorityLabel: Record<Priority, string> = {
  critical: "Crítica",
  high: "Alta",
  medium: "Média",
  low: "Baixa",
};

const priorityVariant: Record<Priority, "destructive" | "warning" | "neutral"> = {
  critical: "destructive",
  high: "warning",
  medium: "neutral",
  low: "neutral",
};

function DecisionsPage() {
  const { items, isLoading, isError, error, refetch } = useDecisionQueue();

  return (
    <div className="col-span-12 flex flex-col gap-4">
      <PageHeader
        title="Decisões"
        description="Sugestões da IA aguardando aprovação, edição, rejeição ou adiamento."
      />

      {isLoading ? (
        <>
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </>
      ) : isError ? (
        <EmptyState
          title="Erro ao carregar"
          description={(error as Error).message}
          actionLabel="Tentar novamente"
          onAction={() => refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState
          title="Nenhuma decisão pendente"
          description="Quando a IA sugerir uma ação, ela aparece aqui para revisão humana."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((item) => (
            <DecisionCard key={`${item.kind}:${item.id}`} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

function DecisionCard({ item }: { item: QueueItem }) {
  if (item.kind === "stage_advance") return <StageAdvanceCard row={item.row} />;
  return <HitlDecisionCard row={item.row} />;
}

// ─── Card: avanço de estágio (ai_pending_stage_advances) ───────────────────

function StageAdvanceCard({ row }: { row: StageAdvanceRow }) {
  const priority = deriveStageAdvancePriority(row.confidence);
  const stagesQ = useBoardStagesForBoard(row.deal?.board_id);
  const stagesById = useMemo(
    () => new Map((stagesQ.data ?? []).map((s) => [s.id, s.name] as const)),
    [stagesQ.data],
  );
  const [rejectOpen, setRejectOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const resolveMut = useResolveStageAdvance();

  const approve = (suggestedStageId?: string) => {
    resolveMut.mutate(
      { advanceId: row.id, action: "approve", suggestedStageId },
      {
        onSuccess: () => {
          toast.success("Avanço de estágio aprovado");
          setEditOpen(false);
        },
        onError: (e: Error) => toast.error(e.message || "Erro ao aprovar avanço de estágio"),
      },
    );
  };

  const reject = (reason: string) => {
    resolveMut.mutate(
      { advanceId: row.id, action: "reject", reason },
      {
        onSuccess: () => {
          toast.success("Avanço de estágio rejeitado");
          setRejectOpen(false);
        },
        onError: (e: Error) => toast.error(e.message || "Erro ao rejeitar avanço de estágio"),
      },
    );
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="gap-1">
            <ArrowRightCircle className="h-3.5 w-3.5" /> Avanço de estágio
          </Badge>
          <StatusBadge variant={priorityVariant[priority]}>{priorityLabel[priority]}</StatusBadge>
          <StatusBadge variant="neutral" showDot={false}>
            Confiança: {Math.round(Number(row.confidence) * 100)}%
          </StatusBadge>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-body text-foreground">
          {row.deal?.contact && (
            <Link
              to="/contatos/$id"
              params={{ id: row.deal.contact.id }}
              className="font-medium hover:underline"
            >
              {row.deal.contact.name}
            </Link>
          )}
          {row.deal && <span className="text-muted-foreground">{row.deal.title}</span>}
        </div>

        <p className="text-caption text-muted-foreground">
          {stagesById.get(row.current_stage_id) ?? "Estágio atual"}
          {" → "}
          {stagesById.get(row.suggested_stage_id) ?? "Estágio sugerido"}
        </p>

        <p className="text-body text-foreground">{row.reason}</p>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={resolveMut.isPending} onClick={() => approve()}>
            Aprovar
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={resolveMut.isPending}
            onClick={() => setEditOpen(true)}
          >
            Editar antes de aprovar
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={resolveMut.isPending}
            onClick={() => setRejectOpen(true)}
          >
            Rejeitar
          </Button>
        </div>
      </CardContent>

      <RejectDialog
        open={rejectOpen}
        onOpenChange={setRejectOpen}
        onConfirm={reject}
        pending={resolveMut.isPending}
      />
      <EditStageDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        stages={stagesQ.data ?? []}
        defaultStageId={row.suggested_stage_id}
        onConfirm={approve}
        pending={resolveMut.isPending}
      />
    </Card>
  );
}

function EditStageDialog({
  open,
  onOpenChange,
  stages,
  defaultStageId,
  onConfirm,
  pending,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  stages: BoardStageOption[];
  defaultStageId: string;
  onConfirm: (stageId: string) => void;
  pending: boolean;
}) {
  const [stageId, setStageId] = useState(defaultStageId);

  useEffect(() => {
    if (open) setStageId(defaultStageId);
  }, [open, defaultStageId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Editar antes de aprovar</DialogTitle>
          <DialogDescription>
            Escolha outro estágio de destino para este negócio antes de aprovar o avanço.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>Novo estágio</Label>
          <Select value={stageId} onValueChange={setStageId}>
            <SelectTrigger>
              <SelectValue placeholder="Selecionar…" />
            </SelectTrigger>
            <SelectContent>
              {stages.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button disabled={pending || !stageId} onClick={() => onConfirm(stageId)}>
            {pending ? "Aprovando…" : "Aprovar com este estágio"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Card: decisão genérica (hitl_decisions) ───────────────────────────────

function HitlDecisionCard({ row }: { row: HitlDecisionRow }) {
  const [rejectOpen, setRejectOpen] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const resolveMut = useResolveHitlDecision();

  const approve = () => {
    resolveMut.mutate(
      { decisionId: row.id, action: "approve" },
      {
        onSuccess: () => toast.success("Decisão aprovada"),
        onError: (e: Error) => toast.error(e.message || "Erro ao aprovar decisão"),
      },
    );
  };

  const reject = (reason: string) => {
    resolveMut.mutate(
      { decisionId: row.id, action: "reject", reason },
      {
        onSuccess: () => {
          toast.success("Decisão rejeitada");
          setRejectOpen(false);
        },
        onError: (e: Error) => toast.error(e.message || "Erro ao rejeitar decisão"),
      },
    );
  };

  const snooze = (snoozeUntil: string) => {
    resolveMut.mutate(
      { decisionId: row.id, action: "snooze", snoozeUntil },
      {
        onSuccess: () => {
          toast.success("Decisão adiada");
          setSnoozeOpen(false);
        },
        onError: (e: Error) => toast.error(e.message || "Erro ao adiar decisão"),
      },
    );
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{categoryLabel[row.category] ?? row.category}</Badge>
          <StatusBadge variant={priorityVariant[row.priority]}>
            {priorityLabel[row.priority]}
          </StatusBadge>
        </div>

        <div className="text-body font-medium text-foreground">{row.title}</div>

        {(row.contact || row.deal || row.activity) && (
          <div className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
            {row.contact && (
              <Link to="/contatos/$id" params={{ id: row.contact.id }} className="hover:underline">
                {row.contact.name}
              </Link>
            )}
            {row.deal && <span>{row.deal.title}</span>}
            {row.activity && <span>{row.activity.title}</span>}
          </div>
        )}

        {(row.reasoning || row.description) && (
          <p className="text-body text-foreground">{row.reasoning ?? row.description}</p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={resolveMut.isPending} onClick={approve}>
            Aprovar
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={resolveMut.isPending}
            onClick={() => setSnoozeOpen(true)}
          >
            Adiar
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={resolveMut.isPending}
            onClick={() => setRejectOpen(true)}
          >
            Rejeitar
          </Button>
        </div>
      </CardContent>

      <RejectDialog
        open={rejectOpen}
        onOpenChange={setRejectOpen}
        onConfirm={reject}
        pending={resolveMut.isPending}
      />
      <SnoozeDialog
        open={snoozeOpen}
        onOpenChange={setSnoozeOpen}
        onConfirm={snooze}
        pending={resolveMut.isPending}
      />
    </Card>
  );
}

function SnoozeDialog({
  open,
  onOpenChange,
  onConfirm,
  pending,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConfirm: (snoozeUntilIso: string) => void;
  pending: boolean;
}) {
  const [date, setDate] = useState<Date | undefined>(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d;
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Adiar decisão</DialogTitle>
          <DialogDescription>
            A decisão some da fila até a data escolhida, sem ser apagada — volta sozinha quando
            vencer.
          </DialogDescription>
        </DialogHeader>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" className="w-full justify-start font-normal">
              {date ? formatDate(date) : "Escolher…"}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto p-0 pointer-events-auto">
            <Calendar
              mode="single"
              selected={date}
              onSelect={(d) => d && setDate(d)}
              disabled={{ before: new Date() }}
              initialFocus
              locale={ptBR}
              className="p-3 pointer-events-auto"
            />
          </PopoverContent>
        </Popover>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button disabled={pending || !date} onClick={() => date && onConfirm(date.toISOString())}>
            {pending ? "Adiando…" : "Adiar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Diálogo de rejeição (compartilhado pelos dois tipos) ──────────────────
//
// Validação client-side com zod + react-hook-form: `handleSubmit` só chama
// `onConfirm` quando `reason` passa em `.trim().min(1)` -- um motivo vazio ou
// só com espaços nunca chega a disparar a RPC. A obrigatoriedade REAL (fail
// -closed) é reforçada de novo dentro de resolve_pending_stage_advance/
// resolve_hitl_decision no banco; esta validação é só UX, nunca a única
// barreira.
const rejectSchema = z.object({
  reason: z.string().trim().min(1, "Motivo é obrigatório"),
});
type RejectForm = z.infer<typeof rejectSchema>;

function RejectDialog({
  open,
  onOpenChange,
  onConfirm,
  pending,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConfirm: (reason: string) => void;
  pending: boolean;
}) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<RejectForm>({
    resolver: zodResolver(rejectSchema),
    defaultValues: { reason: "" },
  });

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
          <DialogTitle>Rejeitar sugestão</DialogTitle>
          <DialogDescription>
            Informe o motivo da rejeição — fica registrado na auditoria.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit((data) => onConfirm(data.reason))} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="reject-reason">Motivo *</Label>
            <Textarea
              id="reject-reason"
              rows={3}
              {...register("reason")}
              aria-invalid={!!errors.reason}
            />
            {errors.reason && (
              <p className="text-caption text-destructive">{errors.reason.message}</p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending ? "Rejeitando…" : "Rejeitar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
