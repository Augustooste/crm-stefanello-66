import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile } from "@/lib/api/session";
import { findWidget, type PageKey } from "@/lib/view-prefs/registry";

// Formato do jsonb: { [page]: { [widget]: boolean } }
export type ViewPrefsMap = Record<string, Record<string, boolean>>;

type ViewPrefsRow = {
  tenant_id: string;
  prefs: ViewPrefsMap;
};

function viewPrefsQueryKey(tenantId: string | null | undefined) {
  return ["tenant-view-prefs", tenantId ?? null] as const;
}

/**
 * Hook central. Sempre retorna um `isVisible(page, key)` seguro:
 *  - Enquanto carrega ou não há profile → fallback para o defaultOn do
 *    registry (a página não pisca "escondida" antes de tudo aparecer).
 *  - Se a chave nem existe no registry, retorna false (defensivo).
 *  - Se o banco tem uma chave que o código não tem mais, ignora
 *    (findWidget devolve null → cai no default de false via short-circuit).
 */
export function useViewPrefs() {
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id ?? null;

  const query = useQuery({
    queryKey: viewPrefsQueryKey(tenantId),
    enabled: !!tenantId,
    staleTime: 60_000,
    queryFn: async (): Promise<ViewPrefsMap> => {
      const { data, error } = await supabase
        .from("tenant_view_preferences")
        .select("prefs")
        .maybeSingle();
      if (error) throw error;
      const prefs = (data?.prefs as ViewPrefsMap | null) ?? {};
      return prefs;
    },
  });

  const prefs = query.data ?? {};

  function isVisible(page: PageKey, key: string): boolean {
    const widget = findWidget(page, key);
    if (!widget) return false;
    const stored = prefs[page]?.[key];
    return stored ?? widget.defaultOn;
  }

  return { ...query, prefs, isVisible };
}

/**
 * Mutação otimista para escrever um toggle. Só admin consegue -- a RLS
 * garante -- e a UI da aba já esconde os controles pra agent.
 */
export function useUpdateViewPref() {
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id ?? null;
  const userId = profile?.id ?? null;
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ page, key, value }: { page: PageKey; key: string; value: boolean }) => {
      if (!tenantId) throw new Error("Sem tenant carregado");

      // Lê o estado atual para preservar as outras chaves. Como upsert em
      // jsonb inteiro sobrescreve o campo, é preciso mesclar do lado do
      // cliente. Race entre dois admins clicando ao mesmo tempo é aceitável
      // (last-write-wins numa UI de preferência estética).
      const current = qc.getQueryData<ViewPrefsMap>(viewPrefsQueryKey(tenantId)) ?? {};
      const next: ViewPrefsMap = {
        ...current,
        [page]: { ...(current[page] ?? {}), [key]: value },
      };

      const { error } = await supabase
        .from("tenant_view_preferences")
        .upsert(
          { tenant_id: tenantId, prefs: next, updated_by: userId ?? undefined },
          { onConflict: "tenant_id" },
        );
      if (error) throw error;
      return next;
    },
    onMutate: async ({ page, key, value }) => {
      await qc.cancelQueries({ queryKey: viewPrefsQueryKey(tenantId) });
      const prev = qc.getQueryData<ViewPrefsMap>(viewPrefsQueryKey(tenantId));
      qc.setQueryData<ViewPrefsMap>(viewPrefsQueryKey(tenantId), (old) => ({
        ...(old ?? {}),
        [page]: { ...((old ?? {})[page] ?? {}), [key]: value },
      }));
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev !== undefined) {
        qc.setQueryData(viewPrefsQueryKey(tenantId), ctx.prev);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: viewPrefsQueryKey(tenantId) });
    },
  });
}

/** Reset de uma página inteira (apaga entradas do jsonb para essa página). */
export function useResetPageViewPrefs() {
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id ?? null;
  const userId = profile?.id ?? null;
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ page }: { page: PageKey }) => {
      if (!tenantId) throw new Error("Sem tenant carregado");
      const current = qc.getQueryData<ViewPrefsMap>(viewPrefsQueryKey(tenantId)) ?? {};
      const next: ViewPrefsMap = { ...current };
      delete next[page];
      const { error } = await supabase
        .from("tenant_view_preferences")
        .upsert(
          { tenant_id: tenantId, prefs: next, updated_by: userId ?? undefined },
          { onConflict: "tenant_id" },
        );
      if (error) throw error;
      return next;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: viewPrefsQueryKey(tenantId) });
    },
  });
}

/**
 * Substitui o mapa inteiro (merge no topo). Usado para aplicar presets e
 * importar preferências.
 */
export function useReplaceViewPrefs() {
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id ?? null;
  const userId = profile?.id ?? null;
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ prefs, mode }: { prefs: ViewPrefsMap; mode: "merge" | "replace" }) => {
      if (!tenantId) throw new Error("Sem tenant carregado");
      const current = qc.getQueryData<ViewPrefsMap>(viewPrefsQueryKey(tenantId)) ?? {};
      const next: ViewPrefsMap =
        mode === "replace"
          ? prefs
          : (() => {
              const merged: ViewPrefsMap = { ...current };
              for (const [page, widgets] of Object.entries(prefs)) {
                merged[page] = { ...(merged[page] ?? {}), ...widgets };
              }
              return merged;
            })();
      const { error } = await supabase
        .from("tenant_view_preferences")
        .upsert(
          { tenant_id: tenantId, prefs: next, updated_by: userId ?? undefined },
          { onConflict: "tenant_id" },
        );
      if (error) throw error;
      return next;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: viewPrefsQueryKey(tenantId) });
    },
  });
}
