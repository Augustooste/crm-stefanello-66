import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile } from "@/lib/api/session";
import { applyBrandTheme, parseBrandColors } from "@/lib/brand-theme";

/** Marca padrão do produto: só aparece quando o usuário não tem workspace. */
const PRODUCT_BRAND = "Stefanello";

export interface TenantBrand {
  /** Nome do workspace (tenant); `null` sem tenant, com erro ou ainda carregando. */
  name: string | null;
  logoUrl: string | null;
  /**
   * `true` enquanto ainda não dá para saber de quem é a marca (perfil ou nome
   * do tenant em voo). Nesse intervalo a UI mostra placeholder neutro, nunca a
   * marca padrão — senão o produto parece de outra marca a cada carregamento.
   */
  isLoading: boolean;
}

/** Chave do registro do tenant usado por topbar, marca e tema (invalidada em Configurações/onboarding). */
const TENANT_RECORD_QUERY_KEY = "topbar-tenant";

/**
 * Fonte única do registro do tenant (nome, logo e `business_profile` com as
 * cores da marca). Topbar, `useTenantBrand` e `useApplyTenantTheme` dividem a
 * mesma chave de cache, então todos precisam pedir as mesmas colunas: se um
 * deles buscasse menos, quem montasse primeiro gravaria no cache um objeto
 * sem `business_profile` por 5 min e a marca do cliente não seria aplicada.
 */
export function useTenantRecord(tenantId: string | null | undefined) {
  return useQuery({
    queryKey: [TENANT_RECORD_QUERY_KEY, tenantId],
    enabled: !!tenantId,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants")
        .select("name, logo_url, business_profile")
        .eq("id", tenantId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

/** Nome + logo do tenant para white-label (mesmo registro em cache do topbar). */
export function useTenantBrand(): TenantBrand {
  const profileQ = useCurrentProfile();
  const profile = profileQ.data;
  const [logoUrl, setLogoUrl] = useState<string | null>(null);

  const tenantQ = useTenantRecord(profile?.tenant_id);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!tenantQ.data?.logo_url) {
        setLogoUrl(null);
        return;
      }
      const { data } = await supabase.storage
        .from("logos")
        .createSignedUrl(tenantQ.data.logo_url, 3600);
      if (!cancelled) setLogoUrl(data?.signedUrl ?? null);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [tenantQ.data?.logo_url]);

  const name = tenantQ.data?.name ?? null;
  // Nome em cache (mesma queryKey) resolve na hora: `name` preenchido, sem carregando.
  const isLoading =
    name === null && (!!profileQ.isPending || (!!profile?.tenant_id && tenantQ.isPending));

  return { name, logoUrl, isLoading };
}

/**
 * Substitui "Stefanello" pelo nome do tenant no título da aba (white-label).
 * O título que a rota grava é a BASE (só o nome da página, sem marca).
 * O hook acrescenta a marca do workspace ou a marca padrão:
 * - carregando: mostra só a base
 * - com workspace: `base — <nome>`
 * - sem workspace ou erro: `base — Stefanello`
 *
 * Observa o document.title em vez de depender só da troca de rota: se a
 * HeadContent reescreve o título depois deste efeito, o MutationObserver
 * detecta e recalcula com a nova base.
 */
export function useTenantTitle() {
  const { name, isLoading } = useTenantBrand();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // A base do título (só a página, sem marca). Detectada quando document.title
  // muda em relação ao último que o hook aplicou.
  const baseRef = useRef<string | null>(null);
  // O último título que este hook aplicou.
  const appliedRef = useRef<string | null>(null);
  // Estado da marca para usar no callback (sem deps desnecessárias no closure).
  const brandRef = useRef({ name, isLoading });

  const applyRef = useRef(() => {
    const current = document.title;

    // Se o documento mudou de título, é uma nova base (a rota atualizou ou
    // HeadContent rodou depois de nós).
    if (current !== appliedRef.current) {
      baseRef.current = current;
    }

    const base = baseRef.current;
    if (!base) return;

    // Normalizar a base: remover a marca padrão se estiver presente
    // (para rotas fora de _app que ainda trazem " - Stefanello" ou " — Stefanello")
    const normalized = base.replace(/\s*[—-]\s*Stefanello\s*$/, "").trim();

    const brand = brandRef.current;
    let next = normalized;
    if (!brand.isLoading) {
      // Carregamento terminou: acrescentar a marca
      const suffix = brand.name ?? PRODUCT_BRAND;
      next = `${normalized} — ${suffix}`;
    }

    appliedRef.current = next;
    if (next !== current) document.title = next;
  });

  useEffect(() => {
    brandRef.current = { name, isLoading };
    applyRef.current();
  }, [name, isLoading, pathname]);

  useEffect(() => {
    const apply = applyRef.current;
    const observer = new MutationObserver(() => apply());
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, []);
}

/**
 * Aplica as cores white-label do tenant nas CSS vars (--primary/--accent).
 * Chamar uma vez no layout do app; remove o override quando não há brand.
 */
export function useApplyTenantTheme() {
  const { data: profile } = useCurrentProfile();

  const tenantQ = useTenantRecord(profile?.tenant_id);

  const brand = parseBrandColors(tenantQ.data?.business_profile);
  const key = brand
    ? `${brand.primary}|${brand.primary_foreground}|${brand.accent_foreground}`
    : "";

  useEffect(() => {
    if (!tenantQ.data) return;
    applyBrandTheme(brand);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, !!tenantQ.data]);
}
