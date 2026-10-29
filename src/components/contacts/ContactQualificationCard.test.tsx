import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { supabase } from "@/integrations/supabase/client";
import { formatDateTime } from "@/lib/format";
import { renderWithQueryClient } from "@/test/render";
import {
  asFromMock,
  createFromByTable,
  createFromQueue,
  createPendingQueryBuilder,
  createQueryBuilder,
  fail,
  ok,
} from "@/test/supabase-mock";
import { ContactQualificationCard } from "./ContactQualificationCard";
import { QueryClient } from "@tanstack/react-query";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: vi.fn() } }));

const snapshot = {
  id: "snapshot-atual",
  confidence: 0.86,
  generated_at: "2026-10-15T18:00:00Z",
  based_on_messages: 12,
  executive_summary: "Paciente deseja avaliar implante na próxima semana.",
  dimensions: [
    { key: "resource", status: "confirmado", notes: "Reserva de R$ 3500 para o tratamento." },
    { key: "servico_interesse", status: "identificado", notes: "Interesse em implante dentário." },
  ],
  recommended_approach: {
    opening: "Acolha a dúvida sobre o implante.",
    keyQuestions: ["Qual dia da próxima semana seria melhor?"],
    objectionsToAnticipate: ["Receio da duração do procedimento."],
    suggestedNextStep: "Oferecer avaliação com o dentista.",
  },
};
const deals = [
  {
    id: "deal-1",
    title: "Avaliação de implante",
    qualifications: [
      snapshot,
      { ...snapshot, id: "snapshot-antigo", executive_summary: "Avaliação antiga." },
    ],
  },
  {
    id: "deal-2",
    title: "Retorno preventivo",
    qualifications: [
      {
        ...snapshot,
        id: "snapshot-retorno",
        based_on_messages: 1,
        executive_summary: "Deseja marcar retorno.",
      },
    ],
  },
];

function renderCard() {
  return renderWithQueryClient(
    <ContactQualificationCard tenantId="tenant-1" contactId="contact-1" />,
  );
}

describe("Qualificação por IA na ficha", () => {
  beforeEach(() => vi.clearAllMocks());

  it("mostra a avaliação mais recente de cada negócio com contexto legível", async () => {
    vi.mocked(supabase.from).mockImplementation(createFromByTable({ deals: ok(deals) }));
    renderCard();
    expect(await screen.findByText(snapshot.executive_summary)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Qualificação por IA" })).toBeInTheDocument();
    expect(screen.getByText("Avaliação de implante")).toBeInTheDocument();
    expect(screen.getByText("Retorno preventivo")).toBeInTheDocument();
    expect(screen.getByText("Deseja marcar retorno.")).toBeInTheDocument();
    expect(screen.queryByText("Avaliação antiga.")).not.toBeInTheDocument();
    expect(screen.getAllByText("Confiança: 86%")).toHaveLength(2);
    expect(screen.getByText("Baseada em 12 mensagens")).toBeInTheDocument();
    expect(screen.getByText("Baseada em 1 mensagem")).toBeInTheDocument();
    expect(screen.getAllByText(formatDateTime(snapshot.generated_at))).toHaveLength(2);
    expect(screen.getAllByText(/Recurso\/orçamento/)).toHaveLength(2);
    expect(screen.getAllByText(/servico interesse/i)).toHaveLength(2);
    expect(screen.getAllByText("Reserva de R$ 3500 para o tratamento.")).toHaveLength(2);
    expect(screen.getAllByText(snapshot.recommended_approach.opening)).toHaveLength(2);
    expect(screen.getAllByText(snapshot.recommended_approach.keyQuestions[0])).toHaveLength(2);
    expect(
      screen.getAllByText(snapshot.recommended_approach.objectionsToAnticipate[0]),
    ).toHaveLength(2);
    expect(screen.getAllByText(snapshot.recommended_approach.suggestedNextStep)).toHaveLength(2);
  });

  it("restringe tenant e contato e solicita só o último snapshot de cada negócio", async () => {
    const builder = createQueryBuilder(ok(deals));
    builder.is.mockImplementation((column) => {
      if (column === "deleted_at") throw new Error("column deals.deleted_at does not exist");
      return builder;
    });
    vi.mocked(supabase.from).mockImplementation(asFromMock(() => builder));
    renderCard();
    await screen.findByText(snapshot.executive_summary);
    expect(supabase.from).toHaveBeenCalledWith("deals");
    expect(builder.eq).toHaveBeenCalledWith("tenant_id", "tenant-1");
    expect(builder.eq).toHaveBeenCalledWith("contact_id", "contact-1");
    expect(builder.eq).toHaveBeenCalledWith("qualifications.tenant_id", "tenant-1");
    expect(builder.order).toHaveBeenCalledWith("generated_at", {
      ascending: false,
      referencedTable: "qualifications",
    });
    expect(builder.limit).toHaveBeenCalledWith(1, { referencedTable: "qualifications" });
  });

  it("mantém tratamento local mesmo quando o app propaga erros para a rota", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0, throwOnError: true } },
    });
    vi.mocked(supabase.from).mockImplementation(createFromByTable({ deals: ok(deals) }));
    renderWithQueryClient(<ContactQualificationCard tenantId="tenant-1" contactId="contact-1" />, {
      queryClient,
    });
    await screen.findByText(snapshot.executive_summary);
    expect(
      queryClient.getQueryCache().find({
        queryKey: ["contact-qualifications", "tenant-1", "contact-1"],
      })?.options,
    ).toMatchObject({ throwOnError: false });
  });

  it("não converte falha de leitura em vazio e permite tentar novamente", async () => {
    vi.mocked(supabase.from).mockImplementation(
      createFromQueue([fail("permission denied"), ok(deals)]),
    );
    renderCard();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Não foi possível carregar a qualificação por IA.",
    );
    expect(screen.queryByText(/Nenhuma qualificação registrada/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(await screen.findByText(snapshot.executive_summary)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    { nome: "contato sem negócios", rows: [] },
    {
      nome: "negócio sem snapshot",
      rows: [{ id: "deal-1", title: "Avaliação", qualifications: [] }],
    },
  ])("mostra vazio para $nome", async ({ rows }) => {
    vi.mocked(supabase.from).mockImplementation(createFromByTable({ deals: ok(rows) }));
    renderCard();
    expect(
      await screen.findByText("Nenhuma qualificação registrada para os negócios deste contato."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("identifica carregamento sem mostrar vazio antes da resposta", () => {
    vi.mocked(supabase.from).mockImplementation(asFromMock(() => createPendingQueryBuilder()));
    renderCard();
    expect(screen.getByRole("status")).toHaveTextContent("Carregando qualificação por IA...");
    expect(screen.queryByText(/Nenhuma qualificação registrada/)).not.toBeInTheDocument();
  });

  it("explicita dimensões e abordagem ausentes sem renderizar JSON ou quebrar a ficha", async () => {
    vi.mocked(supabase.from).mockImplementation(
      createFromByTable({
        deals: ok([
          {
            id: "deal-1",
            title: "Avaliação",
            qualifications: [{ ...snapshot, dimensions: null, recommended_approach: null }],
          },
        ]),
      }),
    );
    renderCard();
    expect(await screen.findByText("Dimensões não registradas.")).toBeInTheDocument();
    expect(screen.getByText("Abordagem não registrada.")).toBeInTheDocument();
    expect(screen.getByText(snapshot.executive_summary)).toBeInTheDocument();
  });
});
