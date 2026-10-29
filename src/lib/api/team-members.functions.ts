import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Criação direta de membro (com senha inicial) pelo admin do workspace.
 *
 * O caminho é o convite + `handle_new_user`: gravamos um convite de uso único
 * para o e-mail e criamos o usuário já com `invite_token` no metadata. Assim o
 * gatilho existente vincula o perfil ao tenant do convite em vez de abrir um
 * workspace novo, e `profiles_sync_tenant_membership` cria o vínculo de RBAC.
 * Nenhuma escrita direta em `auth.users` e nenhuma mudança de schema.
 *
 * O tenant NUNCA vem do corpo da requisição: sai do perfil de quem chama.
 */

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 8;

export type TeamMemberRole = "admin" | "agent";

export type CreateTeamMemberInput = {
  name: string;
  email: string;
  role: TeamMemberRole;
  password: string;
};

export type CreateTeamMemberResult = {
  userId: string;
  email: string;
  role: TeamMemberRole;
};

function newInviteToken(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

export function validateInput(input: CreateTeamMemberInput): CreateTeamMemberInput {
  const name = String(input?.name ?? "").trim();
  const email = String(input?.email ?? "")
    .trim()
    .toLowerCase();
  const role = input?.role === "admin" ? "admin" : "agent";
  const password = String(input?.password ?? "");

  if (name.length < 2) throw new Error("Informe o nome da pessoa.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("E-mail inválido.");
  if (input?.role !== "admin" && input?.role !== "agent") throw new Error("Papel inválido.");
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`A senha precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`);
  }

  return { name, email, role, password };
}

/** Mensagem PT-BR para os erros reais da Admin API — sem vazar detalhe cru. */
export function friendlyAdminError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("already been registered") || lower.includes("already exists")) {
    return "Este e-mail já tem conta. Peça para a pessoa entrar ou use a recuperação de senha.";
  }
  if (lower.includes("password")) {
    return "Senha recusada: use uma senha mais longa ou mais forte.";
  }
  if (lower.includes("email")) {
    return "E-mail recusado pelo servidor de contas. Confira o endereço.";
  }
  return "Não foi possível criar a conta agora. Tente novamente em instantes.";
}

export const createTeamMember = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: CreateTeamMemberInput) => validateInput(input))
  .handler(async ({ data, context }): Promise<CreateTeamMemberResult> => {
    const { supabase, userId } = context;

    // Falha fechada: só admin ativo do workspace cria membro.
    const { data: caller, error: callerError } = await supabase
      .from("profiles")
      .select("tenant_id, role, disabled")
      .eq("id", userId)
      .maybeSingle();
    if (callerError) throw new Error("Não foi possível confirmar suas permissões.");
    if (!caller || caller.role !== "admin" || caller.disabled) {
      throw new Error("Apenas administradores do workspace podem adicionar membros.");
    }
    const tenantId = caller.tenant_id;

    // Convites abertos para o mesmo e-mail perdem a validade (comparação em JS:
    // `_` e `%` são coringas de LIKE e pegariam endereço parecido).
    const { data: openInvites, error: listError } = await supabase
      .from("invites")
      .select("id, email")
      .eq("tenant_id", tenantId)
      .is("accepted_at", null);
    if (listError) throw listError;

    const supersededIds = (openInvites ?? [])
      .filter((invite) => invite.email.trim().toLowerCase() === data.email)
      .map((invite) => invite.id);
    if (supersededIds.length > 0) {
      const { error: deleteError } = await supabase
        .from("invites")
        .delete()
        .in("id", supersededIds);
      if (deleteError) throw deleteError;
    }

    const token = newInviteToken();
    const { data: invite, error: inviteError } = await supabase
      .from("invites")
      .insert({
        tenant_id: tenantId,
        email: data.email,
        role: data.role,
        token,
        expires_at: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
        created_by: userId,
      })
      .select("id")
      .maybeSingle();
    if (inviteError) throw inviteError;
    if (!invite) throw new Error("Não foi possível registrar o convite interno.");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const created = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
      user_metadata: { name: data.name, invite_token: token },
    });

    if (created.error || !created.data?.user) {
      // Sem convite órfão: o token só existe para esta criação.
      await supabase.from("invites").delete().eq("id", invite.id);
      const raw = created.error?.message ?? "Usuário não foi criado";
      // A senha nunca entra em log.
      console.error("[team-create-member] falha na Admin API:", raw);
      throw new Error(friendlyAdminError(raw));
    }

    return { userId: created.data.user.id, email: data.email, role: data.role };
  });
