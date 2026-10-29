import { beforeEach, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type * as TanstackRouter from "@tanstack/react-router";
import { routerOverrides } from "@/test/router-mocks";
import { renderWithQueryClient } from "@/test/render";
import { createChain } from "@/test/query-mocks";
import { supabase } from "@/integrations/supabase/client";
import { useBoards } from "@/lib/api/boards";
import { useCurrentProfile, useTenantProfiles } from "@/lib/api/session";
import {
  useAiHitlPerformance,
  useMessagingPerformance,
  useWalletHealth,
} from "@/lib/api/dashboard-widgets";
import { AiHitlPerformanceCard } from "./ai-hitl-performance-card";
import { MessagingPerformanceCard } from "./messaging-performance-card";
import { WalletHealthCard } from "./wallet-health-card";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof TanstackRouter>();
  return { ...actual, ...routerOverrides() };
});
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: vi.fn() } }));
vi.mock("@/lib/api/boards", () => ({ useBoards: vi.fn() }));
vi.mock("@/lib/api/session", () => ({ useCurrentProfile: vi.fn(), useTenantProfiles: vi.fn() }));
vi.mock("@/lib/api/dashboard-widgets", () => ({
  useAiHitlPerformance: vi.fn(),
  useMessagingPerformance: vi.fn(),
  useWalletHealth: vi.fn(),
}));

const from = new Date("2026-10-01T00:00:00Z");
const to = new Date("2026-10-08T00:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useBoards).mockReturnValue({
    data: [
      { id: "b1", name: "Vendas" },
      { id: "b2", name: "Suporte" },
    ],
  } as never);
  vi.mocked(useCurrentProfile).mockReturnValue({ data: { tenant_id: "tenant-a" } } as never);
  vi.mocked(useTenantProfiles).mockReturnValue({ data: [] } as never);
  vi.mocked(useWalletHealth).mockReturnValue({
    isLoading: false,
    isError: false,
    data: { contatos_total: 0 },
  } as never);
  vi.mocked(useAiHitlPerformance).mockReturnValue({
    isLoading: false,
    isError: false,
    data: undefined,
  } as never);
  vi.mocked(useMessagingPerformance).mockReturnValue({
    isLoading: false,
    isError: false,
    data: {
      msgs_humano: 2,
      msgs_ia: 3,
      frt_mediana_seg: 60,
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

it("carteira envia o quadro e não anuncia agregação global", () => {
  renderWithQueryClient(<WalletHealthCard ownerId="owner-a" boardId="b1" />);

  expect(useWalletHealth).toHaveBeenCalledWith("owner-a", "b1");
  expect(screen.queryByText("Todos os quadros")).not.toBeInTheDocument();
});

it("revisão humana envia o quadro e não anuncia agregação global", () => {
  renderWithQueryClient(
    <AiHitlPerformanceCard from={from} to={to} ownerId="owner-a" boardId="b1" />,
  );

  expect(useAiHitlPerformance).toHaveBeenCalledWith(from, to, "owner-a", "b1");
  expect(screen.queryByText("Todos os quadros")).not.toBeInTheDocument();
});

it("mensagens filtram o quadro e identificam somente contatos e follow-ups como globais", async () => {
  renderWithQueryClient(
    <MessagingPerformanceCard from={from} to={to} ownerId="owner-a" boardId="b1" />,
  );

  expect(useMessagingPerformance).toHaveBeenCalledWith(from, to, "owner-a", "b1");
  expect(await screen.findByText("Novos contatos (todos os quadros)")).toBeInTheDocument();
  expect(screen.getByText("2 follow-ups em todos os quadros")).toBeInTheDocument();
  expect(screen.queryByText("Todos os quadros")).not.toBeInTheDocument();
});
