import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { renderWithQueryClient } from "@/test/render";
import {
  asFromMock,
  createFromByTable,
  createPendingQueryBuilder,
  fail,
  ok,
  type QueryResult,
} from "@/test/supabase-mock";
import type { HitlDecisionRow, StageAdvanceRow } from "@/hooks/use-decision-queue";
import { Route } from "./_app.decisions";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { routerOverrides } = await import("@/test/router-mocks");
  return { ...actual, ...routerOverrides() };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const DecisionsPage = Route.options.component!;

const DECISION_ROW: HitlDecisionRow = {
  id: "dec-1",
  tenant_id: "t1",
  type: "follow_up_suggestion",
  priority: "critical",
  category: "follow_up",
  title: "Recontatar João",
  description: null,
  reasoning: "Sem resposta há 3 dias",
  deal_id: null,
  contact_id: "c1",
  activity_id: null,
  suggested_action: {},
  alternative_actions: [],
  status: "pending",
  created_at: "2026-07-01T10:00:00.000Z",
  expires_at: null,
  snooze_until: null,
  deal: null,
  contact: { id: "c1", name: "João" },
  activity: null,
};

const ADVANCE_ROW: StageAdvanceRow = {
  id: "adv-1",
  tenant_id: "t1",
  deal_id: "d1",
  conversation_id: null,
  current_stage_id: "stage-1",
  suggested_stage_id: "stage-2",
  confidence: 0.5,
  reason: "Contato confirmou orçamento aprovado",
  criteria_evaluation: [],
  status: "pending",
  created_at: "2026-07-01T09:00:00.000Z",
  expires_at: "2026-07-02T09:00:00.000Z",
  deal: { id: "d1", title: "Negócio Y", board_id: "b1", contact: { id: "c2", name: "Maria" } },
};

const BOARD_STAGES = [
  { id: "stage-1", name: "Qualificação", position: 1 },
  { id: "stage-2", name: "Proposta", position: 2 },
  { id: "stage-3", name: "Fechamento", position: 3 },
];

function mockSupabaseTables(overrides: Partial<Record<string, QueryResult>> = {}) {
  vi.mocked(supabase.from).mockImplementation(
    createFromByTable({
      hitl_decisions: ok([]),
      ai_pending_stage_advances: ok([]),
      board_stages: ok(BOARD_STAGES),
      ...overrides,
    }),
  );
}

describe("head() da rota de decisões", () => {
  it("define título e descrição de SEO", async () => {
    const head = await Route.options.head?.({} as never);
    const titleMeta = head?.meta?.find((m) => m && "title" in m);
    expect(titleMeta).toMatchObject({ title: "Decisões" });
    expect(head?.links?.some((l) => l && "rel" in l && l.rel === "canonical")).toBe(true);
  });
});

describe("página de decisões (/_app/decisions)", () => {
  beforeEach(() => {
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it("clicar em 'Tentar novamente' no estado de erro dispara um novo fetch", async () => {
    mockSupabaseTables({ hitl_decisions: fail("timeout ao buscar decisões") });
    const user = userEvent.setup();
    renderWithQueryClient(<DecisionsPage />);

    await screen.findByText("Erro ao carregar");
    const callsBefore = vi.mocked(supabase.from).mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));

    await waitFor(() =>
      expect(vi.mocked(supabase.from).mock.calls.length).toBeGreaterThan(callsBefore),
    );
  });

  it("mostra skeletons enquanto a fila carrega", () => {
    vi.mocked(supabase.from).mockImplementation(
      asFromMock((table: string) =>
        table === "board_stages" ? createPendingQueryBuilder() : createPendingQueryBuilder(),
      ),
    );
    const { container } = renderWithQueryClient(<DecisionsPage />);

    expect(screen.getByRole("heading", { name: "Decisões" })).toBeInTheDocument();
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });

  it("mostra estado de erro com opção de tentar novamente quando uma das duas queries falha", async () => {
    mockSupabaseTables({ hitl_decisions: fail("timeout ao buscar decisões") });
    renderWithQueryClient(<DecisionsPage />);

    expect(await screen.findByText("Erro ao carregar")).toBeInTheDocument();
    expect(screen.getByText("timeout ao buscar decisões")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tentar novamente" })).toBeInTheDocument();
  });

  it("mostra estado vazio quando não há decisões nem avanços pendentes", async () => {
    mockSupabaseTables();
    renderWithQueryClient(<DecisionsPage />);

    expect(await screen.findByText("Nenhuma decisão pendente")).toBeInTheDocument();
  });

  it("lista a fila combinada ordenada por prioridade (crítica antes de alta) e mostra contexto/confiança", async () => {
    mockSupabaseTables({
      hitl_decisions: ok([DECISION_ROW]),
      ai_pending_stage_advances: ok([ADVANCE_ROW]), // confidence 0.5 -> prioridade derivada 'high'
    });
    renderWithQueryClient(<DecisionsPage />);

    await screen.findByText("Recontatar João");
    expect(screen.getByText("Contato confirmou orçamento aprovado")).toBeInTheDocument();
    expect(screen.getByText("Confiança: 50%")).toBeInTheDocument();
    expect(screen.getByText("João")).toBeInTheDocument();
    expect(screen.getByText("Maria")).toBeInTheDocument();
    expect(screen.getByText("Negócio Y")).toBeInTheDocument();

    // Ordem no DOM: crítica (decision) antes de alta (advance derivada de confidence 0.5).
    const html = document.body.innerHTML;
    expect(html.indexOf("Recontatar João")).toBeLessThan(
      html.indexOf("Contato confirmou orçamento aprovado"),
    );
  });

  describe("rejeitar — motivo obrigatório validado no client antes de chamar a RPC", () => {
    it("submit vazio não chama a RPC e mostra erro de validação", async () => {
      mockSupabaseTables({ hitl_decisions: ok([DECISION_ROW]) });
      const user = userEvent.setup();
      renderWithQueryClient(<DecisionsPage />);

      await screen.findByText("Recontatar João");
      await user.click(screen.getByRole("button", { name: "Rejeitar" }));

      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: "Rejeitar" }));

      expect(await within(dialog).findByText("Motivo é obrigatório")).toBeInTheDocument();
      expect(supabase.rpc).not.toHaveBeenCalled();
    });

    it("motivo em branco (só espaços) também é rejeitado pelo client", async () => {
      mockSupabaseTables({ hitl_decisions: ok([DECISION_ROW]) });
      const user = userEvent.setup();
      renderWithQueryClient(<DecisionsPage />);

      await screen.findByText("Recontatar João");
      await user.click(screen.getByRole("button", { name: "Rejeitar" }));
      const dialog = await screen.findByRole("dialog");

      await user.type(within(dialog).getByLabelText("Motivo *"), "   ");
      await user.click(within(dialog).getByRole("button", { name: "Rejeitar" }));

      expect(await within(dialog).findByText("Motivo é obrigatório")).toBeInTheDocument();
      expect(supabase.rpc).not.toHaveBeenCalled();
    });

    it("com motivo preenchido, chama resolve_hitl_decision com o reason e mostra toast de sucesso", async () => {
      mockSupabaseTables({ hitl_decisions: ok([DECISION_ROW]) });
      vi.mocked(supabase.rpc).mockResolvedValue({ data: { success: true }, error: null } as never);
      const user = userEvent.setup();
      renderWithQueryClient(<DecisionsPage />);

      await screen.findByText("Recontatar João");
      await user.click(screen.getByRole("button", { name: "Rejeitar" }));
      const dialog = await screen.findByRole("dialog");

      await user.type(
        within(dialog).getByLabelText("Motivo *"),
        "Contato pediu para não ser mais contatado",
      );
      await user.click(within(dialog).getByRole("button", { name: "Rejeitar" }));

      await waitFor(() =>
        expect(supabase.rpc).toHaveBeenCalledWith("resolve_hitl_decision", {
          p_decision_id: "dec-1",
          p_action: "reject",
          p_reason: "Contato pediu para não ser mais contatado",
          p_snooze_until: undefined,
          p_modifications: null,
        }),
      );
      expect(toast.success).toHaveBeenCalledWith("Decisão rejeitada");
    });
  });

  describe("aprovar — chama a RPC certa com os parâmetros certos", () => {
    it("hitl_decisions: aprovar chama resolve_hitl_decision com action='approve'", async () => {
      mockSupabaseTables({ hitl_decisions: ok([DECISION_ROW]) });
      vi.mocked(supabase.rpc).mockResolvedValue({ data: { success: true }, error: null } as never);
      const user = userEvent.setup();
      renderWithQueryClient(<DecisionsPage />);

      await screen.findByText("Recontatar João");
      await user.click(screen.getByRole("button", { name: "Aprovar" }));

      await waitFor(() =>
        expect(supabase.rpc).toHaveBeenCalledWith("resolve_hitl_decision", {
          p_decision_id: "dec-1",
          p_action: "approve",
          p_reason: undefined,
          p_snooze_until: undefined,
          p_modifications: null,
        }),
      );
      expect(toast.success).toHaveBeenCalledWith("Decisão aprovada");
    });

    it("ai_pending_stage_advances: aprovar direto chama resolve_pending_stage_advance sem p_modifications", async () => {
      mockSupabaseTables({ ai_pending_stage_advances: ok([ADVANCE_ROW]) });
      vi.mocked(supabase.rpc).mockResolvedValue({ data: { success: true }, error: null } as never);
      const user = userEvent.setup();
      renderWithQueryClient(<DecisionsPage />);

      await screen.findByText("Contato confirmou orçamento aprovado");
      await user.click(screen.getByRole("button", { name: "Aprovar" }));

      await waitFor(() =>
        expect(supabase.rpc).toHaveBeenCalledWith("resolve_pending_stage_advance", {
          p_advance_id: "adv-1",
          p_action: "approve",
          p_reason: undefined,
          p_modifications: null,
        }),
      );
      expect(toast.success).toHaveBeenCalledWith("Avanço de estágio aprovado");
    });

    it("editar antes de aprovar: troca o estágio sugerido e aprova com p_modifications.suggested_stage_id", async () => {
      mockSupabaseTables({ ai_pending_stage_advances: ok([ADVANCE_ROW]) });
      vi.mocked(supabase.rpc).mockResolvedValue({ data: { success: true }, error: null } as never);
      const user = userEvent.setup();
      renderWithQueryClient(<DecisionsPage />);

      await screen.findByText("Contato confirmou orçamento aprovado");
      await user.click(screen.getByRole("button", { name: "Editar antes de aprovar" }));

      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("combobox"));
      await user.click(await screen.findByRole("option", { name: "Fechamento" }));
      await user.click(within(dialog).getByRole("button", { name: "Aprovar com este estágio" }));

      await waitFor(() =>
        expect(supabase.rpc).toHaveBeenCalledWith("resolve_pending_stage_advance", {
          p_advance_id: "adv-1",
          p_action: "approve",
          p_reason: undefined,
          p_modifications: { suggested_stage_id: "stage-3" },
        }),
      );
    });
  });

  describe("adiar (snooze) — só disponível para hitl_decisions", () => {
    it("chama resolve_hitl_decision com action='snooze' e um p_snooze_until no futuro", async () => {
      mockSupabaseTables({ hitl_decisions: ok([DECISION_ROW]) });
      vi.mocked(supabase.rpc).mockResolvedValue({ data: { success: true }, error: null } as never);
      const user = userEvent.setup();
      renderWithQueryClient(<DecisionsPage />);

      await screen.findByText("Recontatar João");
      await user.click(screen.getByRole("button", { name: "Adiar" }));

      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: "Adiar" }));

      await waitFor(() => expect(supabase.rpc).toHaveBeenCalled());
      const call = vi.mocked(supabase.rpc).mock.calls[0];
      expect(call[0]).toBe("resolve_hitl_decision");
      const args = call[1] as { p_action: string; p_snooze_until: string };
      expect(args.p_action).toBe("snooze");
      expect(new Date(args.p_snooze_until).getTime()).toBeGreaterThan(Date.now());
      expect(toast.success).toHaveBeenCalledWith("Decisão adiada");
    });

    it("ai_pending_stage_advances não tem botão Adiar (snooze é só para hitl_decisions)", async () => {
      mockSupabaseTables({ ai_pending_stage_advances: ok([ADVANCE_ROW]) });
      renderWithQueryClient(<DecisionsPage />);

      await screen.findByText("Contato confirmou orçamento aprovado");
      expect(screen.queryByRole("button", { name: "Adiar" })).not.toBeInTheDocument();
    });
  });

  it("propaga erro da RPC como toast (ex.: guarda otimista de stage mudado)", async () => {
    mockSupabaseTables({ ai_pending_stage_advances: ok([ADVANCE_ROW]) });
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: null,
      error: { message: "Deal stage mudou desde a sugestão -- recarregue" },
    } as never);
    const user = userEvent.setup();
    renderWithQueryClient(<DecisionsPage />);

    await screen.findByText("Contato confirmou orçamento aprovado");
    await user.click(screen.getByRole("button", { name: "Aprovar" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Deal stage mudou desde a sugestão -- recarregue"),
    );
  });

  describe("rejeitar avanço de estágio (ai_pending_stage_advances)", () => {
    it("rejeita chamando resolve_pending_stage_advance com action='reject' e o motivo", async () => {
      mockSupabaseTables({ ai_pending_stage_advances: ok([ADVANCE_ROW]) });
      vi.mocked(supabase.rpc).mockResolvedValue({ data: { success: true }, error: null } as never);
      const user = userEvent.setup();
      renderWithQueryClient(<DecisionsPage />);

      await screen.findByText("Contato confirmou orçamento aprovado");
      await user.click(screen.getByRole("button", { name: "Rejeitar" }));

      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getByLabelText("Motivo *"), "Estágio incorreto");
      await user.click(within(dialog).getByRole("button", { name: "Rejeitar" }));

      await waitFor(() =>
        expect(supabase.rpc).toHaveBeenCalledWith("resolve_pending_stage_advance", {
          p_advance_id: "adv-1",
          p_action: "reject",
          p_reason: "Estágio incorreto",
          p_modifications: null,
        }),
      );
      expect(toast.success).toHaveBeenCalledWith("Avanço de estágio rejeitado");
    });

    it("mostra toast de erro quando a rejeição do avanço de estágio falha na RPC", async () => {
      mockSupabaseTables({ ai_pending_stage_advances: ok([ADVANCE_ROW]) });
      vi.mocked(supabase.rpc).mockResolvedValue({
        data: null,
        error: { message: "falha ao rejeitar avanço" },
      } as never);
      const user = userEvent.setup();
      renderWithQueryClient(<DecisionsPage />);

      await screen.findByText("Contato confirmou orçamento aprovado");
      await user.click(screen.getByRole("button", { name: "Rejeitar" }));

      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getByLabelText("Motivo *"), "Estágio incorreto");
      await user.click(within(dialog).getByRole("button", { name: "Rejeitar" }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("falha ao rejeitar avanço"));
    });
  });

  describe("erros de RPC nas ações de hitl_decisions (além do caso já coberto de approve em stage advance)", () => {
    it("mostra toast de erro quando aprovar uma hitl_decision falha na RPC", async () => {
      mockSupabaseTables({ hitl_decisions: ok([DECISION_ROW]) });
      vi.mocked(supabase.rpc).mockResolvedValue({
        data: null,
        error: { message: "falha ao aprovar decisão" },
      } as never);
      const user = userEvent.setup();
      renderWithQueryClient(<DecisionsPage />);

      await screen.findByText("Recontatar João");
      await user.click(screen.getByRole("button", { name: "Aprovar" }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("falha ao aprovar decisão"));
    });

    it("mostra toast de erro quando rejeitar uma hitl_decision falha na RPC", async () => {
      mockSupabaseTables({ hitl_decisions: ok([DECISION_ROW]) });
      vi.mocked(supabase.rpc).mockResolvedValue({
        data: null,
        error: { message: "falha ao rejeitar decisão" },
      } as never);
      const user = userEvent.setup();
      renderWithQueryClient(<DecisionsPage />);

      await screen.findByText("Recontatar João");
      await user.click(screen.getByRole("button", { name: "Rejeitar" }));
      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getByLabelText("Motivo *"), "Não se aplica");
      await user.click(within(dialog).getByRole("button", { name: "Rejeitar" }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("falha ao rejeitar decisão"));
    });

    it("mostra toast de erro quando adiar uma hitl_decision falha na RPC", async () => {
      mockSupabaseTables({ hitl_decisions: ok([DECISION_ROW]) });
      vi.mocked(supabase.rpc).mockResolvedValue({
        data: null,
        error: { message: "falha ao adiar decisão" },
      } as never);
      const user = userEvent.setup();
      renderWithQueryClient(<DecisionsPage />);

      await screen.findByText("Recontatar João");
      await user.click(screen.getByRole("button", { name: "Adiar" }));
      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: "Adiar" }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("falha ao adiar decisão"));
    });
  });

  describe("fechar diálogos sem confirmar a ação", () => {
    it("EditStageDialog: 'Cancelar' fecha sem aprovar", async () => {
      mockSupabaseTables({ ai_pending_stage_advances: ok([ADVANCE_ROW]) });
      const user = userEvent.setup();
      renderWithQueryClient(<DecisionsPage />);

      await screen.findByText("Contato confirmou orçamento aprovado");
      await user.click(screen.getByRole("button", { name: "Editar antes de aprovar" }));
      const dialog = await screen.findByRole("dialog");

      await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(supabase.rpc).not.toHaveBeenCalled();
    });

    it("SnoozeDialog: 'Cancelar' fecha sem adiar", async () => {
      mockSupabaseTables({ hitl_decisions: ok([DECISION_ROW]) });
      const user = userEvent.setup();
      renderWithQueryClient(<DecisionsPage />);

      await screen.findByText("Recontatar João");
      await user.click(screen.getByRole("button", { name: "Adiar" }));
      const dialog = await screen.findByRole("dialog");

      await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(supabase.rpc).not.toHaveBeenCalled();
    });

    it("RejectDialog: 'Cancelar' fecha sem rejeitar", async () => {
      mockSupabaseTables({ hitl_decisions: ok([DECISION_ROW]) });
      const user = userEvent.setup();
      renderWithQueryClient(<DecisionsPage />);

      await screen.findByText("Recontatar João");
      await user.click(screen.getByRole("button", { name: "Rejeitar" }));
      const dialog = await screen.findByRole("dialog");

      await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(supabase.rpc).not.toHaveBeenCalled();
    });

    it("RejectDialog: pressionar Escape fecha e reseta o formulário", async () => {
      mockSupabaseTables({ hitl_decisions: ok([DECISION_ROW]) });
      const user = userEvent.setup();
      renderWithQueryClient(<DecisionsPage />);

      await screen.findByText("Recontatar João");
      await user.click(screen.getByRole("button", { name: "Rejeitar" }));
      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getByLabelText("Motivo *"), "rascunho não enviado");

      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

      // Reabre e confirma que o motivo foi resetado (reset() disparado pelo onOpenChange).
      await user.click(screen.getByRole("button", { name: "Rejeitar" }));
      const reopened = await screen.findByRole("dialog");
      expect(within(reopened).getByLabelText("Motivo *")).toHaveValue("");
    });
  });

  describe("hitl_decisions com deal/atividade e fallback de descrição", () => {
    it("mostra o negócio e a atividade relacionados quando presentes", async () => {
      mockSupabaseTables({
        hitl_decisions: ok([
          {
            ...DECISION_ROW,
            contact: null,
            deal: { id: "d9", title: "Negócio da decisão" },
            activity: { id: "act-1", title: "Ligação de follow-up" },
          },
        ]),
      });
      renderWithQueryClient(<DecisionsPage />);

      await screen.findByText("Recontatar João");
      expect(screen.getByText("Negócio da decisão")).toBeInTheDocument();
      expect(screen.getByText("Ligação de follow-up")).toBeInTheDocument();
    });

    it("não renderiza a linha de contexto quando contato, negócio e atividade estão todos ausentes", async () => {
      mockSupabaseTables({
        hitl_decisions: ok([{ ...DECISION_ROW, contact: null, deal: null, activity: null }]),
      });
      renderWithQueryClient(<DecisionsPage />);

      await screen.findByText("Recontatar João");
      expect(screen.queryByText("João")).not.toBeInTheDocument();
    });

    it("usa 'description' como fallback quando 'reasoning' está ausente", async () => {
      mockSupabaseTables({
        hitl_decisions: ok([
          { ...DECISION_ROW, reasoning: null, description: "Descrição alternativa da IA" },
        ]),
      });
      renderWithQueryClient(<DecisionsPage />);

      await screen.findByText("Recontatar João");
      expect(screen.getByText("Descrição alternativa da IA")).toBeInTheDocument();
    });

    it("não renderiza parágrafo de razão quando reasoning e description estão ausentes", async () => {
      mockSupabaseTables({
        hitl_decisions: ok([{ ...DECISION_ROW, reasoning: null, description: null }]),
      });
      renderWithQueryClient(<DecisionsPage />);

      await screen.findByText("Recontatar João");
      expect(screen.queryByText("Sem resposta há 3 dias")).not.toBeInTheDocument();
    });
  });
});
