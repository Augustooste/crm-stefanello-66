import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth/AuthProvider";
import { rpcRetry } from "@/lib/api/session-guard";

export const LEGACY_PLUGIN_CAPABILITIES = {
  agenda: "calendar.agenda",
  companies: "crm.companies",
  catalogo: "crm.catalog",
  "meta-ads": "integrations.meta_ads",
  feegow: "integrations.feegow",
  doutore: "integrations.doutore",
} as const;

export type LegacyPluginSlug = keyof typeof LEGACY_PLUGIN_CAPABILITIES;

export type EffectiveCapability = {
  capability_key: string;
  enabled: boolean;
  source: string;
};

export function capabilityForLegacyPlugin(slug: string): string | null {
  return LEGACY_PLUGIN_CAPABILITIES[slug as LegacyPluginSlug] ?? null;
}

/**
 * Entitlements explícitos são autoritativos. Se o backend ainda não retornou
 * uma capability (rollout/migration parcial), preserva a decisão legada.
 */
export function resolveCapability(
  capabilityKey: string,
  capabilities: EffectiveCapability[] | null | undefined,
  legacyEnabled: boolean,
): boolean {
  const entitlement = capabilities?.find((item) => item.capability_key === capabilityKey);
  return entitlement?.enabled ?? legacyEnabled;
}

export const myCapabilitiesQueryOptions = () => ({
  queryKey: ["my-capabilities"] as const,
  queryFn: async (): Promise<EffectiveCapability[]> => {
    // Trava de sessão: sem token a chamada iria como `anon` e voltaria 42501.
    // Sem sessão não há capabilities — devolve vazio e deixa o resolver legado
    // decidir, em vez de estourar no error boundary da rota.
    const { data: sessionData } = await supabase.auth.getSession();
    if (!sessionData.session) return [];

    const rpc = supabase.rpc.bind(supabase) as unknown as (
      name: string,
    ) => Promise<{ data: EffectiveCapability[] | null; error: { message: string } | null }>;
    const { data, error } = await rpc("get_my_capabilities");
    if (error) throw error;
    return data ?? [];
  },
  staleTime: 60_000,
  retry: rpcRetry,
  retryDelay: 400,
  // Capabilities é chrome de navegação: se falhar, o app degrada para o
  // cálculo legado de plugins. Nunca deve derrubar a página inteira.
  throwOnError: false,
});

export function useMyCapabilities() {
  const { user, isReady } = useAuth();
  return useQuery({
    ...myCapabilitiesQueryOptions(),
    queryKey: ["my-capabilities", user?.id ?? null] as const,
    enabled: isReady && !!user,
  });
}
