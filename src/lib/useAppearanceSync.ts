import { useEffect, useRef } from "react";

import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile } from "@/lib/api/session";
import { isSkin, type Skin, type Theme } from "@/lib/appearance-boot";
import { useAppearance } from "@/lib/useAppearance";

/**
 * Faz a preferência de aparência acompanhar o usuário, não o navegador.
 *
 * O localStorage continua sendo quem evita o flash no reload (o script
 * pré-paint só tem ele antes do bundle). Este hook cuida do resto: aplica o que
 * está salvo no perfil quando a sessão carrega e regrava lá quando o usuário
 * troca. Fica de fora do `useAppearance` de propósito — aquele módulo roda no
 * pré-paint e em teste sem rede, e não pode depender do cliente Supabase.
 */
type SavedAppearance = { theme: Theme; skin: Skin };

export function parseAppearance(value: unknown): SavedAppearance | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as { theme?: unknown; skin?: unknown };
  const theme = raw.theme === "light" || raw.theme === "dark" ? raw.theme : null;
  const skin = typeof raw.skin === "string" && isSkin(raw.skin) ? raw.skin : null;
  if (theme === null || skin === null) return null;
  return { theme, skin };
}

export function useAppearanceSync(): void {
  const { data: profile } = useCurrentProfile();
  const { theme, skin, setTheme, setSkin } = useAppearance();
  // Enquanto o perfil não chegou não dá para saber se uma diferença é escolha
  // nova do usuário ou só o estado default — sem isso, o primeiro render
  // sobrescreveria no banco a preferência que ainda estava vindo.
  const aplicado = useRef(false);
  // Aplicar o que veio do banco mexe no store em dois passos (tema, depois
  // skin). Sem esta trava, o estado intermediário do primeiro passo já dispara
  // a escrita e regrava por cima o par que acabou de chegar.
  const aplicando = useRef(false);

  const salvo = parseAppearance(profile?.appearance);

  useEffect(() => {
    if (aplicado.current || profile === undefined) return;
    aplicado.current = true;
    if (!salvo) return;
    aplicando.current = true;
    if (salvo.theme !== theme) setTheme(salvo.theme);
    if (salvo.skin !== skin) setSkin(salvo.skin);
    queueMicrotask(() => {
      aplicando.current = false;
    });
    // theme/skin ficam fora das deps: este efeito é o da aplicação inicial, e
    // reagir à própria escrita reaplicaria o valor antigo por cima da escolha.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, salvo, setTheme, setSkin]);

  useEffect(() => {
    if (!aplicado.current || aplicando.current || !profile) return;
    if (salvo && salvo.theme === theme && salvo.skin === skin) return;
    void supabase
      .rpc("set_appearance_preference", { p_theme: theme, p_skin: skin })
      .then(({ error }) => {
        // Falhar aqui não quebra a tela: o visual já mudou e o localStorage
        // segura a escolha neste navegador. O que se perde é levá-la para os
        // outros, então o erro precisa pelo menos aparecer no console.
        if (error) console.error("aparência não salva no perfil", error);
      });
  }, [theme, skin, profile, salvo]);
}
