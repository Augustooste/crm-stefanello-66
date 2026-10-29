import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { normalizePhone } from "./conversation.ts";
import { isManyChatSlug } from "./manychat-client.ts";

export type ContactIdentityType =
  | "phone"
  | "email"
  | "provider_user"
  | "push_device";

export function normalizeContactIdentity(
  type: ContactIdentityType,
  value: string,
): string {
  return type === "phone"
    ? normalizePhone(value)
    : type === "email"
    ? value.trim().toLowerCase()
    : value.trim();
}

export interface IdentityResolution {
  contactId: string | null;
  source: "identity" | "legacy" | "none";
}

/** Escapa curingas de ILIKE (%, _, \) para que a busca de e-mail seja uma
 * comparação case-insensitive exata, não um pattern match — sem isso, um
 * `rawValue` malicioso como "%" casaria com qualquer contato do tenant. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Resolve identity strictly inside a tenant. While the identity table is in
 * rollout, any query error falls back to contacts.phone/email.
 */
export async function resolveContactIdentity(
  admin: SupabaseClient,
  tenantId: string,
  type: ContactIdentityType,
  rawValue: string,
  providerSlug = "generic",
): Promise<IdentityResolution> {
  const normalized = normalizeContactIdentity(type, rawValue);
  if (!normalized) return { contactId: null, source: "none" };

  const { data: identity, error: identityError } = await admin
    .from("contact_identities")
    .select("contact_id")
    .eq("tenant_id", tenantId)
    .eq("identity_type", type)
    .eq("provider_slug", providerSlug)
    .eq("normalized_value", normalized)
    .maybeSingle();
  if (identityError) {
    // Erro de DB ao ler contact_identities: phone/email ainda têm o backstop
    // legado abaixo, mas provider_user/push_device NÃO (o trigger de dual-write
    // só cobre phone/email). Nesses tipos um erro aqui devolve `none` e o caller
    // cria um contato DUPLICADO. Logar para dar observabilidade a esse caminho.
    console.error("resolveContactIdentity: falha ao ler contact_identities", {
      tenantId,
      type,
      providerSlug,
      error: identityError,
    });
  }
  if (!identityError && identity?.contact_id) {
    const { data: active, error: activeError } = await admin
      .from("contacts")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("id", identity.contact_id)
      .is("deleted_at", null)
      .maybeSingle();
    if (activeError) {
      // Erro aqui é indistinguível de "o contato do identity foi apagado": o
      // fluxo segue para o backstop legado e, sem ele (provider_user/
      // push_device), o caller cria um contato DUPLICADO. Mesmo risco já
      // logado nos dois caminhos vizinhos — esta query estava sem log.
      console.error("resolveContactIdentity: falha ao ler contacts do identity resolvido", {
        tenantId,
        type,
        providerSlug,
        contactId: identity.contact_id,
        error: activeError,
      });
    }
    if (active?.id) {
      return { contactId: active.id as string, source: "identity" };
    }
  }

  if (type !== "phone" && type !== "email") {
    return { contactId: null, source: "none" };
  }
  let query = admin
    .from("contacts")
    .select("id")
    .eq("tenant_id", tenantId)
    .is("deleted_at", null);
  query = type === "phone"
    ? query.eq("phone", normalized)
    : query.ilike("email", escapeLikePattern(normalized));
  const { data: legacy, error: legacyError } = await query
    .order("created_at", { ascending: true })
    .limit(1).maybeSingle();
  if (legacyError) {
    console.error("resolveContactIdentity: falha no backstop legado de contacts", {
      tenantId,
      type,
      error: legacyError,
    });
  }
  return legacy?.id
    ? { contactId: legacy.id as string, source: "legacy" }
    : { contactId: null, source: "none" };
}

export type IdentitySyncResult =
  | "created"
  | "existing"
  | "conflict"
  | "unavailable";

/** Best-effort bridge for service flows; DB trigger remains the universal dual-write. */
export async function ensureContactIdentity(
  admin: SupabaseClient,
  params: {
    tenantId: string;
    contactId: string;
    type: ContactIdentityType;
    rawValue: string;
    providerSlug?: string;
  },
): Promise<IdentitySyncResult> {
  const normalized = normalizeContactIdentity(params.type, params.rawValue);
  if (!normalized) return "unavailable";
  const baseQuery = () =>
    admin
      .from("contact_identities")
      .select("contact_id")
      .eq("tenant_id", params.tenantId)
      .eq("identity_type", params.type)
      .eq("provider_slug", params.providerSlug ?? "generic")
      .eq("normalized_value", normalized);
  const { data: existing, error } = await baseQuery().maybeSingle();
  if (error) {
    console.error("ensureContactIdentity: falha ao ler contact_identities", {
      tenantId: params.tenantId,
      type: params.type,
      providerSlug: params.providerSlug ?? "generic",
      error,
    });
    return "unavailable";
  }
  if (existing?.contact_id) {
    return existing.contact_id === params.contactId ? "existing" : "conflict";
  }

  const { error: insertError } = await admin.from("contact_identities").insert({
    tenant_id: params.tenantId,
    contact_id: params.contactId,
    identity_type: params.type,
    provider_slug: params.providerSlug ?? "generic",
    external_id: params.rawValue,
    normalized_value: normalized,
    is_primary: true,
  });
  if (!insertError) return "created";
  if ((insertError as { code?: string }).code !== "23505") {
    // Insert do identity falhou por motivo != conflito único (23505). Sem este
    // registro, provider_user/push_device (sem backstop no trigger) voltam a
    // não resolver na próxima mensagem e geram contato DUPLICADO em loop. Logar.
    console.error("ensureContactIdentity: falha ao inserir contact_identity", {
      tenantId: params.tenantId,
      contactId: params.contactId,
      type: params.type,
      providerSlug: params.providerSlug ?? "generic",
      error: insertError,
    });
    return "unavailable";
  }
  const { data: raced } = await baseQuery().maybeSingle();
  return raced?.contact_id === params.contactId ? "existing" : "conflict";
}

/** Canais genéricos endereçados por identidade (não por contacts.phone/email). */
const MULTICHANNEL_IDENTITY: Record<string, ContactIdentityType> = {
  telegram: "provider_user",
  discord: "provider_user",
  sms: "phone",
  email: "email",
  push: "push_device",
};

export type DestinationResolution =
  | { ok: true; destination: string | undefined }
  | { ok: false; error: string };

export const MANYCHAT_MISSING_IDENTITY_ERROR =
  "Este contato não tem ID do ManyChat para este canal. Só dá para responder quem já escreveu por ele — atenda por outro canal.";

/**
 * Destino de envio que NÃO é o telefone/e-mail do contato. Único ponto usado
 * por envio manual, IA, nurture e campanhas.
 *
 * - ManyChat: `provider_user` do slug EXATO (subscriber_id). Sem fallback para
 *   "generic" nem para telefone: um subscriber_id de outra superfície ou um
 *   telefone mandaria a mensagem para a pessoa errada.
 * - telegram/discord/sms/email/push: identidade do slug, com "generic" de
 *   reserva (comportamento que vivia inline no messaging-send).
 * - Demais providers: `undefined` — o dispatcher usa contacts.phone/email.
 */
export async function resolveProviderDestination(
  admin: SupabaseClient,
  params: { tenantId: string; contactId: string; providerSlug: string },
): Promise<DestinationResolution> {
  const { tenantId, contactId, providerSlug } = params;
  const manyChat = isManyChatSlug(providerSlug);
  const identityType = manyChat ? "provider_user" : MULTICHANNEL_IDENTITY[providerSlug];
  if (!identityType) return { ok: true, destination: undefined };

  const slugs = manyChat ? [providerSlug] : [providerSlug, "generic"];
  const { data, error } = await admin
    .from("contact_identities")
    .select("external_id, provider_slug")
    .eq("tenant_id", tenantId)
    .eq("contact_id", contactId)
    .eq("identity_type", identityType)
    .in("provider_slug", slugs);
  if (error) {
    console.error("resolveProviderDestination: falha ao ler contact_identities", {
      tenantId,
      providerSlug,
      error: error.message,
    });
    return { ok: false, error: "Instabilidade ao buscar o destino do contato. Tente de novo." };
  }
  // A identidade específica do provider sempre vence a "generic".
  const rows = (data ?? []) as Array<{ external_id: string; provider_slug: string }>;
  const chosen = rows.find((r) => r.provider_slug === providerSlug) ??
    rows.find((r) => r.provider_slug === "generic");
  const destination = chosen?.external_id?.trim() || undefined;
  if (manyChat && !destination) return { ok: false, error: MANYCHAT_MISSING_IDENTITY_ERROR };
  return { ok: true, destination };
}
