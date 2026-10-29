import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Inbox as InboxIcon,
  Mail,
  Search,
  Send,
  MessageCircle,
  Instagram,
  MessagesSquare,
  AlertCircle,
  CalendarClock,
  ChevronLeft,
  Download,
  Loader2,
  Trash2,
} from "lucide-react";
import { PageHeader } from "@/components/common/PageHeader";
import { EmptyState } from "@/components/common/EmptyState";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { InitialsAvatar } from "@/components/common/InitialsAvatar";
import { StatusBadge } from "@/components/common/StatusBadge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { formatDate, formatTime, isSameDay } from "@/lib/format";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";

import { useCurrentProfile } from "@/lib/api/session";
import { useIntegration, useTenantChannels } from "@/lib/api/integrations";
import { isManyChatSlug } from "@/lib/integrations/manychat";

// Rótulos amigáveis por provedor de WhatsApp — o dropdown de canal precisa
// deixar explícito QUAL integração está sendo filtrada (Meta oficial, Z-API,
// Zappaz, ...), não só "WhatsApp #1".
const WA_PROVIDER_LABELS: Record<string, string> = {
  "meta-cloud": "WhatsApp API Oficial (Meta)",
  "z-api": "Z-API",
  zapi: "Z-API",
  zappaz: "Zappaz",
  twilio: "Twilio",
  evolution: "Evolution API",
  "manychat-whatsapp": "WhatsApp · ManyChat",
};

function waProviderLabel(slug: string | null | undefined): string {
  if (!slug) return "WhatsApp";
  return WA_PROVIDER_LABELS[slug] ?? `WhatsApp · ${slug}`;
}
import { FollowUpSuggestionBanner } from "@/components/inbox/FollowUpSuggestionBanner";
import { QuickFollowupDialog } from "@/components/inbox/QuickFollowupDialog";
import { AiPersonaBadge } from "@/components/ai/ai-persona-badge";
import { NextBestActionCard } from "@/features/inbox/next-best-action-card";
import { InboxModeTabs, type InboxMode } from "@/components/inbox/InboxModeTabs";
import { InboxOverviewView, type TriageFilter } from "@/components/inbox/InboxOverviewView";
import { InboxFocusView } from "@/components/inbox/InboxFocusView";
import { InboxZeroState } from "@/components/inbox/InboxZeroState";
import { SimulatorComposer, SimulatorLauncher } from "@/components/inbox/SimulatorComposer";
import {
  isConversationCold,
  isConversationOverdue,
  isConversationToday,
  buildFocusQueue,
} from "@/lib/inbox-triage";
import { useColdDeals, useHotLeadsWithoutFollowup } from "@/lib/api/inbox-risk-opportunities";
import { useCreateFollowup, usePendingFollowupContactIds } from "@/hooks/use-followup-queue";
import { useConversationExport } from "@/hooks/use-conversation-export";
import { toast } from "sonner";
import { PERIOD_OPTIONS, rangeFor, useGlobalPeriod } from "@/lib/view-prefs/use-global-period";
import { isRateLimitError, type AiError, type AiErrorCode } from "@/lib/ai/errors";

// Frases curtas em PT-BR pra cada AiErrorCode — exibidas no badge de erro
// de IA da inbox (lista + header da conversa selecionada).
//
// "LEGACY" não é um AiErrorCode formal (ver src/lib/ai/errors.ts) — é o
// código sintético que a migration da Fase 2 grava ao converter
// last_error texto livre pré-existente em {"code":"LEGACY","message":...}.
// Mantido como união local (não em AiErrorCode) pra não afetar o contrato
// tipado compartilhado com o edge function.
type InboxErrorLabelCode = AiErrorCode | "LEGACY";

const AI_ERROR_LABELS: Record<InboxErrorLabelCode, string> = {
  RATE_LIMIT: "Limite de IA atingido",
  PROVIDER_AUTH: "Erro de autenticação do provedor",
  PROVIDER_QUOTA: "Cota do provedor esgotada",
  PROVIDER_5XX: "Provedor de IA instável",
  CONTENT_BLOCKED: "Conteúdo bloqueado pelo provedor",
  TIMEOUT: "Tempo esgotado ao gerar resposta",
  SUPPRESSED: "Contato optou por não receber mensagens",
  UNKNOWN: "Falha ao gerar resposta",
  LEGACY: "Erro anterior (sem detalhe)",
};

/**
 * Resolve o label do badge de erro de IA com fallback pra códigos
 * desconhecidos em runtime — `last_error` vem de um cast não-validado
 * (`as unknown as ConversationRow[]`), então um `code` fora de
 * `InboxErrorLabelCode` (ex.: dado legado ainda não migrado) não pode
 * quebrar a UI com badge vazio.
 */
function getAiErrorLabel(code: string): string {
  return code in AI_ERROR_LABELS
    ? AI_ERROR_LABELS[code as InboxErrorLabelCode]
    : AI_ERROR_LABELS.UNKNOWN;
}

// Período usado por "Ampliar período" nos estados vazios da inbox.
const WIDEST_PERIOD = "last_90d" as const;

const INBOX_MODES = ["geral", "lista", "foco"] as const;
const TRIAGE_FILTERS = ["atrasados", "hoje", "pendencias"] as const;

export interface InboxSearch {
  /** Preseleciona uma conversa ao abrir a inbox (ex.: vindo da busca global Cmd+K). */
  conversationId?: string;
  /** Modo de visualização (Visão geral / Lista / Foco); default 'geral'. */
  mode?: (typeof INBOX_MODES)[number];
  /** Recorte de triagem aplicado à Lista quando um StatCard é clicado na Visão geral. */
  filter?: (typeof TRIAGE_FILTERS)[number];
}

export const Route = createFileRoute("/_app/inbox")({
  validateSearch: (search: Record<string, unknown>): InboxSearch => ({
    conversationId:
      typeof search.conversationId === "string" && search.conversationId.length > 0
        ? search.conversationId
        : undefined,
    mode: INBOX_MODES.includes(search.mode as (typeof INBOX_MODES)[number])
      ? (search.mode as (typeof INBOX_MODES)[number])
      : undefined,
    filter: TRIAGE_FILTERS.includes(search.filter as (typeof TRIAGE_FILTERS)[number])
      ? (search.filter as (typeof TRIAGE_FILTERS)[number])
      : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Conversas" },
      {
        name: "description",
        content: "Central unificada de conversas de WhatsApp e e-mail com contexto do lead.",
      },
      { property: "og:title", content: "Conversas" },
      {
        property: "og:description",
        content: "Central unificada de conversas de WhatsApp e e-mail com contexto do lead.",
      },
      { property: "og:url", content: "https://aceleraflow.lovable.app/inbox" },
      { name: "twitter:title", content: "Conversas" },
      {
        name: "twitter:description",
        content: "Central unificada de conversas de WhatsApp e e-mail com contexto do lead.",
      },
    ],
    links: [{ rel: "canonical", href: "https://aceleraflow.lovable.app/inbox" }],
  }),
  component: InboxPage,
});

// instagram/messenger: canais ManyChat (channels_type_check desde 20260929120000).
type ChannelType = "whatsapp" | "email" | "instagram" | "messenger" | "simulator";
type Sender = "contact" | "agent" | "ai";

interface ConversationRow {
  id: string;
  tenant_id: string;
  contact_id: string;
  channel_id: string;
  ai_active: boolean;
  awaiting_human: boolean;
  awaiting_human_since: string | null;
  status: string;
  last_error: AiError | null;
  unread_count: number | null;
  last_message_at: string | null;
  created_at: string;
  contact: {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    tags: string[] | null;
  } | null;
  channel: { id: string; type: ChannelType; provider_slug: string | null } | null;
  last_message: { content: string | null; sender: string; created_at: string } | null;
  // Derivado da mesma query de últimas mensagens: existe resposta da IA
  // escrita e ainda não enviada (modo rascunho). Só a lista usa — a conversa
  // aberta já mostra a bolha de rascunho com "Aprovar e enviar".
  has_pending_draft?: boolean;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  tenant_id: string;
  sender: Sender;
  direction: "in" | "out";
  content: string | null;
  media_url: string | null;
  media_type: string | null;
  audio_storage_path?: string | null;
  audio_status?: string;
  created_at: string;
  status?: "sent" | "pending" | "failed" | "draft" | null;
  send_error?: string | null;
}

// Aceita tanto a `MessageRow` da `DraftBubble` (thread) quanto o `DraftRow`
// enxuto do `NextBestActionCard` — o mesmo rascunho pode aparecer nos dois
// lugares e precisa compartilhar esta única mutation (ver approveDraftMutation).
type DraftApproval = Pick<MessageRow, "id" | "conversation_id">;

// Local insert (integration-less fallback). Returns the inserted row.
async function insertLocalMessage(params: {
  conversationId: string;
  tenantId: string;
  content: string;
}) {
  const { conversationId, tenantId, content } = params;
  const { data, error } = await supabase
    .from("messages")
    .insert({
      conversation_id: conversationId,
      tenant_id: tenantId,
      sender: "agent",
      direction: "out",
      content,
      status: "sent",
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// External send through the provider (currently Z-API).
async function sendViaProvider(conversationId: string, content: string) {
  const { data, error } = await supabase.functions.invoke("messaging-send", {
    body: { conversation_id: conversationId, content },
  });
  if (error) throw error;
  if (!data?.ok) throw new Error(data?.error ?? "Não foi possível enviar a mensagem.");
  return data;
}

function InboxPage() {
  const { data: profile, isLoading: profileLoading } = useCurrentProfile();
  const tenantId = profile?.tenant_id ?? null;
  const { period, range: periodRange, setPeriod } = useGlobalPeriod();
  const periodFromISO = periodRange.from.toISOString();
  const queryClient = useQueryClient();
  const {
    conversationId: conversationIdFromSearch,
    mode: modeFromSearch,
    filter: filterFromSearch,
  } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const mode: InboxMode = modeFromSearch ?? "geral";

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [channelFilter, setChannelFilter] = useState<"todos" | ChannelType>("todos");
  const [aiFilter, setAiFilter] = useState<"todos" | "ativa" | "pausada">("todos");
  // Filtro por número/canal WhatsApp — só ganha uso quando o tenant tem 2+
  // canais WhatsApp conectados. Persiste em localStorage por tenant.
  const waChannelFilterStorageKey = tenantId ? `inbox:waChannel:${tenantId}` : null;
  const [waChannelFilter, setWaChannelFilterState] = useState<string>("todos");
  useEffect(() => {
    if (!waChannelFilterStorageKey) return;
    try {
      const saved = window.localStorage.getItem(waChannelFilterStorageKey);
      if (saved) setWaChannelFilterState(saved);
    } catch {
      // ignore storage errors
    }
  }, [waChannelFilterStorageKey]);
  function setWaChannelFilter(next: string) {
    setWaChannelFilterState(next);
    if (waChannelFilterStorageKey) {
      try {
        window.localStorage.setItem(waChannelFilterStorageKey, next);
      } catch {
        // ignore
      }
    }
  }
  const [draft, setDraft] = useState("");
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [quickFollowupOpen, setQuickFollowupOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  function setMode(next: InboxMode) {
    // Reseta o cursor do Modo Foco sempre que se entra nele — inclusive pela
    // aba do InboxModeTabs, que não passa por onStartFocus/openFilter. Sem
    // isso, focusIndex sobrevive à troca de mode (o componente não desmonta)
    // e o usuário reencontra o cursor de uma sessão de foco anterior.
    if (next === "foco") setFocusIndex(0);
    void navigate({
      to: ".",
      search: (prev: InboxSearch) => ({ ...prev, mode: next === "geral" ? undefined : next }),
    });
  }

  function openFilter(filter: TriageFilter) {
    setFocusIndex(0);
    void navigate({ to: ".", search: (prev: InboxSearch) => ({ ...prev, mode: "lista", filter }) });
  }
  const listRef = useRef<HTMLUListElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const conversationsQuery = useQuery({
    queryKey: ["inbox-conversations", tenantId, periodFromISO],
    enabled: !!tenantId,
    queryFn: async (): Promise<ConversationRow[]> => {
      const { data, error } = await supabase
        .from("conversations")
        .select(
          `id, tenant_id, contact_id, channel_id, ai_active, awaiting_human, awaiting_human_since, status, last_error, unread_count, last_message_at, created_at,
           contact:contacts!conversations_contact_id_fkey(id, name, phone, email, tags, deleted_at),
           channel:channels!conversations_channel_id_fkey(id, type, provider_slug)`,
        )
        // Soft-delete: conversa excluída (`deleted_at`) some da lista; volta a
        // aparecer se ressuscitar (contato manda mensagem nova).
        .is("deleted_at", null)
        // Exclui fechadas ANTES do `.limit()` abaixo — o teto de segurança só
        // pode descartar histórico morto (conversas fechadas), nunca
        // conversas abertas. Sem este filtro, a ordenação por
        // `last_message_at desc` corta primeiro exatamente as conversas com
        // atividade mais antiga (as "atrasadas"/"frias"/aguardando-humano-há-
        // mais-tempo) assim que o tenant passa de 500 conversas HISTÓRICAS —
        // undercountando os StatCards de SLA (`overdueConversations`/
        // `pendingConversations`/`coldConversations`) e a fila do Modo Foco,
        // que são derivados deste mesmo array. Não elimina o caso teórico de
        // >500 conversas ABERTAS simultâneas — fora de escopo pro estágio
        // atual (CRM lean 1-admin).
        .neq("status", "closed")
        // Recorte de período global (topbar). Conversas sem `last_message_at`
        // (recém-criadas, sem tráfego ainda) permanecem — o filtro só descarta
        // atividade estritamente anterior à janela.
        .or(`last_message_at.gte.${periodFromISO},last_message_at.is.null`)
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })

        // Teto de segurança contra fetch ilimitado — mesmo padrão de
        // `_app.contatos.tsx`/`_app.pipeline.tsx`/`_app.atividades.tsx`. A
        // Lista renderiza como lista scrollável com navegação por teclado
        // (não uma tabela paginada por número de página) e já filtra/busca
        // 100% client-side sobre o array carregado — paginação numerada
        // quebraria ArrowUp/Down/Home/End e o auto-select do primeiro item
        // filtrado.
        .limit(500);
      if (error) throw error;
      const rawConvs = (data ?? []) as unknown as (Omit<ConversationRow, "contact"> & {
        contact: (ConversationRow["contact"] & { deleted_at: string | null }) | null;
      })[];
      // Join to-one: contato fundido/removido não deve reaparecer no inbox.
      const convs: ConversationRow[] = rawConvs.map((c) => ({
        ...c,
        contact: c.contact?.deleted_at ? null : c.contact,
      }));

      // Fetch the last message for each conversation (single batched query).
      if (convs.length > 0) {
        const ids = convs.map((c) => c.id);
        const { data: msgs, error: mErr } = await supabase
          .from("messages")
          .select("conversation_id, content, sender, created_at, status")
          .in("conversation_id", ids)
          .order("created_at", { ascending: false })
          // Teto explícito e generoso (não auditável de outra forma, já que o
          // Supabase é gerenciado via Lovable): cobre a última mensagem de
          // até 500 conversas com folga para threads com múltiplas mensagens
          // recentes por conversa, sem depender de um cap implícito do
          // PostgREST.
          .limit(2000);
        if (mErr) throw mErr;
        const lastByConv = new Map<
          string,
          { content: string | null; sender: string; created_at: string }
        >();
        // Rascunho não vira prévia (o lead nunca o recebeu), mas a lista
        // precisa saber que ele existe: sem isso a linha mostra a mensagem do
        // cliente ao lado de "IA ativa" e o dono conclui que a IA não
        // respondeu — quando na verdade a resposta está esperando ele enviar.
        const withDraft = new Set<string>();
        for (const m of msgs ?? []) {
          if (m.status === "draft") {
            withDraft.add(m.conversation_id);
            continue;
          }
          if (!lastByConv.has(m.conversation_id)) {
            lastByConv.set(m.conversation_id, {
              content: m.content,
              sender: m.sender,
              created_at: m.created_at,
            });
          }
        }
        for (const c of convs) {
          c.last_message = lastByConv.get(c.id) ?? null;
          c.has_pending_draft = withDraft.has(c.id);
        }
      }
      return convs;
    },
  });

  // Conversas abertas que o recorte de período esconde mas que o período mais
  // largo (WIDEST_PERIOD) revelaria. Alimenta o aviso "Ampliar período" nos
  // estados vazios — sem ele a lista vazia parece "sem dados".
  const hiddenByPeriodQuery = useQuery({
    queryKey: ["inbox-hidden-by-period", tenantId, periodFromISO],
    enabled: !!tenantId && period !== WIDEST_PERIOD,
    queryFn: async (): Promise<number> => {
      const { count, error } = await supabase
        .from("conversations")
        .select("id", { count: "exact", head: true })
        .is("deleted_at", null)
        .neq("status", "closed")
        .lt("last_message_at", periodFromISO)
        .gte("last_message_at", rangeFor(WIDEST_PERIOD).from.toISOString());
      if (error) throw error;
      return count ?? 0;
    },
  });
  const hiddenByPeriod = hiddenByPeriodQuery.data ?? 0;
  const periodLabel = PERIOD_OPTIONS.find((o) => o.key === period)?.label ?? "";

  const messagesQuery = useQuery({
    queryKey: ["inbox-messages", selectedId],
    enabled: !!selectedId,
    queryFn: async (): Promise<MessageRow[]> => {
      const { data, error } = await supabase
        .from("messages")
        .select(
          "id, conversation_id, tenant_id, sender, direction, content, media_url, media_type, audio_storage_path, audio_status, created_at, status, send_error",
        )
        .eq("conversation_id", selectedId!)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as MessageRow[];
    },
  });

  const tagsQuery = useQuery({
    queryKey: ["inbox-tags", tenantId],
    enabled: !!tenantId,
    queryFn: async (): Promise<{ name: string; color: string }[]> => {
      const { data, error } = await supabase.from("tags").select("name, color");
      if (error) throw error;
      return data ?? [];
    },
  });

  const tagColors = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of tagsQuery.data ?? []) map.set(t.name, t.color);
    return map;
  }, [tagsQuery.data]);

  const conversations = conversationsQuery.data ?? [];

  // Busca pontual da conversa vinda de ?conversationId (Cmd+K) quando ela não
  // está no array já carregado — ex.: conversa antiga demais pra caber no
  // teto de 500 de `conversationsQuery`. Sem isto, o auto-select abaixo teria
  // que cair no fallback `filtered[0]` e abriria uma conversa completamente
  // diferente da que o usuário escolheu na busca global.
  const searchedConversationQuery = useQuery({
    queryKey: ["inbox-conversation-by-id", conversationIdFromSearch],
    enabled:
      !!tenantId &&
      !!conversationIdFromSearch &&
      conversationsQuery.isSuccess &&
      !conversations.some((c) => c.id === conversationIdFromSearch),
    queryFn: async (): Promise<ConversationRow | null> => {
      const { data, error } = await supabase
        .from("conversations")
        .select(
          `id, tenant_id, contact_id, channel_id, ai_active, awaiting_human, awaiting_human_since, status, last_error, unread_count, last_message_at, created_at,
           contact:contacts!conversations_contact_id_fkey(id, name, phone, email, tags, deleted_at),
           channel:channels!conversations_channel_id_fkey(id, type, provider_slug)`,
        )
        .eq("id", conversationIdFromSearch!)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const raw = data as unknown as Omit<ConversationRow, "contact"> & {
        contact: (ConversationRow["contact"] & { deleted_at: string | null }) | null;
      };
      return {
        ...raw,
        contact: raw.contact?.deleted_at ? null : raw.contact,
        last_message: null,
      };
    },
  });

  // ── Triagem (Épico B — Inbox command center) ──────────────────────────
  // Recortes puros sobre `conversations` já carregado — nenhuma query nova.
  const nowMs = Date.now();
  const overdueConversations = useMemo(
    () => conversations.filter((c) => isConversationOverdue(c, nowMs)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversations],
  );
  const todayConversations = useMemo(
    () => conversations.filter((c) => isConversationToday(c, new Date(nowMs))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversations],
  );
  const pendingConversations = useMemo(
    () => (conversationsQuery.data ?? []).filter((c) => c.awaiting_human && c.status !== "closed"),
    [conversationsQuery.data],
  );
  // Mesma dedup do painel Oportunidades (`useHotLeadsWithoutFollowup`): uma
  // conversa fria cujo contato já tem follow-up pendente não deve aparecer no
  // painel Risco de novo — o recontato já está agendado.
  const pendingFollowupContactIds = usePendingFollowupContactIds();
  const coldConversations = useMemo(
    () =>
      conversations.filter(
        (c) => isConversationCold(c, nowMs) && !pendingFollowupContactIds.has(c.contact_id),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversations, pendingFollowupContactIds],
  );

  const focusQueue = useMemo(
    () => buildFocusQueue(pendingConversations, overdueConversations),
    [pendingConversations, overdueConversations],
  );
  // Sem clamp para o índice máximo: `focusQueue[focusIndex]` é `undefined`
  // (→ `null`) assim que o usuário passa do último item (ex.: "Pular" no
  // último item da fila) — isso é o que faz o Modo Foco chegar ao
  // `InboxZeroState` corretamente. Um clamp em `length - 1` prenderia o
  // usuário repetindo o último item pra sempre a cada clique em "Pular".
  const currentFocusItem = focusQueue[focusIndex] ?? null;

  function advanceFocus() {
    setFocusIndex((i) => i + 1);
  }

  const { coldDeals } = useColdDeals(tenantId);
  const { hotLeads } = useHotLeadsWithoutFollowup(tenantId);
  const { exportConversations, isExporting } = useConversationExport();

  // ── Ação inline "Aplicar" (painéis Risco/Oportunidades) ───────────────────
  // Mesma mutation de follow-up já usada pelo `NextBestActionCard`/
  // `FollowUpSuggestionBanner` — "aplicar" aqui é agendar o recontato
  // sugerido sem sair da tela. `applyingKeys` (não `createFollowup.isPending`)
  // rastreia quais linhas estão em voo, pois a mutation é compartilhada entre
  // todas as linhas dos dois painéis — um `Set`, não um escalar único, porque
  // aplicar na linha B enquanto A ainda está em voo não pode sobrescrever o
  // lock de A (duplo-clique/mutation concorrente na mesma linha). Sempre
  // reconstrói o Set (nunca `.add`/`.delete` in-place) para manter a
  // imutabilidade do estado do React.
  const createFollowup = useCreateFollowup();
  const [applyingKeys, setApplyingKeys] = useState<Set<string>>(new Set());

  function markApplying(key: string, applying: boolean) {
    setApplyingKeys((prev) => {
      const next = new Set(prev);
      if (applying) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function applyRescueFollowup(
    key: string,
    input: { contactId: string; dealId?: string | null; description: string; scheduledAt: Date },
  ) {
    if (!profile || !tenantId) {
      toast.error("Perfil ainda não carregado — tente novamente em instantes.");
      return;
    }
    markApplying(key, true);
    createFollowup.mutate(
      {
        tenantId,
        contactId: input.contactId,
        dealId: input.dealId ?? null,
        scheduledAt: input.scheduledAt.toISOString(),
        description: input.description,
        createdBy: profile.id,
        source: "ai_suggested",
        aiSuggested: true,
      },
      {
        onSuccess: () => {
          toast.success("Retorno agendado.");
          markApplying(key, false);
        },
        onError: (e: Error) => {
          toast.error(e.message || "Falha ao aplicar sugestão");
          markApplying(key, false);
        },
      },
    );
  }

  function tomorrowAt(): Date {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d;
  }

  function handleApplyDeal(dealId: string, contactId: string) {
    applyRescueFollowup(`deal-${dealId}`, {
      contactId,
      dealId,
      description: "Retomar negócio parado (painel Risco)",
      scheduledAt: tomorrowAt(),
    });
  }

  function handleApplyConversation(conversationId: string, contactId: string) {
    applyRescueFollowup(`conv-${conversationId}`, {
      contactId,
      description: "Recontatar conversa sem atividade (painel Risco)",
      scheduledAt: tomorrowAt(),
    });
  }

  function handleApplyOpportunity(contactId: string) {
    applyRescueFollowup(contactId, {
      contactId,
      description: "Retorno prioritário — lead quente (painel Oportunidades)",
      scheduledAt: new Date(),
    });
  }

  async function handleExportConversations() {
    try {
      const { recordsCount } = await exportConversations({
        search: query,
        channelType: channelFilter === "todos" ? undefined : channelFilter,
        aiActive: aiFilter === "todos" ? undefined : aiFilter === "ativa",
      });
      toast.success(`${recordsCount} conversa(s) exportada(s)`);
    } catch (e) {
      toast.error((e as Error)?.message ?? "Erro ao exportar conversas");
    }
  }

  function selectConversation(id: string | null) {
    setSelectedId(id);
    setEditingDraftId(null);
    if (!id) return;
    const conv = conversationsQuery.data?.find((c) => c.id === id);
    if (conv && (conv.unread_count ?? 0) > 0) {
      queryClient.setQueryData<ConversationRow[] | undefined>(
        ["inbox-conversations", tenantId, periodFromISO],
        (prev) => prev?.map((c) => (c.id === id ? { ...c, unread_count: 0 } : c)),
      );
      void supabase
        .from("conversations")
        .update({ unread_count: 0 })
        .eq("id", id)
        .then(({ error }) => {
          if (error) toast.error("Não foi possível marcar a conversa como lida.");
        });
    }
  }

  // Lista de canais WhatsApp disponíveis para filtro. Antes era derivada só
  // das conversas carregadas — o efeito colateral era que uma integração
  // conectada mas ainda sem conversa (ex.: Zappaz recém-ligado) nunca
  // aparecia no dropdown. Agora unimos os canais conectados do tenant
  // (`useTenantChannels`) com os canais vistos nas conversas.
  const tenantChannelsQuery = useTenantChannels();
  const waChannels = useMemo(() => {
    const map = new Map<string, { id: string; provider_slug: string | null }>();
    for (const ch of tenantChannelsQuery.data ?? []) {
      if (ch.provider_slug in WA_PROVIDER_LABELS && ch.status !== "disabled") {
        map.set(ch.id, { id: ch.id, provider_slug: ch.provider_slug });
      }
    }
    for (const c of conversationsQuery.data ?? []) {
      if (c.channel?.type === "whatsapp" && c.channel.id && !map.has(c.channel.id)) {
        map.set(c.channel.id, { id: c.channel.id, provider_slug: c.channel.provider_slug });
      }
    }
    return Array.from(map.values()).sort((a, b) =>
      waProviderLabel(a.provider_slug).localeCompare(waProviderLabel(b.provider_slug), "pt-BR"),
    );
  }, [conversationsQuery.data, tenantChannelsQuery.data]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Se o canal salvo no localStorage não existe mais entre os canais
    // conectados, cai para "todos" em vez de esvaziar a lista.
    const effectiveWaFilter =
      waChannelFilter !== "todos" && !waChannels.some((c) => c.id === waChannelFilter)
        ? "todos"
        : waChannelFilter;
    const triageIds =
      filterFromSearch === "atrasados"
        ? new Set(overdueConversations.map((c) => c.id))
        : filterFromSearch === "hoje"
          ? new Set(todayConversations.map((c) => c.id))
          : filterFromSearch === "pendencias"
            ? new Set(pendingConversations.map((c) => c.id))
            : null;
    return (conversationsQuery.data ?? [])
      .filter((c) => channelFilter === "todos" || c.channel?.type === channelFilter)
      .filter((c) => {
        if (effectiveWaFilter === "todos") return true;
        // O filtro por integração só se aplica a canais WhatsApp; conversas de
        // e-mail passam livres a menos que o filtro de canal já as exclua.
        if (c.channel?.type !== "whatsapp") return true;
        return c.channel_id === effectiveWaFilter;
      })
      .filter((c) => aiFilter === "todos" || (aiFilter === "ativa" ? c.ai_active : !c.ai_active))
      .filter((c) => !triageIds || triageIds.has(c.id))
      .filter((c) => {
        if (!q) return true;
        const name = c.contact?.name?.toLowerCase() ?? "";
        const last = c.last_message?.content?.toLowerCase() ?? "";
        const phone = c.contact?.phone?.toLowerCase() ?? "";
        return name.includes(q) || last.includes(q) || phone.includes(q);
      });
  }, [
    conversationsQuery.data,
    query,
    channelFilter,
    waChannelFilter,
    waChannels,
    aiFilter,
    filterFromSearch,
    overdueConversations,
    todayConversations,
    pendingConversations,
  ]);

  const selected =
    conversations.find((c) => c.id === selectedId) ??
    (selectedId && searchedConversationQuery.data?.id === selectedId
      ? searchedConversationQuery.data
      : null);

  // Auto-select first once loaded. Prioriza `conversationId` da URL (vindo da
  // busca global Cmd+K): se ele já está no array carregado, seleciona direto;
  // se não está, aguarda a busca pontual (`searchedConversationQuery`) — uma
  // conversa fora do teto de 500 ainda é exibida (via `selected` acima), e um
  // id inexistente/deletado não seleciona nada (mostra o estado vazio) em vez
  // de cair silenciosamente no primeiro item filtrado, que seria uma conversa
  // não relacionada à busca do usuário. Sem `conversationId` na URL, mantém o
  // comportamento antigo: seleciona o primeiro item filtrado.
  useEffect(() => {
    if (selectedId) return;
    if (conversationIdFromSearch) {
      if (conversations.some((c) => c.id === conversationIdFromSearch)) {
        selectConversation(conversationIdFromSearch);
      } else if (searchedConversationQuery.data) {
        selectConversation(searchedConversationQuery.data.id);
      }
      return;
    }
    const next = filtered[0];
    if (next) selectConversation(next.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filtered,
    conversations,
    selectedId,
    conversationIdFromSearch,
    searchedConversationQuery.data,
  ]);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [messagesQuery.data?.length, selectedId]);

  // Ref espelhando selectedId para os handlers realtime (o useEffect abaixo
  // só depende de tenantId; sem o ref, os closures veriam um selectedId stale).
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  // Realtime: subscribe once per tenant. RLS applies to the initial query,
  // and we also filter by tenant_id server-side on the channel to avoid
  // any cross-tenant leakage.
  useEffect(() => {
    if (!tenantId) return;
    const ch = supabase
      .channel(`inbox:${tenantId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `tenant_id=eq.${tenantId}`,
        },
        (payload) => {
          const msg = payload.new as MessageRow;
          // Append to open thread cache
          queryClient.setQueryData<MessageRow[] | undefined>(
            ["inbox-messages", msg.conversation_id],
            (prev) => (prev ? (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]) : prev),
          );
          // Conversa aberta = mensagem já vista. Re-zera unread para fechar a
          // corrida entre o trigger de incremento (bump_conversation_last_
          // message_at) e o zeramento do selectConversation: sem isto, se o
          // zero do cliente commitar depois do incremento (ou vice-versa), o
          // badge fica errado até a próxima seleção. Idempotente, escreve só
          // para a conversa em foco.
          if (msg.conversation_id === selectedIdRef.current) {
            void supabase
              .from("conversations")
              .update({ unread_count: 0 })
              .eq("id", msg.conversation_id)
              .then(({ error }) => {
                if (error) console.error("[inbox] falha ao re-zerar unread_count:", error.message);
              });
          }
          // Refresh list ordering + last message preview
          queryClient.invalidateQueries({ queryKey: ["inbox-conversations", tenantId] });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "messages",
          filter: `tenant_id=eq.${tenantId}`,
        },
        (payload) => {
          const msg = payload.new as MessageRow;
          queryClient.setQueryData<MessageRow[] | undefined>(
            ["inbox-messages", msg.conversation_id],
            (prev) => prev?.map((m) => (m.id === msg.id ? msg : m)),
          );
          queryClient.invalidateQueries({ queryKey: ["inbox-conversations", tenantId] });
        },
      )
      .on(
        "postgres_changes",
        // Sem filtro tenant_id — deliberado, não esquecimento: em DELETE o
        // payload.old só carrega as colunas da REPLICA IDENTITY (default =
        // só id), então um filtro por tenant_id nunca casaria e descartaria
        // TODOS os eventos silenciosamente. Sem risco: o handler só remove
        // ids do cache local, nada cross-tenant chega além do uuid.
        { event: "DELETE", schema: "public", table: "messages" },
        (payload) => {
          const old = payload.old as Partial<MessageRow>;
          if (!old?.id) return;
          queryClient.setQueriesData<MessageRow[] | undefined>(
            { queryKey: ["inbox-messages"] },
            (prev) => prev?.filter((m) => m.id !== old.id),
          );
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "conversations",
          filter: `tenant_id=eq.${tenantId}`,
        },
        () => {
          queryClient.invalidateQueries({ queryKey: ["inbox-conversations", tenantId] });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "conversations",
          filter: `tenant_id=eq.${tenantId}`,
        },
        () => {
          queryClient.invalidateQueries({ queryKey: ["inbox-conversations", tenantId] });
        },
      )
      .subscribe((status) => {
        // Sem este callback a falha do realtime é muda e a inbox para de atualizar.
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.error(`[inbox] realtime ${status} (tenant ${tenantId})`);
          queryClient.invalidateQueries({ queryKey: ["inbox-conversations", tenantId] });
        }
      });
    return () => {
      supabase.removeChannel(ch);
    };
  }, [tenantId, queryClient]);

  const zapi = useIntegration("zapi");
  const twilio = useIntegration("twilio");
  const resend = useIntegration("resend");
  const metaCloud = useIntegration("meta-cloud");
  const evolution = useIntegration("evolution");
  const zappaz = useIntegration("zappaz");

  const whatsappActive =
    zapi.isActive || twilio.isActive || metaCloud.isActive || evolution.isActive || zappaz.isActive;

  const sendMutation = useMutation({
    mutationFn: async (content: string) => {
      if (!selected || !tenantId) throw new Error("Sem conversa selecionada");
      const providerSlug = selected.channel?.provider_slug ?? null;
      const channelType = selected.channel?.type ?? null;
      const providerActive =
        (providerSlug === "zapi" && zapi.isActive) ||
        (providerSlug === "twilio" && twilio.isActive) ||
        (providerSlug === "meta-cloud" && metaCloud.isActive) ||
        (providerSlug === "evolution" && evolution.isActive) ||
        (providerSlug === "zappaz" && zappaz.isActive) ||
        (providerSlug === "resend" && resend.isActive) ||
        // ManyChat: o messaging-send confere integração e destino e devolve o
        // motivo; gravar só localmente fingiria envio.
        isManyChatSlug(providerSlug) ||
        providerSlug === "simulator";
      if (providerSlug && providerActive) {
        await sendViaProvider(selected.id, content);
        return null;
      }
      const row = await insertLocalMessage({ conversationId: selected.id, tenantId, content });
      if (channelType === "whatsapp" && !whatsappActive) {
        toast.info(
          "Mensagem salva no CRM, mas não foi enviada pelo WhatsApp — a integração está inativa.",
        );
      } else if (channelType === "email" && !resend.isActive) {
        toast.info(
          "Mensagem salva no CRM, mas não foi enviada por e-mail — a integração está inativa.",
        );
      }

      return row;
    },

    onSuccess: (msg) => {
      setDraft("");
      queryClient.invalidateQueries({ queryKey: ["inbox-messages", selected?.id] });
      if (msg) {
        queryClient.setQueryData<MessageRow[] | undefined>(
          ["inbox-messages", (msg as MessageRow).conversation_id],
          (prev) =>
            prev
              ? prev.some((m) => m.id === (msg as MessageRow).id)
                ? prev
                : [...prev, msg as MessageRow]
              : prev,
        );
      }
    },
    onError: (e: Error) => toast.error(e.message || "Falha ao enviar mensagem"),
  });

  const retryMutation = useMutation({
    mutationFn: async (m: MessageRow) => {
      if (!selected) throw new Error("Sem conversa selecionada");
      // Botão "Tentar de novo" só aparece pra status="failed" (não "draft"),
      // então filtramos por "failed" -- com "draft" o delete casaria 0 linhas,
      // a bolha de falha ficaria permanente e o reenvio criaria mensagem nova
      // (duplicação). Também checamos o erro do delete: se falhar, aborta
      // antes de reenviar pra não gerar duplicata.
      const { error: delError } = await supabase
        .from("messages")
        .delete()
        .eq("id", m.id)
        .eq("status", "failed");
      if (delError) throw delError;
      await sendViaProvider(selected.id, m.content ?? "");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["inbox-messages", selected?.id] });
    },
    onError: (e: Error) => toast.error(e.message || "Falha ao reenviar"),
  });

  const approveDraftMutation = useMutation({
    mutationFn: async (m: DraftApproval) => {
      if (editingDraftId === m.id) {
        throw new Error("Salve ou cancele a edição do rascunho antes de enviar.");
      }
      const { data, error } = await supabase.functions.invoke("messaging-send", {
        body: { draft_message_id: m.id, conversation_id: m.conversation_id },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error ?? "Não foi possível enviar o rascunho.");
    },
    onSuccess: (_data, m) => {
      toast.success("Rascunho aprovado e enviado.");
      queryClient.invalidateQueries({ queryKey: ["inbox-messages", selected?.id] });
      queryClient.invalidateQueries({ queryKey: ["inbox-conversations", tenantId] });
      queryClient.invalidateQueries({ queryKey: ["next-best-action-draft", m.conversation_id] });
    },
    onError: (e: Error) => toast.error(e.message || "Falha ao enviar rascunho"),
  });

  const discardDraftMutation = useMutation({
    mutationFn: async (m: MessageRow) => {
      const { error } = await supabase
        .from("messages")
        .delete()
        .eq("id", m.id)
        .eq("status", "draft");
      if (error) throw error;
      return m;
    },
    onSuccess: (m) => {
      if (editingDraftId === m.id) setEditingDraftId(null);
      queryClient.setQueryData<MessageRow[] | undefined>(
        ["inbox-messages", m.conversation_id],
        (prev) => prev?.filter((x) => x.id !== m.id),
      );
      queryClient.invalidateQueries({ queryKey: ["next-best-action-draft", m.conversation_id] });
      // Mesma invalidação que o aprovar já fazia: a linha da lista deriva
      // "A IA escreveu — falta você enviar" do rascunho, e sem isso ela
      // continuaria mandando enviar algo que acabou de ser descartado.
      queryClient.invalidateQueries({ queryKey: ["inbox-conversations", tenantId] });
    },
    onError: (e: Error) => toast.error(e.message || "Falha ao descartar rascunho"),
  });

  const saveDraftMutation = useMutation({
    mutationFn: async ({ message, content }: { message: MessageRow; content: string }) => {
      const text = content.trim();
      if (!tenantId || !text) throw new Error("Escreva o texto do rascunho antes de salvar.");
      const { data, error } = await supabase
        .from("messages")
        .update({ content: text })
        .eq("id", message.id)
        .eq("tenant_id", tenantId)
        .eq("conversation_id", message.conversation_id)
        .eq("status", "draft")
        .select("id")
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        throw new Error("O rascunho não está mais disponível para edição. Atualize a conversa.");
      }
      return { ...message, content: text };
    },
    onSuccess: (message) => {
      queryClient.setQueryData<MessageRow[]>(
        ["inbox-messages", message.conversation_id],
        (previous) => previous?.map((row) => (row.id === message.id ? message : row)),
      );
      queryClient.invalidateQueries({ queryKey: ["inbox-messages", message.conversation_id] });
      queryClient.invalidateQueries({ queryKey: ["inbox-conversations", tenantId] });
      queryClient.invalidateQueries({
        queryKey: ["next-best-action-draft", message.conversation_id],
      });
      toast.success("Rascunho atualizado. Revise antes de enviar.");
    },
    onError: (e: Error) => toast.error(e.message || "Falha ao salvar rascunho."),
  });

  const toggleAiMutation = useMutation({
    mutationFn: async (nextActive: boolean) => {
      if (!selected) throw new Error("Sem conversa selecionada");
      const { error } = await supabase
        .from("conversations")
        .update({
          ai_active: nextActive,
          awaiting_human: false,
          // Reativação EXPLÍCITA: o gate de takeover do ai-respond só volta a
          // bloquear a IA se um atendente responder DEPOIS deste instante.
          // Sem isso, uma resposta humana antiga travava a conversa para
          // sempre em "Aguardando humano".
          ...(nextActive ? { ai_resumed_at: new Date().toISOString() } : {}),
        })
        .eq("id", selected.id);
      if (error) throw error;
      // Reativar precisa limpar as DUAS fontes de pausa da IA: o toggle por
      // CONVERSA (acima) e o toggle por CONTATO (contacts.ai_paused, editado
      // em outra tela). Sem isto o badge mostra "IA ativa" mas ai-respond
      // continua bloqueando silenciosamente pelo gate ai_paused_contact.
      if (nextActive) {
        const { error: contactError } = await supabase
          .from("contacts")
          .update({ ai_paused: false })
          .eq("id", selected.contact_id);
        if (contactError) throw contactError;
      }
      return nextActive;
    },
    onMutate: async (nextActive) => {
      if (!selected) return;
      await queryClient.cancelQueries({ queryKey: ["inbox-conversations", tenantId] });
      const previous = queryClient.getQueryData<ConversationRow[]>([
        "inbox-conversations",
        tenantId,
        periodFromISO,
      ]);
      queryClient.setQueryData<ConversationRow[] | undefined>(
        ["inbox-conversations", tenantId, periodFromISO],
        (prev) =>
          prev?.map((c) =>
            c.id === selected.id ? { ...c, ai_active: nextActive, awaiting_human: false } : c,
          ),
      );
      return { previous };
    },
    onError: (e: Error, _v, ctx) => {
      if (ctx?.previous)
        queryClient.setQueryData(["inbox-conversations", tenantId, periodFromISO], ctx.previous);
      toast.error(e.message || "Falha ao atualizar IA");
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["inbox-conversations", tenantId] });
    },
  });

  // Modo Foco mantém `selectedId` sincronizado com o item corrente da fila —
  // "Responder" reusa o mesmo `sendMutation` da Lista (que já limpa
  // awaiting_human via messaging-send/index.ts), sem duplicar o caminho de
  // envio.
  useEffect(() => {
    if (mode !== "foco" || !currentFocusItem) return;
    if (selectedId !== currentFocusItem.id) selectConversation(currentFocusItem.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, currentFocusItem?.id]);

  const resolveMutation = useMutation({
    mutationFn: async (conversationId: string) => {
      const { error } = await supabase
        .from("conversations")
        .update({ awaiting_human: false, ai_resumed_at: new Date().toISOString() })
        .eq("id", conversationId);
      if (error) throw error;
      return conversationId;
    },
    onSuccess: (conversationId) => {
      queryClient.setQueryData<ConversationRow[] | undefined>(
        ["inbox-conversations", tenantId, periodFromISO],
        (prev) => prev?.map((c) => (c.id === conversationId ? { ...c, awaiting_human: false } : c)),
      );
    },
    onError: (e: Error) => toast.error(e.message || "Falha ao resolver conversa"),
  });

  // Mirror do resolveMutation acima: mesma tabela/campo, valor invertido —
  // reabre uma conversa já resolvida (`awaiting_human: false`) de volta pra
  // fila de atenção humana.
  const reopenMutation = useMutation({
    mutationFn: async (conversationId: string) => {
      const { error } = await supabase
        .from("conversations")
        .update({ awaiting_human: true })
        .eq("id", conversationId);
      if (error) throw error;
      return conversationId;
    },
    onSuccess: (conversationId) => {
      queryClient.setQueryData<ConversationRow[] | undefined>(
        ["inbox-conversations", tenantId, periodFromISO],
        (prev) => prev?.map((c) => (c.id === conversationId ? { ...c, awaiting_human: true } : c)),
      );
    },
    onError: (e: Error) => toast.error(e.message || "Falha ao reabrir conversa"),
  });

  // RLS ("conversations tenant all") libera UPDATE pra qualquer membro do
  // tenant — sem gate de admin (decisão de produto, Felipe 2026-07-19).
  // Exclusão é SOFT (marca `deleted_at`), não hard-delete/cascata: a linha e
  // as mensagens permanecem no banco, somem só das leituras (filtro
  // `.is("deleted_at", null)`) e a conversa ressuscita quando o contato manda
  // mensagem nova (trigger no backend).
  const deleteMutation = useMutation({
    mutationFn: async (conversationId: string) => {
      // PostgREST devolve error nulo com 0 linhas quando o RLS bloqueia ou a
      // conversa já sumiu — sem `.select()` + checagem das linhas afetadas a UI
      // mostraria "excluída" sem nada ter sido marcado.
      const { data, error } = await supabase
        .from("conversations")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", conversationId)
        .select("id");
      if (error) throw error;
      if (!data || data.length === 0) {
        throw new Error("Conversa não encontrada ou sem permissão para excluir");
      }
      return conversationId;
    },
    onSuccess: (conversationId) => {
      queryClient.setQueryData<ConversationRow[] | undefined>(
        ["inbox-conversations", tenantId, periodFromISO],
        (prev) => prev?.filter((c) => c.id !== conversationId),
      );
      if (selectedId === conversationId) {
        setSelectedId(null);
        void navigate({
          to: ".",
          search: (prev: InboxSearch) => ({ ...prev, conversationId: undefined }),
        });
      }
      toast.success("Conversa excluída");
    },
    onError: (e: Error) => toast.error(e.message || "Falha ao excluir conversa"),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["inbox-conversations", tenantId] });
    },
  });

  function handleFocusReply(content: string) {
    sendMutation.mutate(content, { onSuccess: () => advanceFocus() });
  }

  function handleFocusSkip() {
    advanceFocus();
  }

  function handleFocusResolve() {
    if (!currentFocusItem) return;
    resolveMutation.mutate(currentFocusItem.id);
  }

  function handleListKeyDown(e: KeyboardEvent<HTMLUListElement>) {
    if (!["ArrowDown", "ArrowUp", "Enter", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const idx = filtered.findIndex((t) => t.id === selectedId);
    if (e.key === "ArrowDown")
      selectConversation(filtered[Math.min(filtered.length - 1, idx + 1)]?.id ?? null);
    else if (e.key === "ArrowUp") selectConversation(filtered[Math.max(0, idx - 1)]?.id ?? null);
    else if (e.key === "Home") selectConversation(filtered[0]?.id ?? null);
    else if (e.key === "End") selectConversation(filtered[filtered.length - 1]?.id ?? null);
  }

  function onDraftKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const text = draft.trim();
      if (text && !sendMutation.isPending) sendMutation.mutate(text);
    }
  }

  const isLoading = profileLoading || conversationsQuery.isLoading;

  return (
    <div
      className={cn(
        "col-span-12 flex min-h-0 flex-col gap-4",
        mode === "lista" && "h-full overflow-hidden",
      )}
    >
      <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
        <PageHeader
          title="Conversas"
          description="Central de conversas de WhatsApp e e-mail."
          actions={
            <div className="flex flex-wrap gap-2">
              <SimulatorLauncher
                onSent={(id) => {
                  setSelectedId(id);
                  void navigate({ search: { mode: "lista", conversationId: id } });
                }}
              />
              {mode === "lista" ? (
                <Button
                  variant="outline"
                  onClick={handleExportConversations}
                  disabled={isExporting}
                >
                  {isExporting ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <Download className="mr-1 h-4 w-4" />
                  )}
                  Exportar CSV
                </Button>
              ) : undefined}
            </div>
          }
        />
        <InboxModeTabs mode={mode} onChange={setMode} />
      </div>

      {mode === "geral" && (
        <InboxOverviewView
          overdueCount={overdueConversations.length}
          todayCount={todayConversations.length}
          pendingCount={pendingConversations.length}
          onOpenFilter={openFilter}
          coldDeals={coldDeals.map((d) => ({
            id: d.id,
            title: d.title,
            contactName: d.contact?.name ?? null,
            contactId: d.contact_id,
          }))}
          coldConversations={coldConversations.map((c) => ({
            id: c.id,
            contactName: c.contact?.name ?? null,
            contactId: c.contact_id,
          }))}
          onOpenDeal={() => void navigate({ to: "/pipeline" })}
          onOpenConversation={(conversationId) =>
            void navigate({ search: { mode: "lista" as const, conversationId } })
          }
          hotLeads={hotLeads.map((h) => ({
            contactId: h.contact_id,
            contactName: h.contact?.name ?? null,
            rationale: h.rationale,
          }))}
          onOpenContact={(contactId) => {
            const conv = conversations.find((c) => c.contact_id === contactId);
            void navigate({
              search: { mode: "lista" as const, conversationId: conv?.id },
            });
          }}
          focusQueueEmpty={focusQueue.length === 0}
          onStartFocus={() => setMode("foco")}
          onApplyDeal={handleApplyDeal}
          onApplyConversation={handleApplyConversation}
          onApplyOpportunity={handleApplyOpportunity}
          applyingKeys={applyingKeys}
        />
      )}

      {mode === "foco" &&
        (currentFocusItem ? (
          <InboxFocusView
            currentItem={currentFocusItem}
            currentIndex={focusIndex}
            totalItems={focusQueue.length}
            onReply={handleFocusReply}
            onSkip={handleFocusSkip}
            onResolve={handleFocusResolve}
            onExitFocus={() => setMode("lista")}
            replyPending={sendMutation.isPending}
          />
        ) : (
          <InboxZeroState
            hiddenByPeriod={hiddenByPeriod}
            periodLabel={periodLabel}
            onWidenPeriod={() => setPeriod(WIDEST_PERIOD)}
          />
        ))}

      {mode === "lista" && (
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden rounded-lg border border-border bg-card lg:grid-cols-[minmax(300px,360px)_minmax(0,1fr)]">
          {/* Coluna esquerda */}
          <aside
            className={cn(
              "min-h-0 min-w-0 flex-col overflow-hidden border-border lg:flex lg:border-r",
              selected ? "hidden" : "flex",
            )}
          >
            <div className="flex flex-col gap-2 border-b border-border p-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Buscar conversa..."
                  className="pl-8"
                  aria-label="Buscar conversa"
                />
              </div>
              <div className="flex gap-2">
                <Select
                  value={channelFilter}
                  onValueChange={(v) => setChannelFilter(v as typeof channelFilter)}
                >
                  <SelectTrigger className="h-8 flex-1 text-caption" aria-label="Filtrar por canal">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="todos">Todos os canais</SelectItem>
                    <SelectItem value="whatsapp">WhatsApp</SelectItem>
                    <SelectItem value="email">E-mail</SelectItem>
                    <SelectItem value="instagram">Instagram</SelectItem>
                    <SelectItem value="messenger">Messenger</SelectItem>
                    <SelectItem value="simulator">Simulação</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={aiFilter} onValueChange={(v) => setAiFilter(v as typeof aiFilter)}>
                  <SelectTrigger
                    className="h-8 flex-1 text-caption"
                    aria-label="Filtrar por situação da IA"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="todos">Todas</SelectItem>
                    <SelectItem value="ativa">IA ativa</SelectItem>
                    <SelectItem value="pausada">IA pausada</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {waChannels.length > 1 &&
                (channelFilter === "todos" || channelFilter === "whatsapp") && (
                  <Select value={waChannelFilter} onValueChange={setWaChannelFilter}>
                    <SelectTrigger
                      className="h-8 text-caption"
                      aria-label="Filtrar por integração de WhatsApp"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="todos">Todas as integrações</SelectItem>
                      {waChannels.map((ch, i) => {
                        const label = waProviderLabel(ch.provider_slug);
                        const duplicated =
                          waChannels.filter((o) => o.provider_slug === ch.provider_slug).length > 1;
                        return (
                          <SelectItem key={ch.id} value={ch.id}>
                            {duplicated ? `${label} #${i + 1}` : label}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                )}
            </div>

            {isLoading ? (
              <div className="flex-1 space-y-2 p-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="h-16 animate-pulse rounded-md bg-muted/50" />
                ))}
              </div>
            ) : conversationsQuery.isError ? (
              <div className="flex-1 p-4">
                <EmptyState
                  icon={AlertCircle}
                  title="Erro ao carregar"
                  description="Não foi possível carregar as conversas. Tente novamente."
                />
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex-1 p-4">
                {hiddenByPeriod > 0 ? (
                  <EmptyState
                    icon={InboxIcon}
                    title="Nenhuma conversa neste período"
                    description={`${hiddenByPeriod} ${hiddenByPeriod === 1 ? "conversa aberta mais antiga está" : "conversas abertas mais antigas estão"} fora de "${periodLabel}".`}
                    actionLabel="Ampliar período"
                    onAction={() => setPeriod(WIDEST_PERIOD)}
                  />
                ) : filterFromSearch ? (
                  <EmptyState
                    icon={InboxIcon}
                    title="Nenhuma conversa neste filtro"
                    description="Nenhuma conversa atende ao recorte de triagem escolhido."
                    actionLabel="Ver todas"
                    onAction={() =>
                      void navigate({
                        to: ".",
                        search: (prev: InboxSearch) => ({ ...prev, filter: undefined }),
                      })
                    }
                  />
                ) : (
                  <EmptyState
                    icon={InboxIcon}
                    title="Sem conversas"
                    description="As conversas aparecerão aqui à medida que chegarem pelos canais conectados."
                  />
                )}
              </div>
            ) : (
              <ul
                ref={listRef}
                tabIndex={0}
                role="listbox"
                aria-label="Lista de conversas"
                onKeyDown={handleListKeyDown}
                className="flex-1 overflow-y-auto overscroll-contain [scrollbar-color:var(--border-strong)_transparent] [scrollbar-width:thin] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {filtered.map((t) => {
                  const last = t.last_message;
                  const isSelected = t.id === selectedId;
                  return (
                    <li key={t.id} role="option" aria-selected={isSelected}>
                      <button
                        type="button"
                        onClick={() => selectConversation(t.id)}
                        className={cn(
                          "flex w-full items-start gap-3 border-b border-border px-3 py-3 text-left transition-colors hover:bg-accent focus:outline-none focus-visible:bg-accent",
                          isSelected && "bg-accent",
                        )}
                      >
                        <ContactAvatar name={t.contact?.name} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-body font-medium text-foreground">
                              {t.contact?.name ?? "Contato"}
                            </span>
                            <ChannelIcon type={t.channel?.type} />
                            <span className="ml-auto shrink-0 text-caption text-muted-foreground">
                              {t.last_message_at ? formatTime(t.last_message_at) : ""}
                            </span>
                          </div>
                          <div className="mt-0.5 flex items-center gap-2">
                            <p className="min-w-0 flex-1 truncate text-caption text-muted-foreground">
                              {last?.sender === "ai"
                                ? "IA: "
                                : last?.sender === "agent"
                                  ? "Você: "
                                  : ""}
                              {last?.content ?? "Sem mensagens"}
                            </p>
                            {(t.unread_count ?? 0) > 0 && (
                              <span
                                className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-caption font-semibold text-primary-foreground"
                                aria-label={`${t.unread_count} mensagens não lidas`}
                              >
                                {t.unread_count}
                              </span>
                            )}
                          </div>
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                            <StatusBadge variant={t.ai_active ? "success" : "neutral"}>
                              {t.ai_active ? "IA ativa" : "IA pausada"}
                            </StatusBadge>
                            {/* "Aguardando humano" cobre 4 causas (pedido do
                            lead, alguém assumiu, falha, rascunho) e nenhuma
                            delas explica a mais comum. Com rascunho na fila o
                            recado é específico: a IA já escreveu, falta enviar. */}
                            {t.has_pending_draft ? (
                              <StatusBadge variant="warning">
                                A IA escreveu — falta você enviar
                              </StatusBadge>
                            ) : (
                              t.awaiting_human && (
                                <StatusBadge variant="warning">Aguardando humano</StatusBadge>
                              )
                            )}
                            {t.last_error && <AiErrorBadge error={t.last_error} />}
                          </div>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </aside>

          {/* Coluna direita */}
          {selected ? (
            <section className="flex min-h-0 min-w-0 flex-col">
              <header className="grid shrink-0 grid-cols-1 items-start gap-3 border-b border-border p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:p-4">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => selectConversation(null)}
                    className="shrink-0 lg:hidden"
                    aria-label="Voltar para a lista de conversas"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <ContactAvatar name={selected.contact?.name} size="md" />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="min-w-0 truncate text-card-title font-semibold text-foreground">
                        {selected.contact?.name ?? "Contato"}
                      </h2>
                      <ChannelIcon type={selected.channel?.type} />

                      <StatusBadge variant={selected.ai_active ? "success" : "neutral"}>
                        {selected.ai_active ? "IA ativa" : "IA pausada"}
                      </StatusBadge>
                      {selected.channel?.provider_slug === "simulator" && (
                        <StatusBadge variant="warning">
                          Simulação — não entregue no WhatsApp
                        </StatusBadge>
                      )}
                      {selected.awaiting_human && (
                        <StatusBadge variant="warning">Aguardando humano</StatusBadge>
                      )}
                      {selected.last_error && <AiErrorBadge error={selected.last_error} />}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-caption text-muted-foreground">
                      {selected.contact?.phone && <span>{selected.contact.phone}</span>}
                      {selected.contact?.email && <span>{selected.contact.email}</span>}
                      {selected.contact?.tags?.map((tag) => {
                        const color = tagColors.get(tag) ?? "#64748b";
                        return (
                          <span
                            key={tag}
                            className="rounded-full border px-2 py-0.5 text-caption font-medium"
                            style={{
                              color,
                              borderColor: `${color}66`,
                              backgroundColor: `${color}1a`,
                            }}
                          >
                            {tag}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                </div>
                <div className="flex min-w-0 flex-wrap items-center justify-start gap-2 sm:shrink-0 sm:justify-end">
                  {/* Atalho sempre visível de criar follow-up — nunca depende da
                    detecção de intenção do banner (PRD, riscos #7). */}
                  <Button variant="outline" size="sm" onClick={() => setQuickFollowupOpen(true)}>
                    <CalendarClock className="mr-1.5 h-4 w-4" />
                    Retorno
                  </Button>
                  {selected.ai_active ? (
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => toggleAiMutation.mutate(false)}
                      disabled={toggleAiMutation.isPending}
                    >
                      Assumir conversa
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => toggleAiMutation.mutate(true)}
                      disabled={toggleAiMutation.isPending}
                    >
                      Reativar IA
                    </Button>
                  )}
                  {!selected.awaiting_human && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => reopenMutation.mutate(selected.id)}
                      disabled={reopenMutation.isPending}
                    >
                      Reabrir
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setConfirmDeleteOpen(true)}
                    disabled={deleteMutation.isPending}
                    aria-label="Excluir conversa"
                  >
                    <Trash2 className="h-4 w-4 xl:mr-1.5" aria-hidden />
                    <span className="hidden xl:inline">Excluir conversa</span>
                  </Button>
                </div>
              </header>

              <AlertDialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Excluir conversa</AlertDialogTitle>
                    <AlertDialogDescription>
                      Tem certeza que deseja excluir a conversa com{" "}
                      {selected.contact?.name ?? "este contato"}? Ela sai da sua lista de conversas;
                      o histórico de mensagens é preservado.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancelar</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => {
                        setConfirmDeleteOpen(false);
                        deleteMutation.mutate(selected.id);
                      }}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      Excluir
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>

              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain bg-surface p-3 [scrollbar-color:var(--border-strong)_transparent] [scrollbar-width:thin] sm:p-4">
                {messagesQuery.isLoading ? (
                  <div className="space-y-3">
                    {Array.from({ length: 4 }).map((_, i) => (
                      <div key={i} className="h-14 animate-pulse rounded-md bg-muted/50" />
                    ))}
                  </div>
                ) : messagesQuery.isError ? (
                  <EmptyState
                    icon={AlertCircle}
                    title="Erro ao carregar mensagens"
                    description="Tente novamente."
                  />
                ) : (messagesQuery.data?.length ?? 0) === 0 ? (
                  <EmptyState
                    icon={MessageCircle}
                    title="Sem mensagens"
                    description="Nenhuma mensagem nessa conversa ainda."
                  />
                ) : (
                  <>
                    <MessageList
                      messages={messagesQuery.data ?? []}
                      onRetry={(m) => retryMutation.mutate(m)}
                      retryingId={
                        retryMutation.isPending
                          ? (retryMutation.variables as MessageRow | undefined)?.id
                          : undefined
                      }
                      onApproveDraft={(m) => approveDraftMutation.mutate(m)}
                      onDiscardDraft={(m) => discardDraftMutation.mutate(m)}
                      editingDraftId={editingDraftId}
                      onEditDraft={setEditingDraftId}
                      onSaveDraft={(message, content) =>
                        saveDraftMutation.mutateAsync({ message, content }).then(
                          () => true,
                          () => false,
                        )
                      }
                      savingDraftId={
                        saveDraftMutation.isPending
                          ? saveDraftMutation.variables?.message.id
                          : undefined
                      }
                      approvingDraftId={
                        approveDraftMutation.isPending
                          ? approveDraftMutation.variables?.id
                          : undefined
                      }
                      discardingDraftId={
                        discardDraftMutation.isPending
                          ? discardDraftMutation.variables?.id
                          : undefined
                      }
                    />
                    <div ref={messagesEndRef} />
                  </>
                )}
              </div>

              <div className="flex flex-col gap-2 border-t border-border bg-card p-3">
                {profile && (
                  <NextBestActionCard
                    tenantId={profile.tenant_id}
                    conversationId={selected.id}
                    contactId={selected.contact_id}
                    onApproveDraft={(m) => approveDraftMutation.mutate(m)}
                    approvingDraftId={
                      approveDraftMutation.isPending
                        ? approveDraftMutation.variables?.id
                        : undefined
                    }
                  />
                )}
                {profile && (
                  <FollowUpSuggestionBanner
                    key={selected.contact_id}
                    messages={messagesQuery.data ?? []}
                    contactId={selected.contact_id}
                    dealId={null}
                    tenantId={profile.tenant_id}
                    createdBy={profile.id}
                  />
                )}
                <div className="flex items-end gap-2">
                  <Textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={onDraftKey}
                    placeholder="Escreva sua resposta..."
                    className="field-sizing-content max-h-28 min-h-[44px] resize-none"
                    rows={1}
                    aria-label="Nova mensagem"
                  />
                  <Button
                    onClick={() => {
                      const text = draft.trim();
                      if (text) sendMutation.mutate(text);
                    }}
                    disabled={!draft.trim() || sendMutation.isPending}
                    aria-label="Enviar mensagem"
                  >
                    <Send className="h-4 w-4" />
                    <span className="ml-2 hidden sm:inline">Enviar</span>
                  </Button>
                </div>
                <p className="text-caption text-muted-foreground">
                  Enter envia · Shift+Enter quebra linha
                </p>
                {selected.channel?.provider_slug === "simulator" && tenantId && (
                  <details className="rounded-md border border-border p-2">
                    <summary className="cursor-pointer text-sm font-medium">
                      Enviar como cliente (simulação)
                    </summary>
                    <div className="mt-2">
                      <SimulatorComposer
                        key={selected.id}
                        tenantId={tenantId}
                        channelId={selected.channel_id}
                        conversationId={selected.id}
                      />
                    </div>
                  </details>
                )}
              </div>
              {profile && (
                <QuickFollowupDialog
                  open={quickFollowupOpen}
                  onOpenChange={setQuickFollowupOpen}
                  contactId={selected.contact_id}
                  dealId={null}
                  tenantId={profile.tenant_id}
                  createdBy={profile.id}
                />
              )}
            </section>
          ) : (
            <section className="flex items-center justify-center bg-surface p-8">
              <EmptyState
                icon={MessageCircle}
                title={isLoading ? "Carregando..." : "Selecione uma conversa"}
                description={
                  isLoading
                    ? ""
                    : "Escolha uma conversa à esquerda para ver o histórico e responder."
                }
              />
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function ContactAvatar({ name, size = "sm" }: { name?: string | null; size?: "sm" | "md" }) {
  return <InitialsAvatar name={name} variant="accent" size={size === "md" ? "xl" : "lg"} />;
}

function ChannelIcon({ type }: { type?: ChannelType }) {
  if (type === "simulator")
    return <span className="text-caption font-medium text-muted-foreground">SIMULAÇÃO</span>;
  if (type === "email")
    return <Mail className="h-3.5 w-3.5 text-muted-foreground" aria-label="E-mail" />;
  if (type === "instagram")
    return <Instagram className="h-3.5 w-3.5 text-muted-foreground" aria-label="Instagram" />;
  if (type === "messenger")
    return <MessagesSquare className="h-3.5 w-3.5 text-muted-foreground" aria-label="Messenger" />;
  return <MessageCircle className="h-3.5 w-3.5 text-success" aria-label="WhatsApp" />;
}

/**
 * Badge de erro de IA — trata RATE_LIMIT com countdown (quando o backend
 * informou `retryAfterSeconds`); todos os outros códigos mantêm o badge
 * genérico estático (fora de escopo tratar os outros 7 códigos aqui).
 */
function AiErrorBadge({ error }: { error: AiError }) {
  if (isRateLimitError(error) && error.retryAfterSeconds !== undefined) {
    return <RateLimitCountdownBadge retryAfterSeconds={error.retryAfterSeconds} />;
  }
  return <StatusBadge variant="destructive">{getAiErrorLabel(error.code)}</StatusBadge>;
}

/**
 * Countdown simples (setInterval, sem lib nova) até a próxima tentativa
 * automática de IA. Reinicia sempre que `retryAfterSeconds` mudar (ex.: um
 * novo erro de rate limit substitui o anterior com um prazo diferente).
 * Chegando a zero, mostra um rótulo neutro — o backend é quem de fato
 * reexecuta a chamada; a UI só comunica a expectativa de espera.
 */
function RateLimitCountdownBadge({ retryAfterSeconds }: { retryAfterSeconds: number }) {
  const [secondsLeft, setSecondsLeft] = useState(retryAfterSeconds);

  useEffect(() => {
    setSecondsLeft(retryAfterSeconds);
    if (retryAfterSeconds <= 0) return;
    const id = setInterval(() => {
      setSecondsLeft((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => clearInterval(id);
  }, [retryAfterSeconds]);

  return (
    // `data-seconds-left` só existe pra teste provar o clamp interno
    // (`s > 0 ? s - 1 : 0`) sem depender do texto — o rótulo mascara
    // qualquer `secondsLeft <= 0` com o mesmo "Tentando de novo…".
    <span data-seconds-left={secondsLeft}>
      <StatusBadge variant="destructive">
        {secondsLeft > 0 ? `Tentando de novo em ${secondsLeft}s` : "Tentando de novo…"}
      </StatusBadge>
    </span>
  );
}

function MessageList({
  messages,
  onRetry,
  retryingId,
  onApproveDraft,
  onDiscardDraft,
  onSaveDraft,
  savingDraftId,
  editingDraftId,
  onEditDraft,
  approvingDraftId,
  discardingDraftId,
}: {
  messages: MessageRow[];
  onRetry?: (m: MessageRow) => void;
  retryingId?: string;
  onApproveDraft?: (m: MessageRow) => void;
  onDiscardDraft?: (m: MessageRow) => void;
  onSaveDraft?: (message: MessageRow, content: string) => Promise<boolean>;
  savingDraftId?: string;
  editingDraftId?: string | null;
  onEditDraft?: (draftId: string | null) => void;
  approvingDraftId?: string;
  discardingDraftId?: string;
}) {
  const items: React.ReactNode[] = [];
  let lastDate: Date | null = null;
  messages.forEach((m) => {
    const d = new Date(m.created_at);
    if (!lastDate || !isSameDay(d, lastDate)) {
      items.push(
        <div key={`sep-${m.id}`} className="flex items-center justify-center py-1">
          <span className="rounded-full border border-border bg-card px-2.5 py-0.5 text-caption text-muted-foreground">
            {formatDate(d)}
          </span>
        </div>,
      );
      lastDate = d;
    }
    if (m.status === "draft") {
      items.push(
        <DraftBubble
          key={m.id}
          m={m}
          onApprove={onApproveDraft ? () => onApproveDraft(m) : undefined}
          onDiscard={onDiscardDraft ? () => onDiscardDraft(m) : undefined}
          onSave={onSaveDraft ? (content) => onSaveDraft(m, content) : undefined}
          saving={savingDraftId === m.id}
          editing={editingDraftId === m.id}
          onEdit={onEditDraft ? (editing) => onEditDraft(editing ? m.id : null) : undefined}
          approving={approvingDraftId === m.id}
          discarding={discardingDraftId === m.id}
        />,
      );
      return;
    }
    items.push(
      <Bubble
        key={m.id}
        m={m}
        onRetry={onRetry ? () => onRetry(m) : undefined}
        retrying={retryingId === m.id}
      />,
    );
  });
  return <>{items}</>;
}

function DraftBubble({
  m,
  onApprove,
  onDiscard,
  onSave,
  saving,
  editing,
  onEdit,
  approving,
  discarding,
}: {
  m: MessageRow;
  onApprove?: () => void;
  onDiscard?: () => void;
  onSave?: (content: string) => Promise<boolean>;
  saving?: boolean;
  editing?: boolean;
  onEdit?: (editing: boolean) => void;
  approving?: boolean;
  discarding?: boolean;
}) {
  const [draftText, setDraftText] = useState(m.content ?? "");
  const busy = approving || discarding || saving;
  return (
    <div className="flex justify-end">
      <div className="max-w-[75%] rounded-lg border border-dashed border-primary/60 bg-primary/5 px-3 py-2 shadow-sm">
        <div className="mb-1 inline-flex items-center gap-1 rounded bg-primary/15 px-1.5 py-0.5 text-caption font-medium text-primary">
          <AiPersonaBadge tenantId={m.tenant_id} size="xs" /> · Rascunho
        </div>
        {editing ? (
          <div className="space-y-2">
            <Textarea
              aria-label="Texto do rascunho"
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              disabled={busy}
            />
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => onEdit?.(false)} disabled={busy}>
                Cancelar edição
              </Button>
              <Button
                size="sm"
                disabled={busy || !draftText.trim() || !onSave}
                onClick={async () => {
                  if (await onSave?.(draftText)) onEdit?.(false);
                }}
              >
                {saving ? "Salvando..." : "Salvar rascunho"}
              </Button>
            </div>
          </div>
        ) : (
          m.content && <p className="whitespace-pre-wrap text-body text-foreground">{m.content}</p>
        )}
        <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
          {!editing && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || !onSave}
              onClick={() => {
                setDraftText(m.content ?? "");
                onEdit?.(true);
              }}
            >
              Editar rascunho
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onDiscard} disabled={busy || !onDiscard}>
            {discarding ? "Descartando…" : "Descartar"}
          </Button>
          <Button size="sm" onClick={onApprove} disabled={busy || editing || !onApprove}>
            <Send className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="ml-1.5">{approving ? "Enviando…" : "Aprovar e enviar"}</span>
          </Button>
        </div>
      </div>
    </div>
  );
}

function Bubble({
  m,
  onRetry,
  retrying,
}: {
  m: MessageRow;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const mine = m.sender !== "contact";
  const isImage = m.media_url && m.media_type?.startsWith("image/");
  const isAudio = (m.media_url || m.audio_storage_path) && m.media_type?.startsWith("audio/");
  const failed = m.status === "failed";
  const pending = m.status === "pending";
  return (
    <div className={cn("flex", mine ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[75%] rounded-lg border px-3 py-2 shadow-sm",
          failed
            ? "border-destructive/40 bg-destructive/5 text-foreground"
            : mine
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-card text-card-foreground",
        )}
      >
        {m.sender === "ai" && (
          <div className="mb-1 inline-flex items-center gap-1 rounded bg-primary-foreground/15 px-1.5 py-0.5 text-caption font-medium">
            <AiPersonaBadge tenantId={m.tenant_id} size="xs" />
          </div>
        )}
        {isImage && (
          <a href={m.media_url!} target="_blank" rel="noreferrer" className="mb-1 block">
            <img
              src={m.media_url!}
              alt="Anexo"
              className="max-h-64 rounded-md border border-border object-cover"
              loading="lazy"
            />
          </a>
        )}
        {isAudio &&
          (m.audio_storage_path ? (
            <>
              {m.audio_status === "failed" && (
                <p className="mb-1 text-caption font-medium text-destructive">
                  Áudio gerado, mas não enviado — o lead recebeu o texto abaixo.
                </p>
              )}
              <PrivateAudio storagePath={m.audio_storage_path} />
            </>
          ) : (
            <audio controls src={m.media_url!} className="mb-1 w-full max-w-[280px]">
              <a href={m.media_url!}>Baixar áudio</a>
            </audio>
          ))}
        {!isImage && !isAudio && m.media_url && (
          <a
            href={m.media_url}
            target="_blank"
            rel="noreferrer"
            className={cn(
              "mb-1 block break-all text-caption underline",
              mine ? "text-primary-foreground/90" : "text-primary",
            )}
          >
            {m.media_url}
          </a>
        )}
        {m.content && <p className="whitespace-pre-wrap text-body">{m.content}</p>}
        <div
          className={cn(
            "mt-1 flex items-center justify-end gap-2 text-caption",
            failed
              ? "text-destructive"
              : mine
                ? "text-primary-foreground/75"
                : "text-muted-foreground",
          )}
        >
          {pending && <span>Enviando…</span>}
          {failed && (
            <>
              <AlertCircle className="h-3 w-3" aria-hidden="true" />
              <span>{m.send_error || "Falha ao enviar"}</span>
              {onRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  disabled={retrying}
                  className="underline decoration-dotted hover:no-underline disabled:opacity-60"
                >
                  {retrying ? "Reenviando…" : "Tentar de novo"}
                </button>
              )}
            </>
          )}
          {!failed && !pending && <span>{formatTime(m.created_at)}</span>}
        </div>
      </div>
    </div>
  );
}

function PrivateAudio({ storagePath }: { storagePath: string }) {
  const signedUrl = useQuery({
    queryKey: ["ai-audio-signed-url", storagePath],
    queryFn: async () => {
      const { data, error } = await supabase.storage
        .from("ai-audio")
        .createSignedUrl(storagePath, 600);
      if (error) throw error;
      if (!data.signedUrl) throw new Error("URL assinada de áudio não foi gerada.");
      return data.signedUrl;
    },
    staleTime: 8 * 60 * 1000,
    refetchInterval: 8 * 60 * 1000,
  });

  if (signedUrl.isPending) {
    return <p className="mb-1 text-caption opacity-75">Carregando áudio…</p>;
  }
  if (signedUrl.isError) {
    return <p className="mb-1 text-caption text-destructive">Áudio indisponível.</p>;
  }
  return (
    <audio controls src={signedUrl.data} className="mb-1 w-full max-w-[280px]">
      <a href={signedUrl.data}>Baixar áudio</a>
    </audio>
  );
}
