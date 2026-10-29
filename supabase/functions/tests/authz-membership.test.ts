// Membership revogada tem que barrar a Edge — auditoria de 2026-07-28.
//
// Este arquivo morava em `scripts/`, onde NENHUM runner o alcançava: o Vitest
// só coleta `src/**/*.test.{ts,tsx}` (vitest.config.ts) e o `pnpm test:functions`
// só varre `supabase/functions/tests/`. Ou seja: a única prova automatizada de
// que um membro desativado não passa pelo `loadProfileOrFail` ficou dois meses
// sem rodar uma única vez. Mover para cá não é organização de pasta — é o que
// faz o teste existir de verdade.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { BASE_ENV, installFetchMock, jsonResponse, setEnv } from "./_helpers.ts";
import { loadProfileOrFail } from "../_shared/load-profile.ts";

setEnv(BASE_ENV);

Deno.test("AUDITORIA 2026-07-28 — membership revogada bloqueia Edge", async () => {
  let membershipReads = 0;
  const uninstall = installFetchMock((req) => {
    if (req.pathname === "/rest/v1/profiles" && req.method === "GET") {
      return jsonResponse(200, {
        tenant_id: "tenant-1",
        role: "admin",
      });
    }
    if (req.pathname === "/rest/v1/tenant_memberships" && req.method === "GET") {
      membershipReads += 1;
      return jsonResponse(200, {
        tenant_id: "tenant-1",
        user_id: "user-revoked",
        role_id: "role-admin",
        status: "disabled",
        revoked_at: null,
      });
    }
    return undefined;
  });

  try {
    const admin = createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const result = await loadProfileOrFail(admin, "user-revoked", {
      operation: "audit.authz",
    });

    if (membershipReads === 0) {
      throw new Error("loadProfileOrFail não consultou tenant_memberships");
    }
    if (result.ok) {
      throw new Error("membership disabled foi autorizada pela Edge");
    }
    // O motivo importa: `ok: false` sozinho não prova nada. `LoadProfileResult`
    // tem cinco motivos de recusa, e `db_error`/`membership_not_found` deixariam
    // este teste verde por acidente — bastaria o mock desalinhar do `select` de
    // `loadActiveMembershipRole` para o código nunca chegar a olhar o `status`.
    // Cravar `membership_inactive` é o que amarra o verde à proteção real.
    if (result.reason !== "membership_inactive") {
      throw new Error(
        `recusa veio pelo motivo errado: esperado "membership_inactive", veio "${result.reason}"`,
      );
    }
  } finally {
    uninstall();
  }
});

// Controle positivo: com a MESMA fixture e só o `status` em "active", o
// caminho tem que liberar. Sem este par, o teste acima passaria mesmo que
// `loadProfileOrFail` recusasse tudo indiscriminadamente — que é a forma mais
// comum de um teste de autorização virar decoração.
Deno.test("AUDITORIA 2026-07-28 — membership ativa passa (controle positivo)", async () => {
  const uninstall = installFetchMock((req) => {
    if (req.pathname === "/rest/v1/profiles" && req.method === "GET") {
      return jsonResponse(200, { tenant_id: "tenant-1", role: "admin" });
    }
    if (req.pathname === "/rest/v1/tenant_memberships" && req.method === "GET") {
      return jsonResponse(200, {
        tenant_id: "tenant-1",
        user_id: "user-ativo",
        role_id: "role-admin",
        status: "active",
        revoked_at: null,
      });
    }
    if (req.pathname === "/rest/v1/roles" && req.method === "GET") {
      return jsonResponse(200, { role_key: "admin" });
    }
    return undefined;
  });

  try {
    const admin = createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const result = await loadProfileOrFail(admin, "user-ativo", { operation: "audit.authz" });

    if (!result.ok) {
      throw new Error(`membership ativa foi recusada: ${result.reason}`);
    }
    if (result.tenantId !== "tenant-1" || result.role !== "admin") {
      throw new Error(`perfil veio errado: ${JSON.stringify(result)}`);
    }
  } finally {
    uninstall();
  }
});
