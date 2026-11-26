import { describe, expect, it } from "vitest";
import { canOfferCommercialCredit, formatCreditNumber } from "./DealCommercialCreditSection";

describe("crédito comercial", () => {
  it("formata com ponto de milhar e sem decimais", () => {
    expect(formatCreditNumber(12345.6)).toBe("12.346");
  });
  it("oferece só para à vista/sem aprovação, sem grant ativo e com alçada", () => {
    expect(canOfferCommercialCredit("a_vista", false, true)).toBe(true);
    expect(canOfferCommercialCredit("sem_aprovacao", false, true)).toBe(true);
    expect(canOfferCommercialCredit("credito_aprovado", false, true)).toBe(false);
    expect(canOfferCommercialCredit("a_vista", true, true)).toBe(false);
    expect(canOfferCommercialCredit("a_vista", false, false)).toBe(false);
  });
});
