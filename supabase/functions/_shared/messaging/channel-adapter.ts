import type { EvolutionInboundPayload } from "./evolution-client.ts";
import {
  type CanonicalInboundMessage,
  normalizeEvolutionInbound,
  normalizeMetaCloudInbound,
  normalizeWhatsAppOutbound,
} from "./normalizers.ts";

export interface ChannelCapabilities {
  text: boolean;
  media: boolean;
  templates: boolean;
  deliveryReceipts: boolean;
  readReceipts: boolean;
}

export interface ChannelSendInput {
  destination: string;
  content: string;
}

export type ChannelProvider =
  | "meta-cloud"
  | "evolution"
  | "telegram"
  | "discord"
  | "sms"
  | "email"
  | "push";

export type ChannelSendResult =
  | { ok: true; external_id: string | null }
  | { ok: false; error: string };

export interface ChannelAdapter<TRawInbound = unknown> {
  readonly provider: ChannelProvider;
  readonly capabilities: ChannelCapabilities;
  normalizeInbound(payload: TRawInbound): CanonicalInboundMessage | null;
  send(input: ChannelSendInput): Promise<ChannelSendResult>;
}

type LegacySender = (
  destination: string,
  content: string,
) => Promise<ChannelSendResult>;

/** Wraps the current Meta sender; credentials and HTTP behavior remain owned by the legacy client. */
export function createMetaCloudAdapter(
  sendLegacy: LegacySender,
): ChannelAdapter<Record<string, unknown>> {
  return {
    provider: "meta-cloud",
    capabilities: {
      text: true,
      media: false,
      templates: false,
      deliveryReceipts: true,
      readReceipts: true,
    },
    normalizeInbound: normalizeMetaCloudInbound,
    send: ({ destination, content }) => {
      const normalized = normalizeWhatsAppOutbound(destination, content);
      return normalized
        ? sendLegacy(normalized.destination, normalized.content)
        : Promise.resolve({ ok: false, error: "Número do contato inválido." });
    },
  };
}

/** Wraps the current Evolution Go client without changing endpoint or credential semantics. */
export function createEvolutionAdapter(
  sendLegacy: LegacySender,
): ChannelAdapter<EvolutionInboundPayload> {
  return {
    provider: "evolution",
    capabilities: {
      text: true,
      media: false,
      templates: false,
      deliveryReceipts: true,
      readReceipts: true,
    },
    normalizeInbound: normalizeEvolutionInbound,
    send: ({ destination, content }) => {
      const normalized = normalizeWhatsAppOutbound(destination, content);
      return normalized
        ? sendLegacy(normalized.destination, normalized.content)
        : Promise.resolve({ ok: false, error: "Número do contato inválido." });
    },
  };
}
