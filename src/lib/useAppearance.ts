import { useSyncExternalStore } from "react";
import { toast } from "sonner";

import { SKIN_ATTR, isEffectiveDark, isSkin, type Skin, type Theme } from "./appearance-boot";

/**
 * Fonte única de verdade para as preferências de aparência (tema + skin).
 *
 * Antes cada controle (ThemeToggle no topbar e AppearanceTab em Configurações)
 * tinha seu próprio estado local inicializado do DOM só no
 * mount — mudar num não refletia no outro (estado obsoleto → clique invertido).
 * Aqui o estado vive num store externo compartilhado; todos os controles
 * consomem via useSyncExternalStore e re-renderizam juntos quando muda.
 *
 * O store guarda a **preferência** do usuário; o `<html>` recebe o que está
 * sendo **renderizado**. Os dois divergem de propósito quando a skin tem campo
 * escuro próprio (Profundo e Power seguram a variante dark mesmo no tema
 * Claro), então o tema é hidratado do localStorage, nunca da classe do `<html>`.
 *
 * Persistência: os setters escrevem no `<html>` (classe .dark / data-theme /
 * data-skin) e no localStorage; o script pré-paint do root reaplica no reload.
 */

export type { Skin, Theme };

type AppearanceState = { theme: Theme; skin: Skin };

const listeners = new Set<() => void>();
let state: AppearanceState = { theme: "dark", skin: "clean" };
let hydrated = false;

function readInitial(): AppearanceState {
  if (typeof document === "undefined") return { theme: "dark", skin: "clean" };
  const el = document.documentElement;
  const raw = el.getAttribute("data-skin");
  const skin: Skin = isSkin(raw) ? raw : "clean";
  // Atributo com valor que nenhuma skin usa (deploy antigo, extensão, edição
  // manual) não tem regra no CSS: sai do DOM em vez de virar estado fantasma
  // que a UI nega e que clicar em "Clean" não corrige.
  if (raw !== null && SKIN_ATTR[skin] !== raw) el.removeAttribute("data-skin");

  // Sem preferência salva, o `<html>` ainda serve de pista — mas só com skin
  // Clean, porque skin de campo escuro força `.dark` e diria "dark" para quem
  // nunca escolheu. Preferência salva sempre vence.
  let theme: Theme = skin === "clean" && !el.classList.contains("dark") ? "light" : "dark";
  try {
    const saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "dark") theme = saved;
  } catch {
    // storage indisponível (modo privado) — fica com a pista do DOM
  }
  return { theme, skin };
}

/** Lê a preferência salva (e o DOM do pré-paint) uma vez, na primeira leitura. */
function ensureHydrated(): void {
  if (!hydrated) {
    state = readInitial();
    hydrated = true;
  }
}

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  ensureHydrated();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): AppearanceState {
  ensureHydrated();
  return state;
}

// SSR: o root renderiza dark por padrão; o script pré-paint corrige antes do paint.
const serverSnapshot: AppearanceState = { theme: "dark", skin: "clean" };
function getServerSnapshot(): AppearanceState {
  return serverSnapshot;
}

function applyToDom(next: AppearanceState): void {
  const el = document.documentElement;
  const attr = SKIN_ATTR[next.skin];
  if (attr) el.setAttribute("data-skin", attr);
  else el.removeAttribute("data-skin");

  const dark = isEffectiveDark(next.theme, next.skin);
  el.classList.toggle("dark", dark);
  // DS §5: data-theme espelha a classe .dark — os dois carregam o que está
  // renderizado, não a preferência guardada no store.
  el.setAttribute("data-theme", dark ? "dark" : "light");
}

function persist(key: "theme" | "skin", value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage indisponível (modo privado, quota estourada): o `<html>` já
    // mudou, mas a escolha não sobrevive ao reload. Sem avisar, o usuário só
    // descobre na próxima visita, quando tudo voltou ao default.
    toast.error("Não deu para salvar sua preferência neste navegador.", {
      description: "A aparência escolhida vale só nesta sessão.",
      id: "aparencia-sem-storage",
    });
  }
}

export function setTheme(next: Theme): void {
  ensureHydrated();
  state = { ...state, theme: next };
  applyToDom(state);
  persist("theme", next);
  emit();
}

export function setSkin(next: Skin): void {
  ensureHydrated();
  state = { ...state, skin: next };
  applyToDom(state);
  persist("skin", next);
  emit();
}

/** Somente para testes: reseta o store para re-hidratar do DOM no próximo uso. */
export function __resetAppearanceStoreForTests(): void {
  hydrated = false;
  state = { theme: "dark", skin: "clean" };
  listeners.clear();
}

export function useAppearance(): {
  theme: Theme;
  skin: Skin;
  setTheme: (t: Theme) => void;
  setSkin: (s: Skin) => void;
} {
  const s = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { theme: s.theme, skin: s.skin, setTheme, setSkin };
}
