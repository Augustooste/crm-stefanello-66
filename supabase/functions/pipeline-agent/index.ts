import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { runPipelineAgentBatch } from "../_shared/ai/pipeline-agent.ts";
import { captureEdgeError } from "../_shared/telemetry.ts";
import { timingSafeEqualStrings } from "../_shared/timing-safe-equal.ts";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "content-type": "application/json",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers });

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
  const workerId = `pipeline-agent:${crypto.randomUUID()}`;
  try {
    const result = await runPipelineAgentBatch(client, workerId);
    await captureEdgeError(client, {
      severity: result.failed > 0 ? "warn" : "info",
      source: "edge",
      operation: "pipeline.agent.batch",
      message: "Pipeline agent batch processed",
      context: { workerId, ...result },
    });
    return json(200, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await captureEdgeError(client, {
      severity: "error",
      source: "edge",
      operation: "pipeline.agent.batch",
      message,
      stack: error instanceof Error ? error.stack : null,
      context: { workerId },
    });
    return json(500, { error: message });
  }
});
