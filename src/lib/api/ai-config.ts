import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { mensagemDeErroDaFunction } from "./edge-errors";
import { useCurrentProfile } from "@/lib/api/session";

const DEFAULT_HANDOFF_KEYWORDS = [
  "falar com humano",
  "atendente",
  "pessoa real",
  "agendar",
  "marcar",
];
const DEFAULT_BASE_PROMPT =
  "Você é uma assistente virtual atenciosa que atende leads de {{empresa}}. Seja cordial, objetiva e ajude o cliente com clareza.";

export interface AiSettings {
  tenant_id: string;
  base_system_prompt: string;
  handoff_default_keywords: string[];
}

export const aiResponseBehaviorSchema = z.object({
  max_response_blocks: z
    .number()
    .int()
    .min(1)
    .max(5)
    .nullish()
    .transform((v) => v ?? 1),
  response_block_delay_ms: z
    .number()
    .int()
    .min(0)
    .max(10000)
    .nullish()
    .transform((v) => v ?? 1200),
  message_coalesce_window_ms: z
    .number()
    .int()
    .min(0)
    .max(120000)
    .nullish()
    .transform((v) => v ?? 3000),
  voice_reply_mode: z
    .enum(["off", "on_audio", "always"])
    .nullish()
    .transform((v) => v ?? "off"),
  voice_id: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
});

// Teto estático de esperas: caller de 145 s menos gateway (25 s) e um envio
// com até dois POSTs (30 s), conforme execution-budget.ts. Não é garantia
// para STT/TTS ou N envios: o deadline compartilhado do runtime limita cada
// operação pelo tempo real restante, com mais 5 s reservados à finalização.
const AI_RESPONSE_TIMING_BUDGET_MS = 145_000 - (25_000 + 30_000);
export const aiResponseTimingSchema = aiResponseBehaviorSchema
  .pick({
    max_response_blocks: true,
    response_block_delay_ms: true,
    message_coalesce_window_ms: true,
  })
  .refine(
    (settings) =>
      settings.message_coalesce_window_ms +
        (settings.max_response_blocks - 1) * settings.response_block_delay_ms <=
      AI_RESPONSE_TIMING_BUDGET_MS,
    {
      message: `A janela de agrupamento mais os intervalos entre blocos deve somar no máximo ${AI_RESPONSE_TIMING_BUDGET_MS.toLocaleString("pt-BR")} ms. Reduza a janela ou os intervalos. O prazo real do turno pode reduzir a espera e interromper blocos restantes.`,
    },
  );

// Contrato local: as colunas novas não dependem de regenerar types.ts.
export type AiResponseBehavior = z.infer<typeof aiResponseBehaviorSchema>;

// Extensão local da tabela migrada; o client e o types.ts gerados são intocáveis.
type SupabaseWithAiResponseBehavior = SupabaseClient<
  Database & {
    public: Database["public"] & {
      Tables: Database["public"]["Tables"] & {
        ai_settings: {
          Row: AiResponseBehavior;
          Insert: Partial<AiResponseBehavior>;
          Update: Partial<AiResponseBehavior>;
        };
      };
    };
  }
>;
const aiResponseBehaviorClient = supabase as unknown as SupabaseWithAiResponseBehavior;

export function useAiResponseBehavior() {
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id ?? null;
  return useQuery({
    queryKey: ["ai-response-behavior", tenantId],
    enabled: !!tenantId,
    queryFn: async (): Promise<AiResponseBehavior> => {
      const { data, error } = await aiResponseBehaviorClient
        .from("ai_settings")
        .select(
          "max_response_blocks, response_block_delay_ms, message_coalesce_window_ms, voice_reply_mode, voice_id",
        )
        .eq("tenant_id", tenantId!)
        .maybeSingle();
      if (error) throw error;
      return aiResponseBehaviorSchema.parse(data ?? {});
    },
  });
}

export function useUpdateAiResponseBehavior() {
  const qc = useQueryClient();
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id ?? null;
  return useMutation({
    mutationFn: async (patch: Partial<AiResponseBehavior>) => {
      if (!tenantId) throw new Error("Sem tenant.");
      const parsed = aiResponseBehaviorSchema.partial().safeParse(patch);
      if (!parsed.success) throw new Error("Revise as faixas do comportamento das respostas.");
      const cached = qc.getQueryData<AiResponseBehavior>(["ai-response-behavior", tenantId]);
      const timing = aiResponseTimingSchema.safeParse({ ...cached, ...parsed.data });
      if (!timing.success) throw new Error(timing.error.issues[0].message);
      const { error } = await aiResponseBehaviorClient
        .from("ai_settings")
        .upsert({ tenant_id: tenantId, ...parsed.data }, { onConflict: "tenant_id" });
      if (error) throw error;
    },
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["ai-response-behavior", tenantId] }),
        qc.invalidateQueries({ queryKey: ["ai-voice-reply", tenantId] }),
      ]);
    },
  });
}

export interface StageWithConfig {
  stage_id: string;
  stage_name: string;
  position: number;
  is_won: boolean;
  is_lost: boolean;
  enabled: boolean;
  stage_goal: string;
  system_prompt: string;
  advancement_criteria: string[];
  handoff_keywords: string[];
}

export function useTenantAiEnabled() {
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id ?? null;
  return useQuery({
    queryKey: ["tenant-ai-enabled", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants")
        .select("ai_enabled")
        .eq("id", tenantId!)
        .maybeSingle();
      if (error) throw error;
      return (data?.ai_enabled ?? false) as boolean;
    },
  });
}

export function useSetTenantAiEnabled() {
  const qc = useQueryClient();
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id ?? null;
  return useMutation({
    mutationFn: async (enabled: boolean) => {
      if (!tenantId) throw new Error("Sem tenant.");
      const { error } = await supabase
        .from("tenants")
        .update({ ai_enabled: enabled })
        .eq("id", tenantId);
      if (error) throw error;
      return enabled;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tenant-ai-enabled", tenantId] }),
  });
}

export function useAiSettings() {
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id ?? null;
  return useQuery<AiSettings>({
    queryKey: ["ai-settings", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ai_settings")
        .select("tenant_id, base_system_prompt, handoff_default_keywords")
        .eq("tenant_id", tenantId!)
        .maybeSingle();
      if (error) throw error;
      if (data) {
        return {
          tenant_id: data.tenant_id as string,
          base_system_prompt: (data.base_system_prompt as string | null) ?? DEFAULT_BASE_PROMPT,
          handoff_default_keywords:
            (data.handoff_default_keywords as string[] | null) ?? DEFAULT_HANDOFF_KEYWORDS,
        };
      }
      // Create default row on-demand.
      const insertPayload = {
        tenant_id: tenantId!,
        base_system_prompt: DEFAULT_BASE_PROMPT,
        handoff_default_keywords: DEFAULT_HANDOFF_KEYWORDS,
      };
      const { data: created, error: insErr } = await supabase
        .from("ai_settings")
        .insert(insertPayload)
        .select("tenant_id, base_system_prompt, handoff_default_keywords")
        .single();
      if (insErr?.code === "23505") {
        const { data: concurrent, error: concurrentError } = await supabase
          .from("ai_settings")
          .select("tenant_id, base_system_prompt, handoff_default_keywords")
          .eq("tenant_id", tenantId!)
          .single();
        if (concurrentError) throw concurrentError;
        return {
          tenant_id: concurrent.tenant_id,
          base_system_prompt: concurrent.base_system_prompt ?? DEFAULT_BASE_PROMPT,
          handoff_default_keywords: concurrent.handoff_default_keywords ?? DEFAULT_HANDOFF_KEYWORDS,
        };
      }
      if (insErr || !created) throw insErr ?? new Error("Configuração de IA não foi criada");
      return {
        tenant_id: created.tenant_id,
        base_system_prompt: created.base_system_prompt ?? DEFAULT_BASE_PROMPT,
        handoff_default_keywords: created.handoff_default_keywords ?? DEFAULT_HANDOFF_KEYWORDS,
      };
    },
  });
}

export function useUpdateAiSettings() {
  const qc = useQueryClient();
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id ?? null;
  return useMutation({
    mutationFn: async (
      patch: Partial<Pick<AiSettings, "base_system_prompt" | "handoff_default_keywords">>,
    ) => {
      if (!tenantId) throw new Error("Sem tenant.");
      const { error } = await supabase
        .from("ai_settings")
        .upsert({ tenant_id: tenantId, ...patch }, { onConflict: "tenant_id" });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ai-settings", tenantId] }),
  });
}

export function useStagesWithConfig() {
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id ?? null;
  return useQuery<StageWithConfig[]>({
    queryKey: ["stages-with-ai-config", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data: board, error: bErr } = await supabase
        .from("boards")
        .select("id")
        .eq("is_default", true)
        .maybeSingle();
      if (bErr) throw bErr;
      if (!board) return [];
      const { data: stages, error: sErr } = await supabase
        .from("board_stages")
        .select("id, name, position, is_won, is_lost")
        .eq("board_id", board.id)
        .order("position");
      if (sErr) throw sErr;
      const stageIds = (stages ?? []).map((s) => s.id);
      const { data: cfgs, error: cErr } = await supabase
        .from("stage_ai_config")
        .select(
          "stage_id, enabled, stage_goal, system_prompt, advancement_criteria, handoff_keywords",
        )
        .in("stage_id", stageIds.length ? stageIds : ["00000000-0000-0000-0000-000000000000"]);
      if (cErr) throw cErr;
      const byStage = new Map<string, Record<string, unknown>>();
      for (const c of cfgs ?? []) byStage.set(c.stage_id as string, c as Record<string, unknown>);
      return (stages ?? []).map((s) => {
        const c = byStage.get(s.id) ?? {};
        const rawAdv = (c.advancement_criteria as unknown) ?? [];
        let adv: string[] = [];
        if (Array.isArray(rawAdv)) {
          adv = rawAdv
            .map((x) =>
              typeof x === "string"
                ? x
                : String(
                    (x as { criterion?: string; text?: string; description?: string })?.criterion ??
                      (x as { text?: string })?.text ??
                      (x as { description?: string })?.description ??
                      "",
                  ),
            )
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        }
        return {
          stage_id: s.id as string,
          stage_name: s.name as string,
          position: s.position as number,
          is_won: !!s.is_won,
          is_lost: !!s.is_lost,
          enabled: (c.enabled as boolean | undefined) ?? false,
          stage_goal: (c.stage_goal as string | null) ?? "",
          system_prompt: (c.system_prompt as string | null) ?? "",
          advancement_criteria: adv,
          handoff_keywords: (c.handoff_keywords as string[] | null) ?? [],
        };
      });
    },
  });
}

export function useUpsertStageConfig() {
  const qc = useQueryClient();
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id ?? null;
  return useMutation({
    mutationFn: async (input: {
      stage_id: string;
      enabled: boolean;
      stage_goal: string;
      system_prompt: string;
      advancement_criteria: string[];
      handoff_keywords: string[];
    }) => {
      if (!tenantId) throw new Error("Sem tenant.");
      const { error } = await supabase.from("stage_ai_config").upsert(
        {
          tenant_id: tenantId,
          stage_id: input.stage_id,
          enabled: input.enabled,
          stage_goal: input.stage_goal,
          system_prompt: input.system_prompt,
          advancement_criteria: input.advancement_criteria,
          handoff_keywords: input.handoff_keywords,
        },
        { onConflict: "tenant_id,stage_id" },
      );
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["stages-with-ai-config", tenantId] }),
  });
}

/**
 * Copiloto interno (`ai-copilot`) — o assistente do painel lateral.
 * Diferente do `playgroundChat`: aquele simula o agente de atendimento ao lead,
 * este responde ao operador com dado real do CRM.
 */
export async function copilotChat(input: {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<{ reply: string }> {
  // Em resposta não-2xx o supabase-js descarta o corpo e lança
  // `FunctionsHttpError` com uma string fixa em inglês — o `{error: "..."}` que
  // a function mandou nunca chega aqui. Por isso o mapeamento sai do `status`,
  // não do payload; mesmo padrão já usado em `agent-platform.ts`.
  const { data, error, response } = await supabase.functions.invoke("ai-copilot", { body: input });
  if (error) {
    throw new Error(mensagemDeErroDaFunction(response?.status));
  }
  const payload = data as { reply?: string; error?: string };
  // Só alcançável se a function responder 200 com erro no corpo. Hoje ela não
  // faz isso, mas é barato manter a rede.
  if (payload?.error) throw new Error(payload.error);
  if (!payload?.reply) throw new Error("A IA não retornou resposta.");
  return { reply: payload.reply };
}

export async function playgroundChat(input: {
  stage_id: string | null;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<{ reply: string }> {
  const { data, error, response } = await supabase.functions.invoke("ai-playground", {
    body: input,
  });
  if (error) throw new Error(mensagemDeErroDaFunction(response?.status));
  const payload = data as { reply?: string; error?: string };
  if (payload?.error) throw new Error(payload.error);
  if (!payload?.reply) throw new Error("A IA não retornou resposta.");
  return { reply: payload.reply };
}

/** Preview conversacional da IA com o contexto real de um negócio (ai-deal-chat).
 * Single-shot: cada chamada é independente, sem histórico enviado à IA — a
 * lista de mensagens no dialog é só apresentação (ver supabase/functions/ai-deal-chat/index.ts). */
export async function dealChat(input: {
  deal_id: string;
  message: string;
}): Promise<{ reply: string }> {
  const { data, error } = await supabase.functions.invoke("ai-deal-chat", { body: input });
  if (error) {
    const msg = (error as { message?: string }).message || "Não foi possível gerar a resposta.";
    throw new Error(msg);
  }
  const payload = data as { reply?: string; error?: string };
  if (payload?.error) throw new Error(payload.error);
  if (!payload?.reply) throw new Error("A IA não retornou resposta.");
  return { reply: payload.reply };
}
