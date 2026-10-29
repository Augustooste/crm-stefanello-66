/**
 * Vocabulário das skins e o script pré-paint que as reaplica no reload.
 *
 * O script roda como string crua no <head> (precisa executar antes do bundle,
 * senão a primeira pintura sai com o tema errado). Antes ele repetia à mão a
 * lista de skins que o TypeScript já conhecia: incluir uma skin exigia lembrar
 * de editar a string, e esquecer não dava erro nenhum — a preferência ficava
 * salva no localStorage e sumia a cada reload. Aqui a lista sai de SKIN_ATTR,
 * então existe um lugar só para mudar.
 */

export type Theme = "light" | "dark";

/** Skin → valor de `data-skin` no <html>. `null` = default, sem atributo. */
export const SKIN_ATTR = {
  clean: null,
  profundo: "profundo",
  power: "power",
} as const;

export type Skin = keyof typeof SKIN_ATTR;

/** Skins com campo escuro próprio: mantêm a variante dark mesmo no tema Claro. */
export const DARK_SKINS: readonly Skin[] = ["profundo", "power"];

/** Skins que usam Lexend, a fonte carregada sob demanda. */
const LEXEND_SKINS: readonly Skin[] = ["power"];

export function isSkin(value: string | null): value is Skin {
  return value !== null && Object.hasOwn(SKIN_ATTR, value);
}

export function isDarkSkin(skin: Skin): boolean {
  return DARK_SKINS.includes(skin);
}

/**
 * A UI renderiza escura quando o tema é dark **ou** quando a skin tem campo
 * escuro próprio. Sem isso a variante `dark:` do Tailwind (styles.css §topo)
 * desliga no tema Claro enquanto o fundo do Profundo/Power continua
 * quase-preto, e utilitários como `text-amber-800` ficam ilegíveis.
 */
export function isEffectiveDark(theme: Theme, skin: Skin): boolean {
  return theme === "dark" || isDarkSkin(skin);
}

const ATTR_SKINS: readonly string[] = Object.entries(SKIN_ATTR)
  .filter(([, attr]) => attr !== null)
  .map(([skin]) => skin);

/**
 * Script inline do <head>: reaplica tema e skin antes do primeiro paint.
 *
 * Só interpola constantes deste módulo — nada que venha do usuário. O valor
 * lido do localStorage é comparado contra a allowlist antes de virar atributo.
 * A regravação da migração `acelerador` → `power` fica por último e em try
 * próprio: storage cheio ou bloqueado não pode impedir a aplicação no DOM.
 */
export function appearanceBootScript(): string {
  const attrSkins = JSON.stringify(ATTR_SKINS);
  const darkSkins = JSON.stringify(DARK_SKINS);
  const lexendSkins = JSON.stringify(LEXEND_SKINS);

  return `try{var e=document.documentElement;var s=localStorage.getItem("skin");if(s==="acelerador"){s="power"}if(${attrSkins}.indexOf(s)>=0){e.setAttribute("data-skin",s)}else{s="clean";e.removeAttribute("data-skin")}var d=localStorage.getItem("theme")!=="light"||${darkSkins}.indexOf(s)>=0;e.classList.toggle("dark",d);e.setAttribute("data-theme",d?"dark":"light");var f=function(){var n=document.querySelector('link[data-lazy-font="lexend"]');if(n){n.media="all"}};if(${lexendSkins}.indexOf(s)>=0){if(document.readyState!=="loading"){f()}else{document.addEventListener("DOMContentLoaded",f)}}else{window.addEventListener("load",f)}try{if(localStorage.getItem("skin")==="acelerador"){localStorage.setItem("skin","power")}}catch(x){}}catch(err){window.__appearanceBootError=String((err&&err.message)||err)}`;
}

declare global {
  interface Window {
    /** Erro do script pré-paint, drenado no mount do root (ver __root.tsx). */
    __appearanceBootError?: string;
  }
}
