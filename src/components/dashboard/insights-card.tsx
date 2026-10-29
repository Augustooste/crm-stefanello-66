import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AiPersonaBadge } from "@/components/ai/ai-persona-badge";
import type { AiInsight, AiInsightsResponse } from "@/lib/api/reports";

export type InsightsState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: AiInsightsResponse };

const SEVERITY_LABEL: Record<AiInsight["severidade"], string> = {
  alta: "Alta",
  media: "Média",
  baixa: "Baixa",
};

function severityVariant(s: AiInsight["severidade"]): "destructive" | "default" | "secondary" {
  if (s === "alta") return "destructive";
  if (s === "media") return "default";
  return "secondary";
}

/**
 * Card de Insights de IA compartilhado entre Relatórios e Dashboard.
 * `maxItems` limita a lista (variante leve do dashboard mostra o topo e
 * remete a Relatórios para a análise completa); sem ele, mostra tudo.
 */
export function InsightsCard({
  state,
  onAnalyze,
  maxItems,
}: {
  state: InsightsState;
  onAnalyze: (force: boolean) => void;
  maxItems?: number;
}) {
  const all = state.kind === "ready" ? state.data.insights : [];
  const shown = maxItems ? all.slice(0, maxItems) : all;
  const hidden = all.length - shown.length;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-card-title">
          <AiPersonaBadge size="sm" />
          <span className="text-muted-foreground">· Destaques</span>
        </CardTitle>
        <Button
          size="sm"
          variant={state.kind === "ready" ? "outline" : "default"}
          disabled={state.kind === "loading"}
          onClick={() => onAnalyze(state.kind === "ready")}
        >
          {state.kind === "loading"
            ? "Analisando…"
            : state.kind === "ready"
              ? "Analisar novamente"
              : "Analisar"}
        </Button>
      </CardHeader>
      <CardContent>
        {state.kind === "idle" && (
          <p className="text-caption text-muted-foreground">
            A IA analisa os números do período e aponta gargalos com sugestões práticas. Nenhuma
            conversa ou dado pessoal é enviado — apenas métricas agregadas.
          </p>
        )}
        {state.kind === "loading" && (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        )}
        {state.kind === "error" && (
          <p className="text-caption text-destructive">
            Não foi possível gerar a análise: {state.message}
          </p>
        )}
        {state.kind === "ready" && (
          <div className="space-y-3">
            <ul className="space-y-3">
              {shown.map((ins, i) => (
                <li key={i} className="rounded-lg border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Badge variant={severityVariant(ins.severidade)}>
                          {SEVERITY_LABEL[ins.severidade]}
                        </Badge>
                        <span className="text-body font-medium">{ins.diagnostico}</span>
                      </div>
                      <p className="text-caption text-muted-foreground">{ins.sugestao}</p>
                    </div>
                    {ins.link && (
                      <Button asChild size="sm" variant="ghost" className="shrink-0">
                        <Link to={ins.link}>
                          Ver tela
                          <ArrowRight className="ml-1 h-3.5 w-3.5" />
                        </Link>
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {hidden > 0 && (
              <Button asChild size="sm" variant="ghost" className="px-0">
                <Link to="/relatorios">
                  Ver mais {hidden} em Relatórios
                  <ArrowRight className="ml-1 h-3.5 w-3.5" />
                </Link>
              </Button>
            )}
            <p className="text-caption text-muted-foreground">
              {state.data.cached ? "Análise em cache (últimas 24h) · " : ""}
              Gerada em {new Date(state.data.generated_at).toLocaleString("pt-BR")}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
