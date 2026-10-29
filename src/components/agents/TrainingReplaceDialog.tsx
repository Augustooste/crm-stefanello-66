// "Substituir" um treinamento que não é TEXT: o contrato só aceita `PUT` para
// TEXT (divergência D1), então para WEBSITE/VIDEO/DOCUMENT o único caminho é
// excluir e criar de novo — e isso só acontece após confirmação explícita do
// usuário, nesta tela, deixando claro o que vai acontecer.
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
import type { TrainingType } from "@/integrations/agent-platform/enums.gen";
import { TRAINING_TYPE_LABELS, type TrainingItem } from "@/components/agents/TrainingTypes";

interface TrainingReplaceDialogProps {
  agentId: string;
  type: TrainingType;
  training: TrainingItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Chamado após a exclusão ter sucesso — o chamador abre o formulário de criação. */
  onReplaced: () => void;
}

export function TrainingReplaceDialog({
  agentId,
  type,
  training,
  open,
  onOpenChange,
  onReplaced,
}: TrainingReplaceDialogProps) {
  const deleteMutation = useAgentPlatformMutation("training.delete", {
    invalidate: ["trainings.list"],
    onSuccess: () => {
      toast.success("Treinamento removido. Preencha os dados do novo treinamento.");
      onOpenChange(false);
      onReplaced();
    },
    onError: (error: AgentPlatformCallError) => toast.error(error.message),
  });

  function handleConfirm() {
    if (!training.id) {
      toast.error("Este treinamento não tem identificador — não é possível substituí-lo.");
      onOpenChange(false);
      return;
    }
    deleteMutation.mutate({ params: { agentId, trainingId: training.id } });
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Substituir treinamento de {TRAINING_TYPE_LABELS[type].toLowerCase()}
          </AlertDialogTitle>
          <AlertDialogDescription>
            O provedor de agentes não permite atualizar este tipo de treinamento — só o de texto.
            Para substituir, o CRM IA primeiro <strong>exclui definitivamente</strong> o treinamento
            atual e, na sequência, abre o formulário para você cadastrar o novo conteúdo. A exclusão
            não pode ser desfeita.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteMutation.isPending}>Cancelar</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm} disabled={deleteMutation.isPending}>
            Excluir e cadastrar novo
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
