export type DomainEventDelivery = {
  delivery_id: string;
  event_id: string;
  tenant_id: string | null;
  subscriber_id: string;
  event_type: string;
  schema_version: number;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  occurred_at: string;
  attempts: number;
  max_attempts: number;
};

export type EventHandler = (delivery: DomainEventDelivery) => Promise<void>;

// Supabase-js PostgrestFilterBuilder é PromiseLike (thenable), não Promise —
// PromiseLike deixa o SupabaseClient real satisfazer o seam sem cast; o runner
// só faz `await`, nunca usa métodos exclusivos de Promise (.catch/.finally).
type RpcResult = PromiseLike<{
  data: unknown;
  error: { message: string } | null;
}>;
export type RpcClient = {
  rpc: (name: string, args: Record<string, unknown>) => RpcResult;
};

export async function runDomainEventBatch(
  client: RpcClient,
  workerId: string,
  handlers: Record<string, EventHandler>,
  options: {
    limit?: number;
    leaseSeconds?: number;
    subscriberIds?: string[];
    eventTypes?: string[] | null;
  } = {},
) {
  const handlerTypes = Object.keys(handlers);
  if (!workerId.trim()) throw new Error("workerId is required");
  if (handlerTypes.length === 0) return { claimed: 0, delivered: 0, failed: 0 };

  const eventTypes = options.eventTypes !== undefined
    ? options.eventTypes
    : handlers["*"]
    ? null
    : handlerTypes;

  const claim = await client.rpc("claim_event_deliveries", {
    p_worker_id: workerId,
    p_limit: options.limit ?? 20,
    p_lease_seconds: options.leaseSeconds ?? 60,
    p_event_types: eventTypes,
    p_subscriber_ids: options.subscriberIds ?? null,
  });
  if (claim.error) {
    throw new Error(`event claim failed: ${claim.error.message}`);
  }
  const deliveries = (claim.data ?? []) as DomainEventDelivery[];

  let delivered = 0;
  let failed = 0;
  for (const item of deliveries) {
    try {
      const handler = handlers[item.event_type] ?? handlers["*"];
      if (!handler) throw new Error(`no handler for ${item.event_type}`);
      await handler(item);
      const ack = await client.rpc("ack_event_delivery", {
        p_delivery_id: item.delivery_id,
        p_worker_id: workerId,
      });
      if (ack.error || ack.data !== true) {
        throw new Error(ack.error?.message ?? "delivery lease lost");
      }
      delivered++;
    } catch (error) {
      failed++;
      const failure = await client.rpc("fail_event_delivery", {
        p_delivery_id: item.delivery_id,
        p_worker_id: workerId,
        p_error: error instanceof Error ? error.message : String(error),
      });
      if (failure.error) {
        // Não abortar o batch: se o accounting de UMA entrega falha, as demais
        // já processadas devem ser retornadas mesmo assim. Perder o accounting
        // parcial do lote inteiro é pior que perder o de uma única entrega
        // (que continua com o lease e será reprocessada no próximo ciclo).
        console.error("fail_event_delivery falhou; batch continua", {
          deliveryId: item.delivery_id,
          workerId,
          error: failure.error.message,
        });
      }
    }
  }
  return { claimed: deliveries.length, delivered, failed };
}
