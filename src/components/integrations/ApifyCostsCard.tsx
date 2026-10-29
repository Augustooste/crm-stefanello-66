import { useMemo } from "react";
import { CircleDollarSign } from "lucide-react";
import { Bar, BarChart, CartesianGrid, XAxis } from "recharts";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { StatusBadge } from "@/components/common/StatusBadge";
import { EmptyState } from "@/components/common/EmptyState";
import { useApifyEnrichmentRuns } from "@/lib/api/integrations";
import { formatDateTime, formatUSD } from "@/lib/format";

// actor_id é o slug opaco do Apify Store (ver ACTORS em
// supabase/functions/lead-enrich/index.ts) -- mapeado para o nome da fonte
// que o usuário reconhece. Actor não mapeado cai no slug bruto (forward
// compatible, nunca esconde dado).
const ACTOR_LABELS: Record<string, string> = {
  "apify~instagram-profile-scraper": "Instagram",
  "vdrmota~contact-info-scraper": "Site",
  "vero-api~whatsapp-scraper": "WhatsApp",
};
const actorLabel = (actorId: string) => ACTOR_LABELS[actorId] ?? actorId;

const STATUS_LABEL: Record<string, string> = {
  succeeded: "Sucesso",
  failed: "Falha",
  running: "Em execução",
};
const STATUS_VARIANT: Record<string, "success" | "destructive" | "neutral"> = {
  succeeded: "success",
  failed: "destructive",
  running: "neutral",
};

const RECENT_RUNS_LIMIT = 20;

const chartConfig = {
  cost: { label: "Custo (US$)", color: "var(--primary)" },
} satisfies ChartConfig;

/**
 * Dashboard de custos do enriquecimento via Apify (mês corrente). Fonte:
 * apify_enrichment_runs (RLS já filtra por tenant). Vive na aba "Integrações
 * e Plugins" de Configurações, junto do card de conexão -- mesma família
 * conceitual (a integração e o que ela custa).
 */
export function ApifyCostsCard() {
  const runsQuery = useApifyEnrichmentRuns();
  const runs = runsQuery.data ?? [];

  const stats = useMemo(() => {
    const runs = runsQuery.data ?? [];
    const totalCost = runs.reduce((sum, r) => sum + r.cost_usd, 0);
    const succeeded = runs.filter((r) => r.status === "succeeded").length;
    const failed = runs.filter((r) => r.status === "failed").length;

    const byActor = new Map<string, { count: number; cost: number }>();
    for (const r of runs) {
      const cur = byActor.get(r.actor_id) ?? { count: 0, cost: 0 };
      byActor.set(r.actor_id, { count: cur.count + 1, cost: cur.cost + r.cost_usd });
    }

    const byDay = new Map<string, number>();
    for (const r of runs) {
      const day = r.created_at.slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + r.cost_usd);
    }
    const chartData = Array.from(byDay.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, cost]) => ({ day, cost: Number(cost.toFixed(4)) }));

    return { totalCost, succeeded, failed, byActor, chartData };
  }, [runsQuery.data]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-card-title">
          <CircleDollarSign className="h-4 w-4" aria-hidden />
          Custos de enriquecimento (Apify)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {runsQuery.isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : runs.length === 0 ? (
          <EmptyState
            icon={CircleDollarSign}
            title="Nenhum enriquecimento ainda"
            description="Conecte a Apify e enriqueça um contato para ver o histórico de custos aqui."
          />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="rounded-lg border border-border p-4">
                <p className="text-caption text-muted-foreground">Custo este mês</p>
                <p className="mt-1 text-h4 font-semibold">{formatUSD(stats.totalCost)}</p>
              </div>
              <div className="rounded-lg border border-border p-4">
                <p className="text-caption text-muted-foreground">Runs com sucesso</p>
                <p className="mt-1 text-h4 font-semibold text-success">{stats.succeeded}</p>
              </div>
              <div className="rounded-lg border border-border p-4">
                <p className="text-caption text-muted-foreground">Runs com falha</p>
                <p className="mt-1 text-h4 font-semibold text-destructive">{stats.failed}</p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {Array.from(stats.byActor.entries()).map(([actorId, s]) => (
                <StatusBadge key={actorId} variant="brand" showDot={false}>
                  {actorLabel(actorId)}: {s.count} {s.count === 1 ? "run" : "runs"} ·{" "}
                  {formatUSD(s.cost)}
                </StatusBadge>
              ))}
            </div>

            <ChartContainer config={chartConfig} className="h-56 w-full">
              <BarChart data={stats.chartData} margin={{ left: 4, right: 4 }}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="day"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  tickFormatter={(v: string) => v.slice(8, 10) + "/" + v.slice(5, 7)}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="cost" fill="var(--color-cost)" radius={4} />
              </BarChart>
            </ChartContainer>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead>Fonte</TableHead>
                  <TableHead>Situação</TableHead>
                  <TableHead>Custo</TableHead>
                  <TableHead>Contato</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.slice(0, RECENT_RUNS_LIMIT).map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap text-caption text-muted-foreground">
                      {formatDateTime(r.created_at)}
                    </TableCell>
                    <TableCell>{actorLabel(r.actor_id)}</TableCell>
                    <TableCell>
                      <StatusBadge variant={STATUS_VARIANT[r.status] ?? "neutral"}>
                        {STATUS_LABEL[r.status] ?? r.status}
                      </StatusBadge>
                    </TableCell>
                    <TableCell>{formatUSD(r.cost_usd)}</TableCell>
                    <TableCell>{r.contact?.name ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </CardContent>
    </Card>
  );
}
