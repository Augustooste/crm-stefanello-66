import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";

import { supabase } from "@/integrations/supabase/client";
import { renderWithQueryClient } from "@/test/render";
import { createFromByTable, ok, fail, type QueryResult } from "@/test/supabase-mock";
import { AiMemoryCard } from "./ai-memory-card";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));

const BASE_PROPS = {
  contactId: "c1",
  tags: null,
  aiMemory: null,
  openDeal: null,
  followups: [],
  activities: [],
  lastMessageAt: null,
};

function mockFrom(overrides: Record<string, QueryResult> = {}) {
  vi.mocked(supabase.from).mockImplementation(
    createFromByTable({
      ai_lead_verdicts: ok(null),
      ai_conversation_summaries: ok([]),
      ...overrides,
    }),
  );
}

describe("AiMemoryCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("mostra estado vazio de veredito e de resumos quando não há dado nenhum", async () => {
    mockFrom();
    renderWithQueryClient(<AiMemoryCard {...BASE_PROPS} />);

    expect(
      await screen.findByText("Sem veredito de qualificação para este contato ainda."),
    ).toBeInTheDocument();
    expect(await screen.findByText("Sem resumos ainda")).toBeInTheDocument();
    // Perfil consolidado: sem `aiMemory`, a seção inteira não aparece.
    expect(screen.queryByText("Perfil consolidado")).not.toBeInTheDocument();
  });

  it("mostra o veredito de qualificação quando ai_lead_verdicts tem linha", async () => {
    mockFrom({
      ai_lead_verdicts: ok({ verdict: "hot", rationale: "Perguntou preço e prazo de entrega" }),
    });
    renderWithQueryClient(<AiMemoryCard {...BASE_PROPS} />);

    expect(await screen.findByText("Lead quente")).toBeInTheDocument();
    expect(screen.getByText("Perguntou preço e prazo de entrega")).toBeInTheDocument();
  });

  it("lista os resumos de conversa (ai_conversation_summaries) com sentimento e fatos", async () => {
    mockFrom({
      ai_conversation_summaries: ok([
        {
          id: "s1",
          summary: "Cliente confirmou interesse no plano Pro",
          sentiment: "positive",
          key_facts: ["Empresa com 20 funcionários"],
          commitments: ["Vai enviar contrato assinado até sexta"],
          objections: ["Achou o preço alto"],
          open_questions: ["Tem desconto anual?"],
          period_end: "2026-01-10T12:00:00.000Z",
        },
      ]),
    });
    renderWithQueryClient(<AiMemoryCard {...BASE_PROPS} />);

    expect(await screen.findByText("Cliente confirmou interesse no plano Pro")).toBeInTheDocument();
    expect(screen.getByText("Positivo")).toBeInTheDocument();
    expect(screen.getByText(/Empresa com 20 funcionários/)).toBeInTheDocument();
    expect(screen.getByText(/Vai enviar contrato assinado até sexta/)).toBeInTheDocument();
    expect(screen.getByText(/Achou o preço alto/)).toBeInTheDocument();
    expect(screen.getByText(/Tem desconto anual\?/)).toBeInTheDocument();
  });

  it("exibe o perfil consolidado (contacts.ai_memory) só quando presente, com campos parciais", async () => {
    mockFrom();
    renderWithQueryClient(
      <AiMemoryCard
        {...BASE_PROPS}
        aiMemory={{
          history_summary: "Cliente de longa data, sempre renova no mesmo mês",
          preferences: ["Prefere contato por WhatsApp"],
          last_consolidated_at: "2026-01-01T00:00:00.000Z",
        }}
      />,
    );

    expect(await screen.findByText("Perfil consolidado")).toBeInTheDocument();
    expect(
      screen.getByText("Cliente de longa data, sempre renova no mesmo mês"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Prefere contato por WhatsApp/)).toBeInTheDocument();
    // Campos ausentes no jsonb (personality, relationship_notes) não quebram o render.
    expect(screen.queryByText(/Personalidade:/)).not.toBeInTheDocument();
  });

  it("trata contacts.ai_memory vazio ({}) como perfil ausente (sem card em branco)", async () => {
    mockFrom();
    renderWithQueryClient(<AiMemoryCard {...BASE_PROPS} aiMemory={{}} />);

    expect(await screen.findByText("Sem resumos ainda")).toBeInTheDocument();
    expect(screen.queryByText("Perfil consolidado")).not.toBeInTheDocument();
  });

  it("trata contacts.ai_memory malformado (array/string) como perfil ausente", async () => {
    mockFrom();
    renderWithQueryClient(<AiMemoryCard {...BASE_PROPS} aiMemory={["oops"]} />);

    expect(await screen.findByText("Sem resumos ainda")).toBeInTheDocument();
    expect(screen.queryByText("Perfil consolidado")).not.toBeInTheDocument();
  });

  it("renderiza os sinais derivados do CRM (tags, negócio aberto, próximo follow-up)", async () => {
    mockFrom();
    renderWithQueryClient(
      <AiMemoryCard
        {...BASE_PROPS}
        tags={["Quente", "VIP"]}
        openDeal={{ id: "d1", title: "Plano Pro", stageName: "Proposta" }}
        followups={[
          {
            id: "f1",
            description: "Retornar amanhã",
            scheduled_at: "2026-02-01T10:00:00.000Z",
            completed_at: null,
            status: "pending",
          },
        ]}
        lastMessageAt="2026-01-20T10:00:00.000Z"
      />,
    );

    await screen.findByText("Sinais do CRM");
    expect(screen.getByText("Quente")).toBeInTheDocument();
    expect(screen.getByText("VIP")).toBeInTheDocument();
    expect(screen.getByText(/Plano Pro · Proposta/)).toBeInTheDocument();
    expect(screen.getByText(/Retornar amanhã/)).toBeInTheDocument();
  });

  it("mostra traço (—) quando não há tags, negócio aberto, follow-up ou última mensagem", async () => {
    mockFrom();
    renderWithQueryClient(<AiMemoryCard {...BASE_PROPS} />);

    await screen.findByText("Sinais do CRM");
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(4);
  });

  it("propaga erro do veredito sem quebrar o resto do card", async () => {
    mockFrom({ ai_lead_verdicts: fail("Erro ao buscar veredito") });
    renderWithQueryClient(<AiMemoryCard {...BASE_PROPS} />);

    expect(await screen.findByText("Sem resumos ainda")).toBeInTheDocument();
  });
});
