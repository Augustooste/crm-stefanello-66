import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  Bot,
  ClipboardList,
  Download,
  FileSignature,
  FileText,
  FilterX,
  Info,
  LayoutGrid,
  Loader2,
  MoreVertical,
  Plus,
  Search,
  Table as TableIcon,
  Trophy,
  XCircle,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useForm } from "react-hook-form";

import { PageHeader } from "@/components/common/PageHeader";
import { BoardSwitcher, boardStorageKey, type Board } from "@/components/pipeline/BoardSwitcher";
import { PipelineTable, type PipelineTableRow } from "@/components/pipeline/PipelineTable";
import { EmptyState } from "@/components/common/EmptyState";
import { OnboardingWizard, ONBOARDING_STEP_NICHO } from "@/components/onboarding/OnboardingWizard";
import { StatusBadge } from "@/components/common/StatusBadge";
import { useDealExport } from "@/hooks/use-deal-export";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile, useTenantProfiles } from "@/lib/api/session";
import { usePluginActive } from "@/lib/api/plugins";
import { formatBRL, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  ACTIVITY_STATUS_LABEL,
  ACTIVITY_STATUS_VARIANT,
  getActivityStatus,
  getNextActivityDueAt,
  isDealRotting,
  type ActivityForHealth,
  type ActivityStatus,
} from "@/lib/deal-health";
import { buildDealBriefing, type DealBriefing, type DealFollowupStatus } from "@/lib/deal-briefing";
import { DealChatDialog } from "@/components/pipeline/deal-chat-dialog";
import { MeetingPrepSheet } from "@/components/pipeline/meeting-prep-sheet";
import { MeetingResultSheet } from "@/components/pipeline/meeting-result-sheet";
import { ProposalSheet } from "@/components/pipeline/proposal-sheet";
import {
  AutomationSettingsDialog,
  DealAutomationDetails,
  type DealAutomationSnapshot,
} from "@/components/pipeline/PipelineAutomation";
import {
  transitionDealStage,
  usePipelineAutomationState,
  usePipelineRealtime,
} from "@/lib/api/pipeline-automation";
import type { CustomFieldOption, CustomFieldType } from "@/lib/custom-fields";
import type { CustomFieldColumn } from "@/lib/custom-field-display";

type Stage = { id: string; name: string; position: number; is_won: boolean; is_lost: boolean };
type DealRow = {
  id: string;
  title: string;
  value: number | null;
  stage_id: string;
  owner_id: string | null;
  status: string | null;
  lost_reason?: string | null;
  contact_id: string | null;
  created_at: string;
  stage_entered_at: string;
  custom_fields: Record<string, unknown>;
  automation_mode: string;
  automation_paused_until: string | null;
  automation_lock_reason: string | null;
  last_ai_transition_at: string | null;
  ai_transition_count_24h: number;
  contact: {
    id: string;
    name: string;
    tags: string[] | null;
    source: string | null;
    company_id: string | null;
  } | null;
};
type ActivityRow = { deal_id: string | null; due_at: string | null; completed_at: string | null };
type FollowupRow = { deal_id: string | null; scheduled_at: string; status: string };
type HotVerdictRow = { contact_id: string };

/** Contexto de health/briefing calculado uma vez no PipelinePage e repassado aos cards. */
type DealHealthContext = {
  activitiesByDeal: Map<string, ActivityRow[]>;
  followupsByDeal: Map<string, FollowupRow[]>;
  hotContactIds: Set<string>;
  now: Date;
};

/** Deal ganho/perdido não deve continuar sinalizando rotting/atividade/lead quente — só faz sentido em aberto. */
function isDealOpen(deal: Pick<DealRow, "status">): boolean {
  return deal.status !== "won" && deal.status !== "lost";
}

function isDealHot(
  deal: Pick<DealRow, "status" | "contact_id">,
  health: DealHealthContext,
): boolean {
  return isDealOpen(deal) && !!deal.contact_id && health.hotContactIds.has(deal.contact_id);
}

type DealHealthSignals = {
  rotting: boolean;
  activityStatus: ActivityStatus | null;
  isHot: boolean;
};

/**
 * Sinais de saúde de 1 deal a partir do `DealHealthContext` — extraído pra
 * ser reusado tanto pelo card do kanban (`DraggableCard`) quanto pela linha
 * da tabela (`PipelineTable`), sem duplicar o cálculo em dois lugares.
 */
function computeDealHealthSignals(deal: DealRow, health: DealHealthContext): DealHealthSignals {
  const isOpen = isDealOpen(deal);
  const activities = health.activitiesByDeal.get(deal.id) ?? [];
  const rotting = isOpen && isDealRotting(deal.stage_entered_at, health.now);
  const activityInputs: ActivityForHealth[] = activities.map((a) => ({
    dueAt: a.due_at,
    completedAt: a.completed_at,
  }));
  const activityStatus = isOpen
    ? getActivityStatus(getNextActivityDueAt(activityInputs), health.now)
    : null;
  return { rotting, activityStatus, isHot: isDealHot(deal, health) };
}

export interface PipelineSearch {
  /** Deep-link vindo do NextBestActionCard do inbox: seleciona o board do negócio e o destaca. */
  dealId?: string;
  /**
   * Deep-link vindo do botão "Criar negócio" em Contatos (lista e detalhe):
   * abre o dialog de novo negócio já com este contato pré-selecionado.
   */
  contactId?: string;
  /** Nome do contato acima — evita um round-trip extra se ele não estiver nos primeiros 500 contatos do select. */
  contactName?: string;
}

/** Motivo gravado quando o negócio vai para perdido sem motivo informado (mutationFn e update otimista). */
const DEFAULT_LOST_REASON = "Negócio marcado como perdido";

export const Route = createFileRoute("/_app/pipeline")({
  validateSearch: (search: Record<string, unknown>): PipelineSearch => ({
    dealId:
      typeof search.dealId === "string" && search.dealId.length > 0 ? search.dealId : undefined,
    contactId:
      typeof search.contactId === "string" && search.contactId.length > 0
        ? search.contactId
        : undefined,
    contactName:
      typeof search.contactName === "string" && search.contactName.length > 0
        ? search.contactName
        : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Funil de vendas" },
      {
        name: "description",
        content: "Funil de vendas em quadro por etapa, com arrastar e soltar e ações rápidas.",
      },
      { property: "og:title", content: "Funil de vendas" },
      {
        property: "og:description",
        content: "Funil de vendas em quadro por etapa, com arrastar e soltar e ações rápidas.",
      },
      { property: "og:url", content: "https://aceleraflow.lovable.app/pipeline" },
      { name: "twitter:title", content: "Funil de vendas" },
      {
        name: "twitter:description",
        content: "Funil de vendas em quadro por etapa, com arrastar e soltar e ações rápidas.",
      },
    ],
    links: [{ rel: "canonical", href: "https://aceleraflow.lovable.app/pipeline" }],
  }),
  component: PipelinePage,
});

function PipelinePage() {
  const qc = useQueryClient();
  const { data: profile } = useCurrentProfile();
  const { data: tenantProfiles = [] } = useTenantProfiles();

  const boardsQuery = useQuery({
    queryKey: ["boards", profile?.tenant_id],
    enabled: !!profile?.tenant_id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("boards")
        .select("id, name, is_default, position, goal_target, goal_period")
        .order("position");
      if (error) throw error;
      return (data ?? []) as Board[];
    },
  });
  const boards = boardsQuery.data ?? [];

  const {
    dealId: dealIdFromSearch,
    contactId: contactIdFromSearch,
    contactName: contactNameFromSearch,
  } = Route.useSearch();
  const [highlightDealId, setHighlightDealId] = useState<string | null>(null);

  // Resolve o board do negócio quando se chega via deep-link (NextBestActionCard
  // do inbox); tem prioridade sobre localStorage/default no efeito abaixo.
  const dealBoardLookupQuery = useQuery({
    queryKey: ["deal-board-lookup", dealIdFromSearch],
    enabled: !!dealIdFromSearch,
    retry: 1,
    // Deep-link é um extra cosmético (destacar/rolar até o card); uma falha
    // transitória aqui não pode derrubar a página inteira do pipeline via o
    // throwOnError:true global do QueryClient (src/router.tsx) — cai no
    // fallback normal de localStorage/default abaixo.
    throwOnError: false,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deals")
        .select("board_id")
        .eq("id", dealIdFromSearch!)
        .maybeSingle();
      if (error) throw error;
      return data?.board_id ?? null;
    },
  });

  const [boardId, setBoardId] = useState<string | undefined>(undefined);

  const selectBoard = (id: string) => {
    if (profile?.tenant_id) localStorage.setItem(boardStorageKey(profile.tenant_id), id);
    setBoardId(id);
  };

  // Resolve seleção inicial assim que os quadros carregam: deep-link de negócio
  // (se houver) > localStorage (se o quadro ainda existir) > quadro default >
  // primeiro da lista.
  useEffect(() => {
    if (boardId || boards.length === 0) return;
    if (dealIdFromSearch) {
      if (dealBoardLookupQuery.isLoading) return;
      const dealBoardId = dealBoardLookupQuery.data;
      if (dealBoardId && boards.some((b) => b.id === dealBoardId)) {
        selectBoard(dealBoardId);
        setHighlightDealId(dealIdFromSearch);
        return;
      }
      // Negócio não encontrado/sem acesso: cai no fallback normal abaixo.
    }
    const stored = profile?.tenant_id
      ? localStorage.getItem(boardStorageKey(profile.tenant_id))
      : null;
    const fallback =
      boards.find((b) => b.id === stored) ?? boards.find((b) => b.is_default) ?? boards[0];
    if (fallback) selectBoard(fallback.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    boards,
    boardId,
    dealIdFromSearch,
    dealBoardLookupQuery.isLoading,
    dealBoardLookupQuery.data,
  ]);

  const stagesQuery = useQuery({
    queryKey: ["board-stages", boardId],
    enabled: !!boardId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("board_stages")
        .select("id, name, position, is_won, is_lost")
        .eq("board_id", boardId!)
        .order("position");
      if (error) throw error;
      return (data ?? []) as Stage[];
    },
  });

  const dealsQuery = useQuery({
    queryKey: ["deals", boardId],
    enabled: !!boardId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deals")
        .select(
          "id, title, value, stage_id, owner_id, status, lost_reason, contact_id, created_at, stage_entered_at, custom_fields, automation_mode, automation_paused_until, automation_lock_reason, last_ai_transition_at, ai_transition_count_24h, contact:contacts(id, name, tags, source, deleted_at, company_id)",
        )
        .eq("board_id", boardId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      const rows = (data ?? []) as unknown as (Omit<DealRow, "contact"> & {
        contact: (DealRow["contact"] & { deleted_at: string | null }) | null;
      })[];
      // Join to-one: contato fundido/removido não deve reaparecer no card do deal.
      return rows.map((d) => ({
        ...d,
        contact: d.contact?.deleted_at ? null : d.contact,
      })) as DealRow[];
    },
  });

  // Rola até o negócio destacado assim que ele aparecer na lista carregada do
  // board resolvido, e limpa o destaque após alguns segundos.
  useEffect(() => {
    if (!highlightDealId) return;
    if (!dealsQuery.data?.some((d) => d.id === highlightDealId)) return;
    const el = document.querySelector(`[data-deal-id="${highlightDealId}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    const timer = setTimeout(() => setHighlightDealId(null), 2500);
    return () => clearTimeout(timer);
  }, [highlightDealId, dealsQuery.data]);

  const tagsQuery = useQuery({
    queryKey: ["tags", profile?.tenant_id],
    enabled: !!profile?.tenant_id,
    queryFn: async () => {
      const { data, error } = await supabase.from("tags").select("id, name, color").order("name");
      if (error) throw error;
      return (data ?? []) as { id: string; name: string; color: string }[];
    },
  });

  const dealIds = useMemo(() => (dealsQuery.data ?? []).map((d) => d.id), [dealsQuery.data]);
  const automationQuery = usePipelineAutomationState(dealIds);
  usePipelineRealtime({ tenantId: profile?.tenant_id, boardId });
  const automationByDeal = useMemo(() => {
    const result = new Map<string, DealAutomationSnapshot>();
    for (const dealId of dealIds) {
      result.set(dealId, { evaluations: [] });
    }
    for (const evaluation of automationQuery.data?.evaluations ?? []) {
      const current = result.get(evaluation.deal_id) ?? { evaluations: [] };
      current.evaluations.push(evaluation);
      result.set(evaluation.deal_id, current);
    }
    for (const pending of automationQuery.data?.pending ?? []) {
      const current = result.get(pending.deal_id) ?? { evaluations: [] };
      current.pending ??= pending;
      result.set(pending.deal_id, current);
    }
    for (const history of automationQuery.data?.history ?? []) {
      const current = result.get(history.deal_id) ?? { evaluations: [] };
      current.latestHistory ??= history;
      result.set(history.deal_id, current);
    }
    for (const command of automationQuery.data?.commands ?? []) {
      const current = result.get(command.deal_id) ?? { evaluations: [] };
      current.latestCommand ??= command;
      result.set(command.deal_id, current);
    }
    return result;
  }, [automationQuery.data, dealIds]);

  // Kanban health + briefing: activities e follow-ups de todos os deals do
  // board, buscados uma vez e agrupados por deal_id (sem filtro de
  // completed_at/status na query — a classificação é toda client-side em
  // src/lib/deal-health.ts e src/lib/deal-briefing.ts, que precisam tanto de
  // atividades pendentes quanto concluídas).
  const activitiesQuery = useQuery({
    queryKey: ["pipeline-activities", boardId, dealIds],
    enabled: dealIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("activities")
        .select("deal_id, due_at, completed_at")
        .in("deal_id", dealIds);
      if (error) throw error;
      return (data ?? []) as ActivityRow[];
    },
  });

  const followupsQuery = useQuery({
    queryKey: ["pipeline-followups", boardId, dealIds],
    enabled: dealIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deal_followups")
        .select("deal_id, scheduled_at, status")
        .in("deal_id", dealIds);
      if (error) throw error;
      return (data ?? []) as FollowupRow[];
    },
  });

  const contactIds = useMemo(
    () =>
      Array.from(
        new Set(
          (dealsQuery.data ?? []).map((d) => d.contact_id).filter((id): id is string => !!id),
        ),
      ),
    [dealsQuery.data],
  );

  // Tag "Lead quente": mesma fonte (ai_lead_verdicts) usada no painel
  // Oportunidades do inbox (src/lib/api/inbox-risk-opportunities.ts), mas
  // buscada em 1 query batched pelos contact_id visíveis no board — mesmo
  // padrão de `lastByConv` do inbox — em vez de 1 query por card.
  const hotVerdictsQuery = useQuery({
    queryKey: ["pipeline-hot-verdicts", boardId, contactIds],
    enabled: contactIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ai_lead_verdicts")
        .select("contact_id")
        .in("contact_id", contactIds)
        .eq("verdict", "hot");
      if (error) throw error;
      return (data ?? []) as HotVerdictRow[];
    },
  });

  // Empresa por deal: resolvida via contact.company_id, batched pelas
  // empresas visíveis no board (mesmo padrão de hotVerdictsQuery acima) —
  // gated pelo plugin "companies" (nem toda instância tem o módulo ativo),
  // mesmo gate usado em _app.contatos.$id.tsx e ContactFormDialog.tsx.
  const companiesActive = usePluginActive("companies");
  const companyIds = useMemo(
    () =>
      Array.from(
        new Set(
          (dealsQuery.data ?? [])
            .map((d) => d.contact?.company_id)
            .filter((id): id is string => !!id),
        ),
      ),
    [dealsQuery.data],
  );
  const companiesQuery = useQuery({
    queryKey: ["pipeline-companies", boardId, companyIds],
    enabled: companiesActive && companyIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("crm_companies")
        .select("id, name")
        .in("id", companyIds)
        .is("deleted_at", null);
      if (error) throw error;
      return (data ?? []) as { id: string; name: string }[];
    },
  });

  // Definições de campo customizado da entidade "deal" — mesmo padrão de
  // useContactCustomFieldDefinitions (src/hooks/use-lead-forms.ts), só que
  // pra entity="deal" e incluindo field_type/options (precisos pra formatar
  // o valor em src/lib/custom-field-display.ts).
  const dealCustomFieldsQuery = useQuery({
    queryKey: ["custom-field-definitions", "deal", profile?.tenant_id],
    enabled: !!profile?.tenant_id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("custom_field_definitions")
        .select("key, label, field_type, options")
        .eq("entity", "deal")
        .order("position", { ascending: true });
      if (error) throw error;
      return (data ?? []) as {
        key: string;
        label: string;
        field_type: string;
        options: CustomFieldOption[] | null;
      }[];
    },
  });

  const { exportDeals, isExporting } = useDealExport();
  const [viewMode, setViewMode] = useState<"kanban" | "list">("kanban");
  const [ownerFilter, setOwnerFilter] = useState<string>("all");
  const [tagFilter, setTagFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [activeDeal, setActiveDeal] = useState<DealRow | null>(null);
  const [lostFor, setLostFor] = useState<DealRow | null>(null);
  const [lostReason, setLostReason] = useState("");
  const [openNew, setOpenNew] = useState(false);
  /** Assistente de configuração aberto no passo do Nicho pelo estado vazio do funil. */
  const [setupOpen, setSetupOpen] = useState(false);
  const [chatDeal, setChatDeal] = useState<DealRow | null>(null);
  const [prepDeal, setPrepDeal] = useState<DealRow | null>(null);
  const [resultDeal, setResultDeal] = useState<DealRow | null>(null);
  const [proposalDeal, setProposalDeal] = useState<DealRow | null>(null);

  const stages = useMemo(() => stagesQuery.data ?? [], [stagesQuery.data]);
  const deals = useMemo(() => dealsQuery.data ?? [], [dealsQuery.data]);
  // Métrica da barra de progresso da meta do board (ver comentário na migration
  // 20260713130000_pipeline_board_goal.sql): negócios ativos (status='open'),
  // não "ganhos no período" — evita lógica de janela de datas só pra um KPI simples.
  const activeDealsCount = deals.filter((d) => d.status === "open").length;
  const wonStage = stages.find((s) => s.is_won);
  const lostStage = stages.find((s) => s.is_lost);
  const firstStage = stages[0];

  // Deep-link vindo do botão "Criar negócio" em Contatos: assim que o board
  // (e portanto o primeiro estágio) estiver resolvido, abre o dialog de novo
  // negócio já com o contato pré-selecionado. Guardado por contactId para não
  // reabrir sozinho se o usuário fechar o dialog e o efeito rodar de novo.
  const [autoOpenedForContact, setAutoOpenedForContact] = useState<string | null>(null);
  useEffect(() => {
    if (!contactIdFromSearch || !firstStage) return;
    if (autoOpenedForContact === contactIdFromSearch) return;
    setOpenNew(true);
    setAutoOpenedForContact(contactIdFromSearch);
  }, [contactIdFromSearch, firstStage, autoOpenedForContact]);

  const tags = useMemo(() => tagsQuery.data ?? [], [tagsQuery.data]);
  const tagColors = useMemo(() => new Map(tags.map((t) => [t.name, t.color])), [tags]);

  const health: DealHealthContext = useMemo(() => {
    const activitiesByDeal = new Map<string, ActivityRow[]>();
    (activitiesQuery.data ?? []).forEach((a) => {
      if (!a.deal_id) return;
      const list = activitiesByDeal.get(a.deal_id) ?? [];
      list.push(a);
      activitiesByDeal.set(a.deal_id, list);
    });
    const followupsByDeal = new Map<string, FollowupRow[]>();
    (followupsQuery.data ?? []).forEach((f) => {
      if (!f.deal_id) return;
      const list = followupsByDeal.get(f.deal_id) ?? [];
      list.push(f);
      followupsByDeal.set(f.deal_id, list);
    });
    const hotContactIds = new Set((hotVerdictsQuery.data ?? []).map((v) => v.contact_id));
    return { activitiesByDeal, followupsByDeal, hotContactIds, now: new Date() };
  }, [activitiesQuery.data, followupsQuery.data, hotVerdictsQuery.data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return deals.filter((d) => {
      if (ownerFilter !== "all" && d.owner_id !== ownerFilter) return false;
      if (tagFilter !== "all" && !(d.contact?.tags ?? []).includes(tagFilter)) return false;
      if (q) {
        const haystack = `${d.title} ${d.contact?.name ?? ""}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [deals, ownerFilter, tagFilter, search]);

  const hasActiveFilters = ownerFilter !== "all" || tagFilter !== "all" || search.trim() !== "";
  const clearFilters = () => {
    setOwnerFilter("all");
    setTagFilter("all");
    setSearch("");
  };

  // Resumo do funil — agregação de exibição sobre os negócios já carregados
  // (respeita os filtros ativos). Nenhuma query nova.
  const funnelSummary = useMemo(() => {
    const count = filtered.length;
    const total = filtered.reduce((sum, d) => sum + Number(d.value ?? 0), 0);
    return { count, total, average: count > 0 ? total / count : 0 };
  }, [filtered]);

  const byStage = useMemo(() => {
    const map = new Map<string, DealRow[]>();
    stages.forEach((s) => map.set(s.id, []));
    filtered.forEach((d) => map.get(d.stage_id)?.push(d));
    return map;
  }, [stages, filtered]);

  // Visão em tabela (viewMode="list"): nomes resolvidos de dono/empresa e
  // colunas de campo customizado, todos batched (sem N+1 por linha).
  const ownerNameById = useMemo(
    () => new Map(tenantProfiles.map((p) => [p.id, p.name])),
    [tenantProfiles],
  );
  const companyNameById = useMemo(
    () => new Map((companiesQuery.data ?? []).map((c) => [c.id, c.name])),
    [companiesQuery.data],
  );
  const dealCustomFieldDefs: CustomFieldColumn[] = useMemo(
    () =>
      (dealCustomFieldsQuery.data ?? []).map((row) => ({
        key: row.key,
        label: row.label,
        fieldType: row.field_type as CustomFieldType,
        options: row.options ?? [],
      })),
    [dealCustomFieldsQuery.data],
  );
  const tableRows: PipelineTableRow[] = useMemo(
    () =>
      filtered.map((deal) => {
        const { rotting, activityStatus, isHot } = computeDealHealthSignals(deal, health);
        return {
          id: deal.id,
          title: deal.title,
          value: deal.value,
          stageId: deal.stage_id,
          ownerName: deal.owner_id ? (ownerNameById.get(deal.owner_id) ?? null) : null,
          companyName:
            companiesActive && deal.contact?.company_id
              ? (companyNameById.get(deal.contact.company_id) ?? null)
              : null,
          isHot,
          rotting,
          activityStatus,
          customFieldValues: deal.custom_fields ?? {},
        };
      }),
    [filtered, health, ownerNameById, companiesActive, companyNameById],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  type MoveVars = {
    dealId: string;
    fromStageId: string;
    toStageId: string;
    status?: "open" | "won" | "lost";
    lost_reason?: string | null;
  };

  const moveMut = useMutation({
    mutationFn: async ({ dealId, fromStageId, toStageId, status, lost_reason }: MoveVars) => {
      await transitionDealStage({
        dealId,
        expectedStageId: fromStageId,
        targetStageId: toStageId,
        reason:
          status === "lost" ? (lost_reason ?? DEFAULT_LOST_REASON) : "Movimento manual no Kanban",
        evidence: { source: "pipeline.kanban", requested_status: status ?? "open" },
      });
    },
    // Otimista: o card precisa refletir o novo estágio (e, portanto,
    // recalcular "rotting" via stage_entered_at) no instante do drop, sem
    // esperar o round-trip de rede — só o invalidate no onSettled não
    // bastaria (PRD: "recalcula ao mudar de estágio... sem reload de
    // página").
    onMutate: async ({ dealId, toStageId, status, lost_reason }: MoveVars) => {
      await qc.cancelQueries({ queryKey: ["deals", boardId] });
      const previous = qc.getQueryData<DealRow[]>(["deals", boardId]);
      const stageEnteredAt = new Date().toISOString();
      qc.setQueryData<DealRow[]>(["deals", boardId], (old) =>
        (old ?? []).map((d) =>
          d.id === dealId
            ? {
                ...d,
                stage_id: toStageId,
                stage_entered_at: stageEnteredAt,
                status: status ?? "open",
                lost_reason: status === "lost" ? (lost_reason ?? DEFAULT_LOST_REASON) : null,
              }
            : d,
        ),
      );
      return { previous };
    },
    onError: (e: Error, _vars, context) => {
      if (context?.previous) qc.setQueryData(["deals", boardId], context.previous);
      toast.error(e.message ?? "Erro ao mover negócio");
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["deals"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  const handleMoveToStage = (deal: DealRow, toStage: Stage) => {
    if (deal.stage_id === toStage.id) return;
    if (toStage.is_lost) {
      setLostFor(deal);
      setLostReason("");
      return;
    }
    moveMut.mutate({
      dealId: deal.id,
      fromStageId: deal.stage_id,
      toStageId: toStage.id,
      status: toStage.is_won ? "won" : "open",
    });
  };

  // Visão em tabela: mesmo `handleMoveToStage` do kanban (drag/onMove), só
  // resolvido a partir dos ids que o PipelineTable conhece (dealId/stageId).
  const handleTableMove = (dealId: string, stageId: string) => {
    const deal = deals.find((d) => d.id === dealId);
    const stage = stages.find((s) => s.id === stageId);
    if (deal && stage) handleMoveToStage(deal, stage);
  };

  const onDragStart = (e: DragStartEvent) => {
    const d = deals.find((x) => x.id === e.active.id);
    if (d) setActiveDeal(d);
  };
  const onDragEnd = (e: DragEndEvent) => {
    setActiveDeal(null);
    const toId = e.over?.id as string | undefined;
    if (!toId) return;
    const stage = stages.find((s) => s.id === toId);
    const deal = deals.find((d) => d.id === e.active.id);
    if (!stage || !deal) return;
    handleMoveToStage(deal, stage);
  };

  const confirmLost = () => {
    if (lostFor && lostReason.trim() && lostStage) {
      moveMut.mutate({
        dealId: lostFor.id,
        fromStageId: lostFor.stage_id,
        toStageId: lostStage.id,
        status: "lost",
        lost_reason: lostReason.trim(),
      });
      setLostFor(null);
      setLostReason("");
    }
  };

  // Loading / empty states
  const loading =
    boardsQuery.isLoading ||
    (!!boardId && (stagesQuery.isLoading || dealsQuery.isLoading)) ||
    (boards.length > 0 && !boardId);
  const noBoard = !boardsQuery.isLoading && boards.length === 0;
  // Achado 3 — sem funil o BoardSwitcher (único caminho de criação na tela) se
  // esconde sozinho (`boards.length === 0` → null), então o estado vazio virava
  // beco sem saída apontando para um assistente que não abre mais.
  const isAdmin = profile?.role === "admin";

  const handleExport = async () => {
    if (!boardId) return;
    try {
      const { recordsCount } = await exportDeals({
        boardId,
        ownerId: ownerFilter === "all" ? undefined : ownerFilter,
        tagName: tagFilter === "all" ? undefined : tagFilter,
      });
      toast.success(`${recordsCount} negócio(s) exportado(s)`);
    } catch (e) {
      toast.error((e as Error)?.message ?? "Erro ao exportar negócios");
    }
  };

  // Altura limitada à tela: as colunas do kanban rolam por dentro, sem gerar
  // uma segunda barra de rolagem na página.
  return (
    <div className="col-span-12 flex h-[calc(100svh-8rem)] min-h-[520px] flex-col gap-4">
      <PageHeader
        title="Funil"
        description="Funil de vendas por etapa."
        actions={
          <div className="flex items-center gap-2">
            {profile?.role === "admin" && (
              <AutomationSettingsDialog boardId={boardId} stages={stages} />
            )}
            <Button variant="outline" onClick={handleExport} disabled={isExporting || !boardId}>
              {isExporting ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Download className="mr-1 h-4 w-4" />
              )}
              Exportar CSV
            </Button>
            {firstStage && (
              <Button onClick={() => setOpenNew(true)}>
                <Plus className="mr-1 h-4 w-4" /> Novo negócio
              </Button>
            )}
          </div>
        }
      />

      {noBoard ? (
        <>
          <EmptyState
            title="Nenhum funil configurado"
            description={
              isAdmin
                ? "Escolha um modelo de funil para criar as etapas do seu processo de vendas."
                : "Peça a um administrador da sua empresa para configurar o funil."
            }
            actionLabel={isAdmin ? "Configurar funil" : undefined}
            onAction={isAdmin ? () => setSetupOpen(true) : undefined}
          />
          {/* Reaproveita o passo do Nicho do assistente (único caminho que cria
              o board, via useApplyNicheTemplate) em vez de abrir um segundo
              caminho de criação. Montado só quando aberto para o passo inicial
              valer a cada abertura. */}
          {setupOpen && (
            <OnboardingWizard
              open
              onOpenChange={setSetupOpen}
              initialStep={ONBOARDING_STEP_NICHO}
            />
          )}
        </>
      ) : loading ? (
        <div className="flex gap-4 overflow-x-auto pb-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-64 w-72 shrink-0" />
          ))}
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-3">
            {/* Bloco 1 — contexto e busca; bloco 2 — filtros e visão. Antes era
                uma linha só, com todos os controles com o mesmo peso visual. */}
            <div className="flex flex-wrap items-center gap-3">
              <BoardSwitcher
                tenantId={profile?.tenant_id}
                isAdmin={profile?.role === "admin"}
                boards={boards}
                boardsLoading={boardsQuery.isLoading}
                selectedBoardId={boardId}
                onSelect={selectBoard}
                activeDealsCount={activeDealsCount}
              />
              <div className="relative min-w-[220px] flex-1">
                <Search
                  className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  aria-label="Buscar negócios"
                  placeholder="Buscar por negócio ou contato…"
                  className="pl-8"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div
                role="group"
                aria-label="Alternar visualização do funil"
                className="flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-muted/40 p-0.5"
              >
                <Button
                  type="button"
                  variant={viewMode === "kanban" ? "secondary" : "ghost"}
                  size="icon"
                  className="h-8 w-8"
                  aria-label="Visualização em quadro"
                  aria-pressed={viewMode === "kanban"}
                  onClick={() => setViewMode("kanban")}
                >
                  <LayoutGrid className="h-4 w-4" aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant={viewMode === "list" ? "secondary" : "ghost"}
                  size="icon"
                  className="h-8 w-8"
                  aria-label="Visualização em tabela"
                  aria-pressed={viewMode === "list"}
                  onClick={() => setViewMode("list")}
                >
                  <TableIcon className="h-4 w-4" aria-hidden />
                </Button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
              <div className="flex items-center gap-2">
                <Label className="text-caption text-muted-foreground">Responsável</Label>
                <Select value={ownerFilter} onValueChange={setOwnerFilter}>
                  <SelectTrigger className="h-9 w-[200px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos</SelectItem>
                    {profile && <SelectItem value={profile.id}>Meus negócios</SelectItem>}
                    {tenantProfiles
                      .filter((p) => p.id !== profile?.id)
                      .map((u) => (
                        <SelectItem key={u.id} value={u.id}>
                          {u.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              {tags.length > 0 && (
                <div className="flex items-center gap-2">
                  <Label className="text-caption text-muted-foreground">Etiqueta</Label>
                  <Select value={tagFilter} onValueChange={setTagFilter}>
                    <SelectTrigger className="h-9 w-[180px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Todas</SelectItem>
                      {tags.map((t) => (
                        <SelectItem key={t.id} value={t.name}>
                          <span className="flex items-center gap-2">
                            <span
                              className="h-2.5 w-2.5 shrink-0 rounded-full"
                              style={{ backgroundColor: t.color }}
                              aria-hidden
                            />
                            {t.name}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {hasActiveFilters && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-9 text-caption"
                  onClick={clearFilters}
                >
                  <FilterX className="mr-1 h-4 w-4" aria-hidden /> Limpar filtros aplicados
                </Button>
              )}
              <span
                className="ml-auto text-caption tabular-nums text-muted-foreground"
                data-testid="pipeline-result-count"
              >
                {funnelSummary.count} {funnelSummary.count === 1 ? "negócio" : "negócios"}
                {hasActiveFilters && " (filtrados)"}
              </span>
            </div>
          </div>

          {/* Leitura de topo do funil — antes só existiam totais por coluna. */}
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {[
              {
                label: hasActiveFilters ? "Negócios (filtrados)" : "Negócios no funil",
                value: String(funnelSummary.count),
              },
              { label: "Valor total", value: formatBRL(funnelSummary.total) },
              { label: "Ticket médio", value: formatBRL(funnelSummary.average) },
            ].map((kpi) => (
              <div
                key={kpi.label}
                className="rounded-lg border border-border bg-surface px-4 py-3"
                data-testid="pipeline-summary-kpi"
              >
                <dt className="text-caption text-muted-foreground">{kpi.label}</dt>
                <dd className="text-card-title font-semibold tabular-nums text-foreground">
                  {kpi.value}
                </dd>
              </div>
            ))}
          </dl>

          {viewMode === "kanban" ? (
            // Sem resultado COM filtro ativo é outra história de "quadro vazio":
            // repetir "Arraste negócios para cá" em toda coluna é mensagem de
            // primeiro uso. Mesmo texto da visão em tabela (PipelineTable).
            filtered.length === 0 && hasActiveFilters ? (
              <EmptyState
                icon={Search}
                title="Nenhum negócio encontrado com os filtros atuais"
                description="Ajuste a busca, o responsável ou a etiqueta para ver seus negócios."
                actionLabel="Limpar filtros"
                onAction={clearFilters}
              />
            ) : (
              <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
                {/* Máscara lateral: sinaliza que há mais etapas fora do corte. */}
                <div className="relative min-h-0 flex-1">
                  <div
                    className="pointer-events-none absolute inset-y-0 right-0 z-10 w-8 bg-gradient-to-l from-background to-transparent"
                    aria-hidden
                  />
                  <div
                    className="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r from-background to-transparent"
                    aria-hidden
                  />
                  <div className="flex h-full gap-4 overflow-x-auto overscroll-x-contain scroll-smooth pb-2">
                    {stages.map((stage) => (
                      <Column
                        key={stage.id}
                        stage={stage}
                        deals={byStage.get(stage.id) ?? []}
                        stages={stages}
                        tagColors={tagColors}
                        health={health}
                        automationByDeal={automationByDeal}
                        highlightDealId={highlightDealId}
                        isFiltered={hasActiveFilters}
                        boardTotal={funnelSummary.total}
                        onWin={(deal) =>
                          wonStage &&
                          moveMut.mutate({
                            dealId: deal.id,
                            fromStageId: deal.stage_id,
                            toStageId: wonStage.id,
                            status: "won",
                          })
                        }
                        onLose={(d) => {
                          setLostFor(d);
                          setLostReason("");
                        }}
                        onMove={handleMoveToStage}
                        onChat={setChatDeal}
                        onPrepare={setPrepDeal}
                        onResult={setResultDeal}
                        onProposal={setProposalDeal}
                        onCreateInStage={() => setOpenNew(true)}
                      />
                    ))}
                  </div>
                </div>
                <DragOverlay>
                  {activeDeal && (
                    <div className="w-72 shadow-lg">
                      <DealCardBody
                        deal={activeDeal}
                        tagColors={tagColors}
                        isHot={isDealHot(activeDeal, health)}
                      />
                    </div>
                  )}
                </DragOverlay>
              </DndContext>
            )
          ) : (
            <PipelineTable
              stages={stages}
              rows={tableRows}
              customFieldDefs={dealCustomFieldDefs}
              showCompanyColumn={companiesActive}
              highlightDealId={highlightDealId}
              onMoveDeal={handleTableMove}
            />
          )}
        </>
      )}

      <Dialog open={!!lostFor} onOpenChange={(v) => !v && setLostFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Marcar como perdido</DialogTitle>
            <DialogDescription>Informe o motivo para registrar no histórico.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="reason">Motivo *</Label>
            <Textarea
              id="reason"
              rows={3}
              value={lostReason}
              onChange={(e) => setLostReason(e.target.value)}
              aria-invalid={!lostReason.trim()}
            />
            {!lostReason.trim() && (
              <p className="text-caption text-muted-foreground">
                Descreva por que o negócio foi perdido.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setLostFor(null)}>
              Cancelar
            </Button>
            <Button variant="destructive" disabled={!lostReason.trim()} onClick={confirmLost}>
              Marcar perdido
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DealChatDialog
        deal={chatDeal ? { id: chatDeal.id, title: chatDeal.title } : null}
        onOpenChange={(v) => !v && setChatDeal(null)}
      />

      <MeetingPrepSheet
        deal={prepDeal ? { id: prepDeal.id, title: prepDeal.title } : null}
        onOpenChange={(v) => !v && setPrepDeal(null)}
      />

      <MeetingResultSheet
        deal={resultDeal ? { id: resultDeal.id, title: resultDeal.title } : null}
        onOpenChange={(v) => !v && setResultDeal(null)}
      />

      <ProposalSheet
        deal={proposalDeal ? { id: proposalDeal.id, title: proposalDeal.title } : null}
        onOpenChange={(v) => !v && setProposalDeal(null)}
      />

      {firstStage && (
        <NewDealDialog
          open={openNew}
          onOpenChange={setOpenNew}
          firstStageId={firstStage.id}
          boardId={boardId!}
          presetContactId={contactIdFromSearch}
          presetContactName={contactNameFromSearch}
        />
      )}
    </div>
  );
}

function Column({
  stage,
  deals,
  stages,
  tagColors,
  health,
  automationByDeal,
  onWin,
  onLose,
  onMove,
  onChat,
  onPrepare,
  onResult,
  onProposal,
  onCreateInStage,
  highlightDealId,
  isFiltered,
  boardTotal,
}: {
  stage: Stage;
  deals: DealRow[];
  stages: Stage[];
  tagColors: Map<string, string>;
  health: DealHealthContext;
  automationByDeal: Map<string, DealAutomationSnapshot>;
  onWin: (d: DealRow) => void;
  onLose: (d: DealRow) => void;
  onMove: (d: DealRow, to: Stage) => void;
  onChat: (d: DealRow) => void;
  onPrepare: (d: DealRow) => void;
  onResult: (d: DealRow) => void;
  onProposal: (d: DealRow) => void;
  onCreateInStage: () => void;
  highlightDealId: string | null;
  isFiltered: boolean;
  boardTotal: number;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  const total = deals.reduce((s, d) => s + Number(d.value ?? 0), 0);
  const headerTone = stage.is_won
    ? "text-success"
    : stage.is_lost
      ? "text-destructive"
      : "text-foreground";
  const stripeTone = stage.is_won
    ? "bg-success"
    : stage.is_lost
      ? "bg-destructive"
      : "bg-primary/60";
  // Peso da etapa no valor total do funil — só leitura visual.
  const share = boardTotal > 0 ? Math.min(100, (total / boardTotal) * 100) : 0;

  return (
    <div
      className="flex h-full w-72 shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-surface"
      data-testid="pipeline-column"
      data-stage-id={stage.id}
      data-stage-name={stage.name}
    >
      <div className={cn("h-1 w-full shrink-0", stripeTone)} aria-hidden />
      <div className="flex flex-col gap-2 border-b border-border p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col">
            <span className={cn("truncate text-body font-semibold", headerTone)}>{stage.name}</span>
            <span className="text-caption tabular-nums text-muted-foreground">
              {deals.length} {deals.length === 1 ? "negócio" : "negócios"}
              {isFiltered && " (filtrados)"}
            </span>
          </div>
          {/* O total vem de `filtered`, não do quadro inteiro. Com filtro ativo o
              número em destaque seria lido como total autoritativo da etapa — daí
              o rótulo acessível dizer de qual soma se trata. */}
          <span
            className="shrink-0 text-body font-semibold tabular-nums text-primary"
            data-testid="pipeline-column-total"
            aria-label={isFiltered ? "Total filtrado da etapa" : "Total da etapa"}
          >
            {formatBRL(total)}
          </span>
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-muted/50" aria-hidden>
          <div className={cn("h-full transition-all", stripeTone)} style={{ width: `${share}%` }} />
        </div>
      </div>

      <div
        ref={setNodeRef}
        className={cn(
          "flex min-h-[200px] flex-1 flex-col gap-2 overflow-y-auto overscroll-contain p-2 transition-colors",
          isOver && "bg-accent/40 ring-2 ring-primary/40 ring-inset rounded-b-lg",
        )}
      >
        {deals.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border p-6 text-center text-caption text-muted-foreground">
            <LayoutGrid className="h-5 w-5 opacity-60" aria-hidden />
            <span>Arraste negócios para cá</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-caption"
              onClick={onCreateInStage}
            >
              <Plus className="mr-1 h-3.5 w-3.5" aria-hidden /> Adicionar negócio nesta etapa
            </Button>
          </div>
        ) : (
          deals.map((d) => (
            <DraggableCard
              key={d.id}
              deal={d}
              stages={stages}
              tagColors={tagColors}
              health={health}
              automation={automationByDeal.get(d.id) ?? { evaluations: [] }}
              onWin={onWin}
              onLose={onLose}
              onMove={onMove}
              onChat={onChat}
              onPrepare={onPrepare}
              onResult={onResult}
              onProposal={onProposal}
              isHighlighted={d.id === highlightDealId}
            />
          ))
        )}
      </div>
    </div>
  );
}

function DraggableCard({
  deal,
  stages,
  tagColors,
  health,
  automation,
  onWin,
  onLose,
  onMove,
  onChat,
  onPrepare,
  onResult,
  onProposal,
  isHighlighted,
}: {
  deal: DealRow;
  stages: Stage[];
  tagColors: Map<string, string>;
  health: DealHealthContext;
  automation: DealAutomationSnapshot;
  onWin: (d: DealRow) => void;
  onLose: (d: DealRow) => void;
  onMove: (d: DealRow, to: Stage) => void;
  onChat: (d: DealRow) => void;
  onPrepare: (d: DealRow) => void;
  onResult: (d: DealRow) => void;
  onProposal: (d: DealRow) => void;
  isHighlighted: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: deal.id });

  const activities = health.activitiesByDeal.get(deal.id) ?? [];
  const followups = health.followupsByDeal.get(deal.id) ?? [];
  const { rotting, activityStatus, isHot } = computeDealHealthSignals(deal, health);

  const briefing: DealBriefing = buildDealBriefing(
    {
      createdAt: deal.created_at,
      stageEnteredAt: deal.stage_entered_at,
      activities: activities.map((a) => ({ completedAt: a.completed_at })),
      followups: followups.map((f) => ({
        scheduledAt: f.scheduled_at,
        status: f.status as DealFollowupStatus,
      })),
    },
    health.now,
  );

  return (
    <div
      ref={setNodeRef}
      data-deal-id={deal.id}
      className={cn(
        "group relative rounded-md border border-border bg-card p-3 shadow-sm transition-shadow",
        isDragging && "opacity-40",
        isHighlighted && "ring-2 ring-primary shadow-lg",
      )}
      {...attributes}
    >
      <div className="absolute right-1 top-1 z-10 flex items-center gap-0.5">
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label="Ver resumo do negócio"
            >
              <Info className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64">
            <DealBriefingContent briefing={briefing} />
            <Button size="sm" className="mt-3 w-full" onClick={() => onPrepare(deal)}>
              <ClipboardList className="mr-2 h-4 w-4" /> Preparar reunião
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="mt-2 w-full"
              onClick={() => onResult(deal)}
            >
              <FileText className="mr-2 h-4 w-4" /> Resultado da reunião
            </Button>
          </PopoverContent>
        </Popover>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Ações do negócio">
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel>Ações</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => onChat(deal)}>
              <Bot className="mr-2 h-4 w-4 text-primary" /> Falar com IA
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onPrepare(deal)}>
              <ClipboardList className="mr-2 h-4 w-4 text-primary" /> Preparar reunião
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onResult(deal)}>
              <FileText className="mr-2 h-4 w-4 text-primary" /> Resultado da reunião
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onProposal(deal)}>
              <FileSignature className="mr-2 h-4 w-4 text-primary" /> Proposta (simulação)
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Mover para…</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {stages
                  .filter((s) => s.id !== deal.stage_id)
                  .map((s) => (
                    <DropdownMenuItem key={s.id} onClick={() => onMove(deal, s)}>
                      {s.name}
                    </DropdownMenuItem>
                  ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <button
        {...listeners}
        className="block w-full cursor-grab pr-16 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:ring-ring active:cursor-grabbing"
        aria-label={`Arrastar ${deal.title}`}
      >
        <DealCardBody
          deal={deal}
          tagColors={tagColors}
          rotting={rotting}
          activityStatus={activityStatus}
          isHot={isHot}
        />
      </button>
      {/* Uma linha de resumo, não três blocos empilhados: as etiquetas da IA, a
          aprovação e os critérios moraram aqui até virarem parede numa coluna de
          288px — agora vivem dentro do diálogo de detalhes. */}
      <div className="mt-2 space-y-1" onPointerDown={(event) => event.stopPropagation()}>
        <DealAutomationDetails deal={deal} snapshot={automation} stages={stages} />
        {isDealOpen(deal) && (
          <div className="flex gap-1 border-t border-border pt-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 flex-1 px-1.5 text-caption text-success hover:text-success"
              onClick={() => onWin(deal)}
            >
              <Trophy className="mr-1 h-3.5 w-3.5" aria-hidden /> Ganhar
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 flex-1 px-1.5 text-caption text-destructive hover:text-destructive"
              onClick={() => onLose(deal)}
            >
              <XCircle className="mr-1 h-3.5 w-3.5" aria-hidden /> Perder
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function DealBriefingContent({ briefing }: { briefing: DealBriefing }) {
  const dias = (n: number) => `${n} ${n === 1 ? "dia" : "dias"}`;
  return (
    <dl className="space-y-2 text-caption">
      <div className="font-semibold text-foreground">Resumo do negócio</div>
      <div className="flex items-center justify-between gap-2">
        <dt className="text-muted-foreground">Idade do negócio</dt>
        <dd className="font-medium text-foreground">{dias(briefing.idadeDias)}</dd>
      </div>
      <div className="flex items-center justify-between gap-2">
        <dt className="text-muted-foreground">Neste estágio</dt>
        <dd className="font-medium text-foreground">{dias(briefing.diasNoEstagioAtual)}</dd>
      </div>
      <div className="flex items-center justify-between gap-2">
        <dt className="text-muted-foreground">Última interação</dt>
        <dd className="font-medium text-foreground">
          {briefing.ultimaInteracao ? formatDate(briefing.ultimaInteracao) : "Sem registro"}
        </dd>
      </div>
      <div className="flex items-center justify-between gap-2">
        <dt className="text-muted-foreground">Próximo retorno</dt>
        <dd className="font-medium text-foreground">
          {briefing.proximoFollowup ? formatDate(briefing.proximoFollowup) : "Nenhum agendado"}
        </dd>
      </div>
    </dl>
  );
}

function DealCardBody({
  deal,
  tagColors,
  rotting,
  activityStatus,
  isHot,
}: {
  deal: DealRow;
  tagColors: Map<string, string>;
  rotting?: boolean;
  activityStatus?: ActivityStatus | null;
  isHot?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-body font-semibold text-foreground">{deal.title}</div>
      {deal.contact && (
        <div className="text-caption text-muted-foreground">{deal.contact.name}</div>
      )}
      <div className="text-body font-semibold text-primary">
        {formatBRL(Number(deal.value ?? 0))}
      </div>
      {deal.status === "lost" && deal.lost_reason && (
        <div
          className="line-clamp-2 break-words text-caption text-muted-foreground"
          title={deal.lost_reason}
        >
          Motivo da perda: {deal.lost_reason}
        </div>
      )}
      {(rotting || activityStatus || isHot || deal.contact?.source) && (
        <div className="flex flex-wrap gap-1.5">
          {isHot && <StatusBadge variant="success">Lead quente</StatusBadge>}
          {rotting && <StatusBadge variant="destructive">Parado no estágio (+10d)</StatusBadge>}
          {activityStatus && (
            <StatusBadge variant={ACTIVITY_STATUS_VARIANT[activityStatus]}>
              {ACTIVITY_STATUS_LABEL[activityStatus]}
            </StatusBadge>
          )}
          {deal.contact?.source && (
            <StatusBadge variant="outline">{deal.contact.source}</StatusBadge>
          )}
        </div>
      )}
      {(deal.contact?.tags?.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-1">
          {deal.contact!.tags!.map((t) => {
            const color = tagColors.get(t);
            return color ? (
              <span
                key={t}
                className="inline-flex items-center rounded-md border px-2 py-0.5 text-caption font-medium"
                style={{ color, borderColor: `${color}40`, backgroundColor: `${color}1a` }}
              >
                {t}
              </span>
            ) : (
              <StatusBadge key={t} variant="neutral">
                {t}
              </StatusBadge>
            );
          })}
        </div>
      )}
    </div>
  );
}

type NewDealForm = {
  title: string;
  value: string;
  contactId?: string;
  newContactName?: string;
  newContactPhone?: string;
};

function NewDealDialog({
  open,
  onOpenChange,
  firstStageId,
  boardId,
  presetContactId,
  presetContactName,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  firstStageId: string;
  boardId: string;
  /** Vindo do deep-link "Criar negócio" em Contatos — pré-seleciona o contato no modo "existing". */
  presetContactId?: string;
  /** Fallback de exibição caso o contato não esteja nos primeiros 500 do select abaixo. */
  presetContactName?: string;
}) {
  const qc = useQueryClient();
  const { data: profile } = useCurrentProfile();
  const [mode, setMode] = useState<"existing" | "new">("existing");

  const contactsQuery = useQuery({
    queryKey: ["contacts-min"],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("contacts")
        .select("id, name")
        .is("deleted_at", null)
        .order("name")
        .limit(500);
      if (error) throw error;
      return data ?? [];
    },
  });

  // Contato do deep-link pode não estar entre os primeiros 500 do select
  // (ordenado por nome) — garante que ele apareça como opção mesmo assim.
  const contactOptions = useMemo(() => {
    const list = contactsQuery.data ?? [];
    if (presetContactId && !list.some((c) => c.id === presetContactId)) {
      return [{ id: presetContactId, name: presetContactName ?? "Contato selecionado" }, ...list];
    }
    return list;
  }, [contactsQuery.data, presetContactId, presetContactName]);

  const form = useForm<NewDealForm>({
    defaultValues: {
      title: "",
      value: "",
      contactId: presetContactId ?? "",
      newContactName: "",
      newContactPhone: "",
    },
  });

  const mutation = useMutation({
    mutationFn: async (v: NewDealForm) => {
      if (!profile) throw new Error("Sessão inválida");
      let contactId = v.contactId || null;
      if (mode === "new") {
        if (!v.newContactName?.trim()) throw new Error("Informe o nome do contato");
        const { data: c, error: ec } = await supabase
          .from("contacts")
          .insert({
            tenant_id: profile.tenant_id,
            name: v.newContactName.trim(),
            phone: v.newContactPhone?.trim() || null,
          })
          .select("id")
          .single();
        if (ec) throw ec;
        contactId = c.id;
      }
      // Parse pt-BR: "1.234,56" -> 1234.56; "1500" -> 1500; "1,50" -> 1.50.
      // Regra: remove tudo que não for dígito/./, ; se sobrar VÍRGULA, ela é
      // o decimal e todos os pontos são separadores de milhar (removidos);
      // se sobrar SÓ ponto(s), tratamos como separador de milhar quando há
      // grupos de 3 dígitos ("1.500" -> 1500), senão como decimal (US-style
      // "1.5"). Valor VAZIO é opcional e vira 0 (comportamento antigo do
      // form). Só rejeita quando há texto mas não parseia (ex.: "abc").
      const raw = String(v.value ?? "")
        .replace(/[^\d.,]/g, "")
        .trim();
      let numeric = 0;
      if (raw) {
        let normalized: string;
        if (raw.includes(",")) {
          normalized = raw.replace(/\./g, "").replace(",", ".");
        } else if (raw.includes(".")) {
          const parts = raw.split(".");
          const looksLikeThousands =
            parts.length > 1 && parts.slice(1).every((p) => p.length === 3);
          normalized = looksLikeThousands ? parts.join("") : raw;
        } else {
          normalized = raw;
        }
        numeric = Number(normalized);
        if (!Number.isFinite(numeric) || numeric < 0) {
          throw new Error("Valor inválido. Use um formato como 1.500,00");
        }
      }
      const { error } = await supabase.from("deals").insert({
        tenant_id: profile.tenant_id,
        board_id: boardId,
        stage_id: firstStageId,
        contact_id: contactId,
        title: v.title.trim(),
        value: numeric,
        owner_id: profile.id,
        status: "open",
        stage_entered_at: new Date().toISOString(),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["deals"] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      // Página de detalhe do contato (aba Negócios/timeline) — no-op se não
      // houver essa query montada agora, mas evita dado stale ao voltar pra lá.
      qc.invalidateQueries({ queryKey: ["contact-deals"] });
      toast.success("Negócio criado");
      form.reset();
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message ?? "Erro ao criar negócio"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Novo negócio</DialogTitle>
          <DialogDescription>Escolha um contato e informe os dados do negócio.</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit((v) => mutation.mutate(v))} className="space-y-4">
          <RadioGroup
            value={mode}
            onValueChange={(v) => setMode(v as "existing" | "new")}
            className="flex gap-4"
          >
            <label className="flex items-center gap-2 text-body cursor-pointer">
              <RadioGroupItem value="existing" /> Contato existente
            </label>
            <label className="flex items-center gap-2 text-body cursor-pointer">
              <RadioGroupItem value="new" /> Criar contato novo
            </label>
          </RadioGroup>

          {mode === "existing" ? (
            <div className="space-y-1.5">
              <Label>Contato *</Label>
              <Select
                value={form.watch("contactId")}
                onValueChange={(v) => form.setValue("contactId", v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Selecionar contato" />
                </SelectTrigger>
                <SelectContent>
                  {contactOptions.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Nome *</Label>
                <Input {...form.register("newContactName")} />
              </div>
              <div className="space-y-1.5">
                <Label>Telefone</Label>
                <Input {...form.register("newContactPhone")} />
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Título do negócio *</Label>
            <Input {...form.register("title", { required: true })} placeholder="Ex.: Plano anual" />
          </div>
          <div className="space-y-1.5">
            <Label>Valor (R$)</Label>
            <Input {...form.register("value")} placeholder="0,00" inputMode="decimal" />
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button
              type="submit"
              disabled={
                mutation.isPending ||
                !form.watch("title")?.trim() ||
                (mode === "existing"
                  ? !form.watch("contactId")
                  : !form.watch("newContactName")?.trim())
              }
            >
              {mutation.isPending ? "Criando…" : "Criar negócio"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
