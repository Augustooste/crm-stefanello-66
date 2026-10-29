import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { screen, waitFor, within, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { renderWithQueryClient } from "@/test/render";
import { ok, fail, type QueryResult } from "@/test/supabase-mock";
import { useCurrentProfile } from "@/lib/api/session";
import { useIntegration } from "@/lib/api/integrations";
import { useColdDeals, useHotLeadsWithoutFollowup } from "@/lib/api/inbox-risk-opportunities";
import { useCreateFollowup, usePendingFollowupContactIds } from "@/hooks/use-followup-queue";
import { Route } from "./_app.inbox";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { routerOverrides } = await import("@/test/router-mocks");
  return { ...actual, ...routerOverrides() };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(),
    channel: vi.fn(() => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn().mockReturnThis() })),
    removeChannel: vi.fn(),
    functions: { invoke: vi.fn() },
    storage: {
      from: vi.fn(() => ({
        createSignedUrl: vi.fn(),
      })),
    },
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/api/session", () => ({
  useCurrentProfile: vi.fn(),
}));

vi.mock("@/lib/api/integrations", () => ({
  useIntegration: vi.fn(),
  useTenantChannels: () => ({ data: [], isLoading: false }),
}));

// Persona real (useAiPersona) dispara .from("ai_settings")/.from("tenants")
// extras a cada bolha — mockar mantém as bolhas determinísticas e isola o
// teste da resolução assíncrona da persona.
vi.mock("@/components/ai/ai-persona-badge", () => ({
  AiPersonaBadge: () => <span>IA</span>,
}));

vi.mock("@/lib/api/inbox-risk-opportunities", () => ({
  useColdDeals: vi.fn(),
  useHotLeadsWithoutFollowup: vi.fn(),
}));

// A dedup por follow-up pendente (`usePendingFollowupContactIds`) e a
// mutation de "Aplicar" (`useCreateFollowup`) já são cobertas isoladamente em
// `src/lib/api/inbox-risk-opportunities.test.tsx`/`use-followup-queue.test.tsx`
// — aqui mockamos as duas pra controlar exatamente o que a Visão Geral
// recebe, sem depender do supabase mock local (`buildFrom`) pra "deal_followups".
vi.mock("@/hooks/use-followup-queue", () => ({
  useCreateFollowup: vi.fn(),
  usePendingFollowupContactIds: vi.fn(),
}));

const InboxPage = Route.options.component!;

// ---- Fixtures --------------------------------------------------------

interface ContactFixture {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  tags: string[] | null;
}

interface ChannelFixture {
  id: string;
  type: "whatsapp" | "email";
  provider_slug: string | null;
}

interface ConversationFixture {
  id: string;
  tenant_id: string;
  contact_id: string;
  channel_id: string;
  ai_active: boolean;
  awaiting_human: boolean;
  awaiting_human_since?: string | null;
  status: string;
  unread_count: number | null;
  last_message_at: string | null;
  created_at: string;
  contact: ContactFixture | null;
  channel: ChannelFixture | null;
  last_error?: {
    code: string;
    message: string;
    retryAfterSeconds?: number;
  } | null;
}

interface MessageFixture {
  id: string;
  conversation_id: string;
  tenant_id: string;
  sender: "contact" | "agent" | "ai";
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

const CONV_ANA: ConversationFixture = {
  id: "c1",
  tenant_id: "t1",
  contact_id: "ct1",
  channel_id: "ch1",
  ai_active: true,
  awaiting_human: false,
  status: "open",
  unread_count: 2,
  last_message_at: "2026-07-01T10:00:00.000Z",
  created_at: "2026-07-01T09:00:00.000Z",
  contact: { id: "ct1", name: "Ana Souza", phone: "11999990000", email: null, tags: ["Quente"] },
  channel: { id: "ch1", type: "whatsapp", provider_slug: "zapi" },
};

const CONV_BRUNO: ConversationFixture = {
  id: "c2",
  tenant_id: "t1",
  contact_id: "ct2",
  channel_id: "ch2",
  ai_active: false,
  awaiting_human: true,
  status: "open",
  unread_count: 3,
  last_message_at: "2026-07-01T11:00:00.000Z",
  created_at: "2026-07-01T08:00:00.000Z",
  contact: { id: "ct2", name: "Bruno Lima", phone: null, email: "bruno@exemplo.com", tags: [] },
  channel: { id: "ch2", type: "email", provider_slug: "resend" },
};

const LAST_MESSAGES = [
  {
    conversation_id: "c1",
    content: "Oi, tudo bem?",
    sender: "contact",
    created_at: "2026-07-01T10:00:00.000Z",
    status: "sent",
  },
  {
    conversation_id: "c2",
    content: "Preciso de ajuda",
    sender: "ai",
    created_at: "2026-07-01T11:00:00.000Z",
    status: "sent",
  },
];

const THREAD_ANA: MessageFixture[] = [
  {
    id: "m1",
    conversation_id: "c1",
    tenant_id: "t1",
    sender: "contact",
    direction: "in",
    content: "Oi, tudo bem?",
    media_url: null,
    media_type: null,
    created_at: "2026-07-01T09:30:00.000Z",
    status: "sent",
  },
  {
    id: "m2",
    conversation_id: "c1",
    tenant_id: "t1",
    sender: "agent",
    direction: "out",
    content: "Olá! Como posso ajudar?",
    media_url: null,
    media_type: null,
    created_at: "2026-07-01T09:31:00.000Z",
    status: "sent",
  },
  {
    id: "m3",
    conversation_id: "c1",
    tenant_id: "t1",
    sender: "ai",
    direction: "out",
    content: "Resposta automática da IA",
    media_url: null,
    media_type: null,
    created_at: "2026-07-01T09:32:00.000Z",
    status: "sent",
  },
  {
    id: "m4",
    conversation_id: "c1",
    tenant_id: "t1",
    sender: "ai",
    direction: "out",
    content: "Sugestão da IA",
    media_url: null,
    media_type: null,
    created_at: "2026-07-01T09:33:00.000Z",
    status: "draft",
  },
  {
    id: "m5",
    conversation_id: "c1",
    tenant_id: "t1",
    sender: "agent",
    direction: "out",
    content: "Mensagem que falhou",
    media_url: null,
    media_type: null,
    created_at: "2026-07-01T09:34:00.000Z",
    status: "failed",
    send_error: "Número inválido",
  },
];

// ---- Mock helpers ------------------------------------------------------

type Call = { method: string; args: unknown[] };

const CHAIN_METHODS = [
  "select",
  "insert",
  "update",
  "upsert",
  "delete",
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "ilike",
  "is",
  "in",
  "contains",
  "containedBy",
  "order",
  "limit",
  "range",
  "filter",
  "match",
  "or",
  "not",
] as const;

const PENDING = Symbol("pending");

/**
 * Builder local para o inbox: o helper compartilhado (`createFromByTable`)
 * não diferencia as DUAS queries feitas na tabela "messages" (última
 * mensagem em lote via `.in()` vs. thread completa via `.eq()`), nem
 * insert/delete. Por isso este builder inspeciona os métodos encadeados
 * (`calls`) para decidir qual resultado devolver.
 */
function makeBuilder<T>(
  resolve: (calls: Call[]) => QueryResult<T> | typeof PENDING,
): Record<string, unknown> {
  const calls: Call[] = [];
  const builder: Record<string, unknown> = {};
  for (const method of CHAIN_METHODS) {
    builder[method] = vi.fn((...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    });
  }
  const resolved = () => {
    const r = resolve(calls);
    return r === PENDING ? new Promise<QueryResult<T>>(() => {}) : Promise.resolve(r);
  };
  builder.single = vi.fn(() => resolved());
  builder.maybeSingle = vi.fn(() => resolved());
  builder.then = (
    onFulfilled?: ((value: QueryResult<T>) => unknown) | null,
    onRejected?: ((reason: unknown) => unknown) | null,
  ) => resolved().then(onFulfilled ?? undefined, onRejected ?? undefined);
  builder.catch = (onRejected?: ((reason: unknown) => unknown) | null) =>
    resolved().catch(onRejected ?? undefined);
  return builder;
}

interface FromOptions {
  /** Quantas conversas abertas o período atual esconde (default 0). */
  hiddenByPeriodCount?: number;
  conversations: QueryResult<unknown> | (() => QueryResult<unknown>);
  /** Forma de função quando o refetch (pós-invalidação) precisa devolver outro resultado. */
  lastMessages?: QueryResult<unknown> | (() => QueryResult<unknown>);
  threadMessages?: QueryResult<unknown> | (() => QueryResult<unknown>);
  draftUpdate?: (calls: Call[]) => QueryResult<unknown>;
  threadPending?: boolean;
  tags?: QueryResult<unknown>;
  nextBestActionDraft?: QueryResult<unknown>;
  conversationUpdateResult?: QueryResult<unknown>;
  conversationDeleteResult?: QueryResult<unknown>;
  insertResult?: (row: Record<string, unknown>) => QueryResult<unknown>;
  onConversationUpdate?: (id: string | undefined, patch: Record<string, unknown>) => void;
  onConversationDelete?: (id: string | undefined) => void;
  /** Resultado da busca pontual por id (`?conversationId` fora do array capado). */
  conversationById?: (id: string) => QueryResult<unknown>;
  /** Espiona os métodos encadeados da query PRINCIPAL de listagem de conversas. */
  onConversationsListCalls?: (calls: Call[]) => void;
  /** Espiona os métodos encadeados da query de últimas mensagens (batch `.in()`). */
  onLastMessagesCalls?: (calls: Call[]) => void;
}

function buildFrom(opts: FromOptions): Mock {
  return vi.fn((table: string) => {
    if (table === "conversations") {
      return makeBuilder((calls) => {
        const updateCall = calls.find((c) => c.method === "update");
        // Exclusão de conversa é soft-delete: UPDATE { deleted_at } encadeando
        // `.select("id")` — distinta dos updates de unread_count/ai_active/
        // awaiting_human (que nunca tocam em `deleted_at`). O default devolve a
        // linha marcada, para o caminho de sucesso enxergar linhas afetadas.
        if (
          updateCall &&
          (updateCall.args[0] as Record<string, unknown> | undefined)?.deleted_at !== undefined
        ) {
          const eqCall = calls.find((c) => c.method === "eq");
          opts.onConversationDelete?.(eqCall?.args[1] as string | undefined);
          return opts.conversationDeleteResult ?? ok([{ id: eqCall?.args[1] }]);
        }
        if (updateCall) {
          const eqCall = calls.find((c) => c.method === "eq");
          opts.onConversationUpdate?.(
            eqCall?.args[1] as string | undefined,
            updateCall.args[0] as Record<string, unknown>,
          );
          return opts.conversationUpdateResult ?? ok(null);
        }
        // Busca pontual por id (`searchedConversationQuery`): `.eq("id", x)` +
        // `.maybeSingle()`, sem `.order()`/`.limit()` — distinta da listagem
        // principal, que nunca filtra por "id".
        const eqIdCall = calls.find((c) => c.method === "eq" && c.args[0] === "id");
        if (eqIdCall) {
          const id = eqIdCall.args[1] as string;
          return opts.conversationById ? opts.conversationById(id) : ok(null);
        }
        // Contagem de conversas ocultas pelo período (`hiddenByPeriodQuery`):
        // head count com `.lt("last_message_at", ...)`, que a listagem não usa.
        if (calls.some((c) => c.method === "lt")) {
          return ok(null, { count: opts.hiddenByPeriodCount ?? 0 });
        }
        opts.onConversationsListCalls?.(calls);
        return typeof opts.conversations === "function" ? opts.conversations() : opts.conversations;
      });
    }
    if (table === "messages") {
      return makeBuilder((calls) => {
        if (calls.some((c) => c.method === "delete")) return ok(null);
        if (calls.some((c) => c.method === "update")) {
          return opts.draftUpdate?.(calls) ?? ok({ id: "m4" });
        }
        const insertCall = calls.find((c) => c.method === "insert");
        if (insertCall) {
          const row = insertCall.args[0] as Record<string, unknown>;
          return opts.insertResult ? opts.insertResult(row) : ok({ id: "local-1", ...row });
        }
        if (calls.some((c) => c.method === "in")) {
          opts.onLastMessagesCalls?.(calls);
          if (typeof opts.lastMessages === "function") return opts.lastMessages();
          return opts.lastMessages ?? ok([]);
        }
        // NextBestActionCard filtra por status="draft" — sem isto, cairia no
        // fallback do thread completo (array) e o `.maybeSingle()` receberia
        // dado com formato errado (thread inteiro em vez de 1 rascunho).
        if (calls.some((c) => c.method === "eq" && c.args[0] === "status" && c.args[1] === "draft"))
          return opts.nextBestActionDraft ?? ok(null);
        if (opts.threadPending) return PENDING;
        return typeof opts.threadMessages === "function"
          ? opts.threadMessages()
          : (opts.threadMessages ?? ok([]));
      });
    }
    if (table === "tags") {
      return makeBuilder(() => opts.tags ?? ok([]));
    }
    return makeBuilder(() => ok(null));
  });
}

function mockProfile(overrides: Partial<{ isLoading: boolean; tenantId: string | null }> = {}) {
  const { isLoading = false, tenantId = "t1" } = overrides;
  vi.mocked(useCurrentProfile).mockReturnValue({
    data: tenantId ? { id: "p1", tenant_id: tenantId, name: "Agente", role: "agent" } : null,
    isLoading,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

function mockIntegrations(active: { zapi?: boolean; twilio?: boolean; resend?: boolean } = {}) {
  vi.mocked(useIntegration).mockImplementation((slug: string) => ({
    isLoading: false,
    status: active[slug as keyof typeof active] ? "active" : "disabled",
    isActive: !!active[slug as keyof typeof active],
    config: null,
  }));
}

/**
 * Mocka os hooks de Risco/Oportunidades (Épico B) com default vazio — a
 * lógica interna de cada hook (dedup, `isDealRotting`) já é coberta em
 * `src/lib/api/inbox-risk-opportunities.test.tsx`; aqui só precisamos
 * controlar o que a Visão Geral renderiza.
 */
function mockRiskOpportunities(
  overrides: {
    coldDeals?: {
      id: string;
      title: string;
      contact_id?: string | null;
      contact: { id: string; name: string } | null;
    }[];
    hotLeads?: {
      contact_id: string;
      rationale: string | null;
      contact: { id: string; name: string } | null;
    }[];
  } = {},
) {
  vi.mocked(useColdDeals).mockReturnValue({
    coldDeals: overrides.coldDeals ?? [],
    isLoading: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  vi.mocked(useHotLeadsWithoutFollowup).mockReturnValue({
    hotLeads: overrides.hotLeads ?? [],
    isLoading: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
function isoHoursAgo(h: number): string {
  return new Date(Date.now() - h * HOUR_MS).toISOString();
}
function isoDaysAgo(d: number): string {
  return new Date(Date.now() - d * DAY_MS).toISOString();
}

const CONV_AWAITING: ConversationFixture = {
  id: "c-await",
  tenant_id: "t1",
  contact_id: "ct-await",
  channel_id: "ch1",
  ai_active: false,
  awaiting_human: true,
  awaiting_human_since: isoHoursAgo(5),
  status: "open",
  unread_count: 0,
  last_message_at: isoHoursAgo(1),
  created_at: isoDaysAgo(2),
  contact: { id: "ct-await", name: "Carla Aguardando", phone: null, email: null, tags: [] },
  channel: { id: "ch1", type: "whatsapp", provider_slug: "zapi" },
};

const CONV_OVERDUE_ONLY: ConversationFixture = {
  id: "c-overdue",
  tenant_id: "t1",
  contact_id: "ct-overdue",
  channel_id: "ch1",
  ai_active: true,
  awaiting_human: false,
  awaiting_human_since: null,
  status: "open",
  unread_count: 0,
  last_message_at: isoHoursAgo(30),
  created_at: isoDaysAgo(3),
  contact: { id: "ct-overdue", name: "Diego Atrasado", phone: null, email: null, tags: [] },
  channel: { id: "ch1", type: "whatsapp", provider_slug: "zapi" },
};

const CONV_COLD_NO_FOLLOWUP: ConversationFixture = {
  id: "c-cold-1",
  tenant_id: "t1",
  contact_id: "ct-cold-1",
  channel_id: "ch1",
  ai_active: true,
  awaiting_human: false,
  status: "open",
  unread_count: 0,
  last_message_at: isoDaysAgo(10),
  created_at: isoDaysAgo(20),
  contact: { id: "ct-cold-1", name: "Carla Fria", phone: null, email: null, tags: [] },
  channel: { id: "ch1", type: "whatsapp", provider_slug: "zapi" },
};

const CONV_COLD_WITH_FOLLOWUP: ConversationFixture = {
  id: "c-cold-2",
  tenant_id: "t1",
  contact_id: "ct-cold-2",
  channel_id: "ch1",
  ai_active: true,
  awaiting_human: false,
  status: "open",
  unread_count: 0,
  last_message_at: isoDaysAgo(12),
  created_at: isoDaysAgo(25),
  contact: { id: "ct-cold-2", name: "Diego Frio", phone: null, email: null, tags: [] },
  channel: { id: "ch1", type: "whatsapp", provider_slug: "zapi" },
};

const FOCUS_LAST_MESSAGES = [
  {
    conversation_id: "c-await",
    content: "Preciso de ajuda urgente",
    sender: "contact",
    created_at: isoHoursAgo(1),
  },
  {
    conversation_id: "c-overdue",
    content: "Ainda aguardando retorno",
    sender: "contact",
    created_at: isoHoursAgo(30),
  },
];

// ---- Tests --------------------------------------------------------------

// Route.useSearch() usa useMatch internamente (precisa de RouterProvider real).
// Como este arquivo renderiza <InboxPage /> isolado (sem router), mockamos
// diretamente igual ao padrão já usado para Route.useParams em outras rotas.
beforeEach(() => {
  // Default "lista" — os testes de comportamento pré-existentes (busca,
  // filtros, envio, thread) exercitam a coluna dupla da Lista, que só
  // renderiza com mode==="lista". Testes do Épico B sobrescrevem quando
  // precisam de "geral"/"foco".
  vi.spyOn(Route, "useSearch").mockReturnValue({ mode: "lista" });
  mockRiskOpportunities();
  // Default: nenhum contato com follow-up pendente e mutation "burra" (sem
  // callbacks) — testes de dedup/concorrência sobrescrevem por caso.
  vi.mocked(usePendingFollowupContactIds).mockReturnValue(new Set());
  vi.mocked(useCreateFollowup).mockReturnValue({
    mutate: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
});

describe("página de inbox (/_app/inbox)", () => {
  it("mostra esqueleto de carregamento enquanto o perfil ainda carrega", () => {
    mockProfile({ isLoading: true });
    mockIntegrations();
    vi.mocked(supabase.from).mockImplementation(buildFrom({ conversations: ok([]) }));

    renderWithQueryClient(<InboxPage />);

    expect(screen.getByText("Carregando...")).toBeInTheDocument();
  });

  it("mostra estado de erro ao falhar o carregamento das conversas", async () => {
    mockProfile();
    mockIntegrations();
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({ conversations: fail("timeout ao buscar conversas") }),
    );

    renderWithQueryClient(<InboxPage />);

    expect(await screen.findByText("Erro ao carregar")).toBeInTheDocument();
    expect(
      screen.getByText("Não foi possível carregar as conversas. Tente novamente."),
    ).toBeInTheDocument();
  });

  it("mostra estado vazio quando não há conversas", async () => {
    mockProfile();
    mockIntegrations();
    vi.mocked(supabase.from).mockImplementation(buildFrom({ conversations: ok([]) }));

    renderWithQueryClient(<InboxPage />);

    expect(await screen.findByText("Sem conversas")).toBeInTheDocument();
    expect(screen.getByText("Selecione uma conversa")).toBeInTheDocument();
  });

  it("lista conversas com contato, canal, não lidos e status da IA", async () => {
    mockProfile();
    mockIntegrations();
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([CONV_ANA, CONV_BRUNO]),
        lastMessages: ok(LAST_MESSAGES),
        threadMessages: ok(THREAD_ANA),
        tags: ok([{ name: "Quente", color: "#ff0000" }]),
      }),
    );

    const { container } = renderWithQueryClient(<InboxPage />);

    expect((await screen.findAllByText("Ana Souza")).length).toBeGreaterThan(0);
    expect(screen.getByText("Bruno Lima")).toBeInTheDocument();
    // Ana é auto-selecionada ao carregar e marcada como lida (unread_count
    // zerado otimisticamente); só Bruno mantém o badge de não lidas.
    expect(container.querySelector('[aria-label="3 mensagens não lidas"]')).toHaveTextContent("3");
    expect(screen.getAllByText("IA ativa")).not.toHaveLength(0);
    expect(screen.getAllByText("IA pausada")).not.toHaveLength(0);
    expect(screen.getByText("Aguardando humano")).toBeInTheDocument();
  });

  // Modo rascunho: a IA grava a resposta com status "draft" e marca a conversa
  // como awaiting_human. Na lista isso aparecia como o genérico "Aguardando
  // humano" ao lado da mensagem do CLIENTE (o rascunho não vira prévia) — daí
  // o "a IA não respondeu". A linha precisa dizer que falta só enviar.
  it("avisa na lista quando a IA escreveu e o envio depende de um humano", async () => {
    mockProfile();
    mockIntegrations();
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([CONV_ANA, { ...CONV_BRUNO, ai_active: true }]),
        lastMessages: ok([
          ...LAST_MESSAGES,
          {
            conversation_id: "c2",
            content: "Claro, consigo sim. Qual seria o melhor horário?",
            sender: "ai",
            created_at: "2026-07-01T11:05:00.000Z",
            status: "draft",
          },
        ]),
        threadMessages: ok(THREAD_ANA),
      }),
    );

    renderWithQueryClient(<InboxPage />);

    expect(await screen.findByText("A IA escreveu — falta você enviar")).toBeInTheDocument();
    // Some o rótulo genérico: Ana (selecionada) não aguarda humano e a linha do
    // Bruno passou a usar o aviso específico.
    expect(screen.queryByText("Aguardando humano")).not.toBeInTheDocument();
    // O rascunho não vaza para a prévia da lista — o lead nunca o recebeu.
    // A prévia concatena o prefixo do remetente ("IA: "), daí o matcher parcial.
    expect(screen.getByText(/Preciso de ajuda/)).toBeInTheDocument();
    expect(screen.queryByText(/melhor horário/)).not.toBeInTheDocument();
  });

  it("preseleciona a conversa vinda de ?conversationId (busca global Cmd+K)", async () => {
    mockProfile();
    mockIntegrations();
    vi.spyOn(Route, "useSearch").mockReturnValue({ mode: "lista", conversationId: "c2" });
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([CONV_ANA, CONV_BRUNO]),
        lastMessages: ok(LAST_MESSAGES),
        threadMessages: ok(THREAD_ANA),
      }),
    );

    renderWithQueryClient(<InboxPage />);

    // Sem conversationId o auto-select cairia em Ana (primeiro item); com o
    // parâmetro presente, Bruno (c2) deve ganhar prioridade.
    expect(await screen.findByRole("heading", { name: "Bruno Lima" })).toBeInTheDocument();
  });

  it("conversationId que não existe em lugar nenhum (nem na lista, nem via busca pontual) não seleciona conversa alguma", async () => {
    mockProfile();
    mockIntegrations();
    vi.spyOn(Route, "useSearch").mockReturnValue({ mode: "lista", conversationId: "inexistente" });
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([CONV_ANA, CONV_BRUNO]),
        lastMessages: ok(LAST_MESSAGES),
        threadMessages: ok(THREAD_ANA),
        // Id inválido/deletado: a busca pontual não encontra nada.
        conversationById: () => ok(null),
      }),
    );

    renderWithQueryClient(<InboxPage />);

    await screen.findAllByText("Ana Souza"); // lista carregou
    // Regressão do fix HIGH #2: antes caía silenciosamente em `filtered[0]`
    // (Ana) — agora, sem a conversa buscada, não abre NENHUMA outra conversa.
    expect(await screen.findByText("Selecione uma conversa")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Ana Souza" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Bruno Lima" })).not.toBeInTheDocument();
  });

  it("conversationId fora do teto de 500 (não presente no array carregado) busca a conversa à parte e abre ela mesmo assim", async () => {
    mockProfile();
    mockIntegrations();
    vi.spyOn(Route, "useSearch").mockReturnValue({ mode: "lista", conversationId: "c-old" });
    const CONV_OLD_RAW = {
      id: "c-old",
      tenant_id: "t1",
      contact_id: "ct-old",
      channel_id: "ch1",
      ai_active: true,
      awaiting_human: false,
      awaiting_human_since: null,
      status: "open",
      last_error: null,
      unread_count: 0,
      last_message_at: "2020-01-01T00:00:00.000Z",
      created_at: "2020-01-01T00:00:00.000Z",
      contact: {
        id: "ct-old",
        name: "Elisa Antiga",
        phone: null,
        email: null,
        tags: [],
        deleted_at: null,
      },
      channel: { id: "ch1", type: "whatsapp", provider_slug: "zapi" },
    };
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        // Array "capado" carregado normalmente NÃO inclui c-old — simula ela
        // ter ficado de fora do top-500 (conversa antiga demais).
        conversations: ok([CONV_ANA, CONV_BRUNO]),
        lastMessages: ok(LAST_MESSAGES),
        threadMessages: ok([]),
        conversationById: (id) => (id === "c-old" ? ok(CONV_OLD_RAW) : ok(null)),
      }),
    );

    renderWithQueryClient(<InboxPage />);

    expect(await screen.findByRole("heading", { name: "Elisa Antiga" })).toBeInTheDocument();
  });

  it("filtra conversas pela busca de texto", async () => {
    mockProfile();
    mockIntegrations();
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([CONV_ANA, CONV_BRUNO]),
        lastMessages: ok(LAST_MESSAGES),
        threadMessages: ok(THREAD_ANA),
      }),
    );
    const user = userEvent.setup();
    renderWithQueryClient(<InboxPage />);

    await screen.findAllByText("Ana Souza");
    await user.type(screen.getByLabelText("Buscar conversa"), "bruno");

    const list = screen.getByRole("listbox", { name: "Lista de conversas" });
    expect(within(list).queryByText("Ana Souza")).not.toBeInTheDocument();
    expect(within(list).getByText("Bruno Lima")).toBeInTheDocument();
  });

  it("filtra conversas por canal via seletor", async () => {
    mockProfile();
    mockIntegrations();
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([CONV_ANA, CONV_BRUNO]),
        lastMessages: ok(LAST_MESSAGES),
        threadMessages: ok(THREAD_ANA),
      }),
    );
    const user = userEvent.setup();
    renderWithQueryClient(<InboxPage />);

    await screen.findAllByText("Ana Souza");
    await user.click(screen.getByRole("combobox", { name: "Filtrar por canal" }));
    await user.click(await screen.findByRole("option", { name: "E-mail" }));

    const list = screen.getByRole("listbox", { name: "Lista de conversas" });
    expect(within(list).queryByText("Ana Souza")).not.toBeInTheDocument();
    expect(within(list).getByText("Bruno Lima")).toBeInTheDocument();
  });

  it("filtra conversas por status da IA via seletor", async () => {
    mockProfile();
    mockIntegrations();
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([CONV_ANA, CONV_BRUNO]),
        lastMessages: ok(LAST_MESSAGES),
        threadMessages: ok(THREAD_ANA),
      }),
    );
    const user = userEvent.setup();
    renderWithQueryClient(<InboxPage />);

    await screen.findAllByText("Ana Souza");
    await user.click(screen.getByRole("combobox", { name: "Filtrar por situação da IA" }));
    await user.click(await screen.findByRole("option", { name: "IA pausada" }));

    const list = screen.getByRole("listbox", { name: "Lista de conversas" });
    expect(within(list).queryByText("Ana Souza")).not.toBeInTheDocument();
    expect(within(list).getByText("Bruno Lima")).toBeInTheDocument();
  });

  it("seleciona conversa ao clicar e marca como lida", async () => {
    mockProfile();
    mockIntegrations();
    const onConversationUpdate = vi.fn();
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([CONV_ANA, CONV_BRUNO]),
        lastMessages: ok(LAST_MESSAGES),
        threadMessages: ok(THREAD_ANA),
        onConversationUpdate,
      }),
    );
    const user = userEvent.setup();
    renderWithQueryClient(<InboxPage />);

    await screen.findAllByText("Ana Souza");
    // Auto-seleção inicial de Ana já deve ter marcado c1 como lida.
    await waitFor(() =>
      expect(onConversationUpdate).toHaveBeenCalledWith("c1", { unread_count: 0 }),
    );

    onConversationUpdate.mockClear();
    await user.click(screen.getByText("Bruno Lima"));

    expect(await screen.findByRole("heading", { name: "Bruno Lima" })).toBeInTheDocument();
    await waitFor(() =>
      expect(onConversationUpdate).toHaveBeenCalledWith("c2", { unread_count: 0 }),
    );
  });

  it("navega pela lista de conversas com o teclado", async () => {
    mockProfile();
    mockIntegrations();
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([CONV_ANA, CONV_BRUNO]),
        lastMessages: ok(LAST_MESSAGES),
        threadMessages: ok(THREAD_ANA),
      }),
    );
    renderWithQueryClient(<InboxPage />);

    await screen.findAllByText("Ana Souza");
    const list = screen.getByRole("listbox", { name: "Lista de conversas" });

    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(await screen.findByRole("heading", { name: "Bruno Lima" })).toBeInTheDocument();

    fireEvent.keyDown(list, { key: "Home" });
    expect(await screen.findByRole("heading", { name: "Ana Souza" })).toBeInTheDocument();

    fireEvent.keyDown(list, { key: "End" });
    expect(await screen.findByRole("heading", { name: "Bruno Lima" })).toBeInTheDocument();
  });

  it("mostra esqueleto de mensagens enquanto a thread carrega", async () => {
    mockProfile();
    mockIntegrations();
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([CONV_ANA]),
        lastMessages: ok(LAST_MESSAGES),
        threadPending: true,
      }),
    );

    const { container } = renderWithQueryClient(<InboxPage />);

    expect(await screen.findByRole("heading", { name: "Ana Souza" })).toBeInTheDocument();
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(4);
  });

  it("mostra estado vazio quando a conversa não tem mensagens", async () => {
    mockProfile();
    mockIntegrations();
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([CONV_ANA]),
        lastMessages: ok(LAST_MESSAGES),
        threadMessages: ok([]),
      }),
    );

    renderWithQueryClient(<InboxPage />);

    expect(await screen.findByText("Sem mensagens")).toBeInTheDocument();
  });

  it("mostra erro ao falhar o carregamento das mensagens", async () => {
    mockProfile();
    mockIntegrations();
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([CONV_ANA]),
        lastMessages: ok(LAST_MESSAGES),
        threadMessages: fail("erro de rede"),
      }),
    );

    renderWithQueryClient(<InboxPage />);

    expect(await screen.findByText("Erro ao carregar mensagens")).toBeInTheDocument();
  });

  it("renderiza mensagens de contato, agente, IA, rascunho e falha com suas ações", async () => {
    mockProfile();
    mockIntegrations();
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([CONV_ANA]),
        lastMessages: ok(LAST_MESSAGES),
        threadMessages: ok(THREAD_ANA),
      }),
    );

    renderWithQueryClient(<InboxPage />);

    expect(await screen.findByText("Olá! Como posso ajudar?")).toBeInTheDocument();
    expect(screen.getByText("Resposta automática da IA")).toBeInTheDocument();
    expect(screen.getAllByText("IA")).not.toHaveLength(0);
    expect(screen.getByText(/· Rascunho/)).toBeInTheDocument();
    expect(screen.getByText("Sugestão da IA")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Descartar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Aprovar e enviar/ })).toBeInTheDocument();
    expect(screen.getByText("Número inválido")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
  });

  it("distingue áudio gerado que falhou e foi substituído por texto", async () => {
    mockProfile();
    mockIntegrations();
    const failedAudio: MessageFixture = {
      id: "m-audio-fallback",
      conversation_id: "c1",
      tenant_id: "t1",
      sender: "ai",
      direction: "out",
      content: "Resposta entregue em texto.",
      media_url: null,
      media_type: "audio/mpeg",
      audio_storage_path: "t1/c1/m-audio-fallback.mp3",
      audio_status: "failed",
      created_at: "2026-07-01T09:35:00.000Z",
      status: "sent",
    };
    const createSignedUrl = vi.fn().mockResolvedValue({
      data: { signedUrl: "https://storage.test/audio?token=1" },
      error: null,
    });
    vi.mocked(supabase.storage.from).mockReturnValue({
      createSignedUrl,
    } as unknown as ReturnType<typeof supabase.storage.from>);
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([CONV_ANA]),
        lastMessages: ok(LAST_MESSAGES),
        threadMessages: ok([failedAudio]),
      }),
    );

    renderWithQueryClient(<InboxPage />);

    expect(
      await screen.findByText("Áudio gerado, mas não enviado — o lead recebeu o texto abaixo."),
    ).toBeInTheDocument();
    expect(screen.getByText("Resposta entregue em texto.")).toBeInTheDocument();
  });

  it("envia mensagem localmente quando a integração está inativa e avisa o agente", async () => {
    mockProfile();
    mockIntegrations({ zapi: false, twilio: false, resend: false });
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([CONV_ANA]),
        lastMessages: ok(LAST_MESSAGES),
        threadMessages: ok([]),
      }),
    );
    const user = userEvent.setup();
    renderWithQueryClient(<InboxPage />);

    await screen.findByText("Sem mensagens");
    await user.type(screen.getByLabelText("Nova mensagem"), "Olá, cliente!");
    await user.click(screen.getByLabelText("Enviar mensagem"));

    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        "Mensagem salva no CRM, mas não foi enviada pelo WhatsApp — a integração está inativa.",
      ),
    );
    expect(screen.getByLabelText("Nova mensagem")).toHaveValue("");
  });

  it("envia mensagem pelo provedor quando a integração está ativa", async () => {
    mockProfile();
    mockIntegrations({ zapi: true });
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: { ok: true }, error: null });
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([CONV_ANA]),
        lastMessages: ok(LAST_MESSAGES),
        threadMessages: ok([]),
      }),
    );
    const user = userEvent.setup();
    renderWithQueryClient(<InboxPage />);

    await screen.findByText("Sem mensagens");
    await user.type(screen.getByLabelText("Nova mensagem"), "Mensagem via provedor");
    await user.click(screen.getByLabelText("Enviar mensagem"));

    await waitFor(() =>
      expect(supabase.functions.invoke).toHaveBeenCalledWith("messaging-send", {
        body: { conversation_id: "c1", content: "Mensagem via provedor" },
      }),
    );
  });

  it("Enter envia a mensagem e Shift+Enter apenas quebra linha", async () => {
    mockProfile();
    mockIntegrations();
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([CONV_ANA]),
        lastMessages: ok(LAST_MESSAGES),
        threadMessages: ok([]),
      }),
    );
    const user = userEvent.setup();
    renderWithQueryClient(<InboxPage />);

    await screen.findByText("Sem mensagens");
    const textarea = screen.getByLabelText("Nova mensagem");
    await user.type(textarea, "Só quebra linha{Shift>}{Enter}{/Shift}continuação");
    expect(textarea).toHaveValue("Só quebra linha\ncontinuação");

    await user.type(textarea, "{Enter}");

    await waitFor(() => expect(textarea).toHaveValue(""));
  });

  it("aprova um rascunho da IA e envia", async () => {
    mockProfile();
    mockIntegrations();
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: { ok: true }, error: null });
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([CONV_ANA]),
        lastMessages: ok(LAST_MESSAGES),
        threadMessages: ok(THREAD_ANA),
      }),
    );
    const user = userEvent.setup();
    renderWithQueryClient(<InboxPage />);

    await screen.findByText(/· Rascunho/);
    await user.click(screen.getByRole("button", { name: /Aprovar e enviar/ }));

    await waitFor(() =>
      expect(supabase.functions.invoke).toHaveBeenCalledWith("messaging-send", {
        body: { draft_message_id: "m4", conversation_id: "c1" },
      }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Rascunho aprovado e enviado."));
  });

  it("edita o rascunho da IA antes de aprovar a mesma mensagem", async () => {
    mockProfile();
    mockIntegrations();
    let messages = [...THREAD_ANA];
    const update = vi.fn((calls: Call[]) => {
      const patch = calls.find((call) => call.method === "update")?.args[0];
      if (
        !patch ||
        typeof patch !== "object" ||
        !("content" in patch) ||
        typeof patch.content !== "string"
      ) {
        throw new Error("Atualização sem texto.");
      }
      const content = patch.content;
      messages = messages.map((message) =>
        message.id === "m4" ? { ...message, content } : message,
      );
      return ok({ id: "m4" });
    });
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([CONV_ANA]),
        lastMessages: ok(LAST_MESSAGES),
        threadMessages: () => ok(messages),
        draftUpdate: update,
      }),
    );
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: { ok: true }, error: null });
    const user = userEvent.setup();
    renderWithQueryClient(<InboxPage />);

    await user.click(await screen.findByRole("button", { name: "Editar rascunho" }));
    const editor = screen.getByRole("textbox", { name: "Texto do rascunho" });
    await user.clear(editor);
    await user.type(editor, "Texto revisado pela equipe.");
    expect(screen.getByRole("button", { name: /Aprovar e enviar/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Salvar rascunho" }));

    expect(await screen.findByText("Texto revisado pela equipe.")).toBeInTheDocument();
    expect(update).toHaveBeenCalledWith(
      expect.arrayContaining([
        { method: "update", args: [{ content: "Texto revisado pela equipe." }] },
        { method: "eq", args: ["id", "m4"] },
        { method: "eq", args: ["tenant_id", "t1"] },
        { method: "eq", args: ["conversation_id", "c1"] },
        { method: "eq", args: ["status", "draft"] },
      ]),
    );
    expect(supabase.functions.invoke).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Aprovar e enviar/ }));
    await waitFor(() =>
      expect(supabase.functions.invoke).toHaveBeenCalledWith("messaging-send", {
        body: { draft_message_id: "m4", conversation_id: "c1" },
      }),
    );
  });

  it("bloqueia rascunho vazio e permite cancelar a edição", async () => {
    mockProfile();
    mockIntegrations();
    const update = vi.fn(() => ok({ id: "m4" }));
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([CONV_ANA]),
        lastMessages: ok(LAST_MESSAGES),
        threadMessages: ok(THREAD_ANA),
        draftUpdate: update,
      }),
    );
    const user = userEvent.setup();
    renderWithQueryClient(<InboxPage />);
    await user.click(await screen.findByRole("button", { name: "Editar rascunho" }));
    await user.clear(screen.getByRole("textbox", { name: "Texto do rascunho" }));
    expect(screen.getByRole("button", { name: "Salvar rascunho" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Cancelar edição" }));

    expect(screen.getByText("Sugestão da IA")).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it("mantém a edição quando o rascunho já foi enviado por outro operador", async () => {
    mockProfile();
    mockIntegrations();
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([CONV_ANA]),
        lastMessages: ok(LAST_MESSAGES),
        threadMessages: ok(THREAD_ANA),
        draftUpdate: () => ok(null),
      }),
    );
    const user = userEvent.setup();
    renderWithQueryClient(<InboxPage />);
    await user.click(await screen.findByRole("button", { name: "Editar rascunho" }));
    await user.type(screen.getByRole("textbox", { name: "Texto do rascunho" }), " Revisado.");
    await user.click(screen.getByRole("button", { name: "Salvar rascunho" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "O rascunho não está mais disponível para edição. Atualize a conversa.",
      ),
    );
    expect(screen.getByRole("textbox", { name: "Texto do rascunho" })).toHaveValue(
      "Sugestão da IA Revisado.",
    );
  });

  it("não envia pelo atalho da próxima ação enquanto o rascunho está em edição", async () => {
    mockProfile();
    mockIntegrations();
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([CONV_ANA]),
        lastMessages: ok(LAST_MESSAGES),
        threadMessages: ok(THREAD_ANA),
        nextBestActionDraft: ok({ id: "m4", conversation_id: "c1", content: "Sugestão da IA" }),
      }),
    );
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: { ok: true }, error: null });
    const user = userEvent.setup();
    renderWithQueryClient(<InboxPage />);
    await user.click(await screen.findByRole("button", { name: "Editar rascunho" }));
    await user.click(await screen.findByRole("button", { name: "Enviar draft" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Salve ou cancele a edição do rascunho antes de enviar.",
      ),
    );
    expect(supabase.functions.invoke).not.toHaveBeenCalled();
  });

  it("descarta um rascunho da IA e tira o aviso de envio pendente da lista", async () => {
    mockProfile();
    mockIntegrations();
    // O rascunho some do banco ao descartar; o refetch da lista (invalidação de
    // "inbox-conversations") precisa enxergar isso, senão a linha continuaria
    // pedindo para enviar uma resposta que não existe mais.
    let draftDescartado = false;
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([{ ...CONV_ANA, awaiting_human: true }]),
        lastMessages: () =>
          ok(
            draftDescartado
              ? LAST_MESSAGES
              : [
                  ...LAST_MESSAGES,
                  {
                    conversation_id: "c1",
                    content: "Rascunho aguardando aprovação",
                    sender: "ai",
                    created_at: "2026-07-01T10:05:00.000Z",
                    status: "draft",
                  },
                ],
          ),
        threadMessages: ok(THREAD_ANA),
      }),
    );
    const user = userEvent.setup();
    renderWithQueryClient(<InboxPage />);

    await screen.findByText(/· Rascunho/);
    expect(await screen.findByText("A IA escreveu — falta você enviar")).toBeInTheDocument();

    draftDescartado = true;
    await user.click(screen.getByRole("button", { name: "Descartar" }));

    await waitFor(() => expect(screen.queryByText(/· Rascunho/)).not.toBeInTheDocument());
    await waitFor(() =>
      expect(screen.queryByText("A IA escreveu — falta você enviar")).not.toBeInTheDocument(),
    );
  });

  it("tenta reenviar uma mensagem que falhou", async () => {
    mockProfile();
    mockIntegrations();
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: { ok: true }, error: null });
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([CONV_ANA]),
        lastMessages: ok(LAST_MESSAGES),
        threadMessages: ok(THREAD_ANA),
      }),
    );
    const user = userEvent.setup();
    renderWithQueryClient(<InboxPage />);

    await screen.findByText("Mensagem que falhou");
    await user.click(screen.getByRole("button", { name: "Tentar de novo" }));

    await waitFor(() =>
      expect(supabase.functions.invoke).toHaveBeenCalledWith("messaging-send", {
        body: { conversation_id: "c1", content: "Mensagem que falhou" },
      }),
    );
  });

  it("alterna a IA entre ativa e pausada na conversa selecionada", async () => {
    mockProfile();
    mockIntegrations();
    const onConversationUpdate = vi.fn();
    // A mutação invalida ["inbox-conversations"] no onSettled, disparando um
    // refetch — o mock precisa refletir o patch aplicado para o refetch não
    // reverter a atualização otimista feita no onMutate.
    let conversations: ConversationFixture[] = [{ ...CONV_ANA }];
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: () => ok(conversations.map((c) => ({ ...c }))),
        lastMessages: ok(LAST_MESSAGES),
        threadMessages: ok([]),
        onConversationUpdate: (id, patch) => {
          onConversationUpdate(id, patch);
          conversations = conversations.map((c) => (c.id === id ? { ...c, ...patch } : c));
        },
      }),
    );
    const user = userEvent.setup();
    renderWithQueryClient(<InboxPage />);

    await screen.findByRole("button", { name: "Assumir conversa" });
    await user.click(screen.getByRole("button", { name: "Assumir conversa" }));

    expect(await screen.findByRole("button", { name: "Reativar IA" })).toBeInTheDocument();
    await waitFor(() =>
      expect(onConversationUpdate).toHaveBeenCalledWith("c1", {
        ai_active: false,
        awaiting_human: false,
      }),
    );
  });

  // Regressão 2026-07-31: reativar a IA precisa gravar ai_resumed_at. É esse
  // timestamp que o gate de takeover do ai-respond usa como corte; sem ele,
  // uma resposta antiga do atendente bloqueava a IA para sempre e a próxima
  // mensagem do lead (texto ou áudio) voltava a "Aguardando humano".
  it("Reativar IA grava ai_resumed_at para destravar o gate de takeover", async () => {
    mockProfile();
    mockIntegrations();
    const onConversationUpdate = vi.fn();
    let conversations: ConversationFixture[] = [{ ...CONV_ANA }];
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: () => ok(conversations.map((c) => ({ ...c }))),
        lastMessages: ok(LAST_MESSAGES),
        threadMessages: ok([]),
        onConversationUpdate: (id, patch) => {
          onConversationUpdate(id, patch);
          conversations = conversations.map((c) => (c.id === id ? { ...c, ...patch } : c));
        },
      }),
    );
    const user = userEvent.setup();
    renderWithQueryClient(<InboxPage />);

    await screen.findByRole("button", { name: "Assumir conversa" });
    await user.click(screen.getByRole("button", { name: "Assumir conversa" }));
    await user.click(await screen.findByRole("button", { name: "Reativar IA" }));

    await waitFor(() =>
      expect(onConversationUpdate).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({
          ai_active: true,
          awaiting_human: false,
          ai_resumed_at: expect.any(String),
        }),
      ),
    );
  });

  it("mostra Reabrir só quando a conversa selecionada já foi resolvida (awaiting_human=false)", async () => {
    mockProfile();
    mockIntegrations();
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([{ ...CONV_ANA }]),
        lastMessages: ok(LAST_MESSAGES),
        threadMessages: ok([]),
      }),
    );

    renderWithQueryClient(<InboxPage />);

    expect(await screen.findByRole("button", { name: "Reabrir" })).toBeInTheDocument();
  });

  it("não mostra Reabrir quando a conversa selecionada está aguardando humano", async () => {
    mockProfile();
    mockIntegrations();
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([{ ...CONV_BRUNO }]),
        lastMessages: ok(LAST_MESSAGES),
        threadMessages: ok([]),
      }),
    );

    renderWithQueryClient(<InboxPage />);

    await screen.findByRole("button", { name: "Reativar IA" });
    expect(screen.queryByRole("button", { name: "Reabrir" })).not.toBeInTheDocument();
  });

  it("Reabrir marca awaiting_human=true na conversa selecionada", async () => {
    mockProfile();
    mockIntegrations();
    const onConversationUpdate = vi.fn();
    let conversations: ConversationFixture[] = [{ ...CONV_ANA }];
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: () => ok(conversations.map((c) => ({ ...c }))),
        lastMessages: ok(LAST_MESSAGES),
        threadMessages: ok([]),
        onConversationUpdate: (id, patch) => {
          onConversationUpdate(id, patch);
          conversations = conversations.map((c) => (c.id === id ? { ...c, ...patch } : c));
        },
      }),
    );
    const user = userEvent.setup();
    renderWithQueryClient(<InboxPage />);

    await user.click(await screen.findByRole("button", { name: "Reabrir" }));

    await waitFor(() =>
      expect(onConversationUpdate).toHaveBeenCalledWith("c1", { awaiting_human: true }),
    );
    expect(screen.queryByRole("button", { name: "Reabrir" })).not.toBeInTheDocument();
  });

  it("Excluir pede confirmação e, ao confirmar, exclui a conversa (soft-delete) e limpa a seleção", async () => {
    mockProfile();
    mockIntegrations();
    const onConversationDelete = vi.fn();
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([{ ...CONV_ANA }]),
        lastMessages: ok(LAST_MESSAGES),
        threadMessages: ok([]),
        onConversationDelete,
      }),
    );
    const user = userEvent.setup();
    renderWithQueryClient(<InboxPage />);

    await user.click(await screen.findByRole("button", { name: "Excluir conversa" }));
    expect(await screen.findByText(/Tem certeza que deseja excluir/)).toBeInTheDocument();
    expect(onConversationDelete).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Excluir" }));

    await waitFor(() => expect(onConversationDelete).toHaveBeenCalledWith("c1"));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Conversa excluída"));
  });

  it("não confirma exclusão quando o delete não afeta nenhuma linha (RLS/já apagada)", async () => {
    mockProfile();
    mockIntegrations();
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([{ ...CONV_ANA }]),
        lastMessages: ok(LAST_MESSAGES),
        threadMessages: ok([]),
        conversationDeleteResult: ok([]),
      }),
    );
    const user = userEvent.setup();
    renderWithQueryClient(<InboxPage />);

    await user.click(await screen.findByRole("button", { name: "Excluir conversa" }));
    await user.click(screen.getByRole("button", { name: "Excluir" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Conversa não encontrada ou sem permissão para excluir",
      ),
    );
    expect(toast.success).not.toHaveBeenCalledWith("Conversa excluída");
    // A conversa continua na lista — seleção intacta, nada foi removido do cache.
    expect(screen.getByRole("heading", { name: "Ana Souza" })).toBeInTheDocument();
  });

  it("assina o canal de realtime do tenant e cancela ao desmontar", async () => {
    mockProfile();
    mockIntegrations();
    vi.mocked(supabase.from).mockImplementation(buildFrom({ conversations: ok([]) }));

    const { unmount } = renderWithQueryClient(<InboxPage />);

    await screen.findByText("Sem conversas");
    expect(supabase.channel).toHaveBeenCalledWith("inbox:t1");

    unmount();
    expect(supabase.removeChannel).toHaveBeenCalled();
  });

  describe("badge de erro de IA — countdown de rate limit", () => {
    it("erro RATE_LIMIT com retryAfterSeconds mostra countdown em vez do badge genérico", async () => {
      mockProfile();
      mockIntegrations();
      const convRateLimit: ConversationFixture = {
        ...CONV_ANA,
        last_error: { code: "RATE_LIMIT", message: "Rate limited", retryAfterSeconds: 42 },
      };
      vi.mocked(supabase.from).mockImplementation(
        buildFrom({
          conversations: ok([convRateLimit]),
          lastMessages: ok(LAST_MESSAGES),
          threadMessages: ok(THREAD_ANA),
        }),
      );

      renderWithQueryClient(<InboxPage />);

      // Sincroniza no cabeçalho da conversa selecionada (auto-select) antes de
      // contar os badges — evita corrida entre o commit do item da Lista e o
      // commit do header, que rendem o MESMO badge em dois lugares.
      await screen.findByRole("heading", { name: "Ana Souza" });
      expect(screen.getAllByText("Tentando de novo em 42s")).toHaveLength(2);
      expect(screen.queryByText("Limite de IA atingido")).not.toBeInTheDocument();
    });

    it("erro RATE_LIMIT SEM retryAfterSeconds mantém o badge genérico", async () => {
      mockProfile();
      mockIntegrations();
      const convRateLimit: ConversationFixture = {
        ...CONV_ANA,
        last_error: { code: "RATE_LIMIT", message: "Rate limited" },
      };
      vi.mocked(supabase.from).mockImplementation(
        buildFrom({
          conversations: ok([convRateLimit]),
          lastMessages: ok(LAST_MESSAGES),
          threadMessages: ok(THREAD_ANA),
        }),
      );

      renderWithQueryClient(<InboxPage />);

      await screen.findByRole("heading", { name: "Ana Souza" });
      expect(screen.getAllByText("Limite de IA atingido")).toHaveLength(2);
      expect(screen.queryByText(/Tentando de novo/)).not.toBeInTheDocument();
    });

    it("outros códigos de erro (fora do escopo do guard) mantêm o badge genérico estático", async () => {
      mockProfile();
      mockIntegrations();
      const convAuthError: ConversationFixture = {
        ...CONV_ANA,
        last_error: {
          code: "PROVIDER_AUTH",
          message: "Chave inválida",
          retryAfterSeconds: 30,
        },
      };
      vi.mocked(supabase.from).mockImplementation(
        buildFrom({
          conversations: ok([convAuthError]),
          lastMessages: ok(LAST_MESSAGES),
          threadMessages: ok(THREAD_ANA),
        }),
      );

      renderWithQueryClient(<InboxPage />);

      // retryAfterSeconds presente, mas o código não é RATE_LIMIT — não deve
      // ganhar tratamento de countdown, mesmo com o campo preenchido.
      await screen.findByRole("heading", { name: "Ana Souza" });
      expect(screen.getAllByText("Erro de autenticação do provedor")).toHaveLength(2);
      expect(screen.queryByText(/Tentando de novo/)).not.toBeInTheDocument();
    });

    it("countdown decrementa a cada segundo e para em zero sem passar de negativo", async () => {
      mockProfile();
      mockIntegrations();
      const convRateLimit: ConversationFixture = {
        ...CONV_ANA,
        last_error: { code: "RATE_LIMIT", message: "Rate limited", retryAfterSeconds: 2 },
      };
      vi.mocked(supabase.from).mockImplementation(
        buildFrom({
          conversations: ok([convRateLimit]),
          lastMessages: ok(LAST_MESSAGES),
          threadMessages: ok(THREAD_ANA),
        }),
      );

      vi.useFakeTimers();
      try {
        const { container } = renderWithQueryClient(<InboxPage />);
        // Flush da resolução das promises mockadas do supabase + re-render do
        // React Query antes de qualquer avanço de relógio — sem isto o
        // `setInterval` do countdown ainda não teria sido registrado.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(screen.getAllByText("Tentando de novo em 2s")).toHaveLength(2);
        expect(container.querySelectorAll('[data-seconds-left="2"]')).toHaveLength(2);

        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
        expect(screen.getAllByText("Tentando de novo em 1s")).toHaveLength(2);
        expect(container.querySelectorAll('[data-seconds-left="1"]')).toHaveLength(2);

        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
        expect(screen.getAllByText("Tentando de novo…")).toHaveLength(2);
        // Prova o clamp real (`s > 0 ? s - 1 : 0`), não só o texto mascarado.
        expect(container.querySelectorAll('[data-seconds-left="0"]')).toHaveLength(2);

        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
        expect(screen.getAllByText("Tentando de novo…")).toHaveLength(2);
        // Um tick a mais sem o clamp interno iria a -1 — confirma que o
        // valor real nunca passa de zero, não só que o texto não muda.
        expect(container.querySelectorAll('[data-seconds-left="0"]')).toHaveLength(2);
        expect(container.querySelectorAll('[data-seconds-left="-1"]')).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe("estado vazio — conversas ocultas pelo período", () => {
  it("lista vazia com conversas fora do período oferece 'Ampliar período'", async () => {
    mockProfile();
    mockIntegrations();
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([]),
        lastMessages: ok([]),
        threadMessages: ok([]),
        hiddenByPeriodCount: 13,
      }),
    );

    renderWithQueryClient(<InboxPage />);

    expect(await screen.findByText("Nenhuma conversa neste período")).toBeInTheDocument();
    expect(screen.getByText(/13 conversas abertas mais antigas/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ampliar período" })).toBeInTheDocument();
    expect(screen.queryByText("Sem conversas")).not.toBeInTheDocument();
  });
});

describe("query de conversas — teto de segurança (fixes #1 e #3 do review)", () => {
  it("exclui conversas fechadas ANTES do `.limit(500)` na query principal", async () => {
    mockProfile();
    mockIntegrations();
    let listCalls: Call[] = [];
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([CONV_ANA, CONV_BRUNO]),
        lastMessages: ok(LAST_MESSAGES),
        threadMessages: ok(THREAD_ANA),
        onConversationsListCalls: (calls) => {
          listCalls = calls;
        },
      }),
    );

    renderWithQueryClient(<InboxPage />);

    await screen.findAllByText("Ana Souza");
    const neqIdx = listCalls.findIndex((c) => c.method === "neq");
    const limitIdx = listCalls.findIndex((c) => c.method === "limit");
    expect(listCalls[neqIdx]?.args).toEqual(["status", "closed"]);
    expect(listCalls[limitIdx]?.args).toEqual([500]);
    // A exclusão de fechadas precisa vir antes do teto — senão o `.limit()`
    // continuaria descartando conversas abertas atrasadas quando o tenant
    // tem >500 conversas HISTÓRICAS (abertas + fechadas somadas), o que
    // undercounta os StatCards de SLA e a fila do Modo Foco.
    expect(neqIdx).toBeGreaterThanOrEqual(0);
    expect(neqIdx).toBeLessThan(limitIdx);
  });

  it("filtra conversas com `deleted_at` (soft-delete) fora da query principal de listagem", async () => {
    mockProfile();
    mockIntegrations();
    let listCalls: Call[] = [];
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([CONV_ANA, CONV_BRUNO]),
        lastMessages: ok(LAST_MESSAGES),
        threadMessages: ok(THREAD_ANA),
        onConversationsListCalls: (calls) => {
          listCalls = calls;
        },
      }),
    );

    renderWithQueryClient(<InboxPage />);

    await screen.findAllByText("Ana Souza");
    // Conversa excluída (soft-delete) não pode aparecer na lista — a query
    // principal filtra `deleted_at is null` no servidor (PostgREST).
    const isCall = listCalls.find((c) => c.method === "is");
    expect(isCall?.args).toEqual(["deleted_at", null]);
  });

  it("tem teto explícito na query de últimas mensagens (não depende de cap implícito do PostgREST)", async () => {
    mockProfile();
    mockIntegrations();
    let msgCalls: Call[] = [];
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([CONV_ANA, CONV_BRUNO]),
        lastMessages: ok(LAST_MESSAGES),
        threadMessages: ok(THREAD_ANA),
        onLastMessagesCalls: (calls) => {
          msgCalls = calls;
        },
      }),
    );

    renderWithQueryClient(<InboxPage />);

    await screen.findAllByText("Ana Souza");
    const limitCall = msgCalls.find((c) => c.method === "limit");
    expect(limitCall?.args).toEqual([2000]);
  });
});

describe("Épico B — Inbox command center", () => {
  it("abas trocam de modo via navigate (?mode)", async () => {
    mockProfile();
    mockIntegrations();
    vi.spyOn(Route, "useSearch").mockReturnValue({});
    vi.mocked(supabase.from).mockImplementation(buildFrom({ conversations: ok([]) }));
    const { navigateMock } = await import("@/test/router-mocks");
    const user = userEvent.setup();

    renderWithQueryClient(<InboxPage />);

    await user.click(screen.getByRole("tab", { name: /Foco/ }));

    expect(navigateMock).toHaveBeenCalled();
    const lastCall = navigateMock.mock.calls.at(-1)?.[0] as {
      search: (prev: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(lastCall.search({})).toEqual({ mode: "foco" });
  });

  it("clique no StatCard 'Atrasados' navega para a Lista com o filtro aplicado", async () => {
    mockProfile();
    mockIntegrations();
    vi.spyOn(Route, "useSearch").mockReturnValue({});
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([CONV_OVERDUE_ONLY]),
        lastMessages: ok(FOCUS_LAST_MESSAGES),
      }),
    );
    const { navigateMock } = await import("@/test/router-mocks");
    const user = userEvent.setup();

    renderWithQueryClient(<InboxPage />);

    await screen.findByText("Atrasados");
    await user.click(screen.getByRole("button", { name: /Atrasados/ }));

    expect(navigateMock).toHaveBeenCalled();
    const lastCall = navigateMock.mock.calls.at(-1)?.[0] as {
      search: (prev: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(lastCall.search({})).toEqual({ mode: "lista", filter: "atrasados" });
  });

  it("Visão geral renderiza os painéis de Risco e Oportunidades a partir dos hooks", async () => {
    mockProfile();
    mockIntegrations();
    vi.spyOn(Route, "useSearch").mockReturnValue({});
    mockRiskOpportunities({
      coldDeals: [{ id: "d1", title: "Negócio parado", contact: { id: "ct1", name: "Ana" } }],
      hotLeads: [
        {
          contact_id: "ct9",
          rationale: "Clicou 3x no anúncio",
          contact: { id: "ct9", name: "Léo Quente" },
        },
      ],
    });
    vi.mocked(supabase.from).mockImplementation(buildFrom({ conversations: ok([]) }));

    renderWithQueryClient(<InboxPage />);

    expect(await screen.findByText("Negócio parado")).toBeInTheDocument();
    expect(screen.getByText("Léo Quente")).toBeInTheDocument();
    expect(screen.getByText("Clicou 3x no anúncio")).toBeInTheDocument();
  });

  it("Modo Foco mostra a fila com awaiting_human antes do atrasado, e Resolver só aparece em awaiting_human", async () => {
    mockProfile();
    mockIntegrations();
    vi.spyOn(Route, "useSearch").mockReturnValue({ mode: "foco" });
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([CONV_OVERDUE_ONLY, CONV_AWAITING]),
        lastMessages: ok(FOCUS_LAST_MESSAGES),
        threadMessages: ok([]),
      }),
    );
    const user = userEvent.setup();

    renderWithQueryClient(<InboxPage />);

    expect(await screen.findByText("Carla Aguardando")).toBeInTheDocument();
    expect(screen.getByText("Aguardando humano")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resolver" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Pular" }));

    expect(await screen.findByText("Diego Atrasado")).toBeInTheDocument();
    expect(screen.getByText(/Atrasado \d+h/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resolver" })).not.toBeInTheDocument();
  });

  it("Resolver no Modo Foco marca awaiting_human=false e avança a fila", async () => {
    mockProfile();
    mockIntegrations();
    vi.spyOn(Route, "useSearch").mockReturnValue({ mode: "foco" });
    const onConversationUpdate = vi.fn();
    let conversations: ConversationFixture[] = [CONV_AWAITING, CONV_OVERDUE_ONLY];
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: () => ok(conversations.map((c) => ({ ...c }))),
        lastMessages: ok(FOCUS_LAST_MESSAGES),
        threadMessages: ok([]),
        onConversationUpdate: (id, patch) => {
          onConversationUpdate(id, patch);
          conversations = conversations.map((c) => (c.id === id ? { ...c, ...patch } : c));
        },
      }),
    );
    const user = userEvent.setup();

    renderWithQueryClient(<InboxPage />);

    await screen.findByText("Carla Aguardando");
    await user.click(screen.getByRole("button", { name: "Resolver" }));

    await waitFor(() =>
      // ai_resumed_at acompanha toda reativação explícita da IA (o gate de
      // takeover do ai-respond usa esse corte), por isso objectContaining.
      expect(onConversationUpdate).toHaveBeenCalledWith(
        "c-await",
        expect.objectContaining({
          awaiting_human: false,
          // Resolver também é retomada explícita da IA (mesmo corte do gate).
          ai_resumed_at: expect.any(String),
        }),
      ),
    );
    expect(await screen.findByText("Diego Atrasado")).toBeInTheDocument();
  });

  it("Responder no Modo Foco reusa o envio da Lista (messaging-send) e avança a fila", async () => {
    mockProfile();
    mockIntegrations({ zapi: true });
    vi.spyOn(Route, "useSearch").mockReturnValue({ mode: "foco" });
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: { ok: true }, error: null });
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([CONV_AWAITING, CONV_OVERDUE_ONLY]),
        lastMessages: ok(FOCUS_LAST_MESSAGES),
        threadMessages: ok([]),
      }),
    );
    const user = userEvent.setup();

    renderWithQueryClient(<InboxPage />);

    await screen.findByText("Carla Aguardando");
    await user.type(screen.getByLabelText("Resposta rápida"), "Já te retorno!");
    await user.click(screen.getByRole("button", { name: "Responder" }));

    await waitFor(() =>
      expect(supabase.functions.invoke).toHaveBeenCalledWith("messaging-send", {
        body: { conversation_id: "c-await", content: "Já te retorno!" },
      }),
    );
    expect(await screen.findByText("Diego Atrasado")).toBeInTheDocument();
  });

  it("mostra InboxZeroState no Modo Foco quando não há awaiting_human nem atrasados", async () => {
    mockProfile();
    mockIntegrations();
    vi.spyOn(Route, "useSearch").mockReturnValue({ mode: "foco" });
    vi.mocked(supabase.from).mockImplementation(buildFrom({ conversations: ok([]) }));

    renderWithQueryClient(<InboxPage />);

    expect(await screen.findByText("Tudo em dia!")).toBeInTheDocument();
  });

  it("Pular no último item da fila leva ao InboxZeroState, sem repeti-lo indefinidamente", async () => {
    mockProfile();
    mockIntegrations();
    vi.spyOn(Route, "useSearch").mockReturnValue({ mode: "foco" });
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([CONV_AWAITING]),
        lastMessages: ok(FOCUS_LAST_MESSAGES),
        threadMessages: ok([]),
      }),
    );
    const user = userEvent.setup();

    renderWithQueryClient(<InboxPage />);

    await screen.findByText("Carla Aguardando");
    await user.click(screen.getByRole("button", { name: "Pular" }));

    expect(await screen.findByText("Tudo em dia!")).toBeInTheDocument();
    // Regressão: um clamp em `focusQueue.length - 1` prendia o índice no
    // último item, fazendo "Pular" reexibi-lo pra sempre em vez de zerar.
    expect(screen.queryByText("Carla Aguardando")).not.toBeInTheDocument();
  });

  it("reseta focusIndex ao reentrar no Foco pela aba do InboxModeTabs, não só pelo botão 'Começar foco'", async () => {
    mockProfile();
    mockIntegrations();
    const searchSpy = vi.spyOn(Route, "useSearch").mockReturnValue({ mode: "foco" });
    vi.mocked(supabase.from).mockImplementation(
      buildFrom({
        conversations: ok([CONV_AWAITING]),
        lastMessages: ok(FOCUS_LAST_MESSAGES),
        threadMessages: ok([]),
      }),
    );
    const user = userEvent.setup();

    const { rerender, queryClient } = renderWithQueryClient(<InboxPage />);

    // Avança o cursor pra fora dos limites da fila (fila de 1 item, index vai a 1).
    await screen.findByText("Carla Aguardando");
    await user.click(screen.getByRole("button", { name: "Pular" }));
    expect(await screen.findByText("Tudo em dia!")).toBeInTheDocument();

    // Sai do Foco sem passar por onStartFocus/openFilter (ex.: Esc ou aba Lista).
    searchSpy.mockReturnValue({ mode: "lista" });
    rerender(
      <QueryClientProvider client={queryClient}>
        <InboxPage />
      </QueryClientProvider>,
    );

    // Reentra pela aba "Foco" do InboxModeTabs — não pelo botão da Visão Geral.
    await user.click(screen.getByRole("tab", { name: /Foco/ }));

    // Simula a navegação (mockada) tendo concluído a troca de `mode`.
    searchSpy.mockReturnValue({ mode: "foco" });
    rerender(
      <QueryClientProvider client={queryClient}>
        <InboxPage />
      </QueryClientProvider>,
    );

    // Regressão: sem reset em setMode(), focusIndex continuaria em 1 (fora da
    // fila de 1 item) e o app mostraria "Tudo em dia!" mesmo havendo item
    // pendente nunca visto pelo usuário.
    expect(await screen.findByText("Carla Aguardando")).toBeInTheDocument();
    expect(screen.queryByText("Tudo em dia!")).not.toBeInTheDocument();
  });

  describe("fix HIGH #1 do review — dedup do painel Risco por follow-up pendente", () => {
    it("conversa fria com follow-up pendente some do painel Risco; sem follow-up continua aparecendo", async () => {
      mockProfile();
      mockIntegrations();
      vi.spyOn(Route, "useSearch").mockReturnValue({});
      // Mesmo padrão do teste de `useHotLeadsWithoutFollowup`: um contato com
      // follow-up pendente é excluído, o outro (sem follow-up) permanece.
      vi.mocked(usePendingFollowupContactIds).mockReturnValue(new Set(["ct-cold-2"]));
      vi.mocked(supabase.from).mockImplementation(
        buildFrom({
          conversations: ok([CONV_COLD_NO_FOLLOWUP, CONV_COLD_WITH_FOLLOWUP]),
          lastMessages: ok([]),
        }),
      );

      renderWithQueryClient(<InboxPage />);

      expect(await screen.findByText("Carla Fria")).toBeInTheDocument();
      expect(screen.queryByText("Diego Frio")).not.toBeInTheDocument();
    });
  });

  describe("fix HIGH #2 do review — applyingKeys é um Set (sem race condition entre linhas)", () => {
    it("duas aplicações concorrentes em linhas diferentes (deal frio + conversa fria) não interferem uma na outra", async () => {
      mockProfile();
      mockIntegrations();
      vi.spyOn(Route, "useSearch").mockReturnValue({});
      mockRiskOpportunities({
        coldDeals: [
          {
            id: "d1",
            title: "Negócio parado",
            contact_id: "ct1",
            contact: { id: "ct1", name: "Ana" },
          },
        ],
      });
      vi.mocked(supabase.from).mockImplementation(
        buildFrom({ conversations: ok([CONV_COLD_NO_FOLLOWUP]), lastMessages: ok([]) }),
      );

      // Mock de `useCreateFollowup` com promise controlável: guarda os
      // callbacks (onSuccess/onError) de cada `.mutate()` por `contactId`,
      // pra resolver cada mutation concorrente de forma independente —
      // exatamente o cenário de regressão do bug (lock era um único
      // `string | null` compartilhado entre TODAS as linhas).
      const pendingCallbacks: Record<
        string,
        { onSuccess?: () => void; onError?: (e: Error) => void }
      > = {};
      const mutate = vi.fn(
        (
          input: { contactId: string },
          callbacks: { onSuccess?: () => void; onError?: (e: Error) => void },
        ) => {
          pendingCallbacks[input.contactId] = callbacks;
        },
      );
      vi.mocked(useCreateFollowup).mockReturnValue({
        mutate,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      const user = userEvent.setup();
      renderWithQueryClient(<InboxPage />);

      await screen.findByText("Negócio parado");
      const dealRow = screen.getByText("Negócio parado").closest("li") as HTMLElement;
      // "Carla Fria" vem do `conversationsQuery` real (supabase mockado) —
      // assíncrono, diferente do painel Risco/deal acima (hook já mockado
      // como síncrono) — precisa de `findByText`, não `getByText`.
      const convRow = (await screen.findByText("Carla Fria")).closest("li") as HTMLElement;

      // Clica em Aplicar na linha A (deal) — fica em voo.
      await user.click(within(dealRow).getByRole("button", { name: "Aplicar" }));
      expect(within(dealRow).getByRole("button", { name: "Aplicando…" })).toBeDisabled();
      // Linha B (conversa) continua livre — nenhum lock compartilhado ainda.
      expect(within(convRow).getByRole("button", { name: "Aplicar" })).toBeEnabled();

      // Clica em Aplicar na linha B enquanto A ainda está em voo.
      await user.click(within(convRow).getByRole("button", { name: "Aplicar" }));
      expect(within(convRow).getByRole("button", { name: "Aplicando…" })).toBeDisabled();
      // Regressão do bug: clicar em B não pode destravar A.
      expect(within(dealRow).getByRole("button", { name: "Aplicando…" })).toBeDisabled();

      // Resolve só a mutation de B — A precisa permanecer em voo.
      act(() => {
        pendingCallbacks["ct-cold-1"]?.onSuccess?.();
      });
      await waitFor(() =>
        expect(within(convRow).getByRole("button", { name: "Aplicar" })).toBeEnabled(),
      );
      expect(within(dealRow).getByRole("button", { name: "Aplicando…" })).toBeDisabled();

      // Resolve a mutation de A por último.
      act(() => {
        pendingCallbacks["ct1"]?.onSuccess?.();
      });
      await waitFor(() =>
        expect(within(dealRow).getByRole("button", { name: "Aplicar" })).toBeEnabled(),
      );
    });
  });
});
