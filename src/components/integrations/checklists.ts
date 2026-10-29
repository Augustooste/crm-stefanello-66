// Checklists pós-conexão por integração.
//
// Cada checklist lista as verificações que costumam ser esquecidas no painel
// do provedor e que fazem o canal "parecer ativo mas não funcionar" (webhook
// não recebe, número não vinculado, domínio não verificado, etc.). O objetivo
// é reduzir a fricção para operadores leigos: cada item tem estado visual
// (ok / atenção / pendente) e um link direto para o passo correto.
//
// Regras:
// - `ok` só quando temos sinal REAL (webhook_health, status do canal, presença
//   de credencial). Não invente confirmação — na dúvida, `pending` (cinza).
// - `warn` para sinal negativo confirmado (webhook_health === "broken",
//   status === "waiting_qr" ou "disconnected").
// - `pending` para verificações que só o operador pode confirmar no painel
//   externo (assinar campo, marcar evento, verificar domínio DNS).
//
// Este módulo é puro (sem React/DOM) — só monta a estrutura de dados. A
// renderização acontece em `IntegrationCard.tsx` via <IntegrationChecklist />.

import type { ChannelRow, TenantIntegrationRow } from "@/lib/api/integrations";

export type ChecklistItemState = "ok" | "warn" | "pending";

export type ChecklistItem = {
  key: string;
  label: string;
  hint: string;
  state: ChecklistItemState;
  href: string;
  linkLabel: string;
  /** Marca link como interno (nav do próprio app) em vez de externo. */
  internal?: boolean;
};

export type ChecklistDef = {
  title: string;
  items: ChecklistItem[];
};

export type ChecklistContext = {
  channel: ChannelRow | null;
  tenant: TenantIntegrationRow | null;
  voiceConfigured?: boolean;
};

function hasSecret(tenant: TenantIntegrationRow | null, key: string): boolean {
  // config nunca guarda o segredo em si (fica no vault), mas guarda flags
  // como { has_client_token: true } / { webhook_signing_secret_set: true }
  // marcadas pelo integration-connect. Aceitamos qualquer verdade truthy.
  const cfg = tenant?.config;
  if (!cfg) return false;
  return Boolean(cfg[key] ?? cfg[`has_${key}`] ?? cfg[`${key}_set`]);
}

function configVal<T = string>(
  row: ChannelRow | TenantIntegrationRow | null,
  key: string,
): T | null {
  const cfg = row?.config as Record<string, unknown> | null | undefined;
  const v = cfg?.[key];
  return (v ?? null) as T | null;
}

// -------------------- Meta WhatsApp Cloud --------------------
function metaCloudChecklist({ channel }: ChecklistContext): ChecklistDef {
  const webhookOk = channel?.webhook_health === "ok";
  const webhookBroken = channel?.webhook_health === "broken";
  // `silent` = nunca recebeu evento algum. Não é regressão como `broken`,
  // mas é acionável (URL provavelmente não cadastrada no painel do
  // provedor) — por isso `warn`, não `pending`. Quem espera de verdade é
  // `unknown`, canal novo demais para ter recebido.
  const webhookSilent = channel?.webhook_health === "silent";
  const phoneNumberId = configVal<string>(channel, "phone_number_id");
  const hasPhoneId = Boolean(phoneNumberId);

  return {
    title: "Lista de verificação — Meta WhatsApp",
    items: [
      {
        key: "webhook",
        label: "Webhook recebendo eventos",
        hint: webhookOk
          ? "A Meta já chamou este endpoint com sucesso."
          : webhookBroken
            ? "Nenhuma mensagem nas últimas 72h. Se estiver esperando tráfego, reconfirme a URL e o Verify Token no painel."
            : "Aguardando o primeiro callback da Meta neste endpoint.",
        state: webhookOk ? "ok" : webhookBroken || webhookSilent ? "warn" : "pending",
        href: "https://developers.facebook.com/apps/",
        linkLabel: "Abrir Meta for Developers",
      },
      {
        key: "messages-field",
        label: 'Campo "messages" assinado',
        hint: "Em WhatsApp → Configuração → Webhooks, marque o campo messages para receber mensagens de entrada.",
        state: "pending",
        href: "https://developers.facebook.com/docs/graph-api/webhooks/reference/whatsapp-business-account",
        linkLabel: "Ver documentação do campo messages",
      },
      {
        key: "waba-assignment",
        label: "Número (WABA) atribuído ao app",
        hint: hasPhoneId
          ? `Confirme no painel que o Phone Number ID ${phoneNumberId} está vinculado à sua conta de WhatsApp Business e ao seu app.`
          : "Vincule o número de WhatsApp Business (WABA) ao seu app e assine a conta.",
        state: hasPhoneId ? "pending" : "warn",
        href: "https://business.facebook.com/wa/manage/phone-numbers/",
        linkLabel: "Abrir WhatsApp Manager",
      },
    ],
  };
}

// -------------------- Z-API --------------------
function zapiChecklist({ channel, tenant }: ChecklistContext): ChecklistDef {
  const connected = channel?.status === "connected";
  const waitingQr = channel?.status === "waiting_qr";
  const webhookOk = channel?.webhook_health === "ok";
  const webhookBroken = channel?.webhook_health === "broken";
  // `silent` = nunca recebeu evento algum. Não é regressão como `broken`,
  // mas é acionável (URL provavelmente não cadastrada no painel do
  // provedor) — por isso `warn`, não `pending`. Quem espera de verdade é
  // `unknown`, canal novo demais para ter recebido.
  const webhookSilent = channel?.webhook_health === "silent";
  const hasClientToken = hasSecret(tenant, "client_token");

  return {
    title: "Lista de verificação — Z-API",
    items: [
      {
        key: "instance",
        label: "Instância conectada",
        hint: connected
          ? "Instância pareada com o WhatsApp."
          : waitingQr
            ? "Instância aguardando leitura do QR code no painel Z-API."
            : "Instância desconectada. Reabra a Z-API e escaneie o QR novamente.",
        state: connected ? "ok" : "warn",
        href: "https://app.z-api.io",
        linkLabel: "Abrir painel Z-API",
      },
      {
        key: "inbound-webhook",
        label: 'Webhook "Ao receber" apontando para esta URL',
        hint: webhookOk
          ? "Já recebemos mensagens da Z-API neste endpoint."
          : webhookBroken
            ? "Nenhuma mensagem nas últimas 72h. Se estiver esperando tráfego, reconfira a URL colada no painel Z-API."
            : 'Cole a URL de webhook acima em "Configure Webhooks" → "Ao receber", no painel Z-API.',
        state: webhookOk ? "ok" : webhookBroken || webhookSilent ? "warn" : "pending",
        href: "https://app.z-api.io",
        linkLabel: "Abrir Webhooks Z-API",
      },
      {
        key: "client-token",
        label: "Client Token da conta salvo",
        hint: hasClientToken
          ? "Client Token registrado — autoriza chamadas e valida webhooks."
          : "Sem Client Token, o envio pode até funcionar mas as mensagens recebidas serão rejeitadas.",
        state: hasClientToken ? "ok" : "warn",
        href: "https://app.z-api.io",
        linkLabel: "Abrir Segurança da conta",
      },
    ],
  };
}

// -------------------- Twilio --------------------
function twilioChecklist({ channel, tenant }: ChecklistContext): ChecklistDef {
  const whatsappNumber = configVal<string>(tenant, "whatsapp_number");
  const webhookOk = channel?.webhook_health === "ok";
  const webhookBroken = channel?.webhook_health === "broken";
  // `silent` = nunca recebeu evento algum. Não é regressão como `broken`,
  // mas é acionável (URL provavelmente não cadastrada no painel do
  // provedor) — por isso `warn`, não `pending`. Quem espera de verdade é
  // `unknown`, canal novo demais para ter recebido.
  const webhookSilent = channel?.webhook_health === "silent";

  return {
    title: "Lista de verificação — Twilio WhatsApp",
    items: [
      {
        key: "sender",
        label: "Número WhatsApp aprovado configurado",
        hint: whatsappNumber
          ? `Sender registrado: ${whatsappNumber}.`
          : "Nenhum número WhatsApp encontrado. Cadastre em Messaging → Senders.",
        state: whatsappNumber ? "ok" : "warn",
        href: "https://console.twilio.com/us1/develop/sms/senders/whatsapp-senders",
        linkLabel: "Abrir WhatsApp Senders",
      },
      {
        key: "inbound-webhook",
        label: 'Webhook em "When a message comes in" (HTTP POST)',
        hint: "No sender do WhatsApp, cole a URL de webhook acima em When a message comes in — método POST.",
        state: "pending",
        href: "https://console.twilio.com/us1/develop/sms/senders/whatsapp-senders",
        linkLabel: "Configurar webhook do sender",
      },
      {
        key: "signature",
        label: "Assinatura Twilio validada",
        hint: webhookOk
          ? "Requisições da Twilio chegam assinadas corretamente."
          : webhookBroken
            ? "Nenhuma requisição nas últimas 72h. Se estiver esperando tráfego, confirme se o Auth Token salvo é o mesmo do console."
            : "Aguardando a primeira mensagem para validar a assinatura X-Twilio-Signature.",
        state: webhookOk ? "ok" : webhookBroken || webhookSilent ? "warn" : "pending",
        href: "https://www.twilio.com/docs/usage/webhooks/webhooks-security",
        linkLabel: "Ver docs de validação",
      },
    ],
  };
}

// -------------------- Evolution --------------------
function evolutionChecklist({ channel, tenant }: ChecklistContext): ChecklistDef {
  const connected = channel?.status === "connected";
  const waitingQr = channel?.status === "waiting_qr";
  const disconnected = channel?.status === "disconnected" || channel?.status === "error";
  const webhookOk = channel?.webhook_health === "ok";
  const webhookBroken = channel?.webhook_health === "broken";
  // `silent` = nunca recebeu evento algum. Não é regressão como `broken`,
  // mas é acionável (URL provavelmente não cadastrada no painel do
  // provedor) — por isso `warn`, não `pending`. Quem espera de verdade é
  // `unknown`, canal novo demais para ter recebido.
  const webhookSilent = channel?.webhook_health === "silent";
  const apiUrl = configVal<string>(tenant, "api_url");
  const hasApiKey = hasSecret(tenant, "api_key");
  const hasInstanceToken = hasSecret(tenant, "instance_token");

  return {
    title: "Lista de verificação — Evolution Go",
    items: [
      {
        key: "instance",
        label: "Instância pareada com o WhatsApp",
        hint: connected
          ? "Instância conectada ao WhatsApp."
          : waitingQr
            ? "QR Code disponível acima — escaneie em WhatsApp > Dispositivos conectados."
            : "Instância desconectada. Reconecte pelo botão Atualizar credenciais.",
        state: connected ? "ok" : "warn",
        href: apiUrl ?? "https://docs.evolutionfoundation.com.br/evolution-go/getting-started",
        linkLabel: "Abrir painel Evolution Go",
      },
      {
        key: "webhook",
        label: "Recebimento de mensagens cadastrado na instância",
        hint: webhookOk
          ? "A instância envia os eventos para esta app e vem respondendo."
          : webhookBroken
            ? "Nenhum evento nas últimas 72h. Se estiver esperando tráfego, reconecte para cadastrar de novo o endereço na instância."
            : "Aguardando o primeiro evento. Se demorar, reconecte para cadastrar de novo o endereço na instância.",
        state: webhookOk ? "ok" : webhookBroken || webhookSilent ? "warn" : "pending",
        href: "https://docs.evolutionfoundation.com.br/evolution-go/webhooks",
        linkLabel: "Documentação de webhooks",
      },
      {
        key: "api-key",
        label: "GLOBAL_API_KEY correta",
        hint: hasApiKey
          ? disconnected
            ? "Instância desconectada mesmo com a chave salva — confirme se GLOBAL_API_KEY do servidor bate com o valor colado."
            : "Chave salva."
          : "Sem a chave global não conseguimos gerenciar a instância.",
        state: hasApiKey && !disconnected ? "ok" : "warn",
        href: "https://docs.evolutionfoundation.com.br/evolution-go/getting-started",
        linkLabel: "Onde encontrar a chave",
      },
      {
        key: "instance-token",
        label: "Token da instância identificado",
        hint: hasInstanceToken
          ? "Token da instância guardado — é ele que autentica status, QR Code e envio."
          : "Ainda não identificamos o token desta instância. Reconecte; se o servidor não listar instâncias com a chave global, informe o token no assistente.",
        state: hasInstanceToken ? "ok" : "warn",
        href: "https://docs.evolutionfoundation.com.br/evolution-go/getting-started",
        linkLabel: "Onde encontrar o token",
      },
      {
        key: "voz",
        label: "Mensagens de voz habilitadas",
        hint: "Este canal envia e recebe áudio. Para a assistente responder falando, mantenha a ElevenLabs conectada e a resposta por voz ligada em Configurações > IA.",
        state: connected ? "ok" : "pending",
        href: "https://docs.evolutionfoundation.com.br/evolution-go/send-a-media-message",
        linkLabel: "Documentação de mídia",
      },
    ],
  };
}

// -------------------- Zappaz --------------------
function zappazChecklist({ channel, tenant }: ChecklistContext): ChecklistDef {
  const connected = channel?.status === "connected";
  const active = tenant?.status === "active";
  const webhookOk = channel?.webhook_health === "ok";
  const webhookBroken = channel?.webhook_health === "broken";
  // `silent` = nunca recebeu evento algum. Não é regressão como `broken`,
  // mas é acionável (URL provavelmente não cadastrada no painel do
  // provedor) — por isso `warn`, não `pending`. Quem espera de verdade é
  // `unknown`, canal novo demais para ter recebido.
  const webhookSilent = channel?.webhook_health === "silent";
  // A API Key é validada no momento da conexão (checagem da sessão Zappaz);
  // se a integração está ativa/conectada, a chave salva no cofre funciona.
  const hasApiKey = hasSecret(tenant, "api_key") || active || connected;

  return {
    title: "Lista de verificação — Zappaz",
    items: [
      {
        key: "session",
        label: "Sessão ativa",
        hint: connected
          ? "Sessão Zappaz conectada ao WhatsApp."
          : "Sessão desconectada. Reabra o painel Zappaz e escaneie o QR novamente.",
        state: connected ? "ok" : "warn",
        href: "https://app.zappaz.io",
        linkLabel: "Abrir painel Zappaz",
      },
      {
        key: "webhook",
        label: "Webhook registrado automaticamente na sessão",
        hint: webhookOk
          ? "Zappaz está entregando mensagens neste endpoint."
          : webhookBroken
            ? "Nenhum callback nas últimas 72h. Se estiver esperando tráfego, reconecte para reinstalar o webhook."
            : "Registramos o webhook ao conectar. Assim que a primeira mensagem chegar, marcamos como ok.",
        state: webhookOk ? "ok" : webhookBroken || webhookSilent ? "warn" : "pending",
        href: "https://docs.zappaz.io/api-reference/sessions/get-session-details",
        linkLabel: "Docs da sessão Zappaz",
      },
      {
        key: "api-key",
        label: "API Key válida",
        hint: hasApiKey
          ? "API Key validada na conexão — envio e registro de webhook liberados."
          : "Sem API Key não conseguimos enviar mensagens nem registrar o webhook.",
        state: hasApiKey ? "ok" : "warn",
        href: "https://app.zappaz.io",
        linkLabel: "Abrir API Keys",
      },
    ],
  };
}

// -------------------- Resend --------------------
function resendChecklist({ channel, tenant }: ChecklistContext): ChecklistDef {
  const fromDomain = configVal<string>(tenant, "from_domain");
  const hasSigning = hasSecret(tenant, "webhook_signing_secret");
  const webhookOk = channel?.webhook_health === "ok";
  const webhookBroken = channel?.webhook_health === "broken";
  // `silent` = nunca recebeu evento algum. Não é regressão como `broken`,
  // mas é acionável (URL provavelmente não cadastrada no painel do
  // provedor) — por isso `warn`, não `pending`. Quem espera de verdade é
  // `unknown`, canal novo demais para ter recebido.
  const webhookSilent = channel?.webhook_health === "silent";

  return {
    title: "Lista de verificação — Resend",
    items: [
      {
        key: "domain",
        label: "Domínio verificado no Resend",
        hint: fromDomain
          ? `Domínio configurado: ${fromDomain}. Confirme SPF, DKIM e DMARC como "Verified" no painel.`
          : "Cadastre e verifique o domínio antes de enviar (SPF/DKIM/DMARC).",
        state: fromDomain ? "pending" : "warn",
        href: "https://resend.com/domains",
        linkLabel: "Abrir Domains no Resend",
      },
      {
        key: "webhook-endpoint",
        label: "Webhook endpoint apontando para esta URL",
        hint: "Em Webhooks → Add Endpoint, cole a URL acima. Sem isso não recebemos respostas nem eventos de entrega.",
        state: webhookOk ? "ok" : webhookBroken || webhookSilent ? "warn" : "pending",
        href: "https://resend.com/webhooks",
        linkLabel: "Abrir Webhooks no Resend",
      },
      {
        key: "signing-secret",
        label: "Signing secret salvo",
        hint: hasSigning
          ? "Signing secret registrado — assinaturas de webhook são validadas."
          : "Sem o whsec_... o inbound é rejeitado (HMAC fail-closed).",
        state: hasSigning ? "ok" : "warn",
        href: "https://resend.com/webhooks",
        linkLabel: "Copiar Signing secret",
      },
      {
        key: "events",
        label: "Eventos assinados (received / delivered / opened / clicked)",
        hint: "No endpoint do webhook, marque pelo menos email.received (para inbound) e os eventos de situação que quiser rastrear.",
        state: "pending",
        href: "https://resend.com/webhooks",
        linkLabel: "Editar eventos do webhook",
      },
    ],
  };
}

// -------------------- ElevenLabs --------------------
function elevenlabsChecklist({ tenant, voiceConfigured }: ChecklistContext): ChecklistDef {
  const active = tenant?.status === "active";

  return {
    title: "Lista de verificação — ElevenLabs",
    items: [
      {
        key: "api-key",
        label: "API Key válida",
        hint: active
          ? "API Key testada com sucesso pelo integration-connect."
          : "API Key inválida ou expirada — gere uma nova em API Keys.",
        state: active ? "ok" : "warn",
        href: "https://try.elevenlabs.io/o2c8mt1d8jaa",
        linkLabel: "Abrir ElevenLabs",
      },
      {
        key: "default-voice",
        label: "Voz padrão selecionada",
        hint: voiceConfigured
          ? "A voz padrão está salva e pronta para os testes de áudio."
          : "Escolha e salve a voz acima — sem voz padrão, o TTS não é usado nas respostas.",
        state: voiceConfigured ? "ok" : "pending",
        href: "/configuracoes#plugins",
        linkLabel: "Configurar voz",
        internal: true,
      },
      {
        key: "credits",
        label: "Créditos disponíveis na conta",
        hint: "Confirme no painel ElevenLabs que sua assinatura tem créditos suficientes para o volume esperado.",
        state: "pending",
        href: "https://try.elevenlabs.io/o2c8mt1d8jaa",
        linkLabel: "Ver planos na ElevenLabs",
      },
    ],
  };
}

// -------------------- ManyChat --------------------
// Só marca ok com sinal real: tenant ativo (chave validada no connect, que
// também grava o segredo), linha de canal e token, e webhook_health "ok" —
// este último só existe depois de um External Request autenticado e válido.
function manyChatChecklist({ channel, tenant }: ChecklistContext): ChecklistDef {
  const active = tenant?.status === "active";
  const webhookOk = channel?.webhook_health === "ok";
  const webhookBroken = channel?.webhook_health === "broken";
  const webhookSilent = channel?.webhook_health === "silent";
  const docs =
    "https://help.manychat.com/hc/en-us/articles/14281285374364-Dev-Tools-External-request";
  return {
    title: "Lista de verificação — ManyChat",
    items: [
      {
        key: "api-key",
        label: "API Key validada",
        hint: active
          ? "Chave testada no ManyChat ao conectar."
          : "Chave inválida ou não testada. Gere outra em Settings > API.",
        state: active ? "ok" : "warn",
        href: "https://help.manychat.com/hc/en-us/articles/14959510331420-How-to-generate-a-token-for-the-Manychat-API-and-where-to-get-parameters",
        linkLabel: "Como gerar a API Key",
      },
      {
        key: "channel",
        label: "Canal criado",
        hint: channel ? "Canal pronto para receber conversas." : "Conecte para criar o canal.",
        state: channel ? "ok" : "pending",
        href: docs,
        linkLabel: "External Request no ManyChat",
      },
      {
        key: "webhook-url",
        label: "URL de webhook e segredo gerados",
        hint:
          channel?.webhook_token && active
            ? "URL e header x-webhook-secret prontos para colar no ManyChat."
            : "Reconecte para gerar a URL e o segredo.",
        state: channel?.webhook_token && active ? "ok" : "pending",
        href: docs,
        linkLabel: "External Request no ManyChat",
      },
      {
        key: "first-event",
        label: "Primeiro evento recebido (Test Request ou mensagem real)",
        hint: webhookOk
          ? "O ManyChat já entregou um evento válido neste endereço."
          : webhookBroken || webhookSilent
            ? "Nenhum evento válido chegando. Confira URL, header e JSON no External Request."
            : "Ainda não recebemos nada. No ManyChat, rode Test Request e espere HTTP 200.",
        state: webhookOk ? "ok" : webhookBroken || webhookSilent ? "warn" : "pending",
        href: docs,
        linkLabel: "Como testar o External Request",
      },
    ],
  };
}

const REGISTRY: Record<string, (ctx: ChecklistContext) => ChecklistDef> = {
  "manychat-whatsapp": manyChatChecklist,
  "manychat-instagram": manyChatChecklist,
  "manychat-messenger": manyChatChecklist,
  "meta-cloud": metaCloudChecklist,
  zapi: zapiChecklist,
  twilio: twilioChecklist,
  evolution: evolutionChecklist,
  zappaz: zappazChecklist,
  resend: resendChecklist,
  elevenlabs: elevenlabsChecklist,
};

export function getChecklist(slug: string, ctx: ChecklistContext): ChecklistDef | null {
  const fn = REGISTRY[slug];
  return fn ? fn(ctx) : null;
}
