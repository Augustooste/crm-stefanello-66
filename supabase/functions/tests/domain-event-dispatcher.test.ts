import { assertEquals } from "jsr:@std/assert";
import {
  FIRST_PARTY_SUBSCRIBERS,
  runDomainEventDispatcher,
} from "../domain-event-dispatcher/runner.ts";
import type { DomainEventDelivery } from "../_shared/domain-event-runner.ts";

const delivery: DomainEventDelivery = {
  delivery_id: "d1",
  event_id: "e1",
  tenant_id: "t1",
  subscriber_id: "kernel.projection",
  event_type: "contact.created",
  schema_version: 1,
  aggregate_type: "contact",
  aggregate_id: "c1",
  payload: {},
  metadata: {},
  occurred_at: new Date(0).toISOString(),
  attempts: 1,
  max_attempts: 8,
};

Deno.test("dispatcher claims only first-party subscriptions and acknowledges", async () => {
  const rpcArgs: Record<string, unknown>[] = [];
  const projected = new Set<string>();
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcArgs.push(args);
      if (name === "claim_event_deliveries") {
        return { data: [delivery], error: null };
      }
      return { data: true, error: null };
    },
    from: () => ({
      upsert: async (row: Record<string, unknown>) => {
        projected.add(`${row.event_id}:${row.subscriber_id}`);
        return { error: null };
      },
    }),
  };
  const result = await runDomainEventDispatcher(client, "worker-1");
  assertEquals(result, { claimed: 1, delivered: 1, failed: 0 });
  assertEquals(rpcArgs[0].p_subscriber_ids, FIRST_PARTY_SUBSCRIBERS);
  assertEquals(rpcArgs[0].p_event_types, null);
  assertEquals(projected.size, 1);
});

Deno.test("projection consumer is idempotent across replay", async () => {
  const projected = new Set<string>();
  let claims = 0;
  const client = {
    rpc: async (name: string) => {
      if (name === "claim_event_deliveries") {
        claims++;
        return { data: [delivery], error: null };
      }
      return { data: true, error: null };
    },
    from: () => ({
      upsert: async (row: Record<string, unknown>) => {
        projected.add(`${row.event_id}:${row.subscriber_id}`);
        return { error: null };
      },
    }),
  };
  await runDomainEventDispatcher(client, "worker-1");
  await runDomainEventDispatcher(client, "worker-2");
  assertEquals(claims, 2);
  assertEquals(projected.size, 1);
});

Deno.test("unknown subscriber fails closed and is retried", async () => {
  const calls: string[] = [];
  const client = {
    rpc: async (name: string) => {
      calls.push(name);
      if (name === "claim_event_deliveries") {
        return {
          data: [{ ...delivery, subscriber_id: "third-party" }],
          error: null,
        };
      }
      return { data: "pending", error: null };
    },
    from: () => ({ upsert: async () => ({ error: null }) }),
  };
  const result = await runDomainEventDispatcher(client, "worker-1");
  assertEquals(result.failed, 1);
  assertEquals(calls, ["claim_event_deliveries", "fail_event_delivery"]);
});
