// Testa notifyAdminHandoff (supabase/functions/_shared/ai/notify-admin-handoff.ts):
// sem destinatário ativo é no-op silencioso (nunca chama o Resend); com
// destinatário, busca a credencial e chama sendResend com o corpo esperado
// (conversationId + reason); qualquer falha (cooldown, query de
// destinatários, credencial, envio) nunca lança e é reportada via
// captureEdgeError (system_events) — mesmo padrão defensivo de
// failure-log.test.ts.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import {
  BASE_ENV,
  emptyResponse,
  type FetchMatcher,
  installFetchMock,
  jsonResponse,
  setEnv,
} from "./_helpers.ts";
import { notifyAdminHandoff } from "../_shared/ai/notify-admin-handoff.ts";
import { finalizeAiReply } from "../_shared/ai/send-dispatch.ts";

setEnv(BASE_ENV);

function newAdminClient() {
  return createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const RESEND_CRED = [
  { key: "api_key", value: "re_test_key" },
  { key: "from_domain", value: "acme.com" },
];

function realConversationRoute(req: { pathname: string; method: string }): Response | undefined {
  if (req.pathname === "/rest/v1/conversations" && req.method === "GET") {
    return jsonResponse(200, {
      channels: { tenant_id: "tenant-1", type: "whatsapp", provider_slug: "zapi" },
    });
  }
  return undefined;
}

// Sem cooldown ativo (hitl_handoff_sla_events vazio) — usado na maioria dos
// testes, que não são especificamente sobre o throttle (ver
// notifyAdminHandoff-cooldown mais abaixo).
function noCooldownRoute(req: { pathname: string; method: string }): Response | undefined {
  if (req.pathname === "/rest/v1/hitl_handoff_sla_events" && req.method === "GET") {
    return jsonResponse(200, []);
  }
  return realConversationRoute(req);
}

Deno.test("notifyAdminHandoff", async (t) => {
  await t.step("sem destinatário ativo: no-op silencioso, nunca chama o Resend", async () => {
    const router: FetchMatcher = (req) => {
      const cooldown = noCooldownRoute(req);
      if (cooldown) return cooldown;
      if (req.pathname === "/rest/v1/weekly_report_recipients" && req.method === "GET") {
        return jsonResponse(200, []);
      }
      if (req.url.includes("api.resend.com")) {
        throw new Error("não deveria chamar o Resend sem nenhum destinatário ativo");
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const admin = newAdminClient();
      await notifyAdminHandoff(admin, "tenant-1", "conv-1", "generation_failed");
    } finally {
      uninstall();
    }
  });

  await t.step(
    "com destinatário ativo: busca a credencial do Resend e chama sendResend com conversationId + reason",
    async () => {
      let recipientsQuery: URLSearchParams | null = null;
      let resendBody: Record<string, unknown> | null = null;
      const router: FetchMatcher = (req) => {
        const cooldown = noCooldownRoute(req);
        if (cooldown) return cooldown;
        if (req.pathname === "/rest/v1/weekly_report_recipients" && req.method === "GET") {
          recipientsQuery = new URL(req.url).searchParams;
          return jsonResponse(200, [{ address: "admin@acme.com" }]);
        }
        if (req.pathname === "/rest/v1/integration_secrets" && req.method === "GET") {
          return jsonResponse(200, RESEND_CRED);
        }
        if (req.url === "https://api.resend.com/emails" && req.method === "POST") {
          resendBody = req.bodyJson as Record<string, unknown>;
          return jsonResponse(200, { id: "email-1" });
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const admin = newAdminClient();
        await notifyAdminHandoff(admin, "tenant-1", "conv-42", "takeover_blocked_operator_active");

        if (!recipientsQuery) {
          throw new Error("query em weekly_report_recipients não foi capturada");
        }
        const q = recipientsQuery as URLSearchParams;
        if (q.get("tenant_id") !== "eq.tenant-1") {
          throw new Error(`tenant_id=${q.get("tenant_id")}`);
        }
        if (q.get("channel") !== "eq.email") throw new Error(`channel=${q.get("channel")}`);
        if (q.get("active") !== "eq.true") throw new Error(`active=${q.get("active")}`);

        if (!resendBody) throw new Error("sendResend não foi chamado");
        const body = resendBody as { to?: string[]; subject?: string; text?: string };
        if (!body.to?.includes("admin@acme.com")) throw new Error(`to=${JSON.stringify(body.to)}`);
        if (!body.subject) throw new Error("subject vazio");
        if (!body.text?.includes("conv-42")) {
          throw new Error(`corpo do e-mail não menciona a conversa: ${body.text}`);
        }
        if (!body.text?.includes("takeover_blocked_operator_active")) {
          throw new Error(`corpo do e-mail não menciona o motivo: ${body.text}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "vários destinatários ativos: chama sendResend uma vez por destinatário",
    async () => {
      const sentTo: string[] = [];
      const router: FetchMatcher = (req) => {
        const cooldown = noCooldownRoute(req);
        if (cooldown) return cooldown;
        if (req.pathname === "/rest/v1/weekly_report_recipients" && req.method === "GET") {
          return jsonResponse(200, [{ address: "a@acme.com" }, { address: "b@acme.com" }]);
        }
        if (req.pathname === "/rest/v1/integration_secrets" && req.method === "GET") {
          return jsonResponse(200, RESEND_CRED);
        }
        if (req.url === "https://api.resend.com/emails" && req.method === "POST") {
          const body = req.bodyJson as { to?: string[] };
          sentTo.push(...(body.to ?? []));
          return jsonResponse(200, { id: `email-${sentTo.length}` });
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const admin = newAdminClient();
        await notifyAdminHandoff(admin, "tenant-1", "conv-1", "media_received");
        if (
          sentTo.length !== 2 ||
          !sentTo.includes("a@acme.com") ||
          !sentTo.includes("b@acme.com")
        ) {
          throw new Error(`sentTo=${JSON.stringify(sentTo)}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "Resend recusa o envio: não lança, reporta em system_events via captureEdgeError",
    async () => {
      let systemEventBody: Record<string, unknown> | null = null;
      const router: FetchMatcher = (req) => {
        const cooldown = noCooldownRoute(req);
        if (cooldown) return cooldown;
        if (req.pathname === "/rest/v1/weekly_report_recipients" && req.method === "GET") {
          return jsonResponse(200, [{ address: "admin@acme.com" }]);
        }
        if (req.pathname === "/rest/v1/integration_secrets" && req.method === "GET") {
          return jsonResponse(200, RESEND_CRED);
        }
        if (req.url === "https://api.resend.com/emails" && req.method === "POST") {
          return jsonResponse(500, { message: "resend indisponível" });
        }
        if (req.pathname === "/rest/v1/system_events" && req.method === "POST") {
          systemEventBody = req.bodyJson as Record<string, unknown>;
          return emptyResponse(201);
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const admin = newAdminClient();
        // Não deve lançar mesmo com o Resend recusando o envio (500).
        await notifyAdminHandoff(admin, "tenant-1", "conv-1", "generation_failed");

        if (!systemEventBody) throw new Error("captureEdgeError não reportou em system_events");
        const body = systemEventBody as Record<string, unknown>;
        if (body.operation !== "ai-respond.notify-admin-handoff") {
          throw new Error(`operation=${body.operation}`);
        }
        if (body.tenant_id !== "tenant-1") throw new Error(`tenant_id=${body.tenant_id}`);
        if (body.conversation_id !== "conv-1") {
          throw new Error(`conversation_id=${body.conversation_id}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "fetch do envio rejeita (rede fora do ar): não lança, reporta em system_events",
    async () => {
      let systemEventBody: Record<string, unknown> | null = null;
      const router: FetchMatcher = (req) => {
        const cooldown = noCooldownRoute(req);
        if (cooldown) return cooldown;
        if (req.pathname === "/rest/v1/weekly_report_recipients" && req.method === "GET") {
          return jsonResponse(200, [{ address: "admin@acme.com" }]);
        }
        if (req.pathname === "/rest/v1/integration_secrets" && req.method === "GET") {
          return jsonResponse(200, RESEND_CRED);
        }
        if (req.url === "https://api.resend.com/emails" && req.method === "POST") {
          throw new Error("network down");
        }
        if (req.pathname === "/rest/v1/system_events" && req.method === "POST") {
          systemEventBody = req.bodyJson as Record<string, unknown>;
          return emptyResponse(201);
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const admin = newAdminClient();
        await notifyAdminHandoff(admin, "tenant-1", "conv-1", "media_received");

        if (!systemEventBody) throw new Error("captureEdgeError não reportou em system_events");
        const body = systemEventBody as Record<string, unknown>;
        if (body.operation !== "ai-respond.notify-admin-handoff") {
          throw new Error(`operation=${body.operation}`);
        }
        if (typeof body.message !== "string" || !body.message.includes("network down")) {
          throw new Error(`message não menciona a exceção original: ${JSON.stringify(body)}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "query de destinatários falha: não lança, não chega a buscar credencial nem a enviar, reporta em system_events",
    async () => {
      let systemEventBody: Record<string, unknown> | null = null;
      const router: FetchMatcher = (req) => {
        const cooldown = noCooldownRoute(req);
        if (cooldown) return cooldown;
        if (req.pathname === "/rest/v1/weekly_report_recipients" && req.method === "GET") {
          return jsonResponse(500, { message: "db indisponível" });
        }
        if (req.pathname === "/rest/v1/integration_secrets") {
          throw new Error("não deveria buscar credencial sem saber se há destinatário");
        }
        if (req.url.includes("api.resend.com")) {
          throw new Error("não deveria chamar o Resend");
        }
        if (req.pathname === "/rest/v1/system_events" && req.method === "POST") {
          systemEventBody = req.bodyJson as Record<string, unknown>;
          return emptyResponse(201);
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const admin = newAdminClient();
        await notifyAdminHandoff(admin, "tenant-1", "conv-1", "generation_failed");

        if (!systemEventBody) throw new Error("captureEdgeError não reportou em system_events");
        const body = systemEventBody as Record<string, unknown>;
        if (body.operation !== "ai-respond.notify-admin-handoff") {
          throw new Error(`operation=${body.operation}`);
        }
        if (typeof body.message !== "string" || !body.message.includes("destinatários")) {
          throw new Error(`message não menciona a falha de query: ${JSON.stringify(body)}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "credencial do Resend não configurada: sendResend recusa, não lança, reporta em system_events",
    async () => {
      let systemEventBody: Record<string, unknown> | null = null;
      const router: FetchMatcher = (req) => {
        const cooldown = noCooldownRoute(req);
        if (cooldown) return cooldown;
        if (req.pathname === "/rest/v1/weekly_report_recipients" && req.method === "GET") {
          return jsonResponse(200, [{ address: "admin@acme.com" }]);
        }
        if (req.pathname === "/rest/v1/integration_secrets" && req.method === "GET") {
          return jsonResponse(200, []); // sem credenciais -> sendResend recusa o envio
        }
        if (req.url.includes("api.resend.com")) {
          throw new Error("não deveria chamar o Resend sem credencial configurada");
        }
        if (req.pathname === "/rest/v1/system_events" && req.method === "POST") {
          systemEventBody = req.bodyJson as Record<string, unknown>;
          return emptyResponse(201);
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const admin = newAdminClient();
        await notifyAdminHandoff(admin, "tenant-1", "conv-1", "generation_failed");

        if (!systemEventBody) throw new Error("captureEdgeError não reportou em system_events");
        const body = systemEventBody as Record<string, unknown>;
        if (body.operation !== "ai-respond.notify-admin-handoff") {
          throw new Error(`operation=${body.operation}`);
        }
        if (typeof body.message !== "string" || !body.message.includes("Resend")) {
          throw new Error(`message não menciona a recusa do sendResend: ${JSON.stringify(body)}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "credencial do Resend: query real falha (loadSecrets lança) — cai no branch de credenciais, reporta em system_events",
    async () => {
      // Diferente do teste acima ("credencial não configurada", que devolve
      // 200 OK com array vazio e cai no branch de ENVIO — sendResend recusa
      // por falta de api_key/from_domain): aqui a query em si falha (500),
      // loadSecrets (send-adapters.ts) propaga um Error real, exercitando o
      // branch `catch (credErr)` / phase: "credentials" de notifyAdminHandoff
      // — nunca testado antes.
      let systemEventBody: Record<string, unknown> | null = null;
      const router: FetchMatcher = (req) => {
        const cooldown = noCooldownRoute(req);
        if (cooldown) return cooldown;
        if (req.pathname === "/rest/v1/weekly_report_recipients" && req.method === "GET") {
          return jsonResponse(200, [{ address: "admin@acme.com" }]);
        }
        if (req.pathname === "/rest/v1/integration_secrets" && req.method === "GET") {
          return jsonResponse(500, { message: "db indisponível" });
        }
        if (req.url.includes("api.resend.com")) {
          throw new Error("não deveria chamar o Resend sem conseguir carregar a credencial");
        }
        if (req.pathname === "/rest/v1/system_events" && req.method === "POST") {
          systemEventBody = req.bodyJson as Record<string, unknown>;
          return emptyResponse(201);
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const admin = newAdminClient();
        await notifyAdminHandoff(admin, "tenant-1", "conv-1", "generation_failed");

        if (!systemEventBody) throw new Error("captureEdgeError não reportou em system_events");
        const body = systemEventBody as Record<string, unknown>;
        if (body.operation !== "ai-respond.notify-admin-handoff") {
          throw new Error(`operation=${body.operation}`);
        }
        const context = body.context as Record<string, unknown> | undefined;
        if (context?.phase !== "credentials") {
          throw new Error(`esperava phase=credentials, veio ${JSON.stringify(body)}`);
        }
        if (
          typeof body.message !== "string" ||
          !body.message.includes("Falha ao carregar credenciais")
        ) {
          throw new Error(`message não veio de loadSecrets: ${JSON.stringify(body)}`);
        }
      } finally {
        uninstall();
      }
    },
  );
});

// -------------------- Cooldown / throttle (item 5) --------------------

Deno.test("notifyAdminHandoff — cooldown", async (t) => {
  await t.step(
    "já existe outro evento de handoff recente (além do atual): pula o e-mail, só loga",
    async () => {
      let recipientsQueried = false;
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/hitl_handoff_sla_events" && req.method === "GET") {
          // 2 eventos na janela (o atual + um anterior) → cooldown ativo.
          return jsonResponse(200, [{ id: "evt-2" }, { id: "evt-1" }]);
        }
        if (req.pathname === "/rest/v1/weekly_report_recipients" && req.method === "GET") {
          recipientsQueried = true;
          return jsonResponse(200, []);
        }
        return realConversationRoute(req);
      };
      const uninstall = installFetchMock(router);
      try {
        const admin = newAdminClient();
        await notifyAdminHandoff(admin, "tenant-1", "conv-1", "generation_failed");
        if (recipientsQueried) {
          throw new Error("cooldown ativo não deveria seguir para a busca de destinatários");
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "só o evento da própria transição (1 evento na janela): NÃO ativa cooldown, segue e notifica",
    async () => {
      let recipientsQueried = false;
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/hitl_handoff_sla_events" && req.method === "GET") {
          return jsonResponse(200, [{ id: "evt-1" }]);
        }
        if (req.pathname === "/rest/v1/weekly_report_recipients" && req.method === "GET") {
          recipientsQueried = true;
          return jsonResponse(200, []);
        }
        return realConversationRoute(req);
      };
      const uninstall = installFetchMock(router);
      try {
        const admin = newAdminClient();
        await notifyAdminHandoff(admin, "tenant-1", "conv-1", "generation_failed");
        if (!recipientsQueried) {
          throw new Error("deveria seguir para a busca de destinatários sem cooldown ativo");
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "query de cooldown falha (fail-open): não lança, segue e notifica normalmente",
    async () => {
      let recipientsQueried = false;
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/hitl_handoff_sla_events" && req.method === "GET") {
          return jsonResponse(500, { message: "db indisponível" });
        }
        if (req.pathname === "/rest/v1/weekly_report_recipients" && req.method === "GET") {
          recipientsQueried = true;
          return jsonResponse(200, []);
        }
        if (req.pathname === "/rest/v1/system_events" && req.method === "POST") {
          return emptyResponse(201);
        }
        return realConversationRoute(req);
      };
      const uninstall = installFetchMock(router);
      try {
        const admin = newAdminClient();
        await notifyAdminHandoff(admin, "tenant-1", "conv-1", "generation_failed");
        if (!recipientsQueried) {
          throw new Error("fail-open deveria seguir para a busca de destinatários mesmo com erro");
        }
      } finally {
        uninstall();
      }
    },
  );
  await t.step(
    "Resend recusa com 400: mensagem é de recusa permanente e o corpo do erro é logado redigido",
    async () => {
      // Gêmeo do H12 corrigido em _shared/messaging/provider-send.ts: aqui o
      // caminho vivo é sendResend (só ele tem importador). Sem o fix, o 400 caía
      // no genérico "tente novamente" e o motivo real do Resend era descartado.
      const logs: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => {
        logs.push(args.map((a) => String(a)).join(" "));
      };
      let systemEventBody: Record<string, unknown> | null = null;
      const router: FetchMatcher = (req) => {
        const cooldown = noCooldownRoute(req);
        if (cooldown) return cooldown;
        if (req.pathname === "/rest/v1/weekly_report_recipients" && req.method === "GET") {
          return jsonResponse(200, [{ address: "admin@acme.com" }]);
        }
        if (req.pathname === "/rest/v1/integration_secrets" && req.method === "GET") {
          return jsonResponse(200, RESEND_CRED);
        }
        if (req.url === "https://api.resend.com/emails" && req.method === "POST") {
          // Corpo real do Resend numa recusa, com um segredo no meio para
          // provar que a redação acontece antes do log.
          return jsonResponse(400, {
            message: "The from address is not verified. api_key=re_1234567890abcdef",
            name: "validation_error",
          });
        }
        if (req.pathname === "/rest/v1/system_events" && req.method === "POST") {
          systemEventBody = req.bodyJson as Record<string, unknown>;
          return emptyResponse(201);
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const admin = newAdminClient();
        await notifyAdminHandoff(admin, "tenant-1", "conv-400", "generation_failed");

        const linhaDoProvider = logs.find((l) => l.includes("[send-adapters] resend"));
        if (!linhaDoProvider) {
          throw new Error(`corpo do erro do Resend não foi logado: ${JSON.stringify(logs)}`);
        }
        if (!linhaDoProvider.includes("from address is not verified")) {
          throw new Error(`log não traz o motivo real: ${linhaDoProvider}`);
        }
        if (linhaDoProvider.includes("re_1234567890abcdef")) {
          throw new Error(`segredo vazou no log: ${linhaDoProvider}`);
        }
        if (!systemEventBody) throw new Error("a recusa não foi reportada em system_events");
        const msg = String((systemEventBody as Record<string, unknown>).message ?? "");
        if (/tente novamente/i.test(msg)) {
          throw new Error(`400 é recusa permanente, não pode pedir retry: ${msg}`);
        }
      } finally {
        uninstall();
        console.error = originalError;
      }
    },
  );

  await t.step(
    "Resend recusa com status HTTP desconhecido (ex.: 402): mensagem inclui status e corpo redigido",
    async () => {
      // Mesmo padrão do teste de 400 acima, mas para o ramo genérico de
      // friendlyHttp (nenhum status conhecido) — antes descartava status e
      // corpo (docs/PLANO-OBSERVABILIDADE-2026-08-04.md).
      let systemEventBody: Record<string, unknown> | null = null;
      const router: FetchMatcher = (req) => {
        const cooldown = noCooldownRoute(req);
        if (cooldown) return cooldown;
        if (req.pathname === "/rest/v1/weekly_report_recipients" && req.method === "GET") {
          return jsonResponse(200, [{ address: "admin@acme.com" }]);
        }
        if (req.pathname === "/rest/v1/integration_secrets" && req.method === "GET") {
          return jsonResponse(200, RESEND_CRED);
        }
        if (req.url === "https://api.resend.com/emails" && req.method === "POST") {
          return new Response("saldo insuficiente (token: re_1234567890abcdef)", { status: 402 });
        }
        if (req.pathname === "/rest/v1/system_events" && req.method === "POST") {
          systemEventBody = req.bodyJson as Record<string, unknown>;
          return emptyResponse(201);
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const admin = newAdminClient();
        await notifyAdminHandoff(admin, "tenant-1", "conv-402", "generation_failed");

        if (!systemEventBody) throw new Error("a recusa não foi reportada em system_events");
        const msg = String((systemEventBody as Record<string, unknown>).message ?? "");
        if (!msg.includes("402")) {
          throw new Error(`mensagem não traz o status HTTP: ${msg}`);
        }
        if (!msg.includes("saldo insuficiente")) {
          throw new Error(`mensagem não traz o corpo do provedor: ${msg}`);
        }
        if (msg.includes("re_1234567890abcdef")) {
          throw new Error(`segredo vazou na mensagem: ${msg}`);
        }
      } finally {
        uninstall();
      }
    },
  );
});

Deno.test("simulador em draft preserva handoff local sem e-mail externo com Resend configurado", async () => {
  let externalFetches = 0;
  let draft: Record<string, unknown> | null = null;
  let handoff: Record<string, unknown> | null = null;
  let conversationQuery: URLSearchParams | null = null;
  const router: FetchMatcher = (req) => {
    if (new URL(req.url).origin !== new URL(BASE_ENV.SUPABASE_URL).origin) {
      externalFetches++;
      throw new Error("A simulação não pode disparar entrega externa.");
    }
    if (req.pathname === "/rest/v1/messages") {
      if (req.method === "GET") return jsonResponse(200, []);
      if (req.method === "POST") {
        draft = req.bodyJson as Record<string, unknown>;
        return jsonResponse(201, { id: "draft-1" });
      }
    }
    if (req.pathname === "/rest/v1/conversations") {
      if (req.method === "GET") {
        conversationQuery = new URL(req.url).searchParams;
        return jsonResponse(200, {
          channels: { tenant_id: "tenant-1", provider_slug: "simulator", type: "simulator" },
        });
      }
      if (req.method === "PATCH") {
        handoff = req.bodyJson as Record<string, unknown>;
        return emptyResponse(204);
      }
    }
    if (req.pathname === "/rest/v1/weekly_report_recipients") {
      return jsonResponse(200, [{ address: "admin@acme.com" }]);
    }
    if (req.pathname === "/rest/v1/integration_secrets") {
      return jsonResponse(200, RESEND_CRED);
    }
    if (req.pathname === "/rest/v1/system_events") return emptyResponse(201);
    return noCooldownRoute(req);
  };
  const uninstall = installFetchMock(router);
  try {
    const result = await finalizeAiReply({
      admin: newAdminClient(),
      tenantId: "tenant-1",
      conversationId: "conv-simulator",
      contactId: "contact-1",
      dealId: null,
      aiText: "Sua resposta está pronta para revisão humana.",
      sendMode: "draft",
      providerSlug: "simulator",
      contactPhone: null,
      contactEmail: null,
      subject: null,
      previousAwaitingHuman: false,
      voice: null,
    });
    if (externalFetches !== 0) {
      throw new Error(`A simulação tentou ${externalFetches} entrega(s) externa(s).`);
    }
    if (result.kind !== "draft" || result.id !== "draft-1") {
      throw new Error(`Rascunho local não foi preservado: ${JSON.stringify(result)}`);
    }
    if ((draft as Record<string, unknown> | null)?.status !== "draft") {
      throw new Error("A mensagem local precisa continuar como draft.");
    }
    if ((handoff as Record<string, unknown> | null)?.awaiting_human !== true) {
      throw new Error("O atendimento humano local precisa continuar sinalizado.");
    }
    const query = conversationQuery as URLSearchParams | null;
    if (query?.get("id") !== "eq.conv-simulator" || query?.get("tenant_id") !== "eq.tenant-1") {
      throw new Error("O canal precisa ser resolvido pela conversa e pelo tenant.");
    }
  } finally {
    uninstall();
  }
});

for (const channel of [
  { provider_slug: "simulator", type: "whatsapp" },
  { provider_slug: "zapi", type: "simulator" },
]) {
  Deno.test(`simulador não notifica quando identificado por ${JSON.stringify(channel)}`, async () => {
    let externalFetches = 0;
    const router: FetchMatcher = (req) => {
      if (new URL(req.url).origin !== new URL(BASE_ENV.SUPABASE_URL).origin) {
        externalFetches++;
        throw new Error("Canal simulado não pode enviar e-mail.");
      }
      if (req.pathname === "/rest/v1/conversations" && req.method === "GET") {
        return jsonResponse(200, { channels: { tenant_id: "tenant-1", ...channel } });
      }
      if (req.pathname === "/rest/v1/weekly_report_recipients") {
        return jsonResponse(200, [{ address: "admin@acme.com" }]);
      }
      if (req.pathname === "/rest/v1/integration_secrets") {
        return jsonResponse(200, RESEND_CRED);
      }
      if (req.pathname === "/rest/v1/system_events") return emptyResponse(201);
      return noCooldownRoute(req);
    };
    const uninstall = installFetchMock(router);
    try {
      await notifyAdminHandoff(newAdminClient(), "tenant-1", "conv-simulator", "media_received");
      if (externalFetches !== 0) throw new Error(`Envios externos indevidos: ${externalFetches}`);
    } finally {
      uninstall();
    }
  });
}

for (const scenario of [
  { name: "canal ausente", status: 200, body: { channels: null } },
  {
    name: "canal de outro tenant",
    status: 200,
    body: { channels: { tenant_id: "tenant-2", type: "whatsapp", provider_slug: "zapi" } },
  },
  { name: "falha ao consultar canal", status: 500, body: { message: "consulta indisponível" } },
]) {
  Deno.test(`handoff não entrega externamente com ${scenario.name}`, async () => {
    let recipientsQueried = false;
    let failure: Record<string, unknown> | null = null;
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/conversations" && req.method === "GET") {
        return jsonResponse(scenario.status, scenario.body);
      }
      if (req.pathname === "/rest/v1/weekly_report_recipients") {
        recipientsQueried = true;
        return jsonResponse(200, []);
      }
      if (req.pathname === "/rest/v1/system_events" && req.method === "POST") {
        failure = req.bodyJson as Record<string, unknown>;
        return emptyResponse(201);
      }
      return noCooldownRoute(req);
    };
    const uninstall = installFetchMock(router);
    try {
      await notifyAdminHandoff(newAdminClient(), "tenant-1", "conv-1", "generation_failed");
      if (recipientsQueried) throw new Error("Falha na identificação do canal precisa ser fail-closed.");
      if (!failure) throw new Error("A falha ao identificar o canal precisa ficar registrada.");
    } finally {
      uninstall();
    }
  });
}
