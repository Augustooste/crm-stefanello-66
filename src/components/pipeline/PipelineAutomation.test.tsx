import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DealStageHistory } from "@/lib/api/pipeline-automation";
import { renderWithQueryClient } from "@/test/render";
import {
  automationSummary,
  DealAutomationBadges,
  DealAutomationDetails,
  normalizeApproval,
  RuleEditor,
} from "./PipelineAutomation";

const deal = {
  id: "deal-1",
  stage_id: "stage-1",
  automation_mode: "inherit",
  automation_paused_until: null,
  automation_lock_reason: null,
};

const history = (overrides: Partial<DealStageHistory> = {}): DealStageHistory => ({
  id: "history-1",
  deal_id: "deal-1",
  from_stage_id: "stage-0",
  to_stage_id: "stage-1",
  actor_type: "human",
  reason: "Movimento manual no Kanban",
  evidence: null,
  confidence: null,
  decision: null,
  created_at: new Date().toISOString(),
  reversal_of_history_id: null,
  ...overrides,
});

describe("automationSummary", () => {
  const evaluation = (id: string, status: "met" | "unmet") => ({
    id,
    deal_id: "deal-1",
    stage_id: "stage-1",
    criterion_key: id,
    criterion_label: id,
    status,
    confidence: 0.8,
    evidence: "",
    evaluated_at: new Date().toISOString(),
    human_feedback: null,
  });

  it("devolve null quando não há nada de automação a mostrar", () => {
    expect(automationSummary(deal, { evaluations: [] })).toBeNull();
  });

  it("prioriza a aprovação pendente sobre qualquer outro sinal", () => {
    expect(
      automationSummary(
        { ...deal, automation_mode: "paused" },
        {
          evaluations: [evaluation("c1", "unmet")],
          pending: {
            id: "pending-1",
            deal_id: "deal-1",
            current_stage_id: "stage-1",
            suggested_stage_id: "stage-2",
            confidence: 0.8,
            reason: "",
            criteria_evaluation: [],
            status: "pending",
            created_at: new Date().toISOString(),
          },
        },
      ),
    ).toBe("IA: aguardando aprovação");
  });

  it("reconhece pausa por janela de tempo ainda vigente", () => {
    const paused = {
      ...deal,
      automation_paused_until: new Date(Date.now() + 60_000).toISOString(),
    };
    expect(automationSummary(paused, { evaluations: [] })).toBe("IA pausada");
  });

  it("conta só os critérios não cumpridos da etapa atual, com plural correto", () => {
    expect(
      automationSummary(deal, {
        evaluations: [evaluation("c1", "met"), evaluation("c2", "unmet")],
      }),
    ).toBe("IA: 1 pendência");
    expect(
      automationSummary(deal, {
        evaluations: [evaluation("c1", "unmet"), evaluation("c2", "unmet")],
      }),
    ).toBe("IA: 2 pendências");
    expect(automationSummary(deal, { evaluations: [evaluation("c1", "met")] })).toBe(
      "IA: critérios cumpridos",
    );
  });

  it("resume como acompanhamento quando só há histórico ou comando", () => {
    expect(automationSummary(deal, { evaluations: [], latestHistory: history() })).toBe(
      "IA acompanhando",
    );
    expect(
      automationSummary(deal, {
        evaluations: [],
        latestCommand: {
          id: "command-1",
          deal_id: "deal-1",
          status: "blocked",
          decision: "reversal_circuit_breaker",
          confidence: 0.95,
          created_at: new Date().toISOString(),
        },
      }),
    ).toBe("IA acompanhando");
  });

  it("não esconde o negócio avaliado apenas em etapa anterior", () => {
    const outraEtapa = { ...evaluation("c1", "met"), stage_id: "stage-0" };
    expect(automationSummary(deal, { evaluations: [outraEtapa] })).toBe("IA acompanhando");
  });

  it("pausa vence a contagem de pendências quando não há aprovação pendente", () => {
    expect(
      automationSummary(
        { ...deal, automation_mode: "paused" },
        { evaluations: [evaluation("c1", "unmet")] },
      ),
    ).toBe("IA pausada");
  });

  it("trava operacional isolada já conta como pausa", () => {
    expect(
      automationSummary(
        { ...deal, automation_lock_reason: "Circuit breaker" },
        { evaluations: [] },
      ),
    ).toBe("IA pausada");
  });
});

describe("DealAutomationBadges", () => {
  it("mostra progresso, confiança e aprovação pendente no card", () => {
    render(
      <DealAutomationBadges
        deal={deal}
        snapshot={{
          evaluations: [
            {
              id: "evaluation-1",
              deal_id: "deal-1",
              stage_id: "stage-1",
              criterion_key: "criterion_1",
              criterion_label: "Problema identificado",
              status: "met",
              confidence: 0.9,
              evidence: "Lead descreveu o problema.",
              evaluated_at: new Date().toISOString(),
              human_feedback: null,
            },
            {
              id: "evaluation-2",
              deal_id: "deal-1",
              stage_id: "stage-1",
              criterion_key: "criterion_2",
              criterion_label: "Orçamento confirmado",
              status: "unmet",
              confidence: 0.7,
              evidence: "",
              evaluated_at: new Date().toISOString(),
              human_feedback: null,
            },
          ],
          pending: {
            id: "pending-1",
            deal_id: "deal-1",
            current_stage_id: "stage-1",
            suggested_stage_id: "stage-2",
            confidence: 0.8,
            reason: "Aprovação necessária",
            criteria_evaluation: [],
            status: "pending",
            created_at: new Date().toISOString(),
          },
        }}
      />,
    );

    expect(screen.getByText("IA acompanhando")).toBeInTheDocument();
    expect(screen.getByText("1/2 critérios")).toBeInTheDocument();
    expect(screen.getByText("Análise 80% confiável")).toBeInTheDocument();
    expect(screen.getByText("Aguardando aprovação")).toBeInTheDocument();
  });

  it("mostra pausa e conflito operacional", () => {
    render(
      <DealAutomationBadges
        deal={{
          ...deal,
          automation_mode: "paused",
          automation_lock_reason: "Circuit breaker",
        }}
        snapshot={{
          evaluations: [],
          latestCommand: {
            id: "command-1",
            deal_id: "deal-1",
            status: "blocked",
            decision: "reversal_circuit_breaker",
            confidence: 0.95,
            created_at: new Date().toISOString(),
          },
        }}
      />,
    );

    expect(screen.getByText("IA pausada")).toBeInTheDocument();
    expect(screen.getByText("Conflito detectado")).toBeInTheDocument();
  });

  it("mostra a tira quando o único sinal é o histórico", () => {
    render(
      <DealAutomationBadges
        deal={deal}
        snapshot={{ evaluations: [], latestHistory: history({ actor_type: "ai" }) }}
      />,
    );

    expect(screen.getByTestId("deal-automation-badges")).toBeInTheDocument();
    expect(screen.getByText("IA acompanhando")).toBeInTheDocument();
    expect(screen.getByText(/Movido pela IA/)).toBeInTheDocument();
  });
});

describe("DealAutomationDetails", () => {
  const stages = [
    { id: "stage-0", name: "Qualificação" },
    { id: "stage-1", name: "Proposta" },
  ];

  it("não desenha nada quando o negócio não tem automação", () => {
    const { container } = renderWithQueryClient(
      <DealAutomationDetails deal={deal} snapshot={{ evaluations: [] }} stages={stages} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("desenha o resumo como botão único e abre o diálogo com as etiquetas dentro", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(
      <DealAutomationDetails
        deal={deal}
        snapshot={{
          evaluations: [],
          latestHistory: history(),
          pending: {
            id: "pending-1",
            deal_id: "deal-1",
            current_stage_id: "stage-1",
            suggested_stage_id: "stage-2",
            confidence: 0.8,
            reason: "Aprovação necessária",
            criteria_evaluation: [],
            status: "pending",
            created_at: new Date().toISOString(),
          },
        }}
        stages={stages}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: "IA: aguardando aprovação — abrir detalhes da IA",
    });
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Decisão da IA no funil" });
    expect(dialog).toHaveTextContent("Movimento manual no Kanban");
    expect(screen.getByTestId("deal-automation-badges")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aprovar" })).toBeInTheDocument();
  });

  it("mantém o botão para negócio avaliado só na etapa anterior", () => {
    renderWithQueryClient(
      <DealAutomationDetails
        deal={deal}
        snapshot={{
          evaluations: [
            {
              id: "evaluation-antiga",
              deal_id: "deal-1",
              stage_id: "stage-0",
              criterion_key: "criterion_1",
              criterion_label: "Problema identificado",
              status: "met",
              confidence: 0.9,
              evidence: "",
              evaluated_at: new Date().toISOString(),
              human_feedback: null,
            },
          ],
        }}
        stages={stages}
      />,
    );

    expect(
      screen.getByRole("button", { name: "IA acompanhando — abrir detalhes da IA" }),
    ).toBeInTheDocument();
  });
});

describe("RuleEditor (autonomia por modo)", () => {
  const setup = (props: Partial<React.ComponentProps<typeof RuleEditor>> = {}) => {
    const onSave = vi.fn();
    const utils = render(
      <RuleEditor
        label="Lead Novo → Perdido"
        mode="manual"
        minConfidence={0.8}
        requiresHumanApproval={false}
        pending={false}
        onSave={onSave}
        {...props}
      />,
    );
    return { onSave, ...utils };
  };

  const confidence = () => screen.getByLabelText("Confiança da transição Lead Novo → Perdido");
  const approval = () => screen.getByLabelText("Aprovação da transição Lead Novo → Perdido");
  const save = () => screen.getByRole("button", { name: "Salvar" });

  const selectMode = async (user: ReturnType<typeof userEvent.setup>, option: string) => {
    await user.click(screen.getByLabelText("Modo da transição Lead Novo → Perdido"));
    await user.click(await screen.findByRole("option", { name: option }));
  };

  it("manual mostra confiança de referência, campo habilitado e aprovação desabilitada", () => {
    setup();
    expect(screen.getByText("Confiança de referência %")).toBeInTheDocument();
    expect(confidence()).toBeEnabled();
    expect(approval()).toBeDisabled();
    expect(approval()).not.toBeChecked();
    expect(screen.getByText("Não se aplica no modo manual.")).toBeInTheDocument();
  });

  it("manual salva requiresHumanApproval=false mesmo com valor legado true", async () => {
    const user = userEvent.setup();
    const { onSave } = setup({ requiresHumanApproval: true });
    await user.click(save());
    expect(onSave).toHaveBeenCalledWith("manual", 0.8, false);
  });

  it("shadow mantém confiança habilitada, desabilita aprovação e salva false", async () => {
    const user = userEvent.setup();
    const { onSave } = setup({ mode: "shadow", requiresHumanApproval: true });
    expect(confidence()).toBeEnabled();
    expect(approval()).toBeDisabled();
    expect(screen.getByText("Não se aplica no modo shadow.")).toBeInTheDocument();
    await user.click(save());
    expect(onSave).toHaveBeenCalledWith("shadow", 0.8, false);
  });

  it("assistido força aprovação ligada e desabilitada", () => {
    setup({ mode: "assisted", requiresHumanApproval: true });
    expect(screen.getByText("Aprovação humana obrigatória")).toBeInTheDocument();
    expect(approval()).toBeChecked();
    expect(approval()).toBeDisabled();
    expect(confidence()).toBeEnabled();
  });

  it("assistido corrige valor legado requires_human_approval=false ao salvar", async () => {
    const user = userEvent.setup();
    const { onSave } = setup({ mode: "assisted", requiresHumanApproval: false });
    expect(approval()).toBeChecked();
    await user.click(save());
    expect(onSave).toHaveBeenCalledWith("assisted", 0.8, true);
  });

  it("autônomo mantém o switch habilitado", () => {
    setup({ mode: "autonomous", requiresHumanApproval: true });
    expect(approval()).toBeEnabled();
  });

  it("autônomo respeita o valor persistido quando a regra já está nesse modo", () => {
    setup({ mode: "autonomous", requiresHumanApproval: false });
    expect(approval()).not.toBeChecked();
    expect(screen.getByText("O card poderá ser movimentado automaticamente.")).toBeInTheDocument();
  });

  it("ao trocar de outro modo para autônomo, a aprovação começa ligada", async () => {
    const user = userEvent.setup();
    setup({ mode: "manual", requiresHumanApproval: false });
    await selectMode(user, "Autônomo");
    expect(approval()).toBeChecked();
    expect(approval()).toBeEnabled();
  });

  it("autônomo com aprovação desligada salva false", async () => {
    const user = userEvent.setup();
    const { onSave } = setup({ mode: "autonomous", requiresHumanApproval: true });
    await user.click(approval());
    await user.click(save());
    expect(onSave).toHaveBeenCalledWith("autonomous", 0.8, false);
  });

  it("autônomo com aprovação ligada salva true", async () => {
    const user = userEvent.setup();
    const { onSave } = setup({ mode: "autonomous", requiresHumanApproval: true });
    await user.click(save());
    expect(onSave).toHaveBeenCalledWith("autonomous", 0.8, true);
  });

  it("campo de confiança vazio bloqueia o salvamento e não vira zero", async () => {
    const user = userEvent.setup();
    const { onSave } = setup();
    await user.clear(confidence());
    expect(save()).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Informe um valor entre 0 e 100.");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("valor fora da faixa 0-100 impede o salvamento", async () => {
    const user = userEvent.setup();
    setup();
    await user.clear(confidence());
    await user.type(confidence(), "120");
    expect(save()).toBeDisabled();
    await user.clear(confidence());
    await user.type(confidence(), "-5");
    expect(save()).toBeDisabled();
  });

  it("converte o percentual corretamente para a escala do backend", async () => {
    const user = userEvent.setup();
    const { onSave } = setup({ mode: "autonomous", requiresHumanApproval: true });
    await user.clear(confidence());
    await user.type(confidence(), "80");
    await user.click(save());
    expect(onSave).toHaveBeenCalledWith("autonomous", 0.8, true);
  });

  it("alternar repetidamente entre modos não reaproveita valores incompatíveis", async () => {
    const user = userEvent.setup();
    const { onSave } = setup({ mode: "autonomous", requiresHumanApproval: true });
    await selectMode(user, "Manual");
    expect(approval()).not.toBeChecked();
    await selectMode(user, "Assistido");
    expect(approval()).toBeChecked();
    await selectMode(user, "Shadow");
    expect(approval()).not.toBeChecked();
    await user.click(save());
    expect(onSave).toHaveBeenCalledWith("shadow", 0.8, false);
  });

  it("mostra o texto auxiliar de confiança correto para cada modo", async () => {
    const user = userEvent.setup();
    setup();
    expect(screen.getByText(/só pode ser movimentado manualmente/)).toBeInTheDocument();
    await selectMode(user, "Shadow");
    expect(screen.getByText(/registra que teria movimentado/)).toBeInTheDocument();
    await selectMode(user, "Assistido");
    expect(screen.getByText(/envia a sugestão para revisão humana/)).toBeInTheDocument();
    await selectMode(user, "Autônomo");
    expect(screen.getByText(/Abaixo dele, solicita aprovação humana/)).toBeInTheDocument();
  });

  it("sincroniza valores novos vindos das props", () => {
    const { rerender } = setup({ mode: "manual", minConfidence: 0.8 });
    expect(confidence()).toHaveValue(80);
    rerender(
      <RuleEditor
        label="Lead Novo → Perdido"
        mode="autonomous"
        minConfidence={0.55}
        requiresHumanApproval={false}
        pending={false}
        onSave={vi.fn()}
      />,
    );
    expect(confidence()).toHaveValue(55);
    expect(approval()).not.toBeChecked();
  });

  it("normalizeApproval devolve o valor forçado por modo", () => {
    expect(normalizeApproval("manual", true)).toBe(false);
    expect(normalizeApproval("shadow", true)).toBe(false);
    expect(normalizeApproval("assisted", false)).toBe(true);
    expect(normalizeApproval("autonomous", false)).toBe(false);
    expect(normalizeApproval("autonomous", true)).toBe(true);
  });
});
