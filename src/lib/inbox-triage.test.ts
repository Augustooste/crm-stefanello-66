import { describe, expect, it } from "vitest";
import {
  buildFocusQueue,
  isConversationCold,
  isConversationOverdue,
  isConversationToday,
  type ConversationForTriage,
} from "./inbox-triage";

const NOW = new Date("2026-07-13T12:00:00.000Z");
const NOW_MS = NOW.getTime();
const MS_PER_DAY = 1000 * 60 * 60 * 24;

function conv(
  overrides: Partial<ConversationForTriage & { id: string }> = {},
): ConversationForTriage & { id: string } {
  return {
    id: "conv-1",
    status: "open",
    awaiting_human: false,
    awaiting_human_since: null,
    last_message_at: NOW.toISOString(),
    last_message: { sender: "contact" },
    ...overrides,
  };
}

describe("isConversationOverdue", () => {
  it("false quando a última mensagem foi há menos de 24h", () => {
    const c = conv({ last_message_at: new Date(NOW_MS - 10 * 60 * 60 * 1000).toISOString() });
    expect(isConversationOverdue(c, NOW_MS)).toBe(false);
  });

  it("false na borda exata de 24h (não é '>= 24')", () => {
    const c = conv({ last_message_at: new Date(NOW_MS - 24 * 60 * 60 * 1000).toISOString() });
    expect(isConversationOverdue(c, NOW_MS)).toBe(false);
  });

  it("true quando a última mensagem foi há mais de 24h e é do cliente", () => {
    const c = conv({ last_message_at: new Date(NOW_MS - 25 * 60 * 60 * 1000).toISOString() });
    expect(isConversationOverdue(c, NOW_MS)).toBe(true);
  });

  it("false quando a última mensagem foi do agente (sender 'agent')", () => {
    const c = conv({
      last_message_at: new Date(NOW_MS - 48 * 60 * 60 * 1000).toISOString(),
      last_message: { sender: "agent" },
    });
    expect(isConversationOverdue(c, NOW_MS)).toBe(false);
  });

  it("false quando a última mensagem foi da IA (sender 'ai')", () => {
    const c = conv({
      last_message_at: new Date(NOW_MS - 48 * 60 * 60 * 1000).toISOString(),
      last_message: { sender: "ai" },
    });
    expect(isConversationOverdue(c, NOW_MS)).toBe(false);
  });

  it("false quando a conversa está fechada", () => {
    const c = conv({
      last_message_at: new Date(NOW_MS - 48 * 60 * 60 * 1000).toISOString(),
      status: "closed",
    });
    expect(isConversationOverdue(c, NOW_MS)).toBe(false);
  });

  it("false sem last_message_at", () => {
    const c = conv({ last_message_at: null });
    expect(isConversationOverdue(c, NOW_MS)).toBe(false);
  });

  it("false sem last_message (conversa sem mensagens)", () => {
    const c = conv({ last_message: null });
    expect(isConversationOverdue(c, NOW_MS)).toBe(false);
  });

  it("aceita threshold customizado", () => {
    const c = conv({ last_message_at: new Date(NOW_MS - 5 * 60 * 60 * 1000).toISOString() });
    expect(isConversationOverdue(c, NOW_MS, 4)).toBe(true);
  });
});

describe("isConversationToday", () => {
  it("true quando last_message_at é no mesmo dia-calendário de now", () => {
    const c = conv({ last_message_at: new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString() });
    expect(isConversationToday(c, NOW)).toBe(true);
  });

  it("false quando last_message_at é em outro dia", () => {
    const c = conv({ last_message_at: new Date("2026-07-12T23:59:00.000Z").toISOString() });
    expect(isConversationToday(c, NOW)).toBe(false);
  });

  it("false sem last_message_at", () => {
    const c = conv({ last_message_at: null });
    expect(isConversationToday(c, NOW)).toBe(false);
  });

  it("independe de status (mesmo fechada, se teve msg hoje, conta)", () => {
    const c = conv({ last_message_at: NOW.toISOString(), status: "closed" });
    expect(isConversationToday(c, NOW)).toBe(true);
  });
});

describe("isConversationCold", () => {
  it("false quando a última mensagem foi há menos de 7 dias", () => {
    const c = conv({ last_message_at: new Date(NOW_MS - 3 * MS_PER_DAY).toISOString() });
    expect(isConversationCold(c, NOW_MS)).toBe(false);
  });

  it("false na borda exata de 7 dias", () => {
    const c = conv({ last_message_at: new Date(NOW_MS - 7 * MS_PER_DAY).toISOString() });
    expect(isConversationCold(c, NOW_MS)).toBe(false);
  });

  it("true quando a última mensagem foi há mais de 7 dias, independente de direção", () => {
    const c = conv({
      last_message_at: new Date(NOW_MS - 8 * MS_PER_DAY).toISOString(),
      last_message: { sender: "agent" },
    });
    expect(isConversationCold(c, NOW_MS)).toBe(true);
  });

  it("true sem last_message (nunca respondida, aberta há mais de 7 dias) é decidido só por last_message_at", () => {
    const c = conv({
      last_message_at: new Date(NOW_MS - 8 * MS_PER_DAY).toISOString(),
      last_message: null,
    });
    expect(isConversationCold(c, NOW_MS)).toBe(true);
  });

  it("false quando a conversa está fechada", () => {
    const c = conv({
      last_message_at: new Date(NOW_MS - 30 * MS_PER_DAY).toISOString(),
      status: "closed",
    });
    expect(isConversationCold(c, NOW_MS)).toBe(false);
  });

  it("false sem last_message_at", () => {
    const c = conv({ last_message_at: null });
    expect(isConversationCold(c, NOW_MS)).toBe(false);
  });
});

describe("buildFocusQueue", () => {
  it("banda 1 (awaiting_human) ordenada por awaiting_human_since asc", () => {
    const a = conv({
      id: "a",
      awaiting_human: true,
      awaiting_human_since: new Date(NOW_MS - 1 * 60 * 60 * 1000).toISOString(),
    });
    const b = conv({
      id: "b",
      awaiting_human: true,
      awaiting_human_since: new Date(NOW_MS - 3 * 60 * 60 * 1000).toISOString(),
    });
    const result = buildFocusQueue([a, b], []);
    expect(result.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("banda 2 (overdue) ordenada por last_message_at asc, após banda 1", () => {
    const awaiting = conv({
      id: "awaiting",
      awaiting_human: true,
      awaiting_human_since: NOW.toISOString(),
    });
    const overdue1 = conv({
      id: "o1",
      last_message_at: new Date(NOW_MS - 30 * 60 * 60 * 1000).toISOString(),
    });
    const overdue2 = conv({
      id: "o2",
      last_message_at: new Date(NOW_MS - 50 * 60 * 60 * 1000).toISOString(),
    });
    const result = buildFocusQueue([awaiting], [overdue1, overdue2]);
    expect(result.map((c) => c.id)).toEqual(["awaiting", "o2", "o1"]);
  });

  it("nunca duplica: conversa presente nas duas bandas só aparece uma vez (na banda 1)", () => {
    const both = conv({
      id: "both",
      awaiting_human: true,
      awaiting_human_since: NOW.toISOString(),
    });
    const result = buildFocusQueue([both], [both]);
    expect(result.map((c) => c.id)).toEqual(["both"]);
  });

  it("filas vazias retornam array vazio", () => {
    expect(buildFocusQueue([], [])).toEqual([]);
  });
});
