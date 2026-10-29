// Mapeador de mensagens de erro cru dos provedores/edge functions para uma
// instrução acionável em PT-BR que o operador consegue aplicar sozinho.
//
// PRINCÍPIO: qualquer texto que chegue aqui é uma mensagem já sanitizada
// pelo backend (via redactSecrets). Ainda assim, tratamos como "não confiável"
// e nunca ecoamos crua sem passar pela normalização — se nenhum padrão bater,
// caímos num texto genérico + a mensagem original truncada.
//
// Puro, sem I/O. Testado em friendly-errors.test.ts.

const GENERIC = "Não conseguimos concluir a operação. Teste a conexão para diagnosticar.";
const NETWORK = "Não conseguimos falar com o provedor agora — tente novamente em instantes.";
const UNAUTHORIZED =
  "Credenciais inválidas ou expiradas. Reabra o wizard e cole as chaves novamente.";

type Rule = { match: RegExp; message: string };

// ManyChat: as três superfícies compartilham as regras. Os textos casam as
// mensagens de manychat-client.ts / messaging-webhook / resolveProviderDestination.
function MANYCHAT_RULES(): Rule[] {
  return [
    {
      match: /24h|3011|3031/i,
      message:
        "O contato não interage há mais de 24h e o ManyChat bloqueia a resposta. Espere ele escrever de novo.",
    },
    {
      match: /ID do ManyChat|subscriber_id|subscriber/i,
      message:
        "Contato sem ID do ManyChat para este canal: só dá para responder quem já escreveu por ele.",
    },
    {
      match: /x-webhook-secret|webhook.?secret/i,
      message:
        "O header x-webhook-secret do External Request não confere. Gere um novo segredo aqui e cole no ManyChat.",
    },
    {
      match: /inválida|revogada|unauthori[sz]ed|forbidden|401|403/i,
      message:
        "API Key do ManyChat inválida ou revogada. Gere uma nova em Settings > API e reconecte.",
    },
    {
      match: /aguardar|rate.?limit|429/i,
      message: "O ManyChat está limitando as chamadas. A mensagem pode ser reenviada em instantes.",
    },
    {
      match: /canal .*(recusou|não)|304\d/i,
      message:
        "O ManyChat não entrega por este canal para este contato (ele não está inscrito nele).",
    },
    {
      match: /indisponível|5\d\d/i,
      message: "O ManyChat está indisponível agora. Tente de novo em instantes.",
    },
  ];
}

// Regras específicas por slug têm prioridade sobre as genéricas.
const BY_SLUG: Record<string, Rule[]> = {
  zapi: [
    {
      match: /instance.?id|instância/i,
      message: "Instance ID do Z-API inválido. Confira em app.z-api.io > sua instância > ID.",
    },
    {
      match: /token|autoriza/i,
      message:
        "Instance Token do Z-API inválido. Copie novamente em app.z-api.io > sua instância > Segurança.",
    },
    {
      match: /client.?token/i,
      message:
        "Client-Token do Z-API inválido. É o Account Token, disponível em app.z-api.io > Conta > Tokens de segurança.",
    },
  ],
  resend: [
    {
      match: /domain|domínio/i,
      message:
        "Domínio de envio inválido ou não verificado. Vá em resend.com/domains e conclua a verificação DNS.",
    },
    {
      match: /webhook.?sign|assinatura/i,
      message:
        "Segredo de webhook do Resend ausente ou incorreto. Copie o Signing Secret em resend.com/webhooks e cole no assistente.",
    },
    {
      match: /unauthorized|api.?key|401/i,
      message:
        "API key do Resend inválida. Gere uma nova em resend.com/api-keys e cole no assistente.",
    },
  ],
  twilio: [
    {
      match: /account.?sid|authenticat|401/i,
      message:
        "Account SID ou Auth Token do Twilio inválidos. Copie em console.twilio.com > Account Info.",
    },
    {
      match: /from|whatsapp:/i,
      message:
        "Número 'From' do Twilio inválido. Deve estar no formato whatsapp:+55XXXXXXXXXXX e habilitado na sandbox/conta.",
    },
  ],
  "meta-cloud": [
    {
      match: /phone.?number|wa.?id/i,
      message:
        "Phone Number ID inválido. Copie em developers.facebook.com > seu app > WhatsApp > API Setup.",
    },
    {
      match: /token|401|unauthorized/i,
      message:
        "Access Token da Meta expirado ou inválido. Gere um permanente e cole novamente no wizard.",
    },
    {
      match: /app.?secret|assinatura|signature/i,
      message:
        "App Secret ausente ou incorreto. Copie em developers.facebook.com > Configurações > Básico.",
    },
  ],
  evolution: [
    {
      // Restrito a erro de endereço: antes casava qualquer texto com "http"
      // (inclusive "HTTP 401"), mostrando "URL inválida" para falha de token.
      match: /api.?url|url inválid|invalid url|enotfound|getaddrinfo|certificate|self.signed/i,
      message: "URL da API Evolution inválida. Use o formato https://seu-servidor.exemplo.com.",
    },
    {
      match: /api.?key|apikey|\b401\b|unauthorized|forbidden|\b403\b/i,
      message:
        "A Evolution recusou as credenciais (token da instância ou API key). Reconecte a integração para revalidar o token.",
    },
    {
      match: /instance|instância|\b404\b/i,
      message: "Nome da instância Evolution não encontrado. Crie-o no painel antes de conectar.",
    },
  ],

  zappaz: [
    {
      match: /conflict|replaced|substitu/i,
      message:
        "O WhatsApp derrubou a sessão porque este número está conectado em outro lugar (outro app/sessão Zappaz). Saia das outras conexões em WhatsApp > Dispositivos conectados e reconecte aqui.",
    },
    {
      match: /logout|logged.?out|qr/i,
      message: "Sessão encerrada no WhatsApp. Reconecte a integração e escaneie o QR Code.",
    },
  ],
  "manychat-whatsapp": MANYCHAT_RULES(),
  "manychat-instagram": MANYCHAT_RULES(),
  "manychat-messenger": MANYCHAT_RULES(),
  elevenlabs: [
    {
      match: /api.?key|401|unauthorized/i,
      message:
        "API key do ElevenLabs inválida. Gere uma nova em elevenlabs.io/app/settings/api-keys.",
    },
  ],
};

const GENERIC_RULES: Rule[] = [
  // "fetch failed" e "timed out" são as strings que o Deno produz (o browser diz
  // "Failed to fetch" e "timeout") — medidas, não supostas.
  {
    match: /network|timeout|timed out|failed to fetch|fetch failed|econn|dns|connection/i,
    message: NETWORK,
  },
  { match: /unauthori[sz]ed|forbidden|401|403|api.?key|token/i, message: UNAUTHORIZED },
  {
    match: /rate.?limit|429/i,
    message: "Provedor está limitando as chamadas. Aguarde alguns minutos antes de tentar de novo.",
  },
  {
    match: /webhook/i,
    message:
      "Problema no webhook do provedor. Copie a URL de webhook novamente no wizard e cole no painel do provedor.",
  },
];

export interface FriendlyError {
  message: string;
  isGeneric: boolean;
}

export function friendlyIntegrationError(
  slug: string,
  raw: string | null | undefined,
): FriendlyError {
  const text = (raw ?? "").trim();
  if (!text) return { message: GENERIC, isGeneric: true };

  const slugRules = BY_SLUG[slug] ?? [];
  for (const r of slugRules) {
    if (r.match.test(text)) return { message: r.message, isGeneric: false };
  }
  for (const r of GENERIC_RULES) {
    if (r.match.test(text)) return { message: r.message, isGeneric: false };
  }

  // Fallback: whitelist de caracteres seguros + truncagem, prefixado por
  // GENERIC para deixar claro que é uma mensagem crua.
  const safe = text.replace(/[^\p{L}\p{N}\s.,;:!?()@/#-]/gu, "").slice(0, 180);
  return { message: safe ? `${GENERIC} Detalhe: ${safe}` : GENERIC, isGeneric: true };
}

// Sugestão de próxima ação (usada nos alertas de saúde).
export function remediationHint(slug: string, reasonCode: string): string {
  if (reasonCode === "repeated_send_failures") {
    return "Abra Configurações > Integrações, clique em 'Testar conexão' na integração afetada e revise as credenciais no wizard.";
  }
  // integration_error e demais casos.
  const name = slug.charAt(0).toUpperCase() + slug.slice(1);
  return `Abra Configurações > Integrações > ${name} e clique em 'Testar conexão'. Se falhar, reabra o wizard e cole as credenciais novamente.`;
}

// Nome de variável de ambiente: ALL_CAPS com pelo menos um underscore.
const ENV_VAR_TOKEN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

/**
 * Tira nome de variável interna de mensagem de erro que vai para a tela.
 *
 * O backend grava a mensagem técnica em `kb_documents.error_message` e
 * `ai_failure_logs.error_message` — útil no log, constrangedor na interface:
 * produção exibia literalmente "GEMINI_API_KEY ausente." para o operador, numa
 * tela onde ele não pode fazer nada a respeito. Sanear aqui, na borda, cobre
 * também as linhas antigas já gravadas, que nenhuma correção de backend
 * alcança.
 */
export function userFacingFailureMessage(message: string | null | undefined): string {
  const text = String(message ?? "").trim();
  if (!text) return "";
  // A chave do LLM vem da própria plataforma Lovable — o operador não configura
  // nada e não tem a quem pedir. Dizer "credencial não configurada, fale com o
  // suporte" mandava ele caçar uma tela que não existe; a ação certa é tentar
  // de novo. As linhas antigas com GEMINI_API_KEY são de código anterior à
  // migração para o gateway, e caem no mesmo caso.
  if (/\b[A-Z][A-Z0-9_]*_KEY\b[^.]*ausente/i.test(text)) {
    return "O serviço de IA falhou temporariamente. Tente processar de novo.";
  }
  return text.replace(ENV_VAR_TOKEN, "credencial do serviço");
}

// Jargão de Postgres/PostgREST/rede que chega cru no `error.message` das
// queries e mutations do Supabase. Cada regra cobre um caso em que o operador
// ainda consegue fazer alguma coisa a respeito.
const UI_RULES: Rule[] = [
  {
    match: /row-level security|permission denied|insufficient privilege/i,
    message: "Você não tem permissão para fazer isso. Peça a um administrador.",
  },
  {
    match: /duplicate key value|unique constraint|already exists/i,
    message: "Já existe um registro com esse valor.",
  },
  {
    match: /violates foreign key constraint/i,
    message: "Este item está em uso em outro lugar e não pode ser removido.",
  },
  {
    match: /null value in column|not-null constraint|check constraint/i,
    message: "Faltou preencher um campo obrigatório, ou o valor não é aceito.",
  },
  {
    match: /failed to fetch|networkerror|network error|load failed/i,
    message: "Sem conexão com o servidor agora — tente de novo em instantes.",
  },
  {
    match: /\bJWT\b|jwt expired|not authenticated|invalid token/i,
    message: "Sua sessão expirou. Entre de novo para continuar.",
  },
];

// Resto do jargão: sem regra específica não há ação possível, e o texto da
// própria tela ("Erro ao salvar") informa mais que a mensagem do banco.
const TECHNICAL_NOISE =
  /\brelation\b|\bcolumn\b|\bschema\b|\bconstraint\b|\bviolates\b|syntax error|\bPGRST\d+\b|Unexpected token|is not a function|undefined/i;

// O que o Supabase joga não é sempre um `Error`: `PostgrestError` é objeto
// simples com `message`/`code`/`hint`. `String(erro)` nele devolve
// "[object Object]" — daí ler o campo em vez de coagir.
function rawMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "";
}

/**
 * Mensagem pronta para toast/EmptyState a partir de um erro qualquer.
 *
 * O padrão espalhado pelas telas era `toast.error(e.message ?? "Erro ao
 * salvar")`: o fallback em PT-BR já existia e era bom, mas `e.message` tinha
 * prioridade — então o operador lia `new row violates row-level security
 * policy for table "tenants"` em vez dele. Aqui a ordem se inverte: jargão vira
 * instrução acionável quando dá, e o `fallback` da tela quando não dá.
 *
 * Mensagem que o próprio app lançou (já em PT-BR, ex.: "Tenant inválido" ou
 * "Arquivo inválido") não bate em nenhuma regra e passa intacta — só perde
 * nome de variável de ambiente, via `userFacingFailureMessage`.
 */
export function userFacingErrorMessage(error: unknown, fallback: string): string {
  const text = rawMessage(error).trim();
  if (!text) return fallback;
  for (const r of UI_RULES) {
    if (r.match.test(text)) return r.message;
  }
  if (TECHNICAL_NOISE.test(text)) return fallback;
  return userFacingFailureMessage(text);
}
