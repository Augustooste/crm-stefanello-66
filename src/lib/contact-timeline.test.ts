import { describe, expect, it } from "vitest";

import {
  buildContactTimeline,
  paginateTimeline,
  type ContactTimelineSources,
} from "./contact-timeline";

describe("buildContactTimeline", () => {
  it("mescla eventos de todas as fontes em ordem cronológica decrescente", () => {
    const sources: ContactTimelineSources = {
      notes: [
        { id: "n1", content: "Cliente pediu desconto", created_at: "2026-01-03T10:00:00.000Z" },
      ],
      activities: [
        {
          id: "a1",
          title: "Ligar para o cliente",
          type: "call",
          due_at: "2026-01-02T09:00:00.000Z",
          completed_at: null,
          created_at: "2026-01-01T08:00:00.000Z",
        },
      ],
      followups: [
        {
          id: "f1",
          description: "Retornar semana que vem",
          scheduled_at: "2026-01-05T12:00:00.000Z",
          completed_at: null,
          status: "pending",
        },
      ],
      stageChanges: [
        {
          id: "s1",
          deal_title: "Plano Pro",
          from_stage_name: "Novo",
          to_stage_name: "Proposta",
          created_at: "2026-01-04T15:00:00.000Z",
        },
      ],
      messages: [
        {
          id: "m1",
          content: "Oi, tudo bem?",
          created_at: "2026-01-02T18:00:00.000Z",
          channel_type: "whatsapp",
        },
      ],
    };

    const timeline = buildContactTimeline(sources);

    expect(timeline.map((e) => e.id)).toEqual([
      "followup-f1", // 2026-01-05
      "stage-s1", // 2026-01-04
      "note-n1", // 2026-01-03
      "message-m1", // 2026-01-02T18:00
      "activity-a1", // due_at 2026-01-02T09:00 (não completada -> usa due_at)
    ]);
  });

  it("usa completed_at da atividade quando concluída, em vez de due_at", () => {
    const timeline = buildContactTimeline({
      activities: [
        {
          id: "a1",
          title: "Enviar proposta",
          type: "task",
          due_at: "2026-01-01T00:00:00.000Z",
          completed_at: "2026-01-10T00:00:00.000Z",
          created_at: "2025-12-01T00:00:00.000Z",
        },
      ],
    });

    expect(timeline[0].timestamp).toBe("2026-01-10T00:00:00.000Z");
    expect(timeline[0].title).toBe("Atividade concluída: Enviar proposta");
  });

  it("cai para created_at quando atividade não tem due_at nem completed_at", () => {
    const timeline = buildContactTimeline({
      activities: [
        {
          id: "a1",
          title: "Tarefa sem data",
          type: "task",
          due_at: null,
          completed_at: null,
          created_at: "2025-06-01T00:00:00.000Z",
        },
      ],
    });

    expect(timeline[0].timestamp).toBe("2025-06-01T00:00:00.000Z");
  });

  it("usa completed_at do follow-up quando concluído, em vez de scheduled_at", () => {
    const timeline = buildContactTimeline({
      followups: [
        {
          id: "f1",
          description: "Retornar",
          scheduled_at: "2026-01-01T00:00:00.000Z",
          completed_at: "2026-01-02T00:00:00.000Z",
          status: "completed",
        },
      ],
    });

    expect(timeline[0].timestamp).toBe("2026-01-02T00:00:00.000Z");
    expect(timeline[0].title).toBe("Retorno concluído");
  });

  it("rotula follow-up cancelado corretamente", () => {
    const timeline = buildContactTimeline({
      followups: [
        {
          id: "f1",
          description: null,
          scheduled_at: "2026-01-01T00:00:00.000Z",
          completed_at: null,
          status: "cancelled",
        },
      ],
    });

    expect(timeline[0].title).toBe("Retorno cancelado");
  });

  it("descreve mudança de estágio sem stage anterior (deal criado direto em um stage)", () => {
    const timeline = buildContactTimeline({
      stageChanges: [
        {
          id: "s1",
          deal_title: "Plano Pro",
          from_stage_name: null,
          to_stage_name: "Novo",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    expect(timeline[0].description).toBe("Novo");
  });

  it("mantém ordem de inserção entre categorias diferentes quando o timestamp empata", () => {
    const sameTimestamp = "2026-01-01T00:00:00.000Z";
    const timeline = buildContactTimeline({
      notes: [{ id: "n1", content: "nota", created_at: sameTimestamp }],
      activities: [
        {
          id: "a1",
          title: "atividade",
          type: "task",
          due_at: sameTimestamp,
          completed_at: null,
          created_at: sameTimestamp,
        },
      ],
    });

    // Array.sort é estável: nota foi inserida antes da atividade na função
    // de merge, então em empate de timestamp ela permanece primeiro.
    expect(timeline.map((e) => e.id)).toEqual(["note-n1", "activity-a1"]);
  });

  it("retorna lista vazia quando nenhuma fonte é passada", () => {
    expect(buildContactTimeline({})).toEqual([]);
  });

  it("descarta eventos sem timestamp válido em vez de quebrar a ordenação", () => {
    const timeline = buildContactTimeline({
      activities: [
        // due_at/completed_at ausentes e created_at vazio -- não deveria
        // acontecer no schema real (created_at é not-null), mas dados
        // malformados não podem derrubar a página.
        {
          id: "a1",
          title: "Atividade sem nenhuma data",
          type: "task",
          due_at: null,
          completed_at: null,
          created_at: "" as unknown as string,
        },
      ],
      notes: [{ id: "n1", content: "nota válida", created_at: "2026-01-01T00:00:00.000Z" }],
    });

    expect(timeline).toHaveLength(1);
    expect(timeline[0].id).toBe("note-n1");
  });
});

describe("paginateTimeline", () => {
  const events = Array.from({ length: 12 }, (_, i) => ({
    id: `e${i}`,
    kind: "note" as const,
    timestamp: new Date(2026, 0, i + 1).toISOString(),
    title: `Evento ${i}`,
    description: null,
  }));

  it("corta a lista no limite e sinaliza hasMore quando há mais itens", () => {
    const { items, hasMore } = paginateTimeline(events, 5);
    expect(items).toHaveLength(5);
    expect(items.map((e) => e.id)).toEqual(["e0", "e1", "e2", "e3", "e4"]);
    expect(hasMore).toBe(true);
  });

  it("hasMore é false quando o limite cobre a lista inteira", () => {
    const { items, hasMore } = paginateTimeline(events, 12);
    expect(items).toHaveLength(12);
    expect(hasMore).toBe(false);
  });

  it("hasMore é false quando o limite excede o tamanho da lista", () => {
    const { items, hasMore } = paginateTimeline(events, 50);
    expect(items).toHaveLength(12);
    expect(hasMore).toBe(false);
  });

  it("retorna lista vazia com limite zero, ainda sinalizando hasMore", () => {
    const { items, hasMore } = paginateTimeline(events, 0);
    expect(items).toHaveLength(0);
    expect(hasMore).toBe(true);
  });

  it("lida com limite negativo tratando como zero", () => {
    const { items } = paginateTimeline(events, -5);
    expect(items).toHaveLength(0);
  });
});

describe("buildContactTimeline — ligações IA", () => {
  const base = {
    id: "v1",
    created_at: "2026-09-25T14:30:00Z",
    ended_at: "2026-09-25T14:35:47Z",
    duration_seconds: 227,
    outcome: "interested",
    is_simulation: false,
  };

  it("ligação concluída vira evento próprio com duração e resultado", () => {
    const [ev] = buildContactTimeline({ calls: [{ ...base, status: "completed" }] });
    expect(ev).toEqual({
      id: "call-v1",
      kind: "call",
      timestamp: "2026-09-25T14:35:47Z",
      title: "Ligação IA",
      description: "Duração: 03:47 · Resultado: interessado",
      refId: "v1",
    });
  });

  it("ligação sem atender mostra o status, sem duração", () => {
    const [ev] = buildContactTimeline({
      calls: [{ ...base, status: "no_answer", duration_seconds: null, outcome: null }],
    });
    expect(ev.description).toBe("Não atendeu");
  });

  it("ligação em andamento usa created_at e simulação é sinalizada", () => {
    const [ev] = buildContactTimeline({
      calls: [{ ...base, status: "ringing", ended_at: null, is_simulation: true }],
    });
    expect(ev.timestamp).toBe("2026-09-25T14:30:00Z");
    expect(ev.title).toBe("Ligação IA (simulação)");
    expect(ev.description).toBe("Chamando");
  });
});
