import { expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type * as TanstackRouter from "@tanstack/react-router";
import { routerOverrides } from "@/test/router-mocks";
import { renderWithQueryClient } from "@/test/render";

import { useAiHitlPerformance } from "@/lib/api/dashboard-widgets";
import type { AiHitlPerformance } from "@/lib/api/dashboard-widgets";
import { AiHitlPerformanceCard } from "./ai-hitl-performance-card";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof TanstackRouter>();
  return { ...actual, ...routerOverrides() };
});

vi.mock("@/lib/api/dashboard-widgets", () => ({ useAiHitlPerformance: vi.fn() }));

it("mostra sugestões pendentes e mantém aprovações sem edição e editadas", () => {
  const performance: AiHitlPerformance = {
    aguardando_humano: 2,
    auto_avancos: 3,
    drafts_aprovados_sem_edicao: 3,
    drafts_editados: 1,
    sugestoes_pendentes: 5,
    avancos_auto_aprovados: 3,
    avancos_aprovados_humano: 4,
    avancos_rejeitados: 1,
    taxa_aprovacao_pct: 80,
    cobertura_24h_pct: 75,
  };
  vi.mocked(useAiHitlPerformance).mockReturnValue({
    isLoading: false,
    isError: false,
    data: performance,
  } as never);

  renderWithQueryClient(
    <AiHitlPerformanceCard
      from={new Date("2026-10-01T00:00:00Z")}
      to={new Date("2026-10-08T00:00:00Z")}
      ownerId={null}
      boardId={null}
    />,
  );

  expect(
    screen.getByText("4 aprovados (3 sem edição · 1 editados) · 1 rejeitados"),
  ).toBeInTheDocument();
  expect(screen.getByText("Auto-avanços")).toBeInTheDocument();
  expect(screen.getByText("Sugestões pendentes")).toBeInTheDocument();
  expect(screen.getByText("5")).toBeInTheDocument();
  expect(screen.getByText("80%")).toBeInTheDocument();
});
