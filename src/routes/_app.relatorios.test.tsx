// Garante que a raiz de /relatorios usa col-span-12. O layout _app envolve
// as rotas em `grid grid-cols-12`; sem col-span-12 o conteúdo colapsa em
// ~1/12 da largura e sobrepõe cards e gráficos (bug já observado em prod).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";

import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile } from "@/lib/api/session";
import {
  useDashboardReport,
  useDealOwnerLeaderboard,
  useHandoffSlaEvents,
  type DashboardReport,
} from "@/lib/api/reports";
import { renderWithQueryClient } from "@/test/render";
import { asFromMock, createQueryBuilder, ok } from "@/test/supabase-mock";
import { Route } from "./_app.relatorios";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { routerOverrides } = await import("@/test/router-mocks");
  return { ...actual, ...routerOverrides() };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));

vi.mock("@/lib/api/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/session")>();
  return { ...actual, useCurrentProfile: vi.fn() };
});

vi.mock("@/lib/api/reports", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/reports")>();
  return {
    ...actual,
    useDashboardReport: vi.fn(),
    useHandoffSlaEvents: vi.fn(),
    useDealOwnerLeaderboard: vi.fn(),
  };
});

const RelatoriosPage = Route.options.component!;

function baseReport(overrides: Partial<DashboardReport> = {}): DashboardReport {
  return {
    atendimento: {
      conversas_novas: 0,
      primeira_resposta_min: null,
      handoff: 0,
      msgs_recebidas: 0,
      msgs_enviadas: 0,
      msgs_ia: 0,
      msgs_humano: 0,
    },
    mensagens_por_dia: [],
    funil: [],
    resultados: {
      ganhos: 0,
      ganhos_valor: 0,
      perdidos: 0,
      ciclo_medio_dias: null,
      motivos_perda: [],
    },
    ...overrides,
  };
}

/**
 * `useDashboardReport` é chamado 2x pela página nesta ordem fixa: período
 * atual primeiro, período anterior depois (ver _app.relatorios.tsx). Um
 * contador módulo 2 alterna entre os dois retornos a cada par de chamadas,
 * o que se mantém correto em qualquer número de renders (a página sempre
 * chama o hook em pares, na mesma ordem).
 */
function mockDashboardReportPair(current: DashboardReport, previous: DashboardReport) {
  let callIndex = 0;
  vi.mocked(useDashboardReport).mockImplementation(() => {
    const data = callIndex % 2 === 0 ? current : previous;
    callIndex += 1;
    return { isLoading: false, isError: false, data } as never;
  });
}

describe("routes/_app.relatorios.tsx", () => {
  it("root element opts into the 12-col grid via col-span-12", () => {
    const src = readFileSync(resolve(__dirname, "./_app.relatorios.tsx"), "utf8");
    // Primeiro `return (` seguido do JSX raiz da página.
    const match = src.match(/return \(\s*<div className="([^"]+)"/);
    expect(match, "não achei o className da raiz da página").not.toBeNull();
    expect(match![1]).toMatch(/\bcol-span-12\b/);
  });
});

describe("página /relatorios — leaderboard + comparação de período (Fase 4 PR-B)", () => {
  beforeEach(() => {
    vi.mocked(useCurrentProfile).mockReturnValue({
      data: { id: "p1", tenant_id: "t1", name: "Admin", role: "admin" },
    } as never);
    vi.mocked(useHandoffSlaEvents).mockReturnValue({ isLoading: false, data: [] } as never);
    vi.mocked(useDealOwnerLeaderboard).mockReturnValue({
      isLoading: false,
      isError: false,
      data: [],
    } as never);
    vi.mocked(supabase.from).mockImplementation(asFromMock(() => createQueryBuilder(ok([]))));
  });

  it("mostra a variação percentual de alta (seta verde) vs o período anterior", async () => {
    mockDashboardReportPair(
      baseReport({
        atendimento: {
          conversas_novas: 20,
          primeira_resposta_min: null,
          handoff: 0,
          msgs_recebidas: 0,
          msgs_enviadas: 0,
          msgs_ia: 0,
          msgs_humano: 0,
        },
      }),
      baseReport({
        atendimento: {
          conversas_novas: 10,
          primeira_resposta_min: null,
          handoff: 0,
          msgs_recebidas: 0,
          msgs_enviadas: 0,
          msgs_ia: 0,
          msgs_humano: 0,
        },
      }),
    );

    renderWithQueryClient(<RelatoriosPage />);

    expect(await screen.findByText("Comparado ao período anterior")).toBeInTheDocument();
    expect(screen.getByText("+100% vs período anterior")).toBeInTheDocument();
  });

  it("mostra 'novo' (sem dividir por zero) quando o período anterior não tinha dados", async () => {
    mockDashboardReportPair(
      baseReport({
        resultados: {
          ganhos: 3,
          ganhos_valor: 5000,
          perdidos: 0,
          ciclo_medio_dias: null,
          motivos_perda: [],
        },
      }),
      baseReport({
        resultados: {
          ganhos: 0,
          ganhos_valor: 0,
          perdidos: 0,
          ciclo_medio_dias: null,
          motivos_perda: [],
        },
      }),
    );

    renderWithQueryClient(<RelatoriosPage />);

    expect(await screen.findByText("novo")).toBeInTheDocument();
  });

  it("mostra 'sem dados' quando os dois períodos estão zerados", async () => {
    mockDashboardReportPair(baseReport(), baseReport());

    renderWithQueryClient(<RelatoriosPage />);

    // As 3 métricas comparadas (conversas_novas, ganhos, msgs_recebidas)
    // estão zeradas nos dois períodos — cada uma mostra o rótulo.
    const badges = await screen.findAllByText("sem dados");
    expect(badges).toHaveLength(3);
  });

  it("renderiza o ranking de owners ordenado por vitórias vindo da view", async () => {
    mockDashboardReportPair(baseReport(), baseReport());
    vi.mocked(useDealOwnerLeaderboard).mockReturnValue({
      isLoading: false,
      isError: false,
      data: [
        {
          owner_id: "o1",
          owner_name: "Ana",
          wins: 5,
          decided: 6,
          win_rate_pct: 83.3,
          total_won_value: 10000,
        },
        {
          owner_id: "o2",
          owner_name: "Beto",
          wins: 2,
          decided: 4,
          win_rate_pct: 50,
          total_won_value: 4000,
        },
      ],
    } as never);

    renderWithQueryClient(<RelatoriosPage />);

    expect(await screen.findByText("Ranking — negócios fechados")).toBeInTheDocument();
    const anaRow = screen.getByText("Ana").closest("li")!;
    expect(anaRow).toHaveTextContent("1º");
    expect(anaRow).toHaveTextContent("5 vitórias");
    const betoRow = screen.getByText("Beto").closest("li")!;
    expect(betoRow).toHaveTextContent("2º");
  });

  it("mostra estado vazio do ranking quando não há negócios decididos", async () => {
    mockDashboardReportPair(baseReport(), baseReport());

    renderWithQueryClient(<RelatoriosPage />);

    expect(
      await screen.findByText("Nenhum negócio decidido (ganho ou perdido) ainda."),
    ).toBeInTheDocument();
  });
});
