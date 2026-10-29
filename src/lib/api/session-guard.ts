import { supabase } from "@/integrations/supabase/client";

/**
 * Erro de permissão (42501/401): acontece quando a RPC chega ao PostgREST sem
 * token — ou seja, o papel no banco é `anon`, que não tem EXECUTE nas RPCs
 * tenant-scoped. Era a causa do "/app quebrado logo após o login": a query
 * saía em paralelo com a hidratação da sessão.
 *
 * Padrão nasceu em entitlements.ts (get_my_capabilities); dashboard-widgets.ts
 * e reports.ts reusam daqui em vez de duplicar.
 */
export function isPermissionError(error: unknown): boolean {
  const record = (typeof error === "object" && error !== null ? error : {}) as Record<
    string,
    unknown
  >;
  const code = String(record.code ?? "");
  const message = String(record.message ?? "");
  return code === "42501" || code === "401" || /permission denied/i.test(message);
}

/** Retry 2x em erro de permissão (dá tempo da sessão hidratar), 1x no resto. */
export function rpcRetry(failureCount: number, error: unknown): boolean {
  return failureCount < (isPermissionError(error) ? 2 : 1);
}

/**
 * Trava de sessão: aguarda o token anexar antes de disparar a RPC. Sem isso a
 * chamada pode sair como `anon` e voltar 42501.
 */
export async function waitForSession(): Promise<void> {
  await supabase.auth.getSession();
}
