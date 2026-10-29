import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { handleRequest } from "./handler.ts";
import type { DbClient } from "./types.ts";

// A autenticação é a chave de API dentro da função (verify_jwt = false no config.toml).
const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
) as unknown as DbClient;

Deno.serve((req) =>
  handleRequest(req, {
    db,
    log: (event) => console.log(JSON.stringify(event)),
    newRequestId: () => crypto.randomUUID(),
  })
);
