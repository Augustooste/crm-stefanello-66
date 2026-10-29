import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { Route } from "./_app.atividades";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { routerOverrides } = await import("@/test/router-mocks");
  return { ...actual, ...routerOverrides() };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const useCurrentProfileMock = vi.fn();
const useTenantProfilesMock = vi.fn();
vi.mock("@/lib/api/session", () => ({
  useCurrentProfile: () => useCurrentProfileMock(),
  useTenantProfiles: () => useTenantProfilesMock(),
}));

const ActivitiesPage = Route.options.component!;

const PROFILE = { id: "u1", tenant_id: "t1", name: "Felipe", role: "admin" as const };

/** ISO de um horário em um dia deslocado de hoje (evita flakiness perto da meia-noite). */
function isoOffsetDays(days: number, hour: number, minute = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

const ATRASADA = {
  id: "a1",
  tenant_id: "t1",
  type: "call",
  title: "Ligar para Ana",
  due_at: isoOffsetDays(-1, 9),
  completed_at: null,
  owner_id: "u1",
  contact_id: "c1",
  deal_id: null,
  contact: { id: "c1", name: "Ana Souza" },
  deal: null,
  owner: { id: "u1", name: "Felipe" },
};

const HOJE = {
  id: "a2",
  tenant_id: "t1",
  type: "task",
  title: "Enviar proposta",
  due_at: isoOffsetDays(0, 15),
  completed_at: null,
  owner_id: null,
  contact_id: null,
  deal_id: "d1",
  contact: null,
  deal: { id: "d1", title: "Negócio X" },
  owner: null,
};

const PROXIMA = {
  id: "a3",
  tenant_id: "t1",
  type: "note",
  title: "Anotar detalhes da reunião",
  due_at: isoOffsetDays(2, 10),
  completed_at: null,
  owner_id: null,
  contact_id: null,
  deal_id: null,
  contact: null,
  deal: null,
  owner: null,
};

const CONCLUIDA_HOJE = {
  id: "a4",
  tenant_id: "t1",
  type: "task",
  title: "Tarefa já concluída",
  due_at: isoOffsetDays(-3, 10),
  completed_at: new Date().toISOString(),
  owner_id: "u1",
  contact_id: null,
  deal_id: null,
  contact: null,
  deal: null,
  owner: null,
};

const ACTIVITIES = [ATRASADA, HOJE, PROXIMA, CONCLUIDA_HOJE];

function mockSupabaseTables(overrides: Partial<Record<string, QueryResult>> = {}) {
  vi.mocked(supabase.from).mockImplementation(
    createFromByTable({
      activities: ok([]),
      contacts: ok([]),
      deals: ok([]),
      ...overrides,
    }),
  );
}

describe("página de atividades (/_app/atividades)", () => {
  beforeEach(() => {
    useCurrentProfileMock.mockReset();
    useTenantProfilesMock.mockReset();
    useCurrentProfileMock.mockReturnValue({ data: PROFILE });
    useTenantProfilesMock.mockReturnValue({ data: [PROFILE] });
  });

  it("mostra skeletons enquanto as atividades carregam", () => {
    vi.mocked(supabase.from).mockImplementation(
      asFromMock((table: string) =>
        table === "activities" ? createPendingQueryBuilder() : createQueryBuilder(ok([])),
      ),
    );
    const { container } = renderWithQueryClient(<ActivitiesPage />);

    expect(screen.getByRole("heading", { name: "Atividades" })).toBeInTheDocument();
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(2);
    expect(screen.queryByText("Nada atrasado")).not.toBeInTheDocument();
  });

  it("mostra estado de erro com opção de tentar novamente", async () => {
    mockSupabaseTables({ activities: fail("timeout ao buscar atividades") });
    renderWithQueryClient(<ActivitiesPage />);

    expect(await screen.findByText("Erro ao carregar")).toBeInTheDocument();
    expect(screen.getByText("timeout ao buscar atividades")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tentar novamente" })).toBeInTheDocument();
  });

  it("mostra os estados vazios de cada seção quando não há atividades", async () => {
    mockSupabaseTables({ activities: ok([]) });
    renderWithQueryClient(<ActivitiesPage />);

    expect(await screen.findByText("Nada atrasado")).toBeInTheDocument();
    expect(screen.getByText("Nenhuma tarefa para hoje")).toBeInTheDocument();
    expect(screen.getByText("Sem próximas tarefas")).toBeInTheDocument();
    expect(screen.queryByText(/Concluídas hoje/)).not.toBeInTheDocument();
  });

  it("classifica atividades em atrasadas, hoje e próximas, com contato, negócio e responsável", async () => {
    mockSupabaseTables({ activities: ok(ACTIVITIES) });
    renderWithQueryClient(<ActivitiesPage />);

    expect(await screen.findByText("Atrasadas (1)")).toBeInTheDocument();
    expect(screen.getByText("Hoje (1)")).toBeInTheDocument();
    expect(screen.getByText("Próximas (1)")).toBeInTheDocument();
    expect(screen.getByText("Concluídas hoje (1)")).toBeInTheDocument();

    expect(screen.getByText("Ligar para Ana")).toBeInTheDocument();
    expect(screen.getByText("Ligação")).toBeInTheDocument();
    expect(screen.getByText("Ana Souza")).toBeInTheDocument();
    expect(screen.getByText("Resp.: Felipe")).toBeInTheDocument();

    expect(screen.getByText("Enviar proposta")).toBeInTheDocument();
    expect(screen.getByText("Negócio X")).toBeInTheDocument();

    expect(screen.getByText("Anotar detalhes da reunião")).toBeInTheDocument();

    // a atividade concluída fica dentro do collapsible fechado, não visível de cara
    expect(screen.queryByText("Tarefa já concluída")).not.toBeInTheDocument();
  });

  it("expande 'Concluídas hoje' para revelar a atividade concluída", async () => {
    mockSupabaseTables({ activities: ok(ACTIVITIES) });
    const user = userEvent.setup();
    renderWithQueryClient(<ActivitiesPage />);

    const trigger = await screen.findByText("Concluídas hoje (1)");
    await user.click(trigger);

    expect(await screen.findByText("Tarefa já concluída")).toBeInTheDocument();
  });

  it("marca uma atividade como concluída ao clicar no checkbox", async () => {
    const activitiesBuilder = createQueryBuilder(ok(ACTIVITIES));
    vi.mocked(supabase.from).mockImplementation(
      asFromMock((table: string) =>
        table === "activities" ? activitiesBuilder : createQueryBuilder(ok([])),
      ),
    );
    const user = userEvent.setup();
    renderWithQueryClient(<ActivitiesPage />);

    await screen.findByText("Ligar para Ana");
    await user.click(screen.getByLabelText("Concluir Ligar para Ana"));

    await waitFor(() =>
      expect(activitiesBuilder.update).toHaveBeenCalledWith({ completed_at: expect.any(String) }),
    );
    expect(activitiesBuilder.eq).toHaveBeenCalledWith("id", "a1");
  });

  it("reagenda uma atividade a partir do popover de reagendamento", async () => {
    const activitiesBuilder = createQueryBuilder(ok(ACTIVITIES));
    vi.mocked(supabase.from).mockImplementation(
      asFromMock((table: string) =>
        table === "activities" ? activitiesBuilder : createQueryBuilder(ok([])),
      ),
    );
    const user = userEvent.setup();
    renderWithQueryClient(<ActivitiesPage />);

    await screen.findByText("Ligar para Ana");
    const row = screen.getByText("Ligar para Ana").closest("li");
    if (!row) throw new Error("linha da atividade não encontrada");
    await user.click(within(row).getByRole("button", { name: "Reagendar" }));

    await user.click(await screen.findByRole("button", { name: "Aplicar" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Atividade reagendada"));
    expect(activitiesBuilder.update).toHaveBeenCalledWith({ due_at: expect.any(String) });
    expect(activitiesBuilder.eq).toHaveBeenCalledWith("id", "a1");
  });

  it("abre o formulário de nova atividade e valida o título obrigatório", async () => {
    const activitiesBuilder = createQueryBuilder(ok([]));
    vi.mocked(supabase.from).mockImplementation(
      asFromMock((table: string) =>
        table === "activities" ? activitiesBuilder : createQueryBuilder(ok([])),
      ),
    );
    const user = userEvent.setup();
    renderWithQueryClient(<ActivitiesPage />);

    await screen.findByText("Nada atrasado");
    await user.click(screen.getByRole("button", { name: /Nova atividade/ }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Criar atividade" }));

    expect(await screen.findByText("Título é obrigatório")).toBeInTheDocument();
    expect(activitiesBuilder.insert).not.toHaveBeenCalled();
  });

  it("cria uma nova atividade com sucesso e invalida a lista", async () => {
    const activitiesBuilder = createQueryBuilder(ok([]));
    vi.mocked(supabase.from).mockImplementation(
      asFromMock((table: string) =>
        table === "activities" ? activitiesBuilder : createQueryBuilder(ok([])),
      ),
    );
    const user = userEvent.setup();
    renderWithQueryClient(<ActivitiesPage />);

    await screen.findByText("Nada atrasado");
    await user.click(screen.getByRole("button", { name: /Nova atividade/ }));
    await screen.findByRole("dialog");

    await user.type(screen.getByLabelText("Título *"), "Follow-up com cliente");
    await user.click(screen.getByRole("button", { name: "Criar atividade" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Atividade criada"));
    expect(activitiesBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: "t1",
        type: "task",
        title: "Follow-up com cliente",
        contact_id: null,
        deal_id: null,
        owner_id: "u1",
      }),
    );
  });
});
