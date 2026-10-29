// load-profile.ts — leitura do perfil do usuário autenticado, separando
// "erro de infraestrutura" de "perfil não existe".
//
// O BUG QUE ISTO FECHA (item 6 de docs/code-review/05-silent-failures.md):
// o padrão espalhado pelos entrypoints era
//
//   const { data: profile } = await admin.from("profiles")...maybeSingle();
//   if (!profile) return json(403, { error: "Perfil não encontrado." });
//
// `supabase-js` NÃO lança em erro de banco — devolve `{ data: null, error }`.
// Descartando `error`, uma queda do banco fica indistinguível de um perfil
// inexistente, e o usuário recebe 403 dizendo que o cadastro dele não existe.
// Além de mentir, 403 é terminal: o cliente não repete. O certo para falha de
// infra é 503, que é retentável.
//
// POR QUE NÃO DEVOLVE UMA `Response` PRONTA
// Cada entrypoint monta a resposta com o CORS dele — uns têm `function json`
// no módulo, outros um `json` de closure capturando `buildCors(req)` por
// request. Um helper que construísse a Response teria que reimplementar essa
// negociação de origem, e erraria em pelo menos um caller. Então ele devolve
// um resultado discriminado e o caller mapeia com o próprio `json`, mantendo
// a dona do CORS onde ela já estava.
//
// A referência de comportamento é integration-connect/index.ts (~linha 504),
// que já fazia essa separação à mão desde a rodada 3 do code review.
//
// Uso:
//   const prof = await loadProfileOrFail(admin, userId, {
//     operation: "ai.insights.load_profile",
//     requireAdmin: true,
//   });
//   if (!prof.ok) {
//     if (prof.reason === "db_error") {
//       return json(503, { error: PROFILE_DB_ERROR_MESSAGE });
//     }
//     if (prof.reason === "not_admin") {
//       return json(403, { error: "Apenas administradores." });
//     }
//     return json(403, { error: "Perfil não encontrado." });
//   }
//   const tenantId = prof.tenantId;

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

import { captureEdgeError } from "./telemetry.ts";

/**
 * Texto único para falha de infraestrutura ao ler o perfil. Centralizado para
 * os 5 entrypoints não divergirem em redação — o operador que vir dois textos
 * diferentes para a mesma falha vai procurar duas causas.
 */
export const PROFILE_DB_ERROR_MESSAGE =
  "Instabilidade ao verificar suas permissões. Tente de novo em instantes.";

export type LoadProfileResult =
  | { ok: true; tenantId: string; role: string | null }
  | { ok: false; reason: "db_error" }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "membership_not_found" }
  | { ok: false; reason: "membership_inactive" }
  | { ok: false; reason: "not_admin" };

export interface LoadProfileOptions {
  /** `operation` do evento em system_events. Convenção: `dominio.acao`. */
  operation: string;
  /** Quando true, papel diferente de "admin" devolve `reason: "not_admin"`. */
  requireAdmin?: boolean;
}

type MembershipRoleResult =
  | { ok: true; role: string }
  | { ok: false; reason: "db_error" | "membership_not_found" | "membership_inactive" };

interface SupabaseReadError {
  message: string;
  code?: string | null;
}

async function reportPermissionReadError(
  admin: SupabaseClient,
  userId: string,
  options: LoadProfileOptions,
  resource: "profile" | "membership" | "role",
  error: SupabaseReadError,
): Promise<void> {
  console.error(`[${options.operation}] falha ao ler ${resource}:`, error.message);
  await captureEdgeError(admin, {
    severity: "error",
    source: "edge",
    operation: options.operation,
    errorCode: error.code ?? null,
    message: error.message,
    context: { user_id: userId, resource },
  });
}

async function loadActiveMembershipRole(
  admin: SupabaseClient,
  userId: string,
  tenantId: string,
  options: LoadProfileOptions,
): Promise<MembershipRoleResult> {
  const { data: membership, error } = await admin
    .from("tenant_memberships")
    .select("tenant_id, user_id, role_id, status, revoked_at")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle<{
      tenant_id: string;
      user_id: string;
      role_id: string;
      status: string;
      revoked_at: string | null;
    }>();
  if (error) {
    await reportPermissionReadError(admin, userId, options, "membership", error);
    return { ok: false, reason: "db_error" };
  }
  if (!membership) return { ok: false, reason: "membership_not_found" };
  if (membership.tenant_id !== tenantId || membership.user_id !== userId) {
    return { ok: false, reason: "membership_not_found" };
  }
  if (membership.status !== "active" || membership.revoked_at !== null) {
    return { ok: false, reason: "membership_inactive" };
  }

  const { data: role, error: roleError } = await admin
    .from("roles")
    .select("role_key")
    .eq("id", membership.role_id)
    .eq("tenant_id", tenantId)
    .maybeSingle<{ role_key: string }>();
  if (roleError) {
    await reportPermissionReadError(admin, userId, options, "role", roleError);
    return { ok: false, reason: "db_error" };
  }
  if (!role?.role_key) return { ok: false, reason: "membership_not_found" };
  return { ok: true, role: role.role_key };
}

/**
 * Lê `public.profiles` pelo id do usuário autenticado.
 *
 * Nunca lança. Erro de banco vira `reason: "db_error"` E um evento em
 * `system_events` — a captura fica AQUI, não no caller, porque esquecer de
 * reportar foi exatamente o que produziu o bug original em 5 arquivos.
 *
 * `tenant_id` nulo é tratado como `not_found`, não como sucesso com tenant
 * vazio: um perfil sem tenant não consegue passar por nenhuma policy de RLS
 * depois, e devolver `ok: true` só empurraria a falha para um ponto onde a
 * causa não é mais legível.
 */
export async function loadProfileOrFail(
  admin: SupabaseClient,
  userId: string,
  options: LoadProfileOptions,
): Promise<LoadProfileResult> {
  const { data, error } = await admin
    .from("profiles")
    .select("tenant_id")
    .eq("id", userId)
    .maybeSingle<{ tenant_id: string | null }>();

  if (error) {
    await reportPermissionReadError(admin, userId, options, "profile", error);
    return { ok: false, reason: "db_error" };
  }

  if (!data || !data.tenant_id) return { ok: false, reason: "not_found" };
  const membership = await loadActiveMembershipRole(admin, userId, data.tenant_id, options);
  if (!membership.ok) return membership;
  if (options.requireAdmin && membership.role !== "admin") {
    return { ok: false, reason: "not_admin" };
  }

  return { ok: true, tenantId: data.tenant_id, role: membership.role };
}
