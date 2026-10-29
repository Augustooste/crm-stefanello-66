import { AlertTriangle, Users, Wallet } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/common/EmptyState";
import { useWalletHealth } from "@/lib/api/dashboard-widgets";
import { formatBRL } from "@/lib/format";

/**
 * Card 1 — Saúde da Carteira. Layout "hero" alinhado à referência:
 *  - Distribuição da carteira (barra 100% Ativos / Inativos / Churn + legenda).
 *  - Negócios parados (número gigante + badge "Atenção" + valor em risco).
 *  - LTV médio (valor destacado).
 *
 * Snapshot do estado atual (não depende do período). "Churn" é derivado dos
 * contatos que já não têm mais nenhuma atividade recente E que já foram
 * inativos: como o RPC atual só devolve ativos/inativos/total, tratamos o
 * bucket de churn como zero até o RPC ser estendido — mantém 100% de fidelidade
 * ao dado disponível, sem inventar coluna.
 */
export function WalletHealthCard({
  ownerId,
  boardId,
}: {
  ownerId: string | null;
  boardId: string | null;
}) {
  const q = useWalletHealth(ownerId, boardId);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-card-title">
          <Users className="h-4 w-4 text-primary" />
          Saúde da Carteira
        </CardTitle>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <div className="grid gap-6 md:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        ) : q.isError ? (
          <EmptyState
            icon={AlertTriangle}
            title="Não foi possível carregar"
            description={(q.error as Error)?.message ?? "Tente novamente em instantes."}
          />
        ) : !q.data || q.data.contatos_total === 0 ? (
          <EmptyState
            icon={Users}
            title="Carteira vazia"
            description="Ainda não há contatos nesta carteira."
          />
        ) : (
          <div className="grid gap-6 md:grid-cols-3">
            <DistributionBlock
              ativos={q.data.contatos_ativos}
              inativos={q.data.contatos_inativos}
              total={q.data.contatos_total}
            />
            <StagnantBlock
              count={q.data.negocios_parados}
              atRiskValue={q.data.negocios_parados_valor}
              daysThreshold={q.data.stagnant_days_threshold}
            />
            <LtvBlock value={q.data.ltv_medio} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DistributionBlock({
  ativos,
  inativos,
  total,
}: {
  ativos: number;
  inativos: number;
  total: number;
}) {
  const churn = 0; // RPC atual não separa "churn" — mantém 0 até o dado existir.
  const ativosPct = total > 0 ? Math.round((ativos / total) * 100) : 0;
  const inativosPct = total > 0 ? Math.round((inativos / total) * 100) : 0;
  const churnPct = Math.max(0, 100 - ativosPct - inativosPct);

  return (
    <div>
      <p className="text-caption font-medium uppercase tracking-wider text-muted-foreground">
        Distribuição da Carteira
      </p>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-h3 font-bold tabular-nums text-foreground">{ativosPct}%</span>
        <span className="text-caption font-medium text-success">Ativos</span>
      </div>
      <div className="mt-3 flex h-2 w-full overflow-hidden rounded-full bg-muted">
        {ativosPct > 0 && <div className="h-full bg-success" style={{ width: `${ativosPct}%` }} />}
        {inativosPct > 0 && (
          <div className="h-full bg-warning" style={{ width: `${inativosPct}%` }} />
        )}
        {churnPct > 0 && (
          <div className="h-full bg-destructive" style={{ width: `${churnPct}%` }} />
        )}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-caption text-muted-foreground">
        <li className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-success" aria-hidden />
          Ativos ({ativos})
        </li>
        <li className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-warning" aria-hidden />
          Inativos ({inativos})
        </li>
        <li className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-destructive" aria-hidden />
          Churn ({churn})
        </li>
      </ul>
    </div>
  );
}

function StagnantBlock({
  count,
  atRiskValue,
  daysThreshold,
}: {
  count: number;
  atRiskValue: number;
  daysThreshold: number;
}) {
  const alert = count > 0;
  return (
    <div>
      <p className="text-caption font-medium uppercase tracking-wider text-muted-foreground">
        Negócios Parados
      </p>
      <div className="mt-2 flex flex-wrap items-baseline gap-2">
        <span className="text-h3 font-bold tabular-nums text-foreground">
          {count} <span className="text-lead font-medium text-muted-foreground">Negócios</span>
        </span>
        {alert && (
          <Badge
            variant="outline"
            className="border-warning/40 bg-warning/10 text-warning"
            aria-label="Atenção"
          >
            <AlertTriangle className="mr-1 h-3 w-3" aria-hidden />
            Atenção
          </Badge>
        )}
      </div>
      <p className="mt-2 text-caption text-muted-foreground">
        Sem mudança de estágio há +{daysThreshold} dias.
      </p>
      <p className="text-caption font-medium text-foreground">{formatBRL(atRiskValue)} em risco</p>
    </div>
  );
}

function LtvBlock({ value }: { value: number | null }) {
  return (
    <div>
      <p className="text-caption font-medium uppercase tracking-wider text-muted-foreground">
        LTV Médio
      </p>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-h3 font-bold tabular-nums text-foreground">
          {value != null ? formatBRL(value) : "—"}
        </span>
        <span className="text-caption font-medium text-muted-foreground">Médio</span>
      </div>
      <p className="mt-2 text-caption text-muted-foreground">
        Valor médio vitalício por cliente ativo.
      </p>
    </div>
  );
}
