import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useCurrentProfile, useTenantProfiles, type CurrentProfile } from "@/lib/api/session";
import { formatBRL } from "@/lib/format";
import { OnboardingGate } from "@/components/onboarding/OnboardingGate";
import { clickCardAction } from "@/test/pipeline-card";
import { renderWithQueryClient } from "@/test/render";
import {
  asFromMock,
  createPendingQueryBuilder,
  createQueryBuilder,
  ok,
} from "@/test/supabase-mock";
import { Route } from "./_app.pipeline";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/api/session", () => ({
  useCurrentProfile: vi.fn(),
  useTenantProfiles: vi.fn(),
}));

// O gate de onboarding só abre depois do aceite do aviso de privacidade;
// no teste consideramos o aviso já aceito.
vi.mock("@/components/common/ConsentModal", () => ({
  useConsentAcknowledged: () => true,
  ConsentModal: () => null,
}));

const PipelinePage = Route.options.component!;

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
  contact: { id: string; name: string; tags: string[] | null; source: string | null } | null;
};

const BOARD = { id: "b1", name: "Funil padrão", is_default: true, position: 0 };

const STAGES: Stage[] = [
  { id: "s1", name: "Novos", position: 1, is_won: false, is_lost: false },
  { id: "s2", name: "Qualificados", position: 2, is_won: false, is_lost: false },
  { id: "s3", name: "Ganhos", position: 3, is_won: true, is_lost: false },
  { id: "s4", name: "Perdidos", position: 4, is_won: false, is_lost: true },
];

const DEALS: DealRow[] = [
  {
    id: "d1",
    title: "Negócio A",
    value: 1000,
    stage_id: "s1",
    owner_id: "u1",
    status: "open",
    contact_id: "c1",
    contact: { id: "c1", name: "Ana Souza", tags: ["Quente"], source: "Site" },
  },
  {
    id: "d2",
    title: "Negócio B",
    value: 2000,
    stage_id: "s2",
    owner_id: "u2",
    status: "open",
    contact_id: null,
    contact: null,
  },
];

const TAGS = [{ id: "tg1", name: "Quente", color: "#ff0000" }];

const CONTACTS_MIN = [
  { id: "c1", name: "Ana Souza" },
  { id: "c2", name: "Bruno Lima" },
];

/** getByText normaliza espaços (inclusive o NBSP produzido pelo formatBRL) para espaço comum; fazemos o mesmo no esperado. */
const normSpaces = (s: string) => s.replace(/\u00a0/g, " ");

const PROFILE: CurrentProfile = { id: "u1", tenant_id: "tenant-1", name: "Ana", role: "admin" };
const TENANT_PROFILES = [
  { id: "u1", name: "Ana", role: "admin" },
  { id: "u2", name: "Bruno", role: "agent" },
];

function mockProfile(profile: CurrentProfile | null = PROFILE, tenantProfiles = TENANT_PROFILES) {
  vi.mocked(useCurrentProfile).mockReturnValue({
    data: profile,
  } as ReturnType<typeof useCurrentProfile>);
  vi.mocked(useTenantProfiles).mockReturnValue({
    data: tenantProfiles,
  } as ReturnType<typeof useTenantProfiles>);
}

/** Linha de `tenants` que o OnboardingGate lê para decidir se abre o assistente. */
type TenantRow = {
  id: string;
  name: string;
  logo_url: string | null;
  niche: string | null;
  onboarded_at: string | null;
  business_profile: Record<string, unknown>;
};

type FromOverrides = {
  tenant?: TenantRow | null;
  board?: typeof BOARD | null;
  stages?: Stage[];
  deals?: DealRow[];
  tags?: typeof TAGS;
  contacts?: typeof CONTACTS_MIN;
  hotVerdicts?: { contact_id: string }[];
  dealsUpdateSpy?: Mock;
  dealsEqSpy?: Mock;
  dealsInsertSpy?: Mock;
};

/** Mock de `supabase.from` roteado por tabela, com spies opcionais para inspecionar mutações. */
function mockSupabaseFrom({
  tenant = null,
  board = BOARD,
  stages = STAGES,
  deals = DEALS,
  tags = TAGS,
  contacts = CONTACTS_MIN,
  hotVerdicts = [],
  dealsUpdateSpy,
  dealsEqSpy,
  dealsInsertSpy,
}: FromOverrides = {}) {
  vi.mocked(supabase.from).mockImplementation(
    asFromMock((table: string) => {
      switch (table) {
        case "tenants":
          return createQueryBuilder(ok(tenant));
        case "boards":
          return createQueryBuilder(ok(board ? [board] : []));
        case "board_stages":
          return createQueryBuilder(ok(stages));
        case "ai_lead_verdicts":
          return createQueryBuilder(ok(hotVerdicts));
        case "deals": {
          const builder = createQueryBuilder(ok(deals));
          if (dealsUpdateSpy) builder.update = dealsUpdateSpy.mockReturnValue(builder);
          if (dealsEqSpy) builder.eq = dealsEqSpy.mockReturnValue(builder);
          if (dealsInsertSpy) builder.insert = dealsInsertSpy.mockReturnValue(builder);
          return builder;
        }
        case "tags":
          return createQueryBuilder(ok(tags));
        case "contacts":
          return createQueryBuilder(ok(contacts));
        default:
          return createQueryBuilder(ok(null));
      }
    }),
  );
}

function columnByStage(stageName: string): HTMLElement {
  return screen.getAllByTestId("pipeline-column").find((el) => el.dataset.stageName === stageName)!;
}

describe("página de pipeline (/_app/pipeline)", () => {
  beforeEach(() => {
    mockProfile();
    vi.mocked(supabase.rpc).mockReset();
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: { success: true, status: "accepted" },
      error: null,
    } as never);
    // Route.useSearch() usa useMatch internamente (precisa de RouterProvider
    // real); mockado direto, mesmo padrão de _app.inbox.test.tsx.
    vi.spyOn(Route, "useSearch").mockReturnValue({});
  });

  it("mostra skeletons enquanto o funil está carregando", () => {
    vi.mocked(supabase.from).mockImplementation(
      asFromMock((table: string) => {
        if (table === "boards") return createPendingQueryBuilder();
        return createQueryBuilder(ok(null));
      }),
    );

    renderWithQueryClient(<PipelinePage />);

    expect(screen.getByText("Funil")).toBeInTheDocument();
    expect(document.querySelectorAll(".animate-pulse").length).toBe(4);
  });

  it("mostra estado vazio quando não há funil configurado", async () => {
    mockSupabaseFrom({ board: null });

    renderWithQueryClient(<PipelinePage />);

    expect(await screen.findByText("Nenhum funil configurado")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Novo negócio/ })).not.toBeInTheDocument();
  });

  it("estado vazio oferece saída ao admin: abre o assistente no passo do Nicho", async () => {
    const user = userEvent.setup();
    mockSupabaseFrom({ board: null });

    renderWithQueryClient(<PipelinePage />);

    // Sem esta saída o admin fica preso: o BoardSwitcher, que sabe criar funil,
    // some justamente quando não há nenhum board.
    const action = await screen.findByRole("button", { name: "Configurar funil" });
    await user.click(action);

    expect(await screen.findByText("Configuração inicial — Nicho")).toBeInTheDocument();
  });

  it("não empilha um segundo assistente sobre o do OnboardingGate", async () => {
    const user = userEvent.setup();
    // Tenant recém-criado: sem funil E sem onboarding concluído — exatamente o
    // estado que "Pular por enquanto" deixa para trás, e o único em que o gate
    // e o estado vazio do funil disputam a tela.
    mockSupabaseFrom({
      board: null,
      tenant: {
        id: "tenant-1",
        name: "Empresa X",
        logo_url: null,
        niche: null,
        onboarded_at: null,
        business_profile: {},
      },
    });

    renderWithQueryClient(
      <>
        <OnboardingGate />
        <PipelinePage />
      </>,
    );

    // Enquanto não for dispensado, quem manda na tela é o gate.
    expect(
      await screen.findByText(/Configuração inicial — (Preparar o ambiente|Empresa)/),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Fechar janela" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    // Dispensado o gate, a saída do estado vazio abre um único assistente —
    // o gate não reabre por trás porque `onboarded_at` continua nulo e a
    // dispensa é lembrada por essa mesma chave.
    await user.click(await screen.findByRole("button", { name: "Configurar funil" }));

    expect(await screen.findByText("Configuração inicial — Nicho")).toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("estado vazio não oferece o botão a quem não é admin", async () => {
    mockProfile({ ...PROFILE, role: "agent" });
    mockSupabaseFrom({ board: null });

    renderWithQueryClient(<PipelinePage />);

    expect(await screen.findByText("Nenhum funil configurado")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Configurar funil" })).not.toBeInTheDocument();
    expect(
      screen.getByText("Peça a um administrador da sua empresa para configurar o funil."),
    ).toBeInTheDocument();
  });

  it("renderiza as colunas do funil com os negócios distribuídos por estágio", async () => {
    mockSupabaseFrom();

    renderWithQueryClient(<PipelinePage />);

    expect(await screen.findByText("Novos")).toBeInTheDocument();
    expect(screen.getByText("Qualificados")).toBeInTheDocument();
    expect(screen.getByText("Ganhos")).toBeInTheDocument();
    expect(screen.getByText("Perdidos")).toBeInTheDocument();

    // negócio A na coluna "Novos", com contato, etiqueta e origem do lead
    expect(screen.getByText("Negócio A")).toBeInTheDocument();
    expect(screen.getByText("Ana Souza")).toBeInTheDocument();
    expect(screen.getByText("Quente")).toBeInTheDocument();
    expect(screen.getByText("Site")).toBeInTheDocument();

    // negócio B na coluna "Qualificados", sem contato
    expect(screen.getByText("Negócio B")).toBeInTheDocument();

    // cabeçalho da coluna: contagem com substantivo + total destacado à direita
    expect(within(columnByStage("Novos")).getByText("1 negócio")).toBeInTheDocument();
    expect(within(columnByStage("Novos")).getByTestId("pipeline-column-total")).toHaveTextContent(
      normSpaces(formatBRL(1000)),
    );
    expect(within(columnByStage("Qualificados")).getByText("1 negócio")).toBeInTheDocument();
    expect(
      within(columnByStage("Qualificados")).getByTestId("pipeline-column-total"),
    ).toHaveTextContent(normSpaces(formatBRL(2000)));
    expect(within(columnByStage("Ganhos")).getByText("0 negócios")).toBeInTheDocument();
    expect(within(columnByStage("Ganhos")).getByTestId("pipeline-column-total")).toHaveTextContent(
      normSpaces(formatBRL(0)),
    );

    // colunas "Ganhos" e "Perdidos" ficam vazias, com placeholder de arrastar
    expect(screen.getAllByText("Arraste negócios para cá")).toHaveLength(2);
  });

  it("filtra os negócios por responsável", async () => {
    mockSupabaseFrom();
    const user = userEvent.setup();
    renderWithQueryClient(<PipelinePage />);

    await screen.findByText("Negócio A");
    expect(screen.getByText("Negócio B")).toBeInTheDocument();

    const [, ownerCombobox] = screen.getAllByRole("combobox");
    await user.click(ownerCombobox);
    await user.click(await screen.findByRole("option", { name: "Bruno" }));

    expect(screen.queryByText("Negócio A")).not.toBeInTheDocument();
    expect(screen.getByText("Negócio B")).toBeInTheDocument();
  });

  it("filtra os negócios por etiqueta", async () => {
    mockSupabaseFrom();
    const user = userEvent.setup();
    renderWithQueryClient(<PipelinePage />);

    await screen.findByText("Negócio A");
    expect(screen.getByText("Negócio B")).toBeInTheDocument();

    const comboboxes = screen.getAllByRole("combobox");
    const tagCombobox = comboboxes[2];
    await user.click(tagCombobox);
    await user.click(await screen.findByRole("option", { name: "Quente" }));

    expect(screen.getByText("Negócio A")).toBeInTheDocument();
    expect(screen.queryByText("Negócio B")).not.toBeInTheDocument();
  });

  it("troca o placeholder de arrastar por um estado único quando o filtro não acha nada", async () => {
    mockSupabaseFrom();
    const user = userEvent.setup();
    renderWithQueryClient(<PipelinePage />);

    await screen.findByText("Negócio A");

    await user.type(screen.getByLabelText("Buscar negócios"), "inexistente");

    expect(
      await screen.findByText("Nenhum negócio encontrado com os filtros atuais"),
    ).toBeInTheDocument();
    // as colunas somem: nada de repetir a mensagem de primeiro uso em cada uma
    expect(screen.queryAllByTestId("pipeline-column")).toHaveLength(0);
    expect(screen.queryByText("Arraste negócios para cá")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Limpar filtros" }));

    expect(await screen.findByText("Negócio A")).toBeInTheDocument();
    expect(screen.getAllByText("Arraste negócios para cá").length).toBeGreaterThan(0);
  });

  it("expõe Ganhar e Perder como botões com rótulo no card, só para negócio em aberto", async () => {
    const wonDeal: DealRow = {
      id: "d3",
      title: "Negócio C",
      value: 500,
      stage_id: "s3",
      owner_id: "u1",
      status: "won",
      contact_id: null,
      contact: null,
    };
    mockSupabaseFrom({ deals: [...DEALS, wonDeal] });
    renderWithQueryClient(<PipelinePage />);

    const cardA = (await screen.findByText("Negócio A")).closest("div.group") as HTMLElement;
    expect(within(cardA).getByRole("button", { name: "Ganhar" })).toBeInTheDocument();
    expect(within(cardA).getByRole("button", { name: "Perder" })).toBeInTheDocument();
    // o resto das ações (Falar com IA, Mover para…) continua no menu
    expect(within(cardA).getByLabelText("Ações do negócio")).toBeInTheDocument();

    const cardC = screen.getByText("Negócio C").closest("div.group") as HTMLElement;
    expect(within(cardC).queryByRole("button", { name: "Ganhar" })).not.toBeInTheDocument();
    expect(within(cardC).queryByRole("button", { name: "Perder" })).not.toBeInTheDocument();
  });

  it("esconde Ganhar/Perder também no negócio perdido, e sem sobra dos menuitem antigos", async () => {
    const lostDeal: DealRow = {
      id: "d4",
      title: "Negócio D",
      value: 300,
      stage_id: "s4",
      owner_id: "u1",
      status: "lost",
      contact_id: null,
      contact: null,
    };
    mockSupabaseFrom({ deals: [...DEALS, lostDeal] });
    renderWithQueryClient(<PipelinePage />);

    const cardD = (await screen.findByText("Negócio D")).closest("div.group") as HTMLElement;
    expect(within(cardD).queryByRole("button", { name: "Ganhar" })).not.toBeInTheDocument();
    expect(within(cardD).queryByRole("button", { name: "Perder" })).not.toBeInTheDocument();
    // Ganhar/Perder saíram do menu: nenhum menuitem sobra montado no card.
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
  });

  it("mostra o motivo da perda no card do negócio perdido", async () => {
    const lostDeal: DealRow = {
      id: "d4",
      title: "Negócio D",
      value: 300,
      stage_id: "s4",
      owner_id: "u1",
      status: "lost",
      lost_reason: "Escolheu o concorrente",
      contact_id: null,
      contact: null,
    };
    const reopened: DealRow = { ...DEALS[0], id: "d5", lost_reason: "Motivo antigo" };
    mockSupabaseFrom({ deals: [...DEALS, lostDeal, reopened] });
    renderWithQueryClient(<PipelinePage />);

    const cardD = (await screen.findByText("Negócio D")).closest("div.group") as HTMLElement;
    expect(within(cardD).getByText("Motivo da perda: Escolheu o concorrente")).toBeVisible();
    expect(screen.queryByText(/Motivo antigo/)).toBeNull();
  });

  it("pluraliza a contagem da coluna e marca o total como filtrado quando há filtro ativo", async () => {
    const irmao: DealRow = { ...DEALS[0], id: "d5", title: "Negócio A2", value: 500 };
    mockSupabaseFrom({ deals: [...DEALS, irmao] });
    const user = userEvent.setup();
    renderWithQueryClient(<PipelinePage />);

    await screen.findByText("Negócio A");
    const colunaNovos = columnByStage("Novos");
    expect(within(colunaNovos).getByText("2 negócios")).toBeInTheDocument();
    expect(within(colunaNovos).getByLabelText("Total da etapa")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Buscar negócios"), "Negócio A2");

    await waitFor(() =>
      expect(within(columnByStage("Novos")).getByText("1 negócio (filtrados)")).toBeInTheDocument(),
    );
    expect(
      within(columnByStage("Novos")).getByLabelText("Total filtrado da etapa"),
    ).toBeInTheDocument();
  });

  it("aciona o estado vazio por responsável + etiqueta, sem depender da busca", async () => {
    mockSupabaseFrom();
    const user = userEvent.setup();
    renderWithQueryClient(<PipelinePage />);

    await screen.findByText("Negócio A");

    // 1º combobox = quadro, 2º = responsável, 3º = etiqueta.
    await user.click(screen.getAllByRole("combobox")[1]);
    await user.click(await screen.findByRole("option", { name: "Bruno" }));
    expect(screen.queryByText("Negócio A")).not.toBeInTheDocument();

    // Bruno só tem negócio sem contato, logo sem etiqueta: interseção vazia.
    await user.click(screen.getAllByRole("combobox")[2]);
    await user.click(await screen.findByRole("option", { name: "Quente" }));

    expect(
      await screen.findByText("Nenhum negócio encontrado com os filtros atuais"),
    ).toBeInTheDocument();
  });

  it("exibe a tag 'Lead quente' só para o negócio cujo contato tem veredito IA hot", async () => {
    mockSupabaseFrom({ hotVerdicts: [{ contact_id: "c1" }] });

    renderWithQueryClient(<PipelinePage />);

    const cardA = (await screen.findByText("Negócio A")).closest("div.group")!;
    expect(await within(cardA as HTMLElement).findByText("Lead quente")).toBeInTheDocument();

    const cardB = screen.getByText("Negócio B").closest("div.group")!;
    expect(within(cardB as HTMLElement).queryByText("Lead quente")).not.toBeInTheDocument();
  });

  it("não exibe a tag 'Lead quente' quando nenhum contato visível tem veredito hot", async () => {
    mockSupabaseFrom({ hotVerdicts: [] });

    renderWithQueryClient(<PipelinePage />);

    await screen.findByText("Negócio A");
    expect(screen.queryByText("Lead quente")).not.toBeInTheDocument();
  });

  it("não exibe a tag 'Lead quente' para negócio já ganho/perdido, mesmo com veredito hot", async () => {
    const wonDeal: DealRow = {
      id: "d3",
      title: "Negócio C",
      value: 500,
      stage_id: "s3",
      owner_id: "u1",
      status: "won",
      contact_id: "c1",
      contact: { id: "c1", name: "Ana Souza", tags: [], source: null },
    };
    mockSupabaseFrom({ deals: [...DEALS, wonDeal], hotVerdicts: [{ contact_id: "c1" }] });

    renderWithQueryClient(<PipelinePage />);

    const cardC = (await screen.findByText("Negócio C")).closest("div.group")!;
    expect(within(cardC as HTMLElement).queryByText("Lead quente")).not.toBeInTheDocument();
  });

  it("filtra os cards do board pela busca textual (título ou nome do contato)", async () => {
    mockSupabaseFrom();
    const user = userEvent.setup();
    renderWithQueryClient(<PipelinePage />);

    await screen.findByText("Negócio A");
    expect(screen.getByText("Negócio B")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Buscar negócios"), "Ana Souza");

    expect(screen.getByText("Negócio A")).toBeInTheDocument();
    expect(screen.queryByText("Negócio B")).not.toBeInTheDocument();
  });

  it("cria um novo negócio para um contato existente", async () => {
    const dealsInsertSpy = vi.fn();
    mockSupabaseFrom({ dealsInsertSpy });
    const user = userEvent.setup();
    renderWithQueryClient(<PipelinePage />);

    await user.click(await screen.findByRole("button", { name: /Novo negócio/ }));
    const dialog = await screen.findByRole("dialog");

    await user.click(within(dialog).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Ana Souza" }));
    // O <Label> não tem "for"/"id" ligado ao <Input> — busca pelo placeholder.
    await user.type(within(dialog).getByPlaceholderText("Ex.: Plano anual"), "Plano anual");
    await user.click(within(dialog).getByRole("button", { name: "Criar negócio" }));

    await waitFor(() =>
      expect(dealsInsertSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant_id: "tenant-1",
          board_id: "b1",
          stage_id: "s1",
          contact_id: "c1",
          title: "Plano anual",
          owner_id: "u1",
          status: "open",
        }),
      ),
    );
    expect(toast.success).toHaveBeenCalledWith("Negócio criado");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("marca um negócio como ganho pelo botão visível do card", async () => {
    mockSupabaseFrom();
    renderWithQueryClient(<PipelinePage />);

    await screen.findByText("Negócio A");
    await clickCardAction("Negócio A", "Ganhar");

    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith(
        "transition_deal_stage",
        expect.objectContaining({
          p_deal_id: "d1",
          p_expected_stage_id: "s1",
          p_target_stage_id: "s3",
        }),
      ),
    );
  });

  it("marca um negócio como perdido exigindo o motivo antes de confirmar", async () => {
    mockSupabaseFrom();
    renderWithQueryClient(<PipelinePage />);

    await screen.findByText("Negócio A");
    const user = await clickCardAction("Negócio A", "Perder");

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Marcar como perdido")).toBeInTheDocument();

    const confirmButton = within(dialog).getByRole("button", { name: "Marcar perdido" });
    expect(confirmButton).toBeDisabled();

    await user.type(within(dialog).getByLabelText("Motivo *"), "Sem orçamento");
    expect(confirmButton).toBeEnabled();
    await user.click(confirmButton);

    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith(
        "transition_deal_stage",
        expect.objectContaining({
          p_deal_id: "d1",
          p_expected_stage_id: "s1",
          p_target_stage_id: "s4",
          p_reason: "Sem orçamento",
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("abre com dealId no search: resolve o board do negócio e destaca o card", async () => {
    vi.spyOn(Route, "useSearch").mockReturnValue({ dealId: "d1" });
    let dealsCallCount = 0;
    vi.mocked(supabase.from).mockImplementation(
      asFromMock((table: string) => {
        switch (table) {
          case "boards":
            return createQueryBuilder(ok([BOARD]));
          case "board_stages":
            return createQueryBuilder(ok(STAGES));
          case "deals": {
            dealsCallCount += 1;
            // 1ª chamada é o lookup de board do dealId (.maybeSingle()); as
            // seguintes são a listagem normal do board resolvido.
            if (dealsCallCount === 1) return createQueryBuilder(ok({ board_id: BOARD.id }));
            return createQueryBuilder(ok(DEALS));
          }
          case "tags":
            return createQueryBuilder(ok(TAGS));
          case "contacts":
            return createQueryBuilder(ok(CONTACTS_MIN));
          default:
            return createQueryBuilder(ok(null));
        }
      }),
    );

    renderWithQueryClient(<PipelinePage />);

    await screen.findByText("Negócio A");
    const card = screen.getByText("Negócio A").closest("[data-deal-id]");
    expect(card).toHaveAttribute("data-deal-id", "d1");
    await waitFor(() => expect(card?.className).toMatch(/ring-primary/));
  });

  it("abre com contactId no search: dialog de novo negócio já pré-seleciona o contato", async () => {
    vi.spyOn(Route, "useSearch").mockReturnValue({ contactId: "c2", contactName: "Bruno Lima" });
    const dealsInsertSpy = vi.fn();
    mockSupabaseFrom({ dealsInsertSpy });
    const user = userEvent.setup();

    renderWithQueryClient(<PipelinePage />);

    // Dialog abre sozinho (deep-link vindo de Contatos), sem clicar em "Novo negócio".
    const dialog = await screen.findByRole("dialog");
    // Preenche só o título — o botão fica habilitado sem tocar no combobox de
    // contato, provando que o contactId do search já pré-selecionou "Bruno Lima".
    await user.type(within(dialog).getByPlaceholderText("Ex.: Plano anual"), "Plano anual");
    const submit = within(dialog).getByRole("button", { name: "Criar negócio" });
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() =>
      expect(dealsInsertSpy).toHaveBeenCalledWith(
        expect.objectContaining({ contact_id: "c2", title: "Plano anual" }),
      ),
    );
  });

  it("sintetiza a opção do contato do deep-link quando ele está fora dos primeiros 500 do select", async () => {
    vi.spyOn(Route, "useSearch").mockReturnValue({ contactId: "c2", contactName: "Bruno Lima" });
    // contacts-min não inclui "c2" — só assim o fallback via contactOptions entra em jogo.
    mockSupabaseFrom({ contacts: [{ id: "c1", name: "Ana Souza" }] });

    renderWithQueryClient(<PipelinePage />);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("combobox")).toHaveTextContent("Bruno Lima");
  });

  it("invalida a query de negócios do contato (aba do detalhe) ao criar um negócio", async () => {
    const dealsInsertSpy = vi.fn();
    mockSupabaseFrom({ dealsInsertSpy });
    const user = userEvent.setup();
    // gcTime default (não 0, como o createTestQueryClient usa): a query
    // "contact-deals" não tem observador nesta página — com gcTime 0 ela seria
    // coletada antes da asserção abaixo rodar.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderWithQueryClient(<PipelinePage />, { queryClient });
    queryClient.setQueryData(["contact-deals", "c1"], [{ id: "d9", title: "Negócio antigo" }]);

    await user.click(await screen.findByRole("button", { name: /Novo negócio/ }));
    const dialog = await screen.findByRole("dialog");

    await user.click(within(dialog).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Ana Souza" }));
    await user.type(within(dialog).getByPlaceholderText("Ex.: Plano anual"), "Plano anual");
    await user.click(within(dialog).getByRole("button", { name: "Criar negócio" }));

    await waitFor(() => expect(dealsInsertSpy).toHaveBeenCalled());
    await waitFor(() =>
      expect(queryClient.getQueryState(["contact-deals", "c1"])?.isInvalidated).toBe(true),
    );
  });

  // Lacuna conhecida: o submenu "Mover para…" (Radix DropdownMenuSub) depende de
  // pointer events (hover/pointermove) que o jsdom não simula de forma confiável —
  // uma tentativa de clicar no gatilho do submenu e no item de destino não disparou
  // a mutation, mesma classe de limitação do drag-and-drop do @dnd-kit. Por isso
  // `handleMoveToStage` (chamado só por esse submenu e pelo drag) não tem teste
  // direto; a mutation `moveMut` em si (payload de stage_id/status/lost_reason,
  // sucesso e invalidação de queries) está coberta pelos testes de "Ganhar" e
  // "Perder" acima, que a disparam por rotas alternativas sem gesto de ponteiro.

  describe("toggle de visualização kanban/tabela", () => {
    it("alterna para a visão em tabela e volta pro kanban", async () => {
      mockSupabaseFrom();
      const user = userEvent.setup();
      renderWithQueryClient(<PipelinePage />);

      await screen.findByText("Negócio A");
      // kanban: nome da coluna aparece como cabeçalho do quadro
      expect(screen.getByText("Novos")).toBeInTheDocument();
      const kanbanButton = screen.getByRole("button", { name: "Visualização em quadro" });
      const listButton = screen.getByRole("button", { name: "Visualização em tabela" });
      expect(kanbanButton).toHaveAttribute("aria-pressed", "true");
      expect(listButton).toHaveAttribute("aria-pressed", "false");

      await user.click(listButton);

      // tabela: colunas específicas da visão em lista, placeholder do kanban some
      expect(await screen.findByRole("columnheader", { name: "Negócio" })).toBeInTheDocument();
      expect(screen.getByRole("columnheader", { name: "Estágio" })).toBeInTheDocument();
      expect(screen.queryByText("Arraste negócios para cá")).not.toBeInTheDocument();
      expect(listButton).toHaveAttribute("aria-pressed", "true");
      expect(kanbanButton).toHaveAttribute("aria-pressed", "false");

      await user.click(kanbanButton);

      expect(screen.queryByRole("columnheader", { name: "Negócio" })).not.toBeInTheDocument();
      expect(screen.getAllByText("Arraste negócios para cá").length).toBeGreaterThan(0);
    });

    it("renderiza os negócios na tabela com valor, estágio e dono", async () => {
      mockSupabaseFrom();
      const user = userEvent.setup();
      renderWithQueryClient(<PipelinePage />);

      await screen.findByText("Negócio A");
      await user.click(screen.getByRole("button", { name: "Visualização em tabela" }));

      await screen.findByRole("columnheader", { name: "Negócio" });
      expect(screen.getByText("Negócio A")).toBeInTheDocument();
      expect(screen.getByText(normSpaces(formatBRL(1000)))).toBeInTheDocument();
      // dono resolvido a partir de tenantProfiles (owner_id "u1" -> "Ana")
      expect(screen.getByText("Ana")).toBeInTheDocument();
      // estágio clicável mostrando o nome do estágio atual do negócio
      expect(
        screen.getByRole("button", { name: /Estágio de Negócio A: Novos/ }),
      ).toBeInTheDocument();
    });

    it("move um negócio de estágio pela tabela usando o mesmo mecanismo 'Mover para…' do kanban", async () => {
      mockSupabaseFrom();
      const user = userEvent.setup();
      renderWithQueryClient(<PipelinePage />);

      await screen.findByText("Negócio A");
      await user.click(screen.getByRole("button", { name: "Visualização em tabela" }));
      await screen.findByRole("columnheader", { name: "Negócio" });

      await user.click(screen.getByRole("button", { name: /Estágio de Negócio A: Novos/ }));
      await user.click(await screen.findByRole("menuitem", { name: "Ganhos" }));

      await waitFor(() =>
        expect(supabase.rpc).toHaveBeenCalledWith(
          "transition_deal_stage",
          expect.objectContaining({
            p_deal_id: "d1",
            p_expected_stage_id: "s1",
            p_target_stage_id: "s3",
          }),
        ),
      );
    });

    it("move para um estágio de perda pela tabela abre o dialog de motivo (mesma regra do kanban)", async () => {
      const dealsUpdateSpy = vi.fn();
      mockSupabaseFrom({ dealsUpdateSpy });
      const user = userEvent.setup();
      renderWithQueryClient(<PipelinePage />);

      await screen.findByText("Negócio A");
      await user.click(screen.getByRole("button", { name: "Visualização em tabela" }));
      await screen.findByRole("columnheader", { name: "Negócio" });

      await user.click(screen.getByRole("button", { name: /Estágio de Negócio A: Novos/ }));
      await user.click(await screen.findByRole("menuitem", { name: "Perdidos" }));

      // handleMoveToStage desvia para o dialog de motivo em vez de mutar direto
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText("Marcar como perdido")).toBeInTheDocument();
      expect(dealsUpdateSpy).not.toHaveBeenCalled();
    });
  });
});
