// Cria (solto ou já vinculado a este agente) ou renomeia um canal.
//
// `channels.create` (solto) e `channels.createForAgent` (já vinculado) são
// duas operações diferentes do contrato — o switch "Vincular a este agente
// agora" decide qual das duas mutations dispara, sem inventar um terceiro
// endpoint. Renomear reaproveita `channel.update`, sempre preservando o
// `agentId` atual do canal (renomear não deve desvincular).
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { CHANNEL_TYPES, type ChannelType } from "@/integrations/agent-platform/enums.gen";
import { useAgentPlatformMutation } from "@/lib/api/agent-platform";

import { CHANNEL_TYPE_LABELS, type NormalizedChannel } from "./channel-labels";

interface ChannelFormDialogProps {
  mode: "create" | "rename";
  agentId: string;
  channel?: NormalizedChannel;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ChannelFormDialog({
  mode,
  agentId,
  channel,
  open,
  onOpenChange,
}: ChannelFormDialogProps) {
  const [name, setName] = useState(channel?.name ?? "");
  const [type, setType] = useState<ChannelType>(channel?.type ?? CHANNEL_TYPES[1]);
  const [linkNow, setLinkNow] = useState(mode === "rename" ? channel?.agentId === agentId : true);

  // Reabrir o diálogo (outro canal, ou o mesmo depois de fechado) reinicia o
  // rascunho — sem isso, o nome do canal anterior vazaria pro próximo.
  useEffect(() => {
    if (!open) return;
    setName(channel?.name ?? "");
    setType(channel?.type ?? CHANNEL_TYPES[1]);
    setLinkNow(mode === "rename" ? channel?.agentId === agentId : true);
  }, [open, channel, mode, agentId]);

  const createLoose = useAgentPlatformMutation("channels.create", {
    invalidate: ["channels.list"],
    onSuccess: () => {
      toast.success("Canal criado.");
      onOpenChange(false);
    },
    onError: (error) => toast.error(error.message),
  });

  const createForAgent = useAgentPlatformMutation("channels.createForAgent", {
    invalidate: ["channels.list"],
    onSuccess: () => {
      toast.success("Canal criado e vinculado a este agente.");
      onOpenChange(false);
    },
    onError: (error) => toast.error(error.message),
  });

  const rename = useAgentPlatformMutation("channel.update", {
    invalidate: ["channels.list"],
    onSuccess: () => {
      toast.success("Canal atualizado.");
      onOpenChange(false);
    },
    onError: (error) => toast.error(error.message),
  });

  const pending = createLoose.isPending || createForAgent.isPending || rename.isPending;

  function handleSubmit() {
    const trimmed = name.trim();
    if (!trimmed) return;

    if (mode === "rename") {
      if (!channel) return;
      rename.mutate({
        params: { channelId: channel.id },
        body: { name: trimmed, agentId: channel.agentId },
      });
      return;
    }

    if (linkNow) {
      createForAgent.mutate({ params: { agentId, type }, body: { name: trimmed } });
    } else {
      createLoose.mutate({ params: {}, body: { name: trimmed, type } });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "Novo canal" : `Renomear ${channel?.name}`}
          </DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "Escolha o tipo e um nome para o canal."
              : "Só o nome muda aqui — o vínculo com agente não é alterado."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="channel-name">Nome *</Label>
            <Input
              id="channel-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Ex.: WhatsApp comercial"
              autoFocus
            />
          </div>

          {mode === "create" && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="channel-type">Tipo *</Label>
                <Select value={type} onValueChange={(value) => setType(value as ChannelType)}>
                  <SelectTrigger id="channel-type" aria-label="Tipo">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CHANNEL_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {CHANNEL_TYPE_LABELS[t]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <label className="flex items-center gap-2 text-body text-foreground">
                <Switch checked={linkNow} onCheckedChange={setLinkNow} />
                Vincular a este agente agora
              </label>
            </>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={handleSubmit} disabled={pending || !name.trim()}>
            {pending ? "Salvando…" : mode === "rename" ? "Salvar" : "Criar canal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
