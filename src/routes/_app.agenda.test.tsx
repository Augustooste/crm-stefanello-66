import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { renderWithQueryClient } from "@/test/render";
import {
  asFromMock,
  createFromByTable,
  createPendingQueryBuilder,
  createQueryBuilder,
  fail,
  ok,
  type QueryResult,
} from "@/test/supabase-mock";
import { requirePluginActive } from "@/lib/api/plugins";
import { Route } from "./_app.agenda";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/api/plugins", () => ({
  requirePluginActive: vi.fn(),
}));

const useCurrentProfileMock = vi.fn();
vi.mock("@/lib/api/session", () => ({
  useCurrentProfile: () => useCurrentProfileMock(),
}));

const AgendaPage = Route.options.component!;

const PROFILE = { id: "u1", tenant_id: "t1", name: "Felipe", role: "admin" as const };

const TENANT_ROW = {
  id: "t1",
  name: "Empresa X",
  logo_url: null,
  niche: "buffet-eventos",
  onboarded_at: null,
  business_profile: { appointment_label: "Visita" },
};

const APPOINTMENT = {
  id: "a1",
  tenant_id: "t1",
  contact_id: "c1",
  title: "Visita técnica ao salão",
  date: "2026-07-14",
  time_start: "10:00:00",
  time_end: "11:00:00",
  modality: "presencial",
  status: "scheduled",
  notes: null,
  custom_fields: {},
  external_ref: null,
  external_source: null,
  created_by: "u1",
  created_at: "2026-07-11T00:00:00Z",
  updated_at: "2026-07-11T00:00:00Z",
  contact: { id: "c1", name: "Cliente X" },
};

function mockSupabaseTables(overrides: Partial<Record<string, QueryResult>> = {}) {
  vi.mocked(supabase.from).mockImplementation(
    createFromByTable({
      appointments: ok([]),
      tenants: ok(TENANT_ROW),
      contacts: ok([]),
      ...overrides,
    }),
  );
}

describe("configuração da rota /_app/agenda", () => {
  it("delega o guard de plugin ativo para requirePluginActive com o slug 'agenda'", async () => {
    vi.mocked(requirePluginActive).mockResolvedValue(undefined);
    const queryClient = { fake: true };

    await Route.options.beforeLoad?.({ context: { queryClient } } as never);

    expect(requirePluginActive).toHaveBeenCalledWith(queryClient, "agenda");
  });

  it("define título e descrição de SEO", () => {
    const head = Route.options.head?.({} as never);

    expect(head).toEqual({
      meta: [
        { title: "Agenda" },
        {
          name: "description",
          content: "Agenda semanal de compromissos do seu negócio.",
        },
      ],
    });
  });
});

describe("página de agenda (/_app/agenda)", () => {
  beforeEach(() => {
    useCurrentProfileMock.mockReset();
    useCurrentProfileMock.mockReturnValue({ data: PROFILE });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 6, 13, 10, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("mostra skeleton enquanto os compromissos carregam", () => {
    vi.mocked(supabase.from).mockImplementation(
      asFromMock((table: string) =>
        table === "appointments" ? createPendingQueryBuilder() : createQueryBuilder(ok(TENANT_ROW)),
      ),
    );
    renderWithQueryClient(<AgendaPage />);

    expect(screen.getByRole("heading", { name: "Agenda" })).toBeInTheDocument();
    expect(screen.queryByText(/Nenhum/)).not.toBeInTheDocument();
  });

  it("mostra estado de erro quando a consulta falha", async () => {
    mockSupabaseTables({ appointments: fail("timeout ao buscar compromissos") });
    renderWithQueryClient(<AgendaPage />);

    expect(await screen.findByText("timeout ao buscar compromissos")).toBeInTheDocument();
  });

  it("mostra estado vazio com o rótulo customizado do business_profile", async () => {
    mockSupabaseTables({ appointments: ok([]) });
    renderWithQueryClient(<AgendaPage />);

    expect(await screen.findByText("Nenhum visita nesta semana")).toBeInTheDocument();
  });

  it("usa 'Compromisso' como rótulo default quando business_profile não define appointment_label", async () => {
    mockSupabaseTables({
      appointments: ok([]),
      tenants: ok({ ...TENANT_ROW, business_profile: {} }),
    });
    renderWithQueryClient(<AgendaPage />);

    expect(await screen.findByText("Nenhum compromisso nesta semana")).toBeInTheDocument();
    // 2 botões "Novo compromisso" na tela vazia: o do PageHeader e o da EmptyState.
    expect(screen.getAllByRole("button", { name: /Novo compromisso/ })).toHaveLength(2);
  });

  it("lista um compromisso da semana no grid", async () => {
    mockSupabaseTables({ appointments: ok([APPOINTMENT]) });
    renderWithQueryClient(<AgendaPage />);

    expect(await screen.findByText("Visita técnica ao salão")).toBeInTheDocument();
    expect(screen.getByText("Presencial")).toBeInTheDocument();
  });

  it("botões de navegação de semana têm aria-label distintos e movem a semana certa", async () => {
    mockSupabaseTables({ appointments: ok([]) });
    renderWithQueryClient(<AgendaPage />);

    await screen.findByText("Nenhum visita nesta semana");
    const weekLabel = screen.getByText(/\d{4}$/).textContent;

    const prevButton = screen.getByRole("button", { name: "Semana anterior" });
    const nextButton = screen.getByRole("button", { name: "Próxima semana" });
    expect(prevButton).toBeInTheDocument();
    expect(nextButton).toBeInTheDocument();

    await userEvent.setup().click(nextButton);
    expect(screen.getByText(/\d{4}$/).textContent).not.toBe(weekLabel);
  });

  it("abre o dialog de novo compromisso e cria com sucesso", async () => {
    const appointmentsBuilder = createQueryBuilder(ok([]));
    vi.mocked(supabase.from).mockImplementation(
      asFromMock((table: string) => {
        if (table === "appointments") return appointmentsBuilder;
        if (table === "tenants") return createQueryBuilder(ok(TENANT_ROW));
        return createQueryBuilder(ok([]));
      }),
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithQueryClient(<AgendaPage />);

    await screen.findByText("Nenhum visita nesta semana");
    // 2 botões "Novo visita": o do PageHeader (usado aqui) e o da EmptyState.
    const [headerButton] = screen.getAllByRole("button", { name: /Novo visita/ });
    await user.click(headerButton);

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Título *"), "Visita ao imóvel");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Visita criado"));
    expect(appointmentsBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: "t1",
        title: "Visita ao imóvel",
        created_by: "u1",
      }),
    );
  });

  it("abre o dialog de edição ao clicar num compromisso existente", async () => {
    mockSupabaseTables({ appointments: ok([APPOINTMENT]) });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithQueryClient(<AgendaPage />);

    await user.click(await screen.findByText("Visita técnica ao salão"));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Editar visita")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Visita técnica ao salão")).toBeInTheDocument();
  });

  it("editar um compromisso sem mexer em Status preserva o status real (não reverte para 'scheduled')", async () => {
    const appointmentsBuilder = createQueryBuilder(ok([{ ...APPOINTMENT, status: "confirmed" }]));
    vi.mocked(supabase.from).mockImplementation(
      asFromMock((table: string) => {
        if (table === "appointments") return appointmentsBuilder;
        if (table === "tenants") return createQueryBuilder(ok(TENANT_ROW));
        return createQueryBuilder(ok([]));
      }),
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithQueryClient(<AgendaPage />);

    await user.click(await screen.findByText("Visita técnica ao salão"));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    // Regressão: o dialog abre para um compromisso já "confirmed" -- editar
    // só as observações (sem tocar no Select de Status) não pode reverter o
    // status para o default "scheduled" do estado interno do dialog.
    await user.type(screen.getByLabelText("Observações"), "Confirmado por telefone");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Visita atualizado"));
    expect(appointmentsBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "confirmed" }),
    );
  });

  it("botão 'Hoje' volta para a semana atual após navegar para a próxima", async () => {
    mockSupabaseTables({ appointments: ok([]) });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithQueryClient(<AgendaPage />);

    await screen.findByText("Nenhum visita nesta semana");
    const originalLabel = screen.getByText(/\d{4}$/).textContent;

    await user.click(screen.getByRole("button", { name: "Próxima semana" }));
    expect(screen.getByText(/\d{4}$/).textContent).not.toBe(originalLabel);

    await user.click(screen.getByRole("button", { name: "Hoje" }));
    expect(screen.getByText(/\d{4}$/).textContent).toBe(originalLabel);
  });

  it("botão 'Semana anterior' move a semana para trás", async () => {
    mockSupabaseTables({ appointments: ok([]) });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithQueryClient(<AgendaPage />);

    await screen.findByText("Nenhum visita nesta semana");
    const originalLabel = screen.getByText(/\d{4}$/).textContent;

    await user.click(screen.getByRole("button", { name: "Semana anterior" }));

    expect(screen.getByText(/\d{4}$/).textContent).not.toBe(originalLabel);
  });

  describe("exclusão de compromisso pelo dialog de edição", () => {
    it("exclui com sucesso após confirmar no alerta", async () => {
      let appointmentsCall = 0;
      vi.mocked(supabase.from).mockImplementation(
        asFromMock((table: string) => {
          if (table === "appointments") {
            appointmentsCall += 1;
            return createQueryBuilder(appointmentsCall === 1 ? ok([APPOINTMENT]) : ok(undefined));
          }
          if (table === "tenants") return createQueryBuilder(ok(TENANT_ROW));
          return createQueryBuilder(ok([]));
        }),
      );
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderWithQueryClient(<AgendaPage />);

      await user.click(await screen.findByText("Visita técnica ao salão"));
      await screen.findByRole("dialog");
      await user.click(screen.getByRole("button", { name: "Excluir" }));

      const alertDialog = await screen.findByRole("alertdialog");
      expect(within(alertDialog).getByText("Excluir visita")).toBeInTheDocument();
      await user.click(within(alertDialog).getByRole("button", { name: "Excluir" }));

      await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Visita excluído"));
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    it("mostra toast de erro quando a exclusão falha no backend", async () => {
      let appointmentsCall = 0;
      vi.mocked(supabase.from).mockImplementation(
        asFromMock((table: string) => {
          if (table === "appointments") {
            appointmentsCall += 1;
            return createQueryBuilder(
              appointmentsCall === 1 ? ok([APPOINTMENT]) : fail("falha ao excluir compromisso"),
            );
          }
          if (table === "tenants") return createQueryBuilder(ok(TENANT_ROW));
          return createQueryBuilder(ok([]));
        }),
      );
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderWithQueryClient(<AgendaPage />);

      await user.click(await screen.findByText("Visita técnica ao salão"));
      await screen.findByRole("dialog");
      await user.click(screen.getByRole("button", { name: "Excluir" }));

      const alertDialog = await screen.findByRole("alertdialog");
      await user.click(within(alertDialog).getByRole("button", { name: "Excluir" }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("falha ao excluir compromisso"));
    });

    it("cancela a exclusão sem chamar o backend", async () => {
      mockSupabaseTables({ appointments: ok([APPOINTMENT]) });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderWithQueryClient(<AgendaPage />);

      await user.click(await screen.findByText("Visita técnica ao salão"));
      await screen.findByRole("dialog");
      await user.click(screen.getByRole("button", { name: "Excluir" }));

      const alertDialog = await screen.findByRole("alertdialog");
      await user.click(within(alertDialog).getByRole("button", { name: "Cancelar" }));

      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
      expect(toast.success).not.toHaveBeenCalled();
    });
  });

  it("fecha o dialog sem salvar ao clicar em 'Cancelar'", async () => {
    mockSupabaseTables({ appointments: ok([]) });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithQueryClient(<AgendaPage />);

    await screen.findByText("Nenhum visita nesta semana");
    const [headerButton] = screen.getAllByRole("button", { name: /Novo visita/ });
    await user.click(headerButton);
    await screen.findByRole("dialog");

    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("mostra erro de validação e não envia quando o título está vazio", async () => {
    mockSupabaseTables({ appointments: ok([]) });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithQueryClient(<AgendaPage />);

    await screen.findByText("Nenhum visita nesta semana");
    const [headerButton] = screen.getAllByRole("button", { name: /Novo visita/ });
    await user.click(headerButton);
    await screen.findByRole("dialog");

    await user.click(screen.getByRole("button", { name: "Salvar" }));

    expect(await screen.findByText("Título é obrigatório")).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("mostra toast de erro quando criar o compromisso falha no backend", async () => {
    let appointmentsCall = 0;
    vi.mocked(supabase.from).mockImplementation(
      asFromMock((table: string) => {
        if (table === "appointments") {
          appointmentsCall += 1;
          return createQueryBuilder(
            appointmentsCall === 1 ? ok([]) : fail("falha ao criar compromisso"),
          );
        }
        if (table === "tenants") return createQueryBuilder(ok(TENANT_ROW));
        return createQueryBuilder(ok([]));
      }),
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithQueryClient(<AgendaPage />);

    await screen.findByText("Nenhum visita nesta semana");
    const [headerButton] = screen.getAllByRole("button", { name: /Novo visita/ });
    await user.click(headerButton);
    await screen.findByRole("dialog");
    await user.type(screen.getByLabelText("Título *"), "Visita ao imóvel");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("falha ao criar compromisso"));
  });

  it("mostra toast de erro quando atualizar o compromisso falha no backend", async () => {
    let appointmentsCall = 0;
    vi.mocked(supabase.from).mockImplementation(
      asFromMock((table: string) => {
        if (table === "appointments") {
          appointmentsCall += 1;
          return createQueryBuilder(
            appointmentsCall === 1 ? ok([APPOINTMENT]) : fail("falha ao atualizar compromisso"),
          );
        }
        if (table === "tenants") return createQueryBuilder(ok(TENANT_ROW));
        return createQueryBuilder(ok([]));
      }),
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithQueryClient(<AgendaPage />);

    await user.click(await screen.findByText("Visita técnica ao salão"));
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("falha ao atualizar compromisso"));
  });

  it("permite trocar a modalidade para Online e envia o valor selecionado", async () => {
    const appointmentsBuilder = createQueryBuilder(ok([]));
    vi.mocked(supabase.from).mockImplementation(
      asFromMock((table: string) => {
        if (table === "appointments") return appointmentsBuilder;
        if (table === "tenants") return createQueryBuilder(ok(TENANT_ROW));
        return createQueryBuilder(ok([]));
      }),
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithQueryClient(<AgendaPage />);

    await screen.findByText("Nenhum visita nesta semana");
    const [headerButton] = screen.getAllByRole("button", { name: /Novo visita/ });
    await user.click(headerButton);
    await screen.findByRole("dialog");

    await user.type(screen.getByLabelText("Título *"), "Reunião remota");
    // Ordem no DOM (criação): Modalidade (0), Contato (1) — Status só existe em edição.
    await user.click(screen.getAllByRole("combobox")[0]);
    await user.click(await screen.findByRole("option", { name: "Online" }));
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() =>
      expect(appointmentsBuilder.insert).toHaveBeenCalledWith(
        expect.objectContaining({ modality: "online" }),
      ),
    );
  });

  it("seleciona um contato existente na lista e envia o contactId escolhido", async () => {
    const appointmentsBuilder = createQueryBuilder(ok([]));
    vi.mocked(supabase.from).mockImplementation(
      asFromMock((table: string) => {
        if (table === "appointments") return appointmentsBuilder;
        if (table === "tenants") return createQueryBuilder(ok(TENANT_ROW));
        if (table === "contacts")
          return createQueryBuilder(ok([{ id: "c9", name: "Maria Nunes" }]));
        return createQueryBuilder(ok([]));
      }),
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithQueryClient(<AgendaPage />);

    await screen.findByText("Nenhum visita nesta semana");
    const [headerButton] = screen.getAllByRole("button", { name: /Novo visita/ });
    await user.click(headerButton);
    await screen.findByRole("dialog");

    await user.type(screen.getByLabelText("Título *"), "Visita com contato");
    // Ordem no DOM (criação): Modalidade (0), Contato (1).
    await user.click(screen.getAllByRole("combobox")[1]);
    await user.click(await screen.findByRole("option", { name: "Maria Nunes" }));
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() =>
      expect(appointmentsBuilder.insert).toHaveBeenCalledWith(
        expect.objectContaining({ contact_id: "c9" }),
      ),
    );
  });

  it("permite trocar o status ao editar um compromisso existente", async () => {
    const appointmentsBuilder = createQueryBuilder(ok([APPOINTMENT]));
    vi.mocked(supabase.from).mockImplementation(
      asFromMock((table: string) => {
        if (table === "appointments") return appointmentsBuilder;
        if (table === "tenants") return createQueryBuilder(ok(TENANT_ROW));
        return createQueryBuilder(ok([]));
      }),
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithQueryClient(<AgendaPage />);

    await user.click(await screen.findByText("Visita técnica ao salão"));
    await screen.findByRole("dialog");

    // Ordem no DOM (edição): Modalidade (0), Contato (1), Status (2).
    await user.click(screen.getAllByRole("combobox")[2]);
    await user.click(await screen.findByRole("option", { name: "Confirmado" }));
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() =>
      expect(appointmentsBuilder.update).toHaveBeenCalledWith(
        expect.objectContaining({ status: "confirmed" }),
      ),
    );
  });

  it("não quebra quando a consulta de contatos do dialog falha", async () => {
    mockSupabaseTables({ appointments: ok([]), contacts: fail("timeout ao buscar contatos") });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithQueryClient(<AgendaPage />);

    await screen.findByText("Nenhum visita nesta semana");
    const [headerButton] = screen.getAllByRole("button", { name: /Novo visita/ });
    await user.click(headerButton);

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    // Select de contato ainda renderiza (com só a opção "Nenhum") sem quebrar.
    expect(screen.getAllByRole("combobox")).toHaveLength(2);
  });

  it("não quebra quando a consulta de contatos do dialog retorna dado nulo", async () => {
    mockSupabaseTables({ appointments: ok([]), contacts: ok(null) });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithQueryClient(<AgendaPage />);

    await screen.findByText("Nenhum visita nesta semana");
    const [headerButton] = screen.getAllByRole("button", { name: /Novo visita/ });
    await user.click(headerButton);

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    // Select de contato ainda renderiza (com só a opção "Nenhum") sem quebrar.
    expect(screen.getAllByRole("combobox")).toHaveLength(2);
  });
});
