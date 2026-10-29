import type { DomainEventDelivery } from "../domain-event-runner.ts";

type QueryResult = { data: unknown; error: { message: string } | null };

// Seam mínimo do supabase-js: PromiseLike (thenable), como no runner.
type EndpointQuery = PromiseLike<QueryResult> & {
  eq: (column: string, value: unknown) => EndpointQuery;
};

export type FanOutClient = {
  from: (table: string) => {
    select: (columns: string) => EndpointQuery;
    upsert: (
      rows: Record<string, unknown>[],
      options: { onConflict: string; ignoreDuplicates: boolean },
    ) => { select: (columns: string) => PromiseLike<QueryResult> };
  };
};

type EndpointFilter = {
  event_types: string[];
  board_ids: string[];
  stage_ids: string[];
};
type EndpointRow = EndpointFilter & { id: string };

const asId = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

/**
 * Funil e etapa de DESTINO de um evento de negócio; null se o evento não é deal.*.
 * deal.won/lost: payload.deal.{board_id,stage_id}. deal.stage_changed:
 * payload.board_id (desde 20261020160000) e payload.to_stage_id.
 */
export function dealScope(
  eventType: string,
  payload: Record<string, unknown>,
): { boardId: string | null; stageId: string | null } | null {
  if (eventType === "deal.won" || eventType === "deal.lost") {
    const deal = asRecord(payload.deal);
    return { boardId: asId(deal.board_id), stageId: asId(deal.stage_id) };
  }
  if (eventType === "deal.stage_changed") {
    return {
      boardId: asId(payload.board_id),
      stageId: asId(payload.to_stage_id),
    };
  }
  return null;
}

/**
 * Filtro do endpoint: vazio = todos. Falha fechada: funil/etapa ausente ou fora do
 * formato no payload, ou linha sem os arrays, não casa com evento de negócio.
 */
export function endpointMatches(
  endpoint: EndpointFilter,
  eventType: string,
  payload: Record<string, unknown>,
): boolean {
  if (!endpoint.event_types.includes(eventType)) return false;
  const scope = dealScope(eventType, payload);
  if (scope === null) return true;
  const { board_ids: boards, stage_ids: stages } = endpoint;
  if (!Array.isArray(boards) || !Array.isArray(stages)) return false;
  if (boards.length > 0 && !(scope.boardId && boards.includes(scope.boardId))) {
    return false;
  }
  if (stages.length > 0 && !(scope.stageId && stages.includes(scope.stageId))) {
    return false;
  }
  return true;
}

/**
 * Cria 1 webhook_deliveries por endpoint ativo do tenant do evento que assina o tipo
 * e cujo filtro de funil/etapa casa (endpointMatches).
 * Idempotente por (endpoint_id, event_id): ON CONFLICT DO NOTHING, e só as linhas
 * realmente inseridas voltam no select, então reprocessar devolve created: 0.
 */
export async function fanOutToEndpoints(
  client: FanOutClient,
  delivery: DomainEventDelivery,
): Promise<{ created: number }> {
  if (!delivery.tenant_id) return { created: 0 };

  const endpoints = await client
    .from("webhook_endpoints")
    .select("id, event_types, board_ids, stage_ids")
    .eq("tenant_id", delivery.tenant_id)
    .eq("active", true);
  if (endpoints.error) {
    throw new Error(
      `webhook endpoints lookup failed: ${endpoints.error.message}`,
    );
  }
  const targets = ((endpoints.data ?? []) as EndpointRow[]).filter((e) =>
    endpointMatches(e, delivery.event_type, delivery.payload)
  );
  if (targets.length === 0) return { created: 0 };

  const inserted = await client
    .from("webhook_deliveries")
    .upsert(
      targets.map((e) => ({
        tenant_id: delivery.tenant_id,
        endpoint_id: e.id,
        event_id: delivery.event_id,
        event_type: delivery.event_type,
      })),
      { onConflict: "endpoint_id,event_id", ignoreDuplicates: true },
    )
    .select("id");
  if (inserted.error) {
    throw new Error(`webhook fan-out failed: ${inserted.error.message}`);
  }
  return { created: ((inserted.data ?? []) as unknown[]).length };
}
