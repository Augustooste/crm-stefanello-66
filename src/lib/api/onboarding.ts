import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile } from "@/lib/api/session";
import type { Database, Json } from "@/integrations/supabase/types";
import { configureEnvironment } from "@/lib/onboarding/bootstrap.functions";
import { useAuth } from "@/lib/auth/AuthProvider";

export type NicheTemplate = {
  slug: string;
  name: string;
  description: string | null;
  base_prompt: string;
  stages: Array<{ name: string; position: number; is_won: boolean; is_lost: boolean }>;
  stage_prompts: Array<{
    name?: string;
    position: number;
    goal?: string;
    system_prompt?: string;
    advancement_criteria?: string[];
    handoff_keywords?: string[];
  }>;
  // Fase 6 -- default de fábrica de plugins ativados para este nicho. Nunca
  // é o estado final: cada tenant tem seu override em
  // business_profile.plugin_overrides (ver src/lib/api/plugins.ts).
  plugins: string[];
};

export function useNicheTemplates() {
  const { user, isReady } = useAuth();
  return useQuery<NicheTemplate[]>({
    queryKey: ["niche-templates"],
    // O catálogo é autenticado. No logout, o layout ainda pode permanecer
    // montado por um frame; desabilitar pela identidade impede refetch anônimo.
    enabled: isReady && user !== null,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("niche_templates")
        .select("slug, name, description, base_prompt, stages, stage_prompts, plugins")
        .order("name");
      if (error) throw error;
      return (data ?? []) as unknown as NicheTemplate[];
    },
    staleTime: 60 * 60 * 1000,
  });
}

export type TenantOnboardingRow = {
  id: string;
  name: string;
  logo_url: string | null;
  niche: string | null;
  onboarded_at: string | null;
  business_profile: Json;
};

export function useTenantOnboarding() {
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id ?? null;
  return useQuery<TenantOnboardingRow | null>({
    queryKey: ["tenant-onboarding", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants")
        .select("id, name, logo_url, niche, onboarded_at, business_profile")
        .eq("id", tenantId!)
        .maybeSingle();
      if (error) throw error;
      return (data as TenantOnboardingRow) ?? null;
    },
  });
}

// O retorno JSON das RPCs é tipado localmente sem alterar types.ts gerado.
type ScheduledJobsSyncResult = {
  created: number;
  replaced: number;
  unchanged: number;
  active: number;
  inactive: number;
  paused_all: boolean;
  vault_missing: string[];
};

export type ScheduledJobRow = {
  jobname: string;
  schedule: string;
  note: string | null;
  default_active: boolean;
  scheduled: boolean;
  active: boolean;
};

export type ScheduledJobsStatus = {
  can_manage: boolean;
  vault_missing: string[];
  jobs: ScheduledJobRow[];
  total: number;
  active: number;
};

type ScheduledJobsFunctions = {
  activate_scheduled_jobs: {
    Args: Record<string, never>;
    Returns: ScheduledJobsSyncResult;
  };
  pause_scheduled_jobs: {
    Args: Record<string, never>;
    Returns: ScheduledJobsSyncResult;
  };
  scheduled_jobs_status: {
    Args: Record<string, never>;
    Returns: ScheduledJobsStatus;
  };
};

const scheduledJobsClient = supabase as unknown as SupabaseClient<
  Database & {
    public: Database["public"] & {
      Functions: Database["public"]["Functions"] & ScheduledJobsFunctions;
    };
  }
>;

/** Estado global para admins e operadores, com autoridade vinculada à sessão. */
export function useScheduledJobsStatus(enabled = true) {
  const { user, isReady } = useAuth();
  return useQuery<ScheduledJobsStatus | null>({
    queryKey: ["scheduled-jobs-status", user?.id ?? null],
    enabled: enabled && isReady && user !== null,
    queryFn: async () => {
      const { data, error } = await scheduledJobsClient.rpc("scheduled_jobs_status");
      if (error) throw error;
      return (data as ScheduledJobsStatus) ?? null;
    },
    staleTime: 30 * 1000,
  });
}

export function useActivateScheduledJobs() {
  const qc = useQueryClient();
  return useMutation<ScheduledJobsSyncResult, Error, void>({
    mutationFn: async () => {
      const { data, error } = await scheduledJobsClient.rpc("activate_scheduled_jobs");
      if (error) throw error;
      return data as ScheduledJobsSyncResult;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["scheduled-jobs-status"] }),
  });
}

export function usePauseScheduledJobs() {
  const qc = useQueryClient();
  return useMutation<ScheduledJobsSyncResult, Error, void>({
    mutationFn: async () => {
      const { data, error } = await scheduledJobsClient.rpc("pause_scheduled_jobs");
      if (error) throw error;
      return data as ScheduledJobsSyncResult;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["scheduled-jobs-status"] }),
  });
}

export type CompleteOnboardingResult = {
  /** Segredos do Vault que ainda faltam para as rotinas agendadas rodarem. */
  vaultMissing: string[];
  /** Falso quando a ativação não pôde ser feita (sem permissão, RPC ausente). */
  scheduledJobsActivated: boolean;
};

/* ------------------------------------------------------------------ */
/* Configuração automática do ambiente (remix)                         */
/* ------------------------------------------------------------------ */

export type BootstrapItemStatus = "ok" | "atencao" | "pendente";

export type BootstrapItem = {
  key: string;
  label: string;
  status: BootstrapItemStatus;
  detail: string;
};

export type BootstrapStatus = {
  vault_missing: string[];
  items: BootstrapItem[];
  ok: boolean;
};

type BootstrapFunctions = {
  bootstrap_status: {
    Args: Record<string, never>;
    Returns: BootstrapStatus;
  };
};

const bootstrapClient = supabase as unknown as SupabaseClient<
  Database & {
    public: Database["public"] & {
      Functions: Database["public"]["Functions"] & BootstrapFunctions;
    };
  }
>;

/** Diagnóstico do ambiente (cofre interno, catálogos, eventos, rotinas). Admin apenas. */
export function useBootstrapStatus(enabled = true) {
  return useQuery<BootstrapStatus | null>({
    queryKey: ["bootstrap-status"],
    enabled,
    queryFn: async () => {
      const { data, error } = await bootstrapClient.rpc("bootstrap_status");
      if (error) throw error;
      return (data as BootstrapStatus) ?? null;
    },
    staleTime: 30 * 1000,
  });
}

/**
 * Grava o acesso interno do backend a partir do ambiente do servidor —
 * é o que faz um remix se configurar sozinho, sem ninguém digitar chave.
 */
export function useConfigureEnvironment() {
  const qc = useQueryClient();
  return useMutation<{ ok: true; written: string[] }, Error, void>({
    mutationFn: async () => {
      return (await configureEnvironment()) as { ok: true; written: string[] };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bootstrap-status"] });
      qc.invalidateQueries({ queryKey: ["scheduled-jobs-status"] });
    },
  });
}

export function useCompleteOnboarding() {
  const qc = useQueryClient();
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id ?? null;
  return useMutation<CompleteOnboardingResult, Error, void>({
    mutationFn: async () => {
      if (!tenantId) throw new Error("Tenant inválido");
      const { error } = await supabase
        .from("tenants")
        .update({ onboarded_at: new Date().toISOString() })
        .eq("id", tenantId);
      if (error) throw error;

      // Concluir o tenant não concede controle do cron global. Só o operador
      // pode ativar, e apenas quando o estado confirma credenciais presentes.
      const { data: status, error: statusError } =
        await scheduledJobsClient.rpc("scheduled_jobs_status");
      const jobsStatus = status as ScheduledJobsStatus | null;
      const vaultMissing = jobsStatus?.vault_missing ?? [];
      if (statusError || jobsStatus?.can_manage !== true || vaultMissing.length > 0) {
        return { vaultMissing, scheduledJobsActivated: false };
      }

      const { data, error: jobsError } = await scheduledJobsClient.rpc("activate_scheduled_jobs");
      if (jobsError) {
        return { vaultMissing: [], scheduledJobsActivated: false };
      }
      return {
        vaultMissing: data?.vault_missing ?? [],
        scheduledJobsActivated: true,
      };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tenant-onboarding"] });
      qc.invalidateQueries({ queryKey: ["tenant"] });
      qc.invalidateQueries({ queryKey: ["scheduled-jobs-status"] });
    },
  });
}

/** Checks whether the default board already has custom stages beyond the vanilla defaults. */
export async function fetchDefaultBoardInfo(tenantId: string) {
  const { data: board, error: bErr } = await supabase
    .from("boards")
    .select("id, name, is_default")
    .eq("tenant_id", tenantId)
    .eq("is_default", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (bErr) throw bErr;
  if (!board) return { boardId: null as string | null, stageCount: 0, dealCount: 0 };

  const [{ count: stageCount }, { count: dealCount }] = await Promise.all([
    supabase
      .from("board_stages")
      .select("id", { count: "exact", head: true })
      .eq("board_id", board.id),
    supabase.from("deals").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId),
  ]);
  return {
    boardId: board.id as string,
    stageCount: stageCount ?? 0,
    dealCount: dealCount ?? 0,
  };
}

export function useApplyNicheTemplate() {
  const qc = useQueryClient();
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id ?? null;

  return useMutation({
    mutationFn: async (template: NicheTemplate) => {
      if (!tenantId) throw new Error("Tenant inválido");

      // 1. Ensure a default board exists.
      let boardId: string | null = null;
      const { data: existingBoard, error: bErr } = await supabase
        .from("boards")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("is_default", true)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (bErr) throw bErr;
      if (existingBoard) {
        boardId = existingBoard.id;
      } else {
        const { data: newBoard, error: nbErr } = await supabase
          .from("boards")
          .insert({ tenant_id: tenantId, name: "Funil de vendas", is_default: true })
          .select("id")
          .single();
        if (nbErr) throw nbErr;
        boardId = newBoard.id;
      }

      // 2. Atomic apply via SQL function: remaps deals, swaps stages, seeds AI config.
      const stagesPayload = template.stages
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((s) => ({
          name: s.name,
          position: s.position,
          is_won: !!s.is_won,
          is_lost: !!s.is_lost,
        }));

      const stagePromptsPayload = (template.stage_prompts ?? []).map((p) => ({
        position: p.position,
        goal: p.goal ?? null,
        system_prompt: p.system_prompt ?? null,
        advancement_criteria: p.advancement_criteria ?? [],
        handoff_keywords: p.handoff_keywords ?? [],
      }));

      const { data, error } = await supabase.rpc("apply_niche_template", {
        p_board_id: boardId!,
        p_niche_slug: template.slug,
        p_base_prompt: template.base_prompt,
        p_stages: stagesPayload as unknown as Json,
        p_stage_prompts: stagePromptsPayload as unknown as Json,
      });
      if (error) {
        // Swallow technical FK/constraint messages; surface a friendly PT-BR error.
        throw new Error("Não foi possível aplicar o modelo — tente novamente.");
      }

      return { boardId, result: data };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tenant-onboarding"] });
      qc.invalidateQueries({ queryKey: ["tenant"] });
      qc.invalidateQueries({ queryKey: ["boards"] });
      qc.invalidateQueries({ queryKey: ["board-stages"] });
      qc.invalidateQueries({ queryKey: ["ai-settings"] });
      qc.invalidateQueries({ queryKey: ["stage-ai-config"] });
      qc.invalidateQueries({ queryKey: ["deals"] });
    },
  });
}
