import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelProvider,
  ChannelSendInput,
  ChannelSendResult,
} from "./channel-adapter.ts";
import type { CanonicalInboundMessage } from "./normalizers.ts";
import { validatePublicHttpsUrl } from "../validate-http-url.ts";

export interface HttpTransport {
  request(url: string, init: RequestInit): Promise<Response>;
}

// Teto do transporte real (o de produção; os testes injetam o próprio). Sem
// ele, telegram/discord/sms/email/push eram os únicos senders sem deadline
// depois do commit 7e0e6ff — um endpoint de canal que aceita a conexão e não
// responde prendia a edge function até o wall-clock da plataforma. 15s = mesmo
// valor de POST de texto de provider-send.ts/evolution-client.ts; nenhum destes
// adapters carrega mídia no corpo.
//
// AbortSignal.timeout, não AbortController manual: `sendJson` lê
// `response.json()` DEPOIS do transporte retornar, e só com o signal ainda
// armado o deadline cobre a leitura do corpo (buraco do commit 5219925).
const CHANNEL_SEND_TIMEOUT_MS = 15_000;

const fetchTransport: HttpTransport = {
  // `init.signal ??` para não engolir silenciosamente um deadline que o caller
  // tenha escolhido; hoje ninguém passa, e aí vale o teto padrão.
  request: (url, init) =>
    fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(CHANNEL_SEND_TIMEOUT_MS) }),
};
const capabilities: Record<
  Exclude<ChannelProvider, "meta-cloud" | "evolution">,
  ChannelCapabilities
> = {
  telegram: {
    text: true,
    media: true,
    templates: false,
    deliveryReceipts: false,
    readReceipts: false,
  },
  discord: {
    text: true,
    media: true,
    templates: false,
    deliveryReceipts: false,
    readReceipts: false,
  },
  sms: {
    text: true,
    media: false,
    templates: true,
    deliveryReceipts: true,
    readReceipts: false,
  },
  email: {
    text: true,
    media: true,
    templates: true,
    deliveryReceipts: true,
    readReceipts: true,
  },
  push: {
    text: true,
    media: true,
    templates: false,
    deliveryReceipts: true,
    readReceipts: false,
  },
};

export const PROVIDER_CAPABILITY_MATRIX = Object.freeze(capabilities);

type ProviderCredentials = Record<string, string>;

function genericInbound(
  provider: ChannelProvider,
  payload: Record<string, unknown>,
): CanonicalInboundMessage | null {
  const message = (payload.message as Record<string, unknown> | undefined) ??
    payload;
  const external_id = String(message.message_id ?? message.id ?? "");
  const from = String(
    message.from ?? message.sender_id ?? message.chat_id ?? "",
  );
  if (!external_id || !from) return null;
  const rawTimestamp = String(message.timestamp ?? message.created_at ?? "");
  const parsed = Date.parse(rawTimestamp);
  return {
    provider,
    external_id,
    from,
    to: String(message.to ?? message.recipient_id ?? ""),
    content: String(message.content ?? message.text ?? message.body ?? ""),
    timestamp: new Date(Number.isFinite(parsed) ? parsed : Date.now())
      .toISOString(),
    fromMe: Boolean(message.from_me),
    senderName: message.sender_name ? String(message.sender_name) : undefined,
  };
}

function sandboxResult(
  provider: ChannelProvider,
  input: ChannelSendInput,
): ChannelSendResult {
  const suffix = crypto.randomUUID();
  return {
    ok: true,
    external_id: `sandbox:${provider}:${input.destination}:${suffix}`,
  };
}

async function sendJson(
  transport: HttpTransport,
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<ChannelSendResult> {
  // Anti-SSRF: `url` vem de `channels.config` (discord.webhook_url,
  // sms/email/push.api_url) — campos graváveis direto via PostgREST por um
  // admin, driblando o guard do fluxo integration-connect. Revalida no
  // boundary do request. Ver _shared/validate-http-url.ts.
  const urlCheck = await validatePublicHttpsUrl(url);
  if (!urlCheck.ok) {
    return { ok: false, error: urlCheck.error ?? "URL do provedor de canal inválida." };
  }
  const response = await transport.request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    return { ok: false, error: `Provider HTTP ${response.status}` };
  }
  const data = await response.json().catch(() => ({})) as Record<
    string,
    unknown
  >;
  const result = (data.result as Record<string, unknown> | undefined) ?? data;
  return {
    ok: true,
    external_id: String(result.message_id ?? result.id ?? "") || null,
  };
}

export function createMultichannelAdapter(
  provider: Exclude<ChannelProvider, "meta-cloud" | "evolution">,
  credentials: ProviderCredentials,
  transport: HttpTransport = fetchTransport,
): ChannelAdapter<Record<string, unknown>> {
  return {
    provider,
    capabilities: capabilities[provider],
    normalizeInbound: (payload) => genericInbound(provider, payload),
    async send(input) {
      if (!input.destination.trim()) {
        return { ok: false, error: "Destino do canal ausente." };
      }
      const hasSecrets = Object.values(credentials).some(Boolean);
      if (!hasSecrets) return sandboxResult(provider, input);
      switch (provider) {
        case "telegram":
          if (!credentials.bot_token) {
            return { ok: false, error: "Token do Telegram ausente." };
          }
          return sendJson(
            transport,
            `https://api.telegram.org/bot${credentials.bot_token}/sendMessage`,
            {},
            {
              chat_id: input.destination,
              text: input.content,
            },
          );
        case "discord":
          if (!credentials.webhook_url) {
            return { ok: false, error: "Webhook do Discord ausente." };
          }
          return sendJson(transport, credentials.webhook_url, {}, {
            content: input.content,
          });
        case "sms":
        case "email":
        case "push": {
          if (!credentials.api_url || !credentials.api_key) {
            return {
              ok: false,
              error: `Credenciais de ${provider} incompletas.`,
            };
          }
          return sendJson(transport, credentials.api_url, {
            authorization: `Bearer ${credentials.api_key}`,
          }, {
            to: input.destination,
            content: input.content,
            from: credentials.sender,
          });
        }
      }
    },
  };
}
