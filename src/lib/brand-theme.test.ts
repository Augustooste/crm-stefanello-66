import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyBrandTheme,
  buildBrandPalette,
  contrast,
  parseBrandColors,
  type TenantBrandColors,
} from "./brand-theme";

const OVERRIDDEN_VARS = ["--primary", "--primary-foreground", "--accent", "--accent-foreground"];

// Os quatro campos onde a marca aparece. O do Power (#141416) é o mais claro
// dos escuros, e o `--surface` do claro é pior caso que o branco puro.
const FUNDOS_ESCUROS = { "clean-escuro": "#111826", profundo: "#050a10", power: "#141416" };
const FUNDO_CLARO = "#f7f9fc";

describe("parseBrandColors", () => {
  it("retorna null quando raw não é objeto", () => {
    expect(parseBrandColors(null)).toBeNull();
    expect(parseBrandColors(undefined)).toBeNull();
    expect(parseBrandColors("string")).toBeNull();
    expect(parseBrandColors(42)).toBeNull();
  });

  it("retorna null quando não há campo brand", () => {
    expect(parseBrandColors({})).toBeNull();
  });

  it("retorna null quando brand não é objeto", () => {
    expect(parseBrandColors({ brand: "x" })).toBeNull();
    expect(parseBrandColors({ brand: null })).toBeNull();
  });

  it("retorna null quando falta algum campo obrigatório", () => {
    expect(
      parseBrandColors({ brand: { primary: "#112233", primary_foreground: "#ffffff" } }),
    ).toBeNull();
  });

  it("retorna null quando algum campo não é string", () => {
    expect(
      parseBrandColors({
        brand: { primary: 123, primary_foreground: "#ffffff", accent_foreground: "#000000" },
      }),
    ).toBeNull();
  });

  it("retorna null quando algum campo não é hex válido", () => {
    expect(
      parseBrandColors({
        brand: { primary: "blue", primary_foreground: "#ffffff", accent_foreground: "#000000" },
      }),
    ).toBeNull();
  });

  it("aceita hex maiúsculo ou minúsculo e retorna as cores", () => {
    const raw = {
      brand: { primary: "#ABC123", primary_foreground: "#ffffff", accent_foreground: "#000000" },
    };
    expect(parseBrandColors(raw)).toEqual({
      primary: "#ABC123",
      primary_foreground: "#ffffff",
      accent_foreground: "#000000",
    });
  });
});

describe("buildBrandPalette", () => {
  // Cores escolhidas para cobrir os extremos: o ciano que quebrou em produção,
  // amarelo e verde-limão (luminosos demais para o claro), roxo e vermelho
  // (escuros demais para o escuro), preto e branco puros.
  const MARCAS = [
    ["ciano", "#00d4ff"],
    ["safira", "#1e63c8"],
    ["amarelo", "#ffd400"],
    ["verde-limão", "#7fff00"],
    ["vermelho", "#d14343"],
    ["roxo", "#6b21a8"],
    ["preto", "#000000"],
    ["branco", "#ffffff"],
  ] as const;

  it.each(MARCAS)("%s: a cor do claro lê sobre a superfície clara", (_nome, hex) => {
    const { light } = buildBrandPalette(hex);
    expect(contrast(light.primary, FUNDO_CLARO)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(MARCAS)("%s: a cor do escuro lê nos três campos escuros", (_nome, hex) => {
    const { dark } = buildBrandPalette(hex);
    for (const fundo of Object.values(FUNDOS_ESCUROS)) {
      expect(contrast(dark.primary, fundo)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(MARCAS)("%s: o texto do botão lê sobre a cor, nos dois temas", (_nome, hex) => {
    // `--primary` é fundo de botão além de cor de texto: garantir só o
    // contraste com a página deixaria o rótulo do botão ilegível.
    const { light, dark } = buildBrandPalette(hex);
    expect(contrast(light.primary, light.foreground)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(dark.primary, dark.foreground)).toBeGreaterThanOrEqual(4.5);
  });

  it("não mexe na cor que já lê nos dois campos", () => {
    // Safira do DS: 5.42 no claro. Ajustar seria descaracterizar à toa.
    expect(buildBrandPalette("#1e63c8").light.primary).toBe("#1e63c8");
  });

  it("o ciano que quebrou em produção sai escurecido no claro e intacto no escuro", () => {
    const { light, dark } = buildBrandPalette("#00d4ff");
    expect(contrast("#00d4ff", FUNDO_CLARO)).toBeLessThan(2); // o defeito original
    expect(light.primary).not.toBe("#00d4ff");
    expect(dark.primary).toBe("#00d4ff"); // no escuro já lia, fica como está
  });
});

describe("applyBrandTheme", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    OVERRIDDEN_VARS.forEach((v) => document.documentElement.style.removeProperty(v));
    document.getElementById("brand-theme")?.remove();
  });

  it("não faz nada quando document é undefined", () => {
    vi.stubGlobal("document", undefined);
    expect(() => applyBrandTheme(null)).not.toThrow();
  });

  const brand: TenantBrandColors = {
    primary: "#00d4ff",
    primary_foreground: "#05152b",
    accent_foreground: "#00d4ff",
  };

  it("injeta um bloco por tema, com seletor que vence os skins", () => {
    applyBrandTheme(brand);
    const css = document.getElementById("brand-theme")?.textContent ?? "";
    expect(css).toContain(":root:not(.dark){");
    expect(css).toContain(":root.dark{");
  });

  it("limpa o inline antigo — inline venceria a folha injetada", () => {
    document.documentElement.style.setProperty("--primary", "#00d4ff");
    applyBrandTheme(brand);
    expect(document.documentElement.style.getPropertyValue("--primary")).toBe("");
  });

  it("brand null remove a folha e o inline", () => {
    applyBrandTheme(brand);
    document.documentElement.style.setProperty("--primary", "#123456");
    applyBrandTheme(null);
    expect(document.getElementById("brand-theme")).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--primary")).toBe("");
  });

  it("reaplicar não duplica a tag", () => {
    applyBrandTheme(brand);
    applyBrandTheme({ ...brand, primary: "#6b21a8" });
    expect(document.querySelectorAll("#brand-theme")).toHaveLength(1);
    expect(document.getElementById("brand-theme")?.textContent).toContain("#6b21a8");
  });

  it("o accent sai como rgba da cor derivada daquele tema", () => {
    applyBrandTheme(brand);
    const css = document.getElementById("brand-theme")?.textContent ?? "";
    const { light, dark } = buildBrandPalette(brand.primary);
    const rgba = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      return `rgba(${r}, ${g}, ${b}, 0.12)`;
    };
    expect(css).toContain(rgba(light.primary));
    expect(css).toContain(rgba(dark.primary));
  });
});
