import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { renderWithQueryClient } from "@/test/render";
import { createFromByTable, ok, fail, type QueryResult } from "@/test/supabase-mock";
import { buildCampaignStats } from "@/hooks/use-template-schedules";
import { AgendamentosTab } from "./AgendamentosTab";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// O diálogo tem teste próprio (NovaCampanhaDialog.test.tsx).
vi.mock("./NovaCampanhaDialog", () => ({
  NovaCampanhaDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="nova-campanha" /> : null,
}));

function mockTables(
  overrides: Partial<Record<string, QueryResult>> = {},
  stats: { schedule_id: string; status: string; total: number }[] = [],
) {
  vi.mocked(supabase.from).mockImplementation(
    createFromByTable({
      template_schedules: ok([]),
      board_stages: ok([{ id: "stage-1", name: "Negociação" }]),
      ...overrides,
    }),
  );
  vi.mocked(supabase.rpc).mockResolvedValue({ data: stats, error: null } as never);
}

const SCHEDULE_PENDING = {
  id: "sched-1",
  tenant_id: "t1",
  template_id: "tpl-1",
  name: "Reativação de inativos",
  channel_id: "ch-1",
  audience_filter: { tags: ["vip"], stage_id: "stage-1" },
  scheduled_for: "2026-08-01T13:00:00.000Z",
  status: "pending",
  created_at: "2026-07-01T00:00:00.000Z",
  template: { name: "Confirmação de pedido" },
};

const SCHEDULE_COMPLETED = {
  id: "sched-2",
  tenant_id: "t1",
  template_id: "tpl-2",
  name: null,
  channel_id: null,
  audience_filter: {},
  scheduled_for: "2026-07-01T13:00:00.000Z",
  status: "completed",
  created_at: "2026-06-01T00:00:00.000Z",
  template: { name: "Boas-vindas" },
};

describe("buildCampaignStats", () => {
  it("agrupa por status: sending conta como pendente, skipped_suppressed como suprimido", () => {
    const stats = buildCampaignStats([
      { schedule_id: "s1", status: "sent", total: 5 },
      { schedule_id: "s1", status: "failed", total: 1 },
      { schedule_id: "s1", status: "skipped_suppressed", total: 2 },
      { schedule_id: "s1", status: "pending", total: 3 },
      { schedule_id: "s1", status: "sending", total: 1 },
    ]);
    expect(stats.get("s1")).toEqual({ total: 12, pending: 4, sent: 5, failed: 1, suppressed: 2 });
  });
});

const jobsStatusMock = vi.fn();
vi.mock("@/lib/api/onboarding", () => ({
  useScheduledJobsStatus: () => jobsStatusMock(),
}));

function jobs(active: boolean, vault_missing: string[] = []) {
  return {
    data: {
      vault_missing,
      jobs: [
        {
          jobname: "template-schedule-runner",
          schedule: "*",
          note: null,
          default_active: true,
          scheduled: true,
          active,
        },
      ],
      total: 1,
      active: active ? 1 : 0,
    },
  };
}

describe("AgendamentosTab — aviso de disparo desligado", () => {
  beforeEach(() => {
    vi.mocked(supabase.rpc).mockReset();
  });

  it("avisa quando a rotina de campanhas não está ativa no banco", async () => {
    jobsStatusMock.mockReturnValue(jobs(false));
    mockTables();
    renderWithQueryClient(<AgendamentosTab />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "disparo automático de campanhas está desligado",
    );
  });

  it("avisa quando falta segredo no Vault mesmo com a rotina ativa", async () => {
    jobsStatusMock.mockReturnValue(jobs(true, ["aceleraflow_project_url"]));
    mockTables();
    renderWithQueryClient(<AgendamentosTab />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("não avisa com a rotina ativa e o Vault completo", async () => {
    jobsStatusMock.mockReturnValue(jobs(true));
    mockTables();
    renderWithQueryClient(<AgendamentosTab />);
    await screen.findByText("Nenhuma campanha ainda");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("AgendamentosTab (aba 'Campanhas' em /templates)", () => {
  beforeEach(() => {
    jobsStatusMock.mockReturnValue({ data: undefined });
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
    vi.mocked(supabase.rpc).mockReset();
  });

  it("mostra estado de erro com opção de tentar novamente quando a query falha", async () => {
    mockTables({ template_schedules: fail("timeout ao buscar campanhas") });
    renderWithQueryClient(<AgendamentosTab />);

    expect(await screen.findByText("Erro ao carregar")).toBeInTheDocument();
    expect(screen.getByText("timeout ao buscar campanhas")).toBeInTheDocument();
  });

  it("estado vazio oferece criar campanha", async () => {
    mockTables();
    const user = userEvent.setup();
    renderWithQueryClient(<AgendamentosTab />);

    expect(await screen.findByText("Nenhuma campanha ainda")).toBeInTheDocument();
    expect(supabase.rpc).not.toHaveBeenCalled();
    await user.click(screen.getAllByRole("button", { name: "Nova campanha" })[0]);
    expect(await screen.findByTestId("nova-campanha")).toBeInTheDocument();
  });

  it("lista campanhas com status, público e contadores agregados no servidor", async () => {
    mockTables({ template_schedules: ok([SCHEDULE_PENDING, SCHEDULE_COMPLETED]) }, [
      { schedule_id: "sched-2", status: "sent", total: 10 },
      { schedule_id: "sched-2", status: "failed", total: 1 },
      { schedule_id: "sched-2", status: "skipped_suppressed", total: 2 },
    ]);
    renderWithQueryClient(<AgendamentosTab />);

    expect(await screen.findByText("Reativação de inativos")).toBeInTheDocument();
    expect(screen.getByText("Modelo: Confirmação de pedido")).toBeInTheDocument();
    expect(screen.getByText("Agendada")).toBeInTheDocument();
    expect(screen.getByText("Etiquetas: vip")).toBeInTheDocument();
    expect(await screen.findByText("Estágio: Negociação")).toBeInTheDocument();
    expect(
      screen.getByText("Público: 0 · Pendentes: 0 · Enviados: 0 · Falhas: 0 · Suprimidos: 0"),
    ).toBeInTheDocument();
    expect(supabase.rpc).toHaveBeenCalledWith("campaign_execution_stats", {
      p_schedule_ids: ["sched-1", "sched-2"],
    });

    // Campanha antiga sem nome cai no nome do modelo; filtro vazio NÃO é "todos".
    expect(screen.getByText("Boas-vindas")).toBeInTheDocument();
    expect(screen.getByText("Concluída")).toBeInTheDocument();
    expect(screen.getByText("Sem público definido")).toBeInTheDocument();
    expect(screen.queryByText("Todos os contatos")).not.toBeInTheDocument();
    expect(
      screen.getByText("Público: 13 · Pendentes: 0 · Enviados: 10 · Falhas: 1 · Suprimidos: 2"),
    ).toBeInTheDocument();
  });

  it("permite cancelar uma campanha agendada", async () => {
    // O mock resolve pelo NOME da tabela (mesmo objeto serve para o select
    // da listagem e para o delete do cancelamento) -- o `count: 1` é lido
    // só pelo delete.
    mockTables({ template_schedules: ok([SCHEDULE_PENDING], { count: 1 }) });
    const user = userEvent.setup();
    renderWithQueryClient(<AgendamentosTab />);

    await screen.findByText("Reativação de inativos");
    const cancelButton = screen.getByRole("button", { name: "Cancelar" });
    expect(cancelButton).toBeEnabled();

    await user.click(cancelButton);

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Campanha cancelada"));
  });

  it("desabilita Cancelar quando a campanha já não está agendada", async () => {
    mockTables({ template_schedules: ok([SCHEDULE_COMPLETED]) });
    renderWithQueryClient(<AgendamentosTab />);

    await screen.findByText("Boas-vindas");
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeDisabled();
  });
});
