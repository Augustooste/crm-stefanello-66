import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CalendarClock, Send, ExternalLink } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { AiPersonaBadge } from "@/components/ai/ai-persona-badge";
import { supabase } from "@/integrations/supabase/client";
import { useCreateFollowup } from "@/hooks/use-followup-queue";
import { useCurrentProfile } from "@/lib/api/session";

interface DraftRow {
  id: string;
  conversation_id: string;
  content: string | null;
}

interface NextBestActionCardProps {
  tenantId: string;
  conversationId: string;
  contactId: string;
  // Compartilhado com a `DraftBubble` do thread (mesmo rascunho pode aparecer
  // nos dois lugares): mutation e id "em voo" vêm do pai para que aprovar por
  // aqui desabilite o botão "Aprovar e enviar" da bolha e vice-versa — evita
  // disparo duplicado de `messaging-send` para o mesmo `draft_message_id`.
  onApproveDraft: (draft: Pick<DraftRow, "id" | "conversation_id">) => void;
  approvingDraftId?: string;
}

interface VerdictRow {
  verdict: "hot" | "warm" | "cold";
  rationale: string | null;
}

const VERDICT_LABEL: Record<VerdictRow["verdict"], string> = {
  hot: "Lead quente",
  warm: "Lead morno",
  cold: "Lead frio",
};

/**
 * Bloco compacto de "próxima melhor ação" acima do composer — junta o
 * rascunho pendente da IA (se houver) e o veredito de qualificação do
 * contato (ai_lead_verdicts, hoje só escrito pelo fluxo de Meta Ads) num
 * único lugar de ação 1-clique. Vazio graciosamente (retorna null) quando
 * não há nada a sugerir — não polui o thread sem sinal real.
 */
export function NextBestActionCard({
  tenantId,
  conversationId,
  contactId,
  onApproveDraft,
  approvingDraftId,
}: NextBestActionCardProps) {
  const { data: profile } = useCurrentProfile();
  const navigate = useNavigate();
  const createFollowup = useCreateFollowup();

  const draftQuery = useQuery({
    queryKey: ["next-best-action-draft", conversationId],
    queryFn: async (): Promise<DraftRow | null> => {
      const { data, error } = await supabase
        .from("messages")
        .select("id, conversation_id, content")
        .eq("conversation_id", conversationId)
        .eq("status", "draft")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const verdictQuery = useQuery({
    queryKey: ["next-best-action-verdict", contactId],
    queryFn: async (): Promise<VerdictRow | null> => {
      const { data, error } = await supabase
        .from("ai_lead_verdicts")
        .select("verdict, rationale")
        .eq("contact_id", contactId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const verdict: VerdictRow["verdict"] =
        data.verdict === "hot" || data.verdict === "warm" || data.verdict === "cold"
          ? data.verdict
          : "warm";
      return { verdict, rationale: data.rationale };
    },
  });

  const dealQuery = useQuery({
    queryKey: ["next-best-action-deal", contactId],
    queryFn: async (): Promise<{ id: string } | null> => {
      const { data, error } = await supabase
        .from("deals")
        .select("id")
        .eq("contact_id", contactId)
        .or("status.is.null,status.eq.open")
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const followUpMutation = useMutation({
    mutationFn: async () => {
      if (!profile) throw new Error("Sem perfil");
      const dueAt = new Date();
      dueAt.setDate(dueAt.getDate() + 1);
      await createFollowup.mutateAsync({
        tenantId,
        contactId,
        scheduledAt: dueAt.toISOString(),
        createdBy: profile.id,
        source: "ai_suggested",
        aiSuggested: true,
      });
    },
    onSuccess: () => toast.success("Retorno marcado para amanhã."),
    onError: (e: Error) => toast.error(e.message || "Falha ao marcar retorno"),
  });

  const draft = draftQuery.data;
  const verdict = verdictQuery.data;
  const deal = dealQuery.data;

  if (!draft && !verdict) return null;

  return (
    <div className="rounded-lg border border-dashed border-primary/50 bg-primary/5 px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <AiPersonaBadge tenantId={tenantId} size="xs" />
        <span className="text-caption text-muted-foreground">Próxima melhor ação</span>
      </div>

      {verdict && (
        <p className="mb-1.5 text-caption text-foreground">
          <span className="font-medium">{VERDICT_LABEL[verdict.verdict]}</span>
          {verdict.rationale ? ` · ${verdict.rationale}` : ""}
        </p>
      )}

      {draft?.content && (
        <p className="mb-2 line-clamp-2 whitespace-pre-wrap text-caption text-muted-foreground">
          Rascunho: {draft.content}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {draft && (
          <Button
            size="sm"
            onClick={() => onApproveDraft(draft)}
            disabled={approvingDraftId === draft.id}
          >
            <Send className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="ml-1.5">
              {approvingDraftId === draft.id ? "Enviando…" : "Enviar draft"}
            </span>
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => followUpMutation.mutate()}
          disabled={followUpMutation.isPending || !profile}
        >
          <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="ml-1.5">Marcar retorno</span>
        </Button>
        {deal && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => navigate({ to: "/pipeline", search: { dealId: deal.id } })}
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="ml-1.5">Abrir negócio</span>
          </Button>
        )}
      </div>
    </div>
  );
}
