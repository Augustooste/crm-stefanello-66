import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Bot } from "lucide-react";

import type { ReportDia, ReportStage } from "@/lib/api/reports";
import {
  FunnelBars,
  KpiCardInner,
  MessagesPerDayChart,
  ResultRow,
  formatMinutes,
} from "./report-widgets";

function stage(overrides: Partial<ReportStage> = {}): ReportStage {
  return {
    stage_id: "s1",
    nome: "Novo lead",
    posicao: 1,
    is_won: false,
    is_lost: false,
    negocios: 2,
    valor: 1000,
    dias_medio_no_estagio: null,
    ...overrides,
  };
}

describe("formatMinutes", () => {
  it("abaixo de 60 min -- mostra só minutos", () => {
    expect(formatMinutes(45)).toBe("45 min");
  });

  it("60 min exatos -- mostra só horas, sem minutos", () => {
    expect(formatMinutes(60)).toBe("1h");
  });

  it("acima de 60 min com resto -- mostra horas e minutos", () => {
    expect(formatMinutes(90)).toBe("1h 30min");
  });

  it("arredonda minutos fracionários", () => {
    expect(formatMinutes(45.6)).toBe("46 min");
  });
});

describe("KpiCardInner", () => {
  it("renderiza ícone, label, valor e dica", () => {
    render(
      <KpiCardInner
        icon={<Bot data-testid="icon" />}
        label="Cobertura de IA"
        value="70%"
        hint="7 de 10"
      />,
    );

    expect(screen.getByTestId("icon")).toBeInTheDocument();
    expect(screen.getByText("Cobertura de IA")).toBeInTheDocument();
    expect(screen.getByText("70%")).toBeInTheDocument();
    expect(screen.getByText("7 de 10")).toBeInTheDocument();
  });
});

describe("ResultRow", () => {
  it("renderiza label e valor", () => {
    render(<ResultRow label="Ganhos" value="12" />);

    expect(screen.getByText("Ganhos")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
  });
});

describe("MessagesPerDayChart", () => {
  it("mostra mensagem de vazio quando não há dados no período", () => {
    render(<MessagesPerDayChart data={[]} />);

    expect(screen.getByText("Nenhuma mensagem no período.")).toBeInTheDocument();
  });

  it("renderiza o gráfico sem quebrar quando há dados", () => {
    const data: ReportDia[] = [
      { dia: "2026-07-01", recebidas: 5, enviadas: 3 },
      { dia: "2026-07-02", recebidas: 2, enviadas: 4 },
    ];

    const { container } = render(<MessagesPerDayChart data={data} />);

    expect(screen.queryByText("Nenhuma mensagem no período.")).not.toBeInTheDocument();
    expect(container.querySelector("[data-chart]")).toBeInTheDocument();
  });
});

describe("FunnelBars", () => {
  it("mostra mensagem de vazio quando não há estágios abertos configurados", () => {
    render(<FunnelBars stages={[]} />);

    expect(
      screen.getByText("Nenhum estágio configurado — aplique um modelo de nicho no wizard."),
    ).toBeInTheDocument();
  });

  it("filtra estágios ganhos/perdidos do funil, mostrando só os abertos", () => {
    render(
      <FunnelBars
        stages={[
          stage({ stage_id: "s1", nome: "Novo lead" }),
          stage({ stage_id: "s2", nome: "Ganho", is_won: true }),
          stage({ stage_id: "s3", nome: "Perdido", is_lost: true }),
        ]}
      />,
    );

    expect(screen.getByText("Novo lead")).toBeInTheDocument();
    expect(screen.queryByText("Ganho")).not.toBeInTheDocument();
    expect(screen.queryByText("Perdido")).not.toBeInTheDocument();
  });

  it("mostra 'estágio configurado só com ganho/perdido' como vazio (nenhum estágio aberto)", () => {
    render(<FunnelBars stages={[stage({ stage_id: "s2", nome: "Ganho", is_won: true })]} />);

    expect(
      screen.getByText("Nenhum estágio configurado — aplique um modelo de nicho no wizard."),
    ).toBeInTheDocument();
  });

  it("usa singular 'negócio' para contagem 1 e plural para outras", () => {
    render(
      <FunnelBars
        stages={[
          stage({ stage_id: "s1", nome: "Um negócio", negocios: 1, valor: 500 }),
          stage({ stage_id: "s2", nome: "Vários negócios", negocios: 3, valor: 1500 }),
        ]}
      />,
    );

    const singularRow = screen.getByText("Um negócio").closest("div")!;
    expect(singularRow.textContent!.replace(/\u00A0/g, " ")).toContain("1 negócio ·");
    expect(singularRow.textContent).not.toContain("1 negócios");

    const pluralRow = screen.getByText("Vários negócios").closest("div")!;
    expect(pluralRow.textContent!.replace(/\u00A0/g, " ")).toContain("3 negócios ·");
  });

  it("mostra o valor formatado em BRL e o tempo médio no estágio quando presente", () => {
    render(
      <FunnelBars
        stages={[stage({ nome: "Novo lead", negocios: 2, valor: 1000, dias_medio_no_estagio: 3 })]}
      />,
    );

    const row = screen.getByText("Novo lead").closest("div")!;
    const text = row.textContent!.replace(/\u00A0/g, " ");
    expect(text).toContain("R$ 1.000");
    expect(text).toContain("3d parado");
  });

  it("não mostra tempo médio no estágio quando é null", () => {
    render(<FunnelBars stages={[stage({ nome: "Novo lead", dias_medio_no_estagio: null })]} />);

    const row = screen.getByText("Novo lead").closest("div")!;
    expect(row.textContent).not.toContain("d parado");
  });

  it("calcula a largura da barra proporcional ao maior estágio", () => {
    const { container } = render(
      <FunnelBars
        stages={[
          stage({ stage_id: "s1", nome: "Maior", negocios: 10 }),
          stage({ stage_id: "s2", nome: "Menor", negocios: 1 }),
        ]}
      />,
    );

    const bars = container.querySelectorAll(".bg-primary.transition-all");
    expect(bars).toHaveLength(2);
    expect((bars[0] as HTMLElement).style.width).toBe("100%");
    expect((bars[1] as HTMLElement).style.width).toBe("10%");
  });

  it("aplica largura mínima de 4% mesmo para valores desprezíveis", () => {
    const { container } = render(
      <FunnelBars
        stages={[
          stage({ stage_id: "s1", nome: "Maior", negocios: 1000 }),
          stage({ stage_id: "s2", nome: "Ínfimo", negocios: 1 }),
        ]}
      />,
    );

    const bars = container.querySelectorAll(".bg-primary.transition-all");
    expect((bars[1] as HTMLElement).style.width).toBe("4%");
  });
});
