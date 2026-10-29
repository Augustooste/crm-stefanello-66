import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { captureEdgeError } from "../_shared/telemetry.ts";
import { timingSafeEqualStrings } from "../_shared/timing-safe-equal.ts";
import {
  type DeliveryRow,
  type EndpointRow,
  type EventRow,
  runWebhookDeliveryWorker,
  validateWebhookUrl,
  type WebhookWorkerDb,
} from "./runner.ts";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "content-type": "application/json",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers });

function createDb(client: SupabaseClient): WebhookWorkerDb {
  const check = (error: { message: string } | null) => {
    if (error) throw new Error(error.message);
  };
  return {
    async claim(limit, worker) {
      const { data, error } = await client.rpc("claim_webhook_deliveries", { p_limit: limit, p_worker: worker });
      check(error);
      return (data ?? []) as DeliveryRow[];
    },
    async loadEndpoint(id) {
      const { data, error } = await client.from("webhook_endpoints").select("id, url, active").eq("id", id)
        .maybeSingle();
      check(error);
      return data as EndpointRow | null;
    },
    async loadEvent(id) {
      const { data, error } = await client.from("domain_events")
        .select("id, event_type, tenant_id, occurred_at, payload").eq("id", id).maybeSingle();
      check(error);
      return data as EventRow | null;
    },
    async getSecrets(endpointId) {
      const { data, error } = await client.rpc("get_webhook_secrets", { p_endpoint_id: endpointId });
      check(error);
      const row = (Array.isArray(data) ? data[0] : data) as { current: string | null; previous: string | null } | null;
      return { current: row?.current ?? null, previous: row?.previous ?? null };
    },
    async complete(id, worker, status, excerpt) {
      const { error } = await client.rpc("complete_webhook_delivery", {
        p_delivery_id: id,
        p_worker: worker,
        p_response_status: status,
        p_response_excerpt: excerpt,
      });
      check(error);
    },
    async fail(id, worker, message, status, excerpt, retryAt) {
      const { error } = await client.rpc("fail_webhook_delivery", {
        p_delivery_id: id,
        p_worker: worker,
        p_error: message,
        p_response_status: status,
        p_response_excerpt: excerpt,
        p_retry_at: retryAt.toISOString(),
      });
      check(error);
    },
    async deadLetter(id, worker, message) {
      const { error } = await client.from("webhook_deliveries")
        .update({ status: "dead_letter", last_error: message, locked_at: null, locked_by: null })
        .eq("id", id).eq("status", "processing").eq("locked_by", worker);
      check(error);
    },
    async disableEndpoint(id, reason) {
      // set_webhook_endpoint_active exige usuário admin (auth.uid); o worker usa service_role.
      const { error } = await client.from("webhook_endpoints")
        .update({ active: false, disabled_reason: reason, updated_at: new Date().toISOString() }).eq("id", id);
      check(error);
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!serviceRole || !timingSafeEqualStrings(bearer, serviceRole)) {
    return json(401, { error: "Unauthorized" });
  }

  const client = createClient(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const workerId = `webhook:${crypto.randomUUID()}`;
  try {
    const result = await runWebhookDeliveryWorker(createDb(client), workerId, { validateUrl: (url) => validateWebhookUrl(url) });
    if (result.failed > 0 || result.errored > 0) {
      await captureEdgeError(client, {
        severity: "warn",
        source: "edge",
        operation: "webhooks.deliver_batch",
        message: "Webhook batch finished with failures",
        context: { workerId, ...result },
      });
    }
    return json(200, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await captureEdgeError(client, {
      severity: "error",
      source: "edge",
      operation: "webhooks.deliver_batch",
      message,
      stack: error instanceof Error ? error.stack : null,
      context: { workerId },
    });
    return json(500, { error: message });
  }
});
