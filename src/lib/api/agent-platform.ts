// Cliente do provedor de agentes no frontend: fala SÓ com a edge function agent-platform-proxy.
//
// O navegador nunca conhece o token do provedor nem monta URL da API remota
// (§ segurança do escopo). Tipos de entrada/saída vêm do contrato gerado — ver
// agent-platform-contract.ts.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile } from "@/lib/api/session";
import {
  type AgentPlatformAction,
  type AgentPlatformBodyRequired,
  type AgentPlatformRequestBody,
  type AgentPlatformResponse,
} from "@/lib/api/agent-platform-contract";

export const AGENT_PLATFORM_SLUG = "agent-platform";
const PROXY_FUNCTION = "agent-platform-proxy";

export type AgentPlatformErrorCode =
  | "AUTHENTICATION_FAILED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "RATE_LIMITED"
  | "INSUFFICIENT_CREDITS"
  | "REMOTE_SERVER_ERROR"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "UNSUPPORTED_BY_PUBLIC_API"
  | "UNKNOWN";

/** Fallback local: normalmente a mensagem já vem em PT-BR do proxy. Só entra em
 * cena quando a própria invocação falha (offline, function fora do ar). */
const FALLBACK_MESSAGES: Record<AgentPlatformErrorCode, string> = {
  AUTHENTICATION_FAILED: "Sua sessão expirou ou a chave do provedor de agentes é inválida.",
  FORBIDDEN: "Você não tem permissão para esta operação.",
  NOT_FOUND: "Recurso não encontrado no provedor de agentes.",
  VALIDATION_ERROR: "Revise os campos e tente novamente.",
  RATE_LIMITED: "Muitas chamadas em pouco tempo. Aguarde alguns segundos.",
  INSUFFICIENT_CREDITS: "Os créditos do workspace no provedor de agentes acabaram.",
  REMOTE_SERVER_ERROR: "O provedor de agentes está instável agora. Tente novamente.",
  TIMEOUT: "O provedor de agentes não respondeu no tempo esperado.",
  NETWORK_ERROR: "Não conseguimos falar com o servidor agora.",
  UNSUPPORTED_BY_PUBLIC_API:
    "Esta configuração não está disponível na API pública do provedor de agentes.",
  UNKNOWN: "Não foi possível concluir a operação.",
};

export class AgentPlatformCallError extends Error {
  constructor(
    readonly code: AgentPlatformErrorCode,
    message?: string,
    readonly correlationId: string | null = null,
  ) {
    super(message ?? FALLBACK_MESSAGES[code]);
    this.name = "AgentPlatformCallError";
  }
}

export type AgentPlatformParams = Record<string, string | number | boolean | null | undefined>;

/** `body` é obrigatório nas ações em que o contrato exige corpo — sem isso
 * `mutate({ params })` compilava e só quebrava em 400 no provedor. */
export type AgentPlatformCallInput<A extends AgentPlatformAction> = {
  params?: AgentPlatformParams;
} & (AgentPlatformBodyRequired<A> extends true
  ? { body: AgentPlatformRequestBody<A> }
  : { body?: AgentPlatformRequestBody<A> });

interface ProxyEnvelope {
  data?: unknown;
  /** Aviso PT-BR de sincronização parcial: a leitura remota deu certo, mas o
   * proxy não conseguiu gravar os vínculos locais. Não é erro — o dado na tela
   * é válido —, só não pode sumir, senão "Sincronizar" mente sobre ter gravado. */
  syncWarning?: string;
  error?: { code?: string; message?: string; correlationId?: string };
}

function isErrorCode(value: unknown): value is AgentPlatformErrorCode {
  return typeof value === "string" && value in FALLBACK_MESSAGES;
}

/** Traduz o status HTTP da invocação em código do domínio.
 *
 * Erro de negócio do proxy chega em 200 + envelope (ver `errorEnvelope` na
 * function); um não-2xx aqui vem de ANTES do handler — o gateway rejeita o JWT
 * expirado com 401 (`verify_jwt = true`), a plataforma responde 404/429, ou a
 * function caiu (5xx). Sem esta tradução tudo virava NETWORK_ERROR retentável e
 * o usuário ficava clicando "tentar de novo" numa sessão morta. */
function codeFromHttpStatus(status: number): AgentPlatformErrorCode {
  if (status === 401 || status === 403) return "AUTHENTICATION_FAILED";
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "REMOTE_SERVER_ERROR";
  return "UNKNOWN";
}

/**
 * Chama uma ação do proxy. Rejeita com `AgentPlatformCallError` — nunca devolve
 * envelope de erro como se fosse dado (isso mascararia falha em tela vazia).
 */
export async function callAgentPlatform<A extends AgentPlatformAction>(
  action: A,
  input: AgentPlatformCallInput<A>,
): Promise<AgentPlatformResponse<A>> {
  const { data, error, response } = await supabase.functions.invoke<ProxyEnvelope>(PROXY_FUNCTION, {
    body: { action, params: input.params ?? {}, body: input.body },
  });

  if (error) {
    // Sem `response` é falha de transporte de verdade (offline, DNS): retentável.
    // A mensagem crua do supabase-js é constante e em inglês ("Edge Function
    // returned a non-2xx status code"), então cai no fallback PT-BR por código.
    throw new AgentPlatformCallError(
      response ? codeFromHttpStatus(response.status) : "NETWORK_ERROR",
    );
  }
  if (data?.error) {
    const code = isErrorCode(data.error.code) ? data.error.code : "UNKNOWN";
    throw new AgentPlatformCallError(code, data.error.message, data.error.correlationId ?? null);
  }
  // O envelope carrega o aviso ao lado de `data`, e devolver só `data.data`
  // descartava a chave irmã: a gravação de vínculo falhava, a lista renderizava
  // normal e o usuário não via nada. Toast aqui porque o aviso não pertence a
  // nenhuma tela específica — vale para qualquer ação que dispare `syncLinks`.
  if (data?.syncWarning) toast.warning(data.syncWarning);
  return data?.data as AgentPlatformResponse<A>;
}

export const agentPlatformKeys = {
  all: ["agent-platform"] as const,
  connection: (tenantId: string | null) => ["agent-platform", "connection", tenantId] as const,
  action: (action: AgentPlatformAction, params?: AgentPlatformParams) =>
    ["agent-platform", action, params ?? {}] as const,
};

export interface AgentPlatformConnection {
  status: "disabled" | "pending" | "active" | "error";
  lastError: string | null;
  lastCheckAt: string | null;
  connectedAt: string | null;
  workspaceIdConfigured: boolean;
}

/**
 * Estado da conexão do tenant, lido de `tenant_integrations` (o token em si
 * nunca sai do servidor). É o que decide entre "conecte a integração" e as abas
 * de gerenciamento.
 */
export function useAgentPlatformConnection() {
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id ?? null;
  return useQuery({
    queryKey: agentPlatformKeys.connection(tenantId),
    enabled: !!tenantId,
    queryFn: async (): Promise<AgentPlatformConnection | null> => {
      const { data, error } = await supabase
        .from("tenant_integrations")
        .select("status, last_error, last_check_at, connected_at, config")
        .eq("tenant_id", tenantId!)
        .eq("slug", AGENT_PLATFORM_SLUG)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const config = (data.config ?? {}) as Record<string, unknown>;
      return {
        status: data.status as AgentPlatformConnection["status"],
        lastError: data.last_error ?? null,
        lastCheckAt: data.last_check_at ?? null,
        connectedAt: data.connected_at ?? null,
        workspaceIdConfigured: typeof config.workspace_id === "string" && !!config.workspace_id,
      };
    },
  });
}

export interface UseAgentPlatformQueryOptions {
  enabled?: boolean;
  staleTime?: number;
  refetchInterval?: number | false;
  retry?: number | false;
}

/**
 * Leitura de uma ação. Revalida ao montar (o dado pode ter mudado direto no
 * painel do provedor de agentes) e não repete erro de permissão/validação.
 */
export function useAgentPlatformQuery<A extends AgentPlatformAction>(
  action: A,
  input: AgentPlatformCallInput<A>,
  options: UseAgentPlatformQueryOptions = {},
) {
  return useQuery<AgentPlatformResponse<A>, AgentPlatformCallError>({
    queryKey: agentPlatformKeys.action(action, input.params),
    enabled: options.enabled ?? true,
    staleTime: options.staleTime ?? 0,
    refetchInterval: options.refetchInterval,
    refetchOnMount: "always",
    retry:
      options.retry ??
      ((count, error) => {
        const terminal: AgentPlatformErrorCode[] = [
          "AUTHENTICATION_FAILED",
          "FORBIDDEN",
          "NOT_FOUND",
          "VALIDATION_ERROR",
          "UNSUPPORTED_BY_PUBLIC_API",
          "INSUFFICIENT_CREDITS",
        ];
        return !terminal.includes(error.code) && count < 1;
      }),
    queryFn: () => callAgentPlatform(action, input),
  });
}

export interface UseAgentPlatformMutationOptions<A extends AgentPlatformAction> {
  /** Ações cujo cache é invalidado no sucesso. `"all"` limpa tudo do provedor de agentes. */
  invalidate?: readonly AgentPlatformAction[] | "all";
  onSuccess?: (data: AgentPlatformResponse<A>, variables: AgentPlatformCallInput<A>) => void;
  onError?: (error: AgentPlatformCallError, variables: AgentPlatformCallInput<A>) => void;
}

/**
 * Escrita em uma ação. Nunca faz optimistic update: operação destrutiva com
 * update otimista mostra sucesso que o provedor pode ter recusado.
 */
export function useAgentPlatformMutation<A extends AgentPlatformAction>(
  action: A,
  options: UseAgentPlatformMutationOptions<A> = {},
) {
  const queryClient = useQueryClient();
  return useMutation<AgentPlatformResponse<A>, AgentPlatformCallError, AgentPlatformCallInput<A>>({
    mutationFn: (input) => callAgentPlatform(action, input),
    onSuccess: (data, variables) => {
      const invalidate = options.invalidate ?? "all";
      if (invalidate === "all") {
        void queryClient.invalidateQueries({ queryKey: agentPlatformKeys.all });
      } else {
        for (const target of invalidate) {
          void queryClient.invalidateQueries({ queryKey: ["agent-platform", target] });
        }
      }
      options.onSuccess?.(data, variables);
    },
    onError: options.onError,
  });
}
