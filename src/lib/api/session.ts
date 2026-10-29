import { useQuery, type QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth/AuthProvider";
import { permissionQueryOptions } from "@/lib/api/workspaces";

export type CurrentProfile = {
  id: string;
  tenant_id: string;
  name: string;
  role: "admin" | "agent";
  /** Preferência de aparência do usuário; ver useAppearanceSync. */
  appearance?: unknown;
};

// Exportada (não só interna) para que outros guards de rota -- ex.:
// requirePluginActive em plugins.ts -- ensureQueryData() na MESMA queryKey e
// reaproveitem o cache do perfil, em vez de duplicar a query.
export function profileQueryOptions(userId: string | null) {
  return {
    queryKey: ["current-profile", userId] as const,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<CurrentProfile | null> => {
      if (!userId) return null;
      const { data, error } = await supabase
        .from("profiles")
        .select("id, tenant_id, name, role, appearance")
        .eq("id", userId)
        .maybeSingle();
      if (error) throw error;
      return (data as CurrentProfile) ?? null;
    },
  };
}

export function useCurrentProfile() {
  const { user, isReady } = useAuth();
  return useQuery({
    ...profileQueryOptions(user?.id ?? null),
    enabled: isReady && !!user,
  });
}

// Route guard for admin-only pages. Runs in `beforeLoad` (before the component
// renders) so a non-admin never sees a flash of protected content — unlike a
// check in the component body, which renders while the profile loads.
export async function requireAdmin(queryClient: QueryClient): Promise<void> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const user = session?.user ?? null;
  const access = (await queryClient.ensureQueryData(
    permissionQueryOptions(
      user?.id ?? null,
      user?.app_metadata?.active_tenant_id as string | undefined,
    ),
  )) as unknown;
  // Object fallback keeps older pre-RBAC test doubles and rolling deploys safe.
  const allowed = Array.isArray(access)
    ? access.includes("tenant.settings.manage")
    : (access as CurrentProfile | null)?.role === "admin";
  if (!allowed) {
    throw redirect({ to: "/app" });
  }
}

export async function requirePermission(
  queryClient: QueryClient,
  permission: string,
): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const user = data.session?.user ?? null;
  const permissions = await queryClient.ensureQueryData(
    permissionQueryOptions(
      user?.id ?? null,
      user?.app_metadata?.active_tenant_id as string | undefined,
    ),
  );
  if (!permissions.includes(permission)) throw redirect({ to: "/app" });
}

export function useTenantProfiles() {
  const { isReady, user } = useAuth();
  return useQuery({
    queryKey: ["tenant-profiles"],
    enabled: isReady && !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, name, role")
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
}
