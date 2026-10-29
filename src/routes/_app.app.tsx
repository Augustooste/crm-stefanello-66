import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Briefcase,
  CalendarClock,
  CircleAlert,
  CircleCheckBig,
  FileText,
  Phone,
  StickyNote,
  Target,
  TrendingUp,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";

import { PageHeader } from "@/components/common/PageHeader";
import { EmptyState } from "@/components/common/EmptyState";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InitialsAvatar } from "@/components/common/InitialsAvatar";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile } from "@/lib/api/session";
import { DashboardReportSections } from "@/components/dashboard/report-sections";
import { DashboardFilters } from "@/components/dashboard/dashboard-filters";
import { useGlobalPeriod } from "@/lib/view-prefs/use-global-period";
import { WalletHealthCard } from "@/components/dashboard/wallet-health-card";
import { MessagingPerformanceCard } from "@/components/dashboard/messaging-performance-card";
import { AiHitlPerformanceCard } from "@/components/dashboard/ai-hitl-performance-card";
import { PendingReturnsCard } from "@/components/dashboard/pending-returns-card";
import { PipelineFunnelCard } from "@/components/dashboard/pipeline-funnel-card";
import { RecentActivityFeed } from "@/components/dashboard/recent-activity-feed";
import { formatBRL, formatTime, relativeFromNow } from "@/lib/format";
import { useViewPrefs } from "@/lib/api/view-prefs";

export const Route = createFileRoute("/_app/app")({
  head: () => ({
    meta: [
      { title: "Visão Geral" },
      {
        name: "description",
        content: "O pulso do seu negócio em tempo real: funil, receita, saúde da carteira e IA.",
      },
      { property: "og:title", content: "Visão Geral" },
      {
        property: "og:description",
        content: "O pulso do seu negócio em tempo real: funil, receita, saúde da carteira e IA.",
      },
      { property: "og:url", content: "https://aceleraflow.lovable.app/app" },
      { name: "twitter:title", content: "Visão Geral" },
      {
        name: "twitter:description",
        content: "O pulso do seu negócio em tempo real: funil, receita, saúde da carteira e IA.",
      },
    ],
    links: [{ rel: "canonical", href: "https://aceleraflow.lovable.app/app" }],
  }),
  component: DashboardPage,
});

type DashboardScope = { ownerId: string | null; boardId: string | null };

/** Variação percentual vs período anterior; null quando não dá para comparar. */
function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return current > 0 ? null : 0;
  return ((current - previous) / previous) * 100;
}
function startOfDayISO() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
function endOfDayISO() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

/**
 * KPIs monetários e de conversão do topo (alinhados à referência):
 *  - Pipeline Total (R$)  = sum(value) dos deals em aberto.
 *  - Negócios Ativos      = contagem de deals em aberto.
 *  - Win-rate (coorte %)  = ganhos / (ganhos + perdidos) no período global.
 *  - Receita Ganha (R$)   = sum(value) dos ganhos no período global.
 *
 * Pipeline/Ativos são snapshots do presente: respeitam quadro/responsável,
 * mas não são recortados pelo período. Win-rate e receita usam a janela do
 * período global (`stage_entered_at` como data de fechamento) e comparam com
 * a janela imediatamente anterior de mesma duração.
 */
function useDashboardKpis({
  from,
  to,
  ownerId,
  boardId,
}: DashboardScope & { from: Date; to: Date }) {
  const fromISO = from.toISOString();
  const toISO = to.toISOString();
  return useQuery({
    queryKey: ["dashboard", "kpis", fromISO, toISO, ownerId, boardId],
    queryFn: async () => {
      const span = to.getTime() - from.getTime();
      const prevFromISO = new Date(from.getTime() - span - 1).toISOString();

      const deals = (columns: "value" | "id", options: { count: "exact"; head?: boolean }) => {
        let q = supabase.from("deals").select(columns, options);
        if (ownerId) q = q.eq("owner_id", ownerId);
        if (boardId) q = q.eq("board_id", boardId);
        return q;
      };

      const [openDealsRes, wonCurrentRes, lostCurrentRes, wonPrevRes, lostPrevRes] =
        await Promise.all([
          deals("value", { count: "exact" }).eq("status", "open"),
          deals("value", { count: "exact" })
            .eq("status", "won")
            .gte("stage_entered_at", fromISO)
            .lte("stage_entered_at", toISO),
          deals("id", { count: "exact", head: true })
            .eq("status", "lost")
            .gte("stage_entered_at", fromISO)
            .lte("stage_entered_at", toISO),
          deals("value", { count: "exact" })
            .eq("status", "won")
            .gte("stage_entered_at", prevFromISO)
            .lt("stage_entered_at", fromISO),
          deals("id", { count: "exact", head: true })
            .eq("status", "lost")
            .gte("stage_entered_at", prevFromISO)
            .lt("stage_entered_at", fromISO),
        ]);
      const errors = [openDealsRes, wonCurrentRes, lostCurrentRes, wonPrevRes, lostPrevRes]
        .map((r) => r.error)
        .filter(Boolean);
      if (errors.length) throw errors[0];

      // O builder único tipa as linhas como união das duas projeções ("value" | "id").
      const sumValues = (rows: ReadonlyArray<object> | null) =>
        (rows ?? []).reduce(
          (sum, d) => sum + ("value" in d ? Number((d as { value: number | null }).value ?? 0) : 0),
          0,
        );

      const pipelineValue = sumValues(openDealsRes.data);
      const activeDeals = openDealsRes.count ?? 0;
      const wonCount = wonCurrentRes.count ?? 0;
      const lostCount = lostCurrentRes.count ?? 0;
      const revenueValue = sumValues(wonCurrentRes.data);

      const wonPrevCount = wonPrevRes.count ?? 0;
      const lostPrevCount = lostPrevRes.count ?? 0;
      const revenuePrev = sumValues(wonPrevRes.data);

      const winRatePct = wonCount + lostCount > 0 ? (wonCount / (wonCount + lostCount)) * 100 : 0;
      const winRatePrevPct =
        wonPrevCount + lostPrevCount > 0
          ? (wonPrevCount / (wonPrevCount + lostPrevCount)) * 100
          : 0;

      return {
        pipelineValue,
        activeDeals,
        winRatePct,
        revenueValue,
        pipelineDelta: null as number | null, // sem histórico dedicado — evita falso delta
        activeDealsDelta: null as number | null,
        winRateDelta: pctChange(winRatePct, winRatePrevPct),
        revenueDelta: pctChange(revenueValue, revenuePrev),
      };
    },
  });
}

type TodayActivity = {
  id: string;
  title: string;
  type: "task" | "call" | "note";
  due_at: string;
};
type UnansweredLead = {
  id: string;
  name: string;
  last_message_at: string | null;
  channel: string | null;
};

/**
 * "Responsável" é o dono da atividade; "quadro" é o do negócio vinculado —
 * com quadro selecionado, atividades sem negócio ficam de fora.
 */
function useTodayActivities({ ownerId, boardId }: DashboardScope) {
  return useQuery({
    queryKey: ["dashboard", "today-activities", ownerId, boardId],
    queryFn: async () => {
      let q = supabase
        .from("activities")
        .select(
          boardId
            ? "id, title, type, due_at, deal:deals!inner(board_id)"
            : "id, title, type, due_at",
        )
        .is("completed_at", null)
        .gte("due_at", startOfDayISO())
        .lte("due_at", endOfDayISO());
      if (ownerId) q = q.eq("owner_id", ownerId);
      if (boardId) q = q.eq("deal.board_id", boardId);
      const { data, error } = await q.order("due_at");
      if (error) throw error;
      return (data ?? []) as unknown as TodayActivity[];
    },
  });
}

/**
 * Conversas abertas aguardando resposta. "Responsável" é o dono do contato;
 * "quadro" exige que o contato tenha negócio naquele quadro.
 */
function useUnansweredLeads({ ownerId, boardId }: DashboardScope) {
  return useQuery({
    queryKey: ["dashboard", "unanswered-leads", ownerId, boardId],
    queryFn: async () => {
      const contactEmbed = boardId
        ? "contact:contacts!inner(id, name, deleted_at, owner_id, deals!inner(board_id))"
        : ownerId
          ? "contact:contacts!inner(id, name, deleted_at, owner_id)"
          : "contact:contacts(id, name, deleted_at)";
      const scoped = (columns: string, options?: { count: "exact"; head: true }) => {
        let q = supabase
          .from("conversations")
          .select(columns, options)
          .eq("status", "open")
          .is("deleted_at", null);
        if (ownerId) q = q.eq("contact.owner_id", ownerId);
        if (boardId) q = q.eq("contact.deals.board_id", boardId);
        return q;
      };
      const [countRes, listRes] = await Promise.all([
        scoped(ownerId || boardId ? `id, ${contactEmbed}` : "id", { count: "exact", head: true }),
        scoped(`id, last_message_at, ${contactEmbed}, channel:channels(type)`)
          .order("last_message_at", { ascending: false })
          .limit(10),
      ]);
      if (countRes.error) throw countRes.error;
      if (listRes.error) throw listRes.error;
      const items = (listRes.data ?? []).map((c) => {
        const row = c as unknown as {
          id: string;
          last_message_at: string | null;
          contact: { name: string; deleted_at: string | null } | null;
          channel: { type: string } | null;
        };
        const contact = row.contact?.deleted_at ? null : row.contact;
        return {
          id: row.id,
          name: contact?.name ?? "—",
          last_message_at: row.last_message_at,
          channel: row.channel?.type ?? null,
        } as UnansweredLead;
      });
      return { items, total: countRes.count ?? items.length };
    },
  });
}

function DashboardPage() {
  // Período vem do topbar (GlobalPeriodPicker + useGlobalPeriod); owner/board
  // são locais ao Dashboard e valem para todos os indicadores, inclusive o topo.
  const { range } = useGlobalPeriod();
  const { from, to } = range;
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [boardId, setBoardId] = useState<string | null>(null);

  const kpisQ = useDashboardKpis({ from, to, ownerId, boardId });
  const activitiesQ = useTodayActivities({ ownerId, boardId });
  const leadsQ = useUnansweredLeads({ ownerId, boardId });
  const { data: profile } = useCurrentProfile();
  const isAdmin = profile?.role === "admin";
  const { isVisible } = useViewPrefs();

  const kpis = kpisQ.data;

  // Wrapper — reduz ruído nas dezenas de gates abaixo.
  const show = (key: string) => isVisible("dashboard", key);
  // Nenhum dos 4 KPIs ligado? Não renderiza a grid inteira (nem o loading).
  const anyKpi =
    show("kpi_pipeline") || show("kpi_active_deals") || show("kpi_win_rate") || show("kpi_revenue");

  return (
    <div className="col-span-12 flex flex-col gap-6">
      <PageHeader
        title="Visão Geral"
        description="O pulso do seu negócio em tempo real."
        actions={
          <DashboardFilters
            ownerId={ownerId}
            onOwnerChange={setOwnerId}
            boardId={boardId}
            onBoardChange={setBoardId}
          />
        }
      />

      {show("action_briefing") && (
        <ActionBriefing
          activityCount={activitiesQ.data?.length}
          unansweredCount={leadsQ.data?.total}
          openDeals={kpis?.activeDeals}
          isLoading={activitiesQ.isLoading || leadsQ.isLoading || kpisQ.isLoading}
        />
      )}

      {anyKpi &&
        (kpisQ.isError ? (
          <EmptyState
            title="Erro ao carregar indicadores"
            description={(kpisQ.error as Error)?.message ?? "Não foi possível carregar os KPIs."}
            actionLabel="Tentar novamente"
            onAction={() => kpisQ.refetch()}
          />
        ) : (
          <section
            aria-label="Indicadores do período"
            className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
          >
            {kpisQ.isLoading || !kpis ? (
              Array.from({ length: 4 }).map((_, i) => <KpiSkeleton key={i} />)
            ) : (
              <>
                {show("kpi_pipeline") && (
                  <Kpi
                    label="Total no funil"
                    value={formatBRL(kpis.pipelineValue)}
                    icon={Wallet}
                    delta={kpis.pipelineDelta}
                  />
                )}
                {show("kpi_active_deals") && (
                  <Kpi
                    label="Negócios ativos"
                    value={kpis.activeDeals.toString()}
                    icon={Users}
                    tone="brand"
                    delta={kpis.activeDealsDelta}
                  />
                )}
                {show("kpi_win_rate") && (
                  <Kpi
                    label="Taxa de ganho (coorte)"
                    value={`${kpis.winRatePct.toFixed(1)}%`}
                    icon={Target}
                    tone="success"
                    delta={kpis.winRateDelta}
                  />
                )}
                {show("kpi_revenue") && (
                  <Kpi
                    label="Receita (Ganha)"
                    value={formatBRL(kpis.revenueValue)}
                    icon={TrendingUp}
                    tone="success"
                    delta={kpis.revenueDelta}
                  />
                )}
              </>
            )}
          </section>
        ))}

      {show("wallet_health") && (
        <section aria-label="Saúde da Carteira" className="flex flex-col gap-4">
          <WalletHealthCard ownerId={ownerId} boardId={boardId} />
        </section>
      )}

      {show("messaging_performance") && (
        <section aria-label="Performance de Mensagens" className="flex flex-col gap-4">
          <MessagingPerformanceCard from={from} to={to} ownerId={ownerId} boardId={boardId} />
        </section>
      )}

      {(show("ai_hitl") || show("pending_returns")) && (
        <section
          aria-label="IA e retornos pendentes"
          className="grid grid-cols-1 gap-4 lg:grid-cols-2"
        >
          {show("ai_hitl") && (
            <AiHitlPerformanceCard from={from} to={to} ownerId={ownerId} boardId={boardId} />
          )}
          {show("pending_returns") && <PendingReturnsCard ownerId={ownerId} boardId={boardId} />}
        </section>
      )}

      {(show("pipeline_funnel") || show("recent_activity")) && (
        <section aria-label="Funil e atividades" className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {show("pipeline_funnel") && (
            <PipelineFunnelCard from={from} to={to} ownerId={ownerId} boardId={boardId} />
          )}
          {show("recent_activity") && <RecentActivityFeed />}
        </section>
      )}

      {isAdmin && <DashboardReportSections />}

      {(show("today_activities") || show("unanswered_leads")) && (
        <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {show("today_activities") && (
            <Card>
              <CardHeader>
                <CardTitle className="text-card-title">Atividades de hoje</CardTitle>
              </CardHeader>
              <CardContent>
                {activitiesQ.isLoading ? (
                  <ListSkeleton />
                ) : (activitiesQ.data?.length ?? 0) === 0 ? (
                  <EmptyState
                    icon={CalendarClock}
                    title="Nenhuma atividade para hoje"
                    description="Agende ligações, reuniões ou tarefas para manter o funil em movimento."
                  />
                ) : (
                  <ul className="divide-y divide-border">
                    {activitiesQ.data!.map((a) => (
                      <ActivityRow key={a.id} activity={a} />
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          )}

          {show("unanswered_leads") && (
            <Card>
              <CardHeader>
                <CardTitle className="text-card-title">Leads sem resposta</CardTitle>
              </CardHeader>
              <CardContent>
                {leadsQ.isLoading ? (
                  <ListSkeleton />
                ) : leadsQ.isError ? (
                  <EmptyState
                    title="Erro ao carregar leads"
                    description={
                      (leadsQ.error as Error)?.message ?? "Tente novamente em instantes."
                    }
                    actionLabel="Tentar novamente"
                    onAction={() => leadsQ.refetch()}
                  />
                ) : (leadsQ.data?.items.length ?? 0) === 0 ? (
                  <EmptyState
                    icon={Users}
                    title="Tudo em dia"
                    description="Você não tem leads aguardando resposta no momento."
                  />
                ) : (
                  <ul className="divide-y divide-border">
                    {leadsQ.data!.items.map((l) => (
                      <LeadRow key={l.id} lead={l} />
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          )}
        </section>
      )}
    </div>
  );
}

/** O dashboard começa pelo que merece ação, deixando indicadores como contexto. */
function ActionBriefing({
  activityCount,
  unansweredCount,
  openDeals,
  isLoading,
}: {
  activityCount: number | undefined;
  unansweredCount: number | undefined;
  openDeals: number | undefined;
  isLoading: boolean;
}) {
  const actions = [
    {
      title:
        unansweredCount && unansweredCount > 0
          ? `${unansweredCount} lead${unansweredCount === 1 ? "" : "s"} aguardando resposta`
          : "Inbox sob controle",
      description:
        unansweredCount && unansweredCount > 0
          ? "Responda enquanto a intenção ainda está alta."
          : "Nenhuma conversa precisa de resposta agora.",
      to: "/inbox" as const,
      icon: unansweredCount && unansweredCount > 0 ? CircleAlert : CircleCheckBig,
      emphasis: Boolean(unansweredCount && unansweredCount > 0),
    },
    {
      title:
        activityCount && activityCount > 0
          ? `${activityCount} atividade${activityCount === 1 ? "" : "s"} para hoje`
          : "Planeje a próxima ação",
      description:
        activityCount && activityCount > 0
          ? "Mantenha o ritmo dos negócios em andamento."
          : "Crie uma tarefa para não deixar uma oportunidade esfriar.",
      to: "/atividades" as const,
      icon: CalendarClock,
      emphasis: false,
    },
    {
      title: `${openDeals ?? 0} negócio${openDeals === 1 ? "" : "s"} em negociação`,
      description: "Use o funil para identificar o próximo avanço comercial.",
      to: "/pipeline" as const,
      icon: Briefcase,
      emphasis: false,
    },
  ];

  return (
    <section
      className="overflow-hidden rounded-xl border border-primary/20 bg-card shadow-sm"
      aria-label="Prioridades do dia"
    >
      <div className="flex flex-col justify-between gap-3 border-b border-border bg-primary/[0.045] px-5 py-4 sm:flex-row sm:items-center">
        <div>
          <p className="text-caption font-semibold uppercase tracking-[0.12em] text-primary">
            Foco operacional
          </p>
          <h2 className="mt-1 text-lead font-semibold tracking-[-0.025em] text-foreground">
            Prioridade do dia
          </h2>
        </div>
        <p className="max-w-sm text-sm leading-5 text-muted-foreground">
          Comece pelo sinal que mais ajuda a destravar receita agora.
        </p>
      </div>
      <div className="grid divide-y divide-border md:grid-cols-3 md:divide-x md:divide-y-0">
        {actions.map(({ title, description, to, icon: Icon, emphasis }) => (
          <Link
            key={to}
            to={to}
            className="group flex gap-3 p-5 transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:ring-ring focus-visible:ring-inset"
          >
            <span
              className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg ${emphasis ? "bg-warning/15 text-warning" : "bg-primary/10 text-primary"}`}
            >
              <Icon className="h-4.5 w-4.5" />
            </span>
            <span className="min-w-0">
              <span className="flex items-center gap-1 text-sm font-semibold text-foreground">
                {isLoading ? "Atualizando prioridades..." : title}
                <ArrowRight className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
              </span>
              <span className="mt-1 block text-sm leading-5 text-muted-foreground">
                {description}
              </span>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

const KPI_TONES = {
  brand: "bg-primary/10 text-primary",
  success: "bg-success/10 text-success",
  destructive: "bg-destructive/10 text-destructive",
} as const;

function Kpi({
  label,
  value,
  icon: Icon,
  tone = "brand",
  delta,
  deltaInverted = false,
}: {
  label: string;
  value: string;
  icon: LucideIcon;
  tone?: keyof typeof KPI_TONES;
  delta?: number | null;
  deltaInverted?: boolean;
}) {
  const hasDelta = delta !== undefined && delta !== null;
  const isUp = hasDelta && delta > 0;
  const isDown = hasDelta && delta < 0;
  const good = deltaInverted ? isDown : isUp;
  const bad = deltaInverted ? isUp : isDown;
  return (
    <Card className="glass-standard transition-all duration-300 hover:-translate-y-1 hover:shadow-[var(--shadow-glow)]">
      <CardHeader className="flex-row items-start justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="text-caption font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </CardTitle>
        <span
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${KPI_TONES[tone]}`}
          aria-hidden="true"
        >
          <Icon className="h-5 w-5" />
        </span>
      </CardHeader>
      <CardContent>
        <div className="text-h3 font-extrabold tracking-tight tabular-nums text-foreground">
          {value}
        </div>
        {hasDelta && (
          <span
            className={`mt-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-caption font-medium ${good ? "bg-success/10 text-success" : bad ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"}`}
          >
            {isUp ? (
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            ) : isDown ? (
              <ArrowDownRight className="h-3.5 w-3.5" aria-hidden="true" />
            ) : null}
            {`${delta > 0 ? "+" : ""}${delta.toFixed(1)}% vs período anterior`}
          </span>
        )}
      </CardContent>
    </Card>
  );
}

function ActivityRow({ activity }: { activity: TodayActivity }) {
  const iconMap = { call: Phone, task: FileText, note: StickyNote } as const;
  const labelMap = { call: "Ligação", task: "Tarefa", note: "Nota" } as const;
  const Icon = iconMap[activity.type] ?? FileText;
  return (
    <li className="flex items-center gap-3 py-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-body font-medium text-foreground">{activity.title}</p>
        <p className="text-caption text-muted-foreground">
          {labelMap[activity.type] ?? activity.type}
        </p>
      </div>
      <span className="text-caption font-medium text-muted-foreground">
        {formatTime(activity.due_at)}
      </span>
    </li>
  );
}

function LeadRow({ lead }: { lead: UnansweredLead }) {
  return (
    <li className="flex items-center gap-3 py-3">
      <InitialsAvatar name={lead.name} variant="muted" size="lg" />
      <div className="min-w-0 flex-1">
        <Link
          to="/inbox"
          className="truncate text-body font-medium text-foreground hover:underline"
        >
          {lead.name}
        </Link>
        {lead.channel && <p className="text-caption text-muted-foreground">{lead.channel}</p>}
      </div>
      {/* `--warning-foreground` é a cor de texto para fundo warning SÓLIDO e
          continua escura no tema escuro — aqui o texto fica solto sobre o fundo
          da página, então nos três visuais escuros ele virava #05152b sobre
          fundo quase preto (contraste medido: 1.01 a 1.10, ilegível). No claro
          esse mesmo token é o melhor que existe (17.49), por isso a troca é só
          no escuro. */}
      {lead.last_message_at && (
        <span className="shrink-0 text-caption font-medium text-warning-foreground dark:text-warning">
          esperando {relativeFromNow(lead.last_message_at)}
        </span>
      )}
    </li>
  );
}

function KpiSkeleton() {
  return (
    <Card>
      <CardHeader className="pb-2">
        <Skeleton className="h-3 w-24" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-8 w-20" />
        <Skeleton className="mt-3 h-3 w-28" />
      </CardContent>
    </Card>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-9 w-9 rounded-md" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}
