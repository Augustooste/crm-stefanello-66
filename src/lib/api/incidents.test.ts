import { describe, expect, it } from "vitest";

import {
  applyClientIncidentFilters,
  distinctIncidentCodes,
  incidentsByTrace,
  incidentsSinceIso,
  mergeIncidents,
  type Incident,
} from "@/lib/api/incidents";
import { escapeCsvValue, incidentsToCsv, incidentsToJson } from "@/lib/incidents-export";

function incident(partial: Partial<Incident> & Pick<Incident, "id">): Incident {
  return {
    kind: "falha_ia",
    occurredAt: "2026-01-01T00:00:00.000Z",
    traceId: null,
    scope: "ai-respond",
    code: "AI_RESPONSE_FAILED",
    message: "falhou",
    provider: null,
    model: null,
    statusCode: null,
    context: null,
    ...partial,
  };
}

describe("incidents", () => {
  it("ordena a lista unificada do mais recente para o mais antigo", () => {
    const merged = mergeIncidents(
      [incident({ id: "a", occurredAt: "2026-01-01T10:00:00.000Z" })],
      [
        incident({ id: "b", kind: "erro_app", occurredAt: "2026-01-01T12:00:00.000Z" }),
        incident({ id: "c", kind: "erro_app", occurredAt: "2026-01-01T08:00:00.000Z" }),
      ],
    );
    expect(merged.map((i) => i.id)).toEqual(["b", "a", "c"]);
  });

  it("filtra por código e por traceId parcial", () => {
    const rows = [
      incident({ id: "a", code: "X", traceId: "abc-123" }),
      incident({ id: "b", code: "Y", traceId: "def-456" }),
    ];
    expect(applyClientIncidentFilters(rows, { code: "X", traceId: null }).map((i) => i.id)).toEqual(
      ["a"],
    );
    expect(
      applyClientIncidentFilters(rows, { code: null, traceId: "DEF" }).map((i) => i.id),
    ).toEqual(["b"]);
  });

  it("correlaciona erro do app e falha de IA no mesmo traceId, em ordem cronológica", () => {
    const rows = [
      incident({ id: "ia", traceId: "t1", occurredAt: "2026-01-01T10:00:00.000Z" }),
      incident({
        id: "app",
        kind: "erro_app",
        traceId: "t1",
        occurredAt: "2026-01-01T09:00:00.000Z",
      }),
      incident({ id: "outro", traceId: "t2" }),
    ];
    expect(incidentsByTrace(rows, "t1").map((i) => i.id)).toEqual(["app", "ia"]);
  });

  it("lista códigos distintos ordenados", () => {
    expect(
      distinctIncidentCodes([
        incident({ id: "a", code: "B" }),
        incident({ id: "b", code: "A" }),
        incident({ id: "c", code: "A" }),
        incident({ id: "d", code: null }),
      ]),
    ).toEqual(["A", "B"]);
  });

  it("calcula a janela do período", () => {
    const now = Date.parse("2026-01-02T00:00:00.000Z");
    expect(incidentsSinceIso("24h", now)).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("exportação de incidentes", () => {
  it("neutraliza fórmula e escapa separador no CSV", () => {
    expect(escapeCsvValue("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(escapeCsvValue('a,b "c"')).toBe('"a,b ""c"""');
    expect(escapeCsvValue(null)).toBe("");
  });

  it("gera CSV com cabeçalho e uma linha por incidente", () => {
    const csv = incidentsToCsv([incident({ id: "a", traceId: "t1", message: "deu ruim" })]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toContain("trace_id");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("t1");
    expect(lines[1]).toContain("deu ruim");
  });

  it("gera JSON parseável", () => {
    const parsed = JSON.parse(incidentsToJson([incident({ id: "a", traceId: "t1" })]));
    expect(parsed[0].traceId).toBe("t1");
  });
});
