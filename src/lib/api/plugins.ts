import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { logClientError } from "@/lib/client-error-telemetry";
import { useCurrentProfile, profileQueryOptions } from "@/lib/api/session";
import {
  capabilityForLegacyPlugin,
  LEGACY_PLUGIN_CAPABILITIES,
  resolveCapability,
  useMyCapabilities,
} from "@/lib/api/entitlements";
import {
  useNicheTemplates,
  useTenantOnboarding,
  type NicheTemplate,
  type TenantOnboardingRow,
} from "@/lib/api/onboarding";

/**
 * Overrides por tenant, guardados em business_profile.plugin_overrides --
 * chave = slug do plugin, valor = true (força ativo) ou false (força
 * inativo), independente do default de fábrica do niche_template. Lê de
 * forma defensiva: shape ausente/malformado vira {} em vez de lançar.
 */
function extractPluginOverrides(
  businessProfile: Record<string, unknown> | null,
): Record<string, boolean> {
  if (!businessProfile || typeof businessProfile !== "object") return {};
  const raw = businessProfile.plugin_overrides;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const overrides: Record<string, boolean> = {};
  for (const [slug, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "boolean") overrides[slug] = value;
  }
  return overrides;
}

/**
 * Regra de ativação efetiva de um plugin: override explícito do tenant
 * (business_profile.plugin_overrides[slug]) sempre vence; sem override,
 * cai no default de fábrica do niche_template (nichePlugins). Precisa
 * suportar tanto DESATIVAR um plugin que o nicho liga por padrão quanto
 * ATIVAR um que o nicho não inclui -- por isso não é uma união simples de
 * conjuntos (set-union não cobre o caso de desativar um default).
 *
 * Pura, sem I/O -- fácil de testar isoladamente (ver plugins.test.ts).
 */
export function resolveActivePlugins(
  nichePlugins: string[],
  businessProfile: Record<string, unknown> | null,
): string[] {
  const overrides = extractPluginOverrides(businessProfile);
  const slugs = new Set<string>([...nichePlugins, ...Object.keys(overrides)]);
  return Array.from(slugs).filter((slug) => {
    const override = overrides[slug];
    return override !== undefined ? override : nichePlugins.includes(slug);
  });
}

/**
 * Plugins efetivamente ativos do tenant atual. Retorna [] enquanto as
 * queries carregam ou se tenant/niche ainda não resolveram. `tenants.niche`
 * é TEXT livre (não FK para niche_templates.slug) -- um niche que não bate
 * com nenhum niche_template não trava a resolução: só não contribui
 * defaults, os overrides do tenant continuam valendo.
 */
export function useActivePlugins(): string[] {
  const nicheQuery = useNicheTemplates();
  const tenantQuery = useTenantOnboarding();
  const capabilitiesQuery = useMyCapabilities();

  if (nicheQuery.isLoading || tenantQuery.isLoading) return [];

  const tenant = tenantQuery.data;
  if (!tenant?.niche) return [];

  const template = (nicheQuery.data ?? []).find((t) => t.slug === tenant.niche);
  const nichePlugins = template?.plugins ?? [];
  const businessProfile = tenant.business_profile as unknown as Record<string, unknown> | null;
  const legacyPlugins = resolveActivePlugins(nichePlugins, businessProfile);
  if (!capabilitiesQuery.data) return legacyPlugins;

  const candidates = new Set<string>([
    ...legacyPlugins,
    ...Object.keys(LEGACY_PLUGIN_CAPABILITIES),
  ]);
  return Array.from(candidates).filter((slug) => {
    const capability = capabilityForLegacyPlugin(slug);
    if (!capability) return legacyPlugins.includes(slug);
    return resolveCapability(capability, capabilitiesQuery.data, legacyPlugins.includes(slug));
  });
}

export function usePluginActive(slug: string): boolean {
  return useActivePlugins().includes(slug);
}

/**
 * Route guard por plugin -- roda em `beforeLoad` (antes do componente
 * renderizar), mesmo padrão de `requireAdmin` (session.ts): um tenant sem o
 * plugin ativo não deve conseguir acessar a rota digitando a URL, não só ter
 * o link escondido no nav.
 *
 * `useNicheTemplates`/`useTenantOnboarding` não são `queryOptions()`
 * reutilizáveis fora de hook (diferente de `profileQueryOptions`) -- por isso
 * a queryKey/queryFn de tenant-onboarding/niche-templates é duplicada aqui,
 * IDÊNTICA à dos hooks, para que `ensureQueryData` caia no mesmo cache em vez
 * de refazer a leitura à toa quando o componente montar.
 */
/**
 * Registra em `public.system_events` (via `log_client_error`) toda vez que o
 * gate autoritativo `evaluate_capability` não conseguiu decidir e a rota caiu
 * no resolver legado por nicho.
 *
 * Fail-open é deliberado e NÃO foi alterado neste fix: `beforeLoad` é
 * defesa-em-profundidade — quem barra de verdade é a RLS. Fechar aqui faria um
 * PGRST202 (função ausente em um ambiente) redirecionar TODAS as rotas com
 * plugin para /app, um lockout do app inteiro. O que faltava era enxergar a
 * degradação, não trocá-la por indisponibilidade.
 */
function reportCapabilityGateFailure(slug: string, capability: string, error: unknown): void {
  void logClientError(error, {
    origin: "query",
    operation: `evaluate_capability:${capability}:route:${slug}`,
  });
}

export async function requirePluginActive(queryClient: QueryClient, slug: string): Promise<void> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const profile = await queryClient.ensureQueryData(profileQueryOptions(session?.user?.id ?? null));
  if (!profile) {
    throw redirect({ to: "/app" });
  }

  const capability = capabilityForLegacyPlugin(slug);
  if (capability) {
    let runtimeAllowed: boolean | null = null;
    try {
      const rpc = supabase.rpc.bind(supabase) as unknown as (
        name: string,
        args?: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string } | null }>;
      const { data, error } = await rpc("evaluate_capability", {
        p_capability_key: capability,
        p_operation: `route:${slug}`,
      });
      if (error) {
        // "RPC quebrada" != "capability negada". supabase-js NÃO lança nesse
        // caso (o `catch` abaixo é cego para ele), então o registro tem de
        // acontecer aqui — senão o fallback para o resolver legado por nicho
        // fica invisível e sem frequência medível (code review 10/08, 05 · H5).
        // O PostgrestError cru vai inteiro: logClientError extrai code/details/
        // hint e marca permission_error para 42501.
        reportCapabilityGateFailure(slug, capability, error);
      } else if (data && typeof data === "object" && "allowed" in data) {
        runtimeAllowed = (data as { allowed: boolean }).allowed;
      } else {
        // Resposta fora do contrato (sem `allowed`) é RPC quebrada também.
        reportCapabilityGateFailure(
          slug,
          capability,
          new Error(`evaluate_capability respondeu sem "allowed" (typeof=${typeof data})`),
        );
      }
    } catch (error) {
      // Falha de rede/exceção: mesmo tratamento — registra e cai no resolver
      // legado (fail-open deliberado; ver reportCapabilityGateFailure).
      reportCapabilityGateFailure(slug, capability, error);
    }
    if (runtimeAllowed === true) return;
    if (runtimeAllowed === false) throw redirect({ to: "/app" });
  }

  const tenant = await queryClient.ensureQueryData({
    queryKey: ["tenant-onboarding", profile.tenant_id] as const,
    queryFn: async (): Promise<TenantOnboardingRow | null> => {
      const { data, error } = await supabase
        .from("tenants")
        .select("id, name, logo_url, niche, onboarded_at, business_profile")
        .eq("id", profile.tenant_id)
        .maybeSingle();
      if (error) throw error;
      return (data as TenantOnboardingRow) ?? null;
    },
  });

  const templates = await queryClient.ensureQueryData({
    queryKey: ["niche-templates"] as const,
    queryFn: async (): Promise<NicheTemplate[]> => {
      const { data, error } = await supabase
        .from("niche_templates")
        .select("slug, name, description, base_prompt, stages, stage_prompts, plugins")
        .order("name");
      if (error) throw error;
      return (data ?? []) as unknown as NicheTemplate[];
    },
  });

  if (!tenant?.niche) {
    throw redirect({ to: "/app" });
  }

  const template = templates.find((t) => t.slug === tenant.niche);
  const nichePlugins = template?.plugins ?? [];
  const businessProfile = tenant.business_profile as unknown as Record<string, unknown> | null;
  const activePlugins = resolveActivePlugins(nichePlugins, businessProfile);

  if (!activePlugins.includes(slug)) {
    throw redirect({ to: "/app" });
  }
}

export function useTogglePlugin() {
  const qc = useQueryClient();
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id ?? null;

  return useMutation({
    mutationFn: async ({ slug, active }: { slug: string; active: boolean }) => {
      if (!tenantId) throw new Error("Tenant inválido");
      const { error } = await supabase.rpc("set_tenant_plugin_override", {
        p_slug: slug,
        p_active: active,
      });
      if (error) throw error;
    },
    // Mesma queryKey de useTenantOnboarding -- é essa invalidação que faz o
    // nav (useActivePlugins) atualizar sem reload forçado.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tenant-onboarding"] });
    },
  });
}
