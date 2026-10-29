import { describe, expect, it } from "vitest";

import {
  BASE_ASSUMPTIONS,
  computeBusinessCase,
  fmtBRL,
  fmtNumber,
  fmtPercent,
  parseDecimalBR,
  sellersFromText,
} from "./business-case";

const nbsp = (s: string) => s.replace(/\u00a0/g, " ");
const BASE = { sellers: 12, investment: 180000, ...BASE_ASSUMPTIONS };

describe("computeBusinessCase — cenário Base da Demo 5 (Atlas Industrial)", () => {
  const r = computeBusinessCase(BASE);

  it("horas administrativas = 12 × 1 × 22 = 264", () => {
    expect(r.adminHoursPerMonth).toBe(264);
  });
  it("horas economizadas = 264 × 50% = 132", () => {
    expect(r.savedHoursPerMonth).toBe(132);
  });
  it("economia mensal = 132 × R$ 60 = R$ 7.920", () => {
    expect(r.monthlySaving).toBe(7920);
  });
  it("economia anual = R$ 95.040", () => {
    expect(r.annualSaving).toBe(95040);
  });
  it("payback = 180.000 / 7.920 ≈ 22,73 meses", () => {
    expect(r.paybackMonths).toBeCloseTo(22.7273, 3);
    expect(fmtNumber(r.paybackMonths, 1)).toBe("22,7");
  });
  it("ROI 12 meses fica negativo (−47,2%) e não é maquiado", () => {
    expect(r.roi12mPercent).toBeCloseTo(-47.2, 1);
    expect(fmtPercent(r.roi12mPercent)).toBe("-47,2%");
  });
});

describe("computeBusinessCase — guardas", () => {
  it("premissa alterada recalcula tudo", () => {
    const r = computeBusinessCase({ ...BASE, adminHoursPerDay: 2 });
    expect(r.adminHoursPerMonth).toBe(528);
    expect(r.monthlySaving).toBe(15840);
    expect(r.paybackMonths).toBeCloseTo(11.3636, 3);
  });
  it("valores decimais", () => {
    const r = computeBusinessCase({ ...BASE, adminHoursPerDay: 1.5, automatableShare: 0.25 });
    expect(r.adminHoursPerMonth).toBe(396);
    expect(r.savedHoursPerMonth).toBe(99);
  });
  it("percentual zero → economia zero, payback N/A, ROI −100%", () => {
    const r = computeBusinessCase({ ...BASE, automatableShare: 0 });
    expect(r.monthlySaving).toBe(0);
    expect(r.paybackMonths).toBeNull();
    expect(r.roi12mPercent).toBe(-100);
  });
  it("investimento zero → payback e ROI N/A", () => {
    const r = computeBusinessCase({ ...BASE, investment: 0 });
    expect(r.paybackMonths).toBeNull();
    expect(r.roi12mPercent).toBeNull();
    expect(fmtPercent(r.roi12mPercent)).toBe("N/A");
  });
  it("vendedores null (não informado no CRM) → tudo N/A", () => {
    const r = computeBusinessCase({ ...BASE, sellers: null });
    expect(Object.values(r).every((v) => v === null)).toBe(true);
  });
  it("percentual acima de 100% e valor negativo são recusados", () => {
    expect(computeBusinessCase({ ...BASE, automatableShare: 1.5 }).savedHoursPerMonth).toBeNull();
    expect(computeBusinessCase({ ...BASE, hourlyCost: -1 }).monthlySaving).toBeNull();
  });
});

describe("entrada e formatação", () => {
  it("parseDecimalBR aceita vírgula e ponto", () => {
    expect(parseDecimalBR("1,5")).toBe(1.5);
    expect(parseDecimalBR("1.5")).toBe(1.5);
    expect(parseDecimalBR("1.000,50")).toBe(1000.5);
    expect(parseDecimalBR("")).toBeNull();
    expect(parseDecimalBR("abc")).toBeNull();
  });
  it("vendedores só vêm do texto do CRM", () => {
    expect(sellersFromText("uma equipe comercial de 12 vendedores. Vende")).toBe(12);
    expect(sellersFromText("aproximadamente 180 funcionários")).toBeNull();
    expect(sellersFromText(null)).toBeNull();
  });
  it("BRL sem centavos", () => {
    expect(nbsp(fmtBRL(7920))).toBe("R$ 7.920");
    expect(nbsp(fmtBRL(95040))).toBe("R$ 95.040");
    expect(fmtBRL(null)).toBe("N/A");
  });
});
