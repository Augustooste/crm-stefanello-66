import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Clock, MessageSquare, Send, UserPlus } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/common/EmptyState";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { KpiCardInner, formatMinutes } from "@/components/dashboard/report-widgets";
import { useMessagingPerformance } from "@/lib/api/dashboard-widgets";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile, useTenantProfiles } from "@/lib/api/session";

/**
 * Card 2 — Performance de Mensagens.
 * Alinhamento com a referência:
 *  - Bloco "Mensagens Enviadas" com breakdown "X humanos, Y IA".
 *  - Bloco "Novos Contatos" com sub-linha de follow-ups.
 *  - Bloco "First Response Time" (FRT mediano).
 *  - Bloco "Taxa de Resposta" (X de Y conversas).
 *  - Filtro de vendedor próprio (Select no header), inicializado com o filtro
 *    global mas com escopo local (não altera o filtro dos outros cards).
 */
export function MessagingPerformanceCard({
  from,
  to,
  ownerId: globalOwnerId,
  boardId,
}: {
  from: Date;
  to: Date;
  ownerId: string | null;
  boardId: string | null;
}) {
  const [localOwnerId, setLocalOwnerId] = useState<string | null>(globalOwnerId);
  const profilesQ = useTenantProfiles();

  const q = useMessagingPerformance(from, to, localOwnerId, boardId);
  const extrasQ = useMessagingExtras(from, to, localOwnerId);

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle className="flex items-center gap-2 text-card-title">
          <MessageSquare className="h-4 w-4 text-primary" />
          Performance de Mensagens
        </CardTitle>
        <div className="flex items-center gap-2">
          <Select
            value={localOwnerId ?? "all"}
            onValueChange={(v) => setLocalOwnerId(v === "all" ? null : v)}
          >
            <SelectTrigger className="h-8 w-[180px]" aria-label="Filtrar por vendedor">
              <SelectValue placeholder="Todos os vendedores" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os vendedores</SelectItem>
              {(profilesQ.data ?? []).map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {q.isLoading || extrasQ.isLoading ? (
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : q.isError ? (
          <EmptyState
            icon={MessageSquare}
            title="Não foi possível carregar"
            description={(q.error as Error)?.message ?? "Tente novamente em instantes."}
          />
        ) : !q.data ? null : (
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <KpiCardInner
              icon={<Send className="h-4 w-4" />}
              label="Mensagens Enviadas"
              value={(q.data.msgs_humano + q.data.msgs_ia).toString()}
              hint={`${q.data.msgs_humano} humanos, ${q.data.msgs_ia} IA`}
            />
            <KpiCardInner
              icon={<UserPlus className="h-4 w-4" />}
              label="Novos contatos (todos os quadros)"
              value={(extrasQ.data?.novos_contatos ?? 0).toString()}
              hint={`${extrasQ.data?.follow_ups ?? 0} follow-ups em todos os quadros`}
            />
            <KpiCardInner
              icon={<Clock className="h-4 w-4" />}
              label="Tempo da 1ª resposta"
              value={
                q.data.frt_mediana_seg != null ? formatMinutes(q.data.frt_mediana_seg / 60) : "—"
              }
              hint={`${q.data.conversas_com_frt} conversas medidas`}
            />
            <KpiCardInner
              icon={<MessageSquare className="h-4 w-4" />}
              label="Taxa de Resposta"
              value={q.data.taxa_resposta_pct != null ? `${q.data.taxa_resposta_pct}%` : "—"}
              hint={`${q.data.conversas_com_frt} de ${q.data.conversas_total} conversas`}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Contatos criados no período e follow-ups pendentes/agendados, em todos os
 * quadros (escopo indicado junto às métricas). Período e vendedor continuam
 * aplicados; a RLS de contacts e deal_followups mantém o isolamento por tenant.
 */
function useMessagingExtras(from: Date, to: Date, ownerId: string | null) {
  const { data: profile } = useCurrentProfile();
  return useQuery({
    queryKey: [
      "dashboard-messaging-extras",
      profile?.tenant_id,
      from.toISOString(),
      to.toISOString(),
      ownerId,
    ],
    enabled: !!profile?.tenant_id,
    staleTime: 60 * 1000,
    queryFn: async () => {
      let contactsQuery = supabase
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .is("deleted_at", null)
        .gte("created_at", from.toISOString())
        .lt("created_at", to.toISOString());
      if (ownerId) contactsQuery = contactsQuery.eq("owner_id", ownerId);

      let followupsQuery = supabase
        .from("deal_followups")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending")
        .gte("scheduled_at", from.toISOString())
        .lt("scheduled_at", to.toISOString());
      if (ownerId) followupsQuery = followupsQuery.eq("created_by", ownerId);

      const [contactsRes, followupsRes] = await Promise.all([contactsQuery, followupsQuery]);
      if (contactsRes.error) throw contactsRes.error;
      if (followupsRes.error) throw followupsRes.error;
      return {
        novos_contatos: contactsRes.count ?? 0,
        follow_ups: followupsRes.count ?? 0,
      };
    },
  });
}
