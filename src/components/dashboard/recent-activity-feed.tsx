import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Clock } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/common/EmptyState";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile } from "@/lib/api/session";
import { formatDateTime } from "@/lib/format";

/**
 * Feed cronológico das últimas atividades do tenant. Simples: últimas 15
 * linhas de `activities` (com nome do contato via embed), sem tentar
 * consolidar `deal_stage_history` — evita join extra e mantém a query
 * dentro dos limites do PostgREST. RLS aplica.
 */
export function RecentActivityFeed() {
  const q = useRecentActivities();

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-card-title">
          <Clock className="h-4 w-4 text-primary" />
          Atividades Recentes
        </CardTitle>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : q.isError ? (
          <EmptyState
            icon={Clock}
            title="Não foi possível carregar"
            description={(q.error as Error)?.message ?? "Tente novamente em instantes."}
          />
        ) : !q.data || q.data.length === 0 ? (
          <EmptyState
            icon={Clock}
            title="Nenhuma atividade recente"
            description="Novas ações aparecerão aqui conforme sua equipe operar o CRM."
          />
        ) : (
          <ul className="divide-y divide-border">
            {q.data.map((a) => (
              <li key={a.id} className="flex items-start gap-3 py-3">
                <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-success/10 text-success">
                  <CheckCircle2 className="h-4 w-4" aria-hidden />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-body font-medium text-foreground">
                    {a.title}
                    {a.contactName ? ` — ${a.contactName}` : ""}
                  </p>
                  {a.contactName && (
                    <p className="truncate text-caption text-muted-foreground">
                      em {a.contactName}
                    </p>
                  )}
                </div>
                <span className="shrink-0 rounded-md bg-muted/40 px-2 py-1 text-caption font-medium tabular-nums text-muted-foreground">
                  {formatDateTime(a.timestamp)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

type FeedItem = {
  id: string;
  title: string;
  contactName: string | null;
  timestamp: string;
};

function useRecentActivities() {
  const { data: profile } = useCurrentProfile();
  return useQuery<FeedItem[]>({
    queryKey: ["dashboard-recent-activities", profile?.tenant_id],
    enabled: !!profile?.tenant_id,
    staleTime: 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("activities")
        .select("id, title, created_at, completed_at, contact:contacts(name, deleted_at)")
        .order("created_at", { ascending: false })
        .limit(15);
      if (error) throw error;
      return (data ?? []).map((row) => {
        const r = row as unknown as {
          id: string;
          title: string;
          created_at: string;
          completed_at: string | null;
          contact: { name: string; deleted_at: string | null } | null;
        };
        return {
          id: r.id,
          title: r.title,
          contactName: r.contact?.deleted_at ? null : (r.contact?.name ?? null),
          timestamp: r.completed_at ?? r.created_at,
        };
      });
    },
  });
}
