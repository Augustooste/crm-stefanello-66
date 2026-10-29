import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Escala tipográfica do DS (§3.2) declarada para o tailwind-merge.
 *
 * Sem isto, `text-caption` e as irmãs caem no grupo `text-color` — o merge as
 * trata como cor de texto e descarta a cor declarada antes delas. O sintoma é
 * silencioso e só aparece na tela: `bg-primary text-primary-foreground
 * text-caption` renderizava sem `text-primary-foreground`, deixando as
 * iniciais do avatar em 3.31:1 sobre a marca (mínimo AA é 4.5).
 *
 * O oposto — tamanho antes da cor — funcionava por acidente de ordem, em ~475
 * lugares. Declarar a escala tira a ordem da equação.
 */
const ESCALA_TIPOGRAFICA = [
  "display",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "page-title",
  "card-title",
  "lead",
  "body",
  "sm",
  "caption",
  "kicker",
  "subtle",
];

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ESCALA_TIPOGRAFICA }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
