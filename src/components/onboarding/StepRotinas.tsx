import { AlertTriangle, CheckCircle2, Clock, Loader2, Pause, Play } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/common/StatusBadge";
import { userFacingErrorMessage } from "@/lib/integrations/friendly-errors";
import {
  useActivateScheduledJobs,
  usePauseScheduledJobs,
  useScheduledJobsStatus,
} from "@/lib/api/onboarding";

/**
 * Passo "Rotinas automáticas" da configuração inicial.
 *
 * As rotinas são globais e só o operador da plataforma pode ativar ou pausar.
 * Admins de tenant consultam o estado e podem concluir o wizard sem alterá-lo.
 * Sem credenciais no Vault, a ativação continua bloqueada para o operador.
 */
export function StepRotinas() {
  const status = useScheduledJobsStatus();
  const activate = useActivateScheduledJobs();
  const pause = usePauseScheduledJobs();

  const vaultMissing = status.data?.vault_missing ?? [];
  const vaultOk = !!status.data && vaultMissing.length === 0;
  const jobs = status.data?.jobs ?? [];
  const active = status.data?.active ?? 0;
  const busy = activate.isPending || pause.isPending;
  const canManage = status.data?.can_manage === true;

  const handleActivate = () =>
    activate.mutate(undefined, {
      onSuccess: (r) => toast.success(`Rotinas automáticas ligadas (${r.active} em operação).`),
      onError: (e) => toast.error(userFacingErrorMessage(e, "Não foi possível ativar as rotinas.")),
    });

  const handlePause = () =>
    pause.mutate(undefined, {
      onSuccess: () => toast.success("Rotinas automáticas pausadas."),
      onError: (e) => toast.error(userFacingErrorMessage(e, "Não foi possível pausar as rotinas.")),
    });

  if (status.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (status.isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-card-title">Rotinas automáticas</CardTitle>
          <CardDescription>
            Não foi possível consultar o estado das rotinas. Apenas administradores têm acesso a
            esta etapa — você pode pular e concluir depois.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-card-title flex items-center gap-2">
            <Clock className="h-4 w-4" aria-hidden />
            Rotinas automáticas
          </CardTitle>
          <CardDescription>
            São as tarefas que rodam sozinhas em segundo plano: sequências de nutrição, vigilância
            de SLA, reconexão de canais, fila de respostas da IA e o resumo semanal.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2 text-body">
            {active > 0 ? (
              <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
            ) : (
              <Pause className="h-4 w-4 text-muted-foreground" aria-hidden />
            )}
            <span className="tabular-nums">
              {active} de {status.data?.total ?? jobs.length} rotinas em operação
            </span>
          </div>

          {!vaultOk && (
            <div className="flex gap-3 rounded-md border border-warning/40 bg-warning/10 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
              <div className="space-y-1 text-caption">
                <p className="font-medium">Falta configurar o acesso interno do backend.</p>
                <p className="text-muted-foreground">
                  Enquanto as credenciais internas ({vaultMissing.join(", ")}) não estiverem
                  gravadas, ligar as rotinas só geraria erro a cada minuto. Peça ao suporte para
                  concluir esse passo e volte aqui — nada mais do CRM depende disso.
                </p>
              </div>
            </div>
          )}

          {canManage ? (
            <div className="flex flex-wrap gap-2">
              <Button onClick={handleActivate} disabled={!vaultOk || busy}>
                {activate.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Play className="mr-2 h-4 w-4" />
                )}
                Ativar rotinas
              </Button>
              <Button variant="outline" onClick={handlePause} disabled={busy || active === 0}>
                {pause.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Pause className="mr-2 h-4 w-4" />
                )}
                Pausar
              </Button>
            </div>
          ) : (
            <div className="space-y-1 text-caption">
              <p className="font-medium">Rotinas da plataforma são gerenciadas pelo operador.</p>
              <p className="text-muted-foreground">
                Você pode concluir a configuração do seu tenant sem alterar estas rotinas. Em
                ambientes novos, solicite ao responsável pelo banco o cadastro do operador.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-card-title">O que roda</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {jobs.length === 0 && (
            <p className="text-caption text-muted-foreground">Nenhuma rotina no catálogo.</p>
          )}
          {jobs.map((job) => (
            <div
              key={job.jobname}
              className="flex items-start justify-between gap-3 rounded-md border border-border p-3"
            >
              <div className="min-w-0">
                <p className="text-body font-medium">{job.jobname}</p>
                {job.note && <p className="text-caption text-muted-foreground">{job.note}</p>}
                <p className="text-caption text-muted-foreground tabular-nums">{job.schedule}</p>
              </div>
              <StatusBadge variant={job.active ? "success" : "neutral"}>
                {job.active ? "Ligada" : "Desligada"}
              </StatusBadge>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
