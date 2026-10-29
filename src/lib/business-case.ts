/**
 * Business case da proposta (simulação) — cálculo 100% determinístico.
 *
 * Nenhum número financeiro vem de IA: vendedores vem do CRM (fato), o resto
 * são PREMISSAS editáveis, e os resultados saem das fórmulas abaixo. Divisor
 * <= 0 ou entrada ausente devolve null ("N/A" na tela), nunca Infinity/NaN.
 *
 * Origem: Demo 5 da palestra B2B (23/09/2026) — o agente do catálogo
 * (Arsenal de Marketing) só devolve placeholders de ROI para colar no Claude.
 */

export interface BusinessCaseInput {
  /** Fato do CRM (ou null se não informado). */
  sellers: number | null;
  /** Premissa: horas administrativas por vendedor por dia. */
  adminHoursPerDay: number | null;
  /** Premissa: dias úteis por mês. */
  workDaysPerMonth: number | null;
  /** Premissa: fração automatizável, 0–1 (0,5 = 50%). */
  automatableShare: number | null;
  /** Premissa: custo hora médio carregado, em R$. */
  hourlyCost: number | null;
  /** Valor da oportunidade no CRM, usado como investimento da simulação. */
  investment: number | null;
}

export interface BusinessCaseResult {
  adminHoursPerMonth: number | null;
  savedHoursPerMonth: number | null;
  monthlySaving: number | null;
  annualSaving: number | null;
  paybackMonths: number | null;
  roi12mPercent: number | null;
}

export const BASE_ASSUMPTIONS = {
  adminHoursPerDay: 1,
  workDaysPerMonth: 22,
  automatableShare: 0.5,
  hourlyCost: 60,
} as const;

function ok(n: number | null): n is number {
  return n !== null && Number.isFinite(n) && n >= 0;
}

export function computeBusinessCase(i: BusinessCaseInput): BusinessCaseResult {
  const adminHoursPerMonth =
    ok(i.sellers) && ok(i.adminHoursPerDay) && ok(i.workDaysPerMonth)
      ? i.sellers * i.adminHoursPerDay * i.workDaysPerMonth
      : null;
  const savedHoursPerMonth =
    adminHoursPerMonth !== null && ok(i.automatableShare) && i.automatableShare <= 1
      ? adminHoursPerMonth * i.automatableShare
      : null;
  const monthlySaving =
    savedHoursPerMonth !== null && ok(i.hourlyCost) ? savedHoursPerMonth * i.hourlyCost : null;
  const annualSaving = monthlySaving === null ? null : monthlySaving * 12;
  const investment = ok(i.investment) && i.investment > 0 ? i.investment : null;
  const paybackMonths =
    investment !== null && monthlySaving !== null && monthlySaving > 0
      ? investment / monthlySaving
      : null;
  const roi12mPercent =
    investment !== null && annualSaving !== null
      ? ((annualSaving - investment) / investment) * 100
      : null;
  return {
    adminHoursPerMonth,
    savedHoursPerMonth,
    monthlySaving,
    annualSaving,
    paybackMonths,
    roi12mPercent,
  };
}

/** "1,5" / "1.5" / "50" → número; vazio ou inválido → null. */
export function parseDecimalBR(raw: string): number | null {
  const t = raw.trim().replace(/\s/g, "");
  if (!t) return null;
  const normalized = t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/** "equipe comercial de 12 vendedores" → 12. Só lê o que está escrito no CRM. */
export function sellersFromText(text: string | null | undefined): number | null {
  const m = (text ?? "").match(/(\d+)\s+vendedor(?:es|as)?/i);
  return m ? Number(m[1]) : null;
}

const NA = "N/A";

export function fmtBRL(v: number | null): string {
  return v === null
    ? NA
    : v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}

export function fmtNumber(v: number | null, digits = 0): string {
  return v === null
    ? NA
    : v.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtPercent(v: number | null, digits = 1): string {
  return v === null ? NA : `${fmtNumber(v, digits)}%`;
}
