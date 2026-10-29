import { useState } from "react";
import { toast } from "sonner";

import { EmptyState } from "@/components/common/EmptyState";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useRedeliver,
  useWebhookDeliveries,
  type WebhookDelivery,
  type WebhookDeliveryStatus,
} from "@/lib/api/developer";
import { errorText, formatDateTime } from "./format";

export const DELIVERIES_PAGE_SIZE = 50;

const STATUS_LABEL: Record<WebhookDeliveryStatus, string> = {
  pending: "Pendente",
  processing: "Enviando",
  delivered: "Entregue",
  dead_letter: "Falhou",
};
const STATUS_VARIANT: Record<
  WebhookDeliveryStatus,
  "success" | "warning" | "destructive" | "neutral"
> = { pending: "neutral", processing: "warning", delivered: "success", dead_letter: "destructive" };

export function WebhookDeliveriesDialog({
  endpointId,
  endpointUrl,
  open,
  onOpenChange,
}: {
  endpointId: string;
  endpointUrl: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Entregas do webhook</DialogTitle>
          <DialogDescription className="break-all">{endpointUrl}</DialogDescription>
        </DialogHeader>
        {open && <DeliveriesList endpointId={endpointId} />}
      </DialogContent>
    </Dialog>
  );
}

/** Cada página é uma query própria (offset); páginas anteriores seguem em cache e visíveis. */
function DeliveriesList({ endpointId }: { endpointId: string }) {
  const [pages, setPages] = useState(1);
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: pages }, (_, index) => (
        <DeliveriesPage
          key={index}
          endpointId={endpointId}
          page={index}
          isLast={index === pages - 1}
          onLoadMore={() => setPages((p) => p + 1)}
        />
      ))}
    </div>
  );
}

function DeliveriesPage({
  endpointId,
  page,
  isLast,
  onLoadMore,
}: {
  endpointId: string;
  page: number;
  isLast: boolean;
  onLoadMore: () => void;
}) {
  const q = useWebhookDeliveries(endpointId, {
    limit: DELIVERIES_PAGE_SIZE,
    offset: page * DELIVERIES_PAGE_SIZE,
  });
  const redeliver = useRedeliver();
  const rows = q.data ?? [];

  const resend = async (delivery: WebhookDelivery) => {
    try {
      await redeliver.mutateAsync(delivery.id);
      toast.success("Entrega reenfileirada.");
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  if (q.isLoading) {
    return (
      <div role="status" aria-label="Carregando entregas" className="flex flex-col gap-2">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  }
  if (q.error) {
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
          <span>{errorText(q.error)}</span>
          <Button variant="secondary" size="sm" onClick={() => void q.refetch()}>
            Tentar novamente
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (rows.length === 0 && page === 0) {
    return (
      <EmptyState
        title="Nenhuma entrega ainda"
        description="Use Enviar evento de teste para gerar a primeira."
      />
    );
  }

  return (
    <>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {rows.map((d) => (
          <li key={d.id} className="flex flex-wrap items-start justify-between gap-3 p-3">
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge variant={STATUS_VARIANT[d.status]}>
                  {STATUS_LABEL[d.status]}
                </StatusBadge>
                <span className="font-mono text-caption text-foreground">{d.event_type}</span>
              </div>
              <p className="text-caption text-muted-foreground">
                Tentativas: {d.attempts} de {d.max_attempts} · Resposta:{" "}
                {d.response_status ?? "sem resposta"} · {formatDateTime(d.created_at, "-")}
              </p>
              {d.last_error && (
                <p className="break-words text-caption text-destructive">{d.last_error}</p>
              )}
              {d.response_excerpt && <ResponseExcerpt text={d.response_excerpt} />}
            </div>
            {d.status === "dead_letter" && (
              <Button
                variant="outline"
                size="sm"
                disabled={redeliver.isPending}
                aria-label={`Reenviar entrega do evento ${d.event_type}`}
                onClick={() => void resend(d)}
              >
                Reenviar
              </Button>
            )}
          </li>
        ))}
      </ul>
      {isLast && rows.length === DELIVERIES_PAGE_SIZE && (
        <Button variant="secondary" onClick={onLoadMore} disabled={q.isFetching}>
          Carregar mais
        </Button>
      )}
    </>
  );
}

/** Texto puro (nunca HTML), truncado com expansão e rolagem. */
function ResponseExcerpt({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col items-start gap-1">
      <pre
        tabIndex={0}
        aria-label="Início da resposta do seu sistema"
        className={`max-w-full overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted p-2 font-mono text-caption text-foreground ${open ? "max-h-48" : "max-h-10"}`}
      >
        {text}
      </pre>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Mostrar menos da resposta" : "Mostrar mais da resposta"}
      </Button>
    </div>
  );
}
