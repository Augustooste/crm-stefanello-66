// preview-reply.ts — traduz o marcador de handoff para o que aconteceria
// de fato numa conversa real.
//
// No canal real, `[TRANSFERIR_HUMANO]` nunca chega ao contato: `ai-respond`
// (supabase/functions/ai-respond/index.ts:516) intercepta o marcador e
// dispara o handoff. As telas de preview conversacional (deal-chat-dialog e
// o playground de AiAssistantTab) não passam por esse passo, então quem
// testava via essas telas via o token cru e não entendia que a IA tinha
// acabado de pedir ajuda humana. Traduz para o que de fato aconteceria.

/** Reescreve a resposta de preview da IA para refletir o comportamento real do canal. */
export function renderPreviewReply(reply: string): string {
  return /\[TRANSFERIR_HUMANO\]/i.test(reply)
    ? "A IA não soube responder com segurança e transferiria para um humano aqui."
    : reply;
}
