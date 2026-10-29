// Testa loadProfileOrFail: a distinção que o item 6 do code review existe para
// criar — erro de banco NÃO é "perfil não encontrado".
//
// O teste que importa é o `db_error`: antes deste helper, `{ data: profile }`
// sem `error` fazia uma queda do banco virar 403 "Perfil não encontrado.". Se
// alguém reverter o helper para o padrão antigo, o caso 2 abaixo passa a
// devolver `not_found` e quebra — é essa a sensibilidade que o teste protege.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

import { BASE_ENV, installFetchMock, jsonResponse, setEnv } from "./_helpers.ts";
import { loadProfileOrFail, PROFILE_DB_ERROR_MESSAGE } from "../_shared/load-profile.ts";

setEnv(BASE_ENV);

const USER_ID = "11111111-1111-1111-1111-111111111111";
const TENANT_ID = "22222222-2222-2222-2222-222222222222";
const ROLE_ID = "33333333-3333-3333-3333-333333333333";

function admin() {
  return createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Router com o caminho de profiles configurável e captura de system_events. */
function router(
  perfil: { status: number; body: unknown },
  telemetria: Record<string, unknown>[],
  membership?: { status: number; body: unknown },
  role?: { status: number; body: unknown },
) {
  return (r: { pathname: string; method: string; bodyJson: unknown }) => {
    if (r.pathname === "/rest/v1/profiles") return jsonResponse(perfil.status, perfil.body);
    if (r.pathname === "/rest/v1/tenant_memberships") {
      return jsonResponse(
        membership?.status ?? 200,
        membership ? membership.body : {
          tenant_id: TENANT_ID,
          user_id: USER_ID,
          role_id: ROLE_ID,
          status: "active",
          revoked_at: null,
        },
      );
    }
    if (r.pathname === "/rest/v1/roles") {
      const profileRole = (
          perfil.body && typeof perfil.body === "object" && "role" in perfil.body
        )
        ? (perfil.body as { role: unknown }).role
        : null;
      return jsonResponse(role?.status ?? 200, role ? role.body : { role_key: profileRole });
    }
    if (r.pathname === "/rest/v1/system_events" && r.method === "POST") {
      telemetria.push((r.bodyJson ?? {}) as Record<string, unknown>);
      return jsonResponse(201, {});
    }
    return undefined;
  };
}

Deno.test("loadProfileOrFail", async (t) => {
  await t.step("perfil existe: devolve tenantId e role, sem telemetria", async () => {
    const eventos: Record<string, unknown>[] = [];
    const uninstall = installFetchMock(
      router({ status: 200, body: { tenant_id: TENANT_ID, role: "admin" } }, eventos),
    );
    try {
      const r = await loadProfileOrFail(admin(), USER_ID, { operation: "teste.perfil" });
      if (!r.ok) throw new Error(`esperado ok, veio ${JSON.stringify(r)}`);
      if (r.tenantId !== TENANT_ID) throw new Error(`tenantId inesperado: ${r.tenantId}`);
      if (r.role !== "admin") throw new Error(`role inesperada: ${r.role}`);
      if (eventos.length !== 0) {
        throw new Error("caminho feliz não deveria gravar em system_events");
      }
    } finally {
      uninstall();
    }
  });

  await t.step("ERRO DE BANCO: devolve db_error, NÃO not_found, e reporta", async () => {
    const eventos: Record<string, unknown>[] = [];
    const uninstall = installFetchMock(
      router({ status: 500, body: { message: "statement timeout", code: "57014" } }, eventos),
    );
    try {
      const r = await loadProfileOrFail(admin(), USER_ID, { operation: "teste.perfil" });
      if (r.ok) throw new Error("erro de banco não pode devolver ok");
      // O ponto do item 6 inteiro: se isto virar "not_found", o usuário recebe
      // 403 dizendo que o cadastro dele não existe enquanto o banco está fora.
      if (r.reason !== "db_error") {
        throw new Error(
          `erro de banco virou "${r.reason}" — é exatamente o bug que o helper fecha`,
        );
      }
      if (eventos.length !== 1) {
        throw new Error(`esperado 1 evento em system_events, veio ${eventos.length}`);
      }
      const ev = eventos[0];
      if (ev.operation !== "teste.perfil" || ev.severity !== "error") {
        throw new Error(`evento inesperado: ${JSON.stringify(ev)}`);
      }
      if (ev.error_code !== "57014") {
        throw new Error(`error_code não propagado: ${JSON.stringify(ev)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("perfil ausente: not_found, sem telemetria (não é incidente)", async () => {
    const eventos: Record<string, unknown>[] = [];
    const uninstall = installFetchMock(router({ status: 200, body: null }, eventos));
    try {
      const r = await loadProfileOrFail(admin(), USER_ID, { operation: "teste.perfil" });
      if (r.ok || r.reason !== "not_found") {
        throw new Error(`esperado not_found, veio ${JSON.stringify(r)}`);
      }
      if (eventos.length !== 0) throw new Error("ausência de perfil não é incidente de infra");
    } finally {
      uninstall();
    }
  });

  await t.step("tenant_id nulo conta como not_found, não como sucesso", async () => {
    const eventos: Record<string, unknown>[] = [];
    const uninstall = installFetchMock(
      router({ status: 200, body: { tenant_id: null, role: "admin" } }, eventos),
    );
    try {
      const r = await loadProfileOrFail(admin(), USER_ID, { operation: "teste.perfil" });
      // Devolver ok com tenant vazio empurraria a falha para a primeira policy
      // de RLS lá na frente, onde a causa já não é mais legível.
      if (r.ok || r.reason !== "not_found") {
        throw new Error(`esperado not_found, veio ${JSON.stringify(r)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("requireAdmin: papel não-admin devolve not_admin", async () => {
    const eventos: Record<string, unknown>[] = [];
    const uninstall = installFetchMock(
      router({ status: 200, body: { tenant_id: TENANT_ID, role: "member" } }, eventos),
    );
    try {
      const r = await loadProfileOrFail(admin(), USER_ID, {
        operation: "teste.perfil",
        requireAdmin: true,
      });
      if (r.ok || r.reason !== "not_admin") {
        throw new Error(`esperado not_admin, veio ${JSON.stringify(r)}`);
      }
      if (eventos.length !== 0) throw new Error("falta de permissão não é incidente de infra");
    } finally {
      uninstall();
    }
  });

  await t.step("sem requireAdmin: papel não-admin passa", async () => {
    const eventos: Record<string, unknown>[] = [];
    const uninstall = installFetchMock(
      router({ status: 200, body: { tenant_id: TENANT_ID, role: "member" } }, eventos),
    );
    try {
      const r = await loadProfileOrFail(admin(), USER_ID, { operation: "teste.perfil" });
      if (!r.ok) throw new Error(`esperado ok, veio ${JSON.stringify(r)}`);
      if (r.role !== "member") throw new Error(`role inesperada: ${r.role}`);
    } finally {
      uninstall();
    }
  });

  await t.step("membership ausente bloqueia o usuário", async () => {
    const eventos: Record<string, unknown>[] = [];
    const uninstall = installFetchMock(
      router(
        { status: 200, body: { tenant_id: TENANT_ID, role: "admin" } },
        eventos,
        { status: 200, body: null },
      ),
    );
    try {
      const r = await loadProfileOrFail(admin(), USER_ID, { operation: "teste.perfil" });
      if (r.ok || r.reason !== "membership_not_found") {
        throw new Error(`esperado membership_not_found, veio ${JSON.stringify(r)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("membership revogada bloqueia o usuário", async () => {
    const eventos: Record<string, unknown>[] = [];
    const uninstall = installFetchMock(
      router(
        { status: 200, body: { tenant_id: TENANT_ID, role: "admin" } },
        eventos,
        {
          status: 200,
          body: {
            tenant_id: TENANT_ID,
            user_id: USER_ID,
            role_id: ROLE_ID,
            status: "revoked",
            revoked_at: "2026-07-28T12:00:00.000Z",
          },
        },
      ),
    );
    try {
      const r = await loadProfileOrFail(admin(), USER_ID, { operation: "teste.perfil" });
      if (r.ok || r.reason !== "membership_inactive") {
        throw new Error(`esperado membership_inactive, veio ${JSON.stringify(r)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("membership disabled bloqueia o usuário", async () => {
    const eventos: Record<string, unknown>[] = [];
    const uninstall = installFetchMock(
      router(
        { status: 200, body: { tenant_id: TENANT_ID, role: "admin" } },
        eventos,
        {
          status: 200,
          body: {
            tenant_id: TENANT_ID,
            user_id: USER_ID,
            role_id: ROLE_ID,
            status: "disabled",
            revoked_at: null,
          },
        },
      ),
    );
    try {
      const r = await loadProfileOrFail(admin(), USER_ID, { operation: "teste.perfil" });
      if (r.ok || r.reason !== "membership_inactive") {
        throw new Error(`esperado membership_inactive, veio ${JSON.stringify(r)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("membership de outro tenant não autoriza troca de contexto", async () => {
    const eventos: Record<string, unknown>[] = [];
    const uninstall = installFetchMock(
      router(
        { status: 200, body: { tenant_id: TENANT_ID, role: "admin" } },
        eventos,
        {
          status: 200,
          body: {
            tenant_id: "tenant-other",
            user_id: USER_ID,
            role_id: ROLE_ID,
            status: "active",
            revoked_at: null,
          },
        },
      ),
    );
    try {
      const r = await loadProfileOrFail(admin(), USER_ID, { operation: "teste.perfil" });
      if (r.ok || r.reason !== "membership_not_found") {
        throw new Error(`esperado membership_not_found, veio ${JSON.stringify(r)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("revoked_at preenchido bloqueia mesmo se status vier active", async () => {
    const eventos: Record<string, unknown>[] = [];
    const uninstall = installFetchMock(
      router(
        { status: 200, body: { tenant_id: TENANT_ID, role: "admin" } },
        eventos,
        {
          status: 200,
          body: {
            tenant_id: TENANT_ID,
            user_id: USER_ID,
            role_id: ROLE_ID,
            status: "active",
            revoked_at: "2026-07-28T12:00:00.000Z",
          },
        },
      ),
    );
    try {
      const r = await loadProfileOrFail(admin(), USER_ID, { operation: "teste.perfil" });
      if (r.ok || r.reason !== "membership_inactive") {
        throw new Error(`esperado membership_inactive, veio ${JSON.stringify(r)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("erro ao ler membership é db_error com telemetria", async () => {
    const eventos: Record<string, unknown>[] = [];
    const uninstall = installFetchMock(
      router(
        { status: 200, body: { tenant_id: TENANT_ID, role: "admin" } },
        eventos,
        { status: 500, body: { message: "membership timeout", code: "57014" } },
      ),
    );
    try {
      const r = await loadProfileOrFail(admin(), USER_ID, { operation: "teste.perfil" });
      if (r.ok || r.reason !== "db_error") {
        throw new Error(`esperado db_error, veio ${JSON.stringify(r)}`);
      }
      if (eventos.length !== 1 || eventos[0].error_code !== "57014") {
        throw new Error(`telemetria inesperada: ${JSON.stringify(eventos)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("requireAdmin usa o papel efetivo da membership", async () => {
    const eventos: Record<string, unknown>[] = [];
    const uninstall = installFetchMock(
      router(
        { status: 200, body: { tenant_id: TENANT_ID, role: "admin" } },
        eventos,
        undefined,
        { status: 200, body: { role_key: "agent" } },
      ),
    );
    try {
      const r = await loadProfileOrFail(admin(), USER_ID, {
        operation: "teste.perfil",
        requireAdmin: true,
      });
      if (r.ok || r.reason !== "not_admin") {
        throw new Error(`esperado not_admin, veio ${JSON.stringify(r)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("erro ao ler papel efetivo é db_error com telemetria", async () => {
    const eventos: Record<string, unknown>[] = [];
    const uninstall = installFetchMock(
      router(
        { status: 200, body: { tenant_id: TENANT_ID, role: "admin" } },
        eventos,
        undefined,
        { status: 500, body: { message: "role timeout", code: "57014" } },
      ),
    );
    try {
      const r = await loadProfileOrFail(admin(), USER_ID, { operation: "teste.perfil" });
      if (r.ok || r.reason !== "db_error") {
        throw new Error(`esperado db_error, veio ${JSON.stringify(r)}`);
      }
      if (eventos.length !== 1 || eventos[0].error_code !== "57014") {
        throw new Error(`telemetria inesperada: ${JSON.stringify(eventos)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("a mensagem de infra é única e não vaza detalhe do Postgres", () => {
    if (
      PROFILE_DB_ERROR_MESSAGE.includes("statement") || PROFILE_DB_ERROR_MESSAGE.includes("57014")
    ) {
      throw new Error("mensagem ao usuário não pode carregar detalhe cru do banco");
    }
    if (!PROFILE_DB_ERROR_MESSAGE.trim()) throw new Error("mensagem vazia");
  });
});
