/**
 * Tema white-label por tenant. Guardrail do DS: o tenant sobrescreve APENAS
 * --primary/--accent (+ foregrounds derivados) — nunca fundo, texto ou o
 * resto da paleta (styles.css). Cores vêm de business_profile.brand.
 *
 * A cor cadastrada é uma só, mas o app tem quatro campos (Clean claro, Clean
 * escuro, Profundo e Power). Uma cor legível sobre branco costuma sumir sobre
 * o quase-preto e vice-versa: o ciano #00d4ff tinha 10.8:1 no escuro e 1.7:1
 * no claro, e chegou a produção assim porque a validação antiga media contra
 * um fundo só. Por isso aqui a marca vira um PAR — a mesma cor ajustada em
 * luminosidade para cada campo, matiz preservado.
 */

export type TenantBrandColors = {
  primary: string;
  primary_foreground: string;
  accent_foreground: string;
};

const HEX_RE = /^#[0-9a-f]{6}$/i;

const OVERRIDDEN_VARS = ["--primary", "--primary-foreground", "--accent", "--accent-foreground"];

const STYLE_ID = "brand-theme";

// Referências de contraste: o fundo mais desfavorável de cada tema, medido em
// produção. No claro é `--surface` (#f7f9fc), mais claro que os cards. No
// escuro é a superfície do Clean (#111826) — o azulado a deixa mais luminosa
// que o campo do Power (#141416) e que o do Profundo (#050a10), então garantir
// AA nela garante nos outros dois.
const LIGHT_REF = "#f7f9fc";
const DARK_REF = "#111826";
const DARK_TEXT = "#05152b";
const MIN_CONTRAST = 4.5;

export function parseBrandColors(raw: unknown): TenantBrandColors | null {
  if (!raw || typeof raw !== "object") return null;
  const b = (raw as { brand?: unknown }).brand;
  if (!b || typeof b !== "object") return null;
  const o = b as Record<string, unknown>;
  if (
    typeof o.primary !== "string" ||
    typeof o.primary_foreground !== "string" ||
    typeof o.accent_foreground !== "string"
  ) {
    return null;
  }
  if (![o.primary, o.primary_foreground, o.accent_foreground].every((c) => HEX_RE.test(c))) {
    return null;
  }
  return {
    primary: o.primary,
    primary_foreground: o.primary_foreground,
    accent_foreground: o.accent_foreground,
  };
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${[r, g, b].map((v) => clamp(v).toString(16).padStart(2, "0")).join("")}`;
}

function luminance(hex: string): number {
  const canal = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b);
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Mistura `hex` em direção a `alvo` (t de 0 a 1), preservando o matiz relativo. */
function mix(hex: string, alvo: string, t: number): string {
  const [r, g, b] = hexToRgb(hex);
  const [R, G, B] = hexToRgb(alvo);
  return rgbToHex(r + (R - r) * t, g + (G - g) * t, b + (B - b) * t);
}

/**
 * Escurece (ou clareia) a cor em passos de 6% até ela ler no fundo informado.
 * Passos pequenos porque o objetivo é a menor mudança que atinge AA — a marca
 * do cliente deve continuar reconhecível.
 */
function ajustarPara(cor: string, fundo: string, alvo: string): string {
  let c = cor;
  for (let i = 0; i < 30 && contrast(c, fundo) < MIN_CONTRAST; i++) {
    c = mix(c, alvo, 0.06);
  }
  return c;
}

/**
 * `--primary` é fundo de botão E cor de texto: precisa ler contra a página e
 * contra o próprio foreground. Escolhe entre branco e a tinta escura do DS o
 * que tiver mais contraste com a cor já ajustada.
 */
function foregroundDe(cor: string): string {
  return contrast(cor, "#ffffff") >= contrast(cor, DARK_TEXT) ? "#ffffff" : DARK_TEXT;
}

export type BrandPalette = {
  light: { primary: string; foreground: string };
  dark: { primary: string; foreground: string };
};

/** Deriva o par claro/escuro a partir da cor de marca cadastrada. */
export function buildBrandPalette(primary: string): BrandPalette {
  const light = ajustarPara(primary, LIGHT_REF, "#000000");
  const dark = ajustarPara(primary, DARK_REF, "#ffffff");
  return {
    light: { primary: light, foreground: foregroundDe(light) },
    dark: { primary: dark, foreground: foregroundDe(dark) },
  };
}

function blocoCss(seletor: string, cor: string, foreground: string): string {
  const [r, g, b] = hexToRgb(cor);
  return [
    `${seletor}{`,
    `--primary:${cor};`,
    `--primary-foreground:${foreground};`,
    `--accent:rgba(${r}, ${g}, ${b}, 0.12);`,
    `--accent-foreground:${cor};`,
    `}`,
  ].join("");
}

export function applyBrandTheme(brand: TenantBrandColors | null): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;

  // Versões anteriores escreviam inline no <html>, e inline vence qualquer
  // folha: sem limpar, a cor antiga sobreviveria à correção.
  OVERRIDDEN_VARS.forEach((v) => root.style.removeProperty(v));

  const existente = document.getElementById(STYLE_ID);
  if (!brand) {
    existente?.remove();
    return;
  }

  const { light, dark } = buildBrandPalette(brand.primary);
  // `:root:not(.dark)` e `:root.dark` têm especificidade (0,2,0) e vencem os
  // blocos `[data-skin="power"]`/`[data-skin="profundo"]` (0,1,0) sem depender
  // da ordem em que as folhas entram no documento.
  const css =
    blocoCss(":root:not(.dark)", light.primary, light.foreground) +
    blocoCss(":root.dark", dark.primary, dark.foreground);

  const tag = existente ?? document.createElement("style");
  tag.id = STYLE_ID;
  tag.textContent = css;
  if (!existente) document.head.appendChild(tag);
}
