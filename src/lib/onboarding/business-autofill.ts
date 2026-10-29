// Auto-preenchimento do wizard a partir dos dados extraídos do site.
//
// Prioridade fixa, por campo: valor do usuário > valor extraído com confiança
// suficiente > vazio. Nada aqui sobrescreve escolha humana.

import {
  emptyBusinessProfile,
  normalizeBusinessProfile,
  type BusinessProfile,
} from "@/components/settings/BusinessProfileForm";

/** Abaixo disso o dado aparece como sugestão no preview, mas não é aplicado. */
export const AUTO_FILL_MIN_CONFIDENCE = 0.8;

export type FactSource = "json-ld" | "meta" | "ai" | "none";

export type ExtractedField<T> = {
  value: T | null;
  source: FactSource;
  confidence: number;
};

export type ExtractedOpeningHours = { dayOfWeek: string; opens: string; closes: string };

export type ExtractedBusiness = {
  company_name: ExtractedField<string>;
  segment: ExtractedField<string>;
  city: ExtractedField<string>;
  region: ExtractedField<string>;
  services: ExtractedField<string[]>;
  price_range: ExtractedField<string>;
  website_url: ExtractedField<string>;
  portfolio_urls: ExtractedField<string[]>;
  opening_hours: ExtractedField<ExtractedOpeningHours[]>;
  notes: ExtractedField<string>;
};

const FIELD_KEYS: (keyof ExtractedBusiness)[] = [
  "company_name",
  "segment",
  "city",
  "region",
  "services",
  "price_range",
  "website_url",
  "portfolio_urls",
  "opening_hours",
  "notes",
];

export const FIELD_LABEL: Record<keyof ExtractedBusiness, string> = {
  company_name: "Empresa",
  segment: "Segmento",
  city: "Cidade",
  region: "Estado / região",
  services: "Serviços",
  price_range: "Faixa de preço",
  website_url: "Site",
  portfolio_urls: "Links",
  opening_hours: "Horário",
  notes: "Observações",
};

export const SOURCE_LABEL: Record<FactSource, string> = {
  "json-ld": "dados estruturados",
  meta: "metadados",
  ai: "IA",
  none: "não encontrado",
};

const DAY_TO_KEY: Record<string, string> = {
  monday: "mon",
  tuesday: "tue",
  wednesday: "wed",
  thursday: "thu",
  friday: "fri",
  saturday: "sat",
  sunday: "sun",
};

function emptyField<T>(): ExtractedField<T> {
  return { value: null, source: "none", confidence: 0 };
}

function readField(raw: unknown): ExtractedField<unknown> {
  if (!raw || typeof raw !== "object") return emptyField();
  const r = raw as Record<string, unknown>;
  const source: FactSource =
    r.source === "json-ld" || r.source === "meta" || r.source === "ai" ? r.source : "none";
  const confidence = typeof r.confidence === "number" ? Math.max(0, Math.min(1, r.confidence)) : 0;
  const value = r.value === undefined ? null : r.value;
  return { value, source, confidence };
}

/** Lê o objeto `business` do envelope. Resposta sem `business` devolve null. */
export function readExtractedBusiness(raw: unknown): ExtractedBusiness | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out = {} as Record<string, ExtractedField<unknown>>;
  let any = false;
  for (const key of FIELD_KEYS) {
    const field = readField(r[key]);
    if (field.value !== null && field.value !== undefined) any = true;
    out[key] = field;
  }
  if (!any) return null;
  return out as unknown as ExtractedBusiness;
}

function isFilled(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export type AutoFillEntry = {
  key: keyof ExtractedBusiness;
  label: string;
  display: string;
  source: FactSource;
  confidence: number;
  /** Confiança suficiente para aplicar automaticamente. */
  applicable: boolean;
};

function display(key: keyof ExtractedBusiness, value: unknown): string {
  if (key === "opening_hours" && Array.isArray(value)) {
    return (value as ExtractedOpeningHours[])
      .map((h) => `${h.dayOfWeek} ${h.opens}–${h.closes}`)
      .join(", ");
  }
  if (Array.isArray(value)) return value.join(", ");
  return String(value ?? "");
}

/** Lista para o preview: só campos com algum valor encontrado. */
export function autoFillEntries(business: ExtractedBusiness | null): AutoFillEntry[] {
  if (!business) return [];
  const entries: AutoFillEntry[] = [];
  for (const key of FIELD_KEYS) {
    const field = (business as unknown as Record<string, ExtractedField<unknown>>)[key];
    if (!field || !isFilled(field.value)) continue;
    entries.push({
      key,
      label: FIELD_LABEL[key],
      display: display(key, field.value),
      source: field.source,
      confidence: field.confidence,
      applicable: field.confidence >= AUTO_FILL_MIN_CONFIDENCE,
    });
  }
  return entries;
}

export type MergeResult = {
  profile: BusinessProfile & { notes?: string };
  /** Campos efetivamente aplicados e de onde vieram (auditoria). */
  applied: Record<string, FactSource>;
};

function usable<T>(field: ExtractedField<T> | undefined): T | null {
  if (!field) return null;
  if (!isFilled(field.value)) return null;
  if (field.confidence < AUTO_FILL_MIN_CONFIDENCE) return null;
  return field.value as T;
}

/**
 * Aplica os dados extraídos sobre o perfil atual sem tocar em nada que o
 * usuário já preencheu. Idempotente: reaplicar não muda o resultado.
 */
export function mergeBusinessProfile(
  currentRaw: unknown,
  business: ExtractedBusiness | null,
  options: { skip?: (keyof ExtractedBusiness)[] } = {},
): MergeResult {
  const current = normalizeBusinessProfile(currentRaw) as BusinessProfile & {
    notes?: string;
    region?: string;
  };
  const profile: BusinessProfile & { notes?: string; region?: string } = {
    ...current,
    hours: { ...current.hours },
    offerings: [...current.offerings],
    team: [...current.team],
  };
  const applied: Record<string, FactSource> = {};
  if (!business) return { profile, applied };

  const skip = new Set(options.skip ?? []);
  const take = <T>(key: keyof ExtractedBusiness): T | null => {
    if (skip.has(key)) return null;
    return usable((business as unknown as Record<string, ExtractedField<T>>)[key]);
  };
  const mark = (key: keyof ExtractedBusiness) => {
    applied[key] = (business as unknown as Record<string, ExtractedField<unknown>>)[key].source;
  };

  const segment = take<string>("segment");
  if (segment && !isFilled(profile.segment)) {
    profile.segment = segment;
    mark("segment");
  }

  const city = take<string>("city");
  const region = take<string>("region");
  if (city && !isFilled(profile.city)) {
    profile.city = region ? `${city} — ${region}` : city;
    mark("city");
    if (region) mark("region");
  }

  const services = take<string[]>("services");
  if (services && profile.offerings.length === 0) {
    profile.offerings = services.map((name) => ({ name }));
    mark("services");
  }

  const priceRange = take<string>("price_range");
  if (priceRange && !isFilled(profile.price_range)) {
    profile.price_range = priceRange;
    mark("price_range");
  }

  const website = take<string>("website_url") ?? take<string[]>("portfolio_urls")?.[0] ?? null;
  if (website && !isFilled(profile.portfolio_url)) {
    profile.portfolio_url = website;
    mark("website_url");
  }

  const hours = take<ExtractedOpeningHours[]>("opening_hours");
  if (hours && hours.length > 0) {
    const base = emptyBusinessProfile().hours;
    // Só aplica quando o usuário ainda não mexeu no horário (valor default).
    const untouched = JSON.stringify(profile.hours) === JSON.stringify(base);
    if (untouched) {
      const next = { ...base };
      for (const key of Object.keys(next)) next[key] = { ...next[key], enabled: false };
      for (const h of hours) {
        const key = DAY_TO_KEY[h.dayOfWeek];
        if (!key || !next[key]) continue;
        next[key] = { enabled: true, open: h.opens, close: h.closes };
      }
      profile.hours = next;
      mark("opening_hours");
    }
  }

  const notes = take<string>("notes");
  if (notes && !isFilled(profile.notes)) {
    profile.notes = notes;
    mark("notes");
  }

  return { profile, applied };
}
