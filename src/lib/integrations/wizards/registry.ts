// Wizards passo-a-passo por provedor de integração.
//
// Cada wizard descreve N passos com instruções específicas (onde clicar no
// painel do provedor, o que copiar) e quais `required_secrets` do catálogo
// aparecem em cada passo. A submissão real (mutation `integration-connect`)
// continua acontecendo em `ConnectDialog` — este registry é apenas conteúdo +
// agrupamento de campos.
//
// Slugs sem entrada aqui caem no formulário plano (comportamento antigo).

export type WizardStep = {
  title: string;
  /** Bullets curtos, em PT-BR — cada linha vira <li>. */
  bullets: string[];
  /** Chaves de `required_secrets` a exibir neste passo (na ordem). */
  fields: string[];
  /** URL opcional do painel do provedor exibida como link "Abrir painel". */
  docsUrl?: string;
};

export type WizardDef = {
  slug: string;
  intro?: string;
  steps: WizardStep[];
};

const WIZARDS: Record<string, WizardDef> = {
  zappaz: {
    slug: "zappaz",
    intro: "Conecte seu WhatsApp via Zappaz — provedor não-oficial (auth por API key + sessionId).",
    steps: [
      {
        title: "Crie a sessão no painel Zappaz",
        bullets: [
          "Acesse app.zappaz.io e faça login (ou crie conta).",
          "Em Sessões, crie uma nova sessão e escaneie o QR code com o WhatsApp do número que vai atender.",
          "Copie o Session ID que aparece após a criação — é o identificador único da sessão.",
        ],
        fields: ["session_id"],
        docsUrl: "https://app.zappaz.io",
      },
      {
        title: "API Key",
        bullets: [
          "No painel Zappaz, menu do perfil > API Keys.",
          "Gere uma chave com escopo de usuário (vale para todas as sessões da conta) e cole abaixo.",
          "Ao salvar, registramos automaticamente o webhook desta app na sua sessão.",
        ],
        fields: ["api_key"],
      },
    ],
  },
  zapi: {
    slug: "zapi",
    intro: "Conecte seu número via Z-API — provedor não-oficial de WhatsApp mais usado no Brasil.",
    steps: [
      {
        title: "Crie a instância na Z-API",
        bullets: [
          "Acesse app.z-api.io e faça login (ou crie conta).",
          "Em Instâncias, clique em Criar nova instância e escaneie o QR com o WhatsApp do número que vai atender.",
          "Aguarde o status ficar Conectado.",
        ],
        fields: [],
        docsUrl: "https://app.z-api.io",
      },
      {
        title: "Copie o ID e o Token da instância",
        bullets: [
          "Ainda na instância, copie o Instance ID (aparece no topo) e o Instance Token (aba Segurança).",
          "Cole abaixo — ficam guardados criptografados, o front nunca os relê.",
        ],
        fields: ["instance_id", "instance_token"],
      },
      {
        title: "Client Token da conta",
        bullets: [
          "Menu superior direito > Segurança > Token da conta.",
          "Este token vale para todas as instâncias da conta e é o que autoriza requisições à API.",
        ],
        fields: ["client_token"],
      },
    ],
  },
  twilio: {
    slug: "twilio",
    intro: "Twilio WhatsApp Business — provedor oficial (BSP) da Meta.",
    steps: [
      {
        title: "Credenciais da conta",
        bullets: [
          "Acesse console.twilio.com com a conta que tem o número WhatsApp aprovado.",
          "Na Home, copie Account SID e Auth Token (o Auth Token fica escondido — clique em View).",
        ],
        fields: ["account_sid", "auth_token"],
        docsUrl: "https://console.twilio.com",
      },
      {
        title: "Número de WhatsApp",
        bullets: [
          "Menu Messaging > Senders > WhatsApp senders.",
          "Copie o número no formato internacional com +, ex.: +5511999999999.",
        ],
        fields: ["whatsapp_number"],
      },
    ],
  },
  "meta-cloud": {
    slug: "meta-cloud",
    intro: "WhatsApp Cloud API direto da Meta (sem BSP). Requer app no developers.facebook.com.",
    steps: [
      {
        title: "System User e Access Token permanente",
        bullets: [
          "No Meta Business Suite, crie um System User com acesso ao app do WhatsApp.",
          "Gere um token permanente com a permissão whatsapp_business_messaging.",
        ],
        fields: ["access_token"],
        docsUrl: "https://developers.facebook.com",
      },
      {
        title: "Phone Number ID",
        bullets: [
          "developers.facebook.com > seu app > WhatsApp > API Setup.",
          "Copie o Phone number ID do número aprovado (só dígitos, sem +).",
        ],
        fields: ["phone_number_id"],
      },
      {
        title: "App Secret",
        bullets: [
          "developers.facebook.com > seu app > Configurações > Básico.",
          "Copie o App Secret — é o que valida a assinatura X-Hub dos webhooks. Sem ele, o webhook é rejeitado (fail-closed).",
        ],
        fields: ["app_secret"],
      },
    ],
  },
  evolution: {
    slug: "evolution",
    intro:
      "WhatsApp via Evolution Go (servidor próprio). Você já deve ter o Evolution Go instalado e publicado em um domínio acessível pela internet.",
    steps: [
      {
        title: "Endereço do servidor Evolution Go",
        bullets: [
          "Cole a URL do seu Evolution Go, com https:// e sem barra no final — ex.: https://seu-dominio.com.br.",
          "Precisa ser um endereço público: localhost e endereços de rede interna não são aceitos, porque o WhatsApp e esta app precisam alcançar o servidor.",
        ],
        fields: ["api_url"],
        docsUrl: "https://docs.evolutionfoundation.com.br/evolution-go/getting-started",
      },
      {
        title: "Chave global e instância",
        bullets: [
          "A chave é o valor de GLOBAL_API_KEY no arquivo .env do seu Evolution Go (ou no docker-compose.yml).",
          "No painel do Evolution Go, em Instâncias, crie uma instância e copie o nome dela (só letras, números, hífen e underscore).",
          "O token da instância é opcional: buscamos ele sozinhos pelo nome. Preencha apenas se o seu servidor não permitir listar as instâncias com a chave global.",
        ],
        fields: ["api_key", "instance_name", "instance_token"],
      },
      {
        title: "Parear o WhatsApp",
        bullets: [
          "Ao salvar, abrimos a conexão da instância e já cadastramos nela o endereço que recebe as mensagens — você não precisa colar nada no painel do Evolution Go.",
          "Se a instância ainda não estiver pareada, o QR Code aparece aqui nesta tela.",
          "No celular: WhatsApp > Configurações > Dispositivos conectados > Conectar dispositivo, e escaneie o código.",
        ],
        fields: [],
        docsUrl: "https://docs.evolutionfoundation.com.br/evolution-go/webhooks",
      },
    ],
  },
  resend: {
    slug: "resend",
    intro: "E-mail transacional via Resend. Você precisa de um domínio já verificado.",
    steps: [
      {
        title: "API Key",
        bullets: [
          "resend.com/api-keys > Create API Key.",
          "Dê permissão de envio (Sending access) — não precisa de Full access.",
        ],
        fields: ["api_key"],
        docsUrl: "https://resend.com/api-keys",
      },
      {
        title: "Domínio verificado",
        bullets: [
          "resend.com/domains > verifique seu domínio (registros SPF/DKIM/DMARC).",
          "Cole o domínio exatamente como está no painel, ex.: minhaempresa.com.br — sem @, sem https://, sem barra final.",
        ],
        fields: ["from_domain"],
      },
      {
        title: "Webhook signing secret",
        bullets: [
          "resend.com/webhooks > Add Endpoint. Cole a URL de webhook que aparece nesta tela após conectar (será exibida em Gerenciar depois deste passo — se ainda não abriu, pule para o final e volte aqui).",
          "Selecione pelo menos os eventos email.received (para inbound) e email.delivered/opened/clicked (para status de entrega).",
          "Depois de criar, o Resend mostra um Signing Secret começando com whsec_ — copie e cole abaixo. Sem ele, o Resend continua entregando e-mails, mas os inbounds serão rejeitados (fail-closed HMAC).",
        ],
        fields: ["webhook_signing_secret"],
        docsUrl: "https://resend.com/webhooks",
      },
    ],
  },
  elevenlabs: {
    slug: "elevenlabs",
    intro: "Voz do assistente (TTS) via ElevenLabs.",
    steps: [
      {
        title: "API Key",
        bullets: [
          "elevenlabs.io > menu do perfil (canto superior direito) > API Keys.",
          "Copie sua chave. Testamos automaticamente com uma chamada leve antes de ativar.",
        ],
        fields: ["api_key"],
        docsUrl: "https://try.elevenlabs.io/o2c8mt1d8jaa",
      },
    ],
  },
  apify: {
    slug: "apify",
    intro:
      "Enriquecimento de leads via Apify — você usa a sua própria conta e paga direto na Apify.",
    steps: [
      {
        title: "Crie uma conta Apify",
        bullets: [
          "Acesse apify.com e crie uma conta.",
          "Requer plano Apify que permita rodar Actors públicos da Store (o erro public-actor-disabled aparece em planos que não permitem).",
        ],
        fields: [],
        docsUrl: "https://apify.com",
      },
      {
        title: "Gere sua API key",
        bullets: [
          "Na Apify Console, abra Settings > API & Integrations.",
          "Copie o Personal API token (começa com apify_api_) e cole abaixo.",
        ],
        fields: ["api_token"],
        docsUrl: "https://console.apify.com/settings/integrations",
      },
    ],
  },
  feegow: {
    slug: "feegow",
    intro: "Sincronização com o Feegow Clinic (agendamentos e cadastro de pacientes).",
    steps: [
      {
        title: "ID da clínica",
        bullets: [
          "No Feegow, Configurações > Integrações.",
          "O identificador numérico da sua clínica aparece no topo da tela de API.",
        ],
        fields: ["clinic_id"],
        docsUrl: "https://feegow.com",
      },
      {
        title: "Access Token",
        bullets: [
          "Mesma tela, gere um token de API se ainda não houver.",
          "Copie e cole — o token NÃO é reexibido depois de salvo pela Feegow, então guarde uma cópia própria também.",
        ],
        fields: ["access_token"],
      },
    ],
  },
  "manychat-whatsapp": manyChatWizard("manychat-whatsapp", "WhatsApp"),
  "manychat-instagram": manyChatWizard("manychat-instagram", "Instagram"),
  "manychat-messenger": manyChatWizard("manychat-messenger", "Messenger"),
};

// ManyChat: um wizard por superfície, mesmo conteúdo. A URL, o header e o JSON
// do External Request aparecem depois de conectar (ManyChatSetupPanel), porque
// dependem do canal e do segredo gerados no servidor.
function manyChatWizard(slug: string, surface: string): WizardDef {
  return {
    slug,
    intro: `Receba e responda no AceleraFlow as conversas de ${surface} que passam pelo ManyChat.`,
    steps: [
      {
        title: "Gere a API Key no ManyChat",
        bullets: [
          "No ManyChat, abra Settings > API.",
          "Clique em Generate API Key e copie a chave.",
          "A chave fica só no servidor — o navegador nunca a relê.",
        ],
        fields: ["api_key"],
        docsUrl:
          "https://help.manychat.com/hc/en-us/articles/14959510331420-How-to-generate-a-token-for-the-Manychat-API-and-where-to-get-parameters",
      },
      {
        title: "Depois de conectar",
        bullets: [
          "Validamos a chave e criamos o canal.",
          "Você recebe a URL do webhook, o segredo do header x-webhook-secret e o JSON do External Request para colar no ManyChat.",
          "O segredo aparece uma única vez — copie na hora.",
        ],
        fields: [],
        docsUrl:
          "https://help.manychat.com/hc/en-us/articles/14281285374364-Dev-Tools-External-request",
      },
    ],
  };
}

export function getWizard(slug: string): WizardDef | null {
  return WIZARDS[slug] ?? null;
}
