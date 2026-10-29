// Contrato inbound do ManyChat → messaging-webhook.
//
// O ManyChat não tem webhook nativo de mensagem: quem chama é a ação "Make
// External Request" de uma automação, e o JSON é montado pelo operador. Por
// isso o contrato é NOSSO (docs/integrations/MANYCHAT.md). Duas formas, que
// podem ser misturadas — campo plano vence o da ficha:
//
//   1. Campos planos escolhidos no seletor de variáveis do ManyChat.
//   2. `contact`: a variável documentada "Full Contact Data" (JSON com id, key,
//      first_name, last_name, name, last_input_text, last_interaction...).
//
// Tenant e canal NUNCA vêm daqui: saem do channel_id + token da URL.
import type { CanonicalInboundMessage } from "./normalizers.ts";
import {
  isValidSubscriberId,
  type ManyChatProviderSlug,
  manyChatSurfaceForSlug,
} from "./manychat-client.ts";

export interface ManyChatInboundPayload {
  event_id?: string;
  subscriber_id?: string | number;
  channel?: string;
  event_type?: string;
  text?: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  phone?: string;
  email?: string;
  occurred_at?: string;
  /** Variável "Full Contact Data" do ManyChat. */
  contact?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/** Teto do corpo aceito pelo webhook — Full Contact Data com custom fields cabe folgado. */
export const MANYCHAT_MAX_BODY_BYTES = 64 * 1024;
const MAX_TEXT_CHARS = 10_000;
const MAX_NAME_CHARS = 200;
const MAX_EVENT_ID_CHARS = 200;

export type ManyChatNormalizeResult =
  | { ok: true; message: CanonicalInboundMessage; eventType: string }
  | { ok: false; code: string; error: string };

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * subscriber_id como string de dígitos. `contact.key` ("user:<id>") vem antes
 * de `contact.id` porque é string: o `id` da Full Contact Data chega como
 * número JSON e, com 17 dígitos, o JSON.parse já arredondou.
 */
function readSubscriberId(p: ManyChatInboundPayload): { id: string } | { error: string } {
  const raw = p.subscriber_id;
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw) || raw <= 0) {
      return {
        error:
          "subscriber_id chegou como número grande demais e perdeu precisão. No corpo do External Request, coloque a variável entre aspas.",
      };
    }
    return { id: String(raw) };
  }
  if (typeof raw === "string" && raw.trim()) return { id: raw.trim() };
  const key = str(p.contact?.key);
  const fromKey = /^user:(\d+)$/.exec(key)?.[1];
  if (fromKey) return { id: fromKey };
  const cid = p.contact?.id;
  if (typeof cid === "string" && cid.trim()) return { id: cid.trim() };
  if (typeof cid === "number" && Number.isSafeInteger(cid) && cid > 0) return { id: String(cid) };
  return { error: "subscriber_id ausente. Envie o ID do contato do ManyChat no corpo." };
}

function normalizePhoneDigits(v: string): string {
  const digits = v.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : "";
}

function normalizeEmail(v: string): string {
  const e = v.toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254 ? e : "";
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Normaliza o External Request no contrato canônico do messaging-webhook.
 *
 * Idempotência: o ManyChat não expõe id de mensagem nas variáveis. Sem
 * `event_id`, o external_id é um SHA-256 de (subscriber_id, superfície,
 * event_type, occurred_at, texto). Por isso `occurred_at` (ou o
 * `last_interaction` da Full Contact Data) é obrigatório nesse caso: é o que
 * separa duas mensagens reais com o mesmo texto, enquanto o reenvio do MESMO
 * request repete o mesmo valor e cai no dedupe. Nada aleatório entra na chave.
 */
export async function normalizeManyChatInbound(
  payload: unknown,
  providerSlug: ManyChatProviderSlug,
): Promise<ManyChatNormalizeResult> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, code: "invalid_payload", error: "Corpo precisa ser um objeto JSON." };
  }
  const p = payload as ManyChatInboundPayload;
  const contact = p.contact && typeof p.contact === "object" && !Array.isArray(p.contact)
    ? p.contact
    : undefined;
  const surface = manyChatSurfaceForSlug(providerSlug);

  const sub = readSubscriberId({ ...p, contact });
  if ("error" in sub) return { ok: false, code: "missing_subscriber_id", error: sub.error };
  if (!isValidSubscriberId(sub.id)) {
    return { ok: false, code: "invalid_subscriber_id", error: "subscriber_id precisa ser só dígitos." };
  }

  // Declarar outra superfície é configuração errada (URL do canal Instagram
  // colada na automação do WhatsApp): a resposta sairia pelo canal errado.
  const declared = str(p.channel).toLowerCase();
  const declaredSurface = declared === "facebook" ? "messenger" : declared;
  if (declaredSurface && declaredSurface !== surface) {
    return {
      ok: false,
      code: "channel_mismatch",
      error: `Este endereço é do canal ${surface}, mas o corpo diz "${declared}". Use a URL do canal certo.`,
    };
  }

  const eventType = (str(p.event_type) || "message.received").slice(0, 60);
  const occurredRaw = str(p.occurred_at) || str(contact?.last_interaction);
  const occurredMs = occurredRaw ? Date.parse(occurredRaw) : Number.NaN;
  if (occurredRaw && !Number.isFinite(occurredMs)) {
    return { ok: false, code: "invalid_occurred_at", error: "occurred_at não é uma data válida." };
  }
  const eventId = str(p.event_id).slice(0, MAX_EVENT_ID_CHARS);
  if (!eventId && !occurredRaw) {
    return {
      ok: false,
      code: "missing_idempotency_key",
      error:
        "Envie event_id ou occurred_at (ou a Full Contact Data, que traz last_interaction) para evitar mensagens duplicadas.",
    };
  }

  const text = (str(p.text) || str(contact?.last_input_text)).slice(0, MAX_TEXT_CHARS);
  const content = text || "[interação no ManyChat sem texto]";
  const occurredIso = Number.isFinite(occurredMs) ? new Date(occurredMs).toISOString() : "";

  const key = eventId
    ? `${sub.id}:${eventId}`
    : await sha256Hex(JSON.stringify([sub.id, surface, eventType, occurredIso, text]));

  const firstName = str(p.first_name) || str(contact?.first_name);
  const lastName = str(p.last_name) || str(contact?.last_name);
  const senderName = (str(p.full_name) || str(contact?.name) ||
    [firstName, lastName].filter(Boolean).join(" ")).slice(0, MAX_NAME_CHARS);
  // Telefone/e-mail servem para ligar o subscriber_id a um contato que já
  // existe no CRM. Só no WhatsApp o número é do próprio canal (verificado pelo
  // WhatsApp); em Instagram/Messenger é texto digitado pelo usuário, e casar
  // por ele deixaria qualquer um assumir a ficha (e o histórico que a IA usa)
  // de outra pessoa. Lá não vinculamos nem gravamos.
  const trusted = surface === "whatsapp";
  const phone = trusted
    ? normalizePhoneDigits(str(contact?.whatsapp_phone) || str(p.phone) || str(contact?.phone))
    : "";
  const email = trusted ? normalizeEmail(str(p.email) || str(contact?.email)) : "";

  return {
    ok: true,
    eventType,
    message: {
      provider: providerSlug,
      external_id: `manychat:${surface}:${key}`,
      from: sub.id,
      to: "",
      content,
      timestamp: occurredIso || new Date().toISOString(),
      fromMe: false,
      ...(senderName ? { senderName } : {}),
      ...(phone ? { contactPhone: phone } : {}),
      ...(email ? { contactEmail: email } : {}),
    },
  };
}
