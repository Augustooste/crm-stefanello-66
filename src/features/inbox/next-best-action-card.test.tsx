import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useCurrentProfile } from "@/lib/api/session";
import { useCreateFollowup } from "@/hooks/use-followup-queue";
import { renderWithQueryClient } from "@/test/render";
import { navigateMock } from "@/test/router-mocks";
import { createFromByTable, ok } from "@/test/supabase-mock";
import { NextBestActionCard } from "./next-best-action-card";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { routerOverrides } = await import("@/test/router-mocks");
  return { ...actual, ...routerOverrides() };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/api/session", () => ({
  useCurrentProfile: vi.fn(),
}));

vi.mock("@/hooks/use-followup-queue", () => ({
  useCreateFollowup: vi.fn(),
}));

vi.mock("@/components/ai/ai-persona-badge", () => ({
  AiPersonaBadge: () => <span>Persona IA</span>,
}));

const PROFILE = { id: "u1", tenant_id: "t1", name: "Felipe", role: "admin" as const };

const BASE_PROPS = {
  tenantId: "t1",
  conversationId: "conv1",
  contactId: "ct1",
  onApproveDraft: vi.fn(),
};

function mockQueries(overrides: { draft?: unknown; verdict?: unknown; deal?: unknown }) {
  vi.mocked(supabase.from).mockImplementation(
    createFromByTable({
      messages: ok(overrides.draft ?? null),
      ai_lead_verdicts: ok(overrides.verdict ?? null),
      deals: ok(overrides.deal ?? null),
    }),
  );
}

describe("NextBestActionCard", () => {
  beforeEach(() => {
    navigateMock.mockClear();
    vi.mocked(useCurrentProfile).mockReturnValue({ data: PROFILE } as ReturnType<
      typeof useCurrentProfile
    >);
    vi.mocked(useCreateFollowup).mockReturnValue({
      mutateAsync: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof useCreateFollowup>);
  });

  it("não renderiza nada quando não há rascunho nem veredito para o contato", async () => {
    mockQueries({});

    const { container } = renderWithQueryClient(<NextBestActionCard {...BASE_PROPS} />);

    await waitFor(() => expect(supabase.from).toHaveBeenCalledWith("deals"));
    expect(container).toBeEmptyDOMElement();
  });

  it("mostra o veredito com rationale quando há qualificação de lead", async () => {
    mockQueries({ verdict: { verdict: "hot", rationale: "Respondeu rápido e pediu proposta" } });

    renderWithQueryClient(<NextBestActionCard {...BASE_PROPS} />);

    expect(await screen.findByText(/Lead quente/)).toBeInTheDocument();
    expect(screen.getByText(/Respondeu rápido e pediu proposta/)).toBeInTheDocument();
  });

  it("mostra o veredito sem o separador quando não há rationale", async () => {
    mockQueries({ verdict: { verdict: "cold", rationale: null } });

    renderWithQueryClient(<NextBestActionCard {...BASE_PROPS} />);

    expect(await screen.findByText("Lead frio")).toBeInTheDocument();
  });

  it("normaliza um veredito desconhecido para 'morno'", async () => {
    mockQueries({ verdict: { verdict: "unknown", rationale: null } });

    renderWithQueryClient(<NextBestActionCard {...BASE_PROPS} />);

    expect(await screen.findByText("Lead morno")).toBeInTheDocument();
  });

  it("mostra o rascunho pendente e permite aprovar/enviar", async () => {
    const user = userEvent.setup();
    const onApproveDraft = vi.fn();
    mockQueries({ draft: { id: "d1", conversation_id: "conv1", content: "Oi, tudo bem?" } });

    renderWithQueryClient(<NextBestActionCard {...BASE_PROPS} onApproveDraft={onApproveDraft} />);

    expect(await screen.findByText(/Rascunho: Oi, tudo bem\?/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /enviar draft/i }));

    expect(onApproveDraft).toHaveBeenCalledWith({
      id: "d1",
      conversation_id: "conv1",
      content: "Oi, tudo bem?",
    });
  });

  it("desabilita o botão de enviar draft enquanto ele está em voo (approvingDraftId)", async () => {
    mockQueries({ draft: { id: "d1", conversation_id: "conv1", content: "Oi" } });

    renderWithQueryClient(<NextBestActionCard {...BASE_PROPS} approvingDraftId="d1" />);

    const button = await screen.findByRole("button", { name: /enviando/i });
    expect(button).toBeDisabled();
  });

  it("mostra o botão de abrir negócio quando há negócio aberto vinculado ao contato, e navega ao clicar", async () => {
    const user = userEvent.setup();
    mockQueries({
      verdict: { verdict: "hot", rationale: null },
      deal: { id: "deal-1" },
    });

    renderWithQueryClient(<NextBestActionCard {...BASE_PROPS} />);

    const openDealButton = await screen.findByRole("button", { name: /abrir negócio/i });
    await user.click(openDealButton);

    expect(navigateMock).toHaveBeenCalledWith({ to: "/pipeline", search: { dealId: "deal-1" } });
  });

  it("não mostra o botão de abrir negócio quando não há negócio aberto", async () => {
    mockQueries({ verdict: { verdict: "hot", rationale: null }, deal: null });

    renderWithQueryClient(<NextBestActionCard {...BASE_PROPS} />);

    await screen.findByText(/Lead quente/);
    expect(screen.queryByRole("button", { name: /abrir negócio/i })).not.toBeInTheDocument();
  });

  it("marca follow-up para amanhã com sucesso e mostra toast", async () => {
    const user = userEvent.setup();
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useCreateFollowup).mockReturnValue({
      mutateAsync,
    } as unknown as ReturnType<typeof useCreateFollowup>);
    mockQueries({ verdict: { verdict: "warm", rationale: null } });

    renderWithQueryClient(<NextBestActionCard {...BASE_PROPS} />);

    await user.click(await screen.findByRole("button", { name: /marcar retorno/i }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Retorno marcado para amanhã."));
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "t1",
        contactId: "ct1",
        createdBy: "u1",
        source: "ai_suggested",
        aiSuggested: true,
      }),
    );
  });

  it("mostra toast de erro quando marcar o follow-up falha", async () => {
    const user = userEvent.setup();
    vi.mocked(useCreateFollowup).mockReturnValue({
      mutateAsync: vi.fn().mockRejectedValue(new Error("Falha ao agendar")),
    } as unknown as ReturnType<typeof useCreateFollowup>);
    mockQueries({ verdict: { verdict: "warm", rationale: null } });

    renderWithQueryClient(<NextBestActionCard {...BASE_PROPS} />);

    await user.click(await screen.findByRole("button", { name: /marcar retorno/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Falha ao agendar"));
  });

  it("desabilita o botão de marcar follow-up quando não há perfil carregado", async () => {
    vi.mocked(useCurrentProfile).mockReturnValue({ data: undefined } as ReturnType<
      typeof useCurrentProfile
    >);
    mockQueries({ verdict: { verdict: "warm", rationale: null } });

    renderWithQueryClient(<NextBestActionCard {...BASE_PROPS} />);

    const button = await screen.findByRole("button", { name: /marcar retorno/i });
    expect(button).toBeDisabled();
  });
});
