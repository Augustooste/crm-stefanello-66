import { Component, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { renderWithQueryClient } from "@/test/render";
import {
  createFromByTable,
  createPendingQueryBuilder,
  createQueryBuilder,
  fail,
  ok,
  type QueryResult,
} from "@/test/supabase-mock";
import type { ContactRow } from "@/components/contacts/ContactFormDialog";
import { Route } from "./_app.contatos.$id";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { routerOverrides } = await import("@/test/router-mocks");
  return { ...actual, ...routerOverrides() };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), functions: { invoke: vi.fn() } },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// RetornoDialog (Fase 6, Sub-feature 4) usa useCreateAppointment -- mockado
// aqui para não precisar simular a tabela `appointments` (cast especial em
// src/lib/api/appointments.ts) só para exercitar o botão "Agendar retorno".
// Default seguro (mutate no-op) no beforeEach abaixo evita quebrar os demais
// testes desta suíte, que nem sabem que o RetornoDialog existe.
const useCreateAppointmentMock = vi.fn();
vi.mock("@/lib/api/appointments", () => ({
  useCreateAppointment: () => useCreateAppointmentMock(),
}));

// Botão "Agendar retorno" (Fase 6, Sub-feature 4) só aparece com o plugin
// "agenda" ativo para o tenant -- mockado direto (em vez de simular
// niche_templates/tenants via supabase.from) porque os testes desta suíte
// não são sobre resolução de plugin, e sim sobre o fluxo de retorno em si.
// Default `true` no beforeEach evita quebrar os demais testes desta suíte,
// que nem sabem que o botão é condicional.
const usePluginActiveMock = vi.fn();
vi.mock("@/lib/api/plugins", () => ({
  usePluginActive: (slug: string) => usePluginActiveMock(slug),
}));

const ContactDetail = Route.options.component!;

/** Captura o `throw notFound()`/`throw redirect()` que o TanStack Router espera de uma rota real. */
class TestBoundary extends Component<{ children: ReactNode }, { caught: boolean }> {
  state = { caught: false };
  static getDerivedStateFromError() {
    return { caught: true };
  }
  render() {
    return this.state.caught ? <div data-testid="boundary-caught" /> : this.props.children;
  }
}

const CONTACT: ContactRow = {
  id: "c1",
  tenant_id: "t1",
  name: "Ana Souza",
  phone: "11999990000",
  email: "ana@exemplo.com",
  source: "Site",
  tags: ["Quente"],
  notes: "Cliente antiga",
  ai_paused: false,
  created_at: "2026-01-01T00:00:00.000Z",
};

function mockFrom(overrides: Record<string, QueryResult> = {}) {
  vi.mocked(supabase.from).mockImplementation(
    createFromByTable({
      contacts: ok(CONTACT),
      deals: ok([]),
      activities: ok([]),
      conversations: ok([]),
      messages: ok([]),
      contact_notes: ok([]),
      deal_followups: ok([]),
      deal_stage_history: ok([]),
      board_stages: ok([]),
      ...overrides,
    }),
  );
}

describe("head() da rota /_app/contatos/$id", () => {
  it("gera título, canonical e og:url com o id do contato", async () => {
    const head = await Route.options.head?.({ params: { id: "c1" } } as never);

    expect(head?.meta?.some((m) => m && "title" in m && m.title === "Contato")).toBe(true);
    expect(
      head?.links?.some(
        (l) => l && "href" in l && l.href === "https://aceleraflow.lovable.app/contatos/c1",
      ),
    ).toBe(true);
  });
});

describe("página de detalhe do contato (/_app/contatos/$id)", () => {
  beforeEach(() => {
    vi.spyOn(Route, "useParams").mockReturnValue({ id: "c1" });
    useCreateAppointmentMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
    usePluginActiveMock.mockReturnValue(true);
  });

  it("mostra skeleton enquanto o contato está carregando", () => {
    vi.mocked(supabase.from).mockImplementation((table: string) =>
      table === "contacts"
        ? createPendingQueryBuilder()
        : createFromByTable({ deals: ok([]), activities: ok([]), conversations: ok([]) })(table),
    );

    renderWithQueryClient(<ContactDetail />);
    expect(document.querySelector(".animate-pulse")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Ana Souza" })).not.toBeInTheDocument();
  });

  it("lança notFound quando o contato não existe", async () => {
    mockFrom({ contacts: ok(null) });

    renderWithQueryClient(
      <TestBoundary>
        <ContactDetail />
      </TestBoundary>,
    );

    expect(await screen.findByTestId("boundary-caught")).toBeInTheDocument();
  });

  it("renderiza dados do contato e dispara mutação ao editar notas", async () => {
    mockFrom();
    const user = userEvent.setup();
    renderWithQueryClient(<ContactDetail />);

    expect(await screen.findByRole("heading", { name: "Ana Souza" })).toBeInTheDocument();
    expect(screen.getAllByText("11999990000").length).toBeGreaterThan(0);

    const notes = screen.getByLabelText("Notas") as HTMLTextAreaElement;
    expect(notes.value).toBe("Cliente antiga");

    await user.clear(notes);
    await user.type(notes, "Nova nota");
    notes.blur();

    await waitFor(() => {
      const updateCalls = vi
        .mocked(supabase.from)
        .mock.results.filter((r) => r.value && typeof r.value.update === "function");
      expect(updateCalls.some((r) => r.value.update.mock.calls.length > 0)).toBe(true);
    });
  });

  it("mostra estados vazios nas abas de conversas, negócios e atividades", async () => {
    mockFrom();
    const user = userEvent.setup();
    renderWithQueryClient(<ContactDetail />);
    await screen.findByRole("heading", { name: "Ana Souza" });

    await user.click(screen.getByRole("tab", { name: "Conversas" }));
    expect(await screen.findByText("Sem conversas")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Negócios" }));
    expect(await screen.findByText("Sem negócios")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Atividades" }));
    expect(await screen.findByText("Sem atividades")).toBeInTheDocument();
  });

  it("lista negócios com título e estágio", async () => {
    mockFrom({
      deals: ok([
        {
          id: "d1",
          title: "Plano Pro",
          value: 500,
          status: "open",
          stage: { name: "Proposta", is_won: false, is_lost: false },
        },
      ]),
    });
    const user = userEvent.setup();
    renderWithQueryClient(<ContactDetail />);
    await screen.findByRole("heading", { name: "Ana Souza" });

    await user.click(screen.getByRole("tab", { name: "Negócios" }));
    expect(await screen.findByText("Plano Pro")).toBeInTheDocument();
    expect(screen.getByText("Proposta")).toBeInTheDocument();
  });

  it("mostra o motivo da perda só no negócio perdido", async () => {
    mockFrom({
      deals: ok([
        {
          id: "d1",
          title: "Plano Pro",
          value: 500,
          status: "lost",
          lost_reason: "Preço acima do orçamento",
          stage: { name: "Perdidos", is_won: false, is_lost: true },
        },
        {
          id: "d2",
          title: "Plano Básico",
          value: 100,
          status: "open",
          lost_reason: "Motivo antigo",
          stage: { name: "Proposta", is_won: false, is_lost: false },
        },
      ]),
    });
    const user = userEvent.setup();
    renderWithQueryClient(<ContactDetail />);
    await screen.findByRole("heading", { name: "Ana Souza" });

    await user.click(screen.getByRole("tab", { name: "Negócios" }));
    expect(
      await screen.findByText("Motivo da perda: Preço acima do orçamento"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Motivo antigo/)).toBeNull();
  });

  it("renderiza o notFoundComponent da rota com a mensagem de contato inexistente", () => {
    // notFoundComponent não usa props; castamos para um componente sem props.
    const NotFoundComponent = Route.options.notFoundComponent! as () => ReactElement;
    render(<NotFoundComponent />);

    expect(screen.getByText("Contato não encontrado")).toBeInTheDocument();
    expect(screen.getByText("Este contato não existe mais.")).toBeInTheDocument();
  });

  it("lança notFound quando a busca do contato falha com erro", async () => {
    mockFrom({ contacts: fail("Erro ao buscar contato") });

    renderWithQueryClient(
      <TestBoundary>
        <ContactDetail />
      </TestBoundary>,
    );

    expect(await screen.findByTestId("boundary-caught")).toBeInTheDocument();
  });

  it("mantém a lista de negócios vazia quando a busca falha com erro", async () => {
    mockFrom({ deals: fail("Erro ao buscar negócios") });
    const user = userEvent.setup();
    renderWithQueryClient(<ContactDetail />);
    await screen.findByRole("heading", { name: "Ana Souza" });

    await user.click(screen.getByRole("tab", { name: "Negócios" }));
    expect(await screen.findByText("Sem negócios")).toBeInTheDocument();
  });

  it("mantém a lista de atividades vazia quando a busca falha com erro", async () => {
    mockFrom({ activities: fail("Erro ao buscar atividades") });
    const user = userEvent.setup();
    renderWithQueryClient(<ContactDetail />);
    await screen.findByRole("heading", { name: "Ana Souza" });

    await user.click(screen.getByRole("tab", { name: "Atividades" }));
    expect(await screen.findByText("Sem atividades")).toBeInTheDocument();
  });

  it("mantém a lista de conversas vazia quando a busca falha com erro", async () => {
    mockFrom({ conversations: fail("Erro ao buscar conversas") });
    const user = userEvent.setup();
    renderWithQueryClient(<ContactDetail />);
    await screen.findByRole("heading", { name: "Ana Souza" });

    await user.click(screen.getByRole("tab", { name: "Conversas" }));
    expect(await screen.findByText("Sem conversas")).toBeInTheDocument();
  });

  it("propaga erro ao buscar as últimas mensagens das conversas", async () => {
    mockFrom({
      conversations: ok([
        { id: "cv1", status: "open", last_message_at: null, channel: { type: "whatsapp" } },
      ]),
      messages: fail("Erro ao buscar mensagens"),
    });
    const user = userEvent.setup();
    renderWithQueryClient(<ContactDetail />);
    await screen.findByRole("heading", { name: "Ana Souza" });

    await user.click(screen.getByRole("tab", { name: "Conversas" }));
    // a query de conversas entra em erro (mensagens falharam); sem dado, cai no estado vazio.
    expect(await screen.findByText("Sem conversas")).toBeInTheDocument();
  });

  it("trata retorno nulo em negócios, atividades e conversas como lista vazia", async () => {
    mockFrom({ deals: ok(null), activities: ok(null), conversations: ok(null) });
    const user = userEvent.setup();
    renderWithQueryClient(<ContactDetail />);
    await screen.findByRole("heading", { name: "Ana Souza" });

    await user.click(screen.getByRole("tab", { name: "Negócios" }));
    expect(await screen.findByText("Sem negócios")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Atividades" }));
    expect(await screen.findByText("Sem atividades")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Conversas" }));
    expect(await screen.findByText("Sem conversas")).toBeInTheDocument();
  });

  it("mostra skeleton de carregamento nas abas de negócios, conversas e atividades", async () => {
    vi.mocked(supabase.from).mockImplementation((table: string) => {
      if (table === "deals" || table === "conversations" || table === "activities") {
        return createPendingQueryBuilder();
      }
      return createFromByTable({ contacts: ok(CONTACT) })(table);
    });
    const user = userEvent.setup();
    renderWithQueryClient(<ContactDetail />);
    await screen.findByRole("heading", { name: "Ana Souza" });

    await user.click(screen.getByRole("tab", { name: "Conversas" }));
    expect(document.querySelector(".animate-pulse")).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: "Negócios" }));
    expect(document.querySelector(".animate-pulse")).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: "Atividades" }));
    expect(document.querySelector(".animate-pulse")).toBeTruthy();
  });

  it("renderiza conversas com canal conhecido, canal desconhecido e sem canal, status e mensagens variados", async () => {
    mockFrom({
      conversations: ok([
        {
          id: "cv1",
          status: "open",
          last_message_at: "2026-01-02T10:00:00.000Z",
          channel: { type: "whatsapp" },
        },
        {
          id: "cv2",
          status: "closed",
          last_message_at: null,
          channel: { type: "sms" },
        },
        {
          id: "cv3",
          status: "closed",
          last_message_at: null,
          channel: null,
        },
      ]),
      messages: ok([
        {
          conversation_id: "cv1",
          content: "Oi, tudo bem?",
          created_at: "2026-01-02T10:00:00.000Z",
        },
      ]),
    });
    const user = userEvent.setup();
    renderWithQueryClient(<ContactDetail />);
    await screen.findByRole("heading", { name: "Ana Souza" });

    await user.click(screen.getByRole("tab", { name: "Conversas" }));

    expect(await screen.findByText("WhatsApp")).toBeInTheDocument();
    expect(screen.getByText("Aberta")).toBeInTheDocument();
    expect(screen.getByText(/Oi, tudo bem\?/)).toBeInTheDocument();
    expect(screen.getAllByText("Fechada").length).toBe(2);
    expect(screen.getByText("sms")).toBeInTheDocument();
    expect(screen.getByText("Canal")).toBeInTheDocument();
    expect(screen.getAllByText("Sem mensagens").length).toBe(2);
    expect(screen.getAllByText("Abrir no Inbox").length).toBe(3);
  });

  it("formata o valor do negócio como zero quando value é nulo", async () => {
    mockFrom({
      deals: ok([
        {
          id: "d1",
          title: "Plano Grátis",
          value: null,
          status: "open",
          stage: { name: "Proposta", is_won: false, is_lost: false },
        },
      ]),
    });
    const user = userEvent.setup();
    renderWithQueryClient(<ContactDetail />);
    await screen.findByRole("heading", { name: "Ana Souza" });

    await user.click(screen.getByRole("tab", { name: "Negócios" }));
    expect(await screen.findByText("Plano Grátis")).toBeInTheDocument();
    expect(screen.getByText(/R\$\s*0/)).toBeInTheDocument();
  });

  it("renderiza atividades concluída, atrasada e pendente sem data", async () => {
    mockFrom({
      activities: ok([
        {
          id: "a1",
          title: "Ligar para o cliente",
          type: "call",
          due_at: "2020-01-01T00:00:00.000Z",
          completed_at: "2020-01-02T00:00:00.000Z",
        },
        {
          id: "a2",
          title: "Enviar proposta",
          type: "task",
          due_at: "2020-01-01T00:00:00.000Z",
          completed_at: null,
        },
        {
          id: "a3",
          title: "Follow-up sem data",
          type: "task",
          due_at: null,
          completed_at: null,
        },
      ]),
    });
    const user = userEvent.setup();
    renderWithQueryClient(<ContactDetail />);
    await screen.findByRole("heading", { name: "Ana Souza" });

    await user.click(screen.getByRole("tab", { name: "Atividades" }));

    expect(await screen.findByText("Ligar para o cliente")).toBeInTheDocument();
    expect(screen.getByText("Concluída")).toBeInTheDocument();
    expect(screen.getByText("Atrasada")).toBeInTheDocument();
    expect(screen.getByText("Pendente")).toBeInTheDocument();
    expect(screen.getByText("Sem data")).toBeInTheDocument();
  });

  it("mantém telefone, e-mail e origem com traço quando ausentes", async () => {
    mockFrom({ contacts: ok({ ...CONTACT, phone: null, email: null, source: null }) });
    renderWithQueryClient(<ContactDetail />);

    expect(await screen.findByRole("heading", { name: "Ana Souza" })).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(3);
  });

  it("abre o dialog de edição ao clicar em Editar", async () => {
    mockFrom();
    const user = userEvent.setup();
    renderWithQueryClient(<ContactDetail />);
    await screen.findByRole("heading", { name: "Ana Souza" });

    await user.click(screen.getByRole("button", { name: /Editar/ }));
    expect(await screen.findByText("Editar contato")).toBeInTheDocument();
  });

  it("botão 'Criar negócio' navega para o Pipeline com o contato pré-selecionado", async () => {
    mockFrom();
    const { navigateMock } = await import("@/test/router-mocks");
    navigateMock.mockClear();
    const user = userEvent.setup();
    renderWithQueryClient(<ContactDetail />);
    await screen.findByRole("heading", { name: "Ana Souza" });

    await user.click(screen.getByRole("button", { name: /Criar negócio/ }));

    expect(navigateMock).toHaveBeenCalledWith({
      to: "/pipeline",
      search: { contactId: "c1", contactName: "Ana Souza" },
    });
  });

  it("abre o dialog de agendar retorno e cria um appointment para o contato ao submeter", async () => {
    mockFrom();
    const mutateMock = vi.fn((_input: unknown, opts?: { onSuccess?: () => void }) =>
      opts?.onSuccess?.(),
    );
    useCreateAppointmentMock.mockReturnValue({ mutate: mutateMock, isPending: false });

    const user = userEvent.setup();
    renderWithQueryClient(<ContactDetail />);
    await screen.findByRole("heading", { name: "Ana Souza" });

    await user.click(screen.getByRole("button", { name: "Agendar compromisso" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Agendar" }));

    await waitFor(() => {
      expect(mutateMock).toHaveBeenCalledWith(
        expect.objectContaining({ contactId: "c1", modality: "presencial" }),
        expect.any(Object),
      );
    });
    expect(toast.success).toHaveBeenCalled();
  });

  it("esconde o botão 'Agendar retorno' quando o plugin agenda não está ativo pro tenant", async () => {
    mockFrom();
    usePluginActiveMock.mockReturnValue(false);

    renderWithQueryClient(<ContactDetail />);
    await screen.findByRole("heading", { name: "Ana Souza" });

    expect(screen.queryByRole("button", { name: /Agendar/ })).not.toBeInTheDocument();
  });

  it("'Ligar com IA' fica desabilitado quando o serviço de voz não está configurado", async () => {
    mockFrom();
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: { configured: false, simulation: false },
      error: null,
    } as never);
    renderWithQueryClient(<ContactDetail />);
    await screen.findByRole("heading", { name: "Ana Souza" });
    const button = screen.getByRole("button", { name: /Ligar com IA/ });
    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalled());
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Ligações IA não configuradas nesta conta");
  });

  it("'Ligar com IA' habilita quando o serviço de voz está configurado", async () => {
    mockFrom();
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: { configured: true, simulation: true },
      error: null,
    } as never);
    renderWithQueryClient(<ContactDetail />);
    await screen.findByRole("heading", { name: "Ana Souza" });
    await waitFor(() => expect(screen.getByRole("button", { name: /Ligar com IA/ })).toBeEnabled());
  });

  it("não dispara mutação quando o texto das notas não muda no blur", async () => {
    mockFrom();
    renderWithQueryClient(<ContactDetail />);
    await screen.findByRole("heading", { name: "Ana Souza" });

    const notes = screen.getByLabelText("Notas") as HTMLTextAreaElement;
    // aguarda o efeito que sincroniza o rascunho com `contact.notes` antes do blur.
    await waitFor(() => expect(notes.value).toBe("Cliente antiga"));
    notes.focus();
    notes.blur();

    const updateCalls = vi
      .mocked(supabase.from)
      .mock.results.filter(
        (r) =>
          r.value && typeof r.value.update === "function" && r.value.update.mock.calls.length > 0,
      );
    expect(updateCalls.length).toBe(0);
  });

  it("mostra toast de erro quando a mutação de notas falha", async () => {
    let contactsCallCount = 0;
    vi.mocked(supabase.from).mockImplementation((table: string) => {
      if (table === "contacts") {
        contactsCallCount += 1;
        return contactsCallCount === 1
          ? createQueryBuilder(ok(CONTACT))
          : createQueryBuilder(fail("Erro ao salvar notas"));
      }
      return createFromByTable({ deals: ok([]), activities: ok([]), conversations: ok([]) })(table);
    });

    const user = userEvent.setup();
    renderWithQueryClient(<ContactDetail />);
    await screen.findByRole("heading", { name: "Ana Souza" });

    const notes = screen.getByLabelText("Notas") as HTMLTextAreaElement;
    await user.clear(notes);
    await user.type(notes, "Nota que falha ao salvar");
    notes.blur();

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalled();
    });
  });

  describe("aba Timeline", () => {
    it("mostra estado vazio quando não há nenhum evento", async () => {
      mockFrom();
      const user = userEvent.setup();
      renderWithQueryClient(<ContactDetail />);
      await screen.findByRole("heading", { name: "Ana Souza" });

      await user.click(screen.getByRole("tab", { name: "Timeline" }));
      expect(await screen.findByText("Sem eventos")).toBeInTheDocument();
    });

    it("mescla nota, atividade, follow-up, mudança de estágio e mensagem em ordem cronológica única", async () => {
      mockFrom({
        deals: ok([
          {
            id: "d1",
            title: "Plano Pro",
            value: 500,
            status: "open",
            stage: { name: "Proposta", is_won: false, is_lost: false },
          },
        ]),
        activities: ok([
          {
            id: "a1",
            title: "Ligar para o cliente",
            type: "call",
            due_at: "2026-01-02T09:00:00.000Z",
            completed_at: null,
            created_at: "2026-01-01T00:00:00.000Z",
          },
        ]),
        contact_notes: ok([
          { id: "n1", content: "Cliente pediu desconto", created_at: "2026-01-06T00:00:00.000Z" },
        ]),
        deal_followups: ok([
          {
            id: "f1",
            description: "Retornar semana que vem",
            scheduled_at: "2026-01-05T00:00:00.000Z",
            completed_at: null,
            status: "pending",
          },
        ]),
        deal_stage_history: ok([
          {
            id: "s1",
            deal_id: "d1",
            from_stage_id: "stage-novo",
            to_stage_id: "stage-proposta",
            created_at: "2026-01-04T00:00:00.000Z",
            deal: { title: "Plano Pro" },
          },
        ]),
        board_stages: ok([
          { id: "stage-novo", name: "Novo" },
          { id: "stage-proposta", name: "Proposta" },
        ]),
        conversations: ok([
          {
            id: "cv1",
            status: "open",
            last_message_at: "2026-01-03T00:00:00.000Z",
            channel: { type: "whatsapp" },
          },
        ]),
        messages: ok([
          {
            conversation_id: "cv1",
            content: "Oi, tudo bem?",
            created_at: "2026-01-03T00:00:00.000Z",
          },
        ]),
      });

      const user = userEvent.setup();
      renderWithQueryClient(<ContactDetail />);
      await screen.findByRole("heading", { name: "Ana Souza" });

      await user.click(screen.getByRole("tab", { name: "Timeline" }));

      expect(await screen.findByText("Nota adicionada")).toBeInTheDocument();
      const items = await screen.findAllByRole("listitem");
      const titles = items.map((li) => li.textContent);
      // Ordem esperada (mais recente primeiro): nota (01-06) > retorno (01-05)
      // > mudança de estágio (01-04) > mensagem (01-03) > atividade (due_at 01-02).
      const noteIdx = titles.findIndex((t) => t?.includes("Nota adicionada"));
      const followupIdx = titles.findIndex((t) => t?.includes("Retorno agendado"));
      const stageIdx = titles.findIndex((t) => t?.includes("mudou de estágio"));
      const messageIdx = titles.findIndex((t) => t?.includes("Mensagem"));
      const activityIdx = titles.findIndex((t) => t?.includes("Atividade: Ligar para o cliente"));

      expect(noteIdx).toBeGreaterThanOrEqual(0);
      expect(noteIdx).toBeLessThan(followupIdx);
      expect(followupIdx).toBeLessThan(stageIdx);
      expect(stageIdx).toBeLessThan(messageIdx);
      expect(messageIdx).toBeLessThan(activityIdx);
    });

    it("pagina eventos antigos com botão 'Carregar mais'", async () => {
      const manyActivities = Array.from({ length: 60 }, (_, i) => ({
        id: `a${i}`,
        title: `Atividade ${i}`,
        type: "task",
        due_at: null,
        completed_at: null,
        created_at: new Date(2026, 0, i + 1).toISOString(),
      }));
      mockFrom({ activities: ok(manyActivities) });

      const user = userEvent.setup();
      renderWithQueryClient(<ContactDetail />);
      await screen.findByRole("heading", { name: "Ana Souza" });

      await user.click(screen.getByRole("tab", { name: "Timeline" }));
      await screen.findByText("Atividade: Atividade 59");

      expect(screen.getAllByRole("listitem")).toHaveLength(50);
      const loadMore = screen.getByRole("button", { name: "Carregar mais" });

      await user.click(loadMore);

      await waitFor(() => {
        expect(screen.getAllByRole("listitem")).toHaveLength(60);
      });
      expect(screen.queryByRole("button", { name: "Carregar mais" })).not.toBeInTheDocument();
    });
  });

  describe("contato fundido/removido", () => {
    it("mostra aviso com link para o contato de destino quando merged_into_id está preenchido", async () => {
      let contactsCallCount = 0;
      vi.mocked(supabase.from).mockImplementation((table: string) => {
        if (table === "contacts") {
          contactsCallCount += 1;
          // 1ª chamada = busca do próprio contato (via id); 2ª = busca do
          // contato de destino (mergedIntoQuery, via merged_into_id).
          return contactsCallCount === 1
            ? createQueryBuilder(
                ok({ ...CONTACT, deleted_at: "2026-01-01T00:00:00.000Z", merged_into_id: "c2" }),
              )
            : createQueryBuilder(ok({ id: "c2", name: "Outro Contato" }));
        }
        return createFromByTable({
          deals: ok([]),
          activities: ok([]),
          conversations: ok([]),
          messages: ok([]),
          contact_notes: ok([]),
          deal_followups: ok([]),
          deal_stage_history: ok([]),
          board_stages: ok([]),
        })(table);
      });

      renderWithQueryClient(<ContactDetail />);

      expect(
        await screen.findByText(/Este contato foi fundido em outro contato/),
      ).toBeInTheDocument();
      const link = await screen.findByRole("link", { name: "Outro Contato" });
      expect(link).toHaveAttribute("href", expect.stringContaining("c2"));
    });

    it("mostra aviso de contato removido quando só deleted_at está preenchido (sem merge)", async () => {
      mockFrom({
        contacts: ok({ ...CONTACT, deleted_at: "2026-01-01T00:00:00.000Z", merged_into_id: null }),
      });

      renderWithQueryClient(<ContactDetail />);

      expect(
        await screen.findByText(/Este contato foi removido e não aparece mais nas listas/),
      ).toBeInTheDocument();
    });

    it("bloqueia edição (botão Editar e notas) de um contato fundido/removido", async () => {
      mockFrom({
        contacts: ok({ ...CONTACT, deleted_at: "2026-01-01T00:00:00.000Z", merged_into_id: null }),
      });

      renderWithQueryClient(<ContactDetail />);
      await screen.findByRole("heading", { name: "Ana Souza" });

      expect(screen.getByRole("button", { name: /Editar/ })).toBeDisabled();
      expect(screen.getByRole("button", { name: /Criar negócio/ })).toBeDisabled();
      expect(screen.getByLabelText("Notas")).toBeDisabled();
    });

    it("mantém edição normal (botão Editar e notas habilitados) para contato ativo", async () => {
      mockFrom();
      renderWithQueryClient(<ContactDetail />);
      await screen.findByRole("heading", { name: "Ana Souza" });

      expect(screen.getByRole("button", { name: /Editar/ })).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /Criar negócio/ })).not.toBeDisabled();
      expect(screen.getByLabelText("Notas")).not.toBeDisabled();
    });
  });

  describe("campo Empresa (plugin companies)", () => {
    it("esconde o campo Empresa quando o plugin companies não está ativo pro tenant", async () => {
      mockFrom({ contacts: ok({ ...CONTACT, company_id: "company-1" }) });
      usePluginActiveMock.mockImplementation((slug: string) => slug !== "companies");

      renderWithQueryClient(<ContactDetail />);
      await screen.findByRole("heading", { name: "Ana Souza" });

      expect(screen.queryByText("Empresa")).not.toBeInTheDocument();
    });

    it("mostra o link da empresa vinculada quando o plugin companies está ativo", async () => {
      mockFrom({
        contacts: ok({ ...CONTACT, company_id: "company-1" }),
        crm_companies: ok({ id: "company-1", name: "Acme Ltda" }),
      });

      renderWithQueryClient(<ContactDetail />);
      await screen.findByRole("heading", { name: "Ana Souza" });

      expect(await screen.findByRole("link", { name: "Acme Ltda" })).toBeInTheDocument();
    });

    it('renderiza "—" (não um link quebrado) quando a empresa vinculada foi soft-deletada', async () => {
      // company_id aponta pra uma empresa que sumiu da consulta (filtrada por
      // deleted_at is null) -- crm_companies retorna null, não a empresa.
      mockFrom({
        contacts: ok({ ...CONTACT, company_id: "company-1" }),
        crm_companies: ok(null),
      });

      renderWithQueryClient(<ContactDetail />);
      await screen.findByRole("heading", { name: "Ana Souza" });

      expect(screen.queryByRole("link", { name: "Acme Ltda" })).not.toBeInTheDocument();
      expect(screen.getByText("Empresa")).toBeInTheDocument();
      expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    });
  });
});
