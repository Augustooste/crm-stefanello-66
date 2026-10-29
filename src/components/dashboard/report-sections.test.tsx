import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type * as SessionModule from "@/lib/api/session";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile } from "@/lib/api/session";
import { fetchAiInsights, useDashboardReport, type DashboardReport } from "@/lib/api/reports";
import { renderWithQueryClient } from "@/test/render";
import { DashboardReportSections } from "./report-sections";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { routerOverrides } = await import("@/test/router-mocks");
  return { ...actual, ...routerOverrides() };
});

// importOriginal do mock de @/lib/api/reports abaixo carrega o módulo real,
// que importa @/integrations/supabase/client -- sem mockar o client, o CI
// quebra por falta de SUPABASE_URL/SUPABASE_PUBLISHABLE_KEY (mesmo padrão de
// _app.relatorios.test.tsx).
// O KPI de LTV usa o hook real useWalletHealth, então o RPC
// dashboard_wallet_health é mockado aqui (rpc + getSession do waitForSession).
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
    auth: { getSession: vi.fn(async () => ({ data: { session: null }, error: null })) },
  },
}));

vi.mock("@/lib/api/session", async (importOriginal) => {
  const actual = await importOriginal<typeof SessionModule>();
  return { ...actual, useCurrentProfile: vi.fn() };
});

// Persona real (useAiPersona) dispara supabase/react-query extras via
// InsightsCard -- mockar isola o teste da resolução assíncrona da persona
// (mesmo padrão de _app.inbox.test.tsx / insights-card.test.tsx).
vi.mock("@/components/ai/ai-persona-badge", () => ({
  AiPersonaBadge: () => <span>IA</span>,
}));

vi.mock("@/lib/api/reports", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/reports")>();
  return {
    ...actual,
    useDashboardReport: vi.fn(),
    fetchAiInsights: vi.fn(),
  };
});

const useDashboardReportMock = vi.mocked(useDashboardReport);
const fetchAiInsightsMock = vi.mocked(fetchAiInsights);
const rpcMock = vi.mocked(supabase.rpc);

function walletHealth(ltv: number | null) {
  return {
    contatos_ativos: 3,
    contatos_inativos: 1,
    contatos_total: 4,
    negocios_parados: 0,
    negocios_parados_valor: 0,
    ltv_medio: ltv,
    inactive_days_threshold: 30,
    stagnant_days_threshold: 7,
  };
}

beforeEach(() => {
  vi.mocked(useCurrentProfile).mockReturnValue({ data: { tenant_id: "tenant-a" } } as never);
  rpcMock.mockReset();
  rpcMock.mockResolvedValue({ data: walletHealth(1550), error: null } as never);
});

function baseReport(overrides: Partial<DashboardReport> = {}): DashboardReport {
  return {
    atendimento: {
      conversas_novas: 4,
      primeira_resposta_min: 12,
      handoff: 1,
      msgs_recebidas: 20,
      msgs_enviadas: 10,
      msgs_ia: 7,
      msgs_humano: 3,
    },
    mensagens_por_dia: [],
    funil: [
      {
        stage_id: "s1",
        nome: "Novo lead",
        posicao: 1,
        is_won: false,
        is_lost: false,
        negocios: 2,
        valor: 1000,
        dias_medio_no_estagio: null,
      },
    ],
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

describe("DashboardReportSections", () => {
  it("mostra estado de erro com botão de retry quando o RPC falha", async () => {
    const refetch = vi.fn();
    useDashboardReportMock.mockReturnValue({
      isLoading: false,
      isError: true,
      data: undefined,
      refetch,
    } as never);

    renderWithQueryClient(<DashboardReportSections />);

    expect(screen.getByText("Não foi possível carregar as métricas do mês")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(refetch).toHaveBeenCalled();
  });

  it("mostra skeletons dos KPIs enquanto carrega", () => {
    useDashboardReportMock.mockReturnValue({
      isLoading: true,
      isError: false,
      data: undefined,
      refetch: vi.fn(),
    } as never);

    const { container } = renderWithQueryClient(<DashboardReportSections />);

    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });

  it("calcula a cobertura de IA como % de msgs_ia sobre msgs_enviadas", () => {
    useDashboardReportMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: baseReport(),
      refetch: vi.fn(),
    } as never);

    renderWithQueryClient(<DashboardReportSections />);

    expect(screen.getByText("Cobertura de IA")).toBeInTheDocument();
    expect(screen.getByText("70%")).toBeInTheDocument();
    expect(screen.getByText("7 de 10 respostas foram da IA")).toBeInTheDocument();
  });

  it("mostra '—' na cobertura quando não houve mensagens enviadas (evita divisão por zero)", () => {
    useDashboardReportMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: baseReport({
        atendimento: {
          conversas_novas: 0,
          primeira_resposta_min: null,
          handoff: 0,
          msgs_recebidas: 0,
          msgs_enviadas: 0,
          msgs_ia: 0,
          msgs_humano: 0,
        },
      }),
      refetch: vi.fn(),
    } as never);

    renderWithQueryClient(<DashboardReportSections />);

    expect(screen.getByText("1ª resposta (média)")).toBeInTheDocument();
    // primeira_resposta_min null e cobertura null -- ambos mostram "—".
    expect(screen.getAllByText("—")).toHaveLength(2);
  });

  it("formata a 1ª resposta média em minutos quando presente", () => {
    useDashboardReportMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: baseReport({
        atendimento: {
          conversas_novas: 1,
          primeira_resposta_min: 90,
          handoff: 0,
          msgs_recebidas: 1,
          msgs_enviadas: 1,
          msgs_ia: 1,
          msgs_humano: 0,
        },
      }),
      refetch: vi.fn(),
    } as never);

    renderWithQueryClient(<DashboardReportSections />);

    expect(screen.getByText("1h 30min")).toBeInTheDocument();
  });

  it("mostra o LTV médio real do RPC dashboard_wallet_health formatado em BRL", async () => {
    useDashboardReportMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: baseReport(),
      refetch: vi.fn(),
    } as never);

    renderWithQueryClient(<DashboardReportSections />);

    // Intl usa NBSP entre "R$" e o número; \s cobre os dois espaços.
    expect(await screen.findByText(/^R\$\s1\.550$/)).toBeInTheDocument();
    expect(screen.getByText("LTV por cliente")).toBeInTheDocument();
    expect(screen.queryByText("Em breve")).not.toBeInTheDocument();
    expect(
      screen.getByText("Valor médio ganho por cliente ao longo do relacionamento"),
    ).toBeInTheDocument();
    // Mesmos parâmetros do card de carteira sem filtro (queryKey compartilhada).
    expect(rpcMock).toHaveBeenCalledWith("dashboard_wallet_health", {
      p_owner_id: undefined,
      p_board_id: undefined,
    });
  });

  it("mostra '—' no LTV com dica quando ainda não há negócios ganhos", async () => {
    rpcMock.mockResolvedValue({ data: walletHealth(null), error: null } as never);
    useDashboardReportMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: baseReport(),
      refetch: vi.fn(),
    } as never);

    renderWithQueryClient(<DashboardReportSections />);

    expect(
      await screen.findByText(
        "Ainda não há negócios ganhos para calcular o valor médio por cliente",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("Em breve")).not.toBeInTheDocument();
  });

  it("mostra estado de erro no LTV (nunca zero) quando o RPC falha", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "XX000", message: "falha no banco" },
    } as never);
    useDashboardReportMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: baseReport(),
      refetch: vi.fn(),
    } as never);

    renderWithQueryClient(<DashboardReportSections />);

    expect(
      await screen.findByText(
        "Não foi possível carregar o LTV. Tente novamente em instantes.",
        undefined,
        { timeout: 3000 },
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Indisponível")).toBeInTheDocument();
    expect(screen.queryByText(/^R\$\s0$/)).not.toBeInTheDocument();
    expect(screen.queryByText("Em breve")).not.toBeInTheDocument();
  });

  it("renderiza o funil e a mensagem de vazio de mensagens por dia via os widgets reais", () => {
    useDashboardReportMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: baseReport(),
      refetch: vi.fn(),
    } as never);

    renderWithQueryClient(<DashboardReportSections />);

    expect(screen.getByText("Saúde da carteira — funil")).toBeInTheDocument();
    expect(screen.getByText("Novo lead")).toBeInTheDocument();
    expect(screen.getByText("Mensagens por dia")).toBeInTheDocument();
    expect(screen.getByText("Nenhuma mensagem no período.")).toBeInTheDocument();
  });

  it("aciona a análise de insights ao clicar em Analisar e mostra o resultado", async () => {
    const user = userEvent.setup();
    useDashboardReportMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: baseReport(),
      refetch: vi.fn(),
    } as never);
    fetchAiInsightsMock.mockResolvedValue({
      insights: [
        {
          severidade: "alta",
          diagnostico: "Gargalo no funil",
          sugestao: "Revisar SLA",
          link: null,
        },
      ],
      cached: false,
      generated_at: "2026-07-15T10:00:00.000Z",
    });

    renderWithQueryClient(<DashboardReportSections />);

    await user.click(screen.getByRole("button", { name: "Analisar" }));

    expect(await screen.findByText("Gargalo no funil")).toBeInTheDocument();
    expect(fetchAiInsightsMock).toHaveBeenCalledWith(expect.any(Date), expect.any(Date), false);
  });

  it("passa force=true ao clicar em 'Analisar novamente' após já ter analisado", async () => {
    const user = userEvent.setup();
    useDashboardReportMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: baseReport(),
      refetch: vi.fn(),
    } as never);
    fetchAiInsightsMock.mockResolvedValue({
      insights: [],
      cached: false,
      generated_at: "2026-07-15T10:00:00.000Z",
    });

    renderWithQueryClient(<DashboardReportSections />);

    await user.click(screen.getByRole("button", { name: "Analisar" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Analisar novamente" })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Analisar novamente" }));

    await waitFor(() =>
      expect(fetchAiInsightsMock).toHaveBeenLastCalledWith(
        expect.any(Date),
        expect.any(Date),
        true,
      ),
    );
  });

  it("mostra 'Analisando…' enquanto a mutation de insights está pendente", async () => {
    const user = userEvent.setup();
    useDashboardReportMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: baseReport(),
      refetch: vi.fn(),
    } as never);
    let resolvePromise: (value: Awaited<ReturnType<typeof fetchAiInsights>>) => void;
    fetchAiInsightsMock.mockReturnValue(
      new Promise((resolve) => {
        resolvePromise = resolve;
      }),
    );

    renderWithQueryClient(<DashboardReportSections />);

    await user.click(screen.getByRole("button", { name: "Analisar" }));

    expect(await screen.findByRole("button", { name: "Analisando…" })).toBeDisabled();

    resolvePromise!({ insights: [], cached: false, generated_at: "2026-07-15T10:00:00.000Z" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Analisar novamente" })).toBeInTheDocument(),
    );
  });

  it("mostra erro quando a análise de insights falha", async () => {
    const user = userEvent.setup();
    useDashboardReportMock.mockReturnValue({
      isLoading: false,
      isError: false,
      data: baseReport(),
      refetch: vi.fn(),
    } as never);
    fetchAiInsightsMock.mockRejectedValue(new Error("IA indisponível"));

    renderWithQueryClient(<DashboardReportSections />);

    await user.click(screen.getByRole("button", { name: "Analisar" }));

    expect(
      await screen.findByText("Não foi possível gerar a análise: IA indisponível"),
    ).toBeInTheDocument();
  });
});
