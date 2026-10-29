// Testa supabase/functions/template-schedule-runner/runner.ts: expansão de
// audience_filter (tags/stage_id, interseção, e o caso crítico de filtro
// vazio NUNCA tocar `contacts`/`deals` sem predicado), claim atômico de
// schedule (geração não dobra em corrida) e de execuções (claim não
// processa 2x), guard de janela de 24h (freeform bloqueado fora da janela,
// provider_approved sempre permitido), supressão (skipped_suppressed, não
// failed), guard de frequência cruzada, envio feliz, e conclusão do
// schedule quando sent+failed+skipped_suppressed cobre 100% do total. Mesmo
// harness Deno (createClient real + installFetchMock) dos arquivos-irmãos
// desta pasta (nurture-runner.test.ts, hitl-sla-monitor.test.ts) — ver
// docs/TESTING.md ("Edge functions (Deno) — deno test"); NÃO um arquivo
// Vitest (vitest.config.ts só cobre src/**, e este módulo importa de esm.sh).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import {
  BASE_ENV,
  captureHandler,
  type FetchMatcher,
  installFetchMock,
  jsonResponse,
  setEnv,
} from "./_helpers.ts";
import {
  AUTOMATED_SEND_DAILY_LIMIT,
  claimExecutions,
  claimScheduleForGeneration,
  expandAudience,
  generateExecutionsForSchedule,
  generatePendingSchedules,
  isFreeformWithinWindow,
  isPhoneSuppressed,
  processClaimedExecutions,
  processExecution,
  refreshScheduleCounts,
  renderTemplateBody,
  runTemplateScheduleRunner,
  type TemplateSchedule,
  type TemplateScheduleExecution,
  reapStaleWork,
  STALE_EXECUTION_MESSAGE,
  UNCERTAIN_DELIVERY_MESSAGE,
} from "../template-schedule-runner/runner.ts";

setEnv(BASE_ENV);

function newAdminClient() {
  return createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const HOUR_MS = 60 * 60 * 1000;
const META_SEND_URL = "https://graph.facebook.com/v23.0/1234567890/messages";

function hoursAgoIso(h: number): string {
  return new Date(Date.now() - h * HOUR_MS).toISOString();
}

function stripOp(raw: string | null): string {
  return raw?.replace(/^[a-z.]+\./, "") ?? "";
}

function parseInList(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .replace(/^in\.\(/, "")
    .replace(/\)$/, "")
    .split(",")
    .filter(Boolean);
}

function parsePgArrayLiteral(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .replace(/^[a-z]+\./, "")
    .replace(/^\{|\}$/g, "")
    .split(",")
    .filter(Boolean);
}

interface ScheduleRow {
  id: string;
  tenant_id: string;
  template_id: string;
  channel_id?: string | null;
  audience_filter: Record<string, unknown>;
  scheduled_for: string;
  status: string;
  sent_count: number;
  failed_count: number;
}

interface ExecutionRow {
  id: string;
  schedule_id: string;
  contact_id: string;
  applied_variables: Record<string, unknown>;
  status: string;
  attempt_count: number;
  scheduled_for: string;
  sent_at: string | null;
  error_message: string | null;
}

interface TemplateRowFixture {
  id: string;
  tenant_id?: string;
  language?: string;
  variables?: string[];
  body: string;
  kind: string;
  provider_template_name: string | null;
  channel_id: string | null;
}

interface ChannelRowFixture {
  id: string;
  tenant_id?: string;
  provider_slug: string;
}

interface ContactRowFixture {
  id: string;
  tenant_id: string;
  name?: string;
  phone: string | null;
  email: string | null;
  tags: string[];
  custom_fields: Record<string, unknown>;
  deleted_at: string | null;
}

interface DealRowFixture {
  tenant_id: string;
  stage_id: string;
  contact_id: string | null;
}

interface MockState {
  schedules: ScheduleRow[];
  executions: ExecutionRow[];
  templates: TemplateRowFixture[];
  channels: ChannelRowFixture[];
  contacts: ContactRowFixture[];
  deals: DealRowFixture[];
  suppressedPhones: Set<string>;
  inboundByContact: Record<string, string[]>; // key `${tenant}:${contact}` -> timestamps ISO
  /** Canal onde está o inbound de inboundByContact (a janela é por canal). */
  inboundChannelId?: string;
  automatedSendsByContact: Record<string, string[]>;
  conversations: Array<{ id: string; tenant_id: string; contact_id: string; channel_id: string }>;
  messageInserts: Record<string, unknown>[];
  sendResponse: { status: number; body: unknown };
}

function defaultState(): MockState {
  return {
    schedules: [],
    executions: [],
    templates: [],
    channels: [],
    contacts: [],
    deals: [],
    suppressedPhones: new Set(),
    inboundByContact: {},
    automatedSendsByContact: {},
    conversations: [],
    messageInserts: [],
    sendResponse: { status: 200, body: { messages: [{ id: "wamid.ext-1" }] } },
  };
}

/** 1 schedule freeform + canal oficial (meta-cloud) + 1 contato tag 'vip'. */
function seedHappyPath(state: MockState, overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  const schedule: ScheduleRow = {
    id: "sched-1",
    tenant_id: "tenant-1",
    template_id: "tmpl-1",
    channel_id: "chan-1",
    audience_filter: { tags: ["vip"] },
    scheduled_for: hoursAgoIso(1),
    status: "pending",
    sent_count: 0,
    failed_count: 0,
    ...overrides,
  };
  state.schedules.push(schedule);
  state.templates.push({
    id: "tmpl-1",
    tenant_id: "tenant-1",
    language: "pt_BR",
    body: "Olá {{nome}}, promoção especial!",
    kind: "freeform",
    provider_template_name: null,
    channel_id: "chan-1",
  });
  state.channels.push({ id: "chan-1", tenant_id: "tenant-1", provider_slug: "meta-cloud" });
  state.contacts.push({
    id: "contact-1",
    tenant_id: "tenant-1",
    name: "Ana",
    phone: "5511999999999",
    email: null,
    tags: ["vip"],
    custom_fields: {},
    deleted_at: null,
  });
  return schedule;
}

function router(state: MockState): FetchMatcher {
  return (r) => {
    const sp = new URL(r.url).searchParams;
    const wantsRepresentation = sp.has("select");

    // ---------------- template_schedules ----------------
    if (r.pathname === "/rest/v1/template_schedules") {
      if (r.method === "PATCH") {
        const idFilter = sp.get("id");
        if (!idFilter) throw new Error(`PATCH template_schedules sem filtro id: ${r.url}`);
        const id = stripOp(idFilter);
        const row = state.schedules.find((s) => s.id === id);
        if (!row) {
          return wantsRepresentation
            ? jsonResponse(200, null)
            : new Response(null, { status: 204 });
        }
        const statusFilter = sp.get("status");
        if (statusFilter && row.status !== stripOp(statusFilter)) {
          // WHERE ... AND status=eq.X não bateu -> claim atômico não pega a linha.
          return wantsRepresentation
            ? jsonResponse(200, null)
            : new Response(null, { status: 204 });
        }
        Object.assign(row, r.bodyJson as Record<string, unknown>);
        return wantsRepresentation
          ? jsonResponse(200, {
            id: row.id,
            tenant_id: row.tenant_id,
            template_id: row.template_id,
            channel_id: row.channel_id ?? null,
            audience_filter: row.audience_filter,
            scheduled_for: row.scheduled_for,
            status: row.status,
          })
          : new Response(null, { status: 204 });
      }
      if (r.method === "GET") {
        const idIn = sp.get("id");
        if (idIn?.startsWith("in.")) {
          const ids = parseInList(idIn);
          return jsonResponse(
            200,
            state.schedules
              .filter((s) => ids.includes(s.id))
              .map((s) => ({
                id: s.id,
                tenant_id: s.tenant_id,
                template_id: s.template_id,
                channel_id: s.channel_id ?? null,
              })),
          );
        }
        const statusFilter = sp.get("status");
        const scheduledFilter = sp.get("scheduled_for");
        if (statusFilter === "eq.running" && scheduledFilter?.startsWith("lt.")) {
          const cutoff = new Date(stripOp(scheduledFilter));
          return jsonResponse(
            200,
            state.schedules
              .filter((s) => s.status === "running" && new Date(s.scheduled_for) < cutoff)
              .map((s) => ({ id: s.id })),
          );
        }
        if (statusFilter === "eq.pending" && scheduledFilter?.startsWith("lte.")) {
          const cutoff = new Date(stripOp(scheduledFilter));
          return jsonResponse(
            200,
            state.schedules.filter((s) =>
              s.status === "pending" && new Date(s.scheduled_for) <= cutoff
            ).map((s) => ({ id: s.id })),
          );
        }
        throw new Error(`GET template_schedules inesperado: ${r.url}`);
      }
    }

    // ---------------- template_schedule_executions ----------------
    if (r.pathname === "/rest/v1/template_schedule_executions") {
      if (r.method === "POST") {
        const body = r.bodyJson as Array<Partial<ExecutionRow>> | Partial<ExecutionRow>;
        const rows = Array.isArray(body) ? body : [body];
        for (const row of rows) {
          state.executions.push({
            id: `exec-${state.executions.length + 1}`,
            applied_variables: {},
            attempt_count: 0,
            sent_at: null,
            error_message: null,
            ...row,
          } as ExecutionRow);
        }
        return new Response(null, { status: 201 });
      }
      if (r.method === "PATCH") {
        const idFilter = sp.get("id");
        if (idFilter) {
          const id = stripOp(idFilter);
          const row = state.executions.find((e) => e.id === id);
          if (!row) return new Response(null, { status: 204 });
          Object.assign(row, r.bodyJson as Record<string, unknown>);
          return new Response(null, { status: 204 });
        }
        // Reaper: status=eq.sending & last_attempt_at=lt.X -> failed incerto.
        if (sp.get("status") === "eq.sending" && sp.get("last_attempt_at")?.startsWith("lt.")) {
          const cutoff = new Date(stripOp(sp.get("last_attempt_at")));
          const stale = state.executions.filter(
            (e) =>
              e.status === "sending" &&
              new Date((e as ExecutionRow & { last_attempt_at?: string }).last_attempt_at ?? 0) < cutoff,
          );
          for (const e of stale) Object.assign(e, r.bodyJson as Record<string, unknown>);
          return jsonResponse(200, stale.map((e) => ({ schedule_id: e.schedule_id })));
        }
        // Claim: status=eq.pending & scheduled_for=lte.X, com .select() (array).
        // .order()+.limit() simulam o "limited update" real do PostgREST --
        // ordena pelas mais vencidas primeiro e trunca no limite pedido.
        const statusFilter = sp.get("status");
        const scheduledFilter = sp.get("scheduled_for");
        if (statusFilter !== "eq.pending" || !scheduledFilter?.startsWith("lte.")) {
          throw new Error(`PATCH template_schedule_executions (claim) inesperado: ${r.url}`);
        }
        const cutoff = new Date(stripOp(scheduledFilter));
        const limit = Number(sp.get("limit") ?? "50");
        const claimed = state.executions
          .filter((e) => e.status === "pending" && new Date(e.scheduled_for) <= cutoff)
          .sort((a, b) => new Date(a.scheduled_for).getTime() - new Date(b.scheduled_for).getTime())
          .slice(0, limit);
        for (const e of claimed) e.status = "sending";
        return jsonResponse(200, claimed.map((e) => ({ ...e })));
      }
      if (r.method === "GET") {
        // Contagens (refreshScheduleCounts) usam HEAD; GET puro não é usado
        // neste runner para esta tabela.
        throw new Error(`GET template_schedule_executions inesperado: ${r.url}`);
      }
      if (r.method === "HEAD") {
        const scheduleId = stripOp(sp.get("schedule_id"));
        const statusFilter = sp.get("status");
        const rows = state.executions.filter(
          (e) =>
            e.schedule_id === scheduleId && (!statusFilter || e.status === stripOp(statusFilter)),
        );
        return new Response(null, {
          status: 200,
          headers: { "content-range": `*/${rows.length}` },
        });
      }
    }

    // ---------------- messaging_templates ----------------
    if (r.pathname === "/rest/v1/messaging_templates" && r.method === "GET") {
      const idIn = sp.get("id");
      const ids = parseInList(idIn);
      return jsonResponse(200, state.templates.filter((t) => ids.includes(t.id)));
    }

    // ---------------- channels ----------------
    if (r.pathname === "/rest/v1/channels" && r.method === "GET") {
      const idIn = sp.get("id");
      const ids = parseInList(idIn);
      return jsonResponse(200, state.channels.filter((c) => ids.includes(c.id)));
    }

    // ---------------- contacts ----------------
    if (r.pathname === "/rest/v1/contacts" && r.method === "GET") {
      const idIn = sp.get("id");
      if (idIn?.startsWith("in.")) {
        const ids = parseInList(idIn);
        return jsonResponse(
          200,
          state.contacts.filter((c) => ids.includes(c.id) && !c.deleted_at).map((c) => ({
            id: c.id,
            name: c.name ?? null,
            phone: c.phone,
            email: c.email,
            custom_fields: c.custom_fields,
          })),
        );
      }
      const tenantId = stripOp(sp.get("tenant_id"));
      const tagsParam = sp.get("tags");
      const customFieldParam = sp.get("custom_fields");
      if (tagsParam) {
        const wanted = parsePgArrayLiteral(tagsParam);
        const rows = state.contacts.filter(
          (c) =>
            c.tenant_id === tenantId && !c.deleted_at && c.tags.some((t) => wanted.includes(t)),
        );
        return jsonResponse(200, rows.map((c) => ({ id: c.id })));
      }
      if (customFieldParam) {
        const wanted = JSON.parse(customFieldParam.replace(/^cs\./, "")) as Record<string, unknown>;
        const rows = state.contacts.filter(
          (c) =>
            c.tenant_id === tenantId &&
            !c.deleted_at &&
            Object.entries(wanted).every(([k, v]) => c.custom_fields?.[k] === v),
        );
        return jsonResponse(200, rows.map((c) => ({ id: c.id })));
      }
      throw new Error(
        `GET contacts inesperado (audience expansion sem filtro reconhecido chegou até aqui?): ${r.url}`,
      );
    }

    // ---------------- deals (expansão por stage_id) ----------------
    if (r.pathname === "/rest/v1/deals" && r.method === "GET") {
      const tenantId = stripOp(sp.get("tenant_id"));
      const stageId = stripOp(sp.get("stage_id"));
      const rows = state.deals.filter((d) =>
        d.tenant_id === tenantId && d.stage_id === stageId && d.contact_id
      );
      return jsonResponse(200, rows.map((d) => ({ contact_id: d.contact_id })));
    }

    // ---------------- messaging_phone_suppressions ----------------
    // isPhoneSuppressed (_shared/messaging/conversation.ts) usa .limit(1) sem
    // .maybeSingle(), então a resposta real do PostgREST é sempre um array.
    if (r.pathname === "/rest/v1/messaging_phone_suppressions" && r.method === "GET") {
      const phone = stripOp(sp.get("phone"));
      const suppressed = state.suppressedPhones.has(phone);
      return jsonResponse(200, suppressed ? [{ id: `sup-${phone}` }] : []);
    }

    // ---------------- messages: GET (guard de 24h) vs HEAD (guard de frequência) ----------------
    if (r.pathname === "/rest/v1/messages") {
      if (r.method === "GET") {
        const direction = sp.get("direction");
        const tenantId = stripOp(sp.get("conversations.tenant_id"));
        const contactId = stripOp(sp.get("conversations.contact_id"));
        const sinceIso = stripOp(sp.get("created_at"));
        const channelId = stripOp(sp.get("conversations.channel_id"));
        if (!channelId) throw new Error(`janela de 24h sem filtro de canal: ${r.url}`);
        if (state.inboundChannelId && state.inboundChannelId !== channelId) {
          return jsonResponse(200, []);
        }
        if (direction !== "eq.in") {
          throw new Error(`GET messages (janela 24h) sem direction=eq.in: ${r.url}`);
        }
        const since = new Date(sinceIso);
        const inbound = (state.inboundByContact[`${tenantId}:${contactId}`] ?? []).filter(
          (iso) => new Date(iso) >= since,
        );
        return jsonResponse(200, inbound.map((iso) => ({ id: `msg-${iso}` })));
      }
      if (r.method === "HEAD") {
        // Guard de frequência cruzada só deve contar sender='automation' com
        // status='sent' (entregas confirmadas, não tentativas) -- se o filtro
        // de status sumir da query real, este throw pega a regressão.
        if (sp.get("status") !== "eq.sent") {
          throw new Error(
            `HEAD messages (countRecentAutomatedSends) esperava status=eq.sent, veio ${
              sp.get("status")
            }`,
          );
        }
        const tenantId = stripOp(sp.get("conversations.tenant_id"));
        const contactId = stripOp(sp.get("conversations.contact_id"));
        const sinceIso = stripOp(sp.get("created_at"));
        const since = new Date(sinceIso);
        const sends = (state.automatedSendsByContact[`${tenantId}:${contactId}`] ?? []).filter(
          (iso) => new Date(iso) >= since,
        );
        return new Response(null, {
          status: 200,
          headers: { "content-range": `*/${sends.length}` },
        });
      }
      if (r.method === "POST") {
        const body = r.bodyJson as Record<string, unknown>;
        state.messageInserts.push(body);
        return new Response(null, { status: 201 });
      }
    }

    // ---------------- conversations: find-or-create ----------------
    if (r.pathname === "/rest/v1/conversations") {
      if (r.method === "GET") {
        const tenantId = stripOp(sp.get("tenant_id"));
        const contactId = stripOp(sp.get("contact_id"));
        const channelId = stripOp(sp.get("channel_id"));
        const existing = state.conversations.find(
          (c) =>
            c.tenant_id === tenantId && c.contact_id === contactId && c.channel_id === channelId,
        );
        return jsonResponse(200, existing ? { id: existing.id } : null);
      }
      if (r.method === "POST") {
        const body = r.bodyJson as { tenant_id: string; contact_id: string; channel_id: string };
        const created = { id: `conv-${state.conversations.length + 1}`, ...body };
        state.conversations.push(created);
        return jsonResponse(201, { id: created.id });
      }
      if (r.method === "PATCH") return new Response(null, { status: 204 });
    }

    // ---------------- integration_secrets ----------------
    if (r.pathname === "/rest/v1/integration_secrets" && r.method === "GET") {
      return jsonResponse(200, [
        { key: "access_token", value: "token-1" },
        { key: "phone_number_id", value: "1234567890" },
      ]);
    }

    // ---------------- envio externo (meta-cloud) ----------------
    if (r.url === META_SEND_URL && r.method === "POST") {
      return jsonResponse(state.sendResponse.status, state.sendResponse.body);
    }

    return undefined;
  };
}

// ==================================================================
// renderTemplateBody (pura, sem I/O)
// ==================================================================
Deno.test("renderTemplateBody", async (t) => {
  await t.step("substitui {{variavel}} presente em applied_variables", () => {
    const out = renderTemplateBody("Olá {{nome}}, vencendo {{parcela}}.", {
      nome: "Maria",
      parcela: "3ª",
    });
    if (out !== "Olá Maria, vencendo 3ª.") throw new Error(`inesperado: ${out}`);
  });

  await t.step("placeholder sem valor correspondente é mantido literal", () => {
    const out = renderTemplateBody("Olá {{nome}}!", {});
    if (out !== "Olá {{nome}}!") throw new Error(`inesperado: ${out}`);
  });

  await t.step("applied_variables null não lança", () => {
    const out = renderTemplateBody("Sem variáveis aqui.", null);
    if (out !== "Sem variáveis aqui.") throw new Error(`inesperado: ${out}`);
  });
});

// ==================================================================
// expandAudience
// ==================================================================
Deno.test("expandAudience", async (t) => {
  await t.step("filtro por tags: retorna só contatos com overlap", async () => {
    const state = defaultState();
    state.contacts.push(
      {
        id: "c1",
        tenant_id: "t1",
        phone: null,
        email: null,
        tags: ["vip"],
        custom_fields: {},
        deleted_at: null,
      },
      {
        id: "c2",
        tenant_id: "t1",
        phone: null,
        email: null,
        tags: ["frio"],
        custom_fields: {},
        deleted_at: null,
      },
    );
    const uninstall = installFetchMock(router(state));
    try {
      const ids = await expandAudience(newAdminClient(), "t1", { tags: ["vip"] });
      if (JSON.stringify(ids) !== JSON.stringify(["c1"])) {
        throw new Error(`inesperado: ${JSON.stringify(ids)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("filtro por stage_id: expande via deals.contact_id", async () => {
    const state = defaultState();
    state.deals.push(
      { tenant_id: "t1", stage_id: "stage-a", contact_id: "c1" },
      { tenant_id: "t1", stage_id: "stage-b", contact_id: "c2" },
    );
    const uninstall = installFetchMock(router(state));
    try {
      const ids = await expandAudience(newAdminClient(), "t1", { stage_id: "stage-a" });
      if (JSON.stringify(ids) !== JSON.stringify(["c1"])) {
        throw new Error(`inesperado: ${JSON.stringify(ids)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("tags + stage_id presentes: interseção (AND), não união", async () => {
    const state = defaultState();
    state.contacts.push(
      {
        id: "c1",
        tenant_id: "t1",
        phone: null,
        email: null,
        tags: ["vip"],
        custom_fields: {},
        deleted_at: null,
      },
      {
        id: "c2",
        tenant_id: "t1",
        phone: null,
        email: null,
        tags: ["vip"],
        custom_fields: {},
        deleted_at: null,
      },
    );
    state.deals.push({ tenant_id: "t1", stage_id: "stage-a", contact_id: "c1" });
    const uninstall = installFetchMock(router(state));
    try {
      const ids = await expandAudience(newAdminClient(), "t1", {
        tags: ["vip"],
        stage_id: "stage-a",
      });
      if (JSON.stringify(ids) !== JSON.stringify(["c1"])) {
        throw new Error(`esperava só c1 (interseção), veio ${JSON.stringify(ids)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "audience_filter vazio: retorna [] SEM tocar contacts/deals (nunca manda pra base toda)",
    async () => {
      const state = defaultState();
      state.contacts.push({
        id: "c1",
        tenant_id: "t1",
        phone: null,
        email: null,
        tags: [],
        custom_fields: {},
        deleted_at: null,
      });
      const uninstall = installFetchMock((req) => {
        if (req.pathname === "/rest/v1/contacts" || req.pathname === "/rest/v1/deals") {
          throw new Error(
            `expandAudience NÃO deveria consultar ${req.pathname} sem filtro reconhecido`,
          );
        }
        return router(state)(req);
      });
      try {
        const ids = await expandAudience(newAdminClient(), "t1", {});
        if (ids.length !== 0) throw new Error(`esperava [], veio ${JSON.stringify(ids)}`);
      } finally {
        uninstall();
      }
    },
  );
});

// ==================================================================
// claimScheduleForGeneration — corrida na geração
// ==================================================================
Deno.test("claimScheduleForGeneration", async (t) => {
  await t.step("2 chamadas concorrentes para o mesmo schedule: só 1 reivindica", async () => {
    const state = defaultState();
    seedHappyPath(state);
    const uninstall = installFetchMock(router(state));
    try {
      const first = await claimScheduleForGeneration(newAdminClient(), "sched-1");
      if (!first || first.status !== "running") {
        throw new Error(`1ª claim deveria retornar running, veio ${JSON.stringify(first)}`);
      }

      const second = await claimScheduleForGeneration(newAdminClient(), "sched-1");
      if (second !== null) {
        throw new Error(
          `2ª claim concorrente deveria retornar null, veio ${JSON.stringify(second)}`,
        );
      }
    } finally {
      uninstall();
    }
  });
});

// ==================================================================
// generateExecutionsForSchedule
// ==================================================================
Deno.test("generateExecutionsForSchedule", async (t) => {
  await t.step(
    "audience_filter sem filtro reconhecido: marca schedule 'failed', não insere execuções",
    async () => {
      const state = defaultState();
      const schedule = seedHappyPath(state, { audience_filter: {}, status: "running" });
      const uninstall = installFetchMock(router(state));
      try {
        const result = await generateExecutionsForSchedule(
          newAdminClient(),
          schedule as TemplateSchedule,
        );
        if (!result.failed || result.generated !== 0) {
          throw new Error(`inesperado: ${JSON.stringify(result)}`);
        }
        if (state.executions.length !== 0) {
          throw new Error("não deveria ter inserido execução nenhuma");
        }
        if (state.schedules[0].status !== "failed") {
          throw new Error(`schedule deveria estar failed, veio ${state.schedules[0].status}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "audience_filter por tags: gera 1 execução pendente por contato, com scheduled_for do schedule",
    async () => {
      const state = defaultState();
      const schedule = seedHappyPath(state, { status: "running" });
      state.contacts.push({
        id: "contact-2",
        tenant_id: "tenant-1",
        phone: "5511988888888",
        email: null,
        tags: ["vip"],
        custom_fields: {},
        deleted_at: null,
      });
      const uninstall = installFetchMock(router(state));
      try {
        const result = await generateExecutionsForSchedule(
          newAdminClient(),
          schedule as TemplateSchedule,
        );
        if (result.failed || result.generated !== 2) {
          throw new Error(`inesperado: ${JSON.stringify(result)}`);
        }
        if (state.executions.length !== 2) {
          throw new Error(`esperava 2 execuções, veio ${state.executions.length}`);
        }
        for (const e of state.executions) {
          if (e.status !== "pending") {
            throw new Error(`execução deveria nascer pending, veio ${e.status}`);
          }
          if (e.scheduled_for !== schedule.scheduled_for) {
            throw new Error("scheduled_for da execução deveria herdar do schedule");
          }
        }
      } finally {
        uninstall();
      }
    },
  );
});

// ==================================================================
// generatePendingSchedules — integra claim + geração
// ==================================================================
Deno.test("generatePendingSchedules", async (t) => {
  await t.step("gera execuções para schedule pending vencido e marca running", async () => {
    const state = defaultState();
    seedHappyPath(state);
    const uninstall = installFetchMock(router(state));
    try {
      const result = await generatePendingSchedules(newAdminClient());
      if (result.generated !== 1 || result.failedSchedules !== 0) {
        throw new Error(`inesperado: ${JSON.stringify(result)}`);
      }
      if (state.schedules[0].status !== "running") {
        throw new Error(`schedule deveria estar running, veio ${state.schedules[0].status}`);
      }
      if (state.executions.length !== 1) {
        throw new Error(`esperava 1 execução gerada, veio ${state.executions.length}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("schedule ainda não vencido (scheduled_for no futuro) não é gerado", async () => {
    const state = defaultState();
    seedHappyPath(state, { scheduled_for: new Date(Date.now() + HOUR_MS).toISOString() });
    const uninstall = installFetchMock(router(state));
    try {
      const result = await generatePendingSchedules(newAdminClient());
      if (result.generated !== 0) {
        throw new Error(`não deveria gerar nada ainda, veio ${JSON.stringify(result)}`);
      }
      if (state.schedules[0].status !== "pending") {
        throw new Error("schedule não deveria ter mudado de status");
      }
    } finally {
      uninstall();
    }
  });
});

// ==================================================================
// claimExecutions — claim não processa 2x
// ==================================================================
Deno.test("claimExecutions", async (t) => {
  await t.step("2 chamadas sequenciais: a 2ª não reivindica o que a 1ª já pegou", async () => {
    const state = defaultState();
    seedHappyPath(state);
    state.executions.push({
      id: "exec-1",
      schedule_id: "sched-1",
      contact_id: "contact-1",
      applied_variables: {},
      status: "pending",
      attempt_count: 0,
      scheduled_for: hoursAgoIso(1),
      sent_at: null,
      error_message: null,
    });
    const uninstall = installFetchMock(router(state));
    try {
      const first = await claimExecutions(newAdminClient());
      if (first.length !== 1) {
        throw new Error(`1ª chamada deveria reivindicar 1, veio ${first.length}`);
      }
      if (state.executions[0].status !== "sending") {
        throw new Error("estado deveria ter virado sending");
      }

      const second = await claimExecutions(newAdminClient());
      if (second.length !== 0) {
        throw new Error(`2ª chamada não deveria reivindicar nada, veio ${second.length}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "respeita o limite passado, mesmo com mais pendentes vencidas do que o limite",
    async () => {
      const state = defaultState();
      seedHappyPath(state);
      state.executions.push(
        {
          id: "exec-1",
          schedule_id: "sched-1",
          contact_id: "contact-1",
          applied_variables: {},
          status: "pending",
          attempt_count: 0,
          scheduled_for: hoursAgoIso(3),
          sent_at: null,
          error_message: null,
        },
        {
          id: "exec-2",
          schedule_id: "sched-1",
          contact_id: "contact-1",
          applied_variables: {},
          status: "pending",
          attempt_count: 0,
          scheduled_for: hoursAgoIso(2),
          sent_at: null,
          error_message: null,
        },
        {
          id: "exec-3",
          schedule_id: "sched-1",
          contact_id: "contact-1",
          applied_variables: {},
          status: "pending",
          attempt_count: 0,
          scheduled_for: hoursAgoIso(1),
          sent_at: null,
          error_message: null,
        },
      );
      const uninstall = installFetchMock(router(state));
      try {
        const claimed = await claimExecutions(newAdminClient(), { limit: 2 });
        if (claimed.length !== 2) {
          throw new Error(
            `esperava reivindicar 2 (limite), veio ${claimed.length}`,
          );
        }
        const stillPending = state.executions.filter((e) => e.status === "pending");
        if (stillPending.length !== 1) {
          throw new Error(
            `esperava 1 execução ainda pending (excedente do limite), veio ${stillPending.length}`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );
});

// ==================================================================
// isFreeformWithinWindow
// ==================================================================
Deno.test("isFreeformWithinWindow", async (t) => {
  await t.step("mensagem inbound recente (dentro de 24h): true", async () => {
    const state = defaultState();
    state.inboundByContact["tenant-1:contact-1"] = [hoursAgoIso(2)];
    const uninstall = installFetchMock(router(state));
    try {
      const within = await isFreeformWithinWindow(newAdminClient(), "tenant-1", "contact-1", "chan-1");
      if (!within) throw new Error("esperava true (inbound há 2h)");
    } finally {
      uninstall();
    }
  });

  await t.step("última mensagem inbound há mais de 24h: false", async () => {
    const state = defaultState();
    state.inboundByContact["tenant-1:contact-1"] = [hoursAgoIso(30)];
    const uninstall = installFetchMock(router(state));
    try {
      const within = await isFreeformWithinWindow(newAdminClient(), "tenant-1", "contact-1", "chan-1");
      if (within) throw new Error("esperava false (inbound há 30h)");
    } finally {
      uninstall();
    }
  });

  await t.step("nenhuma mensagem inbound: false", async () => {
    const state = defaultState();
    const uninstall = installFetchMock(router(state));
    try {
      const within = await isFreeformWithinWindow(newAdminClient(), "tenant-1", "contact-1", "chan-1");
      if (within) throw new Error("esperava false (nunca houve inbound)");
    } finally {
      uninstall();
    }
  });
});

// ==================================================================
// isPhoneSuppressed
// ==================================================================
Deno.test("isPhoneSuppressed", async (t) => {
  await t.step("telefone suprimido: true", async () => {
    const state = defaultState();
    state.suppressedPhones.add("+5511999999999");
    const uninstall = installFetchMock(router(state));
    try {
      if (!(await isPhoneSuppressed(newAdminClient(), "tenant-1", "5511999999999"))) {
        throw new Error("esperava true");
      }
    } finally {
      uninstall();
    }
  });

  await t.step("telefone não suprimido: false", async () => {
    const state = defaultState();
    const uninstall = installFetchMock(router(state));
    try {
      if (await isPhoneSuppressed(newAdminClient(), "tenant-1", "5511999999999")) {
        throw new Error("esperava false");
      }
    } finally {
      uninstall();
    }
  });

  await t.step("sem telefone: false, sem consultar o banco", async () => {
    const uninstall = installFetchMock(() => {
      throw new Error("não deveria consultar messaging_phone_suppressions sem telefone");
    });
    try {
      if (await isPhoneSuppressed(newAdminClient(), "tenant-1", null)) {
        throw new Error("esperava false");
      }
    } finally {
      uninstall();
    }
  });
});

// ==================================================================
// processExecution — guards + envio
// ==================================================================
function baseExecution(
  overrides: Partial<TemplateScheduleExecution> = {},
): TemplateScheduleExecution {
  return {
    id: "exec-1",
    schedule_id: "sched-1",
    contact_id: "contact-1",
    applied_variables: { nome: "Maria" },
    status: "sending",
    attempt_count: 0,
    scheduled_for: hoursAgoIso(1),
    ...overrides,
  } as TemplateScheduleExecution;
}

const CTX_FREEFORM_OFFICIAL = {
  tenantId: "tenant-1",
  template: {
    id: "tmpl-1",
    body: "Olá {{nome}}!",
    kind: "freeform",
    provider_template_name: null,
    channel_id: "chan-1",
  },
  channel: { id: "chan-1", provider_slug: "meta-cloud" },
  contact: { id: "contact-1", phone: "5511999999999", email: null },
};

Deno.test("processExecution — guard de janela de 24h", async (t) => {
  await t.step("freeform + provider oficial + FORA da janela: bloqueia, não envia", async () => {
    const state = defaultState();
    state.executions.push({
      id: "exec-1",
      schedule_id: "sched-1",
      contact_id: "contact-1",
      applied_variables: {},
      status: "sending",
      attempt_count: 0,
      scheduled_for: hoursAgoIso(1),
      sent_at: null,
      error_message: null,
    });
    // Sem inboundByContact seedado -> nunca houve inbound -> fora da janela.
    const uninstall = installFetchMock((req) => {
      if (req.url === META_SEND_URL) {
        throw new Error("NÃO deveria enviar: guard de 24h deveria ter bloqueado");
      }
      return router(state)(req);
    });
    try {
      const outcome = await processExecution(
        newAdminClient(),
        baseExecution(),
        CTX_FREEFORM_OFFICIAL,
      );
      if (outcome !== "failed") throw new Error(`esperava failed, veio ${outcome}`);
      const row = state.executions[0];
      if (row.status !== "failed") throw new Error(`estado deveria ser failed, veio ${row.status}`);
      if (!row.error_message?.includes("janela de 24h")) {
        throw new Error(`error_message deveria mencionar a janela de 24h: ${row.error_message}`);
      }
      if (state.messageInserts.length !== 0) {
        throw new Error("não deveria ter logado mensagem nenhuma");
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "provider_approved + provider oficial + FORA da janela: permitido, envia mesmo assim",
    async () => {
      const state = defaultState();
      state.executions.push({
        id: "exec-1",
        schedule_id: "sched-1",
        contact_id: "contact-1",
        applied_variables: {},
        status: "sending",
        attempt_count: 0,
        scheduled_for: hoursAgoIso(1),
        sent_at: null,
        error_message: null,
      });
      const ctx = {
        ...CTX_FREEFORM_OFFICIAL,
        template: {
          ...CTX_FREEFORM_OFFICIAL.template,
          kind: "provider_approved",
          provider_template_name: "promo_aprovado",
        },
      };
      const uninstall = installFetchMock(router(state));
      try {
        const outcome = await processExecution(newAdminClient(), baseExecution(), ctx);
        if (outcome !== "sent") throw new Error(`esperava sent (bypass do guard), veio ${outcome}`);
        if (state.executions[0].status !== "sent") {
          throw new Error(`estado deveria ser sent, veio ${state.executions[0].status}`);
        }
      } finally {
        uninstall();
      }
    },
  );
});

Deno.test("processExecution — supressão, frequência, guards de dados ausentes e envio feliz", async (t) => {
  await t.step("contato suprimido: skipped_suppressed, nunca failed, nunca envia", async () => {
    const state = defaultState();
    state.executions.push({
      id: "exec-1",
      schedule_id: "sched-1",
      contact_id: "contact-1",
      applied_variables: {},
      status: "sending",
      attempt_count: 0,
      scheduled_for: hoursAgoIso(1),
      sent_at: null,
      error_message: null,
    });
    state.suppressedPhones.add("+5511999999999");
    state.inboundByContact["tenant-1:contact-1"] = [hoursAgoIso(1)]; // dentro da janela, não é isso que bloqueia
    const uninstall = installFetchMock((req) => {
      if (req.url === META_SEND_URL) throw new Error("supressão não deveria tentar enviar");
      return router(state)(req);
    });
    try {
      const outcome = await processExecution(
        newAdminClient(),
        baseExecution(),
        CTX_FREEFORM_OFFICIAL,
      );
      if (outcome !== "skipped_suppressed") {
        throw new Error(`esperava skipped_suppressed, veio ${outcome}`);
      }
      if (state.executions[0].status !== "skipped_suppressed") {
        throw new Error(
          `estado deveria ser skipped_suppressed (NUNCA failed), veio ${
            state.executions[0].status
          }`,
        );
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "guard de frequência atingido: defer (skipped_suppressed) até MAX_DEFER, depois failed",
    async () => {
      // Lote 2, item 7: frequência agora adia em +6h (status='pending', outcome
      // 'skipped_suppressed') em vez de falhar terminal; só vira 'failed' após
      // MAX_DEFER_ATTEMPTS (5) tentativas.
      const state = defaultState();
      state.executions.push({
        id: "exec-1",
        schedule_id: "sched-1",
        contact_id: "contact-1",
        applied_variables: {},
        status: "sending",
        attempt_count: 0,
        scheduled_for: hoursAgoIso(1),
        sent_at: null,
        error_message: null,
      });
      state.inboundByContact["tenant-1:contact-1"] = [hoursAgoIso(1)];
      state.automatedSendsByContact["tenant-1:contact-1"] = Array.from({
        length: AUTOMATED_SEND_DAILY_LIMIT,
      }, () => hoursAgoIso(1));
      const uninstall = installFetchMock((req) => {
        if (req.url === META_SEND_URL) {
          throw new Error("guard de frequência não deveria tentar enviar");
        }
        return router(state)(req);
      });
      try {
        // 1ª tentativa: adia
        let outcome = await processExecution(
          newAdminClient(),
          baseExecution(),
          CTX_FREEFORM_OFFICIAL,
        );
        if (outcome !== "skipped_suppressed") {
          throw new Error(`esperava skipped_suppressed (defer), veio ${outcome}`);
        }
        if (state.executions[0].status !== "pending") {
          throw new Error(`esperava status=pending após defer, veio ${state.executions[0].status}`);
        }
        if (!state.executions[0].error_message?.includes("adiado")) {
          throw new Error(
            `error_message inesperado no defer: ${state.executions[0].error_message}`,
          );
        }
        // Simula 5ª tentativa (attempt_count=4 → nextAttempt=5 ≥ MAX_DEFER_ATTEMPTS)
        state.executions[0].attempt_count = 4;
        state.executions[0].status = "sending";
        outcome = await processExecution(
          newAdminClient(),
          baseExecution({ attempt_count: 4 }),
          CTX_FREEFORM_OFFICIAL,
        );
        if (outcome !== "failed") throw new Error(`esperava failed no teto, veio ${outcome}`);
        if (!state.executions[0].error_message?.includes("desistindo")) {
          throw new Error(`error_message inesperado no teto: ${state.executions[0].error_message}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("canal ausente (template sem channel_id): failed com mensagem clara", async () => {
    const state = defaultState();
    state.executions.push({
      id: "exec-1",
      schedule_id: "sched-1",
      contact_id: "contact-1",
      applied_variables: {},
      status: "sending",
      attempt_count: 0,
      scheduled_for: hoursAgoIso(1),
      sent_at: null,
      error_message: null,
    });
    const ctx = { ...CTX_FREEFORM_OFFICIAL, channel: null };
    const uninstall = installFetchMock(router(state));
    try {
      const outcome = await processExecution(newAdminClient(), baseExecution(), ctx);
      if (outcome !== "failed") throw new Error(`esperava failed, veio ${outcome}`);
      if (!state.executions[0].error_message?.includes("canal")) {
        throw new Error(
          `error_message deveria mencionar canal ausente: ${state.executions[0].error_message}`,
        );
      }
    } finally {
      uninstall();
    }
  });

  await t.step("contato ausente: failed com mensagem clara", async () => {
    const state = defaultState();
    state.executions.push({
      id: "exec-1",
      schedule_id: "sched-1",
      contact_id: "contact-1",
      applied_variables: {},
      status: "sending",
      attempt_count: 0,
      scheduled_for: hoursAgoIso(1),
      sent_at: null,
      error_message: null,
    });
    const ctx = { ...CTX_FREEFORM_OFFICIAL, contact: null };
    const uninstall = installFetchMock(router(state));
    try {
      const outcome = await processExecution(newAdminClient(), baseExecution(), ctx);
      if (outcome !== "failed") throw new Error(`esperava failed, veio ${outcome}`);
      if (!state.executions[0].error_message?.includes("Contato")) {
        throw new Error(
          `error_message deveria mencionar contato ausente: ${state.executions[0].error_message}`,
        );
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "caminho feliz: envia, cria conversa, loga mensagem, marca execução sent",
    async () => {
      // NOTA: applied_variables preenchido aqui à mão testa a substituição de
      // renderTemplateBody (a "fiação" do processExecution) — NÃO afirma que a
      // geração real produz execuções assim. A geração real sempre insere
      // applied_variables='{}' (ver runTemplateScheduleRunner > "fluxo
      // completo", que exercita o caminho de ponta a ponta e prova o content
      // literal sem substituição).
      const state = defaultState();
      state.executions.push({
        id: "exec-1",
        schedule_id: "sched-1",
        contact_id: "contact-1",
        applied_variables: { nome: "Maria" },
        status: "sending",
        attempt_count: 0,
        scheduled_for: hoursAgoIso(1),
        sent_at: null,
        error_message: null,
      });
      state.inboundByContact["tenant-1:contact-1"] = [hoursAgoIso(1)];
      const uninstall = installFetchMock(router(state));
      try {
        const outcome = await processExecution(
          newAdminClient(),
          baseExecution(),
          CTX_FREEFORM_OFFICIAL,
        );
        if (outcome !== "sent") throw new Error(`esperava sent, veio ${outcome}`);

        if (state.conversations.length !== 1) throw new Error("deveria ter criado 1 conversa");
        if (state.messageInserts.length !== 1) {
          throw new Error(
            `esperava 1 mensagem logada, veio ${state.messageInserts.length}`,
          );
        }
        const msg = state.messageInserts[0];
        if (msg.status !== "sent" || msg.content !== "Olá Maria!") {
          throw new Error(
            `mensagem inesperada (template não renderizou {{nome}}?): ${JSON.stringify(msg)}`,
          );
        }

        const row = state.executions[0];
        if (row.status !== "sent") throw new Error(`estado deveria ser sent, veio ${row.status}`);
        if (!row.sent_at) throw new Error("sent_at deveria estar preenchido");
        if (row.error_message !== null) {
          throw new Error(
            `error_message deveria ser null, veio ${row.error_message}`,
          );
        }
        if (row.attempt_count !== 1) {
          throw new Error(
            `attempt_count deveria ser 1, veio ${row.attempt_count}`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );
});

// ==================================================================
// processClaimedExecutions — pré-carga em lote + isolamento de erro
// ==================================================================
Deno.test("processClaimedExecutions", async (t) => {
  await t.step("processa em lote e agrega sent/failed/skippedSuppressed corretamente", async () => {
    const state = defaultState();
    seedHappyPath(state);
    state.contacts.push({
      id: "contact-2",
      tenant_id: "tenant-1",
      phone: "5511988888888",
      email: null,
      tags: ["vip"],
      custom_fields: {},
      deleted_at: null,
    });
    state.suppressedPhones.add("+5511988888888");
    state.inboundByContact["tenant-1:contact-1"] = [hoursAgoIso(1)];
    state.inboundByContact["tenant-1:contact-2"] = [hoursAgoIso(1)];
    const executions: TemplateScheduleExecution[] = [
      baseExecution({ id: "exec-1", contact_id: "contact-1" }),
      baseExecution({ id: "exec-2", contact_id: "contact-2" }),
    ];
    for (const e of executions) {
      state.executions.push(
        { ...e, applied_variables: {}, sent_at: null, error_message: null } as ExecutionRow,
      );
    }
    const uninstall = installFetchMock(router(state));
    try {
      const summary = await processClaimedExecutions(newAdminClient(), executions);
      if (summary.sent !== 1 || summary.skippedSuppressed !== 1 || summary.failed !== 0) {
        throw new Error(`resumo inesperado: ${JSON.stringify(summary)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("erro inesperado numa execução isolada não aborta o lote", async () => {
    const state = defaultState();
    seedHappyPath(state);
    state.contacts.push({
      id: "contact-2",
      tenant_id: "tenant-1",
      phone: "5511988888888",
      email: null,
      tags: ["vip"],
      custom_fields: {},
      deleted_at: null,
    });
    state.inboundByContact["tenant-1:contact-1"] = [hoursAgoIso(1)];
    state.inboundByContact["tenant-1:contact-2"] = [hoursAgoIso(1)];
    const executions: TemplateScheduleExecution[] = [
      baseExecution({ id: "exec-1", contact_id: "contact-1" }),
      // schedule_id != qualquer schedule seedado -> processExecution via
      // processClaimedExecutions lança "schedule não encontrado" pra esta 1.
      baseExecution({ id: "exec-2", contact_id: "contact-2", schedule_id: "sched-inexistente" }),
    ];
    for (const e of executions) {
      state.executions.push(
        { ...e, applied_variables: {}, sent_at: null, error_message: null } as ExecutionRow,
      );
    }
    const uninstall = installFetchMock(router(state));
    try {
      const summary = await processClaimedExecutions(newAdminClient(), executions);
      if (summary.sent !== 1) {
        throw new Error(`esperava 1 sent (exec-1 não deveria ser afetada), veio ${summary.sent}`);
      }
      if (summary.failed !== 1) {
        throw new Error(`esperava 1 failed (exec-2 sem schedule), veio ${summary.failed}`);
      }
      if (summary.errors.length !== 1) {
        throw new Error(`esperava 1 erro registrado, veio ${summary.errors.length}`);
      }
    } finally {
      uninstall();
    }
  });
});

// ==================================================================
// Campanhas — canal da campanha, isolamento de tenant, template aprovado
// ==================================================================
Deno.test("campanhas", async (t) => {
  function pushExecutions(state: MockState, executions: TemplateScheduleExecution[]) {
    for (const e of executions) {
      state.executions.push(
        { ...e, applied_variables: {}, sent_at: null, error_message: null } as ExecutionRow,
      );
    }
  }

  await t.step("schedule sem channel_id falha na geração, sem criar execução", async () => {
    const state = defaultState();
    const schedule = seedHappyPath(state, { channel_id: null, status: "running" });
    const uninstall = installFetchMock(router(state));
    try {
      const result = await generateExecutionsForSchedule(
        newAdminClient(),
        schedule as TemplateSchedule,
      );
      if (!result.failed) throw new Error(`deveria falhar: ${JSON.stringify(result)}`);
      if (state.executions.length !== 0) throw new Error("não deveria criar execução");
      if (state.schedules[0].status !== "failed") throw new Error("schedule deveria ficar failed");
    } finally {
      uninstall();
    }
  });

  await t.step("template de outro tenant: execução failed, nenhum envio", async () => {
    const state = defaultState();
    seedHappyPath(state);
    state.templates[0].tenant_id = "tenant-2";
    state.inboundByContact["tenant-1:contact-1"] = [hoursAgoIso(1)];
    const executions = [baseExecution({ id: "exec-1", contact_id: "contact-1" })];
    pushExecutions(state, executions);
    let sendCalls = 0;
    const uninstall = installFetchMock((req) => {
      if (req.url === META_SEND_URL) sendCalls++;
      return router(state)(req);
    });
    try {
      const summary = await processClaimedExecutions(newAdminClient(), executions);
      if (summary.failed !== 1 || summary.sent !== 0) {
        throw new Error(`resumo inesperado: ${JSON.stringify(summary)}`);
      }
      if (sendCalls !== 0) throw new Error("não deveria chamar o provedor");
    } finally {
      uninstall();
    }
  });

  await t.step("canal de outro tenant: execução failed, nenhum envio", async () => {
    const state = defaultState();
    seedHappyPath(state);
    state.channels[0].tenant_id = "tenant-2";
    state.inboundByContact["tenant-1:contact-1"] = [hoursAgoIso(1)];
    const executions = [baseExecution({ id: "exec-1", contact_id: "contact-1" })];
    pushExecutions(state, executions);
    let sendCalls = 0;
    const uninstall = installFetchMock((req) => {
      if (req.url === META_SEND_URL) sendCalls++;
      return router(state)(req);
    });
    try {
      const summary = await processClaimedExecutions(newAdminClient(), executions);
      if (summary.failed !== 1 || sendCalls !== 0) {
        throw new Error(`inesperado: ${JSON.stringify(summary)} sendCalls=${sendCalls}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("provider_approved no meta-cloud sai como type=template", async () => {
    const state = defaultState();
    seedHappyPath(state);
    state.templates[0].kind = "provider_approved";
    state.templates[0].provider_template_name = "reativacao_v1";
    const executions = [baseExecution({ id: "exec-1", contact_id: "contact-1" })];
    pushExecutions(state, executions);
    const bodies: Array<Record<string, unknown>> = [];
    const uninstall = installFetchMock((req) => {
      if (req.url === META_SEND_URL) bodies.push(req.bodyJson as Record<string, unknown>);
      return router(state)(req);
    });
    try {
      const summary = await processClaimedExecutions(newAdminClient(), executions);
      if (summary.sent !== 1) throw new Error(`esperava sent, veio ${JSON.stringify(summary)}`);
      const body = bodies[0] as { type?: string; template?: { name?: string } };
      if (body?.type !== "template" || body.template?.name !== "reativacao_v1") {
        throw new Error(`payload inesperado: ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("provider_approved no twilio: failed com mensagem clara", async () => {
    const state = defaultState();
    seedHappyPath(state);
    state.templates[0].kind = "provider_approved";
    state.templates[0].provider_template_name = "reativacao_v1";
    state.channels[0].provider_slug = "twilio";
    const executions = [baseExecution({ id: "exec-1", contact_id: "contact-1" })];
    pushExecutions(state, executions);
    const uninstall = installFetchMock(router(state));
    try {
      const summary = await processClaimedExecutions(newAdminClient(), executions);
      if (summary.failed !== 1) throw new Error(`esperava failed: ${JSON.stringify(summary)}`);
      if (!state.executions[0].error_message?.includes("não envia modelo aprovado")) {
        throw new Error(`mensagem inesperada: ${state.executions[0].error_message}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("falha do provedor num contato não afeta o outro", async () => {
    const state = defaultState();
    seedHappyPath(state);
    state.contacts.push({
      id: "contact-2",
      tenant_id: "tenant-1",
      phone: "5511988888888",
      email: null,
      tags: ["vip"],
      custom_fields: {},
      deleted_at: null,
    });
    state.inboundByContact["tenant-1:contact-1"] = [hoursAgoIso(1)];
    state.inboundByContact["tenant-1:contact-2"] = [hoursAgoIso(1)];
    const executions = [
      baseExecution({ id: "exec-1", contact_id: "contact-1" }),
      baseExecution({ id: "exec-2", contact_id: "contact-2" }),
    ];
    pushExecutions(state, executions);
    const uninstall = installFetchMock((req) => {
      const to = (req.bodyJson as { to?: string } | undefined)?.to;
      if (req.url === META_SEND_URL && to === "5511988888888") {
        return jsonResponse(400, { error: { message: "número inválido" } });
      }
      return router(state)(req);
    });
    try {
      const summary = await processClaimedExecutions(newAdminClient(), executions);
      if (summary.sent !== 1 || summary.failed !== 1) {
        throw new Error(`resumo inesperado: ${JSON.stringify(summary)}`);
      }
      const byId = new Map(state.executions.map((e) => [e.id, e.status]));
      if (byId.get("exec-1") !== "sent" || byId.get("exec-2") !== "failed") {
        throw new Error(`status inesperados: ${JSON.stringify([...byId])}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("audiência por estágio exclui contato deletado (filtro no join)", async () => {
    const state = defaultState();
    state.deals.push({ tenant_id: "t1", stage_id: "stage-a", contact_id: "c1" });
    let deletedFilter: string | null = null;
    const uninstall = installFetchMock((req) => {
      if (req.pathname === "/rest/v1/deals") {
        deletedFilter = new URL(req.url).searchParams.get("contacts.deleted_at");
      }
      return router(state)(req);
    });
    try {
      await expandAudience(newAdminClient(), "t1", { stage_id: "stage-a" });
      if (deletedFilter !== "is.null") {
        throw new Error(`esperava contacts.deleted_at=is.null, veio ${deletedFilter}`);
      }
    } finally {
      uninstall();
    }
  });
});

// ==================================================================
// refreshScheduleCounts
// ==================================================================
Deno.test("refreshScheduleCounts", async (t) => {
  await t.step("todas execuções terminais: atualiza contadores e marca 'completed'", async () => {
    const state = defaultState();
    seedHappyPath(state, { status: "running" });
    state.executions.push(
      {
        id: "e1",
        schedule_id: "sched-1",
        contact_id: "contact-1",
        applied_variables: {},
        status: "sent",
        attempt_count: 1,
        scheduled_for: hoursAgoIso(1),
        sent_at: hoursAgoIso(1),
        error_message: null,
      },
      {
        id: "e2",
        schedule_id: "sched-1",
        contact_id: "contact-1",
        applied_variables: {},
        status: "failed",
        attempt_count: 1,
        scheduled_for: hoursAgoIso(1),
        sent_at: null,
        error_message: "erro",
      },
      {
        id: "e3",
        schedule_id: "sched-1",
        contact_id: "contact-1",
        applied_variables: {},
        status: "skipped_suppressed",
        attempt_count: 1,
        scheduled_for: hoursAgoIso(1),
        sent_at: null,
        error_message: null,
      },
    );
    const uninstall = installFetchMock(router(state));
    try {
      await refreshScheduleCounts(newAdminClient(), "sched-1");
      const row = state.schedules[0];
      if (row.sent_count !== 1 || row.failed_count !== 1) {
        throw new Error(`contadores inesperados: ${JSON.stringify(row)}`);
      }
      if (row.status !== "completed") {
        throw new Error(`status deveria ser completed, veio ${row.status}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "execução ainda pendente: NÃO completa, só atualiza contadores parciais",
    async () => {
      const state = defaultState();
      seedHappyPath(state, { status: "running" });
      state.executions.push(
        {
          id: "e1",
          schedule_id: "sched-1",
          contact_id: "contact-1",
          applied_variables: {},
          status: "sent",
          attempt_count: 1,
          scheduled_for: hoursAgoIso(1),
          sent_at: hoursAgoIso(1),
          error_message: null,
        },
        {
          id: "e2",
          schedule_id: "sched-1",
          contact_id: "contact-1",
          applied_variables: {},
          status: "pending",
          attempt_count: 0,
          scheduled_for: hoursAgoIso(1),
          sent_at: null,
          error_message: null,
        },
      );
      const uninstall = installFetchMock(router(state));
      try {
        await refreshScheduleCounts(newAdminClient(), "sched-1");
        const row = state.schedules[0];
        if (row.sent_count !== 1) {
          throw new Error(
            `sent_count deveria ser 1, veio ${row.sent_count}`,
          );
        }
        if (row.status !== "running") {
          throw new Error(
            `status NÃO deveria mudar (ainda tem pendente), veio ${row.status}`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "schedule já 'failed' na geração: refreshScheduleCounts não o reabre como completed",
    async () => {
      const state = defaultState();
      seedHappyPath(state, { status: "failed" });
      state.executions.push({
        id: "e1",
        schedule_id: "sched-1",
        contact_id: "contact-1",
        applied_variables: {},
        status: "sent",
        attempt_count: 1,
        scheduled_for: hoursAgoIso(1),
        sent_at: hoursAgoIso(1),
        error_message: null,
      });
      const uninstall = installFetchMock(router(state));
      try {
        await refreshScheduleCounts(newAdminClient(), "sched-1");
        if (state.schedules[0].status !== "failed") {
          throw new Error(
            `status deveria continuar failed (transição só a partir de running), veio ${
              state.schedules[0].status
            }`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );
});

// ==================================================================
// runTemplateScheduleRunner — smoke end-to-end
// ==================================================================
Deno.test("runTemplateScheduleRunner", async (t) => {
  await t.step("nada pendente/reivindicável: resumo zerado, sem erros", async () => {
    const state = defaultState();
    const uninstall = installFetchMock(router(state));
    try {
      const summary = await runTemplateScheduleRunner(newAdminClient());
      if (
        summary.schedulesGenerated !== 0 ||
        summary.executionsClaimed !== 0 ||
        summary.sent !== 0 ||
        summary.failed !== 0 ||
        summary.errors.length !== 0
      ) {
        throw new Error(`esperava resumo zerado, veio ${JSON.stringify(summary)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "fluxo completo: gera, reivindica, envia e conclui o schedule numa única chamada",
    async () => {
      const state = defaultState();
      seedHappyPath(state);
      state.inboundByContact["tenant-1:contact-1"] = [hoursAgoIso(1)];
      const uninstall = installFetchMock(router(state));
      try {
        const summary = await runTemplateScheduleRunner(newAdminClient());
        if (summary.schedulesGenerated !== 1) {
          throw new Error(
            `inesperado: ${JSON.stringify(summary)}`,
          );
        }
        if (summary.executionsClaimed !== 1 || summary.sent !== 1) {
          throw new Error(
            `inesperado: ${JSON.stringify(summary)}`,
          );
        }
        if (state.schedules[0].status !== "completed") {
          throw new Error(
            `schedule deveria estar completed ao final, veio ${state.schedules[0].status}`,
          );
        }
        // applied_variables nasce '{}' na geração: {{nome}} vem de
        // contacts.name, resolvido no envio (resolveTemplateVariables). Prova
        // ponta a ponta (generateExecutionsForSchedule -> processExecution),
        // não um fixture de execução com applied_variables preenchido à mão.
        if (
          state.messageInserts.length !== 1 ||
          state.messageInserts[0].content !== "Olá Ana, promoção especial!"
        ) {
          throw new Error(
            `content deveria vir personalizado com o nome do contato: ${
              JSON.stringify(state.messageInserts)
            }`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );
});

// ==================================================================
// index.ts — auth fail-closed + wiring fino
// ==================================================================
Deno.test("template-schedule-runner/index.ts", async (t) => {
  const handler = await captureHandler("../template-schedule-runner/index.ts");

  function req(opts: { method?: string; auth?: string | null } = {}): Request {
    const headers = new Headers({ "content-type": "application/json" });
    if (opts.auth !== null) {
      headers.set("Authorization", opts.auth ?? `Bearer ${BASE_ENV.SUPABASE_SERVICE_ROLE_KEY}`);
    }
    return new Request("http://fn.local", { method: opts.method ?? "POST", headers });
  }

  await t.step("OPTIONS responde CORS sem corpo", async () => {
    const res = await handler(req({ method: "OPTIONS" }));
    if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
    if (await res.text()) throw new Error("esperado corpo vazio");
  });

  await t.step("método não-POST retorna 405", async () => {
    const res = await handler(req({ method: "GET" }));
    if (res.status !== 405) throw new Error(`esperado 405, veio ${res.status}`);
  });

  await t.step("sem Authorization retorna 401", async () => {
    const res = await handler(req({ auth: null }));
    if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
  });

  await t.step("bearer diferente do service role retorna 401", async () => {
    const res = await handler(req({ auth: "Bearer errado" }));
    if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
  });

  await t.step("bearer correto, nada pendente: 200 com resumo zerado", async () => {
    const state = defaultState();
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req());
      const body = await res.json();
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
      if (body.schedulesGenerated !== 0 || body.executionsClaimed !== 0) {
        throw new Error(`resumo inesperado: ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });
});

// ==================================================================
// Meta: modelo aprovado com variáveis, erros do provedor, janela por canal e
// IA assumindo a conversa depois da resposta do lead
// ==================================================================
Deno.test("meta templates no runner", async (t) => {
  function seedTemplate(state: MockState) {
    seedHappyPath(state);
    Object.assign(state.templates[0], {
      kind: "provider_approved",
      provider_template_name: "reativacao_cliente",
      language: "pt_BR",
      body: "Oi {{nome}}, volte com {{cupom}} de desconto",
      variables: ["nome", "cupom"],
    });
    state.contacts[0].custom_fields = { cupom: "20%" };
    // applied_variables vazio = caminho real da geração; o valor vem do contato.
    const exec = baseExecution({ id: "exec-1", contact_id: "contact-1", applied_variables: {} });
    state.executions.push(
      { ...exec, applied_variables: {}, sent_at: null, error_message: null } as ExecutionRow,
    );
    return [exec];
  }

  function metaCalls(state: MockState, response?: () => Response) {
    const bodies: Array<Record<string, unknown>> = [];
    const conversationPosts: Array<Record<string, unknown>> = [];
    const secretTenants: string[] = [];
    const uninstall = installFetchMock((req) => {
      if (req.url === META_SEND_URL) {
        bodies.push(req.bodyJson as Record<string, unknown>);
        if (response) return response();
      }
      if (req.pathname === "/rest/v1/conversations" && req.method === "POST") {
        conversationPosts.push(req.bodyJson as Record<string, unknown>);
      }
      if (req.pathname === "/rest/v1/integration_secrets") {
        secretTenants.push(stripOp(new URL(req.url).searchParams.get("tenant_id")));
      }
      return router(state)(req);
    });
    return { bodies, conversationPosts, secretTenants, uninstall };
  }

  const row = (state: MockState) => state.executions[0] as ExecutionRow & Record<string, unknown>;

  await t.step("variáveis vêm do contato, na ordem do modelo; métricas gravadas", async () => {
    const state = defaultState();
    const executions = seedTemplate(state);
    const calls = metaCalls(state);
    try {
      const summary = await processClaimedExecutions(newAdminClient(), executions);
      if (summary.sent !== 1) throw new Error(`esperava sent: ${JSON.stringify(summary)}`);
      const tpl = calls.bodies[0].template as { components?: unknown };
      const expected = [{ type: "body", parameters: [{ type: "text", text: "Ana" }, { type: "text", text: "20%" }] }];
      if (JSON.stringify(tpl.components) !== JSON.stringify(expected)) {
        throw new Error(`components inesperado: ${JSON.stringify(tpl.components)}`);
      }
      const r = row(state);
      if (r.external_id !== "wamid.ext-1" || r.message_kind !== "provider_template" || r.provider_slug !== "meta-cloud") {
        throw new Error(`métricas inesperadas: ${JSON.stringify(r)}`);
      }
      if (state.messageInserts[0]?.content !== "Oi Ana, volte com 20% de desconto") {
        throw new Error(`histórico deveria ter o corpo renderizado: ${JSON.stringify(state.messageInserts)}`);
      }
      if (calls.secretTenants.some((tenant) => tenant !== "tenant-1")) {
        throw new Error(`credencial lida de outro tenant: ${calls.secretTenants}`);
      }
    } finally {
      calls.uninstall();
    }
  });

  await t.step("variável sem valor falha antes de chamar a Meta", async () => {
    const state = defaultState();
    const executions = seedTemplate(state);
    state.contacts[0].custom_fields = {};
    const calls = metaCalls(state);
    try {
      const summary = await processClaimedExecutions(newAdminClient(), executions);
      if (summary.failed !== 1 || calls.bodies.length !== 0) {
        throw new Error(`inesperado: ${JSON.stringify(summary)} calls=${calls.bodies.length}`);
      }
      if (!row(state).error_message?.includes("{{cupom}}")) {
        throw new Error(`erro deveria citar a variável: ${row(state).error_message}`);
      }
    } finally {
      calls.uninstall();
    }
  });

  await t.step("429 da Meta volta para a fila com espera, sem virar falha", async () => {
    const state = defaultState();
    const executions = seedTemplate(state);
    const calls = metaCalls(state, () => jsonResponse(429, { error: { code: 130429 } }));
    try {
      const summary = await processClaimedExecutions(newAdminClient(), executions);
      const r = row(state);
      if (summary.deferred !== 1 || r.status !== "pending" || r.attempt_count !== 1) {
        throw new Error(`inesperado: ${JSON.stringify(summary)} ${JSON.stringify(r)}`);
      }
      if (new Date(r.scheduled_for).getTime() <= Date.now()) {
        throw new Error("reenfileirado sem espera");
      }
    } finally {
      calls.uninstall();
    }
  });

  await t.step("timeout: falha como resultado incerto e NÃO reenvia", async () => {
    const state = defaultState();
    const executions = seedTemplate(state);
    const calls = metaCalls(state, () => {
      throw new DOMException("Signal timed out.", "TimeoutError");
    });
    try {
      const summary = await processClaimedExecutions(newAdminClient(), executions);
      if (summary.failed !== 1 || calls.bodies.length !== 1) {
        throw new Error(`inesperado: ${JSON.stringify(summary)} calls=${calls.bodies.length}`);
      }
      if (row(state).error_message !== UNCERTAIN_DELIVERY_MESSAGE || row(state).status !== "failed") {
        throw new Error(`status inesperado: ${JSON.stringify(row(state))}`);
      }
    } finally {
      calls.uninstall();
    }
  });

  await t.step("freeform no oficial: inbound em OUTRO canal não abre a janela", async () => {
    const state = defaultState();
    seedHappyPath(state);
    state.inboundByContact["tenant-1:contact-1"] = [hoursAgoIso(1)];
    state.inboundChannelId = "chan-zapi";
    const executions = [baseExecution({ id: "exec-1", contact_id: "contact-1" })];
    state.executions.push(
      { ...executions[0], applied_variables: {}, sent_at: null, error_message: null } as ExecutionRow,
    );
    const calls = metaCalls(state);
    try {
      const summary = await processClaimedExecutions(newAdminClient(), executions);
      if (summary.failed !== 1 || calls.bodies.length !== 0) {
        throw new Error(`deveria bloquear: ${JSON.stringify(summary)}`);
      }
      if (!row(state).error_message?.includes("janela de 24h")) {
        throw new Error(`erro inesperado: ${row(state).error_message}`);
      }
    } finally {
      calls.uninstall();
    }
  });

  await t.step("freeform dentro da janela do MESMO canal sai como texto", async () => {
    const state = defaultState();
    seedHappyPath(state);
    state.inboundByContact["tenant-1:contact-1"] = [hoursAgoIso(1)];
    state.inboundChannelId = "chan-1";
    const executions = [baseExecution({ id: "exec-1", contact_id: "contact-1" })];
    state.executions.push(
      { ...executions[0], applied_variables: {}, sent_at: null, error_message: null } as ExecutionRow,
    );
    const calls = metaCalls(state);
    try {
      const summary = await processClaimedExecutions(newAdminClient(), executions);
      if (summary.sent !== 1 || calls.bodies[0]?.type !== "text") {
        throw new Error(`inesperado: ${JSON.stringify(summary)} ${JSON.stringify(calls.bodies)}`);
      }
      if (row(state).message_kind !== "freeform") throw new Error("message_kind errado");
    } finally {
      calls.uninstall();
    }
  });

  await t.step("conversa nova da campanha nasce com IA ativa (IA assume quando o lead responder)", async () => {
    const state = defaultState();
    const executions = seedTemplate(state);
    const calls = metaCalls(state);
    try {
      await processClaimedExecutions(newAdminClient(), executions);
      if (calls.conversationPosts.length !== 1 || calls.conversationPosts[0].ai_active !== true) {
        throw new Error(`conversa criada sem IA: ${JSON.stringify(calls.conversationPosts)}`);
      }
    } finally {
      calls.uninstall();
    }
  });

  await t.step("conversa já aberta (ex.: handoff humano) é reaproveitada sem tocar ai_active", async () => {
    const state = defaultState();
    const executions = seedTemplate(state);
    state.conversations.push({
      id: "conv-humano",
      tenant_id: "tenant-1",
      contact_id: "contact-1",
      channel_id: "chan-1",
    });
    const patches: unknown[] = [];
    const inner = metaCalls(state);
    inner.uninstall();
    const uninstall = installFetchMock((req) => {
      if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
        patches.push(req.bodyJson);
      }
      return router(state)(req);
    });
    try {
      await processClaimedExecutions(newAdminClient(), executions);
      if (state.conversations.length !== 1) throw new Error("criou conversa duplicada");
      if (patches.some((p) => p && typeof p === "object" && "ai_active" in p)) {
        throw new Error(`mexeu em ai_active da conversa existente: ${JSON.stringify(patches)}`);
      }
      if (state.messageInserts[0]?.conversation_id !== "conv-humano") {
        throw new Error("mensagem não foi para a conversa existente");
      }
    } finally {
      uninstall();
    }
  });
});

// ==================================================================
// Auditoria final: trabalho preso e canais com sucesso simulado
// ==================================================================
Deno.test("auditoria: reaper e canais de campanha", async (t) => {
  await t.step("execução presa em 'sending' vira failed incerto, sem reenvio", async () => {
    const state = defaultState();
    seedHappyPath(state, { status: "running", scheduled_for: hoursAgoIso(2) });
    state.executions.push({
      ...baseExecution({ id: "exec-presa", contact_id: "contact-1", status: "sending" }),
      applied_variables: {},
      sent_at: null,
      error_message: null,
      last_attempt_at: hoursAgoIso(1),
    } as unknown as ExecutionRow);
    let sendCalls = 0;
    const uninstall = installFetchMock((req) => {
      if (req.url === META_SEND_URL) sendCalls++;
      return router(state)(req);
    });
    try {
      const summary = await runTemplateScheduleRunner(newAdminClient());
      const row = state.executions[0];
      if (row.status !== "failed" || row.error_message !== STALE_EXECUTION_MESSAGE) {
        throw new Error(`execução presa não foi fechada: ${JSON.stringify(row)}`);
      }
      if (sendCalls !== 0) throw new Error("reaper não pode reenviar");
      if (summary.staleExecutions !== 1) throw new Error(`resumo: ${JSON.stringify(summary)}`);
      if (state.schedules[0].status !== "completed") {
        throw new Error(`schedule deveria fechar: ${state.schedules[0].status}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("schedule em 'running' sem execuções há muito tempo vira failed", async () => {
    const state = defaultState();
    seedHappyPath(state, { status: "running", scheduled_for: hoursAgoIso(2) });
    const uninstall = installFetchMock(router(state));
    try {
      const r = await reapStaleWork(newAdminClient());
      if (r.staleSchedules !== 1 || state.schedules[0].status !== "failed") {
        throw new Error(`inesperado: ${JSON.stringify(r)} ${state.schedules[0].status}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("canal com sucesso simulado (sms) é recusado em campanha", async () => {
    const state = defaultState();
    seedHappyPath(state);
    state.channels[0].provider_slug = "sms";
    const executions = [baseExecution({ id: "exec-1", contact_id: "contact-1" })];
    state.executions.push(
      { ...executions[0], applied_variables: {}, sent_at: null, error_message: null } as ExecutionRow,
    );
    const uninstall = installFetchMock(router(state));
    try {
      const summary = await processClaimedExecutions(newAdminClient(), executions);
      if (summary.failed !== 1 || !state.executions[0].error_message?.includes("não suportado em campanhas")) {
        throw new Error(`inesperado: ${JSON.stringify(summary)} ${state.executions[0].error_message}`);
      }
      if (state.messageInserts.length !== 0) throw new Error("não pode registrar envio");
    } finally {
      uninstall();
    }
  });
});
