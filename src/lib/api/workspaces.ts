import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth/AuthProvider";

export type Workspace = {
  tenant_id: string;
  tenant_name: string;
  logo_url: string | null;
  role_key: string;
  is_active: boolean;
};

type RpcResponse = Promise<{ data: unknown; error: { message: string } | null }>;
type RpcFn = (functionName: string, args?: Record<string, unknown>) => RpcResponse;
const getRpc = (): RpcFn => supabase.rpc.bind(supabase) as unknown as RpcFn;

export function workspaceQueryOptions(userId: string | null) {
  return {
    queryKey: ["my-workspaces", userId] as const,
    staleTime: 60_000,
    queryFn: async (): Promise<Workspace[]> => {
      if (!userId) return [];
      const { data, error } = await getRpc()("list_my_workspaces");
      if (error) throw new Error(error.message);
      return (data ?? []) as Workspace[];
    },
  };
}

export function permissionQueryOptions(userId: string | null, activeTenantClaim?: string) {
  return {
    queryKey: ["my-permissions", userId, activeTenantClaim ?? "profile-fallback"] as const,
    staleTime: 60_000,
    queryFn: async (): Promise<string[]> => {
      if (!userId) return [];
      const { data, error } = await getRpc()("get_my_permissions");
      if (error) throw new Error(error.message);
      return (data ?? []) as string[];
    },
  };
}

export function useWorkspaces() {
  const { user, isReady } = useAuth();
  return useQuery({ ...workspaceQueryOptions(user?.id ?? null), enabled: isReady && !!user });
}

export function usePermissions() {
  const { user, isReady } = useAuth();
  const claim = user?.app_metadata?.active_tenant_id as string | undefined;
  return useQuery({
    ...permissionQueryOptions(user?.id ?? null, claim),
    enabled: isReady && !!user,
  });
}

export function useCan(permission: string): boolean {
  const { data } = usePermissions();
  return data?.includes(permission) ?? false;
}

export function useSwitchWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (tenantId: string) => {
      const { data, error } = await getRpc()("switch_active_workspace", { p_tenant_id: tenantId });
      if (error) throw new Error(error.message);
      if (data !== true) throw new Error("Não foi possível trocar de workspace");
      const refreshed = await supabase.auth.refreshSession();
      if (refreshed.error) throw refreshed.error;
      return tenantId;
    },
    onSuccess: () => {
      // NÃO invalidar aqui. `invalidateQueries()` não só marca stale: ele
      // REFETCHA toda query ativa — e nesse instante a sessão já aponta para o
      // tenant novo enquanto o `profile` em cache ainda é o do anterior. Quem é
      // admin num workspace e atendente no outro disparava `dashboard_report`
      // (admin-only) contra o destino e levava `forbidden`, medido em produção
      // em 2026-08-10 18:47:37. O `assign` abaixo é reload de página inteira:
      // descarta o cache sozinho, então o refetch era trabalho jogado fora que
      // só servia para gerar erro.
      window.location.assign("/app");
    },
  });
}
