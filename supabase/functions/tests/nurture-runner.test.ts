// Testa a lógica pura de supabase/functions/nurture-runner/runner.ts:
// claim atômico (UPDATE...RETURNING, sem race entre 2 chamadas concorrentes),
// supressão de telefone, guard de frequência cruzada, avanço de step em
// sucesso (com o off-by-one correto -- agenda usando o delay do PRÓXIMO step,
// não do que acabou de ser enviado), retry com backoff em falha de envio, e
// conclusão imediata quando não há próximo step. Mesmo harness Deno (createClient
// real + installFetchMock) usado pelos demais arquivos desta pasta -- ver
// docs/TESTING.md ("Edge functions (Deno) — deno test"); NÃO um arquivo Vitest
// (vitest.config.ts só cobre src/**, e este módulo importa de esm.sh).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { BASE_ENV, type FetchMatcher, installFetchMock, jsonResponse, setEnv } from "./_helpers.ts";
import {
  claimDueEnrollments,
  type ClaimedEnrollment,
  processClaimedEnrollment,
  runNurtureRunner,
} from "../nurture-runner/runner.ts";

setEnv(BASE_ENV);

function newAdminClient() {
  return createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const ZAPI_SEND_URL = "https://api.z-api.io/instances/inst-1/token/tok-1/send-text";
const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

function minutesAgoIso(min: number): string {
  return new Date(Date.now() - min * MIN_MS).toISOString();
}

function stripOp(raw: string | null): string {
  return raw?.replace(/^[a-z.]+\./, "") ?? "";
}

interface EnrollmentRow {
  id: string;
  tenant_id: string;
  sequence_id: string;
  deal_id: string | null;
  contact_id: string;
  current_step: number;
  status: string;
  next_send_at: string | null;
  completed_at?: string | null;
  attempts: number;
}

/**
 * Horário de atendimento do tenant no mock. Aberto 24/7 por padrão: o runner
 * consulta o relógio real e um teste que só passasse em horário comercial seria
 * vermelho todo fim de semana. Os testes da janela em si vivem em
 * business-hours.test.ts, com relógio fixo.
 */
const SEMPRE_ABERTO = Object.fromEntries(
  ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [
    d,
    { enabled: true, open: "00:00", close: "24:00" },
  ]),
);

interface StepRow {
  sequence_id: string;
  step_number: number;
  delay_hours: number;
  message_template: string;
}

interface ContactRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
}

interface MockState {
  enrollments: EnrollmentRow[];
  steps: StepRow[];
  contacts: ContactRow[];
  suppressedPhones: Set<string>;
  channelBySequence: Record<string, string>;
  providerByChannel: Record<string, string>;
  automatedSendsByContact: Record<string, string[]>; // key `${tenant}:${contact}` -> timestamps ISO
  conversations: Array<{ id: string; tenant_id: string; contact_id: string; channel_id: string }>;
  messageInserts: Record<string, unknown>[];
  executionHistory: Record<string, unknown>[];
  sendResponse: { status: number; body: unknown };
  // Sink de `captureEdgeError`: cancelamento é estado terminal e precisa de
  // rastro consultável, não de `console.log` que morre com o isolate.
  systemEvents: Record<string, unknown>[];
  businessHours: Record<string, unknown>;
}

function defaultState(): MockState {
  return {
    enrollments: [],
    steps: [],
    contacts: [],
    suppressedPhones: new Set(),
    channelBySequence: {},
    providerByChannel: {},
    automatedSendsByContact: {},
    conversations: [],
    messageInserts: [],
    executionHistory: [],
    sendResponse: { status: 200, body: { messageId: "ext-1" } },
    systemEvents: [],
    businessHours: SEMPRE_ABERTO,
  };
}

/**
 * Seed padrão: 1 enrollment + sequence -> channel -> zapi + contato com
 * telefone. Nasce em `sending` porque é assim que `processClaimedEnrollment`
 * recebe a linha na vida real (o claim já marcou); os testes de
 * `claimDueEnrollments` passam `status: "active"` para exercitar o claim.
 */
function seedHappyPath(state: MockState, overrides: Partial<EnrollmentRow> = {}): EnrollmentRow {
  const enrollment: EnrollmentRow = {
    id: "enr-1",
    tenant_id: "tenant-1",
    sequence_id: "seq-1",
    deal_id: null,
    contact_id: "contact-1",
    current_step: 0,
    status: "sending",
    next_send_at: minutesAgoIso(1),
    attempts: 0,
    ...overrides,
  };
  state.enrollments.push(enrollment);
  state.steps.push(
    {
      sequence_id: "seq-1",
      step_number: 1,
      delay_hours: 1,
      message_template: "Oi {{contact.name}}!",
    },
    { sequence_id: "seq-1", step_number: 2, delay_hours: 48, message_template: "Segunda mensagem" },
  );
  state.contacts.push({ id: "contact-1", name: "Maria", phone: "5511999999999", email: null });
  state.channelBySequence["seq-1"] = "chan-1";
  state.providerByChannel["chan-1"] = "zapi";
  return enrollment;
}

function router(state: MockState): FetchMatcher {
  return (r) => {
    const sp = new URL(r.url).searchParams;

    if (r.pathname === "/rest/v1/system_events" && r.method === "POST") {
      state.systemEvents.push(r.bodyJson as Record<string, unknown>);
      return jsonResponse(201, []);
    }

    if (r.pathname === "/rest/v1/nurture_execution_history" && r.method === "POST") {
      state.executionHistory.push(r.bodyJson as Record<string, unknown>);
      return jsonResponse(201, []);
    }

    // Releitura do status antes do envio externo: o claim ficou várias
    // consultas atrás e o webhook pode ter cancelado no intervalo.
    if (r.pathname === "/rest/v1/nurture_enrollments" && r.method === "GET") {
      const id = stripOp(sp.get("id"));
      const row = state.enrollments.find((e) => e.id === id);
      return jsonResponse(200, row ? { status: row.status } : null);
    }

    // -------- claim + bookkeeping de nurture_enrollments --------
    if (r.pathname === "/rest/v1/nurture_enrollments" && r.method === "PATCH") {
      const idFilter = sp.get("id");
      if (idFilter) {
        const id = stripOp(idFilter);
        const row = state.enrollments.find((e) => e.id === id);
        if (!row) return jsonResponse(200, []);
        // O código passou a condicionar a escrita ao status atual (guarda
        // contra ressuscitar inscrição cancelada durante o envio) e a ler as
        // linhas afetadas — o mock precisa dos dois para o teste valer.
        const statusFilter = sp.get("status");
        // O worker manda `status=neq.cancelled`: linha cancelada não recebe
        // mais escrita nenhuma dele.
        if (statusFilter?.startsWith("neq.") && statusFilter.slice(4) === row.status) {
          return jsonResponse(200, []);
        }
        Object.assign(row, r.bodyJson as Record<string, unknown>);
        return jsonResponse(200, [{ id: row.id }]);
      }
      // Claim: UPDATE...RETURNING num único statement -- filtra pelos MESMOS
      // parâmetros que claimDueEnrollments manda, marca status='sending' e
      // devolve só o que casar (simula a atomicidade real do Postgres: uma
      // 2ª chamada, mesmo que concorrente, só vê o que a 1ª não reivindicou).
      const statusFilter = sp.get("status");
      const nextSendFilter = sp.get("next_send_at");
      if (statusFilter !== "eq.active" || !nextSendFilter?.startsWith("lte.")) {
        throw new Error(`PATCH nurture_enrollments (claim) inesperado: ${r.url}`);
      }
      const cutoff = new Date(stripOp(nextSendFilter));
      const limit = Number(sp.get("limit") ?? "50");
      const claimed = state.enrollments
        .filter((e) =>
          e.status === "active" && e.next_send_at && new Date(e.next_send_at) <= cutoff
        )
        .sort((a, b) => new Date(a.next_send_at!).getTime() - new Date(b.next_send_at!).getTime())
        .slice(0, limit);
      for (const c of claimed) c.status = "sending";
      return jsonResponse(
        200,
        claimed.map((
          {
            id,
            tenant_id,
            sequence_id,
            deal_id,
            contact_id,
            current_step,
            status,
            next_send_at,
            attempts,
          },
        ) => ({
          id,
          tenant_id,
          sequence_id,
          deal_id,
          contact_id,
          current_step,
          status,
          next_send_at,
          attempts,
        })),
      );
    }

    // -------- tenants (horário de atendimento) --------
    if (r.pathname === "/rest/v1/tenants" && r.method === "GET") {
      return jsonResponse(200, { business_profile: { hours: state.businessHours } });
    }

    // -------- nurture_steps --------
    if (r.pathname === "/rest/v1/nurture_steps" && r.method === "GET") {
      const sequenceId = stripOp(sp.get("sequence_id"));
      const stepNumber = Number(stripOp(sp.get("step_number")));
      const step = state.steps.find((s) =>
        s.sequence_id === sequenceId && s.step_number === stepNumber
      );
      return jsonResponse(
        200,
        step
          ? {
            step_number: step.step_number,
            delay_hours: step.delay_hours,
            message_template: step.message_template,
          }
          : null,
      );
    }

    // -------- contacts --------
    if (r.pathname === "/rest/v1/contacts" && r.method === "GET") {
      const id = stripOp(sp.get("id"));
      const contact = state.contacts.find((c) => c.id === id);
      return jsonResponse(200, contact ?? null);
    }

    // -------- messaging_phone_suppressions --------
    // isPhoneSuppressed (_shared/messaging/conversation.ts) usa .limit(1) sem
    // .maybeSingle(), então a resposta real do PostgREST é sempre um array.
    if (r.pathname === "/rest/v1/messaging_phone_suppressions" && r.method === "GET") {
      const phone = stripOp(sp.get("phone"));
      const suppressed = state.suppressedPhones.has(phone);
      return jsonResponse(200, suppressed ? [{ id: `sup-${phone}` }] : []);
    }

    // -------- nurture_sequences (channel_id) --------
    if (r.pathname === "/rest/v1/nurture_sequences" && r.method === "GET") {
      const id = stripOp(sp.get("id"));
      const channelId = state.channelBySequence[id] ?? null;
      return jsonResponse(200, channelId ? { channel_id: channelId } : { channel_id: null });
    }

    // -------- channels (provider_slug) --------
    if (r.pathname === "/rest/v1/channels" && r.method === "GET") {
      const id = stripOp(sp.get("id"));
      const providerSlug = state.providerByChannel[id] ?? null;
      return jsonResponse(200, providerSlug ? { provider_slug: providerSlug } : null);
    }

    // -------- integration_secrets (credenciais zapi) --------
    if (r.pathname === "/rest/v1/integration_secrets" && r.method === "GET") {
      return jsonResponse(200, [
        { key: "instance_id", value: "inst-1" },
        { key: "instance_token", value: "tok-1" },
        { key: "client_token", value: "client-1" },
      ]);
    }

    // -------- envio externo (zapi) --------
    if (r.url === ZAPI_SEND_URL && r.method === "POST") {
      return jsonResponse(state.sendResponse.status, state.sendResponse.body);
    }

    // -------- conversations: find-or-create --------
    if (r.pathname === "/rest/v1/conversations" && r.method === "GET") {
      const tenantId = stripOp(sp.get("tenant_id"));
      const contactId = stripOp(sp.get("contact_id"));
      const channelId = stripOp(sp.get("channel_id"));
      const existing = state.conversations.find(
        (c) => c.tenant_id === tenantId && c.contact_id === contactId && c.channel_id === channelId,
      );
      return jsonResponse(200, existing ? { id: existing.id } : null);
    }
    if (r.pathname === "/rest/v1/conversations" && r.method === "POST") {
      const body = r.bodyJson as { tenant_id: string; contact_id: string; channel_id: string };
      const created = { id: `conv-${state.conversations.length + 1}`, ...body };
      state.conversations.push(created);
      return jsonResponse(201, { id: created.id });
    }
    if (r.pathname === "/rest/v1/conversations" && r.method === "PATCH") {
      return new Response(null, { status: 204 });
    }

    // -------- messages: insert (logAutomatedSend) --------
    if (r.pathname === "/rest/v1/messages" && r.method === "POST") {
      const body = r.bodyJson as Record<string, unknown>;
      state.messageInserts.push(body);
      return jsonResponse(201, { id: `msg-${state.messageInserts.length}` });
    }

    // -------- messages: count (countRecentAutomatedSends) --------
    if (r.pathname === "/rest/v1/messages" && r.method === "HEAD") {
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
      const sinceRaw = stripOp(sp.get("created_at"));
      const since = new Date(sinceRaw);
      const key = `${tenantId}:${contactId}`;
      const sends = state.automatedSendsByContact[key] ?? [];
      const count = sends.filter((iso) => new Date(iso) >= since).length;
      return new Response(null, { status: 200, headers: { "content-range": `*/${count}` } });
    }

    return undefined;
  };
}

// -------------------- claimDueEnrollments --------------------

Deno.test("claimDueEnrollments", async (t) => {
  await t.step("reivindica linhas ativas e due, marcando status='sending'", async () => {
    const state = defaultState();
    seedHappyPath(state, { status: "active" });
    const uninstall = installFetchMock(router(state));
    try {
      const claimed = await claimDueEnrollments({ admin: newAdminClient() }, { limit: 10 });
      if (claimed.length !== 1) {
        throw new Error(`esperava 1 linha reivindicada, veio ${claimed.length}`);
      }
      if (claimed[0].id !== "enr-1") throw new Error(`id inesperado: ${claimed[0].id}`);
      if (state.enrollments[0].status !== "sending") {
        throw new Error(`esperava status='sending' no estado, veio ${state.enrollments[0].status}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "2 chamadas concorrentes não processam a mesma linha 2x -- a 2ª vê a linha vazia",
    async () => {
      const state = defaultState();
      seedHappyPath(state, { status: "active" });
      const uninstall = installFetchMock(router(state));
      try {
        const firstClaim = await claimDueEnrollments({ admin: newAdminClient() }, { limit: 10 });
        if (firstClaim.length !== 1) {
          throw new Error(`1ª chamada deveria reivindicar 1 linha, veio ${firstClaim.length}`);
        }

        // 2ª chamada "concorrente": o mock reflete o mesmo estado real do
        // banco -- a linha já está 'sending', então a query real
        // (status='active') não deve mais retorná-la.
        const secondClaim = await claimDueEnrollments({ admin: newAdminClient() }, { limit: 10 });
        if (secondClaim.length !== 0) {
          throw new Error(`2ª chamada não deveria reivindicar nada, veio ${secondClaim.length}`);
        }
      } finally {
        uninstall();
      }
    },
  );
});

// -------------------- processClaimedEnrollment --------------------

Deno.test("processClaimedEnrollment", async (t) => {
  await t.step(
    "supressão CANCELA a inscrição em vez de queimar os passos em silêncio",
    async () => {
      const state = defaultState();
      const enrollment = seedHappyPath(state);
      state.suppressedPhones.add("+5511999999999");
      const uninstall = installFetchMock(router(state));
      try {
        const outcome = await processClaimedEnrollment(
          { admin: newAdminClient() },
          enrollment as ClaimedEnrollment,
        );
        if (outcome.kind !== "skipped_suppressed") {
          throw new Error(`outcome inesperado: ${JSON.stringify(outcome)}`);
        }
        if (state.messageInserts.length !== 0) {
          throw new Error("supressão não deveria gravar mensagem nenhuma");
        }

        const row = state.enrollments[0];
        // Antes: voltava para 'active' com o próximo passo agendado — quem
        // pediu "parar" percorria a sequência inteira sem receber nada e
        // terminava marcado como "concluída".
        if (row.status !== "cancelled") {
          throw new Error(`status deveria ser 'cancelled', veio ${row.status}`);
        }
        if (row.next_send_at !== null) {
          throw new Error(`inscrição cancelada não pode ter próximo envio: ${row.next_send_at}`);
        }
        if (row.current_step !== 0) {
          throw new Error(
            `cancelamento não avança passo, mas current_step veio ${row.current_step}`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "inscrição cancelada durante o envio não é ressuscitada pelo avanço",
    async () => {
      const state = defaultState();
      const enrollment = seedHappyPath(state);
      const uninstall = installFetchMock(router(state));
      try {
        // Simula o webhook: o lead respondeu enquanto a linha estava em
        // 'sending', então o cancelamento já está gravado quando o worker
        // termina o envio e tenta avançar.
        state.enrollments[0].status = "cancelled";
        state.enrollments[0].next_send_at = null;

        const outcome = await processClaimedEnrollment(
          { admin: newAdminClient() },
          enrollment as ClaimedEnrollment,
        );

        const row = state.enrollments[0];
        if (row.status !== "cancelled") {
          throw new Error(`avanço ressuscitou a inscrição: status ${row.status}`);
        }
        if (row.next_send_at !== null) {
          throw new Error(`avanço reagendou envio para inscrição cancelada: ${row.next_send_at}`);
        }
        // Sem esta asserção o teste passava mesmo com a mensagem ENVIADA: só
        // provava que o bookkeeping não ressuscitou a linha, não que o lead
        // deixou de receber.
        if (state.messageInserts.length !== 0) {
          throw new Error(
            `inscrição cancelada não podia ter mensagem enviada: ${
              JSON.stringify(state.messageInserts)
            }`,
          );
        }
        if (outcome.kind !== "skipped_cancelled") {
          throw new Error(`outcome inesperado: ${JSON.stringify(outcome)}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "cancelamento por supressão grava completed_at e deixa rastro em system_events",
    async () => {
      const state = defaultState();
      const enrollment = seedHappyPath(state);
      state.suppressedPhones.add("+5511999999999");
      const uninstall = installFetchMock(router(state));
      try {
        await processClaimedEnrollment({ admin: newAdminClient() }, enrollment as ClaimedEnrollment);

        const row = state.enrollments[0];
        // Sem completed_at, o scanner de auto-inscrição reinscreve o contato na
        // varredura seguinte e o cancelamento vira um ciclo.
        if (!row.completed_at) {
          throw new Error("cancelamento por supressão precisa gravar completed_at");
        }
        const evento = state.systemEvents.find(
          (e) => e.operation === "nurture.cancel_enrollment",
        );
        if (!evento || evento.severity !== "info") {
          throw new Error(
            `cancelamento por supressão sem rastro consultável: ${
              JSON.stringify(state.systemEvents)
            }`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("envio adiado por guard de frequência: mantém o step, adia ~6h", async () => {
    const state = defaultState();
    const enrollment = seedHappyPath(state);
    state.automatedSendsByContact["tenant-1:contact-1"] = [new Date().toISOString()];
    const uninstall = installFetchMock(router(state));
    try {
      const outcome = await processClaimedEnrollment(
        { admin: newAdminClient() },
        enrollment as ClaimedEnrollment,
      );
      if (outcome.kind !== "deferred_frequency") {
        throw new Error(`outcome inesperado: ${JSON.stringify(outcome)}`);
      }

      if (state.messageInserts.length !== 0) {
        throw new Error("guard de frequência não deveria tentar enviar");
      }

      const row = state.enrollments[0];
      if (row.status !== "active") {
        throw new Error(`status deveria voltar a 'active', veio ${row.status}`);
      }
      if (row.current_step !== 0) {
        throw new Error(`current_step NÃO deveria avançar, veio ${row.current_step}`);
      }
      const scheduled = new Date(row.next_send_at!).getTime();
      const expectedMin = Date.now() + 5 * HOUR_MS;
      const expectedMax = Date.now() + 7 * HOUR_MS;
      if (scheduled < expectedMin || scheduled > expectedMax) {
        throw new Error(`next_send_at fora da janela esperada (~6h): ${row.next_send_at}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("fora do horário de atendimento: não envia, adia para a abertura", async () => {
    const state = defaultState();
    const enrollment = seedHappyPath(state);
    // Tenant fechado todos os dias das 00:00 às 00:01 — qualquer relógio real
    // cai fora, sem depender da hora em que a suíte roda.
    state.businessHours = Object.fromEntries(
      ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [
        d,
        { enabled: true, open: "00:00", close: "00:01" },
      ]),
    );
    const uninstall = installFetchMock(router(state));
    try {
      const outcome = await processClaimedEnrollment(
        { admin: newAdminClient() },
        enrollment as ClaimedEnrollment,
      );
      if (outcome.kind !== "deferred_window") {
        throw new Error(`outcome inesperado: ${JSON.stringify(outcome)}`);
      }

      if (state.messageInserts.length !== 0) {
        throw new Error("fora do horário não deveria tentar enviar");
      }

      const row = state.enrollments[0];
      if (row.status !== "active") {
        throw new Error(`status deveria voltar a 'active', veio ${row.status}`);
      }
      if (row.current_step !== 0) {
        throw new Error(`current_step NÃO deveria avançar, veio ${row.current_step}`);
      }
      const adiado = new Date(row.next_send_at!).getTime();
      if (adiado <= Date.now()) {
        throw new Error(`next_send_at deveria ser futuro, veio ${row.next_send_at}`);
      }
      if (adiado > Date.now() + 25 * HOUR_MS) {
        throw new Error(`adiamento longe demais (>25h): ${row.next_send_at}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("teto de tentativas: na última falha cancela em vez de reagendar", async () => {
    const state = defaultState();
    // 4 falhas anteriores; esta é a 5ª e última permitida.
    const enrollment = seedHappyPath(state, { attempts: 4 });
    state.sendResponse = { status: 500, body: { error: "provider down" } };
    const uninstall = installFetchMock(router(state));
    try {
      const outcome = await processClaimedEnrollment(
        { admin: newAdminClient() },
        enrollment as ClaimedEnrollment,
      );
      if (outcome.kind !== "exhausted") {
        throw new Error(`outcome inesperado: ${JSON.stringify(outcome)}`);
      }

      const row = state.enrollments[0];
      if (row.status !== "cancelled") {
        throw new Error(`status deveria ser 'cancelled', veio ${row.status}`);
      }
      if (!row.completed_at) {
        throw new Error("cancelamento por esgotamento precisa de completed_at (carência do scanner)");
      }
      if (row.next_send_at !== null) {
        throw new Error(`next_send_at deveria ser null, veio ${row.next_send_at}`);
      }
      const evento = state.systemEvents.find((e) =>
        String(e.operation ?? "").includes("cancel_enrollment")
      );
      if (!evento || !String(evento.message ?? "").includes("tentativas")) {
        throw new Error(
          `esperava system_event explicando o esgotamento: ${JSON.stringify(state.systemEvents)}`,
        );
      }
    } finally {
      uninstall();
    }
  });

  await t.step("antes do teto: conta a tentativa e reagenda o retry", async () => {
    const state = defaultState();
    const enrollment = seedHappyPath(state, { attempts: 1 });
    state.sendResponse = { status: 500, body: { error: "provider down" } };
    const uninstall = installFetchMock(router(state));
    try {
      const outcome = await processClaimedEnrollment(
        { admin: newAdminClient() },
        enrollment as ClaimedEnrollment,
      );
      if (outcome.kind !== "retry") {
        throw new Error(`outcome inesperado: ${JSON.stringify(outcome)}`);
      }
      const row = state.enrollments[0];
      if (row.status !== "active") {
        throw new Error(`status deveria voltar a 'active', veio ${row.status}`);
      }
      if (row.attempts !== 2) {
        throw new Error(`attempts deveria virar 2, veio ${row.attempts}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("envio bem-sucedido zera o contador de tentativas", async () => {
    const state = defaultState();
    const enrollment = seedHappyPath(state, { attempts: 3 });
    const uninstall = installFetchMock(router(state));
    try {
      const outcome = await processClaimedEnrollment(
        { admin: newAdminClient() },
        enrollment as ClaimedEnrollment,
      );
      if (outcome.kind !== "sent") {
        throw new Error(`outcome inesperado: ${JSON.stringify(outcome)}`);
      }
      const row = state.enrollments[0];
      if (row.attempts !== 0) {
        throw new Error(
          `attempts deveria zerar no sucesso (senão a sequência morre no meio), veio ${row.attempts}`,
        );
      }
    } finally {
      uninstall();
    }
  });

  await t.step("sucesso: envia, avança o step usando o delay do PRÓXIMO step", async () => {
    const state = defaultState();
    const enrollment = seedHappyPath(state);
    const uninstall = installFetchMock(router(state));
    try {
      const outcome = await processClaimedEnrollment(
        { admin: newAdminClient() },
        enrollment as ClaimedEnrollment,
      );
      if (outcome.kind !== "sent") {
        throw new Error(`outcome inesperado: ${JSON.stringify(outcome)}`);
      }

      if (state.messageInserts.length !== 1) {
        throw new Error(`esperava 1 mensagem gravada, veio ${state.messageInserts.length}`);
      }
      const msg = state.messageInserts[0];
      if (msg.status !== "sent" || msg.content !== "Oi Maria!") {
        throw new Error(
          `mensagem inesperada (template não renderizou {{contact.name}}?): ${JSON.stringify(msg)}`,
        );
      }

      const row = state.enrollments[0];
      if (row.status !== "active") {
        throw new Error(`status deveria continuar 'active', veio ${row.status}`);
      }
      if (row.current_step !== 1) {
        throw new Error(`current_step deveria avançar para 1, veio ${row.current_step}`);
      }
      const scheduled = new Date(row.next_send_at!).getTime();
      const expectedMin = Date.now() + 47 * HOUR_MS;
      const expectedMax = Date.now() + 49 * HOUR_MS;
      if (scheduled < expectedMin || scheduled > expectedMax) {
        throw new Error(
          `next_send_at deveria usar o delay do step 2 (48h), veio ${row.next_send_at}`,
        );
      }
    } finally {
      uninstall();
    }
  });

  await t.step("sucesso no último step: completa a inscrição (sem próximo step)", async () => {
    const state = defaultState();
    const enrollment = seedHappyPath(state, { current_step: 1 }); // já mandou o step 1; só falta o 2
    const uninstall = installFetchMock(router(state));
    try {
      const outcome = await processClaimedEnrollment(
        { admin: newAdminClient() },
        enrollment as ClaimedEnrollment,
      );
      if (outcome.kind !== "sent") {
        throw new Error(`outcome inesperado: ${JSON.stringify(outcome)}`);
      }

      const row = state.enrollments[0];
      if (row.status !== "completed") {
        throw new Error(`status deveria ser 'completed', veio ${row.status}`);
      }
      if (row.current_step !== 2) {
        throw new Error(`current_step deveria ser 2, veio ${row.current_step}`);
      }
      if (row.next_send_at !== null) {
        throw new Error(`next_send_at deveria ser null, veio ${row.next_send_at}`);
      }
      if (!row.completed_at) throw new Error("completed_at deveria estar preenchido");
    } finally {
      uninstall();
    }
  });

  await t.step(
    "falha no envio: NÃO completa, volta pra 'active' e agenda retry ~30min",
    async () => {
      const state = defaultState();
      const enrollment = seedHappyPath(state);
      state.sendResponse = { status: 500, body: { message: "provider fora do ar" } };
      const uninstall = installFetchMock(router(state));
      try {
        const outcome = await processClaimedEnrollment(
          { admin: newAdminClient() },
          enrollment as ClaimedEnrollment,
        );
        if (outcome.kind !== "retry") {
          throw new Error(
            `outcome inesperado: ${JSON.stringify(outcome)}`,
          );
        }

        if (state.messageInserts.length !== 1 || state.messageInserts[0].status !== "failed") {
          throw new Error(
            `esperava 1 mensagem status='failed', veio ${JSON.stringify(state.messageInserts)}`,
          );
        }

        const row = state.enrollments[0];
        if (row.status !== "active") {
          throw new Error(
            `status deveria voltar a 'active', veio ${row.status}`,
          );
        }
        if (row.current_step !== 0) {
          throw new Error(
            `current_step NÃO deveria avançar em falha, veio ${row.current_step}`,
          );
        }
        const scheduled = new Date(row.next_send_at!).getTime();
        const expectedMin = Date.now() + 25 * MIN_MS;
        const expectedMax = Date.now() + 35 * MIN_MS;
        if (scheduled < expectedMin || scheduled > expectedMax) {
          throw new Error(`next_send_at fora da janela esperada (~30min): ${row.next_send_at}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("conclusão quando não há próximo step: completa sem tentar enviar", async () => {
    const state = defaultState();
    // current_step=2 -> current_step+1=3 não existe em nurture_steps (só há 1 e 2).
    const enrollment = seedHappyPath(state, { current_step: 2 });
    const uninstall = installFetchMock((req) => {
      if (req.url === ZAPI_SEND_URL) {
        throw new Error("não deveria tentar enviar quando não há próximo step");
      }
      return router(state)(req);
    });
    try {
      const outcome = await processClaimedEnrollment(
        { admin: newAdminClient() },
        enrollment as ClaimedEnrollment,
      );
      if (outcome.kind !== "completed") {
        throw new Error(`outcome inesperado: ${JSON.stringify(outcome)}`);
      }
      if (state.messageInserts.length !== 0) throw new Error("não deveria gravar mensagem nenhuma");

      const row = state.enrollments[0];
      if (row.status !== "completed") {
        throw new Error(`status deveria ser 'completed', veio ${row.status}`);
      }
      if (row.current_step !== 2) {
        throw new Error(
          `current_step NÃO deveria mudar (nunca chegou a enviar), veio ${row.current_step}`,
        );
      }
      if (row.next_send_at !== null) {
        throw new Error(`next_send_at deveria ser null, veio ${row.next_send_at}`);
      }
    } finally {
      uninstall();
    }
  });
});

Deno.test("runNurtureRunner registra o envio do simulador por inscrição e passo", async () => {
  const state = defaultState();
  seedHappyPath(state, { status: "active" });
  state.providerByChannel["chan-1"] = "simulator";
  const uninstall = installFetchMock(router(state));
  try {
    const summary = await runNurtureRunner({ admin: newAdminClient() });
    if (summary.sent !== 1) throw new Error(`Envio não executado: ${JSON.stringify(summary)}`);
    const [execution] = state.executionHistory;
    if (state.executionHistory.length !== 1 || execution.enrollment_id !== "enr-1" ||
      execution.step_number !== 1 || execution.outcome !== "sent") {
      throw new Error(`Histórico do envio ausente ou incorreto: ${JSON.stringify(state.executionHistory)}`);
    }
    if (!String(state.messageInserts[0]?.external_id).startsWith("simulator:")) {
      throw new Error("Mensagem não foi registrada com recibo do simulador.");
    }
  } finally {
    uninstall();
  }
});

Deno.test("runNurtureRunner registra falha de credencial sem avançar o passo", async () => {
  const state = defaultState();
  seedHappyPath(state, { status: "active" });
  const uninstall = installFetchMock((req) =>
    req.pathname === "/rest/v1/integration_secrets"
      ? jsonResponse(200, [])
      : router(state)(req)
  );
  try {
    const summary = await runNurtureRunner({ admin: newAdminClient() });
    const [execution] = state.executionHistory;
    if (summary.retried !== 1 || state.enrollments[0].current_step !== 0 ||
      execution?.outcome !== "retry" || execution?.detail !== "Integração Z-API não configurada.") {
      throw new Error(`Falha sem histórico acionável: ${JSON.stringify(state.executionHistory)}`);
    }
  } finally {
    uninstall();
  }
});

Deno.test("runNurtureRunner não envia inscrições pausadas ou canceladas vencidas", async () => {
  const state = defaultState();
  seedHappyPath(state, { status: "paused" });
  seedHappyPath(state, { id: "enr-cancelled", status: "cancelled" });
  const uninstall = installFetchMock(router(state));
  try {
    const summary = await runNurtureRunner({ admin: newAdminClient() });
    if (summary.processed !== 0 || state.messageInserts.length !== 0) {
      throw new Error(`Inscrição interrompida foi enviada: ${JSON.stringify(summary)}`);
    }
  } finally {
    uninstall();
  }
});
