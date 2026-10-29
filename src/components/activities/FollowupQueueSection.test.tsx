import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { renderWithQueryClient } from "@/test/render";
import {
  createFromByTable,
  createFromQueue,
  createQueryBuilder,
  fail,
  ok,
  type QueryBuilderMock,
} from "@/test/supabase-mock";
import { useCurrentProfile } from "@/lib/api/session";
import { FollowupQueueSection } from "./FollowupQueueSection";

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

const PROFILE = { id: "u1", tenant_id: "t1", name: "Felipe", role: "admin" as const };

const FOLLOWUP_OVERDUE = {
  id: "f1",
  tenant_id: "t1",
  deal_id: null,
  contact_id: "ct1",
  scheduled_at: "2020-01-01T10:00:00.000Z", // bem no passado — sempre atrasado
  description: "Confirmar retorno",
  status: "pending" as const,
  ai_suggested: false,
  source: "manual" as const,
  created_at: "2020-01-01T09:00:00.000Z",
  contact: { id: "ct1", name: "Ana Souza" },
  deal: null,
};

describe("FollowupQueueSection", () => {
  beforeEach(() => {
    vi.mocked(useCurrentProfile).mockReturnValue({ data: PROFILE } as ReturnType<
      typeof useCurrentProfile
    >);
  });

  it("mostra o follow-up atrasado na seção correta, com nome do contato e horário", async () => {
    vi.mocked(supabase.from).mockImplementation(
      createFromByTable({ deal_followups: ok([FOLLOWUP_OVERDUE]) }),
    );

    renderWithQueryClient(<FollowupQueueSection />);

    await waitFor(() => expect(screen.getByText("Ana Souza")).toBeInTheDocument());
    expect(screen.getByText(/atrasados/i)).toBeInTheDocument();
    expect(screen.getByText("Confirmar retorno")).toBeInTheDocument();
    expect(screen.getByText("Nenhum retorno para hoje")).toBeInTheDocument();
  });

  it("mostra estados vazios em cada seção quando não há follow-ups pendentes", async () => {
    vi.mocked(supabase.from).mockImplementation(createFromByTable({ deal_followups: ok([]) }));

    renderWithQueryClient(<FollowupQueueSection />);

    await waitFor(() => expect(screen.getByText("Nenhum retorno atrasado")).toBeInTheDocument());
    expect(screen.getByText("Nenhum retorno para hoje")).toBeInTheDocument();
    expect(screen.getByText("Nada agendado para os próximos dias")).toBeInTheDocument();
  });

  it("concluir um follow-up chama a mutation de completar e mostra toast de sucesso", async () => {
    const user = userEvent.setup();
    const followupsBuilder: QueryBuilderMock = createQueryBuilder(ok([FOLLOWUP_OVERDUE]));
    const updateBuilder: QueryBuilderMock = createQueryBuilder(ok(null));
    vi.mocked(supabase.from).mockImplementation(
      (table: string) =>
        (table === "deal_followups" ? followupsBuilder : updateBuilder) as unknown as ReturnType<
          typeof supabase.from
        >,
    );

    renderWithQueryClient(<FollowupQueueSection />);

    await waitFor(() => expect(screen.getByText("Ana Souza")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /concluir retorno com ana souza/i }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Retorno concluído"));
    expect(followupsBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed", completed_by: "u1" }),
    );
  });

  it("abre o diálogo de novo follow-up e permite escolher um contato", async () => {
    const user = userEvent.setup();
    vi.mocked(supabase.from).mockImplementation(
      createFromByTable({
        deal_followups: ok([]),
        contacts: ok([{ id: "ct1", name: "Ana Souza" }]),
        deals: ok([]),
      }),
    );

    renderWithQueryClient(<FollowupQueueSection />);
    await waitFor(() => expect(screen.getByText("Nenhum retorno atrasado")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /novo retorno/i }));
    expect(await screen.findByRole("heading", { name: "Novo retorno" })).toBeInTheDocument();
    // O trigger do Select de contato (Radix) usa role="combobox", não "button".
    expect(await screen.findByRole("combobox")).toBeInTheDocument();
  });

  it("mostra o estado de erro com a mensagem da falha e permite tentar novamente", async () => {
    const user = userEvent.setup();
    const followupsBuilder: QueryBuilderMock = createQueryBuilder(fail("timeout ao buscar fila"));
    vi.mocked(supabase.from).mockImplementation(
      () => followupsBuilder as unknown as ReturnType<typeof supabase.from>,
    );

    renderWithQueryClient(<FollowupQueueSection />);

    expect(await screen.findByText("Erro ao carregar")).toBeInTheDocument();
    expect(screen.getByText("timeout ao buscar fila")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));
    // refetch() dispara nova chamada com o mesmo builder falho — não deve quebrar.
    await waitFor(() => expect(screen.getByText("Erro ao carregar")).toBeInTheDocument());
  });

  it("mostra badge de IA, título do negócio e itens nos baldes hoje/próximos, com contagem no título", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-06-15T13:00:00.000Z"));

    const followupHoje = {
      id: "f2",
      tenant_id: "t1",
      deal_id: "d1",
      contact_id: "ct2",
      scheduled_at: "2026-06-15T20:00:00.000Z",
      description: null,
      status: "pending" as const,
      ai_suggested: true,
      source: "ai_suggested" as const,
      created_at: "2026-06-15T12:00:00.000Z",
      contact: null,
      deal: { id: "d1", title: "Negócio XPTO" },
    };
    const followupProximo = {
      id: "f3",
      tenant_id: "t1",
      deal_id: null,
      contact_id: "ct3",
      scheduled_at: "2026-06-17T13:00:00.000Z",
      description: null,
      status: "pending" as const,
      ai_suggested: false,
      source: "manual" as const,
      created_at: "2026-06-15T12:00:00.000Z",
      contact: { id: "ct3", name: "Bruno Lima" },
      deal: null,
    };
    vi.mocked(supabase.from).mockImplementation(
      createFromByTable({ deal_followups: ok([followupHoje, followupProximo]) }),
    );

    renderWithQueryClient(<FollowupQueueSection />);

    await waitFor(() => expect(screen.getByText(/hoje \(1\)/i)).toBeInTheDocument());
    expect(screen.getByText(/próximos 7 dias \(1\)/i)).toBeInTheDocument();
    expect(screen.getByText("IA")).toBeInTheDocument();
    expect(screen.getByText("Negócio XPTO")).toBeInTheDocument();
    expect(screen.getByText("Bruno Lima")).toBeInTheDocument();
    // Item sem contato usa o fallback "contato" no aria-label do botão de concluir.
    expect(
      screen.getByRole("button", { name: /concluir retorno com contato/i }),
    ).toBeInTheDocument();
  });

  it("mostra toast de erro quando concluir um follow-up falha", async () => {
    const user = userEvent.setup();
    // 1ª chamada em "deal_followups" = GET da fila (sucesso, precisa listar o
    // item pra poder clicar em "Concluir"); 2ª = UPDATE do complete (falha).
    vi.mocked(supabase.from).mockImplementation(
      createFromQueue([
        ok([FOLLOWUP_OVERDUE]),
        fail("permissão negada"),
      ]) as unknown as typeof supabase.from,
    );

    renderWithQueryClient(<FollowupQueueSection />);

    await waitFor(() => expect(screen.getByText("Ana Souza")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /concluir retorno com ana souza/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("permissão negada"));
  });

  it("cria um novo follow-up escolhendo contato e negócio, e fecha o diálogo ao concluir", async () => {
    const user = userEvent.setup();
    const insertBuilder: QueryBuilderMock = createQueryBuilder(ok(null));
    vi.mocked(supabase.from).mockImplementation(
      (table: string) =>
        (table === "contacts"
          ? createQueryBuilder(ok([{ id: "ct1", name: "Ana Souza" }]))
          : table === "deals"
            ? createQueryBuilder(ok([{ id: "d1", title: "Negócio da Ana", contact_id: "ct1" }]))
            : table === "deal_followups"
              ? insertBuilder
              : createQueryBuilder(ok([]))) as unknown as ReturnType<typeof supabase.from>,
    );

    renderWithQueryClient(<FollowupQueueSection />);
    await waitFor(() => expect(screen.getByText("Nenhum retorno atrasado")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /novo retorno/i }));
    await user.click(await screen.findByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Ana Souza" }));

    // Só depois de escolher o contato o Select de negócio (opcional) aparece.
    const dealTriggers = await screen.findAllByRole("combobox");
    await user.click(dealTriggers[1]);
    await user.click(await screen.findByRole("option", { name: "Negócio da Ana" }));

    await user.click(screen.getByRole("button", { name: "Criar retorno" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Retorno criado"));
    expect(insertBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        contact_id: "ct1",
        deal_id: "d1",
        created_by: "u1",
        source: "manual",
        ai_suggested: false,
      }),
    );
    expect(screen.queryByRole("heading", { name: "Novo retorno" })).not.toBeInTheDocument();
  });

  it("mostra toast de erro quando a criação do novo follow-up falha", async () => {
    const user = userEvent.setup();
    // "deal_followups" serve dois papéis: 1ª chamada é o GET da fila no mount
    // (precisa suceder vazio pra não cair no estado de erro geral da seção);
    // 2ª chamada é o INSERT do submit do form (que deve falhar).
    let followupsCalls = 0;
    vi.mocked(supabase.from).mockImplementation(
      (table: string) =>
        (table === "contacts"
          ? createQueryBuilder(ok([{ id: "ct1", name: "Ana Souza" }]))
          : table === "deals"
            ? createQueryBuilder(ok([]))
            : table === "deal_followups"
              ? (() => {
                  followupsCalls += 1;
                  return followupsCalls === 1
                    ? createQueryBuilder(ok([]))
                    : createQueryBuilder(fail("tenant inválido"));
                })()
              : createQueryBuilder(ok([]))) as unknown as ReturnType<typeof supabase.from>,
    );

    renderWithQueryClient(<FollowupQueueSection />);
    await waitFor(() => expect(screen.getByText("Nenhum retorno atrasado")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /novo retorno/i }));
    await user.click(await screen.findByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Ana Souza" }));
    await user.click(screen.getByRole("button", { name: "Criar retorno" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("tenant inválido"));
    expect(screen.getByRole("heading", { name: "Novo retorno" })).toBeInTheDocument();
  });

  it("mostra erro de validação e não chama a API ao tentar criar sem selecionar um contato", async () => {
    const user = userEvent.setup();
    const insertBuilder: QueryBuilderMock = createQueryBuilder(ok(null));
    vi.mocked(supabase.from).mockImplementation(
      (table: string) =>
        (table === "deal_followups"
          ? insertBuilder
          : createQueryBuilder(ok([]))) as unknown as ReturnType<typeof supabase.from>,
    );

    renderWithQueryClient(<FollowupQueueSection />);
    await waitFor(() => expect(screen.getByText("Nenhum retorno atrasado")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /novo retorno/i }));
    await user.click(screen.getByRole("button", { name: "Criar retorno" }));

    expect(await screen.findByText("Selecione um contato")).toBeInTheDocument();
    expect(insertBuilder.insert).not.toHaveBeenCalled();
  });
});
