import { useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, Coins, Power, PowerOff, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/common/EmptyState";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useAgentPlatformMutation, useAgentPlatformQuery } from "@/lib/api/agent-platform";
import { relativeFromNow } from "@/lib/format";
import { AGENT_TYPE_LABELS, COMMUNICATION_TYPE_LABELS } from "./agent-labels";
import type { AgentSessionStatus } from "./agent-session-status";
import { AgentSessionStatusContext, useSetAgentSessionStatus } from "./agent-session-status";

export function AgentSessionStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AgentSessionStatus>(null);
  return (
    <AgentSessionStatusContext.Provider value={{ status, setStatus }}>
      {children}
    </AgentSessionStatusContext.Provider>
  );
}

/** Resumo do agente: perfil, créditos gastos e ações Ativar/Inativar/Excluir. */
export function AgentOverviewTab({ agentId }: { agentId: string }) {
  const navigate = useNavigate();
  const setSessionStatus = useSetAgentSessionStatus();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const agentQuery = useAgentPlatformQuery("agent.get", { params: { agentId } });
  const creditsQuery = useAgentPlatformQuery("agent.creditsSpent", { params: { agentId } });

  const activateMut = useAgentPlatformMutation("agent.activate", {
    invalidate: ["agent.get"],
    onSuccess: () => {
      setSessionStatus("active");
      toast.success("Agente ativado.");
    },
    onError: (error) => toast.error(error.message),
  });

  const deactivateMut = useAgentPlatformMutation("agent.deactivate", {
    invalidate: ["agent.get"],
    onSuccess: () => {
      setSessionStatus("inactive");
      toast.success("Agente inativado.");
    },
    onError: (error) => toast.error(error.message),
  });

  const deleteMut = useAgentPlatformMutation("agent.delete", {
    invalidate: ["agents.list"],
    onSuccess: () => {
      toast.success("Agente excluído.");
      setConfirmDelete(false);
      void navigate({ to: "/agentes" });
    },
    onError: (error) => toast.error(error.message),
  });

  if (agentQuery.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (agentQuery.isError) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Erro ao carregar o agente"
        description={agentQuery.error?.message ?? "Não foi possível carregar o agente."}
        actionLabel="Tentar de novo"
        onAction={() => void agentQuery.refetch()}
      />
    );
  }

  const agent = agentQuery.data;
  const agentType = agent?.type;
  const communicationType = agent?.communicationType;
  const totalCredits = creditsQuery.data?.total;
  const lastLoadedAt = agentQuery.dataUpdatedAt
    ? relativeFromNow(new Date(agentQuery.dataUpdatedAt))
    : null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-card-title">Resumo do agente</CardTitle>
          {lastLoadedAt && (
            <span className="text-caption text-muted-foreground">Última carga: {lastLoadedAt}</span>
          )}
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-caption text-muted-foreground">Nome</dt>
              <dd className="text-body font-medium text-foreground">{agent?.name || "—"}</dd>
            </div>
            <div>
              <dt className="text-caption text-muted-foreground">Objetivo</dt>
              <dd className="text-body text-foreground">
                {agentType ? AGENT_TYPE_LABELS[agentType] : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-caption text-muted-foreground">Tipo de comunicação</dt>
              <dd className="text-body text-foreground">
                {communicationType ? COMMUNICATION_TYPE_LABELS[communicationType] : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-caption text-muted-foreground">Empresa ou produto</dt>
              <dd className="text-body text-foreground">{agent?.jobName || "—"}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-card-title">Créditos gastos</CardTitle>
        </CardHeader>
        <CardContent>
          {creditsQuery.isLoading ? (
            <Skeleton className="h-6 w-32" />
          ) : creditsQuery.isError ? (
            <p className="text-body text-muted-foreground">
              Não foi possível carregar os créditos gastos.
            </p>
          ) : (
            <p className="flex items-center gap-2 text-body text-foreground">
              <Coins className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              {totalCredits ?? 0} créditos gastos
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-card-title">Ações</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() => activateMut.mutate({ params: { agentId } })}
            disabled={activateMut.isPending}
          >
            <Power className="mr-1 h-4 w-4" />
            {activateMut.isPending ? "Ativando…" : "Ativar"}
          </Button>
          <Button
            variant="secondary"
            onClick={() => deactivateMut.mutate({ params: { agentId } })}
            disabled={deactivateMut.isPending}
          >
            <PowerOff className="mr-1 h-4 w-4" />
            {deactivateMut.isPending ? "Inativando…" : "Inativar"}
          </Button>
          <Button
            variant="destructive"
            aria-label="Excluir agente"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className="mr-1 h-4 w-4" />
            Excluir
          </Button>
        </CardContent>
      </Card>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir agente</AlertDialogTitle>
            <AlertDialogDescription>
              Tem certeza que deseja excluir <strong>{agent?.name || "este agente"}</strong>? Esta
              ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMut.mutate({ params: { agentId } })}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMut.isPending ? "Excluindo…" : "Excluir"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
