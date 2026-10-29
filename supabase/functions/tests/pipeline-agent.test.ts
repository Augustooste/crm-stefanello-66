import { assertEquals } from "jsr:@std/assert";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { createPipelineEventHandler, runPipelineAgentBatch } from "../_shared/ai/pipeline-agent.ts";
import type { DomainEventDelivery } from "../_shared/domain-event-runner.ts";

const delivery = (overrides: Partial<DomainEventDelivery> = {}): DomainEventDelivery => ({
  delivery_id: "10000000-0000-0000-0000-000000000001",
  event_id: "10000000-0000-0000-0000-000000000002",
  tenant_id: "10000000-0000-0000-0000-000000000003",
  subscriber_id: "pipeline.agent",
  event_type: "message.sent",
  schema_version: 1,
  aggregate_type: "message",
  aggregate_id: "10000000-0000-0000-0000-000000000004",
  payload: { sender: "ai" },
  metadata: {},
  occurred_at: new Date(0).toISOString(),
  attempts: 1,
  max_attempts: 8,
  ...overrides,
});

Deno.test("pipeline agent ignores AI outbound messages before any database read", async () => {
  let touched = false;
  const admin = {
    from: () => {
      touched = true;
      throw new Error("database should not be touched");
    },
  } as unknown as SupabaseClient;

  await createPipelineEventHandler(admin)(delivery());
  assertEquals(touched, false);
});

Deno.test("pipeline agent stops when tenant disabled AI", async () => {
  const tables: string[] = [];
  const admin = {
    from: (table: string) => {
      tables.push(table);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { ai_enabled: false },
              error: null,
            }),
          }),
        }),
      };
    },
  } as unknown as SupabaseClient;

  await createPipelineEventHandler(admin)(
    delivery({
      event_type: "contact.updated",
      payload: { contact_id: "contact-1" },
    }),
  );
  assertEquals(tables, ["tenants"]);
});

Deno.test("pipeline batch claims only the pipeline.agent subscription", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const admin = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "claim_event_deliveries") {
        return { data: [delivery()], error: null };
      }
      return { data: true, error: null };
    },
  } as unknown as SupabaseClient;

  const result = await runPipelineAgentBatch(admin, "worker-1");
  assertEquals(result, { claimed: 1, delivered: 1, failed: 0 });
  assertEquals(calls[0].name, "claim_event_deliveries");
  assertEquals(calls[0].args.p_subscriber_ids, ["pipeline.agent"]);
  assertEquals(calls[1].name, "ack_event_delivery");
});
