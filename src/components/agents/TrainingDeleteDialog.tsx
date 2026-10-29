// Confirmação de exclusão de um treinamento — `DELETE /v2/training/{trainingId}`,
// sempre com AlertDialog (sem optimistic update: erro do provedor não pode
// aparecer como sucesso na tela).
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
import { type AgentPlatformCallError, useAgentPlatformMutation } from "@/lib/api/agent-platform";
import { trainingSummary, type TrainingItem } from "@/components/agents/TrainingTypes";

interface TrainingDeleteDialogProps {
  agentId: string;
  training: TrainingItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TrainingDeleteDialog({
  agentId,
  training,
  open,
  onOpenChange,
}: TrainingDeleteDialogProps) {
  const deleteMutation = useAgentPlatformMutation("training.delete", {
    invalidate: ["trainings.list"],
    onSuccess: () => {
      toast.success("Treinamento excluído.");
      onOpenChange(false);
    },
    onError: (error: AgentPlatformCallError) => toast.error(error.message),
  });

  function handleConfirm() {
    if (!training.id) {
      toast.error("Este treinamento não tem identificador — não é possível excluí-lo.");
      onOpenChange(false);
      return;
    }
    deleteMutation.mutate({ params: { agentId, trainingId: training.id } });
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Excluir treinamento?</AlertDialogTitle>
          <AlertDialogDescription>
            {trainingSummary(training)} será removido permanentemente do provedor de agentes. Essa
            ação não pode ser desfeita.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteMutation.isPending}>Cancelar</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm} disabled={deleteMutation.isPending}>
            Excluir
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
