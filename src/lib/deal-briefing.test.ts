import { describe, expect, it } from "vitest";
import { buildDealBriefing, type DealBriefingInput } from "./deal-briefing";

const NOW = new Date("2026-07-09T12:00:00.000Z");

function baseInput(overrides: Partial<DealBriefingInput> = {}): DealBriefingInput {
  return {
    createdAt: "2026-07-01T12:00:00.000Z",
    stageEnteredAt: "2026-07-05T12:00:00.000Z",
    activities: [],
    followups: [],
    ...overrides,
  };
}

describe("buildDealBriefing", () => {
  it("calcula idade do deal e dias no estágio atual", () => {
    const briefing = buildDealBriefing(baseInput(), NOW);
    expect(briefing.idadeDias).toBe(8);
    expect(briefing.diasNoEstagioAtual).toBe(4);
  });

  it("estado vazio: sem activities e sem followups não quebra, retorna null nos dois campos", () => {
    const briefing = buildDealBriefing(baseInput(), NOW);
    expect(briefing.ultimaInteracao).toBeNull();
    expect(briefing.proximoFollowup).toBeNull();
  });

  it("ultimaInteracao ignora activities pendentes (sem completed_at)", () => {
    const briefing = buildDealBriefing(baseInput({ activities: [{ completedAt: null }] }), NOW);
    expect(briefing.ultimaInteracao).toBeNull();
  });

  it("ultimaInteracao pega a mais recente entre múltiplas activities concluídas", () => {
    const briefing = buildDealBriefing(
      baseInput({
        activities: [
          { completedAt: "2026-07-03T00:00:00.000Z" },
          { completedAt: "2026-07-08T00:00:00.000Z" },
          { completedAt: null },
        ],
      }),
      NOW,
    );
    expect(briefing.ultimaInteracao).toEqual(new Date("2026-07-08T00:00:00.000Z"));
  });

  it("proximoFollowup ignora followups completed/cancelled", () => {
    const briefing = buildDealBriefing(
      baseInput({
        followups: [
          { scheduledAt: "2026-07-10T00:00:00.000Z", status: "completed" },
          { scheduledAt: "2026-07-11T00:00:00.000Z", status: "cancelled" },
        ],
      }),
      NOW,
    );
    expect(briefing.proximoFollowup).toBeNull();
  });

  it("proximoFollowup pega o pendente mais próximo entre vários", () => {
    const briefing = buildDealBriefing(
      baseInput({
        followups: [
          { scheduledAt: "2026-07-20T00:00:00.000Z", status: "pending" },
          { scheduledAt: "2026-07-12T00:00:00.000Z", status: "pending" },
        ],
      }),
      NOW,
    );
    expect(briefing.proximoFollowup).toEqual(new Date("2026-07-12T00:00:00.000Z"));
  });

  it("proximoFollowup inclui follow-up pendente já vencido (ainda é o 'próximo')", () => {
    const briefing = buildDealBriefing(
      baseInput({
        followups: [{ scheduledAt: "2026-07-01T00:00:00.000Z", status: "pending" }],
      }),
      NOW,
    );
    expect(briefing.proximoFollowup).toEqual(new Date("2026-07-01T00:00:00.000Z"));
  });
});
