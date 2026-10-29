import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, CalendarClock, Plus } from "lucide-react";

import { PageHeader } from "@/components/common/PageHeader";
import { EmptyState } from "@/components/common/EmptyState";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { formatDateTime } from "@/lib/format";
import {
  useCancelTemplateSchedule,
  useTemplateSchedules,
  type TemplateScheduleRow,
  type TemplateScheduleStatus,
} from "@/hooks/use-template-schedules";
import { NovaCampanhaDialog } from "./NovaCampanhaDialog";
import { useScheduledJobsStatus } from "@/lib/api/onboarding";

/**
 * O disparo depende da rotina `template-schedule-runner` no pg_cron. A
 * migration liga no catálogo, mas cada banco só muda depois da reconciliação
 * (ativar rotinas). Sem este aviso, campanha ficava "Agendada" para sempre em
 * silêncio. Falha ao ler o status não gera aviso (não inventa problema).
 */
function useCampaignRunnerOff(): boolean {
  const jobsQ = useScheduledJobsStatus();
  const runner = jobsQ.data?.jobs.find((j) => j.jobname === "template-schedule-runner");
  return !!jobsQ.data && (!runner || !runner.active || jobsQ.data.vault_missing.length > 0);
}

const statusLabel: Record<TemplateScheduleStatus, string> = {
  pending: "Agendada",
  running: "Em execução",
  completed: "Concluída",
  failed: "Falhou",
};

const statusVariant: Record<
  TemplateScheduleStatus,
  "success" | "neutral" | "destructive" | "warning"
> = {
  pending: "neutral",
  running: "warning",
  completed: "success",
  failed: "destructive",
};

/**
 * Aba "Campanhas" de /templates -- lista os broadcasts (template_schedules) com
 * os contadores de template_schedule_executions. Gate de admin fica no
 * `beforeLoad` da rota (ver _app.templates.tsx).
 */
export function AgendamentosTab() {
  const schedulesQ = useTemplateSchedules();
  const [creating, setCreating] = useState(false);
  const runnerOff = useCampaignRunnerOff();

  // audience_filter guarda só o stage_id (uuid): mapa id -> nome de todos os
  // estágios visíveis ao tenant.
  const stagesQuery = useQuery({
    queryKey: ["campaign-stage-names"],
    queryFn: async () => {
      const { data, error } = await supabase.from("board_stages").select("id, name");
      if (error) throw error;
      return (data ?? []) as { id: string; name: string }[];
    },
  });

  const stageNameById = useMemo(
    () => new Map((stagesQuery.data ?? []).map((s) => [s.id, s.name] as const)),
    [stagesQuery.data],
  );

  const schedules = schedulesQ.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Campanhas"
        description="Reativação, recuperação, nutrição e recompra: um modelo aprovado para um público, agora ou agendado."
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            Nova campanha
          </Button>
        }
      />

      {runnerOff && (
        <p
          role="alert"
          className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-caption"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />O disparo automático de campanhas está
          desligado nesta conta. Campanhas criadas ficam aguardando até as rotinas automáticas serem
          ativadas em Configurações.
        </p>
      )}

      {schedulesQ.isLoading ? (
        <>
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </>
      ) : schedulesQ.isError ? (
        <EmptyState
          title="Erro ao carregar"
          description={(schedulesQ.error as Error).message}
          actionLabel="Tentar novamente"
          onAction={() => schedulesQ.refetch()}
        />
      ) : schedules.length === 0 ? (
        <EmptyState
          title="Nenhuma campanha ainda"
          description="Crie uma campanha para enviar um modelo aprovado a um público do CRM."
          actionLabel="Nova campanha"
          onAction={() => setCreating(true)}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {schedules.map((s) => (
            <ScheduleCard key={s.id} row={s} stageNameById={stageNameById} />
          ))}
        </div>
      )}

      <NovaCampanhaDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

function audienceSummary(row: TemplateScheduleRow, stageNameById: Map<string, string>): string[] {
  const parts: string[] = [];
  if (row.audience_filter.tags?.length) {
    parts.push(`Etiquetas: ${row.audience_filter.tags.join(", ")}`);
  }
  if (row.audience_filter.stage_id) {
    parts.push(`Estágio: ${stageNameById.get(row.audience_filter.stage_id) ?? "removido"}`);
  }
  for (const [key, value] of Object.entries(row.audience_filter.custom_field ?? {})) {
    parts.push(`${key}: ${value}`);
  }
  // Filtro vazio nunca envia (o runner marca a campanha como falha) -- não é
  // "todos os contatos".
  if (parts.length === 0) parts.push("Sem público definido");
  return parts;
}

function ScheduleCard({
  row,
  stageNameById,
}: {
  row: TemplateScheduleRow;
  stageNameById: Map<string, string>;
}) {
  const cancelMut = useCancelTemplateSchedule();
  const canCancel = row.status === "pending";
  const { stats } = row;

  const cancel = () => {
    cancelMut.mutate(row.id, {
      onSuccess: () => toast.success("Campanha cancelada"),
      onError: (e: Error) => toast.error(e.message || "Erro ao cancelar campanha"),
    });
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge variant={statusVariant[row.status]}>{statusLabel[row.status]}</StatusBadge>
          <span className="flex items-center gap-1 text-caption text-muted-foreground">
            <CalendarClock className="h-3.5 w-3.5" />
            {formatDateTime(row.scheduled_for)}
          </span>
        </div>

        <div className="text-body font-medium text-foreground">{row.name ?? row.template_name}</div>
        {row.name && (
          <p className="text-caption text-muted-foreground">Modelo: {row.template_name}</p>
        )}

        <div className="flex flex-wrap gap-1.5">
          {audienceSummary(row, stageNameById).map((part) => (
            <Badge key={part} variant="outline">
              {part}
            </Badge>
          ))}
        </div>

        <p className="text-caption text-muted-foreground">
          Público: {stats.total} · Pendentes: {stats.pending} · Enviados: {stats.sent} · Falhas:{" "}
          {stats.failed} · Suprimidos: {stats.suppressed}
        </p>

        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            size="sm"
            variant="outline"
            disabled={!canCancel || cancelMut.isPending}
            onClick={cancel}
          >
            {cancelMut.isPending ? "Cancelando…" : "Cancelar"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
