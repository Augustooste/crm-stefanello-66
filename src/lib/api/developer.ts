import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile } from "@/lib/api/session";
import { usePermissions } from "@/lib/api/workspaces";

/**
 * Camada de dados de chaves de API e webhooks (Tasks 2, 6 e 9).
 *
 * `types.ts` (gerado) ainda não conhece as RPCs/tabelas novas e não pode ser
 * editado. Todo acesso passa por `db`, UM único cast controlado para uma
 * interface estreita; nada de `any`. Quando `types.ts` for regenerado, basta
 * trocar `db` por `supabase`.
 */
type DbError = { message: string; code?: string } | null;
type DbResult = { data: unknown; error: DbError; count?: number | null };
interface DbQuery extends PromiseLike<DbResult> {
  select(columns: string, options?: { count: "exact"; head: boolean }): DbQuery;
  eq(column: string, value: string): DbQuery;
  order(column: string, options?: { ascending: boolean }): DbQuery;
  range(from: number, to: number): DbQuery;
  maybeSingle(): PromiseLike<DbResult>;
}
interface DevDb {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<DbResult>;
  from(table: string): DbQuery;
}
const db = supabase as unknown as DevDb;

const DEFAULT_ERROR_MESSAGE = "Não foi possível concluir a operação. Tente novamente.";
const ERROR_MESSAGES: ReadonlyMap<string, string> = new Map([
  ["42501", "Sem permissão para esta ação."],
  ["22023", "Dados inválidos. Confira os campos, o tipo de evento ou o escopo informado."],
  ["54000", "Limite atingido: até 20 webhooks por workspace e até 10 envios de teste por minuto."],
  ["P0002", "Item não encontrado."],
  ["23514", "Dados inválidos."],
]);

const FILTER_ERROR_MESSAGE = "Funil ou etapa inválido para este workspace.";

function friendlyMessage(code: string | null | undefined, originalMessage?: string): string {
  // Única comparação por texto: 22023 serve a vários erros e só 'filtro invalido'
  // (private.assert_webhook_filters, migration 20261020160000) ganha mensagem própria.
  if (code === "22023" && originalMessage === "filtro invalido") return FILTER_ERROR_MESSAGE;
  return (code ? ERROR_MESSAGES.get(code) : undefined) ?? DEFAULT_ERROR_MESSAGE;
}

/**
 * Erro das RPCs/consultas de desenvolvedor. `message` é sempre em português e
 * nunca carrega texto cru do Postgres (pode conter detalhes ou segredo); o
 * original fica só em `cause`, que a interface não deve exibir. A UI distingue
 * casos por `code` (SQLSTATE), sem comparar texto.
 */
export class DeveloperApiError extends Error {
  readonly code: string | null;
  constructor(code: string | null | undefined, originalMessage?: string) {
    super(friendlyMessage(code, originalMessage), {
      cause: originalMessage === undefined ? undefined : new Error(originalMessage),
    });
    this.name = "DeveloperApiError";
    this.code = code ?? null;
  }
}

async function callRpc(fn: string, args?: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new DeveloperApiError(error.code, error.message);
  return data;
}

async function runQuery(query: DbQuery): Promise<unknown[]> {
  const { data, error } = await query;
  if (error) throw new DeveloperApiError(error.code, error.message);
  return (data ?? []) as unknown[];
}

/** RPC `returns table` vem como array de uma linha; `returns scalar` vem direto. */
function firstRow<T>(data: unknown, label: string): T {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new DeveloperApiError(null, `Resposta vazia de ${label}`);
  return row as T;
}

// --- colunas explícitas: nunca select *, key_hash, vault_secret_id ou locked_by ---
const ENDPOINT_COLUMNS =
  "id, url, description, event_types, board_ids, stage_ids, active, disabled_reason, previous_secret_expires_at, created_at, updated_at";
const DELIVERY_COLUMNS =
  "id, endpoint_id, event_id, event_type, status, attempts, max_attempts, available_at, response_status, response_excerpt, last_error, delivered_at, created_at";
const API_KEY_COLUMNS =
  "id, name, key_prefix, scopes, expires_at, revoked_at, last_used_at, created_by, created_at";

export type WebhookEndpoint = {
  id: string;
  url: string;
  description: string | null;
  event_types: string[];
  /** Vazio = todos os funis. */
  board_ids: string[];
  /** Vazio = todas as etapas (etapa de destino do negócio). */
  stage_ids: string[];
  active: boolean;
  /** 'filter_target_deleted' = funil ou etapa do filtro foi apagado. */
  disabled_reason: string | null;
  previous_secret_expires_at: string | null;
  created_at: string;
  updated_at: string;
};
export type WebhookDeliveryStatus = "pending" | "processing" | "delivered" | "dead_letter";
export type WebhookDelivery = {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  max_attempts: number;
  available_at: string;
  response_status: number | null;
  response_excerpt: string | null;
  last_error: string | null;
  delivered_at: string | null;
  created_at: string;
};
export type WebhookDeliveryFilters = {
  status?: WebhookDeliveryStatus;
  eventType?: string;
  /** Teto de 200; padrão 50. */
  limit?: number;
  /** Paginação por deslocamento (linhas puladas). */
  offset?: number;
};
export type ApiKey = {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_by: string | null;
  created_at: string;
};

const DEFAULT_DELIVERIES_LIMIT = 50;
const MAX_DELIVERIES_LIMIT = 200;
const DELIVERY_STATUSES = ["delivered", "pending", "processing", "dead_letter"] as const;
export type WebhookDeliveryStats = Record<(typeof DELIVERY_STATUSES)[number], number>;

const keys = {
  endpoints: (tenantId: string | undefined) => ["webhook-endpoints", tenantId] as const,
  endpoint: (tenantId: string | undefined, id: string) =>
    ["webhook-endpoints", tenantId, id] as const,
  // prefixo comum: invalidar deliveriesAll também renova as contagens
  deliveryStats: (endpointId: string) => ["webhook-deliveries", "stats", endpointId] as const,
  deliveriesAll: ["webhook-deliveries"] as const,
  deliveries: (endpointId: string, filters: WebhookDeliveryFilters) =>
    ["webhook-deliveries", endpointId, filters] as const,
  apiKeys: (tenantId: string | undefined) => ["api-keys", tenantId] as const,
};

/**
 * Mutations que devolvem segredo/token usam `gcTime: 0`: o resultado sai do
 * MutationCache assim que o consumidor desmonta, e nunca entra no cache de
 * queries (as listagens só leem colunas não sensíveis).
 */
const NO_RETAIN = { gcTime: 0 } as const;

// --- webhooks ---

export function useWebhookEndpoints() {
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id;
  return useQuery<WebhookEndpoint[]>({
    queryKey: keys.endpoints(tenantId),
    enabled: !!tenantId,
    queryFn: async () =>
      (await runQuery(
        db
          .from("webhook_endpoints")
          .select(ENDPOINT_COLUMNS)
          .order("created_at", { ascending: false }),
      )) as WebhookEndpoint[],
  });
}

/** Detalhe de um endpoint; `null` quando não existe (ou RLS oculta). */
export function useWebhookEndpoint(id: string) {
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id;
  return useQuery<WebhookEndpoint | null>({
    queryKey: keys.endpoint(tenantId, id),
    enabled: !!tenantId && !!id,
    queryFn: async () => {
      const { data, error } = await db
        .from("webhook_endpoints")
        .select(ENDPOINT_COLUMNS)
        .eq("id", id)
        .maybeSingle();
      if (error) throw new DeveloperApiError(error.code, error.message);
      return (data ?? null) as WebhookEndpoint | null;
    },
  });
}

/** Contagem de entregas por status, sem trazer linhas (head + count exact, uma consulta por status). */
export function useWebhookDeliveryStats(endpointId: string) {
  const { data: profile } = useCurrentProfile();
  return useQuery<WebhookDeliveryStats>({
    queryKey: keys.deliveryStats(endpointId),
    enabled: !!profile?.tenant_id && !!endpointId,
    queryFn: async () => {
      const entries = await Promise.all(
        DELIVERY_STATUSES.map(async (status) => {
          const { count, error } = await db
            .from("webhook_deliveries")
            .select("id", { count: "exact", head: true })
            .eq("endpoint_id", endpointId)
            .eq("status", status);
          if (error) throw new DeveloperApiError(error.code, error.message);
          return [status, count ?? 0] as const;
        }),
      );
      return Object.fromEntries(entries) as WebhookDeliveryStats;
    },
  });
}

export function useCreateWebhookEndpoint() {
  const queryClient = useQueryClient();
  const { data: profile } = useCurrentProfile();
  return useMutation({
    ...NO_RETAIN,
    mutationFn: async (input: {
      url: string;
      eventTypes: string[];
      description?: string | null;
      boardIds?: string[];
      stageIds?: string[];
    }): Promise<{ id: string; secret: string }> => {
      // Sempre os 5 argumentos: casa com a sobrecarga que grava os filtros na mesma instrução.
      const data = await callRpc("create_webhook_endpoint", {
        p_url: input.url,
        p_event_types: input.eventTypes,
        p_description: input.description ?? null,
        p_board_ids: input.boardIds ?? [],
        p_stage_ids: input.stageIds ?? [],
      });
      const row = firstRow<{ id: string; secret: string }>(data, "create_webhook_endpoint");
      return { id: row.id, secret: row.secret };
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.endpoints(profile?.tenant_id) });
    },
  });
}

export type WebhookEndpointUpdate = {
  id: string;
  url: string;
  eventTypes: string[];
  description: string | null;
  boardIds: string[];
  stageIds: string[];
};

/** Edita url, eventos, descrição e filtros; corrigir o filtro reativa endpoint desativado por filter_target_deleted. */
export function useUpdateWebhookEndpoint() {
  const queryClient = useQueryClient();
  const { data: profile } = useCurrentProfile();
  return useMutation<void, DeveloperApiError, WebhookEndpointUpdate>({
    mutationFn: async (input) => {
      await callRpc("update_webhook_endpoint", {
        p_id: input.id,
        p_url: input.url,
        p_event_types: input.eventTypes,
        p_description: input.description,
        p_board_ids: input.boardIds,
        p_stage_ids: input.stageIds,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.endpoints(profile?.tenant_id) });
    },
  });
}

export function useRotateWebhookSecret() {
  const queryClient = useQueryClient();
  const { data: profile } = useCurrentProfile();
  return useMutation({
    ...NO_RETAIN,
    mutationFn: async (endpointId: string): Promise<string> => {
      const data = await callRpc("rotate_webhook_endpoint_secret", { p_id: endpointId });
      if (typeof data !== "string" || !data) {
        throw new DeveloperApiError(null, "Resposta vazia de rotate_webhook_endpoint_secret");
      }
      return data;
    },
    // previous_secret_expires_at muda na listagem
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.endpoints(profile?.tenant_id) });
    },
  });
}

export function useSetWebhookActive() {
  const queryClient = useQueryClient();
  const { data: profile } = useCurrentProfile();
  return useMutation({
    mutationFn: async (input: { id: string; active: boolean }): Promise<void> => {
      await callRpc("set_webhook_endpoint_active", { p_id: input.id, p_active: input.active });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.endpoints(profile?.tenant_id) });
    },
  });
}

export function useDeleteWebhookEndpoint() {
  const queryClient = useQueryClient();
  const { data: profile } = useCurrentProfile();
  return useMutation({
    mutationFn: async (endpointId: string): Promise<void> => {
      await callRpc("delete_webhook_endpoint", { p_id: endpointId });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.endpoints(profile?.tenant_id) }),
        queryClient.invalidateQueries({ queryKey: keys.deliveriesAll }),
      ]);
    },
  });
}

export function useWebhookDeliveries(endpointId: string, filters: WebhookDeliveryFilters = {}) {
  const { data: profile } = useCurrentProfile();
  return useQuery<WebhookDelivery[]>({
    queryKey: keys.deliveries(endpointId, filters),
    enabled: !!profile?.tenant_id && !!endpointId,
    queryFn: async () => {
      const limit = Math.min(filters.limit ?? DEFAULT_DELIVERIES_LIMIT, MAX_DELIVERIES_LIMIT);
      const offset = Math.max(filters.offset ?? 0, 0);
      // created_at + id: ordem estável entre páginas mesmo com timestamps iguais
      let query = db
        .from("webhook_deliveries")
        .select(DELIVERY_COLUMNS)
        .eq("endpoint_id", endpointId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(offset, offset + limit - 1);
      if (filters.status) query = query.eq("status", filters.status);
      if (filters.eventType) query = query.eq("event_type", filters.eventType);
      return (await runQuery(query)) as WebhookDelivery[];
    },
  });
}

export function useRedeliver() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (deliveryId: string): Promise<void> => {
      await callRpc("redeliver_webhook", { p_delivery_id: deliveryId });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.deliveriesAll });
    },
  });
}

/** Devolve o id da entrega de teste criada. */
export function useSendTestWebhook() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (endpointId: string): Promise<string> => {
      const data = await callRpc("send_test_webhook", { p_id: endpointId });
      if (typeof data !== "string" || !data) {
        throw new DeveloperApiError(null, "Resposta inesperada de send_test_webhook");
      }
      return data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.deliveriesAll });
    },
  });
}

export function useAllowedWebhookEventTypes() {
  return useQuery<string[]>({
    queryKey: ["webhook-allowed-event-types"],
    staleTime: Infinity,
    queryFn: async () => ((await callRpc("webhook_allowed_event_types")) ?? []) as string[],
  });
}

// --- chaves de API ---

export function useApiKeys() {
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id;
  return useQuery<ApiKey[]>({
    queryKey: keys.apiKeys(tenantId),
    enabled: !!tenantId,
    queryFn: async () =>
      (await runQuery(
        db.from("api_keys").select(API_KEY_COLUMNS).order("created_at", { ascending: false }),
      )) as ApiKey[],
  });
}

export function useCreateApiKey() {
  const queryClient = useQueryClient();
  const { data: profile } = useCurrentProfile();
  return useMutation({
    ...NO_RETAIN,
    mutationFn: async (input: {
      name: string;
      scopes: string[];
      expiresAt?: string | null;
    }): Promise<{ id: string; token: string }> => {
      const data = await callRpc("create_api_key", {
        p_name: input.name,
        p_scopes: input.scopes,
        p_expires_at: input.expiresAt ?? null,
      });
      const row = firstRow<{ id: string; token: string }>(data, "create_api_key");
      return { id: row.id, token: row.token };
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.apiKeys(profile?.tenant_id) });
    },
  });
}

export function useRevokeApiKey() {
  const queryClient = useQueryClient();
  const { data: profile } = useCurrentProfile();
  return useMutation({
    mutationFn: async (keyId: string): Promise<void> => {
      await callRpc("revoke_api_key", { p_id: keyId });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.apiKeys(profile?.tenant_id) });
    },
  });
}

/** `api_allowed_scopes()` é executável por `authenticated` (Task 6), então vem do banco. */
export function useAllowedApiScopes() {
  return useQuery<string[]>({
    queryKey: ["api-allowed-scopes"],
    staleTime: Infinity,
    queryFn: async () => ((await callRpc("api_allowed_scopes")) ?? []) as string[],
  });
}

/** Permissão `developer.manage` (Task 9), não `is_admin`. */
export function useCanManageDeveloper(): { allowed: boolean; isLoading: boolean } {
  // isPending (não isLoading): a query de permissões fica desabilitada até a
  // sessão estar pronta, e nesse intervalo isLoading seria false e a UI
  // piscaria "acesso negado".
  const { data, isPending } = usePermissions();
  return { allowed: data?.includes("developer.manage") ?? false, isLoading: isPending };
}
