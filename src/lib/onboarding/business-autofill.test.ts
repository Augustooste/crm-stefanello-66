import { describe, expect, it } from "vitest";
import {
  autoFillEntries,
  mergeBusinessProfile,
  readExtractedBusiness,
  type ExtractedBusiness,
} from "@/lib/onboarding/business-autofill";

function field<T>(value: T | null, confidence = 0.95, source = "json-ld") {
  return { value, source, confidence };
}

function business(over: Record<string, unknown> = {}): ExtractedBusiness {
  return {
    company_name: field("Freedom Digital Hub"),
    segment: field("marketing digital"),
    city: field("São Paulo"),
    region: field("SP"),
    services: field(["SEO", "Tráfego pago"]),
    price_range: field("R$ 1.000 a R$ 5.000"),
    website_url: field("https://freedomdigitalhub.com.br"),
    portfolio_urls: field(null, 0, "none"),
    opening_hours: field([{ dayOfWeek: "monday", opens: "09:00", closes: "18:00" }]),
    notes: field("Agência de marketing"),
    ...over,
  } as unknown as ExtractedBusiness;
}

describe("business-autofill", () => {
  it("resposta sem objeto business devolve null", () => {
    expect(readExtractedBusiness(undefined)).toBeNull();
    expect(readExtractedBusiness({})).toBeNull();
  });

  it("lê o envelope e marca confiança baixa como não aplicável", () => {
    const parsed = readExtractedBusiness({
      segment: { value: "clínica", source: "ai", confidence: 0.4 },
    });
    expect(parsed?.segment.value).toBe("clínica");
    const entries = autoFillEntries(parsed);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.applicable).toBe(false);
  });

  it("preenche apenas campos vazios do perfil", () => {
    const { profile, applied } = mergeBusinessProfile(
      { segment: "escolhido pelo usuário", city: "" },
      business(),
    );
    expect(profile.segment).toBe("escolhido pelo usuário");
    expect(applied.segment).toBeUndefined();
    expect(profile.city).toBe("São Paulo — SP");
    expect(applied.city).toBe("json-ld");
    expect(profile.offerings.map((o) => o.name)).toEqual(["SEO", "Tráfego pago"]);
    expect(profile.price_range).toBe("R$ 1.000 a R$ 5.000");
  });

  it("ignora dados abaixo do limiar de confiança", () => {
    const { profile, applied } = mergeBusinessProfile(
      {},
      business({ segment: field("chute", 0.3, "ai") }),
    );
    expect(profile.segment).toBe("");
    expect(applied.segment).toBeUndefined();
  });

  it("é idempotente: reaplicar não altera o resultado", () => {
    const first = mergeBusinessProfile({}, business());
    const second = mergeBusinessProfile(first.profile, business());
    expect(second.profile).toEqual(first.profile);
    expect(Object.keys(second.applied)).toHaveLength(0);
  });

  it("sem dados extraídos o perfil segue intacto", () => {
    const { profile, applied } = mergeBusinessProfile({ segment: "x" }, null);
    expect(profile.segment).toBe("x");
    expect(applied).toEqual({});
  });

  it("aplica horários do site quando o usuário não mexeu neles", () => {
    const { profile, applied } = mergeBusinessProfile({}, business());
    expect(applied.opening_hours).toBe("json-ld");
    expect(profile.hours.mon).toEqual({ enabled: true, open: "09:00", close: "18:00" });
    expect(profile.hours.sun.enabled).toBe(false);
  });
});
