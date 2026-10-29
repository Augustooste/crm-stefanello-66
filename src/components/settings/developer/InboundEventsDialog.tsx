import { useState } from "react";
import { Link } from "@tanstack/react-router";

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
  INBOUND_EVENTS_MAX_ROWS,
  INBOUND_EVENTS_PAGE_SIZE,
  useInboundEvents,
  type InboundAction,
  type InboundEventStatus,
} from "@/lib/api/inbound-rules";
import { errorText, formatDateTime } from "./format";
import { ACTION_LABEL, EVENT_STATUS_LABEL } from "./inbound-rule-form";

/** O hook trava o offset em 150: passar de 4 páginas repetiria a última. */
const MAX_PAGES = INBOUND_EVENTS_MAX_ROWS / INBOUND_EVENTS_PAGE_SIZE;

const STATUS_VARIANT: Record<
  InboundEventStatus,
  "success" | "warning" | "destructive" | "neutral"
> = {
  processing: "neutral",
  processed: "success",
  ignored: "neutral",
  not_found: "warning",
  ambiguous: "warning",
  rate_limited: "warning",
  failed: "destructive",
};
const ERROR_LABEL: Record<string, string> = {
  deal_not_open: "negócio já fechado",
  already_in_stage: "negócio já estava na etapa",
  minute_limit: "limite por minuto",
  daily_limit: "limite diário (regra pausada)",
  conflict: "negócio mudou ao mesmo tempo",
};

function actionLabel(action: string | null): string {
  if (!action) return "Nenhuma ação";
  return ACTION_LABEL[action as InboundAction] ?? action;
}

/** Reenvio do mesmo evento pelo gateway: não repete a ação, só fica registrado (v2.1). */
function duplicateText(count: number, lastAt: string | null): string {
  const times = `Reenviado ${count} ${count === 1 ? "vez" : "vezes"}`;
  return lastAt ? `${times} (último em ${formatDateTime(lastAt, "-")})` : times;
}

/** Motivo da perda gravado em extracted.reason (ação Marcar como perdido). */
function extractedReason(extracted: unknown): string | null {
  if (typeof extracted !== "object" || extracted === null) return null;
  const reason = (extracted as { reason?: unknown }).reason;
  return typeof reason === "string" && reason.trim() ? reason : null;
}

/** Histórico de uma regra: só valores do resultado, nunca o corpo recebido. */
export function InboundEventsDialog({
  ruleId,
  ruleName,
  open,
  onOpenChange,
}: {
  ruleId: string;
  ruleName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl grid-cols-[minmax(0,1fr)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Histórico da regra</DialogTitle>
          <DialogDescription>
            {ruleName}. Eventos guardados por 90 dias, sem o corpo recebido.
          </DialogDescription>
        </DialogHeader>
        {open && <EventsList ruleId={ruleId} />}
      </DialogContent>
    </Dialog>
  );
}

function EventsList({ ruleId }: { ruleId: string }) {
  const [pages, setPages] = useState(1);
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: pages }, (_, index) => (
        <EventsPage
          key={index}
          ruleId={ruleId}
          page={index}
          isLast={index === pages - 1}
          canLoadMore={pages < MAX_PAGES}
          onLoadMore={() => setPages((p) => Math.min(p + 1, MAX_PAGES))}
        />
      ))}
    </div>
  );
}

function EventsPage({
  ruleId,
  page,
  isLast,
  canLoadMore,
  onLoadMore,
}: {
  ruleId: string;
  page: number;
  isLast: boolean;
  canLoadMore: boolean;
  onLoadMore: () => void;
}) {
  const q = useInboundEvents(ruleId, { offset: page * INBOUND_EVENTS_PAGE_SIZE });
  const rows = q.data ?? [];

  if (q.isLoading) {
    return (
      <div role="status" aria-label="Carregando eventos" className="flex flex-col gap-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
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
        title="Nenhum evento ainda"
        description="Os eventos aparecem aqui quando o gateway chamar a URL da regra."
      />
    );
  }
  const full = rows.length === INBOUND_EVENTS_PAGE_SIZE;

  return (
    <>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {rows.map((e) => {
          const reason = extractedReason(e.extracted);
          return (
            <li key={e.id} className="flex flex-wrap items-start justify-between gap-3 p-3">
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge variant={STATUS_VARIANT[e.status]}>
                    {EVENT_STATUS_LABEL[e.status]}
                  </StatusBadge>
                  <span className="text-caption text-foreground">{actionLabel(e.actionTaken)}</span>
                </div>
                <p className="text-caption text-muted-foreground">
                  {formatDateTime(e.receivedAt, "-")} · Evento{" "}
                  <span className="break-all font-mono">{e.externalEventId}</span>
                  {e.attempts > 1 && ` · ${e.attempts} tentativas`}
                </p>
                {e.duplicateCount > 0 && (
                  <p className="break-words text-caption text-muted-foreground">
                    {duplicateText(e.duplicateCount, e.lastDuplicateAt)}
                  </p>
                )}
                {reason && (
                  <p className="break-words text-caption text-muted-foreground">
                    Motivo da perda: {reason}
                  </p>
                )}
                {e.errorCode && (
                  <p className="text-caption text-muted-foreground">
                    Código: <span className="font-mono">{e.errorCode}</span>
                    {ERROR_LABEL[e.errorCode] && ` (${ERROR_LABEL[e.errorCode]})`}
                  </p>
                )}
              </div>
              {e.dealId && (
                <Link
                  to="/pipeline"
                  search={{ dealId: e.dealId }}
                  className="text-caption text-primary underline underline-offset-4"
                >
                  Abrir negócio
                </Link>
              )}
            </li>
          );
        })}
      </ul>
      {isLast && full && canLoadMore && (
        <Button variant="secondary" onClick={onLoadMore} disabled={q.isFetching}>
          Carregar mais
        </Button>
      )}
      {isLast && full && !canLoadMore && (
        <p className="text-caption text-muted-foreground">
          Mostrando o limite de 200 eventos mais recentes.
        </p>
      )}
    </>
  );
}
