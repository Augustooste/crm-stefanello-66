// ai-failure-logs.ts — leitura paginada de public.ai_failure_logs para a
// página de observabilidade de falhas de IA (admin). Tabela é somente
// escrita por reportAIFailure (service_role, supabase/functions/_shared/ai/
// failure-log.ts) — este módulo só lê (RLS: admin vê apenas o próprio tenant,
// ver policy ai_failure_logs_admin_select_own_tenant).

import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile } from "@/lib/api/session";
import type { AiErrorCode } from "@/lib/ai/errors";

export const AI_FAILURE_LOGS_PAGE_SIZE = 50;

export type AiFailureLogRow = {
  id: string;
  route: string;
  provider: string | null;
  model: string | null;
  status_code: number | null;
  error_code: string;
  error_message: string;
  created_at: string;
};

export type AiFailureLogsPage = {
  rows: AiFailureLogRow[];
  total: number;
};

// Mesmas frases da inbox (AI_ERROR_LABELS em src/routes/_app.inbox.tsx) —
// duplicado de propósito: é um Record pequeno e as duas telas evoluem por
// razões diferentes (badge de conversa vs. filtro de auditoria).
export const AI_ERROR_CODE_LABELS: Record<AiErrorCode, string> = {
  RATE_LIMIT: "Limite de IA atingido",
  PROVIDER_AUTH: "Erro de autenticação do provedor",
  PROVIDER_QUOTA: "Cota do provedor esgotada",
  PROVIDER_5XX: "Provedor de IA instável",
  CONTENT_BLOCKED: "Conteúdo bloqueado pelo provedor",
  TIMEOUT: "Tempo esgotado ao gerar resposta",
  SUPPRESSED: "Contato optou por não receber mensagens",
  UNKNOWN: "Falha ao gerar resposta",
};

export async function fetchAiFailureLogs(params: {
  page: number;
  errorCode: AiErrorCode | null;
}): Promise<AiFailureLogsPage> {
  const from = (params.page - 1) * AI_FAILURE_LOGS_PAGE_SIZE;
  const to = from + AI_FAILURE_LOGS_PAGE_SIZE - 1;

  let query = supabase
    .from("ai_failure_logs")
    .select("id, route, provider, model, status_code, error_code, error_message, created_at", {
      count: "exact",
    })
    .order("created_at", { ascending: false })
    .range(from, to);

  if (params.errorCode) {
    query = query.eq("error_code", params.errorCode);
  }

  const { data, count, error } = await query;
  if (error) throw error;

  return { rows: (data ?? []) as AiFailureLogRow[], total: count ?? 0 };
}

/** Habilitado apenas para admins com tenant — mesma guarda das demais telas admin. */
export function useAiFailureLogs(page: number, errorCode: AiErrorCode | null) {
  const { data: profile } = useCurrentProfile();
  const enabled = !!profile?.tenant_id && profile.role === "admin";
  return useQuery<AiFailureLogsPage>({
    queryKey: ["ai-failure-logs", page, errorCode],
    enabled,
    placeholderData: keepPreviousData,
    queryFn: () => fetchAiFailureLogs({ page, errorCode }),
  });
}

/** Janela usada pelo badge "falhas recentes" em /assistente — não é paginação, só um recorte de tempo. */
export const AI_FAILURE_RECENT_WINDOW_HOURS = 24;

async function fetchRecentAiFailureCount(): Promise<number> {
  const sinceIso = new Date(
    Date.now() - AI_FAILURE_RECENT_WINDOW_HOURS * 60 * 60 * 1000,
  ).toISOString();
  // head:true retorna só o count, sem trazer linhas (mesma técnica de
  // useHumanAttentionCount em src/lib/api/human-attention.ts).
  const { count, error } = await supabase
    .from("ai_failure_logs")
    .select("id", { count: "exact", head: true })
    .gte("created_at", sinceIso);
  if (error) throw error;
  return count ?? 0;
}

/**
 * Conta falhas de IA nas últimas AI_FAILURE_RECENT_WINDOW_HOURS horas — usado
 * pelo link/badge em /assistente que aponta para /falhas-ia. Mesma guarda de
 * admin+tenant de useAiFailureLogs (RLS só permite SELECT para admin).
 */
export function useRecentAiFailureCount(): number {
  const { data: profile } = useCurrentProfile();
  const enabled = !!profile?.tenant_id && profile.role === "admin";
  const query = useQuery<number>({
    queryKey: ["ai-failure-recent-count", profile?.tenant_id],
    enabled,
    queryFn: fetchRecentAiFailureCount,
  });
  return query.data ?? 0;
}
