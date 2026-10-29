import {
  type DomainEventDelivery,
  type RpcClient,
  runDomainEventBatch,
} from "../_shared/domain-event-runner.ts";
import {
  type FanOutClient,
  fanOutToEndpoints,
} from "../_shared/webhooks/fan-out.ts";

type ProjectionClient = RpcClient & {
  from: (table: string) => {
    upsert: (
      row: Record<string, unknown>,
      options: { onConflict: string; ignoreDuplicates: boolean },
    ) => PromiseLike<{ error: { message: string } | null }>;
  };
};

export const WEBHOOK_SUBSCRIBER = "webhook.outbound";

export const FIRST_PARTY_SUBSCRIBERS = [
  "kernel.projection",
  "kernel.observability",
  "billing.audit",
  WEBHOOK_SUBSCRIBER,
];

export function createProjectionHandler(
  client: ProjectionClient,
  fanOutClient?: FanOutClient,
) {
  return async (delivery: DomainEventDelivery) => {
    if (!FIRST_PARTY_SUBSCRIBERS.includes(delivery.subscriber_id)) {
      throw new Error(`unsupported subscriber ${delivery.subscriber_id}`);
    }
    if (delivery.subscriber_id === WEBHOOK_SUBSCRIBER) {
      if (!fanOutClient) throw new Error("webhook fan-out client missing");
      await fanOutToEndpoints(fanOutClient, delivery);
      return;
    }
    const { error } = await client.from("domain_event_projections").upsert(
      {
        event_id: delivery.event_id,
        tenant_id: delivery.tenant_id,
        subscriber_id: delivery.subscriber_id,
        event_type: delivery.event_type,
        aggregate_type: delivery.aggregate_type,
        aggregate_id: delivery.aggregate_id,
        schema_version: delivery.schema_version,
      },
      { onConflict: "event_id,subscriber_id", ignoreDuplicates: true },
    );
    if (error) throw new Error(`projection failed: ${error.message}`);
  };
}

export async function runDomainEventDispatcher(
  client: ProjectionClient,
  workerId: string,
  limit = 50,
  fanOutClient?: FanOutClient,
) {
  return runDomainEventBatch(client, workerId, {
    "*": createProjectionHandler(client, fanOutClient),
  }, {
    limit,
    leaseSeconds: 120,
    subscriberIds: FIRST_PARTY_SUBSCRIBERS,
  });
}
