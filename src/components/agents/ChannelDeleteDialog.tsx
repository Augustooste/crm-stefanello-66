// Confirmação de exclusão de canal — `DELETE /v2/channel/{channelId}`, sempre
// com AlertDialog e sem optimistic update (erro do provedor não pode aparecer
// como sucesso na tela).
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
import { useAgentPlatformMutation } from "@/lib/api/agent-platform";

import type { NormalizedChannel } from "./channel-labels";

interface ChannelDeleteDialogProps {
  channel: NormalizedChannel;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ChannelDeleteDialog({ channel, open, onOpenChange }: ChannelDeleteDialogProps) {
  const deleteMutation = useAgentPlatformMutation("channel.delete", {
    invalidate: ["channels.list"],
    onSuccess: () => {
      toast.success("Canal excluído.");
      onOpenChange(false);
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Excluir canal?</AlertDialogTitle>
          <AlertDialogDescription>
            O canal <strong>{channel.name}</strong> será removido permanentemente do provedor de
            agentes. Essa ação não pode ser desfeita.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteMutation.isPending}>Cancelar</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => deleteMutation.mutate({ params: { channelId: channel.id } })}
            disabled={deleteMutation.isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Excluir
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
