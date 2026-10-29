import type { ReactNode } from "react";
import { AlertTriangle, TrendingUp } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type TriageFilter = "atrasados" | "hoje" | "pendencias";

export interface RiskDealItem {
  id: string;
  title: string;
  contactName: string | null;
  contactId: string | null;
}

export interface RiskConversationItem {
  id: string;
  contactName: string | null;
  contactId: string;
}

export interface OpportunityItem {
  contactId: string;
  contactName: string | null;
  rationale: string | null;
}

export interface InboxOverviewViewProps {
  overdueCount: number;
  todayCount: number;
  pendingCount: number;
  onOpenFilter: (filter: TriageFilter) => void;
  coldDeals: RiskDealItem[];
  coldConversations: RiskConversationItem[];
  onOpenDeal: () => void;
  onOpenConversation: (conversationId: string) => void;
  hotLeads: OpportunityItem[];
  onOpenContact: (contactId: string) => void;
  focusQueueEmpty: boolean;
  onStartFocus: () => void;
  /** Ação inline "Aplicar" — resgata o deal frio agendando um follow-up sem sair da tela. */
  onApplyDeal: (dealId: string, contactId: string) => void;
  /** Idem, para conversa fria. */
  onApplyConversation: (conversationId: string, contactId: string) => void;
  /** Idem, para lead quente (Oportunidades) — follow-up prioritário. */
  onApplyOpportunity: (contactId: string) => void;
  /** Chaves (`deal-<id>`/`conv-<id>`/`contactId`) das linhas com "Aplicar" em voo — cada uma desabilita/mostra spinner independentemente das demais. */
  applyingKeys: ReadonlySet<string>;
}

/**
 * Visão Geral da inbox: 3 cards de triagem (Atrasados/Hoje/Pendências) +
 * painéis Risco/Oportunidades. Adaptado do `InboxOverviewView` do medflow,
 * trocando StalledDeal/UpsellDeal/RescueContact por `isDealRotting` (deal) +
 * `isConversationCold` (conversa) para Risco, e `ai_lead_verdicts` p/
 * Oportunidades. Tokens semânticos sempre (success/warning/destructive) —
 * nunca cor hardcoded (cor de marca é por tenant).
 *
 * Cada item tem uma ação primária inline "Aplicar" (mirror do padrão de
 * aceitar sugestão em 1 clique do `NextBestActionCard`) — agenda um
 * follow-up via mutation já existente, sem sair da tela — e mantém a ação de
 * navegação original (Resgatar/Abrir) como secundária.
 */
export function InboxOverviewView({
  overdueCount,
  todayCount,
  pendingCount,
  onOpenFilter,
  coldDeals,
  coldConversations,
  onOpenDeal,
  onOpenConversation,
  hotLeads,
  onOpenContact,
  focusQueueEmpty,
  onStartFocus,
  onApplyDeal,
  onApplyConversation,
  onApplyOpportunity,
  applyingKeys,
}: InboxOverviewViewProps) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          label="Atrasados"
          value={overdueCount}
          tone={overdueCount > 0 ? "destructive" : "neutral"}
          onClick={() => onOpenFilter("atrasados")}
        />
        <StatCard
          label="Hoje"
          value={todayCount}
          tone={todayCount > 0 ? "warning" : "neutral"}
          onClick={() => onOpenFilter("hoje")}
        />
        <StatCard
          label="Pendências"
          value={pendingCount}
          tone={pendingCount > 0 ? "warning" : "neutral"}
          onClick={() => onOpenFilter("pendencias")}
        />
      </div>

      <div className="flex items-center justify-end">
        <Button onClick={onStartFocus} disabled={focusQueueEmpty}>
          Começar foco
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel
          icon={<AlertTriangle className="h-4 w-4 text-destructive" aria-hidden="true" />}
          title="Risco"
        >
          {coldDeals.length === 0 && coldConversations.length === 0 ? (
            <EmptyPanelText>Sem riscos destacados agora.</EmptyPanelText>
          ) : (
            <ul className="flex flex-col gap-2">
              {coldDeals.map((d) => {
                const dealKey = `deal-${d.id}`;
                const contactId = d.contactId;
                return (
                  <PanelRow
                    key={dealKey}
                    title={d.title}
                    subtitle={d.contactName ?? "Sem contato"}
                    actionLabel="Resgatar"
                    onAction={onOpenDeal}
                    primaryAction={
                      contactId
                        ? {
                            label: "Aplicar",
                            pendingLabel: "Aplicando…",
                            pending: applyingKeys.has(dealKey),
                            onClick: () => onApplyDeal(d.id, contactId),
                          }
                        : undefined
                    }
                  />
                );
              })}
              {coldConversations.map((c) => {
                const convKey = `conv-${c.id}`;
                return (
                  <PanelRow
                    key={convKey}
                    title={c.contactName ?? "Contato"}
                    subtitle="Conversa sem atividade há mais de 7 dias"
                    actionLabel="Abrir"
                    onAction={() => onOpenConversation(c.id)}
                    primaryAction={{
                      label: "Aplicar",
                      pendingLabel: "Aplicando…",
                      pending: applyingKeys.has(convKey),
                      onClick: () => onApplyConversation(c.id, c.contactId),
                    }}
                  />
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel
          icon={<TrendingUp className="h-4 w-4 text-success" aria-hidden="true" />}
          title="Oportunidades"
        >
          {hotLeads.length === 0 ? (
            <EmptyPanelText>Sem oportunidades quentes agora.</EmptyPanelText>
          ) : (
            <ul className="flex flex-col gap-2">
              {hotLeads.map((l) => (
                <PanelRow
                  key={l.contactId}
                  title={l.contactName ?? "Contato"}
                  subtitle={l.rationale ?? "Lead classificado como quente pela IA"}
                  actionLabel="Abrir"
                  onAction={() => onOpenContact(l.contactId)}
                  primaryAction={{
                    label: "Aplicar",
                    pendingLabel: "Aplicando…",
                    pending: applyingKeys.has(l.contactId),
                    onClick: () => onApplyOpportunity(l.contactId),
                  }}
                />
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
  onClick,
}: {
  label: string;
  value: number;
  tone: "destructive" | "warning" | "neutral";
  onClick: () => void;
}) {
  const toneClasses: Record<typeof tone, string> = {
    destructive: "border-destructive/25 bg-destructive/5 text-destructive",
    // Mesmo par de StatusBadge: o foreground do warning não inverte no escuro.
    warning: "border-warning/35 bg-warning/10 text-warning-foreground dark:text-warning",
    neutral: "border-border bg-card text-foreground",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-col items-start gap-1 rounded-lg border px-4 py-3 text-left transition-colors hover:bg-accent",
        toneClasses[tone],
      )}
    >
      <span className="text-caption font-medium text-muted-foreground">{label}</span>
      <span className="text-page-title font-semibold">{value}</span>
    </button>
  );
}

function Panel({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        {icon}
        <h3 className="text-card-title font-semibold text-foreground">{title}</h3>
      </div>
      {children}
    </div>
  );
}

function EmptyPanelText({ children }: { children: ReactNode }) {
  return <p className="text-body text-muted-foreground">{children}</p>;
}

interface PanelRowPrimaryAction {
  label: string;
  pendingLabel: string;
  pending: boolean;
  onClick: () => void;
}

function PanelRow({
  title,
  subtitle,
  actionLabel,
  onAction,
  primaryAction,
}: {
  title: string;
  subtitle: string;
  actionLabel: string;
  onAction: () => void;
  /** Ação inline "Aplicar" — quando ausente (ex.: deal frio sem contato vinculado), só a navegação secundária é exibida. */
  primaryAction?: PanelRowPrimaryAction;
}) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface px-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-body font-medium text-foreground">{title}</p>
        <p className="truncate text-caption text-muted-foreground">{subtitle}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {primaryAction && (
          <Button size="sm" onClick={primaryAction.onClick} disabled={primaryAction.pending}>
            {primaryAction.pending ? primaryAction.pendingLabel : primaryAction.label}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={onAction}>
          {actionLabel}
        </Button>
      </div>
    </li>
  );
}
