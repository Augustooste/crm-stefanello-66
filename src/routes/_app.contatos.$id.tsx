import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link, notFound, useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRightLeft,
  CalendarClock,
  CalendarPlus,
  CheckCircle2,
  ExternalLink,
  Handshake,
  Mail,
  MessageSquare,
  Pencil,
  Phone,
  PhoneCall,
  Sparkles,
  StickyNote,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { PageHeader } from "@/components/common/PageHeader";
import { StatusBadge } from "@/components/common/StatusBadge";
import { ContactFormDialog, type ContactRow } from "@/components/contacts/ContactFormDialog";
import { RetornoDialog } from "@/components/contacts/RetornoDialog";
import { ExtractedFieldsCard } from "@/components/contacts/ExtractedFieldsCard";
import { LigarComIaDialog } from "@/components/voice/LigarComIaDialog";
import { VoiceCallDetailsButtons } from "@/components/voice/VoiceCallDetailsButtons";
import { useContactVoiceCalls, useVoiceServiceStatus } from "@/lib/api/voice-calls";
import { FollowUpSuggestionBanner } from "@/components/inbox/FollowUpSuggestionBanner";
import { AiMemoryCard, type OpenDealSignal } from "@/features/contacts/ai-memory-card";
import { useAppointmentLabel } from "@/routes/_app.agenda";
import { usePluginActive } from "@/lib/api/plugins";
import { useCurrentProfile } from "@/lib/api/session";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { iniciaisDe } from "@/components/common/InitialsAvatar";
import { useContactAvatarUrl } from "@/lib/api/contact-avatar";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/common/EmptyState";
import { supabase } from "@/integrations/supabase/client";
import { formatBRL, formatDate, formatDateTime, formatUSD, relativeFromNow } from "@/lib/format";
import type { Json } from "@/integrations/supabase/types";
import {
  buildContactTimeline,
  paginateTimeline,
  type ContactNoteSource,
  type FollowupTimelineSource,
  type MessageTimelineSource,
  type StageChangeTimelineSource,
  type TimelineEvent,
  type TimelineEventKind,
} from "@/lib/contact-timeline";
import { ContactQualificationCard } from "@/components/contacts/ContactQualificationCard";

export const Route = createFileRoute("/_app/contatos/$id")({
  head: ({ params }) => {
    const url = `https://aceleraflow.lovable.app/contatos/${params.id}`;
    const title = "Contato";
    const description = "Perfil do contato: dados, conversas, negócios e histórico.";
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        { property: "og:url", content: url },
        { name: "twitter:title", content: title },
        { name: "twitter:description", content: description },
        { name: "robots", content: "noindex" },
      ],
      links: [{ rel: "canonical", href: url }],
    };
  },
  component: ContactDetail,
  notFoundComponent: () => (
    <div className="col-span-12">
      <EmptyState title="Contato não encontrado" description="Este contato não existe mais." />
    </div>
  ),
});

function ContactAvatar({
  avatarPath,
  name,
}: {
  avatarPath: string | null | undefined;
  name: string;
}) {
  const { data: url } = useContactAvatarUrl(avatarPath);
  return (
    <Avatar className="h-14 w-14">
      {url ? <AvatarImage src={url} alt={name} /> : null}
      <AvatarFallback className="bg-primary text-primary-foreground text-body font-semibold">
        {iniciaisDe(name)}
      </AvatarFallback>
    </Avatar>
  );
}

type DealRow = {
  id: string;
  title: string;
  value: number | null;
  status: string | null;
  lost_reason?: string | null;
  stage: { name: string; is_won: boolean; is_lost: boolean } | null;
};

type ActivityRow = {
  id: string;
  title: string;
  type: string;
  due_at: string | null;
  completed_at: string | null;
  created_at: string;
};

type ContactDetailRow = ContactRow & {
  deleted_at: string | null;
  merged_into_id: string | null;
  ai_memory: Json | null;
};

type StageHistoryRow = {
  id: string;
  deal_id: string;
  from_stage_id: string | null;
  to_stage_id: string | null;
  created_at: string;
  deal: { title: string } | null;
};

const TIMELINE_SOURCE_FETCH_LIMIT = 100;
const TIMELINE_PAGE_SIZE = 50;

const timelineIcons: Record<TimelineEventKind, typeof StickyNote> = {
  note: StickyNote,
  activity: CheckCircle2,
  followup: CalendarClock,
  stage_change: ArrowRightLeft,
  message: MessageSquare,
  call: PhoneCall,
};

type ConversationRow = {
  id: string;
  status: string;
  last_message_at: string | null;
  channel: { type: string } | null;
  last_message: { content: string | null; created_at: string } | null;
};

const channelLabel: Record<string, string> = { whatsapp: "WhatsApp", email: "E-mail" };

interface InvokeErrorContext {
  status?: number;
  json?: () => Promise<unknown>;
}

// Mesmo padrão de src/routes/f.$formId.tsx: supabase.functions.invoke() não
// coloca o corpo de um status não-2xx em `data` -- ele vira um
// FunctionsHttpError genérico em `error`. O corpo real ({error: "..."}) só
// está acessível via error.context.json(). Sem isto, o toast mostraria
// "Edge Function returned a non-2xx status code" em vez da mensagem amigável
// que lead-enrich devolve (ex.: "Integração Apify não conectada...").
async function extractInvokeErrorMessage(error: unknown): Promise<string> {
  const context = (error as { context?: InvokeErrorContext } | null)?.context;
  if (context?.json) {
    try {
      const body = await context.json();
      const message =
        body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
      if (typeof message === "string" && message.trim()) return message;
    } catch {
      // Corpo não é JSON válido -- cai no fallback abaixo.
    }
  }
  return "Não foi possível enriquecer o contato. Tente novamente em instantes.";
}

function ContactDetail() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [openEdit, setOpenEdit] = useState(false);
  const [openRetorno, setOpenRetorno] = useState(false);
  const [openLigarIa, setOpenLigarIa] = useState(false);
  const voiceCallsQuery = useContactVoiceCalls(id);
  const voiceStatusQuery = useVoiceServiceStatus();
  const voiceConfigured = voiceStatusQuery.data?.configured === true;
  const [notesDraft, setNotesDraft] = useState("");
  const appointmentLabel = useAppointmentLabel();
  const agendaActive = usePluginActive("agenda");
  const { data: profile } = useCurrentProfile();
  const companiesActive = usePluginActive("companies");

  const contactQuery = useQuery({
    queryKey: ["contact", id],
    queryFn: async () => {
      // Busca por id direto (não é lista) -- não filtra deleted_at/merged_into_id:
      // um contato fundido/removido ainda precisa carregar aqui para exibirmos o
      // aviso abaixo (ver `deleted_at`/`merged_into_id` no JSX), em vez de um 404.
      const { data, error } = await supabase
        .from("contacts")
        .select(
          "id, tenant_id, name, phone, email, source, tags, notes, ai_paused, created_at, deleted_at, merged_into_id, ai_memory, company_id, status, job_title, department, address_street, address_city, address_state, address_zip, address_country, birthday, website, instagram, linkedin, description, avatar_url",
        )
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      return (data as ContactDetailRow) ?? null;
    },
  });

  const dealsQuery = useQuery({
    queryKey: ["contact-deals", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deals")
        .select("id, title, value, status, lost_reason, stage:board_stages(name, is_won, is_lost)")
        .eq("contact_id", id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as DealRow[];
    },
  });

  const activitiesQuery = useQuery({
    queryKey: ["contact-activities", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("activities")
        .select("id, title, type, due_at, completed_at, created_at")
        .eq("contact_id", id)
        .order("due_at", { ascending: false, nullsFirst: false });
      if (error) throw error;
      return (data ?? []) as ActivityRow[];
    },
  });

  const conversationsQuery = useQuery({
    queryKey: ["contact-conversations", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select("id, status, last_message_at, channel:channels!conversations_channel_id_fkey(type)")
        .eq("contact_id", id)
        .is("deleted_at", null)
        .order("last_message_at", { ascending: false, nullsFirst: false });
      if (error) throw error;
      const convs = (data ?? []) as unknown as ConversationRow[];
      if (convs.length > 0) {
        const { data: msgs, error: mErr } = await supabase
          .from("messages")
          .select("conversation_id, content, created_at")
          .in(
            "conversation_id",
            convs.map((c) => c.id),
          )
          .order("created_at", { ascending: false });
        if (mErr) throw mErr;
        const lastByConv = new Map<string, { content: string | null; created_at: string }>();
        for (const m of msgs ?? []) {
          if (!lastByConv.has(m.conversation_id)) {
            lastByConv.set(m.conversation_id, { content: m.content, created_at: m.created_at });
          }
        }
        for (const c of convs) c.last_message = lastByConv.get(c.id) ?? null;
      }
      return convs;
    },
  });

  const notesFeedQuery = useQuery({
    queryKey: ["contact-notes-feed", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("contact_notes")
        .select("id, content, created_at")
        .eq("contact_id", id)
        .order("created_at", { ascending: false })
        .limit(TIMELINE_SOURCE_FETCH_LIMIT);
      if (error) throw error;
      return (data ?? []) as ContactNoteSource[];
    },
  });

  const followupsQuery = useQuery({
    queryKey: ["contact-followups", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deal_followups")
        .select("id, description, scheduled_at, completed_at, status")
        .eq("contact_id", id)
        .order("scheduled_at", { ascending: false })
        .limit(TIMELINE_SOURCE_FETCH_LIMIT);
      if (error) throw error;
      return (data ?? []) as FollowupTimelineSource[];
    },
  });

  const dealIds = useMemo(() => (dealsQuery.data ?? []).map((d) => d.id), [dealsQuery.data]);

  const stageHistoryQuery = useQuery({
    queryKey: ["contact-stage-history", id, dealIds],
    enabled: dealIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deal_stage_history")
        .select("id, deal_id, from_stage_id, to_stage_id, created_at, deal:deals(title)")
        .in("deal_id", dealIds)
        .order("created_at", { ascending: false })
        .limit(TIMELINE_SOURCE_FETCH_LIMIT);
      if (error) throw error;
      const rows = (data ?? []) as unknown as StageHistoryRow[];

      const stageIds = Array.from(
        new Set(
          rows.flatMap((r) => [r.from_stage_id, r.to_stage_id]).filter((v): v is string => !!v),
        ),
      );
      const stageNames = new Map<string, string>();
      if (stageIds.length > 0) {
        const { data: stages, error: sErr } = await supabase
          .from("board_stages")
          .select("id, name")
          .in("id", stageIds);
        if (sErr) throw sErr;
        for (const s of (stages ?? []) as { id: string; name: string }[])
          stageNames.set(s.id, s.name);
      }

      return rows.map((r): StageChangeTimelineSource => ({
        id: r.id,
        deal_title: r.deal?.title ?? null,
        from_stage_name: r.from_stage_id ? (stageNames.get(r.from_stage_id) ?? null) : null,
        to_stage_name: r.to_stage_id ? (stageNames.get(r.to_stage_id) ?? null) : null,
        created_at: r.created_at,
      }));
    },
  });

  const conversationIds = useMemo(
    () => (conversationsQuery.data ?? []).map((c) => c.id),
    [conversationsQuery.data],
  );

  const timelineMessagesQuery = useQuery({
    queryKey: ["contact-timeline-messages", id, conversationIds],
    enabled: conversationIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("messages")
        .select("id, conversation_id, content, created_at, sender")
        .in("conversation_id", conversationIds)
        .order("created_at", { ascending: false })
        .limit(TIMELINE_SOURCE_FETCH_LIMIT);
      if (error) throw error;
      return (data ?? []) as {
        id: string;
        conversation_id: string;
        content: string | null;
        created_at: string;
        sender: string;
      }[];
    },
  });

  const contact = contactQuery.data;

  const mergedIntoQuery = useQuery({
    queryKey: ["contact-merged-into", contact?.merged_into_id],
    enabled: !!contact?.merged_into_id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("contacts")
        .select("id, name")
        .eq("id", contact!.merged_into_id!)
        .maybeSingle();
      if (error) throw error;
      return data as { id: string; name: string } | null;
    },
  });

  const companyQuery = useQuery({
    queryKey: ["contact-company", contact?.company_id],
    enabled: !!contact?.company_id && companiesActive,
    queryFn: async () => {
      // .is("deleted_at", null) -- defesa em profundidade: uma empresa
      // soft-deletada nunca deve renderizar como link vivo aqui (cai no "—"
      // abaixo em vez de apontar pra um registro que não existe mais pro
      // usuário).
      const { data, error } = await supabase
        .from("crm_companies")
        .select("id, name")
        .eq("id", contact!.company_id!)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) throw error;
      return data as { id: string; name: string } | null;
    },
  });

  const channelByConversation = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const c of conversationsQuery.data ?? []) map.set(c.id, c.channel?.type ?? null);
    return map;
  }, [conversationsQuery.data]);

  const timelineMessages: MessageTimelineSource[] = useMemo(
    () =>
      (timelineMessagesQuery.data ?? []).map((m) => ({
        id: m.id,
        content: m.content,
        created_at: m.created_at,
        channel_type: channelByConversation.get(m.conversation_id) ?? null,
      })),
    [timelineMessagesQuery.data, channelByConversation],
  );

  const timelineEvents: TimelineEvent[] = useMemo(
    () =>
      buildContactTimeline({
        notes: notesFeedQuery.data,
        activities: activitiesQuery.data,
        followups: followupsQuery.data,
        stageChanges: stageHistoryQuery.data,
        messages: timelineMessages,
        calls: voiceCallsQuery.data,
      }),
    [
      voiceCallsQuery.data,
      notesFeedQuery.data,
      activitiesQuery.data,
      followupsQuery.data,
      stageHistoryQuery.data,
      timelineMessages,
    ],
  );

  // Sinais derivados do CRM para o card "Memória IA" -- SQL/JS puro sobre
  // dados já buscados acima (dealsQuery/conversationsQuery), sem query nova.
  const openDeal: OpenDealSignal | null = useMemo(() => {
    const deal = (dealsQuery.data ?? []).find((d) => d.status !== "won" && d.status !== "lost");
    return deal ? { id: deal.id, title: deal.title, stageName: deal.stage?.name ?? null } : null;
  }, [dealsQuery.data]);

  const lastMessageAt = useMemo(() => {
    const dates = (conversationsQuery.data ?? [])
      .map((c) => c.last_message_at)
      .filter((d): d is string => !!d);
    return dates.length > 0
      ? dates.reduce((latest, d) => (new Date(d) > new Date(latest) ? d : latest))
      : null;
  }, [conversationsQuery.data]);

  // `FollowUpSuggestionBanner` espera as mensagens em ordem cronológica
  // (mais antiga primeiro) -- o oposto da ordem usada por `timelineMessages`
  // (mais recente primeiro, para paginação da timeline). Reordena aqui em vez
  // de mudar a query, que outras partes da tela já dependem da ordem desc.
  const followUpBannerMessages = useMemo(
    () =>
      [...(timelineMessagesQuery.data ?? [])]
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
        .map((m) => ({
          sender: (m.sender === "contact" || m.sender === "ai" ? m.sender : "agent") as
            "contact" | "agent" | "ai",
          content: m.content,
        })),
    [timelineMessagesQuery.data],
  );

  const [timelineVisibleCount, setTimelineVisibleCount] = useState(TIMELINE_PAGE_SIZE);
  const { items: visibleTimelineEvents, hasMore: timelineHasMore } = paginateTimeline(
    timelineEvents,
    timelineVisibleCount,
  );

  const timelineLoading =
    notesFeedQuery.isLoading ||
    activitiesQuery.isLoading ||
    followupsQuery.isLoading ||
    (dealIds.length > 0 && stageHistoryQuery.isLoading) ||
    (conversationIds.length > 0 && timelineMessagesQuery.isLoading);

  // Timeline mescla 5 fontes independentes; se uma falhar, buildContactTimeline
  // trata a ausência de dado igual a "fonte vazia de verdade" -- sem isto, o
  // usuário veria uma timeline incompleta sem saber que faltou algo. Inclui
  // dealsQuery/conversationsQuery porque sua falha zera dealIds/conversationIds
  // e desliga (enabled: false) stageHistoryQuery/timelineMessagesQuery inteiras,
  // sem que o isError delas entre em jogo.
  const timelineError =
    notesFeedQuery.isError ||
    activitiesQuery.isError ||
    followupsQuery.isError ||
    stageHistoryQuery.isError ||
    timelineMessagesQuery.isError ||
    voiceCallsQuery.isError ||
    dealsQuery.isError ||
    conversationsQuery.isError;

  useEffect(() => {
    setNotesDraft(contact?.notes ?? "");
  }, [contact?.notes]);

  const notesMut = useMutation({
    mutationFn: async (notes: string) => {
      const { error } = await supabase.from("contacts").update({ notes }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["contact", id] }),
    onError: (e: Error) => toast.error(e.message ?? "Erro ao salvar notas"),
  });

  const enrichMut = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("lead-enrich", {
        body: { contact_id: id },
      });
      if (error) throw new Error(await extractInvokeErrorMessage(error));
      if (!data?.ok) throw new Error(data?.error ?? "Não foi possível enriquecer o contato.");
      return data as {
        ok: true;
        cached?: boolean;
        filled?: string[];
        failed?: string[];
        cost_usd?: number;
      };
    },
    onSuccess: (data) => {
      if (data.cached) {
        toast.info("Já enriquecido recentemente");
      } else {
        const filledCount = data.filled?.length ?? 0;
        const failedKeys = data.failed ?? [];
        const campo = filledCount === 1 ? "campo preenchido" : "campos preenchidos";
        const custo = formatUSD(data.cost_usd ?? 0);
        const labels: Record<string, string> = {
          instagram: "Instagram",
          website: "Site",
          whatsapp: "WhatsApp",
        };
        const fontes = failedKeys.map((k) => labels[k] ?? k).join(", ");
        if (failedKeys.length === 0) {
          toast.success(`Enriquecido: ${filledCount} ${campo} (${custo})`);
        } else if (filledCount > 0) {
          toast.warning(`Enriquecido: ${filledCount} ${campo} (${custo}). Falhou: ${fontes}.`);
        } else {
          toast.error(`Nenhum dado novo — falhou: ${fontes}.`);
        }
      }
      qc.invalidateQueries({ queryKey: ["contact", id] });
      qc.invalidateQueries({ queryKey: ["apify-enrichment-runs"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "Erro ao enriquecer contato"),
  });

  if (contactQuery.isLoading) {
    return (
      <div className="col-span-12 space-y-3">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (!contact) throw notFound();

  // Contato fundido/removido: registro é mantido só para histórico -- edição
  // (dados e notas) fica bloqueada em vez de permitir mudanças que nunca
  // aparecerão em nenhuma lista/relatório novamente.
  const isReadOnly = !!(contact.deleted_at || contact.merged_into_id);

  const stageLabel = (d: DealRow) =>
    d.status === "won" ? "Ganho" : d.status === "lost" ? "Perdido" : (d.stage?.name ?? "Em aberto");
  const stageVariant = (d: DealRow) =>
    d.status === "won" ? "success" : d.status === "lost" ? "destructive" : "neutral";

  return (
    <div className="col-span-12 flex flex-col gap-4">
      <Link
        to="/contatos"
        className="inline-flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground w-fit"
      >
        <ArrowLeft className="h-3 w-3" /> Voltar para contatos
      </Link>
      <PageHeader
        title={contact.name}
        description={`Criado em ${formatDate(contact.created_at)}${contact.source ? ` • ${contact.source}` : ""}`}
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => setOpenLigarIa(true)}
              disabled={isReadOnly || !contact.phone || !voiceConfigured}
              title={
                isReadOnly
                  ? "Contato fundido/removido não pode receber ligação"
                  : !contact.phone
                    ? "Contato sem telefone"
                    : !voiceConfigured
                      ? "Ligações IA não configuradas nesta conta"
                      : undefined
              }
            >
              <PhoneCall className="mr-1 h-4 w-4" /> Ligar com IA
            </Button>
            {agendaActive && (
              <Button
                variant="outline"
                onClick={() => setOpenRetorno(true)}
                disabled={isReadOnly}
                title={isReadOnly ? "Contato fundido/removido não pode agendar" : undefined}
              >
                <CalendarPlus className="mr-1 h-4 w-4" /> Agendar {appointmentLabel.toLowerCase()}
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() =>
                navigate({
                  to: "/pipeline",
                  search: { contactId: contact.id, contactName: contact.name },
                })
              }
              disabled={isReadOnly}
              title={
                isReadOnly ? "Contato fundido/removido não pode ter negócio criado" : undefined
              }
            >
              <Handshake className="mr-1 h-4 w-4" /> Criar negócio
            </Button>
            <Button
              variant="outline"
              onClick={() => setOpenEdit(true)}
              disabled={isReadOnly}
              title={isReadOnly ? "Contato fundido/removido não pode ser editado" : undefined}
            >
              <Pencil className="mr-1 h-4 w-4" /> Editar
            </Button>
            {/* Botão "Enriquecer" (lead-enrich/Apify) oculto: integração fora do
                MVP (2026-07-27). A mutation acima segue no arquivo para
                reativação em uma linha. */}
          </>
        }
      />

      {(contact.deleted_at || contact.merged_into_id) && (
        <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-body text-destructive">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          <div>
            {contact.merged_into_id ? (
              <>
                Este contato foi fundido em outro contato
                {mergedIntoQuery.data ? (
                  <>
                    {": "}
                    <Link
                      to="/contatos/$id"
                      params={{ id: contact.merged_into_id }}
                      className="font-medium underline underline-offset-2"
                    >
                      {mergedIntoQuery.data.name}
                    </Link>
                  </>
                ) : null}
                . Os dados abaixo são mantidos apenas para histórico.
              </>
            ) : (
              "Este contato foi removido e não aparece mais nas listas. Os dados abaixo são mantidos apenas para histórico."
            )}
          </div>
        </div>
      )}

      <div className="flex items-center gap-4 rounded-lg border border-border bg-surface p-4">
        <ContactAvatar avatarPath={contact.avatar_url} name={contact.name} />

        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-body text-muted-foreground">
            <Phone className="h-4 w-4" /> {contact.phone || "—"}
          </div>
          <div className="flex items-center gap-2 text-body text-muted-foreground">
            <Mail className="h-4 w-4" /> {contact.email || "—"}
          </div>
        </div>
        <div className="ml-auto flex flex-wrap gap-1">
          {contact.tags?.map((t) => (
            <StatusBadge key={t} variant="neutral">
              {t}
            </StatusBadge>
          ))}
        </div>
      </div>

      {profile && !isReadOnly && (
        <FollowUpSuggestionBanner
          messages={followUpBannerMessages}
          contactId={contact.id}
          dealId={openDeal?.id ?? null}
          tenantId={profile.tenant_id}
          createdBy={profile.id}
        />
      )}

      <Tabs defaultValue="dados">
        <TabsList>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="dados">Dados</TabsTrigger>
          <TabsTrigger value="conversas">Conversas</TabsTrigger>
          <TabsTrigger value="negocios">Negócios</TabsTrigger>
          <TabsTrigger value="atividades">Atividades</TabsTrigger>
          <TabsTrigger value="memoria-ia">Memória IA</TabsTrigger>
        </TabsList>

        <TabsContent value="timeline" className="mt-4">
          {timelineError && (
            <div className="mb-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-body text-destructive">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
              <div className="flex-1">
                <p>
                  Não foi possível carregar uma ou mais fontes da timeline (notas, atividades,
                  follow-ups, histórico de estágio ou mensagens). O que aparece abaixo pode estar
                  incompleto.
                </p>
                <Button
                  variant="link"
                  className="h-auto p-0 text-destructive underline"
                  onClick={() => {
                    void notesFeedQuery.refetch();
                    void activitiesQuery.refetch();
                    void followupsQuery.refetch();
                    void stageHistoryQuery.refetch();
                    void timelineMessagesQuery.refetch();
                    void dealsQuery.refetch();
                    void conversationsQuery.refetch();
                  }}
                >
                  Tentar novamente
                </Button>
              </div>
            </div>
          )}
          <Card>
            <CardContent className="p-0">
              {timelineLoading ? (
                <div className="p-4 space-y-2">
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-16 w-full" />
                </div>
              ) : timelineEvents.length === 0 ? (
                <div className="p-6">
                  <EmptyState
                    title="Sem eventos"
                    description="Nenhuma nota, atividade, retorno, mudança de negócio ou mensagem registrada ainda."
                  />
                </div>
              ) : (
                <>
                  <ul className="divide-y divide-border">
                    {visibleTimelineEvents.map((ev) => {
                      const Icon = timelineIcons[ev.kind];
                      return (
                        <li key={ev.id} className="flex items-start gap-3 p-3">
                          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
                            <Icon className="h-4 w-4" aria-hidden="true" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-body text-foreground">{ev.title}</div>
                            {ev.description ? (
                              <div className="truncate text-caption text-muted-foreground">
                                {ev.description}
                              </div>
                            ) : null}
                            <div className="text-caption text-muted-foreground">
                              {formatDateTime(ev.timestamp)}
                            </div>
                            {ev.kind === "call" && ev.refId
                              ? (() => {
                                  const call = voiceCallsQuery.data?.find((c) => c.id === ev.refId);
                                  return call ? <VoiceCallDetailsButtons call={call} /> : null;
                                })()
                              : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  {timelineHasMore && (
                    <div className="flex justify-center p-3">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setTimelineVisibleCount((c) => c + TIMELINE_PAGE_SIZE)}
                      >
                        Carregar mais
                      </Button>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="dados" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-card-title">Informações</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Nome" value={contact.name} />
              <Field label="Situação" value={contact.status || "—"} />
              <Field label="Telefone" value={contact.phone || "—"} />
              <Field label="E-mail" value={contact.email || "—"} />
              <Field label="Origem" value={contact.source || "—"} />
              <Field label="Cargo" value={contact.job_title || "—"} />
              <Field label="Departamento" value={contact.department || "—"} />
              <Field
                label="Aniversário"
                value={contact.birthday ? formatDate(contact.birthday) : "—"}
              />
              {companiesActive && (
                <div>
                  <div className="text-caption text-muted-foreground">Empresa</div>
                  {contact.company_id && companyQuery.data ? (
                    <Link
                      to="/empresas/$id"
                      params={{ id: contact.company_id }}
                      className="text-body text-primary hover:underline"
                    >
                      {companyQuery.data.name}
                    </Link>
                  ) : (
                    <div className="text-body text-foreground">—</div>
                  )}
                </div>
              )}
              <div>
                <div className="text-caption text-muted-foreground">Site</div>
                {contact.website ? (
                  <a
                    href={contact.website}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-body text-primary hover:underline inline-flex items-center gap-1"
                  >
                    {contact.website}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                ) : (
                  <div className="text-body text-foreground">—</div>
                )}
              </div>
              <Field label="Instagram" value={contact.instagram || "—"} />
              <div>
                <div className="text-caption text-muted-foreground">LinkedIn</div>
                {contact.linkedin ? (
                  <a
                    href={contact.linkedin}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-body text-primary hover:underline inline-flex items-center gap-1"
                  >
                    {contact.linkedin}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                ) : (
                  <div className="text-body text-foreground">—</div>
                )}
              </div>
              <div className="sm:col-span-2">
                <div className="text-caption text-muted-foreground">Endereço</div>
                <div className="text-body text-foreground whitespace-pre-line">
                  {[
                    contact.address_street,
                    [contact.address_city, contact.address_state].filter(Boolean).join(" / "),
                    contact.address_zip,
                    contact.address_country,
                  ]
                    .filter(Boolean)
                    .join("\n") || "—"}
                </div>
              </div>
              {contact.description && (
                <div className="sm:col-span-2">
                  <div className="text-caption text-muted-foreground">Descrição</div>
                  <div className="text-body text-foreground whitespace-pre-line">
                    {contact.description}
                  </div>
                </div>
              )}
              <div className="sm:col-span-2 space-y-1.5">
                <Label htmlFor="notes-detail">Notas</Label>
                <Textarea
                  id="notes-detail"
                  rows={4}
                  value={notesDraft}
                  disabled={isReadOnly}
                  onChange={(e) => setNotesDraft(e.target.value)}
                  onBlur={() => {
                    if (!isReadOnly && notesDraft !== (contact.notes ?? ""))
                      notesMut.mutate(notesDraft);
                  }}
                />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="conversas" className="mt-4">
          <Card>
            <CardContent className="p-0">
              {conversationsQuery.isLoading ? (
                <div className="p-4">
                  <Skeleton className="h-16 w-full" />
                </div>
              ) : (conversationsQuery.data?.length ?? 0) === 0 ? (
                <div className="p-6">
                  <EmptyState
                    title="Sem conversas"
                    description="Nenhuma conversa registrada com este contato."
                  />
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {conversationsQuery.data!.map((c) => (
                    <li key={c.id} className="flex items-center gap-3 p-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
                        <MessageSquare className="h-4 w-4" aria-hidden="true" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-body font-medium text-foreground">
                            {channelLabel[c.channel?.type ?? ""] ?? c.channel?.type ?? "Canal"}
                          </span>
                          <StatusBadge variant={c.status === "open" ? "success" : "neutral"}>
                            {c.status === "open" ? "Aberta" : "Fechada"}
                          </StatusBadge>
                        </div>
                        <div className="truncate text-caption text-muted-foreground">
                          {c.last_message?.content ?? "Sem mensagens"}
                          {c.last_message_at ? ` • ${relativeFromNow(c.last_message_at)}` : ""}
                        </div>
                      </div>
                      <Button asChild variant="outline" size="sm" className="h-8 shrink-0">
                        <Link to="/inbox">
                          <ExternalLink className="mr-1 h-3.5 w-3.5" /> Abrir no Inbox
                        </Link>
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="negocios" className="mt-4">
          {dealsQuery.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : (dealsQuery.data?.length ?? 0) === 0 ? (
            <EmptyState
              title="Sem negócios"
              description="Nenhum negócio vinculado a este contato."
            />
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {dealsQuery.data!.map((d) => (
                <Card key={d.id}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-card-title">{d.title}</CardTitle>
                  </CardHeader>
                  <CardContent className="flex items-center justify-between">
                    <StatusBadge variant={stageVariant(d)}>{stageLabel(d)}</StatusBadge>
                    <span className="text-body font-semibold text-primary">
                      {formatBRL(Number(d.value ?? 0))}
                    </span>
                  </CardContent>
                  {d.status === "lost" && d.lost_reason && (
                    <CardContent
                      className="line-clamp-2 break-words pt-0 text-caption text-muted-foreground"
                      title={d.lost_reason}
                    >
                      Motivo da perda: {d.lost_reason}
                    </CardContent>
                  )}
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="atividades" className="mt-4">
          <Card>
            <CardContent className="p-0">
              {activitiesQuery.isLoading ? (
                <div className="p-4">
                  <Skeleton className="h-16 w-full" />
                </div>
              ) : (activitiesQuery.data?.length ?? 0) === 0 ? (
                <div className="p-6">
                  <EmptyState title="Sem atividades" description="Nenhuma atividade vinculada." />
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {activitiesQuery.data!.map((a) => {
                    const overdue = a.due_at && !a.completed_at && new Date(a.due_at) < new Date();
                    const status: "success" | "warning" | "destructive" | "neutral" = a.completed_at
                      ? "success"
                      : overdue
                        ? "destructive"
                        : "neutral";
                    const label = a.completed_at ? "Concluída" : overdue ? "Atrasada" : "Pendente";
                    return (
                      <li key={a.id} className="flex items-center gap-3 p-3">
                        <StatusBadge variant={status}>{label}</StatusBadge>
                        <div className="flex-1 min-w-0">
                          <div className="truncate text-body text-foreground">{a.title}</div>
                          <div className="text-caption text-muted-foreground">
                            {a.due_at ? formatDateTime(a.due_at) : "Sem data"}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="memoria-ia" className="mt-4 space-y-4">
          <ExtractedFieldsCard tenantId={contact.tenant_id} contactId={contact.id} />
          <ContactQualificationCard tenantId={contact.tenant_id} contactId={contact.id} />
          <AiMemoryCard
            contactId={contact.id}
            tags={contact.tags}
            aiMemory={contact.ai_memory}
            openDeal={openDeal}
            followups={followupsQuery.data ?? []}
            activities={activitiesQuery.data ?? []}
            lastMessageAt={lastMessageAt}
          />
        </TabsContent>
      </Tabs>

      <ContactFormDialog open={openEdit} onOpenChange={setOpenEdit} contact={contact} />
      <RetornoDialog open={openRetorno} onOpenChange={setOpenRetorno} contactId={contact.id} />
      <LigarComIaDialog
        open={openLigarIa}
        onOpenChange={setOpenLigarIa}
        contact={{ id: contact.id, name: contact.name, phone: contact.phone }}
        deals={(dealsQuery.data ?? [])
          .filter((d) => d.status !== "won" && d.status !== "lost")
          .map((d) => ({ id: d.id, title: d.title }))}
      />
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-caption text-muted-foreground">{label}</div>
      <div className="text-body text-foreground">{value}</div>
    </div>
  );
}
