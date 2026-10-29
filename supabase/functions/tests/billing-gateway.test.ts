import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type BillingWebhook,
  type BillingWebhookStore,
  processBillingWebhook,
  SandboxBillingGateway,
} from "../_shared/billing/gateway.ts";

class MemoryStore implements BillingWebhookStore {
  claimed = new Set<string>();
  processed: string[] = [];
  failed: string[] = [];

  claim(provider: string, event: BillingWebhook): Promise<{ duplicate: boolean }> {
    const key = `${provider}:${event.id}`;
    const duplicate = this.claimed.has(key);
    this.claimed.add(key);
    return Promise.resolve({ duplicate });
  }
  markProcessed(provider: string, eventId: string): Promise<void> {
    this.processed.push(`${provider}:${eventId}`);
    return Promise.resolve();
  }
  markFailed(provider: string, eventId: string): Promise<void> {
    this.failed.push(`${provider}:${eventId}`);
    return Promise.resolve();
  }
}

function webhook(id = "evt-1") {
  return new Request("https://sandbox.local/webhook", {
    method: "POST",
    body: JSON.stringify({ id, type: "subscription.updated", data: { status: "active" } }),
  });
}

Deno.test("sandbox gateway normalizes and processes one event", async () => {
  const store = new MemoryStore();
  const handled: string[] = [];
  const result = await processBillingWebhook(
    new SandboxBillingGateway(),
    store,
    webhook(),
    (event) => {
      handled.push(event.id);
      return Promise.resolve();
    },
  );
  assertEquals(result, { duplicate: false, eventId: "evt-1" });
  assertEquals(handled, ["evt-1"]);
  assertEquals(store.processed, ["sandbox:evt-1"]);
});

Deno.test("duplicate event is acknowledged without running handler", async () => {
  const store = new MemoryStore();
  let calls = 0;
  const handler = () => {
    calls += 1;
    return Promise.resolve();
  };
  await processBillingWebhook(new SandboxBillingGateway(), store, webhook(), handler);
  const replay = await processBillingWebhook(
    new SandboxBillingGateway(),
    store,
    webhook(),
    handler,
  );
  assertEquals(replay.duplicate, true);
  assertEquals(calls, 1);
});

Deno.test("handler failure is persisted and rethrown", async () => {
  const store = new MemoryStore();
  await assertRejects(
    () =>
      processBillingWebhook(
        new SandboxBillingGateway(),
        store,
        webhook("evt-fail"),
        () => Promise.reject(new Error("boom")),
      ),
    Error,
    "boom",
  );
  assertEquals(store.failed, ["sandbox:evt-fail"]);
});

Deno.test("sandbox rejects malformed payload", async () => {
  const request = new Request("https://sandbox.local/webhook", {
    method: "POST",
    body: JSON.stringify({ type: "missing.id" }),
  });
  await assertRejects(
    () => new SandboxBillingGateway().verifyAndParseWebhook(request),
    Error,
    "requires id and type",
  );
});
