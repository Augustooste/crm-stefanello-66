import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UseQueryResult } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { renderWithQueryClient } from "@/test/render";
import {
  createFromByTable,
  createQueryBuilder,
  ok,
  fail,
  type QueryResult,
} from "@/test/supabase-mock";
import { useCurrentProfile, type CurrentProfile } from "@/lib/api/session";
import type { NurtureEnrollmentRow, NurtureSequenceRow } from "@/hooks/use-nurture";
import { Route } from "./_app.nurture";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

vi.mock("@/lib/api/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/session")>();
  return { ...actual, useCurrentProfile: vi.fn() };
});

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const NurturePage = Route.options.component!;

function mockProfile(profile: CurrentProfile) {
  vi.mocked(useCurrentProfile).mockReturnValue({
    data: profile,
    isLoading: false,
  } as UseQueryResult<CurrentProfile | null, Error>);
}

function mockNurture(overrides: Partial<Record<string, QueryResult>> = {}) {
  vi.mocked(supabase.from).mockImplementation(
    createFromByTable({
      nurture_sequences: ok([]),
      nurture_enrollments: ok([]),
      nurture_execution_history: ok([]),
      boards: ok({ id: "board-1" }),
      board_stages: ok([{ id: "stage-1", name: "Qualificação" }]),
      nurture_steps: ok(null),
      ...overrides,
    }),
  );
}

const MANUAL_SEQUENCE: NurtureSequenceRow = {
  id: "seq-manual",
  tenant_id: "t1",
  name: "Onboarding",
  description: null,
  channel_id: null,
  trigger_type: "manual",
  trigger_stage_id: null,
  stagnant_days: null,
  periodic_days: null,
  notify_owner: false,
  is_active: true,
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
  nurture_steps: [
    {
      id: "step-1",
      sequence_id: "seq-manual",
      step_number: 1,
      delay_hours: 24,
      message_template: "Olá {{nome}}, tudo bem?",
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
  ],
};

const ACTIVE_ENROLLMENT: NurtureEnrollmentRow = {
  id: "enr-active",
  tenant_id: "t1",
  sequence_id: "seq-manual",
  deal_id: null,
  contact_id: "c1",
  current_step: 1,
  status: "active",
  enrolled_at: "2026-07-05T00:00:00.000Z",
  next_send_at: "2026-07-06T00:00:00.000Z",
  completed_at: null,
  updated_at: "2026-07-05T00:00:00.000Z",
  contact: { id: "c1", name: "Ana Souza" },
  deal: null,
};

const PAUSED_ENROLLMENT: NurtureEnrollmentRow = {
  ...ACTIVE_ENROLLMENT,
  id: "enr-paused",
  contact_id: "c2",
  status: "paused",
  contact: { id: "c2", name: "Bruno Lima" },
};

const INACTIVE_SEQUENCE: NurtureSequenceRow = {
  ...MANUAL_SEQUENCE,
  id: "seq-inactive",
  name: "Reativação antiga",
  is_active: false,
};

const NO_STEPS_SEQUENCE: NurtureSequenceRow = {
  ...MANUAL_SEQUENCE,
  id: "seq-no-steps",
  name: "Sequência vazia",
  nurture_steps: [],
};

const STAGNANT_SEQUENCE: NurtureSequenceRow = {
  ...MANUAL_SEQUENCE,
  id: "seq-stagnant",
  name: "Reengajar parados",
  trigger_type: "stagnant",
  trigger_stage_id: "stage-1",
  stagnant_days: 7,
};

const ENROLLMENT_WITH_DEAL: NurtureEnrollmentRow = {
  ...ACTIVE_ENROLLMENT,
  id: "enr-with-deal",
  deal_id: "d1",
  deal: { id: "d1", title: "Negócio da Ana" },
};

const SENDING_ENROLLMENT: NurtureEnrollmentRow = {
  ...ACTIVE_ENROLLMENT,
  id: "enr-sending",
  status: "sending",
};

describe("head() da rota de nurture", () => {
  it("define título e descrição de SEO", async () => {
    const head = await Route.options.head?.({} as never);
    const titleMeta = head?.meta?.find((m) => m && "title" in m);
    expect(titleMeta).toMatchObject({ title: "Acompanhamento automático" });
    const descriptionMeta = head?.meta?.find((m) => m && "name" in m && m.name === "description");
    expect(descriptionMeta).toMatchObject({
      content: "Sequências automáticas de nutrição e inscrições de contatos.",
    });
    expect(head?.links?.some((l) => l && "rel" in l && l.rel === "canonical")).toBe(true);
  });
});

describe("página de nurture (/_app/nurture)", () => {
  beforeEach(() => {
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
    vi.mocked(supabase.rpc).mockReset();
  });

  it("mostra estado de erro com opção de tentar novamente quando a query falha", async () => {
    mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
    mockNurture({ nurture_sequences: fail("timeout ao buscar sequências") });
    renderWithQueryClient(<NurturePage />);

    expect(await screen.findByText("Erro ao carregar")).toBeInTheDocument();
    expect(screen.getByText("timeout ao buscar sequências")).toBeInTheDocument();
  });

  it("clicar em 'Tentar novamente' no estado de erro dispara um novo fetch", async () => {
    mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
    mockNurture({ nurture_sequences: fail("timeout ao buscar sequências") });
    const user = userEvent.setup();
    renderWithQueryClient(<NurturePage />);

    await screen.findByText("Erro ao carregar");
    const callsBefore = vi.mocked(supabase.from).mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));

    await waitFor(() =>
      expect(vi.mocked(supabase.from).mock.calls.length).toBeGreaterThan(callsBefore),
    );
  });

  it("mostra badge 'Inativa' para sequência desativada", async () => {
    mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
    mockNurture({ nurture_sequences: ok([INACTIVE_SEQUENCE]) });
    renderWithQueryClient(<NurturePage />);

    await screen.findByText("Reativação antiga");
    expect(screen.getByText("Inativa")).toBeInTheDocument();
  });

  it("quando não há sequências, mostra estado vazio", async () => {
    mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
    mockNurture();
    renderWithQueryClient(<NurturePage />);

    expect(await screen.findByText("Nenhuma sequência de acompanhamento")).toBeInTheDocument();
  });

  it("lista a sequência com contagem de passos e de inscrições ativas", async () => {
    mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
    mockNurture({
      nurture_sequences: ok([MANUAL_SEQUENCE]),
      nurture_enrollments: ok([ACTIVE_ENROLLMENT]),
    });
    renderWithQueryClient(<NurturePage />);

    expect(await screen.findByText("Onboarding")).toBeInTheDocument();
    expect(screen.getByText("1 passo(s) · 1 inscrição(ões) ativa(s)")).toBeInTheDocument();
  });

  describe("ações de escrita escondidas de não-admin (mesmo padrão do /templates)", () => {
    it("não-admin não vê 'Nova sequência' nem 'Editar'", async () => {
      mockProfile({ id: "u2", tenant_id: "t1", name: "Bia", role: "agent" });
      mockNurture({ nurture_sequences: ok([MANUAL_SEQUENCE]) });
      renderWithQueryClient(<NurturePage />);

      await screen.findByText("Onboarding");
      expect(screen.queryByRole("button", { name: "Nova sequência" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Editar" })).not.toBeInTheDocument();
    });

    it("admin vê 'Nova sequência' e 'Editar'", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockNurture({ nurture_sequences: ok([MANUAL_SEQUENCE]) });
      renderWithQueryClient(<NurturePage />);

      await screen.findByText("Onboarding");
      expect(screen.getByRole("button", { name: "Nova sequência" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Editar" })).toBeInTheDocument();
    });
  });

  describe("editar sequência existente", () => {
    it("abre o diálogo pré-preenchido, salva e mostra toast de sucesso", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      const sequencesBuilder = createQueryBuilder(ok([MANUAL_SEQUENCE]));
      vi.mocked(supabase.from).mockImplementation((table: string) =>
        table === "nurture_sequences"
          ? sequencesBuilder
          : createFromByTable({
              nurture_enrollments: ok([]),
              boards: ok({ id: "board-1" }),
              board_stages: ok([{ id: "stage-1", name: "Qualificação" }]),
            })(table),
      );
      const user = userEvent.setup();
      renderWithQueryClient(<NurturePage />);

      await screen.findByText("Onboarding");
      await user.click(screen.getByRole("button", { name: "Editar" }));

      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByLabelText("Nome *")).toHaveValue("Onboarding");

      await user.clear(within(dialog).getByLabelText("Nome *"));
      await user.type(within(dialog).getByLabelText("Nome *"), "Onboarding revisado");
      await user.click(within(dialog).getByRole("button", { name: "Salvar" }));

      await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Sequência atualizada"));
      expect(sequencesBuilder.update).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Onboarding revisado", is_active: true }),
      );
      expect(sequencesBuilder.eq).toHaveBeenCalledWith("id", "seq-manual");
    });

    it("pré-preenche dias parado ao editar uma sequência com gatilho estagnado", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockNurture({ nurture_sequences: ok([STAGNANT_SEQUENCE]) });
      const user = userEvent.setup();
      renderWithQueryClient(<NurturePage />);

      await screen.findByText("Reengajar parados");
      await user.click(screen.getByRole("button", { name: "Editar" }));

      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByLabelText("Dias parado *")).toHaveValue(7);
    });

    it("mostra toast de erro quando salvar a edição falha no backend", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      let sequencesCall = 0;
      vi.mocked(supabase.from).mockImplementation((table: string) => {
        if (table === "nurture_sequences") {
          sequencesCall += 1;
          return createQueryBuilder(
            sequencesCall === 1 ? ok([MANUAL_SEQUENCE]) : fail("falha ao salvar sequência"),
          ) as unknown as ReturnType<typeof supabase.from>;
        }
        return createFromByTable({
          nurture_enrollments: ok([]),
          boards: ok({ id: "board-1" }),
          board_stages: ok([{ id: "stage-1", name: "Qualificação" }]),
        })(table) as unknown as ReturnType<typeof supabase.from>;
      });
      const user = userEvent.setup();
      renderWithQueryClient(<NurturePage />);

      await screen.findByText("Onboarding");
      await user.click(screen.getByRole("button", { name: "Editar" }));
      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: "Salvar" }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("falha ao salvar sequência"));
    });
  });

  describe("detalhe da sequência: passos e inscrições", () => {
    it("ao selecionar a sequência, mostra o passo configurado e a inscrição ativa", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockNurture({
        nurture_sequences: ok([MANUAL_SEQUENCE]),
        nurture_enrollments: ok([ACTIVE_ENROLLMENT]),
      });
      const user = userEvent.setup();
      renderWithQueryClient(<NurturePage />);

      await user.click(await screen.findByText("Onboarding"));

      expect(await screen.findByText("Olá {{nome}}, tudo bem?")).toBeInTheDocument();
      await user.click(screen.getByRole("tab", { name: "Inscrições (1)" }));
      expect(await screen.findByText("Ana Souza")).toBeInTheDocument();
    });

    it("não-admin não vê 'Adicionar passo' no detalhe", async () => {
      mockProfile({ id: "u2", tenant_id: "t1", name: "Bia", role: "agent" });
      mockNurture({ nurture_sequences: ok([MANUAL_SEQUENCE]) });
      const user = userEvent.setup();
      renderWithQueryClient(<NurturePage />);

      await user.click(await screen.findByText("Onboarding"));
      await screen.findByText("Olá {{nome}}, tudo bem?");
      expect(screen.queryByRole("button", { name: "Adicionar passo" })).not.toBeInTheDocument();
    });

    it("sequência sem passos mostra o estado vazio de passos", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockNurture({ nurture_sequences: ok([NO_STEPS_SEQUENCE]) });
      const user = userEvent.setup();
      renderWithQueryClient(<NurturePage />);

      await user.click(await screen.findByText("Sequência vazia"));

      expect(await screen.findByText("Nenhum passo configurado")).toBeInTheDocument();
    });

    it("sugere o número 1 ao adicionar o primeiro passo de uma sequência vazia", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockNurture({ nurture_sequences: ok([NO_STEPS_SEQUENCE]) });
      const user = userEvent.setup();
      renderWithQueryClient(<NurturePage />);

      await user.click(await screen.findByText("Sequência vazia"));
      await user.click(await screen.findByRole("button", { name: "Adicionar passo" }));

      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByLabelText("Número *")).toHaveValue(1);
    });
  });

  describe("editar e excluir passo existente", () => {
    it("abre o diálogo de edição pré-preenchido e salva com sucesso", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      const stepsBuilder = createQueryBuilder(ok(null));
      vi.mocked(supabase.from).mockImplementation((table: string) =>
        table === "nurture_steps"
          ? stepsBuilder
          : createFromByTable({
              nurture_sequences: ok([MANUAL_SEQUENCE]),
              nurture_enrollments: ok([]),
              boards: ok({ id: "board-1" }),
              board_stages: ok([{ id: "stage-1", name: "Qualificação" }]),
            })(table),
      );
      const user = userEvent.setup();
      renderWithQueryClient(<NurturePage />);

      await user.click(await screen.findByText("Onboarding"));
      await user.click(await screen.findByRole("button", { name: "Editar passo 1" }));

      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByLabelText("Mensagem *")).toHaveValue("Olá {{nome}}, tudo bem?");

      await user.clear(within(dialog).getByLabelText("Mensagem *"));
      await user.type(within(dialog).getByLabelText("Mensagem *"), "Nova mensagem de teste");
      await user.click(within(dialog).getByRole("button", { name: "Salvar" }));

      await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Passo atualizado"));
      expect(stepsBuilder.update).toHaveBeenCalledWith(
        expect.objectContaining({ message_template: "Nova mensagem de teste" }),
      );
      expect(stepsBuilder.eq).toHaveBeenCalledWith("id", "step-1");
    });

    it("mostra toast de erro quando salvar a edição do passo falha no backend", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      // "nurture_steps" só é consultada via `.from()` na própria mutação (os
      // passos vêm embutidos no select de nurture_sequences) -- não precisa de
      // contador por chamada, a 1ª chamada JÁ é o update que deve falhar.
      vi.mocked(supabase.from).mockImplementation(
        createFromByTable({
          nurture_sequences: ok([MANUAL_SEQUENCE]),
          nurture_enrollments: ok([]),
          boards: ok({ id: "board-1" }),
          board_stages: ok([{ id: "stage-1", name: "Qualificação" }]),
          nurture_steps: fail("falha ao salvar passo"),
        }),
      );
      const user = userEvent.setup();
      renderWithQueryClient(<NurturePage />);

      await user.click(await screen.findByText("Onboarding"));
      await user.click(await screen.findByRole("button", { name: "Editar passo 1" }));
      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: "Salvar" }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("falha ao salvar passo"));
    });

    it("exclui o passo após confirmar no alerta", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      const stepsBuilder = createQueryBuilder(ok(null));
      vi.mocked(supabase.from).mockImplementation((table: string) =>
        table === "nurture_steps"
          ? stepsBuilder
          : createFromByTable({
              nurture_sequences: ok([MANUAL_SEQUENCE]),
              nurture_enrollments: ok([]),
              boards: ok({ id: "board-1" }),
              board_stages: ok([{ id: "stage-1", name: "Qualificação" }]),
            })(table),
      );
      const user = userEvent.setup();
      renderWithQueryClient(<NurturePage />);

      await user.click(await screen.findByText("Onboarding"));
      await user.click(await screen.findByRole("button", { name: "Excluir passo 1" }));

      const dialog = await screen.findByRole("alertdialog");
      expect(within(dialog).getByText("Excluir passo")).toBeInTheDocument();
      await user.click(within(dialog).getByRole("button", { name: "Excluir" }));

      await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Passo removido"));
      expect(stepsBuilder.delete).toHaveBeenCalled();
      expect(stepsBuilder.eq).toHaveBeenCalledWith("id", "step-1");
    });

    it("cancela a exclusão do passo sem chamar o backend", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockNurture({ nurture_sequences: ok([MANUAL_SEQUENCE]) });
      const user = userEvent.setup();
      renderWithQueryClient(<NurturePage />);

      await user.click(await screen.findByText("Onboarding"));
      await user.click(await screen.findByRole("button", { name: "Excluir passo 1" }));
      const dialog = await screen.findByRole("alertdialog");

      await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));

      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
      expect(toast.success).not.toHaveBeenCalled();
    });

    it("mostra toast de erro quando excluir o passo falha no backend", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      vi.mocked(supabase.from).mockImplementation(
        createFromByTable({
          nurture_sequences: ok([MANUAL_SEQUENCE]),
          nurture_enrollments: ok([]),
          boards: ok({ id: "board-1" }),
          board_stages: ok([{ id: "stage-1", name: "Qualificação" }]),
          nurture_steps: fail("falha ao excluir passo"),
        }),
      );
      const user = userEvent.setup();
      renderWithQueryClient(<NurturePage />);

      await user.click(await screen.findByText("Onboarding"));
      await user.click(await screen.findByRole("button", { name: "Excluir passo 1" }));
      const dialog = await screen.findByRole("alertdialog");
      await user.click(within(dialog).getByRole("button", { name: "Excluir" }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("falha ao excluir passo"));
    });
  });

  describe("ações de inscrição via RPC (não são admin-only, igual à própria RPC)", () => {
    it("pausar uma inscrição ativa chama a RPC com status 'paused'", async () => {
      mockProfile({ id: "u2", tenant_id: "t1", name: "Bia", role: "agent" });
      mockNurture({
        nurture_sequences: ok([MANUAL_SEQUENCE]),
        nurture_enrollments: ok([ACTIVE_ENROLLMENT]),
      });
      vi.mocked(supabase.rpc).mockResolvedValue({
        data: { status: "paused" },
        error: null,
      } as never);
      const user = userEvent.setup();
      renderWithQueryClient(<NurturePage />);

      await user.click(await screen.findByText("Onboarding"));
      await user.click(screen.getByRole("tab", { name: "Inscrições (1)" }));
      await screen.findByText("Ana Souza");

      await user.click(screen.getByRole("button", { name: "Pausar" }));

      expect(supabase.rpc).toHaveBeenCalledWith("set_nurture_enrollment_status", {
        p_enrollment_id: "enr-active",
        p_status: "paused",
      });
      expect(toast.success).toHaveBeenCalledWith("Inscrição pausada");
    });

    it("uma inscrição pausada mostra 'Reativar', não 'Pausar'", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockNurture({
        nurture_sequences: ok([MANUAL_SEQUENCE]),
        nurture_enrollments: ok([PAUSED_ENROLLMENT]),
      });
      const user = userEvent.setup();
      renderWithQueryClient(<NurturePage />);

      await user.click(await screen.findByText("Onboarding"));
      await user.click(screen.getByRole("tab", { name: "Inscrições (1)" }));

      expect(await screen.findByText("Bruno Lima")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Reativar" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Pausar" })).not.toBeInTheDocument();
    });

    it("cancelar uma inscrição ativa chama a RPC com status 'cancelled'", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockNurture({
        nurture_sequences: ok([MANUAL_SEQUENCE]),
        nurture_enrollments: ok([ACTIVE_ENROLLMENT]),
      });
      vi.mocked(supabase.rpc).mockResolvedValue({
        data: { status: "cancelled" },
        error: null,
      } as never);
      const user = userEvent.setup();
      renderWithQueryClient(<NurturePage />);

      await user.click(await screen.findByText("Onboarding"));
      await user.click(screen.getByRole("tab", { name: "Inscrições (1)" }));
      await screen.findByText("Ana Souza");

      await user.click(screen.getByRole("button", { name: "Cancelar" }));

      expect(supabase.rpc).toHaveBeenCalledWith("set_nurture_enrollment_status", {
        p_enrollment_id: "enr-active",
        p_status: "cancelled",
      });
    });

    it("reativar uma inscrição pausada chama a RPC com status 'active'", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockNurture({
        nurture_sequences: ok([MANUAL_SEQUENCE]),
        nurture_enrollments: ok([PAUSED_ENROLLMENT]),
      });
      vi.mocked(supabase.rpc).mockResolvedValue({
        data: { status: "active" },
        error: null,
      } as never);
      const user = userEvent.setup();
      renderWithQueryClient(<NurturePage />);

      await user.click(await screen.findByText("Onboarding"));
      await user.click(screen.getByRole("tab", { name: "Inscrições (1)" }));
      await screen.findByText("Bruno Lima");

      await user.click(screen.getByRole("button", { name: "Reativar" }));

      expect(supabase.rpc).toHaveBeenCalledWith("set_nurture_enrollment_status", {
        p_enrollment_id: "enr-paused",
        p_status: "active",
      });
      expect(toast.success).toHaveBeenCalledWith("Inscrição reativada");
    });

    it("mostra toast de erro quando alterar o status da inscrição falha na RPC", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockNurture({
        nurture_sequences: ok([MANUAL_SEQUENCE]),
        nurture_enrollments: ok([ACTIVE_ENROLLMENT]),
      });
      vi.mocked(supabase.rpc).mockResolvedValue({
        data: null,
        error: { message: "falha ao atualizar inscrição" },
      } as never);
      const user = userEvent.setup();
      renderWithQueryClient(<NurturePage />);

      await user.click(await screen.findByText("Onboarding"));
      await user.click(screen.getByRole("tab", { name: "Inscrições (1)" }));
      await screen.findByText("Ana Souza");

      await user.click(screen.getByRole("button", { name: "Pausar" }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("falha ao atualizar inscrição"));
    });

    it("mostra o título do negócio vinculado quando a inscrição tem um deal", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockNurture({
        nurture_sequences: ok([MANUAL_SEQUENCE]),
        nurture_enrollments: ok([ENROLLMENT_WITH_DEAL]),
      });
      const user = userEvent.setup();
      renderWithQueryClient(<NurturePage />);

      await user.click(await screen.findByText("Onboarding"));
      await user.click(screen.getByRole("tab", { name: "Inscrições (1)" }));

      expect(await screen.findByText(/Negócio da Ana · Passo 1/)).toBeInTheDocument();
    });

    it("uma inscrição em 'sending' permite cancelar, mas não pausar nem reativar", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockNurture({
        nurture_sequences: ok([MANUAL_SEQUENCE]),
        nurture_enrollments: ok([SENDING_ENROLLMENT]),
      });
      const user = userEvent.setup();
      renderWithQueryClient(<NurturePage />);

      await user.click(await screen.findByText("Onboarding"));
      await user.click(screen.getByRole("tab", { name: "Inscrições (1)" }));
      await screen.findByText("Ana Souza");

      expect(screen.getByRole("button", { name: "Cancelar" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Pausar" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Reativar" })).not.toBeInTheDocument();
    });
  });

  describe("criar sequência — insert direto (sem RPC, ao contrário de templates)", () => {
    it("preenche nome e cria com gatilho manual (sem campos condicionais)", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      const sequencesBuilder = createQueryBuilder(ok([]));
      vi.mocked(supabase.from).mockImplementation((table: string) =>
        table === "nurture_sequences"
          ? sequencesBuilder
          : createFromByTable({
              nurture_enrollments: ok([]),
              boards: ok({ id: "board-1" }),
              board_stages: ok([{ id: "stage-1", name: "Qualificação" }]),
            })(table),
      );
      const user = userEvent.setup();
      renderWithQueryClient(<NurturePage />);

      await screen.findByText("Nenhuma sequência de acompanhamento");
      await user.click(screen.getByRole("button", { name: "Nova sequência" }));

      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getByLabelText("Nome *"), "Pós-venda");
      await user.click(within(dialog).getByRole("button", { name: "Salvar" }));

      expect(sequencesBuilder.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant_id: "t1",
          name: "Pós-venda",
          trigger_type: "manual",
          trigger_stage_id: null,
          stagnant_days: null,
          periodic_days: null,
          notify_owner: false,
        }),
      );
      expect(toast.success).toHaveBeenCalledWith("Sequência criada");
    });

    it("mostra toast de erro quando o tenant_id do perfil ainda não está disponível", async () => {
      mockProfile({
        id: "u1",
        tenant_id: undefined as unknown as string,
        name: "Ana",
        role: "admin",
      });
      mockNurture();
      const user = userEvent.setup();
      renderWithQueryClient(<NurturePage />);

      await screen.findByText("Nenhuma sequência de acompanhamento");
      await user.click(screen.getByRole("button", { name: "Nova sequência" }));
      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getByLabelText("Nome *"), "Pós-venda");
      await user.click(within(dialog).getByRole("button", { name: "Salvar" }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Sessão inválida"));
    });

    it("mostra toast de erro quando criar a sequência falha no backend", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      let sequencesCall = 0;
      vi.mocked(supabase.from).mockImplementation((table: string) => {
        if (table === "nurture_sequences") {
          sequencesCall += 1;
          return createQueryBuilder(
            sequencesCall === 1 ? ok([]) : fail("falha ao criar sequência"),
          ) as unknown as ReturnType<typeof supabase.from>;
        }
        return createFromByTable({
          nurture_enrollments: ok([]),
          boards: ok({ id: "board-1" }),
          board_stages: ok([{ id: "stage-1", name: "Qualificação" }]),
        })(table) as unknown as ReturnType<typeof supabase.from>;
      });
      const user = userEvent.setup();
      renderWithQueryClient(<NurturePage />);

      await screen.findByText("Nenhuma sequência de acompanhamento");
      await user.click(screen.getByRole("button", { name: "Nova sequência" }));
      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getByLabelText("Nome *"), "Pós-venda");
      await user.click(within(dialog).getByRole("button", { name: "Salvar" }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("falha ao criar sequência"));
    });
  });

  describe("validação condicional por tipo de gatilho (superRefine)", () => {
    async function openNewSequenceDialog() {
      const user = userEvent.setup();
      renderWithQueryClient(<NurturePage />);
      await screen.findByText("Nenhuma sequência de acompanhamento");
      await user.click(screen.getByRole("button", { name: "Nova sequência" }));
      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getByLabelText("Nome *"), "Sequência de teste");
      return { user, dialog };
    }

    it("'Mudança de etapa' sem etapa selecionada bloqueia o envio", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockNurture();
      const { user, dialog } = await openNewSequenceDialog();

      await user.click(within(dialog).getByRole("combobox"));
      await user.click(await screen.findByRole("option", { name: "Mudança de etapa" }));
      await user.click(within(dialog).getByRole("button", { name: "Salvar" }));

      expect(
        await within(dialog).findByText("Etapa é obrigatória para este gatilho"),
      ).toBeInTheDocument();
      expect(toast.success).not.toHaveBeenCalled();
    });

    it("'Estagnado' sem etapa nem dias parados bloqueia o envio com os dois erros", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockNurture();
      const { user, dialog } = await openNewSequenceDialog();

      await user.click(within(dialog).getByRole("combobox"));
      await user.click(await screen.findByRole("option", { name: "Estagnado" }));
      await user.click(within(dialog).getByRole("button", { name: "Salvar" }));

      expect(
        await within(dialog).findByText("Etapa é obrigatória para este gatilho"),
      ).toBeInTheDocument();
      expect(within(dialog).getByText("Obrigatório para o gatilho estagnado")).toBeInTheDocument();
      expect(toast.success).not.toHaveBeenCalled();
    });

    it("'Periódico' sem intervalo em dias bloqueia o envio", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockNurture();
      const { user, dialog } = await openNewSequenceDialog();

      await user.click(within(dialog).getByRole("combobox"));
      await user.click(await screen.findByRole("option", { name: "Periódico" }));
      await user.click(within(dialog).getByRole("button", { name: "Salvar" }));

      expect(
        await within(dialog).findByText("Obrigatório para o gatilho periódico"),
      ).toBeInTheDocument();
      expect(toast.success).not.toHaveBeenCalled();
    });

    it("cria com gatilho 'Mudança de etapa' e etapa selecionada com sucesso", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      const sequencesBuilder = createQueryBuilder(ok([]));
      vi.mocked(supabase.from).mockImplementation((table: string) =>
        table === "nurture_sequences"
          ? sequencesBuilder
          : createFromByTable({
              nurture_enrollments: ok([]),
              boards: ok({ id: "board-1" }),
              board_stages: ok([{ id: "stage-1", name: "Qualificação" }]),
            })(table),
      );
      const { user, dialog } = await openNewSequenceDialog();

      await user.click(within(dialog).getByRole("combobox"));
      await user.click(await screen.findByRole("option", { name: "Mudança de etapa" }));
      // Segundo combobox só aparece depois de escolher um gatilho com etapa.
      await user.click(within(dialog).getAllByRole("combobox")[1]!);
      await user.click(await screen.findByRole("option", { name: "Qualificação" }));
      await user.click(within(dialog).getByRole("button", { name: "Salvar" }));

      await waitFor(() =>
        expect(sequencesBuilder.insert).toHaveBeenCalledWith(
          expect.objectContaining({
            trigger_type: "stage_change",
            trigger_stage_id: "stage-1",
          }),
        ),
      );
      expect(toast.success).toHaveBeenCalledWith("Sequência criada");
    });

    it("cria com gatilho 'Periódico' e intervalo em dias preenchido com sucesso", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      const sequencesBuilder = createQueryBuilder(ok([]));
      vi.mocked(supabase.from).mockImplementation((table: string) =>
        table === "nurture_sequences"
          ? sequencesBuilder
          : createFromByTable({
              nurture_enrollments: ok([]),
              boards: ok({ id: "board-1" }),
              board_stages: ok([{ id: "stage-1", name: "Qualificação" }]),
            })(table),
      );
      const { user, dialog } = await openNewSequenceDialog();

      await user.click(within(dialog).getByRole("combobox"));
      await user.click(await screen.findByRole("option", { name: "Periódico" }));
      await user.type(within(dialog).getByLabelText("Intervalo em dias *"), "30");
      await user.click(within(dialog).getByRole("button", { name: "Salvar" }));

      await waitFor(() =>
        expect(sequencesBuilder.insert).toHaveBeenCalledWith(
          expect.objectContaining({ trigger_type: "periodic", periodic_days: 30 }),
        ),
      );
      expect(toast.success).toHaveBeenCalledWith("Sequência criada");
    });

    it("não deixa escolher 'Aniversário', que nenhum código processa", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockNurture();
      const { user, dialog } = await openNewSequenceDialog();

      await user.click(within(dialog).getByRole("combobox"));

      // Continua listado (sequência antiga com esse gatilho ainda precisa
      // aparecer pelo nome na edição), mas não é selecionável.
      const opcao = await screen.findByRole("option", { name: /Aniversário/ });
      expect(opcao).toHaveAttribute("aria-disabled", "true");
    });
  });

  describe("adicionar passo — insert direto em nurture_steps", () => {
    it("admin adiciona um passo com número sugerido e mensagem", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockNurture({ nurture_sequences: ok([MANUAL_SEQUENCE]) });
      const user = userEvent.setup();
      renderWithQueryClient(<NurturePage />);

      await user.click(await screen.findByText("Onboarding"));
      await user.click(await screen.findByRole("button", { name: "Adicionar passo" }));

      const dialog = await screen.findByRole("dialog");
      // Número já vem sugerido como o próximo (existe 1 passo -> sugere 2).
      expect(within(dialog).getByLabelText("Número *")).toHaveValue(2);

      await user.type(within(dialog).getByLabelText("Mensagem *"), "Segunda mensagem");
      await user.click(within(dialog).getByRole("button", { name: "Salvar" }));

      expect(toast.success).toHaveBeenCalledWith("Passo criado");
    });

    it("mostra toast de erro quando criar o passo falha no backend", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      vi.mocked(supabase.from).mockImplementation(
        createFromByTable({
          nurture_sequences: ok([MANUAL_SEQUENCE]),
          nurture_enrollments: ok([]),
          boards: ok({ id: "board-1" }),
          board_stages: ok([{ id: "stage-1", name: "Qualificação" }]),
          nurture_steps: fail("falha ao criar passo"),
        }),
      );
      const user = userEvent.setup();
      renderWithQueryClient(<NurturePage />);

      await user.click(await screen.findByText("Onboarding"));
      await user.click(await screen.findByRole("button", { name: "Adicionar passo" }));
      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getByLabelText("Mensagem *"), "Segunda mensagem");
      await user.click(within(dialog).getByRole("button", { name: "Salvar" }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("falha ao criar passo"));
    });
  });

  it("mantém inscrição concluída visível e mostra execução com data real no histórico", async () => {
    mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
    mockNurture({
      nurture_sequences: ok([MANUAL_SEQUENCE]),
      nurture_enrollments: ok([{ ...ACTIVE_ENROLLMENT, status: "completed", next_send_at: null }]),
      nurture_execution_history: ok([
        {
          id: "exec-1",
          tenant_id: "t1",
          enrollment_id: "enr-active",
          step_number: 1,
          outcome: "sent",
          detail: null,
          executed_at: "2026-10-15T15:00:00.000Z",
        },
      ]),
    });
    const user = userEvent.setup();
    renderWithQueryClient(<NurturePage />);
    await user.click(await screen.findByText("Onboarding"));
    await user.click(screen.getByRole("tab", { name: "Inscrições (1)" }));
    expect(await screen.findByText("Concluída")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pausar" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Histórico" }));
    expect(await screen.findByText("Passo 1: Mensagem enviada")).toBeInTheDocument();
    expect(screen.getByTitle("2026-10-15T15:00:00.000Z")).toHaveAttribute(
      "dateTime",
      "2026-10-15T15:00:00.000Z",
    );
  });

  it("não transforma falha de leitura do histórico em ausência de execuções", async () => {
    mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
    mockNurture({
      nurture_sequences: ok([MANUAL_SEQUENCE]),
      nurture_enrollments: ok([ACTIVE_ENROLLMENT]),
      nurture_execution_history: fail("Histórico indisponível"),
    });
    const user = userEvent.setup();
    renderWithQueryClient(<NurturePage />);
    await user.click(await screen.findByText("Onboarding"));
    await user.click(screen.getByRole("tab", { name: "Inscrições (1)" }));
    await user.click(screen.getByRole("button", { name: "Histórico" }));
    expect(await screen.findByText("Erro ao carregar histórico")).toBeInTheDocument();
    expect(screen.queryByText("Nenhuma execução registrada")).not.toBeInTheDocument();
  });
});
