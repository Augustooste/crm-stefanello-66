import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { prepareMeeting, type MeetingPrep } from "@/lib/api/meeting-prep";
import { MeetingPrepSheet } from "./meeting-prep-sheet";

vi.mock("@/lib/api/meeting-prep", () => ({ prepareMeeting: vi.fn() }));

const PREP: MeetingPrep = {
  facts: {
    company: { name: "Atlas Industrial", industry: null, city: null },
    contact: { name: "Mariana Costa", title: "Diretora Comercial", email: null, phone: null },
    deal: {
      title: "Projeto de Automação Comercial B2B",
      value: 180000,
      valueLabel: "R$ 180.000",
      stageName: "Diagnóstico",
      ownerName: null,
    },
    meeting: {
      title: "Reunião",
      dateLabel: "25/09/2026",
      timeLabel: "10:00",
      dueAt: "2026-09-25T13:00:00Z",
    },
    objective: "mapear o processo comercial atual",
    knownContext: ["Equipe comercial de 12 vendedores."],
    recordedHypotheses: [],
    nextStep: null,
    attentionPoints: ["Oportunidade de R$ 180.000."],
  },
  // A IA é quem erra o cargo aqui: a UI não pode usar isso como fato.
  generated: {
    summary: null,
    hypotheses: [{ text: "Pode haver atualização manual do CRM.", reason: "nota" }],
    suggestedQuestions: ["Como o time registra hoje as interações no CRM?"],
    attentionPoints: [],
  },
  aiError: null,
};

function renderSheet() {
  // Igual ao router.tsx: throwOnError global ligado.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, throwOnError: true } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MeetingPrepSheet deal={{ id: "deal-1", title: "Projeto" }} onOpenChange={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe("MeetingPrepSheet", () => {
  it("renderiza os fatos do CRM e separa hipóteses de contexto", async () => {
    vi.mocked(prepareMeeting).mockResolvedValue(PREP);
    renderSheet();

    expect(await screen.findByText("Diretora Comercial")).toBeInTheDocument();
    expect(
      screen.getByText("Atlas Industrial · Projeto de Automação Comercial B2B"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("R$ 180.000")).toHaveLength(1);
    expect(screen.getByText("Diagnóstico")).toBeInTheDocument();
    expect(screen.getByText("25/09/2026")).toBeInTheDocument();
    expect(screen.getByText("10:00")).toBeInTheDocument();
    expect(screen.getByText("Hipóteses a validar")).toBeInTheDocument();
    expect(screen.getByText("Pode haver atualização manual do CRM.")).toBeInTheDocument();
    expect(screen.getByText("Próximo passo não definido.")).toBeInTheDocument();
    expect(prepareMeeting).toHaveBeenCalledWith("deal-1");
  });

  it("contato sem cargo mostra 'Cargo não informado'", async () => {
    vi.mocked(prepareMeeting).mockResolvedValue({
      ...PREP,
      facts: {
        ...PREP.facts,
        contact: { name: "João Teste", title: null, email: null, phone: null },
      },
    });
    renderSheet();

    expect(await screen.findByText("Cargo não informado")).toBeInTheDocument();
    expect(screen.queryByText(/Gerente|Diretor|CEO/)).not.toBeInTheDocument();
  });

  it("erro da Edge Function aparece no Sheet, sem derrubar a rota", async () => {
    vi.mocked(prepareMeeting).mockRejectedValue(new Error("Negócio não encontrado."));
    renderSheet();

    expect(await screen.findByText("Negócio não encontrado.")).toBeInTheDocument();
    expect(screen.getByText("Preparação da reunião")).toBeInTheDocument();
  });

  it("falha da IA mantém os fatos na tela", async () => {
    vi.mocked(prepareMeeting).mockResolvedValue({
      ...PREP,
      generated: null,
      aiError: "IA indisponível.",
    });
    renderSheet();

    expect(await screen.findByText("IA indisponível.")).toBeInTheDocument();
    expect(screen.getByText("Mariana Costa")).toBeInTheDocument();
    expect(screen.getByText("Nenhuma hipótese gerada.")).toBeInTheDocument();
  });
});
