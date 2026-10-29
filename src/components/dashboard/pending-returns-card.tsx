import { Link } from "@tanstack/react-router";
import { CalendarClock } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/common/EmptyState";
import { usePendingReturns, type PendingReturn } from "@/lib/api/dashboard-widgets";
import { formatDateTime, relativeFromNow } from "@/lib/format";

/**
 * Card 4 — Retornos Pendentes. Sem RPC dedicada (2 selects client-side com
 * RLS, tenant-scoped por policy) -- mesma decisão do medflow-v0
 * (PendingReturnsCard: union de activities + deal_followups, horizonte de
 * 14 dias), adaptado sem API route Next (aceleraflow é 100% client +
 * edge functions).
 */
export function PendingReturnsCard({
  ownerId,
  boardId,
}: {
  ownerId: string | null;
  boardId: string | null;
}) {
  const q = usePendingReturns(ownerId, boardId);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-card-title">Retornos pendentes</CardTitle>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : q.isError ? (
          <EmptyState
            icon={CalendarClock}
            title="Não foi possível carregar"
            description={(q.error as Error)?.message ?? "Tente novamente em instantes."}
          />
        ) : (q.data?.length ?? 0) === 0 ? (
          <EmptyState
            icon={CalendarClock}
            title="Nenhum retorno pendente"
            description="Todos os retornos e tarefas agendadas nos próximos 14 dias estão em dia."
          />
        ) : (
          <ul className="divide-y divide-border">
            {q.data!.map((item) => (
              <PendingReturnRow key={`${item.kind}-${item.id}`} item={item} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function PendingReturnRow({ item }: { item: PendingReturn }) {
  const content = (
    <div className="flex min-w-0 flex-1 items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-body font-medium text-foreground">{item.title}</p>
        <p className="text-caption text-muted-foreground">{formatDateTime(item.scheduledAt)}</p>
      </div>
      <Badge variant={item.overdue ? "destructive" : "secondary"}>
        {item.overdue ? "Vencido" : relativeFromNow(item.scheduledAt)}
      </Badge>
    </div>
  );

  if (!item.contactId) return <li>{content}</li>;

  return (
    <li>
      <Link to="/contatos/$id" params={{ id: item.contactId }} className="block hover:bg-accent/60">
        {content}
      </Link>
    </li>
  );
}
