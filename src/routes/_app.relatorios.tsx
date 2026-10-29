import { useEffect, useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  ArrowDownRight,
  ArrowUpRight,
  Bot,
  Clock,
  MessageSquare,
  Trophy,
  TrendingUp,
} from "lucide-react";

import { PageHeader } from "@/components/common/PageHeader";
import { AiInsightsHealthBanner } from "@/components/relatorios/AiInsightsHealthBanner";
import {
  FunnelBars,
  MessagesPerDayChart,
  ResultRow,
  formatMinutes,
} from "@/components/dashboard/report-widgets";
import { InsightsCard } from "@/components/dashboard/insights-card";

import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBRL } from "@/lib/format";
import { requireAdmin } from "@/lib/api/session";
import { useGlobalPeriod } from "@/lib/view-prefs/use-global-period";
import {
  computeHandoffSlaPercentiles,
  computePeriodOverPeriod,
  fetchAiInsights,
  useDashboardReport,
  useDealOwnerLeaderboard,
  useHandoffSlaEvents,
  type AiInsightsResponse,
  type PeriodOverPeriod,
} from "@/lib/api/reports";

export const Route = createFileRoute("/_app/relatorios")({
  beforeLoad: ({ context }) => requireAdmin(context.queryClient),
  head: () => ({
    meta: [
      { title: "Relatórios" },
      {
        name: "description",
        content: "Métricas de atendimento e visão gerencial do funil.",
      },
    ],
  }),
  component: RelatoriosPage,
});

function RelatoriosPage() {
  // Período vem do topbar (useGlobalPeriod). O range já é o `from/to`
  // deste report; nenhum seletor local aqui.
  const { period, range } = useGlobalPeriod();
  const { from, to } = range;

  const reportQ = useDashboardReport(from, to);
  const r = reportQ.data;

  // Período anterior de mesma duração (user story K), derivado do range já
  // selecionado — não é outro seletor, é [from - duração, from).
  const { fromPrev, toPrev } = useMemo(() => {
    const durationMs = to.getTime() - from.getTime();
    return { fromPrev: new Date(from.getTime() - durationMs), toPrev: new Date(from.getTime()) };
  }, [from, to]);
  const prevReportQ = useDashboardReport(fromPrev, toPrev);

  const periodOverPeriod = useMemo(() => {
    if (!r || !prevReportQ.data) return null;
    const p = prevReportQ.data;
    return {
      conversas_novas: computePeriodOverPeriod(
        r.atendimento.conversas_novas,
        p.atendimento.conversas_novas,
      ),
      ganhos: computePeriodOverPeriod(r.resultados.ganhos, p.resultados.ganhos),
      msgs_recebidas: computePeriodOverPeriod(
        r.atendimento.msgs_recebidas,
        p.atendimento.msgs_recebidas,
      ),
    };
  }, [r, prevReportQ.data]);

  const slaQ = useHandoffSlaEvents(from, to);
  const slaPercentiles = useMemo(() => computeHandoffSlaPercentiles(slaQ.data ?? []), [slaQ.data]);

  const leaderboardQ = useDealOwnerLeaderboard();

  const insightsMut = useMutation<AiInsightsResponse, Error, { force?: boolean }>({
    mutationFn: ({ force }) => fetchAiInsights(from, to, force),
  });

  const pctIa = useMemo(() => {
    if (!r || r.atendimento.msgs_enviadas === 0) return null;
    return Math.round((r.atendimento.msgs_ia / r.atendimento.msgs_enviadas) * 100);
  }, [r]);

  const winRate = useMemo(() => {
    if (!r) return null;
    const total = r.resultados.ganhos + r.resultados.perdidos;
    if (total === 0) return null;
    return Math.round((r.resultados.ganhos / total) * 100);
  }, [r]);

  // Muda de período → invalida o resultado de insights do período anterior.
  useEffect(() => {
    insightsMut.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period]);

  return (
    <div className="col-span-12 space-y-6">
      <AiInsightsHealthBanner />

      <PageHeader
        title="Relatórios"
        description="Métricas de atendimento e visão gerencial do funil. Período controlado no topo."
      />

      {reportQ.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      ) : reportQ.isError ? (
        <EmptyState
          title="Não foi possível carregar"
          description="Tente novamente em instantes. Apenas administradores acessam relatórios."
        />
      ) : r ? (
        <>
          {/* KPIs de atendimento */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              icon={<Clock className="h-4 w-4" />}
              label="1ª resposta (média)"
              value={
                r.atendimento.primeira_resposta_min == null
                  ? "—"
                  : formatMinutes(r.atendimento.primeira_resposta_min)
              }
              hint="Da primeira mensagem do lead até a primeira resposta"
            />
            <KpiCard
              icon={<Bot className="h-4 w-4" />}
              label="Respondido pela IA"
              value={pctIa == null ? "—" : `${pctIa}%`}
              hint={`${r.atendimento.msgs_ia} de ${r.atendimento.msgs_enviadas} mensagens enviadas`}
            />
            <KpiCard
              icon={<MessageSquare className="h-4 w-4" />}
              label="Novas conversas"
              value={String(r.atendimento.conversas_novas)}
              hint={`${r.atendimento.handoff} transferidas para humano`}
            />
            <KpiCard
              icon={<TrendingUp className="h-4 w-4" />}
              label="Taxa de ganho"
              value={winRate == null ? "—" : `${winRate}%`}
              hint={`${r.resultados.ganhos} ganhos · ${r.resultados.perdidos} perdidos`}
            />
          </div>

          {/* Comparação com o período anterior de mesma duração */}
          <Card>
            <CardHeader>
              <CardTitle className="text-card-title">Comparado ao período anterior</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <PeriodOverPeriodRow
                label="Novas conversas"
                value={String(r.atendimento.conversas_novas)}
                trend={periodOverPeriod?.conversas_novas ?? null}
              />
              <PeriodOverPeriodRow
                label="Negócios ganhos"
                value={String(r.resultados.ganhos)}
                trend={periodOverPeriod?.ganhos ?? null}
              />
              <PeriodOverPeriodRow
                label="Mensagens recebidas"
                value={String(r.atendimento.msgs_recebidas)}
                trend={periodOverPeriod?.msgs_recebidas ?? null}
              />
            </CardContent>
          </Card>

          {/* Insights de IA */}
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
          />

          <div className="grid gap-4 lg:grid-cols-2">
            {/* Mensagens por dia */}
            <Card>
              <CardHeader>
                <CardTitle className="text-card-title">Mensagens por dia</CardTitle>
              </CardHeader>
              <CardContent>
                <MessagesPerDayChart data={r.mensagens_por_dia} />
              </CardContent>
            </Card>

            {/* Funil */}
            <Card>
              <CardHeader>
                <CardTitle className="text-card-title">Funil — negócios abertos</CardTitle>
              </CardHeader>
              <CardContent>
                <FunnelBars stages={r.funil} />
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* Resultados */}
            <Card>
              <CardHeader>
                <CardTitle className="text-card-title">Resultados do período</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <ResultRow label="Negócios ganhos" value={String(r.resultados.ganhos)} />
                <ResultRow label="Valor ganho" value={formatBRL(r.resultados.ganhos_valor)} />
                <ResultRow label="Negócios perdidos" value={String(r.resultados.perdidos)} />
                <ResultRow
                  label="Ciclo médio de venda"
                  value={
                    r.resultados.ciclo_medio_dias == null
                      ? "—"
                      : `${r.resultados.ciclo_medio_dias} dias`
                  }
                />
              </CardContent>
            </Card>

            {/* Motivos de perda */}
            <Card>
              <CardHeader>
                <CardTitle className="text-card-title">Principais motivos de perda</CardTitle>
              </CardHeader>
              <CardContent>
                {r.resultados.motivos_perda.length === 0 ? (
                  <p className="text-caption text-muted-foreground">
                    Nenhum motivo registrado no período.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {r.resultados.motivos_perda.map((m) => (
                      <li key={m.motivo} className="flex items-center justify-between text-body">
                        <span className="truncate">{m.motivo}</span>
                        <span className="text-muted-foreground">{m.n}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Tempo de resolução da transferência para humano */}
          <Card>
            <CardHeader>
              <CardTitle className="text-card-title">
                Transferência para humano — tempo até a resolução
              </CardTitle>
            </CardHeader>
            <CardContent>
              {slaQ.isLoading ? (
                <Skeleton className="h-10 w-48" />
              ) : slaPercentiles == null ? (
                <p className="text-caption text-muted-foreground">
                  Nenhuma transferência resolvida no período.
                </p>
              ) : (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-caption text-muted-foreground">p50 (mediana)</p>
                    <p className="mt-1 text-h4 font-semibold">
                      {formatMinutes(slaPercentiles.p50)}
                    </p>
                  </div>
                  <div>
                    <p className="text-caption text-muted-foreground">p95</p>
                    <p className="mt-1 text-h4 font-semibold">
                      {formatMinutes(slaPercentiles.p95)}
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Ranking de owners de deals (user story G) — sem filtro de
              período nesta primeira versão, ver comentário em
              useDealOwnerLeaderboard. */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-card-title">
                <Trophy className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                Ranking — negócios fechados
              </CardTitle>
            </CardHeader>
            <CardContent>
              {leaderboardQ.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : leaderboardQ.isError ? (
                <p className="text-caption text-muted-foreground">
                  Não foi possível carregar o ranking.
                </p>
              ) : !leaderboardQ.data || leaderboardQ.data.length === 0 ? (
                <p className="text-caption text-muted-foreground">
                  Nenhum negócio decidido (ganho ou perdido) ainda.
                </p>
              ) : (
                <ul className="space-y-3">
                  {leaderboardQ.data.map((row, i) => (
                    <li
                      key={row.owner_id ?? i}
                      className="flex flex-wrap items-center justify-between gap-2 text-body"
                    >
                      <span className="flex items-center gap-2">
                        <span className="w-6 text-caption text-muted-foreground">{i + 1}º</span>
                        {row.owner_name ?? "—"}
                      </span>
                      <span className="flex items-center gap-4 text-caption text-muted-foreground">
                        <span>{row.wins ?? 0} vitórias</span>
                        <span>{row.decided ?? 0} decididos</span>
                        <span>{row.win_rate_pct == null ? "—" : `${row.win_rate_pct}%`}</span>
                        <span className="font-medium text-foreground">
                          {formatBRL(row.total_won_value ?? 0)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}

function PeriodOverPeriodRow({
  label,
  value,
  trend,
}: {
  label: string;
  value: string;
  trend: PeriodOverPeriod | null;
}) {
  const isUp = trend != null && trend.pct != null && trend.pct > 0;
  const isDown = trend != null && trend.pct != null && trend.pct < 0;
  return (
    <div className="flex items-center justify-between text-body">
      <span>{label}</span>
      <span className="flex items-center gap-3">
        <span className="font-medium">{value}</span>
        {trend && (
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-caption font-medium ${
              isUp
                ? "bg-success/10 text-success"
                : isDown
                  ? "bg-destructive/10 text-destructive"
                  : "bg-muted text-muted-foreground"
            }`}
          >
            {isUp ? (
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            ) : isDown ? (
              <ArrowDownRight className="h-3.5 w-3.5" aria-hidden="true" />
            ) : null}
            {trend.pct == null ? trend.label : `${trend.label} vs período anterior`}
          </span>
        )}
      </span>
    </div>
  );
}

function KpiCard({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-caption font-medium uppercase tracking-wider text-muted-foreground">
          {icon}
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-h4 font-semibold">{value}</div>
        <p className="mt-1 text-caption text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}
