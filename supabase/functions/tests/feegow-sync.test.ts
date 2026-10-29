// Testa a lógica pura de supabase/functions/feegow-sync/runner.ts: sync de
// agendamentos Feegow -> public.appointments por tenant, isolamento de
// falha via Promise.allSettled (1 tenant com erro na API não impede o
// sync/log dos demais), idempotência do upsert (ON CONFLICT
// tenant_id/external_source/external_ref) e mapeamento de status_id
// desconhecido para 'scheduled' sem lançar. Mesmo harness Deno
// (createClient real + installFetchMock) usado pelos demais arquivos desta
// pasta -- ver docs/TESTING.md ("Edge functions (Deno) — deno test").
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { BASE_ENV, type FetchMatcher, installFetchMock, jsonResponse, setEnv } from "./_helpers.ts";
import { mapFeegowStatus, runFeegowSync } from "../feegow-sync/runner.ts";

setEnv(BASE_ENV);

function newAdminClient() {
  return createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function stripOp(raw: string | null): string {
  return raw?.replace(/^[a-z.]+\./, "") ?? "";
}

interface TenantIntegrationRowState {
  tenant_id: string;
  config: Record<string, unknown>;
}

interface SecretRowState {
  tenant_id: string;
  key: string;
  value: string;
}

interface AppointmentRowState {
  tenant_id: string;
  external_source: string;
  external_ref: string;
  status: string;
  [key: string]: unknown;
}

interface SyncLogRowState {
  tenant_id: string;
  status: string;
  synced_count: number;
  error_detail: string | null;
}

interface FeegowApiBehavior {
  networkError?: boolean;
  status?: number;
  body?: unknown;
}

interface MockState {
  integrations: TenantIntegrationRowState[];
  secrets: SecretRowState[];
  appointments: AppointmentRowState[];
  syncLogs: SyncLogRowState[];
  /** Comportamento da API Feegow por access_token (cada tenant tem o seu). */
  feegowApiByToken: Record<string, FeegowApiBehavior>;
}

function defaultState(): MockState {
  return { integrations: [], secrets: [], appointments: [], syncLogs: [], feegowApiByToken: {} };
}

/**
 * Router genérico: nenhum lookup por `tenant_id === "..."` hardcoded, tudo
 * resolve por `state.*` -- o mesmo racional de genericidade documentado em
 * messaging-channels-reconcile.test.ts.
 */
function router(state: MockState): FetchMatcher {
  return (req) => {
    const url = new URL(req.url);
    const p = url.pathname;
    const sp = url.searchParams;

    // -------- tenant_integrations: carga de integrações feegow ativas --------
    if (p === "/rest/v1/tenant_integrations" && req.method === "GET") {
      if (sp.get("slug") !== "eq.feegow" || sp.get("status") !== "eq.active") {
        throw new Error(
          `GET tenant_integrations esperava slug=eq.feegow&status=eq.active, veio slug=${
            sp.get("slug")
          } status=${sp.get("status")}`,
        );
      }
      return jsonResponse(200, state.integrations);
    }

    // -------- integration_secrets: clinic_id/access_token por tenant --------
    if (p === "/rest/v1/integration_secrets" && req.method === "GET") {
      if (sp.get("slug") !== "eq.feegow") {
        throw new Error(`GET integration_secrets esperava slug=eq.feegow, veio ${sp.get("slug")}`);
      }
      const tenantId = stripOp(sp.get("tenant_id"));
      const rows = state.secrets.filter((s) => s.tenant_id === tenantId);
      return jsonResponse(200, rows);
    }

    // -------- feegow_upsert_appointments: RPC de upsert idempotente --------
    // Não é POST /rest/v1/appointments direto -- appointments_external_dedupe
    // é um índice único PARCIAL (where external_ref is not null), e o
    // parâmetro on_conflict do PostgREST não expressa esse predicado
    // (verificado empiricamente contra o Postgres local: ON CONFLICT com
    // lista de colunas nua falha com 42P10 contra índice parcial). Ver RPC
    // em 20260712150000_fase6_feegow_sync_log.sql -- este mock espelha o
    // comportamento real dela (upsert por tenant_id+external_source+
    // external_ref), não só confia na chamada.
    if (p === "/rest/v1/rpc/feegow_upsert_appointments" && req.method === "POST") {
      const body = req.bodyJson as { p_rows: AppointmentRowState[] };
      const rows = body.p_rows ?? [];
      for (const row of rows) {
        const idx = state.appointments.findIndex(
          (a) =>
            a.tenant_id === row.tenant_id &&
            a.external_source === row.external_source &&
            a.external_ref === row.external_ref,
        );
        if (idx >= 0) state.appointments[idx] = { ...state.appointments[idx], ...row };
        else state.appointments.push(row);
      }
      return jsonResponse(200, rows.length);
    }

    // -------- feegow_sync_log: 1 insert por tenant processado --------
    if (p === "/rest/v1/feegow_sync_log" && req.method === "POST") {
      state.syncLogs.push(req.bodyJson as SyncLogRowState);
      return jsonResponse(201, []);
    }

    // -------- API real da Feegow (host/path diferente do REST do Supabase) --------
    if (p === "/v1/api/appoints/search") {
      const token = req.headers.get("x-access-token") ?? "";
      const behavior = state.feegowApiByToken[token];
      if (!behavior) return jsonResponse(200, { success: true, content: [] });
      if (behavior.networkError) throw new Error("network down");
      return jsonResponse(behavior.status ?? 200, behavior.body ?? { success: true, content: [] });
    }

    return undefined;
  };
}

function feegowAppointment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agendamento_id: 1001,
    data: "15-07-2026",
    horario: "14:30",
    status_id: 1,
    telemedicina: false,
    ...overrides,
  };
}

Deno.test("runFeegowSync", async (t) => {
  await t.step(
    "2 tenants: falha na API Feegow de 1 não impede o sync/log do outro (Promise.allSettled)",
    async () => {
      const state = defaultState();
      state.integrations = [
        { tenant_id: "tenant-a", config: {} },
        { tenant_id: "tenant-b", config: {} },
      ];
      state.secrets = [
        { tenant_id: "tenant-a", key: "clinic_id", value: "clinic-a" },
        { tenant_id: "tenant-a", key: "access_token", value: "token-a" },
        { tenant_id: "tenant-b", key: "clinic_id", value: "clinic-b" },
        { tenant_id: "tenant-b", key: "access_token", value: "token-b" },
      ];
      state.feegowApiByToken["token-a"] = {
        status: 200,
        body: { success: true, content: [feegowAppointment({ agendamento_id: 1 })] },
      };
      state.feegowApiByToken["token-b"] = { networkError: true };

      const uninstall = installFetchMock(router(state));
      try {
        const admin = newAdminClient();
        const summary = await runFeegowSync({ admin }, { now: new Date("2026-07-11T12:00:00Z") });

        if (summary.tenantsProcessed !== 2) {
          throw new Error(`tenantsProcessed=${summary.tenantsProcessed}, esperado 2`);
        }
        if (summary.tenantsFailed !== 1) {
          throw new Error(`tenantsFailed=${summary.tenantsFailed}, esperado 1 (só tenant-b)`);
        }

        if (state.appointments.length !== 1 || state.appointments[0].tenant_id !== "tenant-a") {
          throw new Error(
            `appointments=${JSON.stringify(state.appointments)}, esperado só 1 linha do tenant-a`,
          );
        }

        if (state.syncLogs.length !== 2) {
          throw new Error(`syncLogs.length=${state.syncLogs.length}, esperado 2 (1 por tenant)`);
        }
        const logA = state.syncLogs.find((l) => l.tenant_id === "tenant-a");
        const logB = state.syncLogs.find((l) => l.tenant_id === "tenant-b");
        if (!logA || logA.status !== "success" || logA.synced_count !== 1) {
          throw new Error(`log tenant-a inesperado: ${JSON.stringify(logA)}`);
        }
        if (!logB || logB.status !== "error" || logB.synced_count !== 0 || !logB.error_detail) {
          throw new Error(
            `log tenant-b inesperado (deveria ser error, com error_detail): ${
              JSON.stringify(logB)
            }`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "rodar 2x com o mesmo agendamento_id não duplica linhas em appointments (idempotência)",
    async () => {
      const state = defaultState();
      state.integrations = [{ tenant_id: "tenant-a", config: {} }];
      state.secrets = [
        { tenant_id: "tenant-a", key: "clinic_id", value: "clinic-a" },
        { tenant_id: "tenant-a", key: "access_token", value: "token-a" },
      ];
      state.feegowApiByToken["token-a"] = {
        status: 200,
        body: { success: true, content: [feegowAppointment({ agendamento_id: 42, status_id: 1 })] },
      };

      const uninstall = installFetchMock(router(state));
      try {
        const admin = newAdminClient();
        const now = new Date("2026-07-11T12:00:00Z");

        await runFeegowSync({ admin }, { now });
        if (state.appointments.length !== 1) {
          throw new Error(
            `após 1a rodada: appointments.length=${state.appointments.length}, esperado 1`,
          );
        }

        // Segunda execução: mesma resposta Feegow (mesmo agendamento_id=42) --
        // deve fazer UPDATE (via ON CONFLICT), não INSERT duplicado.
        state.feegowApiByToken["token-a"] = {
          status: 200,
          body: {
            success: true,
            content: [feegowAppointment({ agendamento_id: 42, status_id: 2 })],
          },
        };
        await runFeegowSync({ admin }, { now });

        if (state.appointments.length !== 1) {
          throw new Error(
            `após 2a rodada: appointments.length=${state.appointments.length}, esperado continuar 1 (dedupe por tenant_id/external_source/external_ref)`,
          );
        }
        if (state.appointments[0].status !== "confirmed") {
          throw new Error(
            `status da linha após 2a rodada=${
              state.appointments[0].status
            }, esperado 'confirmed' (status_id=2 da 2a resposta sobrescreveu via upsert)`,
          );
        }
        if (state.syncLogs.length !== 2) {
          throw new Error(`syncLogs.length=${state.syncLogs.length}, esperado 2 (1 por execução)`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("status_id desconhecido da Feegow mapeia para 'scheduled' sem lançar", async () => {
    if (mapFeegowStatus(9999) !== "scheduled") {
      throw new Error(`mapFeegowStatus(9999)=${mapFeegowStatus(9999)}, esperado 'scheduled'`);
    }

    const state = defaultState();
    state.integrations = [{ tenant_id: "tenant-a", config: {} }];
    state.secrets = [
      { tenant_id: "tenant-a", key: "clinic_id", value: "clinic-a" },
      { tenant_id: "tenant-a", key: "access_token", value: "token-a" },
    ];
    state.feegowApiByToken["token-a"] = {
      status: 200,
      body: {
        success: true,
        content: [feegowAppointment({ agendamento_id: 7, status_id: 9999 })],
      },
    };

    const uninstall = installFetchMock(router(state));
    try {
      const admin = newAdminClient();
      const summary = await runFeegowSync({ admin }, { now: new Date("2026-07-11T12:00:00Z") });

      if (summary.tenantsFailed !== 0) {
        throw new Error(
          `tenantsFailed=${summary.tenantsFailed}, esperado 0 (status_id desconhecido não é erro)`,
        );
      }
      if (state.appointments.length !== 1 || state.appointments[0].status !== "scheduled") {
        throw new Error(
          `appointments=${
            JSON.stringify(state.appointments)
          }, esperado 1 linha com status='scheduled'`,
        );
      }
      const log = state.syncLogs[0];
      if (!log || log.status !== "success") {
        throw new Error(`log inesperado: ${JSON.stringify(log)}`);
      }
    } finally {
      uninstall();
    }
  });
});
