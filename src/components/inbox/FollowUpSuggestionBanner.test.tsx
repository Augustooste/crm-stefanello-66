import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { createTestQueryClient, renderWithQueryClient } from "@/test/render";
import {
  createFromQueue,
  createQueryBuilder,
  ok,
  type QueryBuilderMock,
} from "@/test/supabase-mock";
import { toast } from "sonner";
import { FollowUpSuggestionBanner } from "./FollowUpSuggestionBanner";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const BASE_PROPS = {
  contactId: "ct1",
  dealId: null,
  tenantId: "t1",
  createdBy: "u1",
};

function msg(sender: "contact" | "agent" | "ai", content: string | null) {
  return { sender, content };
}

describe("FollowUpSuggestionBanner", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("não renderiza com menos de 3 mensagens na conversa, mesmo com padrão na última", () => {
    renderWithQueryClient(
      <FollowUpSuggestionBanner
        {...BASE_PROPS}
        messages={[msg("agent", "oi"), msg("contact", "me chama semana que vem")]}
      />,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("não renderiza quando a ÚLTIMA mensagem do lead não bate com nenhum padrão", () => {
    renderWithQueryClient(
      <FollowUpSuggestionBanner
        {...BASE_PROPS}
        messages={[
          msg("contact", "me chama semana que vem"),
          msg("agent", "combinado"),
          msg("contact", "só queria confirmar o endereço"),
        ]}
      />,
    );
    // A frase com padrão é de uma mensagem antiga do lead, não a última — não deve detectar.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("detecta padrão na última mensagem do lead com >=3 mensagens e mostra a data sugerida", () => {
    renderWithQueryClient(
      <FollowUpSuggestionBanner
        {...BASE_PROPS}
        messages={[
          msg("contact", "oi"),
          msg("agent", "tudo bem?"),
          msg("contact", "me chama semana que vem"),
        ]}
      />,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Possível retorno detectado")).toBeInTheDocument();
    expect(screen.getByText(/data sugerida/i)).toBeInTheDocument();
  });

  it("procura a última mensagem DO LEAD, ignorando respostas do agente depois dela", () => {
    renderWithQueryClient(
      <FollowUpSuggestionBanner
        {...BASE_PROPS}
        messages={[
          msg("contact", "beleza"),
          msg("contact", "me chama semana que vem"),
          msg("agent", "combinado, falo com você em breve"),
        ]}
      />,
    );
    // A última mensagem do lead é "me chama semana que vem" — a resposta do
    // agente depois dela não deve impedir a detecção.
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("descarta a sugestão e não reaparece após um novo render do mesmo contato (dismissal via localStorage)", async () => {
    const user = userEvent.setup();
    const messages = [
      msg("contact", "oi"),
      msg("agent", "tudo bem?"),
      msg("contact", "me chama semana que vem"),
    ];
    const { unmount } = renderWithQueryClient(
      <FollowUpSuggestionBanner {...BASE_PROPS} messages={messages} />,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Ignorar sugestão" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    unmount();
    renderWithQueryClient(<FollowUpSuggestionBanner {...BASE_PROPS} messages={messages} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("dismissal de um contato não vaza para outro contato (troca de conversa sem desmontar)", () => {
    const messages = [
      msg("contact", "oi"),
      msg("agent", "tudo bem?"),
      msg("contact", "me chama semana que vem"),
    ];
    // Marca ct1 como já descartado antes do primeiro render (simula sessão anterior).
    localStorage.setItem("af_followup_banner_dismissed_ct1", "1");

    const queryClient = createTestQueryClient();
    const { rerender } = renderWithQueryClient(
      <FollowUpSuggestionBanner {...BASE_PROPS} contactId="ct1" messages={messages} />,
      { queryClient },
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // InboxPage não desmonta o banner ao trocar de conversa — apenas troca
    // `contactId`/`messages` via props (mesma árvore React, sem novo mount).
    // O `rerender` precisa recriar o mesmo `QueryClientProvider` usado no
    // render inicial, senão perde o provider do react-query.
    rerender(
      <QueryClientProvider client={queryClient}>
        <FollowUpSuggestionBanner {...BASE_PROPS} contactId="ct2" messages={messages} />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("aceitar a sugestão cria follow-up com source='ai_suggested' e ai_suggested=true, e esconde o banner", async () => {
    const user = userEvent.setup();
    const builder: QueryBuilderMock = createQueryBuilder(ok(null));
    vi.mocked(supabase.from).mockImplementation(
      () => builder as unknown as ReturnType<typeof supabase.from>,
    );

    renderWithQueryClient(
      <FollowUpSuggestionBanner
        {...BASE_PROPS}
        messages={[
          msg("contact", "oi"),
          msg("agent", "tudo bem?"),
          msg("contact", "me chama semana que vem"),
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Criar retorno" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(supabase.from).toHaveBeenCalledWith("deal_followups");
    expect(builder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        contact_id: "ct1",
        tenant_id: "t1",
        created_by: "u1",
        source: "ai_suggested",
        ai_suggested: true,
        status: "pending",
      }),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("mostra erro via toast e mantém o banner quando a criação falha", async () => {
    const user = userEvent.setup();
    vi.mocked(supabase.from).mockImplementation(
      createFromQueue([{ data: null, error: { message: "tenant inválido" } }]),
    );

    renderWithQueryClient(
      <FollowUpSuggestionBanner
        {...BASE_PROPS}
        messages={[
          msg("contact", "oi"),
          msg("agent", "tudo bem?"),
          msg("contact", "me chama semana que vem"),
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Criar retorno" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("tenant inválido"));
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
