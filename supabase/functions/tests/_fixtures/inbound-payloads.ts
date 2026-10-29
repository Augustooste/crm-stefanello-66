import { MEDIA_KEY_BASE64 } from "./whatsapp-media.ts";

// Payloads reais (anonimizados) de inbound dos dois canais de WhatsApp em
// produção. Ficam num módulo único porque o mesmo envelope é usado pelo teste
// do webhook (normalização/persistência) e pelo teste de fluxo da IA — copiar
// o JSON em cada arquivo já causou divergência silenciosa no passado.
//
// Zappaz entrega o formato cru do Baileys dentro de `data`, e manda um POST
// EXTRA de protocolo por mídia recebida (senderKeyDistributionMessage /
// messageContextInfo) — é esse POST que virava linha fantasma no inbox.

export function zappazText(
  text: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    event: "inbound-message.upsert",
    data: {
      key: {
        id: "3EB0ZAPPAZTEXT01",
        fromMe: false,
        remoteJid: "554599022026@s.whatsapp.net",
      },
      message: { conversation: text },
      pushName: "Felipe Truman",
      messageType: "conversation",
      messageTimestamp: 1784919781,
      ...overrides,
    },
  };
}

/** Áudio (PTT) do lead. Não tem legenda: content vem do marcador padrão. */
export function zappazAudio(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    event: "inbound-message.upsert",
    data: {
      key: {
        id: "3EB0ZAPPAZAUDIO01",
        fromMe: false,
        remoteJid: "554599022026@s.whatsapp.net",
      },
      message: {
        audioMessage: {
          url: "https://mmg.whatsapp.net/v/audio-enc.enc",
          // Presente em TODO áudio real do WhatsApp: é a chave que decifra o
          // `.enc`. Sem ela na fixture, o teste rodava contra um payload que não
          // existe em produção e fixava o comportamento quebrado como correto.
          mediaKey: MEDIA_KEY_BASE64,
          mimetype: "audio/ogg; codecs=opus",
          seconds: 7,
          ptt: true,
        },
      },
      pushName: "Felipe Truman",
      messageType: "audioMessage",
      messageTimestamp: 1784919799,
      ...overrides,
    },
  };
}

/** POST de protocolo do Baileys que acompanha cada mídia recebida. */
export function zappazProtocolEvent(): Record<string, unknown> {
  return {
    event: "inbound-message.upsert",
    data: {
      key: {
        id: "3EB0ZAPPAZPROTO01",
        fromMe: false,
        remoteJid: "554599022026@s.whatsapp.net",
      },
      message: {
        senderKeyDistributionMessage: {
          groupId: "status@broadcast",
          axolotlSenderKeyDistributionMessage: "AAAA",
        },
        messageContextInfo: { deviceListMetadataVersion: 2 },
      },
      messageTimestamp: 1784919799,
    },
  };
}

/** Eco da própria resposta enviada (fromMe): nunca pode realimentar a IA. */
export function zappazOutboundEcho(text: string): Record<string, unknown> {
  return {
    event: "outbound-message.upsert",
    data: {
      key: {
        id: "3EB0ZAPPAZECHO01",
        fromMe: true,
        remoteJid: "554599022026@s.whatsapp.net",
      },
      message: { conversation: text },
      messageTimestamp: 1784919810,
    },
  };
}

export function metaEnvelope(message: Record<string, unknown>): Record<string, unknown> {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { display_phone_number: "5511900000000" },
              contacts: [{ profile: { name: "Contato Meta" } }],
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

export function metaText(text: string): Record<string, unknown> {
  return metaEnvelope({
    id: "wamid.TEXT01",
    from: "5511999999999",
    timestamp: "1700000000",
    type: "text",
    text: { body: text },
  });
}

export function metaAudio(): Record<string, unknown> {
  return metaEnvelope({
    id: "wamid.AUDIO01",
    from: "5511999999999",
    timestamp: "1700000100",
    type: "audio",
    audio: { id: "987654321", mime_type: "audio/ogg; codecs=opus", voice: true },
  });
}
