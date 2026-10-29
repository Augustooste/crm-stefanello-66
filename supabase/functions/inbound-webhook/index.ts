import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { handleInbound, type InboundDeps } from "./handler.ts";

// A autenticação é a assinatura/token da regra, verificada dentro da função
// (verify_jwt = false no config.toml: o gateway chamador não tem JWT do Supabase).
// Prazo único por requisição para todas as RPCs (até três por caminho, incluindo o
// record_inbound_ignored best-effort): o Asaas espera 10 s (task-4-review §G).
const RPC_DEADLINE_MS = 8000;

Deno.serve((req) => {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    return new Response(JSON.stringify({ error: "unavailable" }), {
      status: 503,
      headers: { "content-type": "application/json", "X-Request-Id": crypto.randomUUID() },
    });
  }
  const deadline = AbortSignal.timeout(RPC_DEADLINE_MS);
  // Client por requisição: o prazo vale para a requisição inteira, não para cada RPC.
  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
        }),
    },
  }) as unknown as InboundDeps["db"];
  return handleInbound(req, {
    db,
    log: (entry) => console.log(JSON.stringify(entry)),
    now: () => Date.now(),
  });
});
