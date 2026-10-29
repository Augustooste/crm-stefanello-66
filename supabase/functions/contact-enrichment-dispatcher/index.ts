import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { runContactEnrichmentBatch } from "../_shared/ai/contact-enrichment.ts";
import { timingSafeEqualStrings } from "../_shared/timing-safe-equal.ts";

const headers = { "content-type": "application/json" };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "Método não permitido." });
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!key || !timingSafeEqualStrings(bearer, key)) return json(401, { error: "Não autorizado." });
  const client = createClient(Deno.env.get("SUPABASE_URL")!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  try {
    return json(200, await runContactEnrichmentBatch(client, `contact-enrichment:${crypto.randomUUID()}`));
  } catch (error) {
    console.error("Falha no enriquecimento de contato", error instanceof Error ? error.message : "Erro desconhecido");
    return json(500, { error: "Não foi possível processar a ficha. O lote será retomado após o lease." });
  }
});
