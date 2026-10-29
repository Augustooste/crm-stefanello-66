import type { ChannelType } from "@/integrations/agent-platform/enums.gen";
import type { AgentPlatformChannel } from "@/lib/api/agent-platform-contract";

/** Rótulo PT-BR por tipo. `Record<ChannelType, string>` — se o contrato ganhar
 * um 10º valor, o build quebra até alguém adicionar o rótulo aqui. */
export const CHANNEL_TYPE_LABELS: Record<ChannelType, string> = {
  Z_API: "Z-API (WhatsApp não oficial)",
  WHATSAPP: "WhatsApp",
  INSTAGRAM: "Instagram",
  CLOUD_API: "WhatsApp Cloud API (Meta oficial)",
  TELEGRAM: "Telegram",
  WIDGET: "Widget (chat no site)",
  MESSENGER: "Messenger",
  MERCADO_LIVRE: "Mercado Livre",
  TWILIO_SMS: "SMS (Twilio)",
};

export interface NormalizedChannel {
  id: string;
  name: string;
  type: ChannelType;
  agentId: string | null;
  agentName: string | null;
  connected: boolean;
}

/** A listagem devolve todo campo opcional (nada é `required` no schema).
 * Descarta defensivamente qualquer item sem os 3 campos que a tela precisa
 * pra funcionar (id/name/type) em vez de arriscar `undefined` viajando pelas
 * ações de escrita. */
export function normalizeChannel(raw: AgentPlatformChannel): NormalizedChannel | null {
  if (typeof raw.id !== "string" || typeof raw.name !== "string" || typeof raw.type !== "string") {
    return null;
  }
  return {
    id: raw.id,
    name: raw.name,
    type: raw.type,
    agentId: raw.agentId ?? null,
    agentName: raw.agentName ?? null,
    connected: raw.connected ?? false,
  };
}
