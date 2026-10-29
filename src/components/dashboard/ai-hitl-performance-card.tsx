import { Link } from "@tanstack/react-router";
import { ArrowRight, Bot, CircleAlert, Gauge, Radio } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/common/EmptyState";
import { KpiCardInner } from "@/components/dashboard/report-widgets";
import { useAiHitlPerformance } from "@/lib/api/dashboard-widgets";

/**
 * Card 3 — Performance da IA / HITL, no período/responsável/board do filtro
 * global. "Taxa de aprovação" mede aprovação de SUGESTÃO DE AVANÇO DE
 * ESTÁGIO (ai_pending_stage_advances) -- ver comentário na migration
 * dashboard_ai_hitl_performance() sobre a divergência com "draft de
 * mensagem" (feature que não existe hoje neste schema).
 */
export function AiHitlPerformanceCard({
  from,
  to,
  ownerId,
  boardId,
}: {
  from: Date;
  to: Date;
  ownerId: string | null;
  boardId: string | null;
}) {
  const q = useAiHitlPerformance(from, to, ownerId, boardId);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div className="flex items-center gap-2">
          <CardTitle className="text-card-title">Performance da IA (revisão humana)</CardTitle>
        </div>
        <Link
          to="/decisions"
          className="flex items-center gap-1 text-caption font-medium text-primary hover:underline"
        >
          Ver fila
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <div className="grid grid-cols-2 gap-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : q.isError ? (
          <EmptyState
            icon={CircleAlert}
            title="Não foi possível carregar"
            description={(q.error as Error)?.message ?? "Tente novamente em instantes."}
          />
        ) : !q.data ? (
          <EmptyState icon={Bot} title="Sem dados de IA no período" />
        ) : (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <KpiCardInner
                icon={<CircleAlert className="h-4 w-4" />}
                label="Aguardando humano"
                value={q.data.aguardando_humano.toString()}
                hint="Conversas em atendimento humano agora"
              />
            </div>
            <div>
              <KpiCardInner
                icon={<Gauge className="h-4 w-4" />}
                label="Taxa de aprovação"
                value={q.data.taxa_aprovacao_pct != null ? `${q.data.taxa_aprovacao_pct}%` : "—"}
                hint={`${q.data.avancos_aprovados_humano} aprovados (${q.data.drafts_aprovados_sem_edicao} sem edição · ${q.data.drafts_editados} editados) · ${q.data.avancos_rejeitados} rejeitados`}
              />
            </div>
            <div>
              <KpiCardInner
                icon={<Bot className="h-4 w-4" />}
                label="Auto-avanços"
                value={q.data.auto_avancos.toString()}
                hint="Avanços de estágio aprovados automaticamente"
              />
            </div>
            <div>
              <KpiCardInner
                icon={<CircleAlert className="h-4 w-4" />}
                label="Sugestões pendentes"
                value={q.data.sugestoes_pendentes.toString()}
                hint="Avanços de estágio aguardando revisão humana"
              />
            </div>
            <div>
              <KpiCardInner
                icon={<Radio className="h-4 w-4" />}
                label="Cobertura de IA (24h)"
                value={`${q.data.cobertura_24h_pct}%`}
                hint="Horas do dia com ao menos 1 resposta da IA"
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
