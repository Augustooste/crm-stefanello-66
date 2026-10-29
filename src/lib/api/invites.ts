import { supabase } from "@/integrations/supabase/client";

/** Prazo do convite — é o mesmo prazo que a UI promete ("expira em 7 dias"). */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Token do link `/auth?invite=<token>`: dois UUIDs sem hífen (64 caracteres). */
function newInviteToken(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

function newExpiry(): string {
  return new Date(Date.now() + INVITE_TTL_MS).toISOString();
}

export type CreateInviteInput = {
  tenantId: string;
  email: string;
  role: "admin" | "agent";
  createdBy: string | null;
};

export type CreateInviteResult = {
  token: string;
  /** Quantos convites abertos do mesmo e-mail foram invalidados por este. */
  superseded: number;
};

/**
 * Cria o convite e invalida os convites ainda abertos para o mesmo e-mail neste
 * workspace.
 *
 * Sem UNIQUE em `(tenant_id, lower(email))`, convidar duas vezes o mesmo
 * endereço deixa duas linhas com `accepted_at is null`: o trigger de aceite casa
 * por `lower(email) + token`, então quem decide o papel do convidado passa a ser
 * "qual link ele ainda tem em mãos". O convite novo tem que matar o anterior.
 *
 * A comparação é feita em JS depois de listar os convites abertos, e não com
 * `ilike`: `_` e `%` são coringas de LIKE e apagariam o convite de um endereço
 * parecido (`joao_silva@x.com` casaria com `joao.silva@x.com`).
 */
export async function createInvite({
  tenantId,
  email,
  role,
  createdBy,
}: CreateInviteInput): Promise<CreateInviteResult> {
  const normalizedEmail = email.trim().toLowerCase();

  // Lista sempre fresca do banco: a lista da tela pode estar velha se outro
  // admin convidou o mesmo e-mail há pouco.
  const { data: openInvites, error: listError } = await supabase
    .from("invites")
    .select("id, email")
    .eq("tenant_id", tenantId)
    .is("accepted_at", null);
  if (listError) throw listError;

  const supersededIds = (openInvites ?? [])
    .filter((invite) => invite.email.trim().toLowerCase() === normalizedEmail)
    .map((invite) => invite.id);

  // Falha fechada: se o banco recusar a limpeza, não insere — inserir mesmo
  // assim recriaria a duplicidade em silêncio, que é justamente o defeito.
  if (supersededIds.length > 0) {
    const { error: deleteError } = await supabase.from("invites").delete().in("id", supersededIds);
    if (deleteError) throw deleteError;
  }

  const { data, error } = await supabase
    .from("invites")
    .insert({
      tenant_id: tenantId,
      email: normalizedEmail,
      role,
      token: newInviteToken(),
      expires_at: newExpiry(),
      created_by: createdBy,
    })
    .select("token")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Convite não foi gravado. Atualize a lista e tente de novo.");

  return { token: data.token, superseded: supersededIds.length };
}

/**
 * Renova o convite trocando o token, não só a validade.
 *
 * Estender `expires_at` mantendo o mesmo token revive por mais 7 dias um segredo
 * que já pode ter vazado (print, área de transferência, canal errado). Com o
 * token novo, o link antigo para de valer no mesmo instante.
 *
 * Lê o token de volta: um update que não pega nenhuma linha volta sem erro, e aí
 * mostrar "novo link gerado" seria mentira — o link antigo continuaria vivo.
 */
export async function rotateInviteToken(inviteId: string): Promise<string> {
  const { data, error } = await supabase
    .from("invites")
    .update({ token: newInviteToken(), expires_at: newExpiry() })
    .eq("id", inviteId)
    .select("token")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Convite não encontrado. Atualize a lista e tente de novo.");

  return data.token;
}
