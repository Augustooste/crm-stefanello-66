import { beforeEach, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type * as TanstackRouter from "@tanstack/react-router";
import { routerOverrides } from "@/test/router-mocks";
import { renderWithQueryClient } from "@/test/render";
import { createChain } from "@/test/query-mocks";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile, useTenantProfiles } from "@/lib/api/session";
import { useMessagingPerformance } from "@/lib/api/dashboard-widgets";
import { MessagingPerformanceCard } from "./messaging-performance-card";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof TanstackRouter>();
  return { ...actual, ...routerOverrides() };
});
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: vi.fn() } }));
vi.mock("@/lib/api/session", () => ({ useCurrentProfile: vi.fn(), useTenantProfiles: vi.fn() }));
vi.mock("@/lib/api/dashboard-widgets", () => ({ useMessagingPerformance: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useCurrentProfile).mockReturnValue({ data: { tenant_id: "tenant-a" } } as never);
  vi.mocked(useTenantProfiles).mockReturnValue({ data: [] } as never);
  vi.mocked(useMessagingPerformance).mockReturnValue({
    isLoading: false,
    isError: false,
    data: {
      msgs_humano: 2,
      msgs_ia: 3,
      frt_mediana_seg: 240,
      conversas_com_frt: 4,
      taxa_resposta_pct: 80,
      conversas_total: 5,
    },
  } as never);
  vi.mocked(supabase.from).mockImplementation((table: string) => {
    const chain = createChain({ data: [], error: null, count: table === "contacts" ? 7 : 2 });
    return Object.assign(chain, { lt: vi.fn(() => chain) }) as never;
  });
});

it("cada KPI ocupa uma única célula da grade, com rótulo, valor e dica juntos", async () => {
  renderWithQueryClient(
    <MessagingPerformanceCard
      from={new Date("2026-10-01T00:00:00Z")}
      to={new Date("2026-10-08T00:00:00Z")}
      ownerId={null}
      boardId={null}
    />,
  );

  await screen.findByText("2 follow-ups em todos os quadros");
  // A célula do KPI também é grade (subgrid); a grade-mãe é a que não herda linhas.
  const grid = screen.getByText("Mensagens Enviadas").closest(".grid:not(.grid-rows-subgrid)");
  expect(grid).not.toBeNull();

  const celulas = Array.from(grid!.children).map((c) => c.textContent);
  expect(celulas).toEqual([
    "Mensagens Enviadas52 humanos, 3 IA",
    "Novos contatos (todos os quadros)72 follow-ups em todos os quadros",
    "Tempo da 1ª resposta4 min4 conversas medidas",
    "Taxa de Resposta80%4 de 5 conversas",
  ]);
});

it("rótulo, valor e dica de cada KPI dividem as mesmas linhas da grade (valores alinhados)", async () => {
  renderWithQueryClient(
    <MessagingPerformanceCard
      from={new Date("2026-10-01T00:00:00Z")}
      to={new Date("2026-10-08T00:00:00Z")}
      ownerId={null}
      boardId={null}
    />,
  );

  await screen.findByText("2 follow-ups em todos os quadros");
  const grid = screen.getByText("Mensagens Enviadas").closest(".grid:not(.grid-rows-subgrid)");
  expect(grid).not.toBeNull();

  // jsdom não calcula layout: provamos a estrutura que garante o alinhamento.
  // Cada célula ocupa 3 linhas da grade-mãe e as herda via subgrid, então um
  // rótulo que quebra em 2 linhas empurra a faixa de valores de todas as colunas.
  const celulas = Array.from(grid!.children);
  expect(celulas).toHaveLength(4);
  for (const celula of celulas) {
    expect(celula).toHaveClass("grid", "grid-rows-subgrid", "row-span-3");
    expect(celula.children).toHaveLength(3);
  }

  const partes = celulas.map((c) => Array.from(c.children).map((p) => p.textContent));
  expect(partes).toEqual([
    ["Mensagens Enviadas", "5", "2 humanos, 3 IA"],
    ["Novos contatos (todos os quadros)", "7", "2 follow-ups em todos os quadros"],
    ["Tempo da 1ª resposta", "4 min", "4 conversas medidas"],
    ["Taxa de Resposta", "80%", "4 de 5 conversas"],
  ]);
});
