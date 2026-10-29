import { useQuery } from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/common/EmptyState";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile } from "@/lib/api/session";

/**
 * Card visual "Funil" — 3 barras horizontais (Em aberto / Ganho / Perdido)
 * com contagens no período/quadro selecionado. Query client-side em `deals`
 * (RLS aplica). Simples e independente das RPCs existentes.
 */
export function PipelineFunnelCard({
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
  const q = useFunnelCounts(from, to, ownerId, boardId);

  const rows: Array<{ key: "open" | "won" | "lost"; label: string; color: string }> = [
    { key: "open", label: "Em aberto", color: "bg-primary" },
    { key: "won", label: "Ganho", color: "bg-success" },
    { key: "lost", label: "Perdido", color: "bg-destructive" },
  ];

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-card-title">
          <BarChart3 className="h-4 w-4 text-primary" />
          Funil
        </CardTitle>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <div className="space-y-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : q.isError ? (
          <EmptyState
            icon={BarChart3}
            title="Não foi possível carregar"
            description={(q.error as Error)?.message ?? "Tente novamente em instantes."}
          />
        ) : !q.data || q.data.open + q.data.won + q.data.lost === 0 ? (
          <EmptyState
            icon={BarChart3}
            title="Sem negócios no período"
            description="Ajuste o período no filtro acima."
          />
        ) : (
          <div className="space-y-4">
            {rows.map((r) => {
              const value = q.data[r.key];
              const max = Math.max(q.data.open, q.data.won, q.data.lost, 1);
              const pct = Math.max(2, (value / max) * 100);
              return (
                <div key={r.key} className="flex items-center gap-3">
                  <span className="w-20 shrink-0 text-caption text-muted-foreground">
                    {r.label}
                  </span>
                  <div className="relative flex-1">
                    <div className="h-6 w-full overflow-hidden rounded-md bg-muted/50">
                      {value > 0 && (
                        <div
                          className={`h-full ${r.color} transition-all`}
                          style={{ width: `${pct}%` }}
                        />
                      )}
                    </div>
                  </div>
                  <span className="w-10 shrink-0 text-right tabular-nums text-body font-semibold">
                    {value}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function useFunnelCounts(from: Date, to: Date, ownerId: string | null, boardId: string | null) {
  const { data: profile } = useCurrentProfile();
  return useQuery({
    queryKey: [
      "dashboard-pipeline-funnel",
      profile?.tenant_id,
      from.toISOString(),
      to.toISOString(),
      ownerId,
      boardId,
    ],
    enabled: !!profile?.tenant_id,
    staleTime: 60 * 1000,
    queryFn: async () => {
      const build = (status: "open" | "won" | "lost") => {
        let query = supabase.from("deals").select("id", { count: "exact", head: true });
        if (status === "open") {
          query = query.eq("status", "open");
        } else {
          query = query
            .eq("status", status)
            .gte("stage_entered_at", from.toISOString())
            .lt("stage_entered_at", to.toISOString());
        }
        if (ownerId) query = query.eq("owner_id", ownerId);
        if (boardId) query = query.eq("board_id", boardId);
        return query;
      };
      const [openRes, wonRes, lostRes] = await Promise.all([
        build("open"),
        build("won"),
        build("lost"),
      ]);
      if (openRes.error) throw openRes.error;
      if (wonRes.error) throw wonRes.error;
      if (lostRes.error) throw lostRes.error;
      return {
        open: openRes.count ?? 0,
        won: wonRes.count ?? 0,
        lost: lostRes.count ?? 0,
      };
    },
  });
}
