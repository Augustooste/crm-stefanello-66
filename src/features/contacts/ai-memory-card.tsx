import { useQuery } from "@tanstack/react-query";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/common/EmptyState";
import { supabase } from "@/integrations/supabase/client";
import { formatDateTime, relativeFromNow } from "@/lib/format";
import type { Json } from "@/integrations/supabase/types";
import type { ActivityTimelineSource, FollowupTimelineSource } from "@/lib/contact-timeline";

// ─── Tipos de linha (mesmo shape das tabelas, ver migrations
// 20260709110000_fase2_ia_profunda_schema.sql e
// 20260712120200_fase6_meta_ads_verdicts.sql) ────────────────────────────────

type Verdict = "hot" | "warm" | "cold";

interface VerdictRow {
  verdict: Verdict;
  rationale: string | null;
}

type Sentiment = "positive" | "neutral" | "negative" | "frustrated";

export interface ConversationSummaryRow {
  id: string;
  summary: string;
  sentiment: Sentiment | null;
  key_facts: string[];
  commitments: string[];
  objections: string[];
  open_questions: string[];
  period_end: string;
}

export interface OpenDealSignal {
  id: string;
  title: string;
  stageName: string | null;
}

const VERDICT_LABEL: Record<Verdict, string> = {
  hot: "Lead quente",
  warm: "Lead morno",
  cold: "Lead frio",
};

const VERDICT_VARIANT: Record<Verdict, "success" | "warning" | "neutral"> = {
  hot: "success",
  warm: "warning",
  cold: "neutral",
};

const SENTIMENT_LABEL: Record<string, string> = {
  positive: "Positivo",
  neutral: "Neutro",
  negative: "Negativo",
  frustrated: "Frustrado",
};

const SUMMARIES_LIMIT = 5;

// ─── Perfil consolidado (tier-2, contacts.ai_memory) ────────────────────────
//
// Shape documentado em 20260709110000_fase2_ia_profunda_schema.sql:186-188 —
// não há constraint de schema no jsonb, então lemos com guards defensivos em
// vez de um cast direto (a consolidação tier-2 nem está agendada ainda, ver
// docs do PR; a coluna pode conter qualquer coisa ou nada).

function asRecord(json: Json | null): Record<string, Json | undefined> | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  return json;
}

function asNonEmptyString(value: Json | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asStringArray(value: Json | undefined): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function asSentiment(value: string | null): Sentiment | null {
  return value === "positive" ||
    value === "neutral" ||
    value === "negative" ||
    value === "frustrated"
    ? value
    : null;
}

// Perfil consolidado só é exibido quando pelo menos um campo de conteúdo real
// existe — um `{}` (coluna inicializada mas nunca consolidada) não deve
// renderizar um card com só o título e nada dentro.
function hasProfileContent(profile: Record<string, Json | undefined>): boolean {
  return (
    asNonEmptyString(profile.history_summary) !== null ||
    asNonEmptyString(profile.personality) !== null ||
    asStringArray(profile.preferences).length > 0 ||
    asStringArray(profile.important_dates).length > 0 ||
    asNonEmptyString(profile.relationship_notes) !== null
  );
}

function latestCompletedAt(activities: readonly ActivityTimelineSource[]): Date | null {
  const dates = activities
    .filter((a): a is ActivityTimelineSource & { completed_at: string } => a.completed_at != null)
    .map((a) => new Date(a.completed_at));
  return dates.length > 0 ? dates.reduce((latest, d) => (d > latest ? d : latest)) : null;
}

function nextPendingFollowup(
  followups: readonly FollowupTimelineSource[],
): FollowupTimelineSource | null {
  const pending = followups.filter((f) => f.status === "pending");
  if (pending.length === 0) return null;
  return pending.reduce((earliest, f) =>
    new Date(f.scheduled_at) < new Date(earliest.scheduled_at) ? f : earliest,
  );
}

interface AiMemoryCardProps {
  contactId: string;
  tags: string[] | null;
  aiMemory: Json | null;
  openDeal: OpenDealSignal | null;
  followups: readonly FollowupTimelineSource[];
  activities: readonly ActivityTimelineSource[];
  lastMessageAt: string | null;
}

/**
 * "Memória de IA" por contato — Opção A do spec: card 100% read-only sobre
 * dados já existentes, ZERO chamada de LLM nova, zero cron, zero schema novo.
 * Junta:
 * 1) veredito de qualificação (`ai_lead_verdicts`, hoje só escrito pelo fluxo
 *    Meta Ads, mesmo select de `next-best-action-card.tsx`);
 * 2) resumos tier-1 de conversa (`ai_conversation_summaries`, já gerados pelo
 *    fluxo de resposta da IA em `supabase/functions/_shared/ai/memory-summary.ts`,
 *    nunca exibidos em nenhuma tela até este card);
 * 3) sinais derivados do CRM (SQL/JS puro, sem IA) — calculados aqui a partir
 *    de dados que o componente pai (`_app.contatos.$id.tsx`) já buscou, para
 *    não duplicar query;
 * 4) perfil consolidado tier-2 (`contacts.ai_memory`), exibido só quando
 *    existe — a consolidação tier-2 não está agendada, então a seção some
 *    graciosamente para a maioria dos contatos hoje.
 *
 * Fora de escopo desta v1 (enhancement opcional, ver PR): botão "Gerar/
 * atualizar memória" disparando a consolidação tier-2 sob demanda.
 */
export function AiMemoryCard({
  contactId,
  tags,
  aiMemory,
  openDeal,
  followups,
  activities,
  lastMessageAt,
}: AiMemoryCardProps) {
  const verdictQuery = useQuery({
    queryKey: ["ai-memory-verdict", contactId],
    queryFn: async (): Promise<VerdictRow | null> => {
      const { data, error } = await supabase
        .from("ai_lead_verdicts")
        .select("verdict, rationale")
        .eq("contact_id", contactId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const verdict: Verdict =
        data.verdict === "hot" || data.verdict === "warm" || data.verdict === "cold"
          ? data.verdict
          : "warm";
      return { verdict, rationale: data.rationale };
    },
  });

  const summariesQuery = useQuery({
    queryKey: ["ai-memory-summaries", contactId],
    queryFn: async (): Promise<ConversationSummaryRow[]> => {
      const { data, error } = await supabase
        .from("ai_conversation_summaries")
        .select(
          "id, summary, sentiment, key_facts, commitments, objections, open_questions, period_end",
        )
        .eq("contact_id", contactId)
        .order("period_end", { ascending: false })
        .limit(SUMMARIES_LIMIT);
      if (error) throw error;
      return (data ?? []).map((row) => ({ ...row, sentiment: asSentiment(row.sentiment) }));
    },
  });

  const verdict = verdictQuery.data;
  const summaries = summariesQuery.data ?? [];
  const profile = asRecord(aiMemory);
  const showProfile = profile !== null && hasProfileContent(profile);
  const lastConsolidatedAt = profile ? asNonEmptyString(profile.last_consolidated_at) : null;
  const lastActivity = latestCompletedAt(activities);
  const nextFollowup = nextPendingFollowup(followups);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-card-title">Sinais do CRM</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SignalField
            label="Última mensagem"
            value={lastMessageAt ? relativeFromNow(lastMessageAt) : "—"}
          />
          <SignalField
            label="Última interação concluída"
            value={lastActivity ? relativeFromNow(lastActivity.toISOString()) : "—"}
          />
          <SignalField
            label="Próximo retorno"
            value={
              nextFollowup
                ? `${formatDateTime(nextFollowup.scheduled_at)}${
                    nextFollowup.description ? ` · ${nextFollowup.description}` : ""
                  }`
                : "—"
            }
          />
          <SignalField
            label="Negócio aberto"
            value={
              openDeal
                ? `${openDeal.title}${openDeal.stageName ? ` · ${openDeal.stageName}` : ""}`
                : "—"
            }
          />
          <div className="sm:col-span-2 space-y-1">
            <div className="text-caption text-muted-foreground">Tags</div>
            <div className="flex flex-wrap gap-1">
              {tags && tags.length > 0 ? (
                tags.map((t) => (
                  <StatusBadge key={t} variant="neutral">
                    {t}
                  </StatusBadge>
                ))
              ) : (
                <span className="text-body text-foreground">—</span>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-card-title">Veredito de qualificação</CardTitle>
        </CardHeader>
        <CardContent>
          {verdictQuery.isLoading ? (
            <Skeleton className="h-6 w-40" />
          ) : verdict ? (
            <div className="flex items-start gap-2">
              <StatusBadge variant={VERDICT_VARIANT[verdict.verdict]}>
                {VERDICT_LABEL[verdict.verdict]}
              </StatusBadge>
              {verdict.rationale && (
                <p className="text-body text-muted-foreground">{verdict.rationale}</p>
              )}
            </div>
          ) : (
            <p className="text-body text-muted-foreground">
              Sem veredito de qualificação para este contato ainda.
            </p>
          )}
        </CardContent>
      </Card>

      {showProfile && profile && (
        <Card>
          <CardHeader>
            <CardTitle className="text-card-title">Perfil consolidado</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {asNonEmptyString(profile.history_summary) && (
              <p className="text-body text-foreground">
                {asNonEmptyString(profile.history_summary)}
              </p>
            )}
            {asNonEmptyString(profile.personality) && (
              <p className="text-caption text-muted-foreground">
                Personalidade: {asNonEmptyString(profile.personality)}
              </p>
            )}
            {asStringArray(profile.preferences).length > 0 && (
              <p className="text-caption text-muted-foreground">
                Preferências: {asStringArray(profile.preferences).join(", ")}
              </p>
            )}
            {asStringArray(profile.important_dates).length > 0 && (
              <p className="text-caption text-muted-foreground">
                Datas importantes: {asStringArray(profile.important_dates).join(", ")}
              </p>
            )}
            {asNonEmptyString(profile.relationship_notes) && (
              <p className="text-caption text-muted-foreground">
                {asNonEmptyString(profile.relationship_notes)}
              </p>
            )}
            {lastConsolidatedAt && (
              <p className="text-caption text-muted-foreground">
                Consolidado {relativeFromNow(lastConsolidatedAt)}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-card-title">Resumos de interações recentes</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {summariesQuery.isLoading ? (
            <div className="p-4">
              <Skeleton className="h-16 w-full" />
            </div>
          ) : summaries.length === 0 ? (
            <div className="p-6">
              <EmptyState
                title="Sem resumos ainda"
                description="Nenhum resumo de conversa foi gerado para este contato ainda."
              />
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {summaries.map((s) => (
                <li key={s.id} className="flex flex-col gap-1.5 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-caption text-muted-foreground">
                      {formatDateTime(s.period_end)}
                    </span>
                    {s.sentiment && (
                      <StatusBadge variant="neutral">
                        {SENTIMENT_LABEL[s.sentiment] ?? s.sentiment}
                      </StatusBadge>
                    )}
                  </div>
                  <p className="text-body text-foreground">{s.summary}</p>
                  {s.key_facts.length > 0 && (
                    <p className="text-caption text-muted-foreground">
                      Fatos: {s.key_facts.join(" · ")}
                    </p>
                  )}
                  {s.commitments.length > 0 && (
                    <p className="text-caption text-muted-foreground">
                      Compromissos: {s.commitments.join(" · ")}
                    </p>
                  )}
                  {s.objections.length > 0 && (
                    <p className="text-caption text-muted-foreground">
                      Objeções: {s.objections.join(" · ")}
                    </p>
                  )}
                  {s.open_questions.length > 0 && (
                    <p className="text-caption text-muted-foreground">
                      Perguntas em aberto: {s.open_questions.join(" · ")}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SignalField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-caption text-muted-foreground">{label}</div>
      <div className="text-body text-foreground">{value}</div>
    </div>
  );
}
