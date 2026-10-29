import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { formatBRL } from "@/lib/format";
import { PipelineTable, type PipelineTableRow, type PipelineTableStage } from "./PipelineTable";

const STAGES: PipelineTableStage[] = [
  { id: "s1", name: "Novos", is_won: false, is_lost: false },
  { id: "s2", name: "Qualificados", is_won: false, is_lost: false },
  { id: "s3", name: "Ganhos", is_won: true, is_lost: false },
];

function makeRow(overrides: Partial<PipelineTableRow> = {}): PipelineTableRow {
  return {
    id: "d1",
    title: "Negócio A",
    value: 1000,
    stageId: "s1",
    ownerName: "Ana",
    companyName: null,
    isHot: false,
    rotting: false,
    activityStatus: null,
    customFieldValues: {},
    ...overrides,
  };
}

/** o valor renderizado por formatBRL(1000), com o NBSP trocado por espaço comum (getByText normaliza o do DOM, não o nosso). */
const FORMATTED_1000 = formatBRL(1000).normalize().replace(/\s/g, " ");

describe("PipelineTable — renderização", () => {
  it("mostra estado vazio quando não há linhas", () => {
    render(
      <PipelineTable
        stages={STAGES}
        rows={[]}
        customFieldDefs={[]}
        showCompanyColumn={false}
        highlightDealId={null}
        onMoveDeal={vi.fn()}
      />,
    );

    expect(screen.getByText("Nenhum negócio encontrado com os filtros atuais")).toBeInTheDocument();
  });

  it("renderiza colunas Negócio/Estágio/Valor/Dono com os dados da linha", () => {
    render(
      <PipelineTable
        stages={STAGES}
        rows={[makeRow()]}
        customFieldDefs={[]}
        showCompanyColumn={false}
        highlightDealId={null}
        onMoveDeal={vi.fn()}
      />,
    );

    expect(screen.getByRole("columnheader", { name: "Negócio" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Estágio" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Valor" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Dono" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Empresa" })).not.toBeInTheDocument();

    expect(screen.getByText("Negócio A")).toBeInTheDocument();
    expect(screen.getByText("Ana")).toBeInTheDocument();
    expect(screen.getByText(FORMATTED_1000)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Estágio de Negócio A: Novos/ })).toBeInTheDocument();
  });

  it("mostra a coluna Empresa só quando showCompanyColumn=true", () => {
    render(
      <PipelineTable
        stages={STAGES}
        rows={[makeRow({ companyName: "Acme Ltda" })]}
        customFieldDefs={[]}
        showCompanyColumn
        highlightDealId={null}
        onMoveDeal={vi.fn()}
      />,
    );

    expect(screen.getByRole("columnheader", { name: "Empresa" })).toBeInTheDocument();
    expect(screen.getByText("Acme Ltda")).toBeInTheDocument();
  });

  it("mostra travessão quando o dono/empresa não é conhecido", () => {
    render(
      <PipelineTable
        stages={STAGES}
        rows={[makeRow({ ownerName: null, companyName: null })]}
        customFieldDefs={[]}
        showCompanyColumn
        highlightDealId={null}
        onMoveDeal={vi.fn()}
      />,
    );

    expect(screen.getAllByText("—")).toHaveLength(2);
  });

  it("renderiza colunas de campo customizado formatadas por tipo", () => {
    render(
      <PipelineTable
        stages={STAGES}
        rows={[makeRow({ customFieldValues: { plano: "pro", ativo: true } })]}
        customFieldDefs={[
          {
            key: "plano",
            label: "Plano",
            fieldType: "select",
            options: [{ value: "pro", label: "Pro" }],
          },
          { key: "ativo", label: "Ativo?", fieldType: "boolean", options: [] },
        ]}
        showCompanyColumn={false}
        highlightDealId={null}
        onMoveDeal={vi.fn()}
      />,
    );

    expect(screen.getByRole("columnheader", { name: "Plano" })).toBeInTheDocument();
    expect(screen.getByText("Pro")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Ativo?" })).toBeInTheDocument();
    expect(screen.getByText("Sim")).toBeInTheDocument();
  });

  it("mostra os sinais de saúde (lead quente, parado, atividade) junto do título", () => {
    render(
      <PipelineTable
        stages={STAGES}
        rows={[makeRow({ isHot: true, rotting: true, activityStatus: "red" })]}
        customFieldDefs={[]}
        showCompanyColumn={false}
        highlightDealId={null}
        onMoveDeal={vi.fn()}
      />,
    );

    expect(screen.getByText("Lead quente")).toBeInTheDocument();
    expect(screen.getByText("Parado (+10d)")).toBeInTheDocument();
    expect(screen.getByText("Atividade atrasada")).toBeInTheDocument();
  });

  it("aplica destaque visual na linha do negócio destacado (highlightDealId)", () => {
    render(
      <PipelineTable
        stages={STAGES}
        rows={[makeRow({ id: "d1" }), makeRow({ id: "d2", title: "Negócio B" })]}
        customFieldDefs={[]}
        showCompanyColumn={false}
        highlightDealId="d1"
        onMoveDeal={vi.fn()}
      />,
    );

    const row = screen.getByText("Negócio A").closest("tr")!;
    expect(row.className).toMatch(/ring-primary/);
    const otherRow = screen.getByText("Negócio B").closest("tr")!;
    expect(otherRow.className).not.toMatch(/ring-primary/);
  });

  it("move o negócio para outro estágio pelo mesmo mecanismo 'Mover para…' do kanban", async () => {
    const onMoveDeal = vi.fn();
    const user = userEvent.setup();
    render(
      <PipelineTable
        stages={STAGES}
        rows={[makeRow()]}
        customFieldDefs={[]}
        showCompanyColumn={false}
        highlightDealId={null}
        onMoveDeal={onMoveDeal}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Estágio de Negócio A: Novos/ }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Mover para…")).toBeInTheDocument();
    // o estágio atual ("Novos") não aparece como opção de destino
    expect(within(menu).queryByRole("menuitem", { name: "Novos" })).not.toBeInTheDocument();

    await user.click(within(menu).getByRole("menuitem", { name: "Qualificados" }));

    expect(onMoveDeal).toHaveBeenCalledWith("d1", "s2");
  });
});
