// Regressão dos achados 01b · H2 e 05 · H6 do code review de 10/08
// (docs/code-review/10-code-review-e2e-2026-08-10.md):
//
// H2 — `processClaimedEnrollment` tinha quatro guardas antes de enviar (janela,
//      supressão, frequência, "ainda reivindicada") e nenhuma olhava a fila de
//      atendimento humano. O lead pedia humano, `performHandoff` desligava a
//      conversa (`awaiting_human=true`), e o cron seguia disparando etapas por
//      cima do atendimento com `sender='automation'`.
// H6 — falha no bookkeeping pós-envio deixava a inscrição presa em `sending`
//      (o claim só pega `status='active'` e não há reaper) com o erro morrendo
//      num `console.error` que some junto com o isolate.
//
// Cobre também o controle positivo que o fix NÃO pode quebrar: conversa de
// automação nasce com `ai_active: false` (_shared/messaging/conversation.ts:66),
// então uma guarda escrita sobre `ai_active` barraria 100% da nutrição. É por
// isso que o campo checado é `awaiting_human`.
//
// Mesmo harness Deno (createClient real + installFetchMock) de
// nurture-runner.test.ts — ver docs/TESTING.md.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { BASE_ENV, type FetchMatcher, installFetchMock, jsonResponse, setEnv } from "./_helpers.ts";
import { type ClaimedEnrollment, processClaimedEnrollment } from "../nurture-runner/runner.ts";

setEnv(BASE_ENV);

const ZAPI_SEND_URL = "https://api.z-api.io/instances/inst-1/token/tok-1/send-text";
const HOUR_MS = 60 * 60 * 1000;

function newAdminClient() {
  return createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function stripOp(raw: string | null): string {
  return raw?.replace(/^[a-z.]+\./, "") ?? "";
}

/** Aberto 24/7: a janela de envio tem testes próprios em business-hours.test.ts. */
const SEMPRE_ABERTO = Object.fromEntries(
  ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [
    d,
    { enabled: true, open: "00:00", close: "24:00" },
  ]),
);

interface EnrollmentRow {
  id: string;
  tenant_id: string;
  sequence_id: string;
  contact_id: string;
  current_step: number;
  status: string;
  next_send_at: string | null;
  completed_at?: string | null;
  attempts: number;
}

interface MockState {
  enrollment: EnrollmentRow;
  /** `awaiting_human` da conversa reusada pelo findOrCreateConversation. */
  conversaAguardandoHumano: boolean;
  /** Faz o PATCH de bookkeeping (avanço de step) falhar — cenário do H6. */
  falharAvancoDeStep: boolean;
  enviosZapi: number;
  /** Leituras de integration_secrets: a guarda roda ANTES de carregar segredo. */
  leiturasDeSegredo: number;
  messageInserts: Record<string, unknown>[];
  systemEvents: Record<string, unknown>[];
}

function defaultState(): MockState {
  return {
    enrollment: {
      id: "enr-1",
      tenant_id: "tenant-1",
      sequence_id: "seq-1",
      contact_id: "contact-1",
      current_step: 0,
      status: "sending",
      next_send_at: new Date(Date.now() - 60_000).toISOString(),
      attempts: 0,
    },
    conversaAguardandoHumano: false,
    falharAvancoDeStep: false,
    enviosZapi: 0,
    leiturasDeSegredo: 0,
    messageInserts: [],
    systemEvents: [],
  };
}

function claimed(state: MockState): ClaimedEnrollment {
  const { id, tenant_id, sequence_id, contact_id, current_step, status, next_send_at, attempts } =
    state.enrollment;
  return {
    id,
    tenant_id,
    sequence_id,
    deal_id: null,
    contact_id,
    current_step,
    status,
    next_send_at,
    attempts,
  } as ClaimedEnrollment;
}

function router(state: MockState): FetchMatcher {
  return (r) => {
    const sp = new URL(r.url).searchParams;

    if (r.pathname === "/rest/v1/system_events" && r.method === "POST") {
      state.systemEvents.push(r.bodyJson as Record<string, unknown>);
      return jsonResponse(201, []);
    }

    // Releitura do status (aindaReivindicada).
    if (r.pathname === "/rest/v1/nurture_enrollments" && r.method === "GET") {
      return jsonResponse(200, { status: state.enrollment.status });
    }

    if (r.pathname === "/rest/v1/nurture_enrollments" && r.method === "PATCH") {
      if (state.falharAvancoDeStep) {
        return jsonResponse(500, { message: "deadlock detected", code: "40P01" });
      }
      Object.assign(state.enrollment, r.bodyJson as Record<string, unknown>);
      return jsonResponse(200, [{ id: state.enrollment.id }]);
    }

    if (r.pathname === "/rest/v1/tenants" && r.method === "GET") {
      return jsonResponse(200, { business_profile: { hours: SEMPRE_ABERTO } });
    }

    if (r.pathname === "/rest/v1/nurture_steps" && r.method === "GET") {
      const stepNumber = Number(stripOp(sp.get("step_number")));
      if (stepNumber !== 1) return jsonResponse(200, null);
      return jsonResponse(200, {
        step_number: 1,
        delay_hours: 1,
        message_template: "Oi {{contact.name}}!",
      });
    }

    if (r.pathname === "/rest/v1/contacts" && r.method === "GET") {
      return jsonResponse(200, {
        id: "contact-1",
        name: "Maria",
        phone: "5511999999999",
        email: null,
      });
    }

    if (r.pathname === "/rest/v1/messaging_phone_suppressions" && r.method === "GET") {
      return jsonResponse(200, []);
    }

    if (r.pathname === "/rest/v1/nurture_sequences" && r.method === "GET") {
      return jsonResponse(200, { channel_id: "chan-1" });
    }

    if (r.pathname === "/rest/v1/channels" && r.method === "GET") {
      return jsonResponse(200, { provider_slug: "zapi" });
    }

    if (r.pathname === "/rest/v1/integration_secrets" && r.method === "GET") {
      state.leiturasDeSegredo++;
      return jsonResponse(200, [
        { key: "instance_id", value: "inst-1" },
        { key: "instance_token", value: "tok-1" },
        { key: "client_token", value: "client-1" },
      ]);
    }

    if (r.url === ZAPI_SEND_URL && r.method === "POST") {
      state.enviosZapi++;
      return jsonResponse(200, { messageId: "ext-1" });
    }

    // conversations: duas leituras distintas no mesmo path.
    //  - filtro por id            -> guarda de atendimento humano (o fix do H2)
    //  - filtro por tenant/contact -> findOrCreateConversation
    if (r.pathname === "/rest/v1/conversations" && r.method === "GET") {
      if (sp.get("id")) {
        return jsonResponse(200, { awaiting_human: state.conversaAguardandoHumano });
      }
      // Conversa já existe (foi criada pelo inbound do lead) e é a mesma que o
      // performHandoff desligou — nasce com ai_active=false como toda conversa
      // tocada por automação.
      return jsonResponse(200, { id: "conv-1" });
    }
    if (r.pathname === "/rest/v1/conversations" && r.method === "PATCH") {
      return new Response(null, { status: 204 });
    }

    if (r.pathname === "/rest/v1/messages" && r.method === "POST") {
      state.messageInserts.push(r.bodyJson as Record<string, unknown>);
      return jsonResponse(201, { id: `msg-${state.messageInserts.length}` });
    }

    if (r.pathname === "/rest/v1/messages" && r.method === "HEAD") {
      return new Response(null, { status: 200, headers: { "content-range": "*/0" } });
    }

    return undefined;
  };
}

Deno.test("nurture: guarda de atendimento humano (01b · H2)", async (t) => {
  await t.step("conversa com awaiting_human=true não recebe envio, a inscrição é adiada", async () => {
    const state = defaultState();
    state.conversaAguardandoHumano = true;
    const uninstall = installFetchMock(router(state));
    try {
      const outcome = await processClaimedEnrollment({ admin: newAdminClient() }, claimed(state));

      if (outcome.kind !== "deferred_handoff") {
        throw new Error(`esperava deferred_handoff, veio ${outcome.kind}`);
      }
      if (state.enviosZapi !== 0) {
        throw new Error(
          `nutrição escreveu por cima do atendimento humano: ${state.enviosZapi} envio(s) ao provedor`,
        );
      }
      if (state.messageInserts.length !== 0) {
        throw new Error(
          `esperava nenhuma mensagem sender='automation' gravada, veio ${state.messageInserts.length}`,
        );
      }
      // Trava a ordem: a guarda tem que rodar ANTES de loadProviderSecrets.
      if (state.leiturasDeSegredo !== 0) {
        throw new Error(
          `guarda rodou depois de carregar segredo do provedor (${state.leiturasDeSegredo} leitura(s) de integration_secrets)`,
        );
      }
      // Pausa, não cancela: o handoff é temporário e a sequência precisa
      // sobreviver a ele.
      if (state.enrollment.status !== "active") {
        throw new Error(`esperava a inscrição de volta em 'active', veio ${state.enrollment.status}`);
      }
      const proximo = new Date(state.enrollment.next_send_at ?? 0).getTime();
      const delta = proximo - Date.now();
      if (delta < 5 * HOUR_MS || delta > 7 * HOUR_MS) {
        throw new Error(`esperava reagendamento ~6h à frente, veio ${Math.round(delta / HOUR_MS)}h`);
      }
    } finally {
      uninstall();
    }
  });

  // Controle positivo: sem ele, uma guarda escrita sobre `ai_active` (que é
  // false em TODA conversa de automação) passaria no teste acima e mataria a
  // nutrição inteira em produção.
  await t.step("conversa sem handoff continua enviando normalmente", async () => {
    const state = defaultState();
    state.conversaAguardandoHumano = false;
    const uninstall = installFetchMock(router(state));
    try {
      const outcome = await processClaimedEnrollment({ admin: newAdminClient() }, claimed(state));
      if (outcome.kind !== "sent") {
        throw new Error(`esperava sent, veio ${outcome.kind}`);
      }
      if (state.enviosZapi !== 1) {
        throw new Error(`esperava 1 envio ao provedor, veio ${state.enviosZapi}`);
      }
    } finally {
      uninstall();
    }
  });
});

Deno.test("nurture: inscrição presa em 'sending' vira evento consultável (05 · H6)", async () => {
  const state = defaultState();
  const uninstall = installFetchMock(router(state));
  try {
    // A mensagem sai; o bookkeeping seguinte é que falha.
    state.falharAvancoDeStep = false;
    const admin = newAdminClient();
    const enrollment = claimed(state);
    state.falharAvancoDeStep = true;
    const outcome = await processClaimedEnrollment({ admin }, enrollment);

    // O envio aconteceu de verdade: o resultado continua 'sent' (reverter para
    // 'active' reenviaria marketing já entregue).
    if (outcome.kind !== "sent") {
      throw new Error(`esperava sent, veio ${outcome.kind}`);
    }
    const stuck = state.systemEvents.find((e) => e.error_code === "enrollment_stuck_sending");
    if (!stuck) {
      throw new Error(
        `falha no avanço de step não gerou system_events consultável; eventos: ${
          JSON.stringify(state.systemEvents.map((e) => e.operation))
        }`,
      );
    }
    if (stuck.severity !== "error") {
      throw new Error(`esperava severity=error, veio ${stuck.severity}`);
    }
    if (stuck.tenant_id !== "tenant-1") {
      throw new Error(`esperava tenant_id preenchido, veio ${stuck.tenant_id}`);
    }
    const ctx = stuck.context as Record<string, unknown>;
    if (ctx?.enrollment_id !== "enr-1") {
      throw new Error(`esperava enrollment_id no contexto, veio ${JSON.stringify(ctx)}`);
    }
  } finally {
    uninstall();
  }
});
