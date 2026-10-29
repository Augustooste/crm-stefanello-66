import { Area, AreaChart, CartesianGrid, XAxis } from "recharts";

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { formatBRL } from "@/lib/format";
import type { ReportDia, ReportStage } from "@/lib/api/reports";

/**
 * Widgets compartilhados entre Relatórios e Dashboard, alimentados pelo RPC
 * `dashboard_report` (useDashboardReport). Extraídos de _app.relatorios.tsx
 * para o Dashboard reusar sem duplicar (mesmo visual, mesma fonte de dados).
 */

export function formatMinutes(min: number): string {
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

export function KpiCardInner({
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
  // Um único elemento raiz: usado direto como item de grade, o KPI ocupa uma
  // célula só (com Fragment, rótulo/valor/dica viravam 3 células soltas).
  // A célula ocupa 3 linhas da grade-mãe e as herda via subgrid: rótulo, valor
  // e dica de todas as colunas dividem as mesmas faixas, então um rótulo que
  // quebra em 2 linhas não desalinha o valor da sua coluna. gap-y-0 impede que
  // o espaçamento vertical da grade-mãe entre no KPI (mt-2/mt-1 cuidam disso).
  // Fora de uma grade, o subgrid vira uma grade comum e o row-span é ignorado.
  return (
    <div className="row-span-3 grid grid-rows-subgrid gap-y-0">
      <div className="flex items-center gap-2 text-caption font-medium uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-2 text-h4 font-semibold">{value}</div>
      <p className="mt-1 text-caption text-muted-foreground">{hint}</p>
    </div>
  );
}

const chartConfig = {
  recebidas: { label: "Recebidas", color: "var(--primary)" },
  enviadas: { label: "Enviadas", color: "var(--accent-foreground)" },
} satisfies ChartConfig;

export function MessagesPerDayChart({ data }: { data: ReportDia[] }) {
  if (data.length === 0) {
    return <p className="text-caption text-muted-foreground">Nenhuma mensagem no período.</p>;
  }
  return (
    <ChartContainer config={chartConfig} className="h-64 w-full">
      <AreaChart data={data} margin={{ left: 4, right: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="dia"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tickFormatter={(v: string) => v.slice(8, 10) + "/" + v.slice(5, 7)}
        />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Area
          dataKey="recebidas"
          type="monotone"
          fill="var(--color-recebidas)"
          fillOpacity={0.25}
          stroke="var(--color-recebidas)"
        />
        <Area
          dataKey="enviadas"
          type="monotone"
          fill="var(--color-enviadas)"
          fillOpacity={0.25}
          stroke="var(--color-enviadas)"
        />
      </AreaChart>
    </ChartContainer>
  );
}

export function FunnelBars({ stages }: { stages: ReportStage[] }) {
  const open = stages.filter((s) => !s.is_won && !s.is_lost);
  const max = Math.max(1, ...open.map((s) => s.negocios));
  if (open.length === 0) {
    return (
      <p className="text-caption text-muted-foreground">
        Nenhum estágio configurado — aplique um modelo de nicho no wizard.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {open.map((s) => (
        <div key={s.stage_id}>
          <div className="mb-1 flex items-center justify-between text-caption">
            <span className="font-medium">{s.nome}</span>
            <span className="text-muted-foreground">
              {s.negocios} {s.negocios === 1 ? "negócio" : "negócios"} · {formatBRL(s.valor)}
              {s.dias_medio_no_estagio != null && ` · ${s.dias_medio_no_estagio}d parado`}
            </span>
          </div>
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${Math.max(4, (s.negocios / max) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ResultRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-body">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
