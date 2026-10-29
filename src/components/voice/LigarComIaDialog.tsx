import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CALL_STATUS_LABEL } from "@/lib/contact-timeline";
import {
  TERMINAL_CALL_STATUSES,
  useCancelVoiceCall,
  useStartVoiceCall,
  useVoiceCall,
} from "@/lib/api/voice-calls";

const NO_DEAL = "none";

export interface LigarComIaDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact: { id: string; name: string; phone: string | null };
  deals: { id: string; title: string }[];
}

/**
 * "Ligar com IA": mostra telefone e agente, pede o objetivo, confirma e
 * acompanha o status. A execução real acontece no Voice Service; aqui só o
 * pedido (edge function voice-calls) e a leitura de voice_calls.
 */
export function LigarComIaDialog({ open, onOpenChange, contact, deals }: LigarComIaDialogProps) {
  const [objective, setObjective] = useState("");
  const [dealId, setDealId] = useState(NO_DEAL);
  const [callId, setCallId] = useState<string | null>(null);
  // Uma chave por abertura do diálogo: clique duplo ou retry não disca duas vezes.
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const startMut = useStartVoiceCall();
  const cancelMut = useCancelVoiceCall();
  const callQ = useVoiceCall(callId);

  useEffect(() => {
    if (!open) return;
    setObjective("");
    setDealId(NO_DEAL);
    setCallId(null);
    setIdempotencyKey(crypto.randomUUID());
  }, [open]);

  const call = callQ.data ?? null;
  const active = !!call && !TERMINAL_CALL_STATUSES.has(call.status);
  const canStart = !!contact.phone && objective.trim().length >= 3 && !startMut.isPending;

  const start = () => {
    startMut.mutate(
      {
        contactId: contact.id,
        dealId: dealId === NO_DEAL ? null : dealId,
        objective: objective.trim(),
        idempotencyKey,
      },
      {
        onSuccess: (res) => setCallId(res.call_id),
        onError: (e: Error) => toast.error(e.message),
      },
    );
  };

  const cancel = () => {
    if (!callId) return;
    cancelMut.mutate(callId, { onError: (e: Error) => toast.error(e.message) });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Ligar com IA</DialogTitle>
          <DialogDescription>
            O agente de voz liga para {contact.name} e registra resumo e resultado no CRM.
          </DialogDescription>
        </DialogHeader>

        {!callId ? (
          <div className="space-y-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border p-3 text-body">
              <dt className="text-muted-foreground">Telefone</dt>
              <dd>{contact.phone ?? "Sem telefone cadastrado"}</dd>
              <dt className="text-muted-foreground">Agente</dt>
              <dd>Agente de voz padrão da empresa</dd>
            </dl>
            {deals.length > 0 && (
              <div className="space-y-1.5">
                <Label htmlFor="voice-deal">Negócio relacionado</Label>
                <Select value={dealId} onValueChange={setDealId}>
                  <SelectTrigger id="voice-deal">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_DEAL}>Nenhum</SelectItem>
                    {deals.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="voice-objective">Objetivo da ligação *</Label>
              <Textarea
                id="voice-objective"
                rows={3}
                placeholder="ex.: confirmar interesse no plano anual e agendar uma conversa"
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
              />
            </div>
            <p className="text-caption text-muted-foreground">
              O agente recebe só o primeiro nome, o negócio e as últimas mensagens. O resultado não
              move o negócio de etapa.
            </p>
          </div>
        ) : (
          <div className="space-y-2" aria-live="polite">
            <p className="text-body">
              Status:{" "}
              <strong>
                {call ? (CALL_STATUS_LABEL[call.status] ?? call.status) : "Iniciando"}
              </strong>
              {call?.is_simulation ? " (simulação)" : ""}
            </p>
            {call?.error_message && (
              <p className="text-caption text-muted-foreground">{call.error_message}</p>
            )}
            {call?.status === "completed" && (
              <p className="text-caption text-muted-foreground">
                Resumo e transcrição ficam na linha do tempo do contato.
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {!callId ? (
            <>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancelar
              </Button>
              <Button type="button" disabled={!canStart} onClick={start}>
                {startMut.isPending ? "Iniciando…" : "Confirmar e ligar"}
              </Button>
            </>
          ) : (
            <>
              {active && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={cancelMut.isPending}
                  onClick={cancel}
                >
                  Encerrar ligação
                </Button>
              )}
              <Button type="button" onClick={() => onOpenChange(false)}>
                Fechar
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
