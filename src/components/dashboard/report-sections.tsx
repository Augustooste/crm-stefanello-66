import { useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { Bot, Clock, Gem, MessageSquare, Users } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/common/EmptyState";
import { fetchAiInsights, useDashboardReport, type AiInsightsResponse } from "@/lib/api/reports";
import { useWalletHealth } from "@/lib/api/dashboard-widgets";
import { formatBRL } from "@/lib/format";
import {
  FunnelBars,
  KpiCardInner,
  MessagesPerDayChart,
  formatMinutes,
} from "@/components/dashboard/report-widgets";
import { InsightsCard } from "@/components/dashboard/insights-card";

/**
 * Seções agregadas do dashboard, alimentadas pelo RPC `dashboard_report`
 * (mesma fonte dos Relatórios). Admin-only: montado apenas para admins em
 * `_app.index.tsx`, então a query nunca roda para vendedores (role "agent").
 * Período = mês corrente, alinhado aos KPIs do topo ("deste mês").
 */
export function DashboardReportSections() {
  const { from, to } = useMemo(() => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    start.setHours(0, 0, 0, 0);
    return { from: start, to: now };
  }, []);

  const reportQ = useDashboardReport(from, to);
  const r = reportQ.data;
  // LTV vem do snapshot da carteira (não depende do período). Sem filtro de
  // responsável/quadro: mesma queryKey do WalletHealthCard sem filtro, então o
  // TanStack Query deduplica a chamada ao RPC dashboard_wallet_health.
  const walletQ = useWalletHealth(null, null);

  const insightsMut = useMutation<AiInsightsResponse, Error, { force?: boolean }>({
    mutationFn: ({ force }) => fetchAiInsights(from, to, force),
  });

  if (reportQ.isError) {
    return (
      <EmptyState
        title="Não foi possível carregar as métricas do mês"
        description="Tente novamente em instantes."
        actionLabel="Tentar novamente"
        onAction={() => reportQ.refetch()}
      />
    );
  }

  const loading = reportQ.isLoading || !r;
  const at = r?.atendimento;
  const cobertura =
    at && at.msgs_enviadas > 0 ? Math.round((at.msgs_ia / at.msgs_enviadas) * 100) : null;

  return (
    <div className="grid grid-cols-1 gap-6">
      {/* Performance de mensagens */}
      <section
        aria-label="Performance de mensagens"
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5"
      >
        {loading || !at ? (
          Array.from({ length: 5 }).map((_, i) => <KpiCardSkeleton key={i} />)
        ) : (
          <>
            <KpiCard
              icon={<Clock className="h-4 w-4" />}
              label="1ª resposta (média)"
              value={
                at.primeira_resposta_min == null ? "—" : formatMinutes(at.primeira_resposta_min)
              }
              hint="Do primeiro contato do lead até a resposta"
            />
            <KpiCard
              icon={<Bot className="h-4 w-4" />}
              label="Cobertura de IA"
              value={cobertura == null ? "—" : `${cobertura}%`}
              hint={`${at.msgs_ia} de ${at.msgs_enviadas} respostas foram da IA`}
            />
            <KpiCard
              icon={<MessageSquare className="h-4 w-4" />}
              label="Mensagens enviadas"
              value={String(at.msgs_enviadas)}
              hint={`${at.msgs_recebidas} recebidas no período`}
            />
            <KpiCard
              icon={<Users className="h-4 w-4" />}
              label="Transferidas para humano"
              value={String(at.handoff)}
              hint={`${at.conversas_novas} novas conversas no mês`}
            />
            {/* isPending (não isLoading): com o perfil ainda carregando a query
                fica desabilitada e o "—" de "sem negócios ganhos" seria falso. */}
            {walletQ.isPending ? (
              <KpiCardSkeleton />
            ) : (
              <KpiCard
                icon={<Gem className="h-4 w-4" />}
                label="LTV por cliente"
                {...ltvKpi(walletQ.isError, walletQ.data?.ltv_medio)}
              />
            )}
          </>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Mensagens por dia */}
        <Card>
          <CardHeader>
            <CardTitle className="text-card-title">Mensagens por dia</CardTitle>
          </CardHeader>
          <CardContent>
            {loading || !r ? (
              <Skeleton className="h-64 w-full" />
            ) : (
              <MessagesPerDayChart data={r.mensagens_por_dia} />
            )}
          </CardContent>
        </Card>

        {/* Saúde da carteira — funil */}
        <Card>
          <CardHeader>
            <CardTitle className="text-card-title">Saúde da carteira — funil</CardTitle>
          </CardHeader>
          <CardContent>
            {loading || !r ? <Skeleton className="h-40 w-full" /> : <FunnelBars stages={r.funil} />}
          </CardContent>
        </Card>
      </div>

      {/* Insights de IA — variante leve (top 3 + link para Relatórios) */}
      <InsightsCard
        state={
          insightsMut.isPending
            ? { kind: "loading" }
            : insightsMut.isError
              ? { kind: "error", message: insightsMut.error.message }
              : insightsMut.data
                ? { kind: "ready", data: insightsMut.data }
                : { kind: "idle" }
        }
        onAnalyze={(force) => insightsMut.mutate({ force })}
        maxItems={3}
      />
    </div>
  );
}

/**
 * Valor/dica do KPI de LTV. Erro do RPC vira "Indisponível" (nunca R$ 0) e
 * `ltv_medio` null significa que nenhum cliente tem negócio ganho ainda.
 */
function ltvKpi(isError: boolean, ltv: number | null | undefined) {
  if (isError) {
    return {
      value: "Indisponível",
      hint: "Não foi possível carregar o LTV. Tente novamente em instantes.",
    };
  }
  if (ltv == null) {
    return {
      value: "—",
      hint: "Ainda não há negócios ganhos para calcular o valor médio por cliente",
    };
  }
  return {
    value: formatBRL(ltv),
    hint: "Valor médio ganho por cliente ao longo do relacionamento",
  };
}

function KpiCard(props: { icon: React.ReactNode; label: string; value: string; hint: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <KpiCardInner {...props} />
      </CardContent>
    </Card>
  );
}

function KpiCardSkeleton() {
  return (
    <Card>
      <CardContent className="pt-6">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="mt-3 h-7 w-16" />
        <Skeleton className="mt-2 h-3 w-32" />
      </CardContent>
    </Card>
  );
}
