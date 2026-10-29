// Testa hitl-overdue-activity-analyzer: (1) a regra pura de cálculo de
// priority (logic.ts, sem I/O) e (2) o handler HTTP — auth fail-closed,
// validação de corpo, filtros da query de activities, e o guard de
// idempotência (a unique index parcial idx_hitl_decisions_one_pending_per_activity
// garante no máximo 1 decisão pendente por atividade; aqui simulamos via
// mock de fetch a violação 23505 que o Postgres devolveria numa 2ª rodada —
// não há Postgres real neste harness Deno, então isto valida a REAÇÃO do
// handler ao conflito, não o índice em si).
import {
  BASE_ENV,
  captureHandler,
  type FetchMatcher,
  installFetchMock,
  jsonResponse,
  setEnv,
} from "./_helpers.ts";
import { DAY_MS, daysAgoIso, req } from "./_hitl-test-helpers.ts";
import {
  calculateOverduePriority,
  daysOverdue,
  OVERDUE_CRITICAL_DAYS,
  OVERDUE_HIGH_DAYS,
} from "../hitl-overdue-activity-analyzer/logic.ts";

setEnv(BASE_ENV);

const handler = await captureHandler("../hitl-overdue-activity-analyzer/index.ts");

const TENANT_ID = "tenant-1";

function activityRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "act-1",
    tenant_id: TENANT_ID,
    title: "Ligar para o cliente",
    due_at: daysAgoIso(10),
    deal_id: "deal-1",
    contact_id: "contact-1",
    ...overrides,
  };
}

// -------------------- Lógica pura (logic.ts) --------------------

Deno.test("calculateOverduePriority (regra pura, sem I/O)", async (t) => {
  const now = new Date("2026-07-10T12:00:00.000Z");

  await t.step("mais de 7 dias de atraso => critical", () => {
    const dueAt = new Date(now.getTime() - 8 * DAY_MS).toISOString();
    if (calculateOverduePriority(dueAt, now) !== "critical") {
      throw new Error("esperado critical para 8 dias de atraso");
    }
  });

  await t.step("exatamente 7 dias de atraso ainda é high (limite exclusivo)", () => {
    const dueAt = new Date(now.getTime() - OVERDUE_CRITICAL_DAYS * DAY_MS).toISOString();
    if (calculateOverduePriority(dueAt, now) !== "high") {
      throw new Error("esperado high no limite exato de 7 dias");
    }
  });

  await t.step("mais de 2 e até 7 dias de atraso => high", () => {
    const dueAt = new Date(now.getTime() - 3 * DAY_MS).toISOString();
    if (calculateOverduePriority(dueAt, now) !== "high") {
      throw new Error("esperado high para 3 dias de atraso");
    }
  });

  await t.step("exatamente 2 dias de atraso ainda é medium (limite exclusivo)", () => {
    const dueAt = new Date(now.getTime() - OVERDUE_HIGH_DAYS * DAY_MS).toISOString();
    if (calculateOverduePriority(dueAt, now) !== "medium") {
      throw new Error("esperado medium no limite exato de 2 dias");
    }
  });

  await t.step("até 2 dias de atraso => medium", () => {
    const dueAt = new Date(now.getTime() - 1 * DAY_MS).toISOString();
    if (calculateOverduePriority(dueAt, now) !== "medium") {
      throw new Error("esperado medium para 1 dia de atraso");
    }
  });

  await t.step("daysOverdue calcula fração de dias corretamente (1.5 dias)", () => {
    const dueAt = new Date(now.getTime() - 36 * 60 * 60 * 1000).toISOString();
    const days = daysOverdue(dueAt, now);
    if (Math.abs(days - 1.5) > 1e-9) throw new Error(`esperado 1.5, obtido ${days}`);
  });
});

// -------------------- Handler HTTP (index.ts) --------------------

Deno.test("hitl-overdue-activity-analyzer (handler)", async (t) => {
  await t.step("OPTIONS responde CORS sem corpo", async () => {
    const res = await handler(req(undefined, { method: "OPTIONS" }));
    if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
    if (await res.text()) throw new Error("esperado corpo vazio");
  });

  await t.step("método não-POST retorna 405", async () => {
    const res = await handler(req(undefined, { method: "GET" }));
    if (res.status !== 405) throw new Error(`esperado 405, veio ${res.status}`);
  });

  await t.step("sem Authorization retorna 401", async () => {
    const res = await handler(req(undefined, { auth: null }));
    if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
  });

  await t.step("bearer diferente do service role retorna 401", async () => {
    const res = await handler(req(undefined, { auth: "Bearer errado" }));
    if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
  });

  await t.step("corpo presente e inválido (JSON quebrado) retorna 400", async () => {
    const res = await handler(
      new Request("http://fn.local", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${BASE_ENV.SUPABASE_SERVICE_ROLE_KEY}`,
          "content-type": "application/json",
        },
        body: "{not-json",
      }),
    );
    const body = await res.json();
    if (res.status !== 400 || body.error !== "Corpo inválido.") {
      throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("tenantId de tipo errado retorna 400", async () => {
    const res = await handler(req({ tenantId: 123 }));
    const body = await res.json();
    if (res.status !== 400 || body.error !== "tenantId inválido.") {
      throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
    }
  });

  await t.step(
    "sem corpo nenhum (cron sem payload) processa todos os tenants, sem filtro de tenant_id",
    async () => {
      let sawTenantFilter = false;
      let sawActivitiesQuery = false;
      const router: FetchMatcher = (r) => {
        if (r.pathname === "/rest/v1/activities" && r.method === "GET") {
          sawActivitiesQuery = true;
          const sp = new URL(r.url).searchParams;
          if (sp.has("tenant_id")) sawTenantFilter = true;
          return jsonResponse(200, []);
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const res = await handler(req(undefined));
        const body = await res.json();
        if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
        if (body.processed !== 0) throw new Error(`inesperado: ${JSON.stringify(body)}`);
        if (!sawActivitiesQuery) throw new Error("query de activities não foi disparada");
        if (sawTenantFilter) {
          throw new Error("não deveria filtrar por tenant_id sem tenantId no corpo");
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "query filtra due_at IS NOT NULL, completed_at IS NULL, due_at < now, e tenant_id quando informado",
    async () => {
      let checked = false;
      const router: FetchMatcher = (r) => {
        if (r.pathname === "/rest/v1/activities" && r.method === "GET") {
          const sp = new URL(r.url).searchParams;
          const dueAtFilters = sp.getAll("due_at");
          if (!dueAtFilters.includes("not.is.null")) {
            throw new Error(`due_at not.is.null ausente: ${JSON.stringify(dueAtFilters)}`);
          }
          if (!dueAtFilters.some((f) => f.startsWith("lt."))) {
            throw new Error(`due_at lt.* ausente: ${JSON.stringify(dueAtFilters)}`);
          }
          if (sp.get("completed_at") !== "is.null") {
            throw new Error(`completed_at inesperado: ${sp.get("completed_at")}`);
          }
          if (sp.get("tenant_id") !== `eq.${TENANT_ID}`) {
            throw new Error(`tenant_id inesperado: ${sp.get("tenant_id")}`);
          }
          checked = true;
          return jsonResponse(200, []);
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const res = await handler(req({ tenantId: TENANT_ID }));
        if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
        if (!checked) throw new Error("query de activities não foi verificada");
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "cria decisões com priority correta por atividade (critical/high/medium)",
    async () => {
      const rows = [
        activityRow({ id: "act-critical", due_at: daysAgoIso(10) }),
        activityRow({ id: "act-high", due_at: daysAgoIso(3) }),
        activityRow({ id: "act-medium", due_at: daysAgoIso(1) }),
      ];
      const insertedPriorities = new Map<string, string>();
      const router: FetchMatcher = (r) => {
        if (r.pathname === "/rest/v1/activities" && r.method === "GET") {
          return jsonResponse(200, rows);
        }
        if (r.pathname === "/rest/v1/hitl_decisions" && r.method === "POST") {
          const payload = r.bodyJson as {
            activity_id: string;
            priority: string;
            type: string;
            category: string;
            suggested_action: unknown;
            auto_generated: boolean;
          };
          insertedPriorities.set(payload.activity_id, payload.priority);
          if (payload.type !== "overdue_activity") {
            throw new Error(
              `type inesperado: ${payload.type}`,
            );
          }
          if (payload.category !== "deadline") {
            throw new Error(
              `category inesperado: ${payload.category}`,
            );
          }
          if (payload.auto_generated !== true) throw new Error("auto_generated deveria ser true");
          if (
            JSON.stringify(payload.suggested_action) !==
              JSON.stringify({ action: "reschedule_or_complete" })
          ) {
            throw new Error(
              `suggested_action inesperado: ${JSON.stringify(payload.suggested_action)}`,
            );
          }
          return new Response(null, { status: 201 });
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const res = await handler(req({ tenantId: TENANT_ID }));
        const body = await res.json();
        if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
        if (body.processed !== 3 || body.created !== 3 || body.failed !== 0 || body.skipped !== 0) {
          throw new Error(`inesperado: ${JSON.stringify(body)}`);
        }
        if (insertedPriorities.get("act-critical") !== "critical") {
          throw new Error(
            `act-critical deveria ser critical, veio ${insertedPriorities.get("act-critical")}`,
          );
        }
        if (insertedPriorities.get("act-high") !== "high") {
          throw new Error(`act-high deveria ser high, veio ${insertedPriorities.get("act-high")}`);
        }
        if (insertedPriorities.get("act-medium") !== "medium") {
          throw new Error(
            `act-medium deveria ser medium, veio ${insertedPriorities.get("act-medium")}`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "guard de idempotência: rodar duas vezes seguidas não duplica (2ª rodada => skipped, não failed)",
    async () => {
      const row = activityRow({ id: "act-idempotente", due_at: daysAgoIso(5) });
      let insertCount = 0;
      const router: FetchMatcher = (r) => {
        if (r.pathname === "/rest/v1/activities" && r.method === "GET") {
          return jsonResponse(200, [row]);
        }
        if (r.pathname === "/rest/v1/hitl_decisions" && r.method === "POST") {
          insertCount++;
          if (insertCount === 1) {
            return new Response(null, { status: 201 });
          }
          // Simula a violação de unicidade que a unique index parcial
          // idx_hitl_decisions_one_pending_per_activity devolveria numa 2ª
          // tentativa de INSERT para a mesma (activity_id, type) ainda
          // pendente — não é o índice real rodando, é a reação do handler
          // a esse SQLSTATE que está sendo testada.
          return jsonResponse(409, {
            code: "23505",
            message:
              'duplicate key value violates unique constraint "idx_hitl_decisions_one_pending_per_activity"',
            details: null,
            hint: null,
          });
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const res1 = await handler(req({ tenantId: TENANT_ID }));
        const body1 = await res1.json();
        if (body1.created !== 1 || body1.skipped !== 0 || body1.failed !== 0) {
          throw new Error(`1ª rodada inesperada: ${JSON.stringify(body1)}`);
        }

        const res2 = await handler(req({ tenantId: TENANT_ID }));
        const body2 = await res2.json();
        if (body2.created !== 0 || body2.skipped !== 1 || body2.failed !== 0) {
          throw new Error(
            `2ª rodada inesperada (não deveria duplicar nem falhar): ${JSON.stringify(body2)}`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "erro de INSERT que não é unique_violation conta como failed (não como skipped)",
    async () => {
      const row = activityRow({ id: "act-erro", due_at: daysAgoIso(4) });
      const router: FetchMatcher = (r) => {
        if (r.pathname === "/rest/v1/activities" && r.method === "GET") {
          return jsonResponse(200, [row]);
        }
        if (r.pathname === "/rest/v1/hitl_decisions" && r.method === "POST") {
          return jsonResponse(500, {
            code: "XX000",
            message: "banco fora do ar",
            details: null,
            hint: null,
          });
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const res = await handler(req({ tenantId: TENANT_ID }));
        const body = await res.json();
        if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
        if (body.processed !== 1 || body.created !== 0 || body.skipped !== 0 || body.failed !== 1) {
          throw new Error(`inesperado: ${JSON.stringify(body)}`);
        }
        if (!Array.isArray(body.errors) || body.errors.length !== 1) {
          throw new Error(`errors inesperado: ${JSON.stringify(body.errors)}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("erro na query de activities retorna 500", async () => {
    const router: FetchMatcher = (r) => {
      if (r.pathname === "/rest/v1/activities" && r.method === "GET") {
        return jsonResponse(500, { code: "XX000", message: "timeout", details: null, hint: null });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const res = await handler(req({ tenantId: TENANT_ID }));
      if (res.status !== 500) throw new Error(`esperado 500, veio ${res.status}`);
    } finally {
      uninstall();
    }
  });
});
