// Testa direto as funções exportadas de send-dispatch.ts (finalizeAiReply,
// dispatchAiSend) — 1 caso feliz + 1 caso de erro relevante por função.
// ai-respond.test.ts já cobre o encadeamento completo via mock do
// Deno.serve; este arquivo isola qual função quebrou quando algo falhar.
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { BASE_ENV, type FetchMatcher, installFetchMock, jsonResponse, setEnv } from "./_helpers.ts";
import {
  dispatchAiSend,
  capEmoji,
  contarEmojis,
  dropRepeatedQuestion,
  dropTrailingQuestion,
  probabilidadeCorrigida,
  extrairUltimaPergunta,
  finalizeAiReply,
  splitIntoBubbles,
} from "../_shared/ai/send-dispatch.ts";
import type { Rng } from "../_shared/ai/send-dispatch.ts";

setEnv(BASE_ENV);

function newAdminClient() {
  return createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const ZAPI_SEND_URL = "https://api.z-api.io/instances/inst-1/token/tok-1/send-text";
const ZAPPAZ_SEND_URL = "https://api.zappaz.io/api/v1/session/sess-1/message/text";
const ZAPPAZ_AUDIO_URL = "https://api.zappaz.io/api/v1/session/sess-1/message/audio";

// -------------------- finalizeAiReply --------------------

Deno.test("finalizeAiReply", async (t) => {
  await t.step(
    "modo draft: grava status=draft e marca awaiting_human, sem tentar envio",
    async () => {
      let awaitingHumanPatch: Record<string, unknown> | null = null;
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/messages" && req.method === "POST") {
          return jsonResponse(201, { id: "msg-draft-1" });
        }
        if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
          awaitingHumanPatch = req.bodyJson as Record<string, unknown>;
          return jsonResponse(200, {});
        }
        // Sem rota externa mockada — modo draft nunca deve tentar envio.
        if (req.url === ZAPI_SEND_URL) throw new Error("draft não deveria disparar envio externo");
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const result = await finalizeAiReply({
          admin: newAdminClient(),
          tenantId: "tenant-1",
          conversationId: "conv-1",
          contactId: "contact-1",
          dealId: null,
          aiText: "Olá! Como posso ajudar?",
          sendMode: "draft",
          providerSlug: "zapi",
          contactPhone: "5511999999999",
          contactEmail: null,
          subject: null,
          previousAwaitingHuman: true,
        });
        if (result.kind !== "draft" || result.id !== "msg-draft-1") {
          throw new Error(`resultado inesperado: ${JSON.stringify(result)}`);
        }
        if (!awaitingHumanPatch) throw new Error("PATCH em conversations não foi capturado");
        const patchBody = awaitingHumanPatch as Record<string, unknown>;
        if (patchBody.awaiting_human !== true) {
          throw new Error(`awaiting_human não setado: ${JSON.stringify(patchBody)}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  // O rascunho não sintetiza áudio. Antes o pedido de voz sumia sem rastro:
  // `messages` não distingue rascunho de voz de rascunho de texto e nenhuma
  // linha ia para ai_failure_logs, então "configurei voz e chegou texto" não
  // tinha explicação em lugar nenhum. Os dois passos abaixo andam em par — o
  // segundo é o controle negativo, sem ele o primeiro passaria com um
  // reportVoiceFallback disparando em TODO rascunho.
  await t.step("modo draft com voz pedida: registra o descarte em ai_failure_logs", async () => {
    const failureRows: Array<Record<string, unknown>> = [];
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/messages" && req.method === "POST") {
        return jsonResponse(201, { id: "msg-draft-voice-1" });
      }
      if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
        return jsonResponse(200, {});
      }
      if (req.pathname === "/rest/v1/ai_failure_logs" && req.method === "POST") {
        failureRows.push(req.bodyJson as Record<string, unknown>);
        return jsonResponse(201, {});
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await finalizeAiReply({
        admin: newAdminClient(),
        tenantId: "tenant-1",
        conversationId: "conv-1",
        contactId: "contact-1",
        dealId: null,
        aiText: "Olá! Como posso ajudar?",
        sendMode: "draft",
        providerSlug: "zapi",
        contactPhone: "5511999999999",
        contactEmail: null,
        subject: null,
        previousAwaitingHuman: true,
        voice: { apiKey: "k-1", voiceId: "v-1" },
      });
      if (result.kind !== "draft") {
        throw new Error(`resultado inesperado: ${JSON.stringify(result)}`);
      }
      if (failureRows.length !== 1) {
        throw new Error(`esperava 1 linha em ai_failure_logs, veio ${failureRows.length}`);
      }
      const ctx = failureRows[0].context as Record<string, unknown> | undefined;
      if (ctx?.phase !== "voice_fallback" || ctx?.reason !== "modo_rascunho") {
        throw new Error(`context inesperado: ${JSON.stringify(failureRows[0].context)}`);
      }
      // Sem tenant/conversa o log é inútil num app multi-tenant — mesmo
      // contrato dos outros três motivos de fallback de voz.
      if (failureRows[0].tenant_id !== "tenant-1" || ctx?.conversationId !== "conv-1") {
        throw new Error(`correlação faltando: ${JSON.stringify(failureRows[0])}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("modo draft sem voz: NÃO registra fallback de voz", async () => {
    const failureRows: Array<Record<string, unknown>> = [];
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/messages" && req.method === "POST") {
        return jsonResponse(201, { id: "msg-draft-novoice-1" });
      }
      if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
        return jsonResponse(200, {});
      }
      if (req.pathname === "/rest/v1/ai_failure_logs" && req.method === "POST") {
        failureRows.push(req.bodyJson as Record<string, unknown>);
        return jsonResponse(201, {});
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      await finalizeAiReply({
        admin: newAdminClient(),
        tenantId: "tenant-1",
        conversationId: "conv-1",
        contactId: "contact-1",
        dealId: null,
        aiText: "Olá! Como posso ajudar?",
        sendMode: "draft",
        providerSlug: "zapi",
        contactPhone: "5511999999999",
        contactEmail: null,
        subject: null,
        previousAwaitingHuman: true,
      });
      if (failureRows.length !== 0) {
        throw new Error(`rascunho sem voz não deveria logar: ${JSON.stringify(failureRows)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("falha ao gravar o rascunho: kind=insert_failed, marca last_error", async () => {
    let errorPatch: Record<string, unknown> | null = null;
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/messages" && req.method === "POST") {
        return jsonResponse(500, { message: "db indisponível" });
      }
      if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
        errorPatch = req.bodyJson as Record<string, unknown>;
        return jsonResponse(200, {});
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await finalizeAiReply({
        admin: newAdminClient(),
        tenantId: "tenant-1",
        conversationId: "conv-2",
        contactId: "contact-1",
        dealId: null,
        aiText: "texto",
        sendMode: "draft",
        providerSlug: "zapi",
        contactPhone: "5511999999999",
        contactEmail: null,
        subject: null,
        previousAwaitingHuman: true,
      });
      if (result.kind !== "insert_failed") {
        throw new Error(`resultado inesperado: ${JSON.stringify(result)}`);
      }
      if (!errorPatch) throw new Error("PATCH em conversations não foi capturado");
      const patchBody = errorPatch as Record<string, unknown>;
      if (!patchBody.last_error) {
        throw new Error(`last_error não setado: ${JSON.stringify(patchBody)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "modo draft, previousAwaitingHuman=false: notifica admin (reason draft_pending_approval)",
    async () => {
      // Flag síncrona em vez de throw-no-matcher (notifyAdminHandoff nunca
      // propaga exceção, by design — um throw no matcher seria sempre
      // engolido e o teste passaria mesmo sem o e-mail disparar de verdade).
      // Mesmo padrão de gates.test.ts (linha ~325).
      let notifiedRecipientsQuery = false;
      let resendCalled = false;
      let resendBody: Record<string, unknown> | null = null;
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/conversations" && req.method === "GET") {
          return jsonResponse(200, {
            channels: { tenant_id: "tenant-1", provider_slug: "zapi", type: "whatsapp" },
          });
        }
        if (req.pathname === "/rest/v1/messages" && req.method === "POST") {
          return jsonResponse(201, { id: "msg-draft-notify-1" });
        }
        if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
          return jsonResponse(200, {});
        }
        if (req.pathname === "/rest/v1/hitl_handoff_sla_events" && req.method === "GET") {
          return jsonResponse(200, []); // sem cooldown ativo
        }
        if (req.pathname === "/rest/v1/weekly_report_recipients" && req.method === "GET") {
          notifiedRecipientsQuery = true;
          return jsonResponse(200, [{ address: "admin@acme.com" }]);
        }
        if (req.pathname === "/rest/v1/integration_secrets" && req.method === "GET") {
          return jsonResponse(200, [
            { key: "api_key", value: "re_test" },
            { key: "from_domain", value: "acme.com" },
          ]);
        }
        if (req.url === "https://api.resend.com/emails" && req.method === "POST") {
          resendCalled = true;
          resendBody = req.bodyJson as Record<string, unknown>;
          return jsonResponse(200, { id: "email-1" });
        }
        // Modo draft nunca deve tentar envio externo pelo canal da conversa.
        if (req.url === ZAPI_SEND_URL) throw new Error("draft não deveria disparar envio externo");
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const result = await finalizeAiReply({
          admin: newAdminClient(),
          tenantId: "tenant-1",
          conversationId: "conv-notify-draft",
          contactId: "contact-1",
          dealId: null,
          aiText: "texto",
          sendMode: "draft",
          providerSlug: "zapi",
          contactPhone: "5511999999999",
          contactEmail: null,
          subject: null,
          previousAwaitingHuman: false,
        });
        if (result.kind !== "draft" || result.id !== "msg-draft-notify-1") {
          throw new Error(`resultado inesperado: ${JSON.stringify(result)}`);
        }
        if (!notifiedRecipientsQuery) {
          throw new Error("notifyAdminHandoff não consultou destinatários");
        }
        if (!resendCalled) throw new Error("notifyAdminHandoff não chamou o Resend");
        const body = resendBody as Record<string, unknown> | null;
        if (
          !body || typeof body.text !== "string" || !body.text.includes("draft_pending_approval")
        ) {
          throw new Error(`reason não propagado ao corpo do e-mail: ${JSON.stringify(body)}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "falha ao gravar o rascunho, previousAwaitingHuman=false: notifica admin (reason persist_failed)",
    async () => {
      let notifiedRecipientsQuery = false;
      let resendCalled = false;
      let resendBody: Record<string, unknown> | null = null;
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/conversations" && req.method === "GET") {
          return jsonResponse(200, {
            channels: { tenant_id: "tenant-1", provider_slug: "zapi", type: "whatsapp" },
          });
        }
        if (req.pathname === "/rest/v1/messages" && req.method === "POST") {
          return jsonResponse(500, { message: "db indisponível" });
        }
        if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
          return jsonResponse(200, {});
        }
        if (req.pathname === "/rest/v1/hitl_handoff_sla_events" && req.method === "GET") {
          return jsonResponse(200, []); // sem cooldown ativo
        }
        if (req.pathname === "/rest/v1/weekly_report_recipients" && req.method === "GET") {
          notifiedRecipientsQuery = true;
          return jsonResponse(200, [{ address: "admin@acme.com" }]);
        }
        if (req.pathname === "/rest/v1/integration_secrets" && req.method === "GET") {
          return jsonResponse(200, [
            { key: "api_key", value: "re_test" },
            { key: "from_domain", value: "acme.com" },
          ]);
        }
        if (req.url === "https://api.resend.com/emails" && req.method === "POST") {
          resendCalled = true;
          resendBody = req.bodyJson as Record<string, unknown>;
          return jsonResponse(200, { id: "email-1" });
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const result = await finalizeAiReply({
          admin: newAdminClient(),
          tenantId: "tenant-1",
          conversationId: "conv-notify-insert-fail",
          contactId: "contact-1",
          dealId: null,
          aiText: "texto",
          sendMode: "draft",
          providerSlug: "zapi",
          contactPhone: "5511999999999",
          contactEmail: null,
          subject: null,
          previousAwaitingHuman: false,
        });
        if (result.kind !== "insert_failed") {
          throw new Error(`resultado inesperado: ${JSON.stringify(result)}`);
        }
        if (!notifiedRecipientsQuery) {
          throw new Error("notifyAdminHandoff não consultou destinatários");
        }
        if (!resendCalled) throw new Error("notifyAdminHandoff não chamou o Resend");
        const body = resendBody as Record<string, unknown> | null;
        if (!body || typeof body.text !== "string" || !body.text.includes("persist_failed")) {
          throw new Error(`reason não propagado ao corpo do e-mail: ${JSON.stringify(body)}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "modo auto: grava status=pending e despacha o envio (dispatchAiSend) em seguida",
    async () => {
      let sentUpdate: Record<string, unknown> | null = null;
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/conversations" && req.method === "GET") {
          return jsonResponse(200, { ai_active: true, awaiting_human: false });
        }
        if (req.pathname === "/rest/v1/contacts" && req.method === "GET") {
          return jsonResponse(200, { ai_paused: false });
        }
        if (req.pathname === "/rest/v1/messages" && req.method === "POST") {
          return jsonResponse(201, { id: "msg-auto-1" });
        }
        if (req.pathname === "/rest/v1/messages" && req.method === "PATCH") {
          sentUpdate = req.bodyJson as Record<string, unknown>;
          return jsonResponse(200, {});
        }
        if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
          return jsonResponse(200, {});
        }
        if (req.pathname === "/rest/v1/integration_secrets" && req.method === "GET") {
          return jsonResponse(200, []); // sem credenciais -> zapi recusa o envio
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const result = await finalizeAiReply({
          admin: newAdminClient(),
          tenantId: "tenant-1",
          conversationId: "conv-3",
          contactId: "contact-1",
          dealId: null,
          aiText: "texto auto",
          sendMode: "auto",
          providerSlug: "zapi",
          contactPhone: "5511999999999",
          contactEmail: null,
          subject: null,
          previousAwaitingHuman: true,
        });
        if (result.kind !== "sent" || result.id !== "msg-auto-1" || result.sent !== false) {
          throw new Error(`resultado inesperado: ${JSON.stringify(result)}`);
        }
        if (!sentUpdate) throw new Error("PATCH em messages não foi capturado");
        const updateBody = sentUpdate as Record<string, unknown>;
        if (updateBody.status !== "failed") {
          throw new Error(
            `status inesperado (sem credenciais deveria falhar): ${JSON.stringify(updateBody)}`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "H9 — cascata: insert do rascunho falha E o UPDATE de awaiting_human também: reporta em ai_failure_logs",
    async () => {
      // O UPDATE de conversations é o mecanismo que traz o humano para a
      // conversa. Se ele falhar junto com o insert (banco instável derruba os
      // dois), sem checagem o cliente fica sem resposta, sem flag e sem alerta.
      const failureLogs: Array<Record<string, unknown>> = [];
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/messages" && req.method === "POST") {
          return jsonResponse(500, { message: "db indisponível" });
        }
        if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
          return jsonResponse(500, { message: "db indisponível" });
        }
        if (req.pathname === "/rest/v1/ai_failure_logs" && req.method === "POST") {
          failureLogs.push(req.bodyJson as Record<string, unknown>);
          return jsonResponse(201, {});
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const result = await finalizeAiReply({
          admin: newAdminClient(),
          tenantId: "tenant-1",
          conversationId: "conv-h9",
          contactId: "contact-1",
          dealId: null,
          aiText: "texto",
          sendMode: "draft",
          providerSlug: "zapi",
          contactPhone: "5511999999999",
          contactEmail: null,
          subject: null,
          // true evita o caminho de notificação: o que este step isola é o
          // rastro do UPDATE perdido, não o alerta ao admin.
          previousAwaitingHuman: true,
        });
        if (result.kind !== "insert_failed") {
          throw new Error(`resultado inesperado: ${JSON.stringify(result)}`);
        }
        const persist = failureLogs.find((log) => {
          const ctx = log.context as Record<string, unknown> | undefined;
          return ctx?.phase === "persist" && ctx?.table === "conversations";
        });
        if (!persist) {
          throw new Error(
            `UPDATE de awaiting_human falhou em silêncio: ${JSON.stringify(failureLogs)}`,
          );
        }
        if ((persist.context as Record<string, unknown>).step !== "rascunho não gravado") {
          throw new Error(`step não identifica o caminho: ${JSON.stringify(persist.context)}`);
        }
      } finally {
        uninstall();
      }
    },
  );
});

// -------------------- dispatchAiSend --------------------

Deno.test("dispatchAiSend", async (t) => {
  await t.step(
    "zapi com credenciais válidas: envia, marca sent e limpa awaiting_human",
    async () => {
      let messagesUpdate: Record<string, unknown> | null = null;
      let conversationsUpdate: Record<string, unknown> | null = null;
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/integration_secrets" && req.method === "GET") {
          return jsonResponse(200, [
            { key: "instance_id", value: "inst-1" },
            { key: "instance_token", value: "tok-1" },
            { key: "client_token", value: "client-1" },
          ]);
        }
        if (req.url === ZAPI_SEND_URL && req.method === "POST") {
          return jsonResponse(200, { messageId: "zapi-ext-1" });
        }
        if (req.pathname === "/rest/v1/messages" && req.method === "PATCH") {
          messagesUpdate = req.bodyJson as Record<string, unknown>;
          return jsonResponse(200, {});
        }
        if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
          conversationsUpdate = req.bodyJson as Record<string, unknown>;
          return jsonResponse(200, {});
        }
        // ai_conversation_summaries/messages (geração de resumo em background) —
        // fire-and-forget via runInBackground, sem bloquear a asserção principal.
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const sendOk = await dispatchAiSend({
          admin: newAdminClient(),
          tenantId: "tenant-1",
          conversationId: "conv-1",
          contactId: "contact-1",
          dealId: null,
          aiMessageId: "msg-1",
          aiText: "Olá!",
          providerSlug: "zapi",
          contactPhone: "5511999999999",
          contactEmail: null,
          subject: null,
          previousAwaitingHuman: true,
        });
        if (sendOk !== true) throw new Error(`esperado sendOk=true, veio ${sendOk}`);
        if (!messagesUpdate) throw new Error("PATCH em messages não foi capturado");
        const msgBody = messagesUpdate as Record<string, unknown>;
        if (msgBody.status !== "sent" || msgBody.external_id !== "zapi-ext-1") {
          throw new Error(`messages PATCH incorreto: ${JSON.stringify(msgBody)}`);
        }
        if (!conversationsUpdate) throw new Error("PATCH em conversations não foi capturado");
        const convBody = conversationsUpdate as Record<string, unknown>;
        if (convBody.awaiting_human !== false) {
          throw new Error(`awaiting_human deveria zerar: ${JSON.stringify(convBody)}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  // Regressão: o caminho automático da IA tinha um dispatcher próprio que só
  // conhecia zapi/twilio/meta-cloud/resend, então canais como zappaz caíam em
  // "Canal desta conversa não é suportado para envio externo" mesmo com o
  // envio manual funcionando. Agora delega ao dispatcher canônico.
  await t.step("zappaz: envia pelo dispatcher canônico e marca sent", async () => {
    let messagesUpdate: Record<string, unknown> | null = null;
    let sentBody: Record<string, unknown> | null = null;
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/integration_secrets" && req.method === "GET") {
        return jsonResponse(200, [
          { key: "api_key", value: "zappaz-key" },
          { key: "session_id", value: "sess-1" },
        ]);
      }
      if (req.url === ZAPPAZ_SEND_URL && req.method === "POST") {
        sentBody = req.bodyJson as Record<string, unknown>;
        return jsonResponse(200, { messageId: "zappaz-ext-1" });
      }
      if (req.pathname === "/rest/v1/messages" && req.method === "PATCH") {
        messagesUpdate = req.bodyJson as Record<string, unknown>;
        return jsonResponse(200, {});
      }
      if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
        return jsonResponse(200, {});
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const sendOk = await dispatchAiSend({
        admin: newAdminClient(),
        tenantId: "tenant-1",
        conversationId: "conv-1",
        contactId: "contact-1",
        dealId: null,
        aiMessageId: "msg-z-1",
        aiText: "Olá!",
        providerSlug: "zappaz",
        contactPhone: "+554599022026",
        contactEmail: null,
        subject: null,
        previousAwaitingHuman: true,
      });
      if (sendOk !== true) throw new Error(`esperado sendOk=true, veio ${sendOk}`);
      if (!sentBody) throw new Error("envio Zappaz não foi disparado");
      if ((sentBody as Record<string, unknown>).number !== "554599022026") {
        throw new Error(`número enviado inesperado: ${JSON.stringify(sentBody)}`);
      }
      const msgBody = messagesUpdate as Record<string, unknown> | null;
      if (!msgBody || msgBody.status !== "sent") {
        throw new Error(`messages PATCH incorreto: ${JSON.stringify(msgBody)}`);
      }
    } finally {
      uninstall();
    }
  });

  // Regressão: a queda de áudio->texto era console-only e SEM correlação — os
  // payloads tinham só providerSlug e error, sem tenantId nem conversationId.
  // Num app multi-tenant, nem com o log em mãos dava para dizer qual tenant ou
  // conversa caiu, e nada em `messages` distingue resposta em áudio de texto,
  // então também não havia auditoria post-hoc.
  await t.step(
    "TTS falha: cai para texto E registra em ai_failure_logs com tenant/conversa",
    async () => {
      let failureLog: Record<string, unknown> | null = null;
      let textoEnviado = false;
      let ttsCalls = 0;
      const messagePatches: Record<string, unknown>[] = [];
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/integration_secrets" && req.method === "GET") {
          return jsonResponse(200, [
            { key: "api_key", value: "zappaz-key" },
            { key: "session_id", value: "sess-1" },
          ]);
        }
        if (req.url.includes("api.elevenlabs.io")) {
          ttsCalls++;
          return jsonResponse(500, { detail: "voice quota exceeded" });
        }
        if (req.url === ZAPPAZ_SEND_URL && req.method === "POST") {
          textoEnviado = true;
          return jsonResponse(200, { messageId: "zappaz-ext-2" });
        }
        if (req.pathname === "/rest/v1/ai_failure_logs" && req.method === "POST") {
          failureLog = req.bodyJson as Record<string, unknown>;
          return jsonResponse(201, []);
        }
        if (req.pathname === "/rest/v1/messages" && req.method === "PATCH") {
          messagePatches.push(req.bodyJson as Record<string, unknown>);
          return jsonResponse(200, {});
        }
        if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
          return jsonResponse(200, {});
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const sendOk = await dispatchAiSend({
          admin: newAdminClient(),
          tenantId: "tenant-1",
          conversationId: "conv-1",
          contactId: "contact-1",
          dealId: null,
          aiMessageId: "msg-z-2",
          aiText: "Olá!",
          providerSlug: "zappaz",
          contactPhone: "+554599022026",
          contactEmail: null,
          subject: null,
          previousAwaitingHuman: true,
          voice: { apiKey: "el-key", voiceId: "voice-1" },
        });
        // Falha de voz NÃO pode deixar o lead sem resposta.
        if (sendOk !== true) throw new Error(`esperado sendOk=true, veio ${sendOk}`);
        if (!textoEnviado) throw new Error("fallback para texto não aconteceu");
        if (ttsCalls !== 2) throw new Error(`retry TTS esperado 2 vezes, veio ${ttsCalls}`);
        if (!messagePatches.some((patch) => patch.audio_status === "failed")) {
          throw new Error(`lifecycle não marcou áudio failed: ${JSON.stringify(messagePatches)}`);
        }

        const log = failureLog as Record<string, unknown> | null;
        if (!log) throw new Error("queda de áudio não virou ai_failure_logs");
        if (log.tenant_id !== "tenant-1") {
          throw new Error(`tenant_id ausente/errado no log: ${JSON.stringify(log)}`);
        }
        const ctx = log.context as Record<string, unknown> | undefined;
        if (ctx?.phase !== "voice_fallback" || ctx?.conversationId !== "conv-1") {
          throw new Error(`context sem correlação: ${JSON.stringify(ctx)}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "TTS feliz: gera, persiste no bucket privado, envia áudio e grava lifecycle completo",
    async () => {
      const audioStates: string[] = [];
      const messagePatches: Record<string, unknown>[] = [];
      let uploaded = false;
      let audioSent = false;
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/integration_secrets" && req.method === "GET") {
          return jsonResponse(200, [
            { key: "api_key", value: "zappaz-key" },
            { key: "session_id", value: "sess-1" },
          ]);
        }
        if (req.url.includes("api.elevenlabs.io/v1/text-to-speech/")) {
          return new Response(new Uint8Array([0x49, 0x44, 0x33, 0x03]), {
            status: 200,
            headers: { "content-type": "audio/mpeg" },
          });
        }
        if (
          req.pathname.startsWith("/storage/v1/object/ai-audio/tenant-1/conv-voice-1/") &&
          req.method === "POST"
        ) {
          uploaded = true;
          return jsonResponse(200, { Key: "ai-audio/tenant-1/conv-voice-1/msg-voice-1.mp3" });
        }
        if (req.url === ZAPPAZ_AUDIO_URL && req.method === "POST") {
          audioSent = true;
          const body = req.bodyJson as Record<string, unknown>;
          if (body.number !== "554599022026" || typeof body.source !== "string") {
            throw new Error(`payload de áudio inesperado: ${JSON.stringify(body)}`);
          }
          return jsonResponse(200, { messageId: "zappaz-audio-ext-1" });
        }
        if (req.pathname === "/rest/v1/messages" && req.method === "PATCH") {
          const body = req.bodyJson as Record<string, unknown>;
          messagePatches.push(body);
          if (typeof body.audio_status === "string") audioStates.push(body.audio_status);
          return jsonResponse(200, {});
        }
        if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
          return jsonResponse(200, {});
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const sendOk = await dispatchAiSend({
          admin: newAdminClient(),
          tenantId: "tenant-1",
          conversationId: "conv-voice-1",
          contactId: "contact-1",
          dealId: null,
          aiMessageId: "msg-voice-1",
          aiText: "Resposta falada.",
          providerSlug: "zappaz",
          contactPhone: "+554599022026",
          contactEmail: null,
          subject: null,
          previousAwaitingHuman: true,
          voice: { apiKey: "el-key", voiceId: "voice-1" },
        });
        if (!sendOk || !uploaded || !audioSent) {
          throw new Error(`fluxo incompleto: ${JSON.stringify({ sendOk, uploaded, audioSent })}`);
        }
        const expected = ["generating", "generated", "sending", "sent"];
        if (JSON.stringify(audioStates) !== JSON.stringify(expected)) {
          throw new Error(`lifecycle inesperado: ${JSON.stringify(audioStates)}`);
        }
        const generated = messagePatches.find((patch) => patch.audio_status === "generated");
        if (
          generated?.audio_storage_path !==
            "tenant-1/conv-voice-1/msg-voice-1.mp3" ||
          generated.audio_bytes !== 4 ||
          generated.audio_attempts !== 1 ||
          generated.media_type !== "audio/mpeg" ||
          typeof generated.audio_generated_at !== "string"
        ) {
          throw new Error(`metadados auditáveis incompletos: ${JSON.stringify(generated)}`);
        }
        const sent = messagePatches.find((patch) => patch.audio_status === "sent");
        if (typeof sent?.audio_sent_at !== "string") {
          throw new Error(`timestamp de envio ausente: ${JSON.stringify(sent)}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "zapi sem telefone cadastrado: não tenta HTTP externo, marca failed + awaiting_human",
    async () => {
      let messagesUpdate: Record<string, unknown> | null = null;
      let conversationsUpdate: Record<string, unknown> | null = null;
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/integration_secrets" && req.method === "GET") {
          return jsonResponse(200, [
            { key: "instance_id", value: "inst-1" },
            { key: "instance_token", value: "tok-1" },
            { key: "client_token", value: "client-1" },
          ]);
        }
        if (req.url === ZAPI_SEND_URL) throw new Error("não deveria tentar enviar sem telefone");
        if (req.pathname === "/rest/v1/messages" && req.method === "PATCH") {
          messagesUpdate = req.bodyJson as Record<string, unknown>;
          return jsonResponse(200, {});
        }
        if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
          conversationsUpdate = req.bodyJson as Record<string, unknown>;
          return jsonResponse(200, {});
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const sendOk = await dispatchAiSend({
          admin: newAdminClient(),
          tenantId: "tenant-1",
          conversationId: "conv-2",
          contactId: "contact-1",
          dealId: null,
          aiMessageId: "msg-2",
          aiText: "Olá!",
          providerSlug: "zapi",
          contactPhone: null,
          contactEmail: null,
          subject: null,
          previousAwaitingHuman: true,
        });
        if (sendOk !== false) throw new Error(`esperado sendOk=false, veio ${sendOk}`);
        if (!messagesUpdate) throw new Error("PATCH em messages não foi capturado");
        const msgBody = messagesUpdate as Record<string, unknown>;
        if (msgBody.status !== "failed") {
          throw new Error(`status inesperado: ${JSON.stringify(msgBody)}`);
        }
        if (!conversationsUpdate) throw new Error("PATCH em conversations não foi capturado");
        const convBody = conversationsUpdate as Record<string, unknown>;
        if (convBody.awaiting_human !== true) {
          throw new Error(`awaiting_human deveria setar: ${JSON.stringify(convBody)}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "exceção de rede no envio: marca failed, awaiting_human e reporta em ai_failure_logs com detalhes sanitizados",
    async () => {
      let messagesUpdate: Record<string, unknown> | null = null;
      let conversationsUpdate: Record<string, unknown> | null = null;
      let failureLogInsert: Record<string, unknown> | null = null;
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/integration_secrets" && req.method === "GET") {
          return jsonResponse(200, [
            { key: "instance_id", value: "inst-1" },
            { key: "instance_token", value: "tok-1" },
            { key: "client_token", value: "client-1" },
          ]);
        }
        if (req.url === ZAPI_SEND_URL) throw new TypeError("network down");
        if (req.pathname === "/rest/v1/messages" && req.method === "PATCH") {
          messagesUpdate = req.bodyJson as Record<string, unknown>;
          return jsonResponse(200, {});
        }
        if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
          conversationsUpdate = req.bodyJson as Record<string, unknown>;
          return jsonResponse(200, {});
        }
        if (req.pathname === "/rest/v1/ai_failure_logs" && req.method === "POST") {
          failureLogInsert = req.bodyJson as Record<string, unknown>;
          return jsonResponse(201, {});
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const sendOk = await dispatchAiSend({
          admin: newAdminClient(),
          tenantId: "tenant-1",
          conversationId: "conv-3",
          contactId: "contact-1",
          dealId: null,
          aiMessageId: "msg-3",
          aiText: "Olá!",
          providerSlug: "zapi",
          contactPhone: "5511999999999",
          contactEmail: null,
          subject: null,
          previousAwaitingHuman: true,
        });
        if (sendOk !== false) throw new Error(`esperado sendOk=false, veio ${sendOk}`);
        if (!messagesUpdate) throw new Error("PATCH em messages não foi capturado");
        const msgBody = messagesUpdate as Record<string, unknown>;
        if (msgBody.status !== "failed") {
          throw new Error(`status inesperado: ${JSON.stringify(msgBody)}`);
        }
        if (!conversationsUpdate) throw new Error("PATCH em conversations não foi capturado");
        const convBody = conversationsUpdate as Record<string, unknown>;
        if (convBody.awaiting_human !== true) {
          throw new Error(`awaiting_human deveria setar: ${JSON.stringify(convBody)}`);
        }
        if (!failureLogInsert) throw new Error("INSERT em ai_failure_logs não foi capturado");
        const logBody = failureLogInsert as Record<string, unknown>;
        if (logBody.error_code !== "UNKNOWN" || logBody.status_code !== null) {
          throw new Error(`ai_failure_logs incorreto: ${JSON.stringify(logBody)}`);
        }
        if (
          typeof logBody.error_message !== "string" ||
          !logBody.error_message.includes("network down")
        ) {
          throw new Error(`error_message não veio da exceção original: ${JSON.stringify(logBody)}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "voz pedida e segredo do canal indisponível: fecha lifecycle de áudio como failed",
    async () => {
      const messagePatches: Record<string, unknown>[] = [];
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/integration_secrets" && req.method === "GET") {
          return jsonResponse(500, { message: "vault indisponível" });
        }
        if (req.pathname === "/rest/v1/messages" && req.method === "PATCH") {
          messagePatches.push(req.bodyJson as Record<string, unknown>);
          return jsonResponse(200, {});
        }
        if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
          return jsonResponse(200, {});
        }
        if (req.pathname === "/rest/v1/ai_failure_logs" && req.method === "POST") {
          return jsonResponse(201, {});
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const sendOk = await dispatchAiSend({
          admin: newAdminClient(),
          tenantId: "tenant-1",
          conversationId: "conv-audio-secret",
          contactId: "contact-1",
          dealId: null,
          aiMessageId: "msg-audio-secret",
          aiText: "Olá!",
          providerSlug: "zapi",
          contactPhone: "5511999999999",
          contactEmail: null,
          subject: null,
          previousAwaitingHuman: true,
          voice: { apiKey: "el-key", voiceId: "voice-1" },
        });
        if (sendOk !== false) throw new Error(`esperado sendOk=false, veio ${sendOk}`);
        const failed = messagePatches.find((patch) => patch.status === "failed");
        if (failed?.audio_status !== "failed" || typeof failed.audio_error !== "string") {
          throw new Error(`lifecycle ficou aberto: ${JSON.stringify(messagePatches)}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  // -------------------- H7/H8: erro nos UPDATEs de persistência --------------------
  // supabase-js NÃO lança em erro de banco (devolve { data, error }), então
  // sem destructure um UPDATE que falhou é idêntico a um que funcionou.
  // Os dois steps abaixo asseguram que a falha vira telemetria em vez de
  // sumir (docs/code-review/05-silent-failures.md, H7 e H8).

  await t.step(
    "H7 — mensagem JÁ entregue mas UPDATE de messages falha: reporta persistência em ai_failure_logs",
    async () => {
      const failureLogs: Array<Record<string, unknown>> = [];
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/integration_secrets" && req.method === "GET") {
          return jsonResponse(200, [
            { key: "instance_id", value: "inst-1" },
            { key: "instance_token", value: "tok-1" },
            { key: "client_token", value: "client-1" },
          ]);
        }
        if (req.url === ZAPI_SEND_URL && req.method === "POST") {
          return jsonResponse(200, { messageId: "zapi-ext-h7" });
        }
        // Envio externo OK, banco fora do ar na hora de marcar sent.
        if (req.pathname === "/rest/v1/messages" && req.method === "PATCH") {
          return jsonResponse(500, { message: "db indisponível" });
        }
        if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
          return jsonResponse(200, {});
        }
        if (req.pathname === "/rest/v1/ai_failure_logs" && req.method === "POST") {
          failureLogs.push(req.bodyJson as Record<string, unknown>);
          return jsonResponse(201, {});
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const sendOk = await dispatchAiSend({
          admin: newAdminClient(),
          tenantId: "tenant-1",
          conversationId: "conv-h7",
          contactId: "contact-1",
          dealId: null,
          aiMessageId: "msg-h7",
          aiText: "Olá!",
          providerSlug: "zapi",
          contactPhone: "5511999999999",
          contactEmail: null,
          subject: null,
          previousAwaitingHuman: true,
        });
        // O envio externo aconteceu: o retorno continua true, o que muda é a
        // falha de persistência ter deixado rastro.
        if (sendOk !== true) throw new Error(`esperado sendOk=true, veio ${sendOk}`);
        const persist = failureLogs.find(
          (log) => (log.context as Record<string, unknown> | undefined)?.phase === "persist",
        );
        if (!persist) {
          throw new Error(
            `falha ao gravar messages não foi reportada: ${JSON.stringify(failureLogs)}`,
          );
        }
        const ctx = persist.context as Record<string, unknown>;
        if (ctx.table !== "messages" || ctx.aiMessageId !== "msg-h7") {
          throw new Error(`context sem rastro da mensagem: ${JSON.stringify(ctx)}`);
        }
        if (ctx.externalId !== "zapi-ext-h7") {
          throw new Error(`context sem external_id do envio já entregue: ${JSON.stringify(ctx)}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "H8 — UPDATEs do registro da falha de envio também falham: as duas falhas viram ai_failure_logs",
    async () => {
      const failureLogs: Array<Record<string, unknown>> = [];
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/integration_secrets" && req.method === "GET") {
          return jsonResponse(200, [
            { key: "instance_id", value: "inst-1" },
            { key: "instance_token", value: "tok-1" },
            { key: "client_token", value: "client-1" },
          ]);
        }
        // Sem telefone o envio nem sai: cai direto em persistSendFailure.
        if (req.url === ZAPI_SEND_URL) throw new Error("não deveria tentar enviar sem telefone");
        if (req.pathname === "/rest/v1/messages" && req.method === "PATCH") {
          return jsonResponse(500, { message: "db indisponível" });
        }
        if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
          return jsonResponse(500, { message: "db indisponível" });
        }
        if (req.pathname === "/rest/v1/ai_failure_logs" && req.method === "POST") {
          failureLogs.push(req.bodyJson as Record<string, unknown>);
          return jsonResponse(201, {});
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const sendOk = await dispatchAiSend({
          admin: newAdminClient(),
          tenantId: "tenant-1",
          conversationId: "conv-h8",
          contactId: "contact-1",
          dealId: null,
          aiMessageId: "msg-h8",
          aiText: "Olá!",
          providerSlug: "zapi",
          contactPhone: null,
          contactEmail: null,
          subject: null,
          previousAwaitingHuman: true,
        });
        if (sendOk !== false) throw new Error(`esperado sendOk=false, veio ${sendOk}`);
        const tables = failureLogs
          .map((log) => (log.context as Record<string, unknown> | undefined))
          .filter((ctx) => ctx?.phase === "persist")
          .map((ctx) => ctx?.table);
        if (!tables.includes("messages") || !tables.includes("conversations")) {
          throw new Error(
            `esperado report de persistência para messages E conversations, veio ${
              JSON.stringify(failureLogs)
            }`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );
});

// -------------------- cadência da resposta --------------------
//
// Em produção (2026-08-04) toda resposta da IA chegava como UMA mensagem de
// 240-330 caracteres com linha em branco no meio — parecia documento
// formatado, não conversa.
//
// A correção NÃO é fragmentar em rajada. O medflow implementou a fragmentação
// e desligou depois de comparar com secretária humana real em 3 conversas
// (2026-05-19): pessoa manda 1 mensagem densa por turno. O que sai é uma
// mensagem só, condensada — sem os \n\n.

Deno.test("condensação da resposta", async (t) => {
  await t.step("parágrafos viram UMA mensagem, sem linha em branco", () => {
    const texto = "Olá! Sou a Clara. 👋\n\nComo posso ajudar?\n\nQual é o seu segmento?";
    const saida = splitIntoBubbles(texto);
    assertEquals(saida.length, 1);
    assertEquals(saida[0].includes("\n\n"), false);
    // Nada de conteúdo pode sumir na condensação.
    assertStringIncludes(saida[0], "Sou a Clara");
    assertStringIncludes(saida[0], "seu segmento");
  });

  await t.step("mensagem já curta passa intacta", () => {
    assertEquals(splitIntoBubbles("Bom dia, tudo bem por aí?"), ["Bom dia, tudo bem por aí?"]);
  });

  await t.step("\n solto dentro do parágrafo é preservado", () => {
    // Continuação e lista não são linha em branco: achatar isso destruiria
    // formatação legítima que o lead consegue ler.
    const saida = splitIntoBubbles("Temos dois planos:\nBásico e Pro");
    assertEquals(saida, ["Temos dois planos:\nBásico e Pro"]);
  });

  await t.step("vazio não vira mensagem fantasma", () => {
    assertEquals(splitIntoBubbles(""), []);
    assertEquals(splitIntoBubbles("\n\n   \n\n"), []);
  });
});

// Regressão de 2026-08-04: com `voice` pedido, o código pulava a condensação
// inteira. O TTS falhou, o texto caiu como fallback e chegou ao lead com as
// linhas em branco que a condensação existe para remover.
Deno.test("condensação vale também quando há pedido de voz", () => {
  const texto = "Recebi seus áudios!\n\nPor onde você conheceu a gente?";
  const saida = splitIntoBubbles(texto);
  // splitIntoBubbles é a única fonte de verdade do formato; o caminho de voz
  // apenas junta o que ela devolve, nunca ignora.
  assertEquals(saida.length, 1);
  assertEquals(saida[0].includes("\n\n"), false);
  assertStringIncludes(saida[0], "Recebi seus áudios!");
  assertStringIncludes(saida[0], "conheceu a gente?");
});

// dropRepeatedQuestion — o caso real de 2026-08-04: 3 respostas seguidas
// terminaram com a MESMA pergunta de qualificação mesmo com a instrução de
// prompt da PR #172 mandando não repetir. Prompt pede, código garante.
Deno.test("dropRepeatedQuestion corta a pergunta que a IA já fez nesta conversa", () => {
  const anterior =
    "Para eu te encaminhar para a equipe, qual seu faturamento atual e a meta para os próximos 6 meses?";
  const atual =
    "O limite diário para alimentação é de R$ 60,00, mediante nota fiscal. Para eu te encaminhar para a equipe da Freedom, qual seu faturamento atual e a meta para os próximos 6 meses?";

  const saida = dropRepeatedQuestion(atual, [anterior]);
  assertStringIncludes(saida, "R$ 60,00");
  assertEquals(saida.includes("faturamento"), false);
  assertEquals(saida.endsWith("?"), false);
});

Deno.test("dropRepeatedQuestion mantém pergunta nova e redação variada da mesma", () => {
  const anterior = "Qual seu faturamento atual e a meta para os próximos 6 meses?";

  // Pergunta DIFERENTE sobrevive.
  const nova = "O limite é R$ 60,00. Você já trabalhou com CRM antes?";
  assertEquals(dropRepeatedQuestion(nova, [anterior]), nova);

  // Mesma pergunta com outra redação também é cortada (comparação por tokens).
  const reescrita = "O limite é R$ 60,00. Me conta: qual é o faturamento atual e a meta de 6 meses?";
  assertEquals(dropRepeatedQuestion(reescrita, [anterior]).includes("faturamento"), false);

  // Sem histórico, nada muda.
  assertEquals(dropRepeatedQuestion(nova, []), nova);
});

Deno.test("dropRepeatedQuestion não esvazia resposta que é só a pergunta repetida", () => {
  const anterior = "Qual seu faturamento atual e a meta para os próximos 6 meses?";
  const so = "Qual seu faturamento atual e a meta para os próximos 6 meses?";
  assertEquals(dropRepeatedQuestion(so, [anterior]), so);
});

Deno.test("extrairUltimaPergunta pega a última interrogativa, ou null", () => {
  assertEquals(extrairUltimaPergunta("Tudo certo. Qual seu nome?"), "Qual seu nome?");
  assertEquals(
    extrairUltimaPergunta("Beleza? Agora me diz: qual a meta?"),
    "Agora me diz: qual a meta?",
  );
  assertEquals(extrairUltimaPergunta("Sem pergunta aqui."), null);
});

// capEmoji — a #172 tentou por prompt ("se a anterior tem emoji, esta não
// leva") e o resultado em produção foi 12/12 com emoji, 4 delas com dois.
// Frequência é o que um modelo sem estado não consegue cumprir; aqui vira
// alternância determinística, que converge para os 50% do humano real.




// dropTrailingQuestion — humano real faz 0,62 pergunta/mensagem; a IA vinha em
// ~1,0. A #172 pediu isso no prompt e não pegou (frequência é o que um modelo
// sem estado não cumpre). Alternância determinística cai perto de 0,5.

// -------------------- Cadência probabilística --------------------
// Alternância determinística (0,1,0,1) acerta a média e erra o que importa:
// dá para prever a próxima mensagem olhando a anterior, que é assinatura de
// bot. Aqui a decisão é moeda enviesada; `rng` injetado deixa o teste exato.
const SEMPRE: Rng = () => 0;
const NUNCA: Rng = () => 0.999;

Deno.test("probabilidadeCorrigida puxa de volta ao alvo sem nunca travar em 0 ou 1", () => {
  // Sem histórico, é o próprio alvo.
  assertEquals(probabilidadeCorrigida([], 0.5), 0.5);
  // Na taxa certa, moeda honesta.
  assertEquals(probabilidadeCorrigida([true, false, true, false], 0.5), 0.5);
  // Excesso recente derruba a chance; escassez levanta.
  const excesso = probabilidadeCorrigida([true, true, true, true], 0.5);
  const escassez = probabilidadeCorrigida([false, false, false, false], 0.5);
  assertEquals(excesso < 0.5, true);
  assertEquals(escassez > 0.5, true);
  // O clamp é o ponto: NUNCA determinístico, nos dois extremos.
  assertEquals(excesso >= 0.15, true);
  assertEquals(escassez <= 0.85, true);
});

Deno.test("capEmoji: rng decide, e o teto de um é absoluto", () => {
  const atual = "Temos Stay Charlie 🏨 e Ibis Budget 🛏️ disponíveis 😊";
  assertEquals(contarEmojis(capEmoji(atual, [], SEMPRE)), 1);
  assertEquals(contarEmojis(capEmoji(atual, [], NUNCA)), 0);
  // Mesmo com histórico sem emoji nenhum, o teto continua UM.
  assertEquals(contarEmojis(capEmoji(atual, ["oi", "tudo bem"], SEMPRE)), 1);
});

Deno.test("capEmoji não deixa espaço duplo nem espaço antes de pontuação", () => {
  const saida = capEmoji("O limite é R$ 60 📑 por dia 🧾 . Combinado 😊?", [], NUNCA);
  assertEquals(contarEmojis(saida), 0);
  assertEquals(/\s{2,}/.test(saida), false);
  assertEquals(/\s[.,!?;:]/.test(saida), false);
});

Deno.test("capEmoji preserva texto sem emoji", () => {
  const texto = "O limite diário é de R$ 60,00 mediante nota fiscal.";
  assertEquals(capEmoji(texto, [], SEMPRE), texto);
  assertEquals(capEmoji(texto, [], NUNCA), texto);
});

Deno.test("dropTrailingQuestion: rng decide manter ou cortar", () => {
  const atual = "O limite é R$ 60,00 mediante nota. Quer que eu detalhe o reembolso?";
  assertEquals(dropTrailingQuestion(atual, [], SEMPRE), atual);
  const cortado = dropTrailingQuestion(atual, [], NUNCA);
  assertStringIncludes(cortado, "R$ 60,00");
  assertEquals(cortado.endsWith("?"), false);
});

Deno.test("dropTrailingQuestion não toca em pergunta no meio da frase", () => {
  const atual = "Você perguntou sobre reembolso? Segue o passo a passo completo.";
  assertEquals(dropTrailingQuestion(atual, [], NUNCA), atual);
});

Deno.test("dropTrailingQuestion não esvazia resposta que é só a pergunta", () => {
  const so = "Qual o seu nome completo?";
  assertEquals(dropTrailingQuestion(so, [], NUNCA), so);
});

// O que o usuário reclamou: sequência previsível. Com rng real, a série NÃO
// pode ser alternância perfeita — e a taxa tem que ficar perto do alvo.
Deno.test("cadência real: converge no alvo sem virar alternância previsível", () => {
  let seed = 42;
  const rng: Rng = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const historico: string[] = [];
  for (let i = 0; i < 200; i++) {
    const saida = capEmoji("Resposta com emoji 😊", historico, rng);
    historico.unshift(saida);
  }
  const serie = historico.map((h) => contarEmojis(h) > 0);
  const taxa = serie.filter(Boolean).length / serie.length;
  // Perto dos 50% do humano real.
  assertEquals(taxa > 0.35 && taxa < 0.65, true);
  // E NÃO é alternância: tem que haver repetição de valor em posições vizinhas.
  const repeticoes = serie.filter((v, i) => i > 0 && v === serie[i - 1]).length;
  assertEquals(repeticoes > 20, true);
});
