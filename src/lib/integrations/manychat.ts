// ManyChat na UI: slugs por superfície e o modelo do corpo do External Request.
// Espelha supabase/functions/_shared/messaging/manychat-client.ts (backend).

export const MANYCHAT_SLUGS = [
  "manychat-whatsapp",
  "manychat-instagram",
  "manychat-messenger",
] as const;

export type ManyChatSlug = (typeof MANYCHAT_SLUGS)[number];

export function isManyChatSlug(slug: string | null | undefined): slug is ManyChatSlug {
  return (MANYCHAT_SLUGS as readonly string[]).includes(slug ?? "");
}

const SURFACE: Record<ManyChatSlug, { value: string; label: string }> = {
  "manychat-whatsapp": { value: "whatsapp", label: "WhatsApp" },
  "manychat-instagram": { value: "instagram", label: "Instagram" },
  "manychat-messenger": { value: "messenger", label: "Messenger" },
};

export function manyChatSurfaceLabel(slug: ManyChatSlug): string {
  return SURFACE[slug].label;
}

/** Marcador que o operador troca pela variável "Full Contact Data" no ManyChat. */
export const FULL_CONTACT_DATA_PLACEHOLDER = "<<Full Contact Data>>";

/**
 * Corpo do External Request. Não inventamos sintaxe de variável do ManyChat:
 * o marcador é substituído pelo operador usando o seletor de variáveis.
 * `event_id`/`occurred_at` não são necessários — a Full Contact Data traz
 * `last_interaction`, que o backend usa para não duplicar mensagem.
 */
export function manyChatRequestTemplate(slug: ManyChatSlug): string {
  return [
    "{",
    `  "channel": "${SURFACE[slug].value}",`,
    '  "event_type": "message.received",',
    `  "contact": ${FULL_CONTACT_DATA_PLACEHOLDER}`,
    "}",
  ].join("\n");
}
