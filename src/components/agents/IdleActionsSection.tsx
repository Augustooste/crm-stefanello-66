// Ações de inatividade do agente.
//
// ACHADO D10 (CONTRACT_MATRIX.md): `DELETE /v2/agent/{agentId}/idle-actions`
// não recebe id de ação — a exclusão é do CONJUNTO inteiro. Por isso não há
// botão de excluir por item, só "Remover todas".
//
// ACHADO (fora de D1-D14): `workingHours` tem forma diferente no GET (objeto
// com `days[]` cheio de metadados) e no POST/PUT (array raso de dias) — ver
// comentário em `IdleActionsWorkingHoursEditor.tsx`.
import { useEffect, useState } from "react";
import { AlertTriangle, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

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
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/common/EmptyState";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  createDefaultWorkingDays,
  IdleActionsWorkingHoursEditor,
  type EditableWorkingDay,
} from "@/components/agents/IdleActionsWorkingHoursEditor";
import { useAgentPlatformMutation, useAgentPlatformQuery } from "@/lib/api/agent-platform";
import type { AgentPlatformIdleActions } from "@/lib/api/agent-platform-contract";

type RemoteAction = NonNullable<AgentPlatformIdleActions["actions"]>[number];

interface EditableAction {
  key: string;
  instructions: string;
  seconds: number;
  allowAllHours: boolean;
  workingDays: EditableWorkingDay[];
}

function toEditableAction(action: RemoteAction, index: number): EditableAction {
  const remoteByDay = new Map((action.workingHours?.days ?? []).map((d) => [d.dayWeek, d]));
  const workingDays = createDefaultWorkingDays().map((defaultDay) => {
    const remote = remoteByDay.get(defaultDay.dayWeek);
    if (!remote) return defaultDay;
    const hours = remote.hours ?? [];
    return {
      dayWeek: defaultDay.dayWeek,
      active: remote.active ?? false,
      hours:
        hours.length > 0
          ? hours.map((h) => ({ start: h.start ?? "", end: h.end ?? "" }))
          : [{ start: "", end: "" }],
    };
  });
  return {
    key: action.id ?? `existing-${index}`,
    instructions: action.instructions ?? "",
    seconds: action.seconds ?? 60,
    allowAllHours: action.allowAllHours ?? true,
    workingDays,
  };
}

function newEditableAction(): EditableAction {
  return {
    key: `novo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    instructions: "",
    seconds: 60,
    allowAllHours: true,
    workingDays: createDefaultWorkingDays(),
  };
}

export function IdleActionsSection({ agentId }: { agentId: string }) {
  const getQ = useAgentPlatformQuery("idleActions.get", { params: { agentId } });
  const [hydrated, setHydrated] = useState(false);
  const [existsOnServer, setExistsOnServer] = useState(false);
  const [actions, setActions] = useState<EditableAction[]>([]);
  const [finishSeconds, setFinishSeconds] = useState(0);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);

  useEffect(() => {
    if (getQ.data && !hydrated) {
      const remoteActions = getQ.data.actions ?? [];
      setActions(remoteActions.map(toEditableAction));
      setFinishSeconds(getQ.data.finishOn?.seconds ?? 0);
      setExistsOnServer(remoteActions.length > 0);
      setHydrated(true);
    }
  }, [getQ.data, hydrated]);

  const saveMut = useAgentPlatformMutation(
    existsOnServer ? "idleActions.update" : "idleActions.create",
    {
      invalidate: ["idleActions.get"],
      onSuccess: () => {
        toast.success("Ações de inatividade salvas");
        setExistsOnServer(true);
      },
      onError: (e) => toast.error(e.message),
    },
  );

  const deleteMut = useAgentPlatformMutation("idleActions.delete", {
    invalidate: ["idleActions.get"],
    onSuccess: () => {
      toast.success("Ações de inatividade removidas");
      setActions([]);
      setFinishSeconds(0);
      setExistsOnServer(false);
      setConfirmDeleteAll(false);
    },
    onError: (e) => toast.error(e.message),
  });

  function updateAction(key: string, patch: Partial<EditableAction>) {
    setActions((prev) => prev.map((a) => (a.key === key ? { ...a, ...patch } : a)));
  }

  function removeAction(key: string) {
    setActions((prev) => prev.filter((a) => a.key !== key));
  }

  function handleSave() {
    saveMut.mutate({
      params: { agentId },
      body: {
        actions: actions.map((a) => ({
          instructions: a.instructions,
          seconds: a.seconds,
          allowAllHours: a.allowAllHours,
          workingHours: a.allowAllHours
            ? undefined
            : a.workingDays
                .filter((d) => d.active)
                .map((d) => ({
                  dayWeek: d.dayWeek,
                  active: d.active,
                  hours: d.hours
                    .filter((h) => h.start && h.end)
                    .map((h) => ({ start: h.start, end: h.end })),
                })),
        })),
        finishOn: { seconds: finishSeconds },
      },
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        {/* O título já está no AccordionTrigger — aqui só a descrição, sem repetir o heading. */}
        <CardDescription>O que o agente faz quando o contato para de responder.</CardDescription>
        <Button
          variant="destructive"
          size="sm"
          disabled={!existsOnServer}
          onClick={() => setConfirmDeleteAll(true)}
        >
          <Trash2 className="mr-1 h-4 w-4" /> Remover todas
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {getQ.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : getQ.error ? (
          <EmptyState
            icon={AlertTriangle}
            title="Não foi possível carregar as ações de inatividade"
            description={getQ.error.message}
            actionLabel="Tentar de novo"
            onAction={() => getQ.refetch()}
          />
        ) : (
          <>
            <div className="max-w-xs space-y-1.5">
              <Label htmlFor="finish-seconds">Finalizar atendimento após (segundos)</Label>
              <Input
                id="finish-seconds"
                type="number"
                min={0}
                value={finishSeconds}
                onChange={(e) => setFinishSeconds(Number(e.target.value))}
              />
            </div>

            {actions.length === 0 ? (
              <p className="text-body text-muted-foreground">
                Nenhuma ação configurada ainda. Adicione uma abaixo.
              </p>
            ) : (
              <div className="space-y-4">
                {actions.map((a, i) => (
                  <div key={a.key} className="space-y-3 rounded-md border border-border p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-caption font-medium text-muted-foreground">
                        Ação {i + 1}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Remover ação ${i + 1}`}
                        onClick={() => removeAction(a.key)}
                      >
                        <Trash2 className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`action-${a.key}-instructions`}>Mensagem/instruções</Label>
                      <Textarea
                        id={`action-${a.key}-instructions`}
                        value={a.instructions}
                        onChange={(e) => updateAction(a.key, { instructions: e.target.value })}
                        rows={2}
                      />
                    </div>
                    <div className="max-w-xs space-y-1.5">
                      <Label htmlFor={`action-${a.key}-seconds`}>
                        Disparar após (segundos de inatividade)
                      </Label>
                      <Input
                        id={`action-${a.key}-seconds`}
                        type="number"
                        min={1}
                        value={a.seconds}
                        onChange={(e) => updateAction(a.key, { seconds: Number(e.target.value) })}
                      />
                    </div>
                    <label className="flex items-center gap-2 text-body text-foreground">
                      <Switch
                        checked={a.allowAllHours}
                        onCheckedChange={(v) => updateAction(a.key, { allowAllHours: v })}
                      />
                      Executar em qualquer horário
                    </label>
                    {!a.allowAllHours && (
                      <IdleActionsWorkingHoursEditor
                        days={a.workingDays}
                        idPrefix={a.key}
                        onChange={(workingDays) => updateAction(a.key, { workingDays })}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setActions((prev) => [...prev, newEditableAction()])}
              >
                <Plus className="mr-1 h-4 w-4" /> Adicionar ação
              </Button>
              <Button size="sm" disabled={saveMut.isPending} onClick={handleSave}>
                {saveMut.isPending ? "Salvando…" : "Salvar ações de inatividade"}
              </Button>
            </div>
          </>
        )}
      </CardContent>

      <AlertDialog open={confirmDeleteAll} onOpenChange={setConfirmDeleteAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover todas as ações de inatividade</AlertDialogTitle>
            <AlertDialogDescription>
              O provedor de agentes não permite excluir uma ação isolada: esta operação remove{" "}
              <strong>todo o conjunto</strong> de ações de inatividade configuradas para este
              agente, inclusive o tempo de finalização automática. Esta ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteMut.mutate({ params: { agentId } })}
            >
              {deleteMut.isPending ? "Removendo…" : "Confirmar remoção"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
