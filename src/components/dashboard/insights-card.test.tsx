import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { AiInsight, AiInsightsResponse } from "@/lib/api/reports";
import { InsightsCard } from "./insights-card";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { routerOverrides } = await import("@/test/router-mocks");
  return { ...actual, ...routerOverrides() };
});

// Persona real (useAiPersona) dispara supabase/react-query extras -- mockar
// mantém o teste focado no comportamento do InsightsCard (mesmo padrão de
// _app.inbox.test.tsx).
vi.mock("@/components/ai/ai-persona-badge", () => ({
  AiPersonaBadge: () => <span>IA</span>,
}));

function insight(overrides: Partial<AiInsight> = {}): AiInsight {
  return {
    severidade: "media",
    diagnostico: "Diagnóstico padrão",
    sugestao: "Sugestão padrão",
    link: null,
    ...overrides,
  };
}

function readyResponse(overrides: Partial<AiInsightsResponse> = {}): AiInsightsResponse {
  return {
    insights: [insight()],
    cached: false,
    generated_at: "2026-07-15T10:00:00.000Z",
    ...overrides,
  };
}

describe("InsightsCard", () => {
  it("estado idle -- mostra texto explicativo e botão 'Analisar'", () => {
    const onAnalyze = vi.fn();
    render(<InsightsCard state={{ kind: "idle" }} onAnalyze={onAnalyze} />);

    expect(screen.getByText(/A IA analisa os números do período/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Analisar" })).toBeEnabled();
  });

  it("estado loading -- desabilita o botão e mostra skeletons", () => {
    const { container } = render(<InsightsCard state={{ kind: "loading" }} onAnalyze={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Analisando…" })).toBeDisabled();
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(3);
  });

  it("estado error -- mostra a mensagem do erro", () => {
    render(
      <InsightsCard
        state={{ kind: "error", message: "Falha ao gerar insights" }}
        onAnalyze={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Não foi possível gerar a análise: Falha ao gerar insights"),
    ).toBeInTheDocument();
  });

  it("estado ready -- lista os insights com severidade e link quando presente", () => {
    render(
      <InsightsCard
        state={{
          kind: "ready",
          data: readyResponse({
            insights: [
              insight({ severidade: "alta", diagnostico: "Gargalo crítico", link: "/pipeline" }),
              insight({ severidade: "baixa", diagnostico: "Observação leve", link: null }),
            ],
          }),
        }}
        onAnalyze={vi.fn()}
      />,
    );

    expect(screen.getByText("Alta")).toBeInTheDocument();
    expect(screen.getByText("Gargalo crítico")).toBeInTheDocument();
    expect(screen.getByText("Baixa")).toBeInTheDocument();
    expect(screen.getByText("Observação leve")).toBeInTheDocument();
    // Só o insight com link tem o botão "Ver tela".
    expect(screen.getAllByText("Ver tela")).toHaveLength(1);
    expect(screen.getByRole("link", { name: /Ver tela/ })).toHaveAttribute("href", "/pipeline");
  });

  it("estado ready -- botão vira 'Analisar novamente' e chama onAnalyze(true)", async () => {
    const user = userEvent.setup();
    const onAnalyze = vi.fn();
    render(<InsightsCard state={{ kind: "ready", data: readyResponse() }} onAnalyze={onAnalyze} />);

    const button = screen.getByRole("button", { name: "Analisar novamente" });
    await user.click(button);

    expect(onAnalyze).toHaveBeenCalledWith(true);
  });

  it("estado idle -- botão chama onAnalyze(false)", async () => {
    const user = userEvent.setup();
    const onAnalyze = vi.fn();
    render(<InsightsCard state={{ kind: "idle" }} onAnalyze={onAnalyze} />);

    await user.click(screen.getByRole("button", { name: "Analisar" }));

    expect(onAnalyze).toHaveBeenCalledWith(false);
  });

  it("respeita maxItems, mostrando link 'Ver mais N em Relatórios' para o restante", () => {
    render(
      <InsightsCard
        state={{
          kind: "ready",
          data: readyResponse({
            insights: [
              insight({ diagnostico: "Um" }),
              insight({ diagnostico: "Dois" }),
              insight({ diagnostico: "Três" }),
            ],
          }),
        }}
        onAnalyze={vi.fn()}
        maxItems={2}
      />,
    );

    expect(screen.getByText("Um")).toBeInTheDocument();
    expect(screen.getByText("Dois")).toBeInTheDocument();
    expect(screen.queryByText("Três")).not.toBeInTheDocument();
    expect(screen.getByText("Ver mais 1 em Relatórios")).toBeInTheDocument();
  });

  it("sem maxItems, mostra todos os insights e nenhum link 'Ver mais'", () => {
    render(
      <InsightsCard
        state={{
          kind: "ready",
          data: readyResponse({
            insights: [insight({ diagnostico: "Um" }), insight({ diagnostico: "Dois" })],
          }),
        }}
        onAnalyze={vi.fn()}
      />,
    );

    expect(screen.getByText("Um")).toBeInTheDocument();
    expect(screen.getByText("Dois")).toBeInTheDocument();
    expect(screen.queryByText(/Ver mais/)).not.toBeInTheDocument();
  });

  it("mostra 'Análise em cache' quando cached é true", () => {
    render(
      <InsightsCard
        state={{ kind: "ready", data: readyResponse({ cached: true }) }}
        onAnalyze={vi.fn()}
      />,
    );

    expect(screen.getByText(/Análise em cache \(últimas 24h\)/)).toBeInTheDocument();
  });

  it("não mostra 'Análise em cache' quando cached é false", () => {
    render(
      <InsightsCard
        state={{ kind: "ready", data: readyResponse({ cached: false }) }}
        onAnalyze={vi.fn()}
      />,
    );

    expect(screen.queryByText(/Análise em cache/)).not.toBeInTheDocument();
    expect(screen.getByText(/Gerada em/)).toBeInTheDocument();
  });
});
