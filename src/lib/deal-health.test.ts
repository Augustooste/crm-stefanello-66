import { describe, expect, it } from "vitest";
import { getActivityStatus, getNextActivityDueAt, isDealRotting } from "./deal-health";

const NOW = new Date("2026-07-09T12:00:00.000Z");

describe("isDealRotting", () => {
  it("false quando o deal está no estágio há menos de 10 dias", () => {
    const stageEnteredAt = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000);
    expect(isDealRotting(stageEnteredAt, NOW)).toBe(false);
  });

  it("false na borda exata de 10 dias (não é '> 10')", () => {
    const stageEnteredAt = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000);
    expect(isDealRotting(stageEnteredAt, NOW)).toBe(false);
  });

  it("true quando o deal está no estágio há mais de 10 dias", () => {
    const stageEnteredAt = new Date(NOW.getTime() - 11 * 24 * 60 * 60 * 1000);
    expect(isDealRotting(stageEnteredAt, NOW)).toBe(true);
  });

  it("aceita string ISO", () => {
    expect(isDealRotting("2026-06-01T00:00:00.000Z", NOW)).toBe(true);
  });
});

describe("getNextActivityDueAt", () => {
  it("retorna null sem activities", () => {
    expect(getNextActivityDueAt([])).toBeNull();
  });

  it("ignora activities já concluídas", () => {
    const result = getNextActivityDueAt([
      { dueAt: "2026-07-10T00:00:00.000Z", completedAt: "2026-07-09T00:00:00.000Z" },
    ]);
    expect(result).toBeNull();
  });

  it("ignora activities sem due_at", () => {
    const result = getNextActivityDueAt([{ dueAt: null, completedAt: null }]);
    expect(result).toBeNull();
  });

  it("seleciona a menor due_at entre múltiplas activities pendentes", () => {
    const result = getNextActivityDueAt([
      { dueAt: "2026-07-15T00:00:00.000Z", completedAt: null },
      { dueAt: "2026-07-11T00:00:00.000Z", completedAt: null },
      { dueAt: "2026-07-20T00:00:00.000Z", completedAt: null },
    ]);
    expect(result).toEqual(new Date("2026-07-11T00:00:00.000Z"));
  });

  it("inclui activity vencida (due_at no passado) — não filtra por now", () => {
    const result = getNextActivityDueAt([{ dueAt: "2026-07-01T00:00:00.000Z", completedAt: null }]);
    expect(result).toEqual(new Date("2026-07-01T00:00:00.000Z"));
  });
});

describe("getActivityStatus", () => {
  it("yellow quando não há próxima atividade", () => {
    expect(getActivityStatus(null, NOW)).toBe("yellow");
  });

  it("red quando a atividade está atrasada (dia anterior a hoje)", () => {
    const threeDaysAgo = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000);
    expect(getActivityStatus(threeDaysAgo, NOW)).toBe("red");
  });

  it("green quando a atividade é hoje, mesmo em horário diferente", () => {
    expect(getActivityStatus(new Date("2026-07-09T23:00:00.000Z"), NOW)).toBe("green");
  });

  it("gray quando a atividade é futura", () => {
    const nextWeek = new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000);
    expect(getActivityStatus(nextWeek, NOW)).toBe("gray");
  });
});
