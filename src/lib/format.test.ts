import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatBRL,
  formatDate,
  formatDateTime,
  formatTime,
  relativeFromNow,
  isToday,
  isPast,
  isSameDay,
  startOfDay,
  isAfter,
} from "./format";

describe("formatBRL", () => {
  it("formata número como moeda brasileira sem casas decimais", () => {
    expect(formatBRL(1234)).toBe("R$ 1.234");
  });

  it("formata zero", () => {
    expect(formatBRL(0)).toBe("R$ 0");
  });

  it("arredonda valores fracionários", () => {
    expect(formatBRL(9.9)).toBe("R$ 10");
  });
});

describe("formatDate", () => {
  it("formata um Date como dd/MM/yyyy", () => {
    expect(formatDate(new Date(2026, 5, 7))).toBe("07/06/2026");
  });

  it("aceita uma string de data", () => {
    expect(formatDate("2026-06-07T00:00:00")).toBe("07/06/2026");
  });
});

describe("formatDateTime", () => {
  it("formata um Date como dd/MM HH:mm", () => {
    expect(formatDateTime(new Date(2026, 5, 7, 14, 30))).toBe("07/06 14:30");
  });
});

describe("formatTime", () => {
  it("formata um Date como HH:mm", () => {
    expect(formatTime(new Date(2026, 5, 7, 9, 5))).toBe("09:05");
  });
});

describe("relativeFromNow", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 7, 12, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("descreve datas passadas com sufixo 'há'", () => {
    const past = new Date(2026, 5, 7, 10, 0, 0);
    expect(relativeFromNow(past)).toMatch(/há/);
  });

  it("descreve datas futuras com sufixo 'em'", () => {
    const future = new Date(2026, 5, 7, 14, 0, 0);
    expect(relativeFromNow(future)).toMatch(/em/);
  });

  it("aceita string de data", () => {
    expect(relativeFromNow("2026-06-07T10:00:00")).toMatch(/há/);
  });
});

describe("reexports do date-fns", () => {
  it("reexporta as funções auxiliares intactas", () => {
    expect(isToday(new Date())).toBe(true);
    expect(isPast(new Date(2000, 0, 1))).toBe(true);
    expect(isSameDay(new Date(2026, 0, 1), new Date(2026, 0, 1))).toBe(true);
    expect(startOfDay(new Date(2026, 0, 1, 15))).toEqual(new Date(2026, 0, 1, 0, 0, 0, 0));
    expect(isAfter(new Date(2026, 0, 2), new Date(2026, 0, 1))).toBe(true);
  });
});
