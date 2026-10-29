// Diálogo de QR Code — `GET /v2/channel/{channelId}/qr-code`, resposta
// `oneOf`: `{value}` (aguardando leitura) ou `{connected}` (já conectado).
// Faz polling enquanto aguarda e para sozinho ao conectar ou ao dar erro —
// `qrRefetchInterval` é a decisão pura, testada isolada (sem depender de
// timer real disparando dentro do react-query).
import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, QrCode as QrCodeIcon, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAgentPlatformQuery } from "@/lib/api/agent-platform";
import { qrRefetchInterval } from "./channel-qr-code-utils";

interface ChannelQrCodeDialogProps {
  channelId: string;
  channelName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Disparado uma única vez, na transição para conectado — o pai decide o
   * que atualizar (ex.: refazer a listagem de canais). */
  onConnected?: () => void;
}

export function ChannelQrCodeDialog({
  channelId,
  channelName,
  open,
  onOpenChange,
  onConnected,
}: ChannelQrCodeDialogProps) {
  // `useAgentPlatformQuery` só aceita `refetchInterval` como `number | false`
  // estático (não uma função do último dado, que é o que precisaríamos pra
  // parar de pollar só quando `connected`). Por isso o polling automático do
  // hook fica desligado (`false`) e é feito manualmente abaixo, guiado por
  // `qrRefetchInterval`.
  const qrQuery = useAgentPlatformQuery(
    "channel.qrCode",
    { params: { channelId } },
    { enabled: open, refetchInterval: false },
  );
  const interval = qrRefetchInterval(qrQuery.data, qrQuery.isError);
  const connected = !!(qrQuery.data && "connected" in qrQuery.data && qrQuery.data.connected);
  const value = qrQuery.data && "value" in qrQuery.data ? qrQuery.data.value : undefined;

  useEffect(() => {
    if (!open || interval === false) return;
    const id = setInterval(() => void qrQuery.refetch(), interval);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `refetch` continua válido mesmo se a referência mudar entre renders; o gatilho real de reiniciar/parar é `interval`
  }, [open, interval]);

  useNotifyConnected(connected, onConnected);

  function handleRegenerate() {
    void qrQuery.refetch();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <QrCodeIcon className="h-5 w-5" aria-hidden />
            QR Code — {channelName}
          </DialogTitle>
          <DialogDescription>
            Escaneie o código no aplicativo para conectar este canal.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-3 py-2">
          {qrQuery.isLoading ? (
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-hidden />
          ) : qrQuery.isError ? (
            <div className="flex flex-col items-center gap-2 text-center">
              <AlertCircle className="h-8 w-8 text-destructive" aria-hidden />
              <p className="text-caption text-destructive">{qrQuery.error?.message}</p>
            </div>
          ) : connected ? (
            <div
              className="flex flex-col items-center gap-2 text-center"
              data-testid="qr-connected"
            >
              <CheckCircle2 className="h-8 w-8 text-success" aria-hidden />
              <p className="text-body font-medium text-foreground">Canal conectado.</p>
            </div>
          ) : value ? (
            <img
              src={value.startsWith("data:") ? value : `data:image/png;base64,${value}`}
              alt={`QR Code para conectar ${channelName}`}
              className="h-56 w-56 rounded-md border border-border"
              data-testid="qr-code-image"
            />
          ) : (
            <p className="text-caption text-muted-foreground">Aguardando QR Code…</p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={handleRegenerate}>
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden />
            Gerar novo QR Code
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Chama `onConnected` uma vez por trecho em que `connected` fica true —
 * inclusive se o diálogo já abrir com o canal já conectado (o diálogo é
 * desmontado ao fechar, então "uma vez" vale por montagem, não pra sempre).
 * Repetir a notificação aqui é barato: o pai só usa isso pra revalidar a
 * listagem de canais. */
function useNotifyConnected(connected: boolean, onConnected?: () => void): void {
  const [notified, setNotified] = useState(false);
  useEffect(() => {
    if (connected && !notified) {
      setNotified(true);
      onConnected?.();
    }
    if (!connected && notified) setNotified(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onConnected pode ser uma closure nova a cada render do pai
  }, [connected, notified]);
}
