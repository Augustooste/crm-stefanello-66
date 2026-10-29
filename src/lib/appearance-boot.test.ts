import { afterEach, describe, expect, it } from "vitest";

import { appearanceBootScript } from "./appearance-boot";

/**
 * Roda o script do jeito que o <head> roda: string crua avaliada no escopo
 * global. Sem isso o script não tem teste nenhum — ele não passa pelo tsc e um
 * erro ali só aparece como tema errado no reload de produção.
 */
function runBootScript(): void {
  new Function(appearanceBootScript())();
}

const html = () => document.documentElement;

afterEach(() => {
  html().className = "";
  html().removeAttribute("data-theme");
  html().removeAttribute("data-skin");
  localStorage.clear();
  delete window.__appearanceBootError;
});

describe("appearanceBootScript", () => {
  it("sem preferência salva, aplica o dark do produto e nenhuma skin", () => {
    runBootScript();

    expect(html().classList.contains("dark")).toBe(true);
    expect(html().getAttribute("data-theme")).toBe("dark");
    expect(html().getAttribute("data-skin")).toBeNull();
  });

  it("tema claro sem skin desliga a variante dark", () => {
    localStorage.setItem("theme", "light");

    runBootScript();

    expect(html().classList.contains("dark")).toBe(false);
    expect(html().getAttribute("data-theme")).toBe("light");
  });

  it("aplica a skin salva", () => {
    localStorage.setItem("skin", "profundo");

    runBootScript();

    expect(html().getAttribute("data-skin")).toBe("profundo");
  });

  // Power é a skin que já está salva no navegador de quem usa hoje — é ela que
  // muda de renderização com esta PR, então não pode ficar fora da asserção.
  it.each(["profundo", "power"])("skin %s segura a variante dark no tema claro", (skin) => {
    localStorage.setItem("theme", "light");
    localStorage.setItem("skin", skin);

    runBootScript();

    // O fundo do Profundo é quase-preto: sem isto os utilitários `dark:` do
    // Tailwind desligam e texto de tema claro fica ilegível sobre ele.
    expect(html().classList.contains("dark")).toBe(true);
    expect(html().getAttribute("data-theme")).toBe("dark");
  });

  it("migra o nome legado acelerador para power e regrava o localStorage", () => {
    localStorage.setItem("skin", "acelerador");

    runBootScript();

    expect(html().getAttribute("data-skin")).toBe("power");
    expect(localStorage.getItem("skin")).toBe("power");
  });

  it("ignora valor desconhecido, sem sujar o <html> nem registrar erro", () => {
    localStorage.setItem("skin", "eletrico");

    runBootScript();

    expect(html().getAttribute("data-skin")).toBeNull();
    expect(window.__appearanceBootError).toBeUndefined();
  });
});
