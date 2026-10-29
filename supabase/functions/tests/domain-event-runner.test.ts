import { assertEquals, assertRejects } from "jsr:@std/assert";
import { type DomainEventDelivery, runDomainEventBatch } from "../_shared/domain-event-runner.ts";

const delivery = (type = "message.received"): DomainEventDelivery => ({
  delivery_id: "delivery-1",
  event_id: "event-1",
  tenant_id: "tenant-1",
  subscriber_id: "test",
  event_type: type,
  schema_version: 1,
  aggregate_type: "message",
  aggregate_id: "message-1",
  payload: {},
  metadata: {},
  occurred_at: new Date(0).toISOString(),
  attempts: 1,
  max_attempts: 3,
});

Deno.test("runner claims, handles and acknowledges a delivery", async () => {
  const calls: string[] = [];
  const client = {
    rpc: async (name: string) => {
      calls.push(name);
      if (name === "claim_event_deliveries") {
        return {
          data: [delivery()],
          error: null,
        };
      }
      return { data: true, error: null };
    },
  };
  const result = await runDomainEventBatch(client, "worker-1", {
    "message.received": async () => {
      calls.push("handler");
    },
  });
  assertEquals(result, { claimed: 1, delivered: 1, failed: 0 });
  assertEquals(calls, [
    "claim_event_deliveries",
    "handler",
    "ack_event_delivery",
  ]);
});

Deno.test("runner records handler failures for retry/dead-letter policy", async () => {
  const calls: string[] = [];
  const client = {
    rpc: async (name: string) => {
      calls.push(name);
      if (name === "claim_event_deliveries") {
        return {
          data: [delivery()],
          error: null,
        };
      }
      return { data: "pending", error: null };
    },
  };
  const result = await runDomainEventBatch(client, "worker-1", {
    "message.received": async () => {
      throw new Error("temporary outage");
    },
  });
  assertEquals(result, { claimed: 1, delivered: 0, failed: 1 });
  assertEquals(calls, ["claim_event_deliveries", "fail_event_delivery"]);
});

Deno.test("runner fails closed when claim RPC fails", async () => {
  const client = {
    rpc: async () => ({ data: null, error: { message: "db unavailable" } }),
  };
  await assertRejects(
    () =>
      runDomainEventBatch(client, "worker-1", {
        "message.received": async () => {},
      }),
    Error,
    "event claim failed",
  );
});
