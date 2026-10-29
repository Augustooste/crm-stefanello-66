// Testa a lógica pura de supabase/functions/weekly-digest-generator/runner.ts:
// idempotência do relatório (2ª chamada no mesmo período reaproveita a linha
// existente, sem recalcular métricas), claim de delivery via ON CONFLICT
// distinguindo 23505 (idempotente) de outro erro real (nunca por texto de
// mensagem -- risco #5 do PRD), falha isolada por destinatário (não aborta os
// demais) e a transição weekly_reports.status='sent' só quando TODAS as
// deliveries do relatório terminam. Mesmo harness Deno (createClient real +
// installFetchMock) usado pelos demais arquivos desta pasta -- ver
// docs/TESTING.md ("Edge functions (Deno) — deno test"); NÃO um arquivo
// Vitest (vitest.config.ts só cobre src/**, e este módulo importa de esm.sh).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { BASE_ENV, type FetchMatcher, installFetchMock, jsonResponse, setEnv } from "./_helpers.ts";
import {
  computeReportWindow,
  getOrCreateReport,
  renderDigestText,
  runWeeklyDigestGenerator,
  type WeeklyReportRow,
} from "../weekly-digest-generator/runner.ts";

setEnv(BASE_ENV);

function newAdminClient() {
  return createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const RESEND_SEND_URL = "https://api.resend.com/emails";
const ZAPI_SEND_URL = "https://api.z-api.io/instances/inst-1/token/tok-1/send-text";

function stripOp(raw: string | null): string | null {
  return raw?.replace(/^[a-z]+\./, "") ?? null;
}

function parseInList(raw: string | null): string[] {
  if (!raw) return [];
  return raw.replace(/^in\.\(/, "").replace(/\)$/, "").split(",").filter(Boolean);
}

interface RecipientSeed {
  id: string;
  tenant_id: string;
  channel: "email" | "whatsapp";
  address: string;
  name: string | null;
  active: boolean;
}

interface ReportSeed {
  id: string;
  tenant_id: string;
  period_start: string;
  period_end: string;
  metrics: Record<string, unknown>;
  status: string;
}

interface DeliverySeed {
  id: string;
  report_id: string;
  recipient_id: string;
  channel: string;
  address: string;
  status: string;
  attempt_count: number;
}

interface IntegrationSeed {
  tenant_id: string;
  slug: string;
  status: string;
}

interface MockState {
  recipients: RecipientSeed[];
  reports: ReportSeed[];
  deliveries: DeliverySeed[];
  integrations: IntegrationSeed[];
  dashboardMetrics: Record<string, unknown>;
  leaderboardRows: Array<Record<string, unknown>>;
  dashboardRpcCalls: number;
  leaderboardCalls: number;
  sendCallCount: number;
  forceReportInsertConflict: boolean;
  forceDeliveryConflictFor: Set<string>;
  forceDeliveryErrorFor: Set<string>;
  suppressedPhones: Set<string>;
  sendStatus: number;
  sendBody: unknown;
  nextReportId: number;
  nextDeliveryId: number;
}

function defaultState(): MockState {
  return {
    recipients: [],
    reports: [],
    deliveries: [],
    integrations: [],
    dashboardMetrics: {
      atendimento: { conversas_novas: 10, primeira_resposta_min: 5.5, handoff: 2 },
      resultados: { ganhos: 3, ganhos_valor: 15000, perdidos: 1 },
    },
    leaderboardRows: [
      {
        owner_id: "owner-1",
        owner_name: "Maria",
        wins: 3,
        decided: 4,
        win_rate_pct: 75,
        total_won_value: 15000,
      },
    ],
    dashboardRpcCalls: 0,
    leaderboardCalls: 0,
    sendCallCount: 0,
    forceReportInsertConflict: false,
    forceDeliveryConflictFor: new Set(),
    forceDeliveryErrorFor: new Set(),
    suppressedPhones: new Set(),
    sendStatus: 200,
    sendBody: { id: "ext-1" },
    nextReportId: 1,
    nextDeliveryId: 1,
  };
}

function seedRecipient(state: MockState, overrides: Partial<RecipientSeed> = {}): RecipientSeed {
  const recipient: RecipientSeed = {
    id: `rec-${state.recipients.length + 1}`,
    tenant_id: "tenant-1",
    channel: "email",
    address: "gestor@example.com",
    name: "Gestor",
    active: true,
    ...overrides,
  };
  state.recipients.push(recipient);
  return recipient;
}

function router(state: MockState): FetchMatcher {
  return (r) => {
    const sp = new URL(r.url).searchParams;

    // -------- weekly_report_recipients --------
    if (r.pathname === "/rest/v1/weekly_report_recipients" && r.method === "GET") {
      const tenantId = stripOp(sp.get("tenant_id"));
      const rows = tenantId
        ? state.recipients.filter((rec) => rec.tenant_id === tenantId && rec.active)
        : state.recipients.filter((rec) => rec.active);
      return jsonResponse(200, rows);
    }

    // -------- weekly_reports --------
    if (r.pathname === "/rest/v1/weekly_reports" && r.method === "GET") {
      const tenantId = stripOp(sp.get("tenant_id"));
      const periodStart = stripOp(sp.get("period_start"));
      const periodEnd = stripOp(sp.get("period_end"));
      const row = state.reports.find(
        (rep) =>
          rep.tenant_id === tenantId && rep.period_start === periodStart &&
          rep.period_end === periodEnd,
      );
      return jsonResponse(200, row ?? null);
    }
    if (r.pathname === "/rest/v1/weekly_reports" && r.method === "POST") {
      const body = r.bodyJson as Record<string, unknown>;
      if (state.forceReportInsertConflict) {
        return jsonResponse(409, {
          code: "23505",
          message:
            'duplicate key value violates unique constraint "weekly_reports_tenant_id_period_start_period_end_key"',
        });
      }
      // Simula o unique(tenant_id, period_start, period_end) real -- 2ª
      // tentativa de INSERT para a mesma janela bate em 23505.
      const alreadyExists = state.reports.some(
        (rep) =>
          rep.tenant_id === body.tenant_id &&
          rep.period_start === body.period_start &&
          rep.period_end === body.period_end,
      );
      if (alreadyExists) {
        return jsonResponse(409, {
          code: "23505",
          message:
            'duplicate key value violates unique constraint "weekly_reports_tenant_id_period_start_period_end_key"',
        });
      }
      const row: ReportSeed = {
        id: `report-${state.nextReportId++}`,
        tenant_id: body.tenant_id as string,
        period_start: body.period_start as string,
        period_end: body.period_end as string,
        metrics: body.metrics as Record<string, unknown>,
        status: body.status as string,
      };
      state.reports.push(row);
      return jsonResponse(201, row);
    }
    if (r.pathname === "/rest/v1/weekly_reports" && r.method === "PATCH") {
      const id = stripOp(sp.get("id"));
      const row = state.reports.find((rep) => rep.id === id);
      if (row) Object.assign(row, r.bodyJson as Record<string, unknown>);
      return new Response(null, { status: 204 });
    }

    // -------- rpc: dashboard_report_for_tenant --------
    if (r.pathname === "/rest/v1/rpc/dashboard_report_for_tenant" && r.method === "POST") {
      state.dashboardRpcCalls++;
      return jsonResponse(200, state.dashboardMetrics);
    }

    // -------- deal_owner_leaderboard --------
    if (r.pathname === "/rest/v1/deal_owner_leaderboard" && r.method === "GET") {
      state.leaderboardCalls++;
      const tenantId = stripOp(sp.get("tenant_id"));
      return jsonResponse(
        200,
        state.leaderboardRows.filter((row) => !tenantId || row.tenant_id === tenantId || true),
      );
    }

    // -------- weekly_report_deliveries --------
    if (r.pathname === "/rest/v1/weekly_report_deliveries" && r.method === "POST") {
      const body = r.bodyJson as Record<string, unknown>;
      const recipientId = body.recipient_id as string;
      if (state.forceDeliveryErrorFor.has(recipientId)) {
        return jsonResponse(500, { code: "XX000", message: "connection reset by peer" });
      }
      if (state.forceDeliveryConflictFor.has(recipientId)) {
        return jsonResponse(409, {
          code: "23505",
          message:
            'duplicate key value violates unique constraint "weekly_report_deliveries_report_id_recipient_id_key"',
        });
      }
      // Simula o unique(report_id, recipient_id) real -- 2ª tentativa de
      // INSERT para o mesmo par bate em 23505, igual ao Postgres real.
      const alreadyExists = state.deliveries.some(
        (d) => d.report_id === body.report_id && d.recipient_id === recipientId,
      );
      if (alreadyExists) {
        return jsonResponse(409, {
          code: "23505",
          message:
            'duplicate key value violates unique constraint "weekly_report_deliveries_report_id_recipient_id_key"',
        });
      }
      const row: DeliverySeed = {
        id: `delivery-${state.nextDeliveryId++}`,
        report_id: body.report_id as string,
        recipient_id: recipientId,
        channel: body.channel as string,
        address: body.address as string,
        status: body.status as string,
        attempt_count: 0,
      };
      state.deliveries.push(row);
      return jsonResponse(201, row);
    }
    if (r.pathname === "/rest/v1/weekly_report_deliveries" && r.method === "GET") {
      const reportId = stripOp(sp.get("report_id"));
      const recipientId = stripOp(sp.get("recipient_id"));
      const row = state.deliveries.find((d) =>
        d.report_id === reportId && d.recipient_id === recipientId
      );
      return jsonResponse(200, row ?? null);
    }
    if (r.pathname === "/rest/v1/weekly_report_deliveries" && r.method === "HEAD") {
      const reportId = stripOp(sp.get("report_id"));
      const statusFilter = sp.get("status");
      const allowedStatuses = statusFilter ? parseInList(statusFilter) : null;
      const rows = state.deliveries.filter(
        (d) => d.report_id === reportId && (!allowedStatuses || allowedStatuses.includes(d.status)),
      );
      return new Response(null, { status: 200, headers: { "content-range": `*/${rows.length}` } });
    }
    if (r.pathname === "/rest/v1/weekly_report_deliveries" && r.method === "PATCH") {
      const id = stripOp(sp.get("id"));
      // Claim de 2 fases (lote 2, item 5): o runner faz update condicional
      // .eq("id", id).eq("status", "pending") — se a linha não estiver mais em
      // pending, o UPDATE não afeta nada e o `.select().maybeSingle()` deve
      // devolver `null`. Só quem ganha o pending→sending pode enviar.
      const requiredStatus = stripOp(sp.get("status"));
      const row = state.deliveries.find((d) => d.id === id);
      if (!row) return jsonResponse(200, []);
      if (requiredStatus && row.status !== requiredStatus) {
        return jsonResponse(200, []);
      }
      Object.assign(row, r.bodyJson as Record<string, unknown>);
      // Prefer: return=representation → o client espera array de linhas afetadas.
      return jsonResponse(200, [row]);
    }

    // -------- messaging_phone_suppressions --------
    // isPhoneSuppressed (_shared/messaging/conversation.ts) usa .limit(1) sem
    // .maybeSingle(), então a resposta real do PostgREST é sempre um array.
    if (r.pathname === "/rest/v1/messaging_phone_suppressions" && r.method === "GET") {
      const phone = stripOp(sp.get("phone"));
      const suppressed = phone ? state.suppressedPhones.has(phone) : false;
      return jsonResponse(200, suppressed ? [{ id: `sup-${phone}` }] : []);
    }

    // -------- tenant_integrations (whatsapp ativo) --------
    if (r.pathname === "/rest/v1/tenant_integrations" && r.method === "GET") {
      const tenantId = stripOp(sp.get("tenant_id"));
      const slugs = parseInList(sp.get("slug"));
      const row = state.integrations.find(
        (i) => i.tenant_id === tenantId && i.status === "active" && slugs.includes(i.slug),
      );
      return jsonResponse(200, row ?? null);
    }

    // -------- integration_secrets --------
    if (r.pathname === "/rest/v1/integration_secrets" && r.method === "GET") {
      return jsonResponse(200, [
        { key: "api_key", value: "key-1" },
        { key: "from_domain", value: "example.com" },
        { key: "instance_id", value: "inst-1" },
        { key: "instance_token", value: "tok-1" },
        { key: "client_token", value: "ctok-1" },
      ]);
    }

    // -------- envio externo --------
    if (r.url === RESEND_SEND_URL && r.method === "POST") {
      state.sendCallCount++;
      return jsonResponse(state.sendStatus, state.sendBody);
    }
    if (r.url === ZAPI_SEND_URL && r.method === "POST") {
      state.sendCallCount++;
      return jsonResponse(state.sendStatus, state.sendBody);
    }

    return undefined;
  };
}

Deno.test("weekly-digest-generator — runner", async (t) => {
  await t.step(
    "gera relatório novo, envia para o destinatário e marca weekly_reports como sent",
    async () => {
      const state = defaultState();
      seedRecipient(state, { channel: "email", address: "gestor@example.com" });
      state.integrations.push({ tenant_id: "tenant-1", slug: "resend", status: "active" });
      const uninstall = installFetchMock(router(state));
      const admin = newAdminClient();
      try {
        const summary = await runWeeklyDigestGenerator({ admin });
        if (summary.reportsGenerated !== 1 || summary.reportsReused !== 0) {
          throw new Error(`esperava 1 relatório novo, veio ${JSON.stringify(summary)}`);
        }
        if (summary.deliveriesSent !== 1 || summary.deliveriesFailed !== 0) {
          throw new Error(`esperava 1 entrega enviada, veio ${JSON.stringify(summary)}`);
        }
        if (summary.reportsMarkedSent !== 1) {
          throw new Error(`esperava relatório marcado como sent, veio ${JSON.stringify(summary)}`);
        }
        if (state.reports[0].status !== "sent") {
          throw new Error(`weekly_reports.status esperado 'sent', veio ${state.reports[0].status}`);
        }
        if (state.deliveries[0].status !== "sent") {
          throw new Error(
            `weekly_report_deliveries.status esperado 'sent', veio ${state.deliveries[0].status}`,
          );
        }
        if (state.dashboardRpcCalls !== 1 || state.leaderboardCalls !== 1) {
          throw new Error(
            `esperava 1 chamada de métricas, veio dashboard=${state.dashboardRpcCalls} leaderboard=${state.leaderboardCalls}`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "idempotência: 2ª chamada no mesmo período reaproveita o relatório existente sem recalcular métricas",
    async () => {
      const state = defaultState();
      seedRecipient(state);
      state.integrations.push({ tenant_id: "tenant-1", slug: "resend", status: "active" });
      const uninstall = installFetchMock(router(state));
      const admin = newAdminClient();
      try {
        const first = await runWeeklyDigestGenerator({ admin });
        if (first.reportsGenerated !== 1) {
          throw new Error(`1ª chamada deveria gerar 1 relatório: ${JSON.stringify(first)}`);
        }
        if (state.reports.length !== 1) {
          throw new Error("deveria haver exatamente 1 weekly_reports após a 1ª chamada");
        }

        const second = await runWeeklyDigestGenerator({ admin });
        if (second.reportsGenerated !== 0 || second.reportsReused !== 1) {
          throw new Error(
            `2ª chamada deveria reaproveitar o relatório existente: ${JSON.stringify(second)}`,
          );
        }
        if (state.reports.length !== 1) {
          throw new Error(
            `2ª chamada não deveria duplicar weekly_reports, veio ${state.reports.length} linhas`,
          );
        }
        if (state.dashboardRpcCalls !== 1 || state.leaderboardCalls !== 1) {
          throw new Error(
            `2ª chamada não deveria recalcular métricas: dashboard=${state.dashboardRpcCalls} leaderboard=${state.leaderboardCalls}`,
          );
        }
        // Delivery também não deve duplicar (já 'sent' da 1ª chamada) -- 2ª
        // chamada não deveria reenviar (already_terminal).
        if (second.deliveriesSent !== 0 || second.deliveriesFailed !== 0) {
          throw new Error(
            `2ª chamada não deveria reenviar delivery já terminal: ${JSON.stringify(second)}`,
          );
        }
        if (state.deliveries.length !== 1) {
          throw new Error(
            `2ª chamada não deveria duplicar weekly_report_deliveries, veio ${state.deliveries.length}`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "getOrCreateReport: corrida real (23505 no INSERT) busca o relatório que a execução concorrente gravou, não recalcula",
    async () => {
      const state = defaultState();
      const periodStart = "2026-07-01T00:00:00.000Z";
      const periodEnd = "2026-07-08T00:00:00.000Z";
      // Simula: outra execução concorrente já inseriu entre nosso SELECT e
      // nosso INSERT -- a linha já existe no "banco" (state.reports) e nosso
      // INSERT bate no 23505.
      state.reports.push({
        id: "report-winner",
        tenant_id: "tenant-1",
        period_start: periodStart,
        period_end: periodEnd,
        metrics: { dashboard: {}, leaderboard: [] },
        status: "generated",
      });
      state.forceReportInsertConflict = true;
      const uninstall = installFetchMock(router(state));
      const admin = newAdminClient();
      try {
        const { report, wasCreated } = await getOrCreateReport(
          admin,
          "tenant-1",
          periodStart,
          periodEnd,
        );
        if (wasCreated) throw new Error("não deveria marcar como criado quando o INSERT conflita");
        if (report.id !== "report-winner") {
          throw new Error(`esperava o relatório da execução concorrente, veio ${report.id}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "claim de delivery: 23505 no INSERT é idempotente (SELECT da existente, sem reenviar se já terminal)",
    async () => {
      const state = defaultState();
      const recipient = seedRecipient(state, { id: "rec-existing" });
      state.reports.push({
        id: "report-1",
        tenant_id: "tenant-1",
        period_start: "2026-07-01T00:00:00.000Z",
        period_end: "2026-07-08T00:00:00.000Z",
        metrics: { dashboard: {}, leaderboard: [] },
        status: "generated",
      });
      // Delivery já existe e já foi enviada por outra execução -- nosso INSERT
      // bate no 23505 (report_id, recipient_id).
      state.deliveries.push({
        id: "delivery-existing",
        report_id: "report-1",
        recipient_id: recipient.id,
        channel: "email",
        address: recipient.address,
        status: "sent",
        attempt_count: 1,
      });
      state.forceDeliveryConflictFor.add(recipient.id);
      state.integrations.push({ tenant_id: "tenant-1", slug: "resend", status: "active" });
      const uninstall = installFetchMock(router(state));
      const admin = newAdminClient();
      try {
        const summary = await runWeeklyDigestGenerator({ admin });
        if (summary.deliveriesSent !== 0 || summary.deliveriesFailed !== 0) {
          throw new Error(
            `delivery já terminal não deveria contar como enviada/falha nesta rodada: ${
              JSON.stringify(summary)
            }`,
          );
        }
        if (state.sendCallCount !== 0) {
          throw new Error(
            `não deveria chamar o provedor de envio para delivery já terminal, chamadas=${state.sendCallCount}`,
          );
        }
        if (state.deliveries.length !== 1) {
          throw new Error(
            `não deveria criar uma 2ª linha de delivery, veio ${state.deliveries.length}`,
          );
        }
        if (summary.reportsMarkedSent !== 1) {
          throw new Error(
            `relatório com todas as deliveries terminais deveria virar sent: ${
              JSON.stringify(summary)
            }`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "claim de delivery: erro REAL (não-23505) no INSERT propaga e é isolado ao destinatário (não aborta os demais)",
    async () => {
      const state = defaultState();
      const bad = seedRecipient(state, { id: "rec-bad", address: "bad@example.com" });
      const good = seedRecipient(state, { id: "rec-good", address: "good@example.com" });
      state.integrations.push({ tenant_id: "tenant-1", slug: "resend", status: "active" });
      state.forceDeliveryErrorFor.add(bad.id);
      const uninstall = installFetchMock(router(state));
      const admin = newAdminClient();
      try {
        const summary = await runWeeklyDigestGenerator({ admin });
        if (summary.deliveriesSent !== 1) {
          throw new Error(`esperava 1 entrega enviada (rec-good): ${JSON.stringify(summary)}`);
        }
        if (summary.deliveriesFailed !== 1) {
          throw new Error(`esperava 1 entrega falhada (rec-bad): ${JSON.stringify(summary)}`);
        }
        if (!summary.errors.some((e) => e.includes(bad.id))) {
          throw new Error(
            `esperava erro reportado citando ${bad.id}: ${JSON.stringify(summary.errors)}`,
          );
        }
        // rec-good deve ter sido processado normalmente mesmo com rec-bad falhando.
        const goodDelivery = state.deliveries.find((d) => d.recipient_id === good.id);
        if (!goodDelivery || goodDelivery.status !== "sent") {
          throw new Error(
            `rec-good deveria ter sido processado e marcado sent: ${JSON.stringify(goodDelivery)}`,
          );
        }
        // rec-bad nunca chegou a criar uma linha de delivery (o INSERT falhou de verdade).
        const badDelivery = state.deliveries.find((d) => d.recipient_id === bad.id);
        if (badDelivery) {
          throw new Error(
            `rec-bad não deveria ter uma linha de delivery: ${JSON.stringify(badDelivery)}`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "falha no ENVIO (provedor retorna erro) de 1 destinatário não impede os demais; relatório só vira sent quando TODAS terminam",
    async () => {
      const state = defaultState();
      const failing = seedRecipient(state, {
        id: "rec-fail",
        channel: "whatsapp",
        address: "5511999990000",
      });
      const ok = seedRecipient(state, {
        id: "rec-ok",
        channel: "email",
        address: "ok@example.com",
      });
      state.integrations.push({ tenant_id: "tenant-1", slug: "resend", status: "active" });
      // Sem integração de whatsapp ativa para "rec-fail" -- falha isolada
      // (nenhuma integração de whatsapp na lista), não deveria propagar.
      const uninstall = installFetchMock(router(state));
      const admin = newAdminClient();
      try {
        const summary = await runWeeklyDigestGenerator({ admin });
        if (summary.deliveriesSent !== 1) {
          throw new Error(`esperava 1 envio ok: ${JSON.stringify(summary)}`);
        }
        if (summary.deliveriesFailed !== 1) {
          throw new Error(`esperava 1 falha isolada: ${JSON.stringify(summary)}`);
        }
        const failDelivery = state.deliveries.find((d) => d.recipient_id === failing.id);
        if (failDelivery?.status !== "failed") {
          throw new Error(`rec-fail deveria estar marcado failed: ${JSON.stringify(failDelivery)}`);
        }
        const okDelivery = state.deliveries.find((d) => d.recipient_id === ok.id);
        if (okDelivery?.status !== "sent") {
          throw new Error(`rec-ok deveria estar marcado sent: ${JSON.stringify(okDelivery)}`);
        }
        // sent + failed = ambas terminais -> relatório vira 'sent' mesmo com 1 falha
        // (reflete "tentativa concluída", não "100% de sucesso").
        if (summary.reportsMarkedSent !== 1 || state.reports[0].status !== "sent") {
          throw new Error(
            `relatório deveria virar sent (todas terminais): ${JSON.stringify(summary)} / ${
              JSON.stringify(state.reports[0])
            }`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "supressão de telefone bloqueia o envio de WhatsApp (verificação no momento do envio) sem afetar o destinatário de e-mail",
    async () => {
      const state = defaultState();
      const suppressed = seedRecipient(state, {
        id: "rec-suppressed",
        channel: "whatsapp",
        address: "5511999990000",
      });
      const email = seedRecipient(state, {
        id: "rec-email",
        channel: "email",
        address: "gestor@example.com",
      });
      state.integrations.push({ tenant_id: "tenant-1", slug: "zapi", status: "active" });
      state.integrations.push({ tenant_id: "tenant-1", slug: "resend", status: "active" });
      // isPhoneSuppressed usa normalizePhone (adiciona '+' prefixo antes de comparar).
      state.suppressedPhones.add("+5511999990000");
      const uninstall = installFetchMock(router(state));
      const admin = newAdminClient();
      try {
        const summary = await runWeeklyDigestGenerator({ admin });
        // Sem ambiguidade: o destinatário suprimido NUNCA deve chegar a
        // chamar o provedor (bloqueio no momento do envio), e o resultado
        // não pode ser contabilizado como falha de provider (PRD: "não
        // confunda com falha de provider").
        if (summary.deliveriesSkippedSuppressed !== 1) {
          throw new Error(`esperava 1 delivery pulada por supressão: ${JSON.stringify(summary)}`);
        }
        if (summary.deliveriesFailed !== 0) {
          throw new Error(
            `supressão não deveria contar como falha de provider: ${JSON.stringify(summary)}`,
          );
        }
        if (summary.deliveriesSent !== 1) {
          throw new Error(`esperava 1 envio ok (rec-email): ${JSON.stringify(summary)}`);
        }
        // Só a chamada de e-mail (Resend) deveria ter acontecido -- nenhuma
        // chamada ao provedor de WhatsApp (Z-API) para o número suprimido.
        if (state.sendCallCount !== 1) {
          throw new Error(
            `esperava só 1 chamada de envio externo (e-mail), veio ${state.sendCallCount}`,
          );
        }
        const suppressedDelivery = state.deliveries.find((d) => d.recipient_id === suppressed.id);
        if (suppressedDelivery?.status !== "failed") {
          throw new Error(
            `delivery suprimida deveria ficar terminal como 'failed' (schema sem status próprio), veio ${
              JSON.stringify(suppressedDelivery)
            }`,
          );
        }
        const emailDelivery = state.deliveries.find((d) => d.recipient_id === email.id);
        if (emailDelivery?.status !== "sent") {
          throw new Error(
            `destinatário de e-mail não deveria ser afetado pela supressão: ${
              JSON.stringify(emailDelivery)
            }`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "relatório NÃO vira sent enquanto houver delivery não-terminal (pending) de uma execução anterior incompleta",
    async () => {
      const state = defaultState();
      const recipient = seedRecipient(state);
      state.reports.push({
        id: "report-1",
        tenant_id: "tenant-1",
        period_start: "2026-07-01T00:00:00.000Z",
        period_end: "2026-07-08T00:00:00.000Z",
        metrics: { dashboard: {}, leaderboard: [] },
        status: "generated",
      });
      // Delivery do destinatário ativo já 'sent'.
      state.deliveries.push({
        id: "delivery-1",
        report_id: "report-1",
        recipient_id: recipient.id,
        channel: "email",
        address: recipient.address,
        status: "sent",
        attempt_count: 1,
      });
      // Delivery "órfã" de um destinatário que já foi desativado/removido --
      // nunca mais revisitada pelo loop de recipients ativos, mas ainda conta
      // no total de deliveries do relatório -- fica presa em 'pending'.
      state.deliveries.push({
        id: "delivery-orphan",
        report_id: "report-1",
        recipient_id: "rec-removido",
        channel: "email",
        address: "removido@example.com",
        status: "pending",
        attempt_count: 0,
      });
      const uninstall = installFetchMock(router(state));
      const admin = newAdminClient();
      try {
        const summary = await runWeeklyDigestGenerator({ admin });
        if (summary.reportsMarkedSent !== 0) {
          throw new Error(
            `não deveria marcar sent com 1 delivery pendente: ${JSON.stringify(summary)}`,
          );
        }
        if (state.reports[0].status !== "generated") {
          throw new Error(
            `weekly_reports.status deveria continuar 'generated', veio ${state.reports[0].status}`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "computeReportWindow: truncado ao início do dia UTC, janela de 7 dias corridos",
    () => {
      const now = new Date("2026-07-09T15:42:07.123Z");
      const { periodStart, periodEnd } = computeReportWindow(now);
      if (periodEnd !== "2026-07-09T00:00:00.000Z") {
        throw new Error(
          `period_end inesperado: ${periodEnd}`,
        );
      }
      if (periodStart !== "2026-07-02T00:00:00.000Z") {
        throw new Error(
          `period_start inesperado: ${periodStart}`,
        );
      }

      // 2 "agoras" no MESMO dia (minutos de diferença) devem gerar a MESMA
      // janela -- é isso que garante a idempotência via unique(tenant_id,
      // period_start, period_end) mesmo com o cron disparando 2x no dia.
      const later = new Date("2026-07-09T23:59:59.000Z");
      const laterWindow = computeReportWindow(later);
      if (laterWindow.periodStart !== periodStart || laterWindow.periodEnd !== periodEnd) {
        throw new Error(
          `2 chamadas no mesmo dia deveriam gerar a mesma janela: ${
            JSON.stringify({ periodStart, periodEnd })
          } vs ${JSON.stringify(laterWindow)}`,
        );
      }
    },
  );

  await t.step(
    "renderDigestText: inclui métricas de atendimento/resultados e o leaderboard",
    () => {
      const report: WeeklyReportRow = {
        id: "report-1",
        tenant_id: "tenant-1",
        period_start: "2026-07-01T00:00:00.000Z",
        period_end: "2026-07-08T00:00:00.000Z",
        status: "generated",
        metrics: {
          dashboard: {
            atendimento: { conversas_novas: 7, primeira_resposta_min: 3.2, handoff: 1 },
            resultados: { ganhos: 2, ganhos_valor: 8000, perdidos: 0 },
          },
          leaderboard: [
            {
              owner_id: "o1",
              owner_name: "Ana",
              wins: 2,
              decided: 2,
              win_rate_pct: 100,
              total_won_value: 8000,
            },
          ],
        },
      };
      const text = renderDigestText(report);
      if (!text.includes("Conversas novas: 7")) {
        throw new Error(
          `texto sem conversas novas: ${text}`,
        );
      }
      if (!text.includes("Ana")) {
        throw new Error(
          `texto sem o nome do owner do leaderboard: ${text}`,
        );
      }
      if (!text.includes("Negócios ganhos: 2")) throw new Error(`texto sem ganhos: ${text}`);
    },
  );
});
