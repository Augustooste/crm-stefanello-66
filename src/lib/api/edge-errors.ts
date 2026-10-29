/**
 * Tradução de falha de edge function para mensagem de tela.
 *
 * Existe porque o `supabase-js` **descarta o corpo** quando a function responde
 * não-2xx: ele lança `FunctionsHttpError` com uma string fixa em inglês e deixa
 * `data` nulo. O `{ error: "…" }` que a function montou em PT-BR nunca chega —
 * ler `payload.error` é código morto em todo caminho de erro HTTP.
 *
 * Então o mapeamento sai do `status`, que é o que sobrevive. Mesma abordagem já
 * usada em `agent-platform.ts`.
 */
export function mensagemDeErroDaFunction(status: number | undefined): string {
  if (status === 402) return "Créditos de IA esgotados no workspace.";
  if (status === 429)
    return "Limite de requisições de IA atingido. Tente de novo em alguns minutos.";
  if (status === 401 || status === 403) {
    return "Sessão expirada ou sem permissão. Recarregue a página.";
  }
  if (status === 503)
    return "Instabilidade ao verificar suas permissões. Tente de novo em instantes.";
  return "Não foi possível gerar a resposta.";
}
