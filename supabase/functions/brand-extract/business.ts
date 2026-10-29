// Extração de dados empresariais do site informado no wizard.
//
// Regra central: nada é inventado. Cada campo carrega `value`, `source` e
// `confidence`; sem evidência o campo volta {value:null, source:"none",
// confidence:0}. Extrator que falha vira "none" isolado — nunca derruba a
// extração inteira.

export type FactSource = "json-ld" | "meta" | "ai" | "none";

export interface ExtractedField<T> {
  value: T | null;
  source: FactSource;
  confidence: number;
}

export interface ExtractedOpeningHours {
  /** "monday".."sunday" — chave de dado, nunca traduzida. */
  dayOfWeek: string;
  opens: string;
  closes: string;
}

export interface ExtractedBusiness {
  company_name: ExtractedField<string>;
  segment: ExtractedField<string>;
  city: ExtractedField<string>;
  region: ExtractedField<string>;
  services: ExtractedField<string[]>;
  /** Texto livre — mesmo formato do campo do wizard ("R$ 200 a R$ 1.500"). */
  price_range: ExtractedField<string>;
  website_url: ExtractedField<string>;
  portfolio_urls: ExtractedField<string[]>;
  opening_hours: ExtractedField<ExtractedOpeningHours[]>;
  notes: ExtractedField<string>;
}

export const MAX_INTERNAL_PAGES = 4;
export const MAX_TEXT_CHARS = 12_000;
const MAX_SERVICES = 12;

const BUSINESS_TYPES = new Set([
  "organization",
  "localbusiness",
  "professionalservice",
  "store",
  "person",
  "corporation",
  "medicalorganization",
  "medicalbusiness",
  "healthandbeautybusiness",
  "dentist",
  "homeandconstructionbusiness",
  "foodestablishment",
]);

const OFFER_TYPES = new Set(["product", "service", "offer", "offercatalog", "itemlist"]);

const DAY_MAP: Record<string, string> = {
  monday: "monday",
  tuesday: "tuesday",
  wednesday: "wednesday",
  thursday: "thursday",
  friday: "friday",
  saturday: "saturday",
  sunday: "sunday",
  segunda: "monday",
  terca: "tuesday",
  quarta: "wednesday",
  quinta: "thursday",
  sexta: "friday",
  sabado: "saturday",
  domingo: "sunday",
};

const PRIORITY_PATHS = [
  "sobre",
  "quem-somos",
  "empresa",
  "servicos",
  "solucoes",
  "produtos",
  "precos",
  "planos",
  "contato",
  "equipe",
  "about",
  "services",
  "solutions",
  "products",
  "pricing",
  "contact",
  "team",
];

function none<T>(): ExtractedField<T> {
  return { value: null, source: "none", confidence: 0 };
}

function field<T>(value: T | null, source: FactSource, confidence: number): ExtractedField<T> {
  if (value === null || value === undefined) return none<T>();
  if (typeof value === "string" && value.trim() === "") return none<T>();
  if (Array.isArray(value) && value.length === 0) return none<T>();
  return { value, source, confidence: Math.max(0, Math.min(1, confidence)) };
}

export function emptyBusiness(): ExtractedBusiness {
  return {
    company_name: none<string>(),
    segment: none<string>(),
    city: none<string>(),
    region: none<string>(),
    services: none<string[]>(),
    price_range: none<string>(),
    website_url: none<string>(),
    portfolio_urls: none<string[]>(),
    opening_hours: none<ExtractedOpeningHours[]>(),
    notes: none<string>(),
  };
}

// ─── JSON-LD ───────────────────────────────────────────────────────────────

/** Lê todos os blocos ld+json. Bloco inválido é ignorado isoladamente. */
export function extractJsonLdNodes(html: string): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const push = (value: unknown, depth = 0) => {
    if (!value || depth > 4) return;
    if (Array.isArray(value)) {
      for (const item of value) push(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    nodes.push(node);
    if (node["@graph"]) push(node["@graph"], depth + 1);
  };
  for (const match of html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    const raw = (match[1] ?? "").trim();
    if (!raw) continue;
    try {
      push(JSON.parse(raw));
    } catch {
      // JSON-LD malformado: ignora só este bloco.
    }
  }
  return nodes;
}

function typesOf(node: Record<string, unknown>): string[] {
  const t = node["@type"];
  const list = Array.isArray(t) ? t : [t];
  return list.filter((v): v is string => typeof v === "string").map((v) => v.toLowerCase());
}

function text(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return text(obj.name) ?? text(obj["@value"]) ?? null;
  }
  return null;
}

function normalizeDay(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const key = raw
    .split("/")
    .pop()!
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/-feira/, "")
    .trim();
  return DAY_MAP[key] ?? null;
}

function normalizeTime(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const m = raw.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  if (Number.isNaN(h) || h > 23) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

function collectOffers(node: unknown, out: string[], depth = 0): void {
  if (!node || depth > 4 || out.length >= MAX_SERVICES) return;
  if (Array.isArray(node)) {
    for (const item of node) collectOffers(item, out, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const name = text(obj.name);
  if (name && !out.includes(name)) out.push(name);
  for (const key of ["itemOffered", "itemListElement", "offers", "hasOfferCatalog", "item"]) {
    if (obj[key]) collectOffers(obj[key], out, depth + 1);
  }
}

export type JsonLdFacts = {
  company_name: string | null;
  segment: string | null;
  city: string | null;
  region: string | null;
  services: string[];
  price_range: string | null;
  website_url: string | null;
  portfolio_urls: string[];
  opening_hours: ExtractedOpeningHours[];
  notes: string | null;
};

export function factsFromJsonLd(nodes: Record<string, unknown>[]): JsonLdFacts {
  const facts: JsonLdFacts = {
    company_name: null,
    segment: null,
    city: null,
    region: null,
    services: [],
    price_range: null,
    website_url: null,
    portfolio_urls: [],
    opening_hours: [],
    notes: null,
  };

  for (const node of nodes) {
    let types: string[] = [];
    try {
      types = typesOf(node);
    } catch {
      continue;
    }
    const isBusiness = types.some((t) => BUSINESS_TYPES.has(t));
    const isOffer = types.some((t) => OFFER_TYPES.has(t));

    if (isBusiness) {
      facts.company_name ??= text(node.name) ?? text(node.legalName);
      facts.segment ??=
        text(node.additionalType) ??
        (types.find((t) => t !== "organization" && t !== "thing") ?? null);
      facts.notes ??= text(node.description);
      facts.website_url ??= typeof node.url === "string" ? node.url.trim() : null;
      facts.price_range ??= text(node.priceRange);

      const address = node.address as Record<string, unknown> | undefined;
      if (address && typeof address === "object") {
        facts.city ??= text(address.addressLocality);
        facts.region ??= text(address.addressRegion);
      }

      const sameAs = node.sameAs;
      const links = Array.isArray(sameAs) ? sameAs : sameAs ? [sameAs] : [];
      for (const link of links) {
        if (typeof link === "string" && /^https?:\/\//i.test(link.trim())) {
          const url = link.trim();
          if (!facts.portfolio_urls.includes(url)) facts.portfolio_urls.push(url);
        }
      }

      const hours = node.openingHoursSpecification;
      const hourList = Array.isArray(hours) ? hours : hours ? [hours] : [];
      for (const spec of hourList) {
        if (!spec || typeof spec !== "object") continue;
        const s = spec as Record<string, unknown>;
        const opens = normalizeTime(s.opens);
        const closes = normalizeTime(s.closes);
        if (!opens || !closes) continue;
        const days = Array.isArray(s.dayOfWeek) ? s.dayOfWeek : [s.dayOfWeek];
        for (const d of days) {
          const day = normalizeDay(d);
          if (!day || facts.opening_hours.some((h) => h.dayOfWeek === day)) continue;
          facts.opening_hours.push({ dayOfWeek: day, opens, closes });
        }
      }

      if (node.hasOfferCatalog || node.makesOffer || node.offers) {
        collectOffers(node.hasOfferCatalog ?? node.makesOffer ?? node.offers, facts.services);
      }
    }

    if (isOffer && facts.services.length < MAX_SERVICES) {
      collectOffers(node, facts.services);
    }
  }

  facts.services = facts.services.slice(0, MAX_SERVICES);
  return facts;
}

// ─── Texto visível ─────────────────────────────────────────────────────────

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

/** Texto limpo do HTML: sem script/style/svg, com alt/aria-label preservados. */
export function extractVisibleText(html: string, maxChars = MAX_TEXT_CHARS): string {
  let body = html;
  for (const tag of ["script", "style", "svg", "noscript", "template", "iframe"]) {
    body = body.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
  }
  body = body.replace(/<!--[\s\S]*?-->/g, " ");

  // Alt/aria-label têm conteúdo útil (nome de serviço em card com imagem).
  const extras: string[] = [];
  for (const m of body.matchAll(/\b(?:alt|aria-label)\s*=\s*["']([^"']{3,120})["']/gi)) {
    const value = decodeEntities(m[1]).trim();
    if (value && !extras.includes(value)) extras.push(value);
  }

  body = body.replace(/<(?:br|\/p|\/li|\/h[1-6]|\/div|\/section|\/tr)[^>]*>/gi, "\n");
  body = body.replace(/<[^>]+>/g, " ");
  body = decodeEntities(body);

  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line.length < 2) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue; // corta repetição excessiva (menus, rodapés)
    seen.add(key);
    lines.push(line);
  }
  for (const extra of extras.slice(0, 40)) {
    const key = extra.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(extra);
  }
  return lines.join("\n").slice(0, maxChars);
}

// ─── Crawl interno controlado ──────────────────────────────────────────────

/**
 * Descobre no máximo `max` páginas internas relevantes do MESMO host.
 * `resolve` recebe href cru + base e devolve URL absoluta (ou lança).
 */
export function discoverInternalLinks(
  html: string,
  baseUrl: string,
  resolve: (href: string, base: string) => string,
  max = MAX_INTERNAL_PAGES,
): string[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const scored = new Map<string, number>();
  for (const tag of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const href = (tag[1] ?? "").trim();
    if (!href || href.startsWith("#") || /^(?:mailto|tel|javascript|data):/i.test(href)) continue;
    let absolute: string;
    try {
      absolute = resolve(href, baseUrl);
    } catch {
      continue;
    }
    let url: URL;
    try {
      url = new URL(absolute);
    } catch {
      continue;
    }
    if (url.hostname !== base.hostname) continue;
    url.hash = "";
    const path = url.pathname.toLowerCase();
    if (path === base.pathname.toLowerCase() || path === "/") continue;
    if (/\.(?:pdf|jpg|jpeg|png|gif|webp|svg|zip|mp4|css|js)$/i.test(path)) continue;
    const rank = PRIORITY_PATHS.findIndex((p) => path.includes(p));
    if (rank < 0) continue;
    const key = url.href;
    if (!scored.has(key) || scored.get(key)! > rank) scored.set(key, rank);
  }
  return [...scored.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, max)
    .map(([url]) => url);
}

// ─── IA: resultado estruturado ─────────────────────────────────────────────

export const AI_BUSINESS_RULE =
  "Use somente informações explicitamente suportadas pelo conteúdo fornecido. Não invente, complete ou presuma dados. Quando não houver evidência suficiente, retorne null.";

export function buildBusinessPrompt(input: {
  url: string;
  title: string | null;
  description: string | null;
  jsonLd: JsonLdFacts;
  visibleText: string;
  internalPages: Array<{ url: string; text: string }>;
}): string {
  const paginas = input.internalPages
    .map((p) => `--- ${p.url} ---\n${p.text.slice(0, 3000)}`)
    .join("\n\n");
  return [
    "Você extrai dados empresariais confiáveis do conteúdo público de um site, para pré-preencher um cadastro.",
    AI_BUSINESS_RULE,
    'Responda SOMENTE JSON no formato: {"company_name":{"value":string|null,"confidence":number},"segment":{...},"city":{...},"region":{...},"services":{"value":string[]|null,"confidence":number},"price_range":{...},"website_url":{...},"opening_hours":{"value":[{"dayOfWeek":"monday","opens":"09:00","closes":"18:00"}]|null,"confidence":number},"notes":{...}}',
    "confidence é 0..1 e reflete o quanto o conteúdo sustenta o valor. Texto em pt-BR. notes é um resumo curto do negócio (máx. 400 caracteres).",
    "",
    `URL: ${input.url}`,
    `Título: ${input.title ?? "nenhum"}`,
    `Descrição: ${input.description ?? "nenhuma"}`,
    `Dados estruturados já encontrados (JSON-LD): ${JSON.stringify(input.jsonLd)}`,
    "",
    "Conteúdo da página inicial:",
    input.visibleText.slice(0, 8000),
    paginas ? `\nPáginas internas:\n${paginas}` : "",
  ].join("\n");
}

type AiField = { value: unknown; confidence: unknown };

function aiString(raw: unknown, max = 200): { value: string | null; confidence: number } {
  const f = (raw ?? {}) as AiField;
  const value = typeof f.value === "string" && f.value.trim() ? f.value.trim().slice(0, max) : null;
  const confidence = typeof f.confidence === "number" ? Math.max(0, Math.min(1, f.confidence)) : 0;
  return { value, confidence: value ? confidence : 0 };
}

function aiList(raw: unknown): { value: string[] | null; confidence: number } {
  const f = (raw ?? {}) as AiField;
  const list = Array.isArray(f.value)
    ? f.value
        .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
        .map((v) => v.trim().slice(0, 120))
        .slice(0, MAX_SERVICES)
    : [];
  const confidence = typeof f.confidence === "number" ? Math.max(0, Math.min(1, f.confidence)) : 0;
  return { value: list.length ? list : null, confidence: list.length ? confidence : 0 };
}

function aiHours(raw: unknown): { value: ExtractedOpeningHours[] | null; confidence: number } {
  const f = (raw ?? {}) as AiField;
  const list: ExtractedOpeningHours[] = [];
  if (Array.isArray(f.value)) {
    for (const item of f.value) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const day = normalizeDay(o.dayOfWeek);
      const opens = normalizeTime(o.opens);
      const closes = normalizeTime(o.closes);
      if (!day || !opens || !closes) continue;
      if (list.some((h) => h.dayOfWeek === day)) continue;
      list.push({ dayOfWeek: day, opens, closes });
    }
  }
  const confidence = typeof f.confidence === "number" ? Math.max(0, Math.min(1, f.confidence)) : 0;
  return { value: list.length ? list : null, confidence: list.length ? confidence : 0 };
}

export type AiBusiness = ReturnType<typeof parseAiBusiness>;

/** Converte a resposta crua da IA. Qualquer formato inesperado vira vazio. */
export function parseAiBusiness(raw: string): {
  company_name: { value: string | null; confidence: number };
  segment: { value: string | null; confidence: number };
  city: { value: string | null; confidence: number };
  region: { value: string | null; confidence: number };
  services: { value: string[] | null; confidence: number };
  price_range: { value: string | null; confidence: number };
  website_url: { value: string | null; confidence: number };
  opening_hours: { value: ExtractedOpeningHours[] | null; confidence: number };
  notes: { value: string | null; confidence: number };
} {
  const empty = {
    company_name: { value: null, confidence: 0 },
    segment: { value: null, confidence: 0 },
    city: { value: null, confidence: 0 },
    region: { value: null, confidence: 0 },
    services: { value: null, confidence: 0 },
    price_range: { value: null, confidence: 0 },
    website_url: { value: null, confidence: 0 },
    opening_hours: { value: null, confidence: 0 },
    notes: { value: null, confidence: 0 },
  } as ReturnType<typeof parseAiBusiness>;
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  if (!cleaned) return empty;
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(cleaned);
    if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
    parsed = value as Record<string, unknown>;
  } catch {
    return empty;
  }
  return {
    company_name: aiString(parsed.company_name, 120),
    segment: aiString(parsed.segment, 80),
    city: aiString(parsed.city, 80),
    region: aiString(parsed.region, 80),
    services: aiList(parsed.services),
    price_range: aiString(parsed.price_range, 80),
    website_url: aiString(parsed.website_url, 300),
    opening_hours: aiHours(parsed.opening_hours),
    notes: aiString(parsed.notes, 400),
  };
}

// ─── Consolidação ──────────────────────────────────────────────────────────

const JSON_LD_CONFIDENCE = 0.95;
const META_CONFIDENCE = 0.85;
/** Teto da IA: complemento nunca vale mais que dado estruturado do site. */
const AI_MAX_CONFIDENCE = 0.9;

function fromAi<T>(input: { value: T | null; confidence: number }): ExtractedField<T> {
  return field<T>(input.value, "ai", Math.min(input.confidence, AI_MAX_CONFIDENCE));
}

function pick<T>(...candidates: ExtractedField<T>[]): ExtractedField<T> {
  for (const c of candidates) if (c.value !== null) return c;
  return none<T>();
}

export function consolidateBusiness(input: {
  jsonLd: JsonLdFacts;
  meta: { title: string | null; description: string | null; canonical: string | null };
  ai: ReturnType<typeof parseAiBusiness> | null;
  finalUrl: string;
}): ExtractedBusiness {
  const { jsonLd, meta, finalUrl } = input;
  const ai = input.ai;
  const empty = emptyBusiness();

  return {
    company_name: pick(
      field(jsonLd.company_name, "json-ld", JSON_LD_CONFIDENCE),
      ai ? fromAi(ai.company_name) : empty.company_name,
      field(meta.title, "meta", META_CONFIDENCE),
    ),
    segment: pick(
      field(jsonLd.segment, "json-ld", JSON_LD_CONFIDENCE),
      ai ? fromAi(ai.segment) : empty.segment,
    ),
    city: pick(field(jsonLd.city, "json-ld", JSON_LD_CONFIDENCE), ai ? fromAi(ai.city) : empty.city),
    region: pick(
      field(jsonLd.region, "json-ld", JSON_LD_CONFIDENCE),
      ai ? fromAi(ai.region) : empty.region,
    ),
    services: pick(
      field(jsonLd.services, "json-ld", JSON_LD_CONFIDENCE),
      ai ? fromAi(ai.services) : empty.services,
    ),
    price_range: pick(
      field(jsonLd.price_range, "json-ld", JSON_LD_CONFIDENCE),
      ai ? fromAi(ai.price_range) : empty.price_range,
    ),
    website_url: pick(
      field(jsonLd.website_url, "json-ld", JSON_LD_CONFIDENCE),
      field(meta.canonical, "meta", META_CONFIDENCE),
      field(finalUrl, "meta", META_CONFIDENCE),
    ),
    portfolio_urls: field(
      jsonLd.portfolio_urls.length ? jsonLd.portfolio_urls : null,
      "json-ld",
      JSON_LD_CONFIDENCE,
    ),
    opening_hours: pick(
      field(
        jsonLd.opening_hours.length ? jsonLd.opening_hours : null,
        "json-ld",
        JSON_LD_CONFIDENCE,
      ),
      ai ? fromAi(ai.opening_hours) : empty.opening_hours,
    ),
    notes: pick(
      field(jsonLd.notes, "json-ld", JSON_LD_CONFIDENCE),
      ai ? fromAi(ai.notes) : empty.notes,
      field(meta.description, "meta", META_CONFIDENCE),
    ),
  };
}

/** Quantos campos vieram com valor — usado no diagnóstico da tela. */
export function countFilledFields(business: ExtractedBusiness): number {
  return Object.values(business as unknown as Record<string, ExtractedField<unknown>>).filter(
    (f) => f.value !== null,
  ).length;
}
