// Testa direto cada helper de seção exportado por gates.ts (loadTriggerMessage,
// claimMessageOnce, coalesceBurst, loadConversationAndTakeover, loadTenant,
// loadContact, ensureAiSettings, enforceRateLimit, acquireConcurrencyLock) —
// runGates já é coberto em profundidade via mock HTTP completo do Deno.serve
// em ai-respond.test.ts; este arquivo isola qual etapa quebrou quando algo
// falhar, com 1 caso feliz + 1 caso de erro por função.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { BASE_ENV, type FetchMatcher, installFetchMock, jsonResponse, setEnv } from "./_helpers.ts";
import {
  acquireConcurrencyLock,
  claimMessageOnce,
  coalesceBurst,
  enforceRateLimit,
  ensureAiSettings,
  loadContact,
  loadConversationAndTakeover,
  loadTenant,
  loadTriggerMessage,
} from "../_shared/ai/gates.ts";

setEnv(BASE_ENV);

function newAdminClient() {
  return createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// -------------------- loadTriggerMessage --------------------

Deno.test("loadTriggerMessage", async (t) => {
  await t.step("mensagem inbound de contato: ok=true com o msg", async () => {
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/messages" && req.method === "GET") {
        return jsonResponse(200, {
          id: "msg-1",
          tenant_id: "tenant-1",
          conversation_id: "conv-1",
          sender: "contact",
          direction: "in",
          content: "oi",
          media_url: null,
          media_type: null,
          created_at: "2026-01-01T00:00:00.000Z",
        });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await loadTriggerMessage(newAdminClient(), "msg-1");
      if (!result.ok) throw new Error(`esperado ok=true, veio ${JSON.stringify(result)}`);
      if (result.msg.id !== "msg-1") throw new Error(`msg.id=${result.msg.id}`);
    } finally {
      uninstall();
    }
  });

  await t.step("mensagem não encontrada: reason=message_not_found", async () => {
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/messages" && req.method === "GET") {
        return jsonResponse(200, null);
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await loadTriggerMessage(newAdminClient(), "msg-x");
      if (result.ok || result.reason !== "message_not_found") {
        throw new Error(`esperado message_not_found, veio ${JSON.stringify(result)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("mensagem outbound (sender != contact): reason=not_contact_inbound", async () => {
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/messages" && req.method === "GET") {
        return jsonResponse(200, {
          id: "msg-2",
          tenant_id: "tenant-1",
          conversation_id: "conv-1",
          sender: "ai",
          direction: "out",
          content: "resposta",
          media_url: null,
          media_type: null,
        });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await loadTriggerMessage(newAdminClient(), "msg-2");
      if (result.ok || result.reason !== "not_contact_inbound") {
        throw new Error(`esperado not_contact_inbound, veio ${JSON.stringify(result)}`);
      }
    } finally {
      uninstall();
    }
  });
});

// -------------------- claimMessageOnce --------------------

Deno.test("claimMessageOnce", async (t) => {
  await t.step("primeira lease retorna token e ok=true", async () => {
    const router: FetchMatcher = (req) => {
      if (
        req.pathname === "/rest/v1/rpc/claim_ai_processing_message" &&
        req.method === "POST"
      ) {
        return jsonResponse(200, [
          {
            claimed: true,
            claim_state: "claimed",
            attempt: 1,
            lease_token: "11111111-1111-4111-8111-111111111111",
            lease_expires_at: "2026-01-01T00:03:00.000Z",
          },
        ]);
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await claimMessageOnce(newAdminClient(), {
        messageId: "msg-1",
        conversationId: "conv-1",
        tenantId: "tenant-1",
      });
      if (!result.ok) throw new Error(`esperado ok=true, veio ${JSON.stringify(result)}`);
      if (result.claimToken !== "11111111-1111-4111-8111-111111111111") {
        throw new Error(`claimToken=${result.claimToken}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "lease ocupada por concorrente => message_already_processing",
    async () => {
      const router: FetchMatcher = (req) => {
        if (
          req.pathname === "/rest/v1/rpc/claim_ai_processing_message" &&
          req.method === "POST"
        ) {
          return jsonResponse(200, [
            {
              claimed: false,
              claim_state: "processing",
              attempt: 1,
              lease_token: "22222222-2222-4222-8222-222222222222",
              lease_expires_at: "2026-01-01T00:03:00.000Z",
            },
          ]);
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const result = await claimMessageOnce(newAdminClient(), {
          messageId: "msg-2",
          conversationId: "conv-1",
          tenantId: "tenant-1",
        });
        if (result.ok || result.reason !== "message_already_processing") {
          throw new Error(`esperado message_already_processing, veio ${JSON.stringify(result)}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  // Diferente do caso acima (lease ocupada, resposta 200): aqui a RPC quebra
  // (500). O caller ainda cai no mesmo "message_already_processing", mas
  // precisa reportar via reportAIFailure — mesma distinção "erro real vs
  // resultado vazio legítimo" já coberta em enforceRateLimit (rpcFailed).
  await t.step(
    "erro real da RPC (500): reporta via reportAIFailure com tenantId/phase/mensagem",
    async () => {
      let failureLogBody: Record<string, unknown> | null = null;
      const router: FetchMatcher = (req) => {
        if (
          req.pathname === "/rest/v1/rpc/claim_ai_processing_message" &&
          req.method === "POST"
        ) {
          return jsonResponse(500, { message: "db indisponível" });
        }
        if (req.pathname === "/rest/v1/ai_failure_logs" && req.method === "POST") {
          failureLogBody = req.bodyJson as Record<string, unknown>;
          return jsonResponse(201, {});
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const result = await claimMessageOnce(newAdminClient(), {
          messageId: "msg-3",
          conversationId: "conv-1",
          tenantId: "tenant-1",
        });
        if (result.ok || result.reason !== "message_already_processing") {
          throw new Error(`esperado message_already_processing, veio ${JSON.stringify(result)}`);
        }
        if (!failureLogBody) throw new Error("reportAIFailure não inseriu em ai_failure_logs");
        const body = failureLogBody as Record<string, unknown>;
        if (body.tenant_id !== "tenant-1") throw new Error(`tenant_id=${body.tenant_id}`);
        if (body.route !== "ai-respond") throw new Error(`route=${body.route}`);
        const context = body.context as Record<string, unknown>;
        if (context.phase !== "claim") throw new Error(`context.phase=${context.phase}`);
        if (context.conversationId !== "conv-1") {
          throw new Error(`context.conversationId=${context.conversationId}`);
        }
        if (typeof body.error_message !== "string" || (body.error_message as string).length === 0) {
          throw new Error(`error_message vazio: ${body.error_message}`);
        }
      } finally {
        uninstall();
      }
    },
  );
});

// -------------------- coalesceBurst --------------------

Deno.test("coalesceBurst", async (t) => {
  await t.step("mensagem única e mais recente, sem resposta prévia: ok=true", async () => {
    const router: FetchMatcher = (req) => {
      if (req.pathname !== "/rest/v1/messages" || req.method !== "GET") return undefined;
      const sp = new URL(req.url).searchParams;
      if (sp.get("sender") === "eq.ai") return jsonResponse(200, []);
      if (sp.get("direction") === "eq.in") {
        return jsonResponse(200, [{ id: "msg-1", created_at: "2026-01-01T00:00:01.000Z" }]);
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await coalesceBurst(newAdminClient(), {
        conversationId: "conv-1",
        tenantId: "tenant-1",
        messageId: "msg-1",
        messageCreatedAt: "2026-01-01T00:00:01.000Z",
      });
      if (!result.ok) throw new Error(`esperado ok=true, veio ${JSON.stringify(result)}`);
    } finally {
      uninstall();
    }
  });

  await t.step(
    "mensagem mais recente da conversa é outra: reason=coalesced_not_latest",
    async () => {
      const router: FetchMatcher = (req) => {
        if (req.pathname !== "/rest/v1/messages" || req.method !== "GET") return undefined;
        const sp = new URL(req.url).searchParams;
        if (sp.get("sender") === "eq.ai") return jsonResponse(200, []);
        if (sp.get("direction") === "eq.in") {
          return jsonResponse(200, [{ id: "msg-2", created_at: "2026-01-01T00:00:02.000Z" }]);
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const result = await coalesceBurst(newAdminClient(), {
          conversationId: "conv-1",
          tenantId: "tenant-1",
          messageId: "msg-1",
          messageCreatedAt: "2026-01-01T00:00:01.000Z",
        });
        if (result.ok || result.reason !== "coalesced_not_latest") {
          throw new Error(`esperado coalesced_not_latest, veio ${JSON.stringify(result)}`);
        }
      } finally {
        uninstall();
      }
    },
  );
});

// -------------------- loadConversationAndTakeover --------------------

Deno.test("loadConversationAndTakeover", async (t) => {
  await t.step("conversa ativa, sem takeover humano: ok=true com conv", async () => {
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/conversations" && req.method === "GET") {
        return jsonResponse(200, {
          id: "conv-1",
          tenant_id: "tenant-1",
          contact_id: "contact-1",
          channel_id: "chan-1",
          ai_active: true,
          subject: null,
          awaiting_human: false,
          channels: { provider_slug: "zapi", type: "whatsapp" },
        });
      }
      if (req.pathname === "/rest/v1/messages" && req.method === "GET") {
        return jsonResponse(200, null); // nem operador ativo, nem humano respondeu
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await loadConversationAndTakeover(newAdminClient(), {
        conversationId: "conv-1",
        tenantId: "tenant-1",
        aiTakeoverMinutes: 15,
      });
      if (!result.ok) throw new Error(`esperado ok=true, veio ${JSON.stringify(result)}`);
      if (result.conv.id !== "conv-1") throw new Error(`conv.id=${result.conv.id}`);
    } finally {
      uninstall();
    }
  });

  await t.step(
    "conversa com IA pausada (ai_active=false): reason=ai_paused_conversation",
    async () => {
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/conversations" && req.method === "GET") {
          return jsonResponse(200, {
            id: "conv-2",
            tenant_id: "tenant-1",
            contact_id: "contact-1",
            channel_id: "chan-1",
            ai_active: false,
            subject: null,
            awaiting_human: false,
          });
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const result = await loadConversationAndTakeover(newAdminClient(), {
          conversationId: "conv-2",
          tenantId: "tenant-1",
          aiTakeoverMinutes: 15,
        });
        if (result.ok || result.reason !== "ai_paused_conversation") {
          throw new Error(`esperado ai_paused_conversation, veio ${JSON.stringify(result)}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "conversa aguardando humano: bloqueia antes de consultar takeover",
    async () => {
      let messagesQueried = false;
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/conversations" && req.method === "GET") {
          return jsonResponse(200, {
            id: "conv-awaiting",
            tenant_id: "tenant-1",
            contact_id: "contact-1",
            channel_id: "chan-1",
            ai_active: true,
            subject: null,
            awaiting_human: true,
          });
        }
        if (req.pathname === "/rest/v1/messages" && req.method === "GET") {
          messagesQueried = true;
          return jsonResponse(200, null);
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const result = await loadConversationAndTakeover(newAdminClient(), {
          conversationId: "conv-awaiting",
          tenantId: "tenant-1",
          aiTakeoverMinutes: 15,
        });
        if (result.ok || result.reason !== "awaiting_human") {
          throw new Error(`esperado awaiting_human, veio ${JSON.stringify(result)}`);
        }
        if (messagesQueried) {
          throw new Error("gate de awaiting_human deveria bloquear antes da consulta de takeover");
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "takeover bloqueado (operador ativo), awaiting_human era false: marca true E notifica admin (transição)",
    async () => {
      let notifiedRecipientsQuery = false;
      let resendCalled = false;
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/conversations" && req.method === "GET") {
          return jsonResponse(200, {
            id: "conv-3",
            tenant_id: "tenant-1",
            contact_id: "contact-1",
            channel_id: "chan-1",
            ai_active: true,
            subject: null,
            awaiting_human: false,
            channels: { tenant_id: "tenant-1", provider_slug: "zapi", type: "whatsapp" },
          });
        }
        if (req.pathname === "/rest/v1/messages" && req.method === "GET") {
          // sender=eq.agent com created_at recente → isOperatorActive=true.
          return jsonResponse(200, { created_at: new Date().toISOString() });
        }
        if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
          // Guarda otimista (TOCTOU fix): awaiting_human ainda é false neste
          // teste (single-shot, sem corrida) — a linha casa, devolve 1 item.
          return jsonResponse(200, [{ id: "conv-3" }]);
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
          return jsonResponse(200, { id: "email-1" });
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const result = await loadConversationAndTakeover(newAdminClient(), {
          conversationId: "conv-3",
          tenantId: "tenant-1",
          aiTakeoverMinutes: 15,
        });
        if (result.ok || result.reason !== "takeover_blocked_operator_active") {
          throw new Error(
            `esperado takeover_blocked_operator_active, veio ${JSON.stringify(result)}`,
          );
        }
        if (!notifiedRecipientsQuery) {
          throw new Error("notifyAdminHandoff não consultou destinatários");
        }
        if (!resendCalled) throw new Error("notifyAdminHandoff não chamou o Resend");
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "awaiting_human já era true: não consulta takeover, não atualiza e não notifica",
    async () => {
      let takeoverQueried = false;
      let conversationPatched = false;
      let recipientsQueried = false;
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/conversations" && req.method === "GET") {
          return jsonResponse(200, {
            id: "conv-4",
            tenant_id: "tenant-1",
            contact_id: "contact-1",
            channel_id: "chan-1",
            ai_active: true,
            subject: null,
            awaiting_human: true,
          });
        }
        if (req.pathname === "/rest/v1/messages" && req.method === "GET") {
          takeoverQueried = true;
          return jsonResponse(200, { created_at: new Date().toISOString() });
        }
        if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
          conversationPatched = true;
          return jsonResponse(200, []);
        }
        if (req.pathname === "/rest/v1/weekly_report_recipients" && req.method === "GET") {
          recipientsQueried = true;
          return jsonResponse(200, []);
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const result = await loadConversationAndTakeover(newAdminClient(), {
          conversationId: "conv-4",
          tenantId: "tenant-1",
          aiTakeoverMinutes: 15,
        });
        if (result.ok || result.reason !== "awaiting_human") {
          throw new Error(`esperado awaiting_human, veio ${JSON.stringify(result)}`);
        }
        if (takeoverQueried || conversationPatched || recipientsQueried) {
          throw new Error("awaiting_human deve bloquear antes de qualquer efeito de takeover");
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "TOCTOU: 2 chamadas concorrentes na mesma conversa (awaiting_human=false) resultam em só 1 notificação",
    async () => {
      // Simula a corrida real: as duas invocações leem awaiting_human=false
      // (via GET) e as duas decidem bloquear (operador ativo). Sem a guarda
      // otimista do UPDATE, as duas notificariam. `awaitingHuman` simula a
      // linha em conversations — só quem "vence" o UPDATE condicional (JS é
      // single-threaded, então só uma execução do matcher PATCH encontra
      // awaitingHuman ainda false) flipa o estado e notifica.
      let awaitingHuman = false;
      let notifyAttempts = 0;
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/conversations" && req.method === "GET") {
          return jsonResponse(200, {
            id: "conv-race",
            tenant_id: "tenant-1",
            contact_id: "contact-1",
            channel_id: "chan-1",
            ai_active: true,
            subject: null,
            awaiting_human: awaitingHuman,
            channels: { tenant_id: "tenant-1", provider_slug: "zapi", type: "whatsapp" },
          });
        }
        if (req.pathname === "/rest/v1/messages" && req.method === "GET") {
          // sender=eq.agent com created_at recente → isOperatorActive=true
          // nas duas invocações (as duas devem bloquear).
          return jsonResponse(200, { created_at: new Date().toISOString() });
        }
        if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
          const sp = new URL(req.url).searchParams;
          if (sp.get("awaiting_human") === "eq.false" && !awaitingHuman) {
            awaitingHuman = true;
            return jsonResponse(200, [{ id: "conv-race" }]);
          }
          return jsonResponse(200, []);
        }
        if (req.pathname === "/rest/v1/hitl_handoff_sla_events" && req.method === "GET") {
          return jsonResponse(200, []); // sem cooldown ativo
        }
        if (req.pathname === "/rest/v1/weekly_report_recipients" && req.method === "GET") {
          notifyAttempts++;
          return jsonResponse(200, []); // no-op silencioso, só queremos contar a tentativa
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const [r1, r2] = await Promise.all([
          loadConversationAndTakeover(newAdminClient(), {
            conversationId: "conv-race",
            tenantId: "tenant-1",
            aiTakeoverMinutes: 15,
          }),
          loadConversationAndTakeover(newAdminClient(), {
            conversationId: "conv-race",
            tenantId: "tenant-1",
            aiTakeoverMinutes: 15,
          }),
        ]);
        if (r1.ok || r2.ok) {
          throw new Error(`as duas chamadas deveriam bloquear: ${JSON.stringify([r1, r2])}`);
        }
        if (notifyAttempts !== 1) {
          throw new Error(`esperado exatamente 1 tentativa de notificação, veio ${notifyAttempts}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "H10 — erro de banco no claim de awaiting_human: notifica admin mesmo assim (não é 'outra invocação venceu')",
    async () => {
      // supabase-js devolve { data: null, error } em falha de banco, o mesmo
      // `data` de "o WHERE não casou nenhuma linha". Sem checar o error, o
      // erro vira "a corrida foi vencida por outra invocação" e o handoff
      // pedido pelo cliente nunca chega ao admin (05-silent-failures.md, H10).
      // Flag síncrona, nunca throw-no-matcher: notifyAdminHandoff não propaga.
      let notifiedRecipientsQuery = false;
      let resendCalled = false;
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/conversations" && req.method === "GET") {
          return jsonResponse(200, {
            id: "conv-claim-err",
            tenant_id: "tenant-1",
            contact_id: "contact-1",
            channel_id: "chan-1",
            ai_active: true,
            subject: null,
            awaiting_human: false,
            channels: { tenant_id: "tenant-1", provider_slug: "zapi", type: "whatsapp" },
          });
        }
        if (req.pathname === "/rest/v1/messages" && req.method === "GET") {
          return jsonResponse(200, { created_at: new Date().toISOString() });
        }
        if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
          return jsonResponse(500, { message: "db indisponível" });
        }
        if (req.pathname === "/rest/v1/hitl_handoff_sla_events" && req.method === "GET") {
          return jsonResponse(200, []);
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
          return jsonResponse(200, { id: "email-1" });
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const result = await loadConversationAndTakeover(newAdminClient(), {
          conversationId: "conv-claim-err",
          tenantId: "tenant-1",
          aiTakeoverMinutes: 15,
        });
        if (result.ok || result.reason !== "takeover_blocked_operator_active") {
          throw new Error(
            `esperado takeover_blocked_operator_active, veio ${JSON.stringify(result)}`,
          );
        }
        if (!notifiedRecipientsQuery) {
          throw new Error("erro no claim virou 'outra invocação cuidou': admin não foi consultado");
        }
        if (!resendCalled) {
          throw new Error("erro no claim engoliu o alerta: Resend não foi chamado");
        }
      } finally {
        uninstall();
      }
    },
  );
});

// -------------------- loadTenant --------------------

Deno.test("loadTenant", async (t) => {
  await t.step("tenant com ai_enabled=true: ok=true", async () => {
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/tenants" && req.method === "GET") {
        return jsonResponse(200, {
          id: "tenant-1",
          name: "Clínica X",
          business_profile: {},
          ai_enabled: true,
        });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await loadTenant(newAdminClient(), "tenant-1");
      if (!result.ok) throw new Error(`esperado ok=true, veio ${JSON.stringify(result)}`);
      if (result.tenant.name !== "Clínica X") throw new Error(`tenant.name=${result.tenant.name}`);
    } finally {
      uninstall();
    }
  });

  await t.step("tenant não encontrado: reason=tenant_not_found", async () => {
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/tenants" && req.method === "GET") {
        return jsonResponse(200, null);
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await loadTenant(newAdminClient(), "tenant-x");
      if (result.ok || result.reason !== "tenant_not_found") {
        throw new Error(`esperado tenant_not_found, veio ${JSON.stringify(result)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("tenant com ai_enabled=false: reason=ai_disabled_tenant", async () => {
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/tenants" && req.method === "GET") {
        return jsonResponse(200, {
          id: "tenant-2",
          name: "Clínica Y",
          business_profile: {},
          ai_enabled: false,
        });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await loadTenant(newAdminClient(), "tenant-2");
      if (result.ok || result.reason !== "ai_disabled_tenant") {
        throw new Error(`esperado ai_disabled_tenant, veio ${JSON.stringify(result)}`);
      }
    } finally {
      uninstall();
    }
  });
});

// -------------------- loadContact --------------------

Deno.test("loadContact", async (t) => {
  await t.step("contato sem pausa de IA: ok=true", async () => {
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/contacts" && req.method === "GET") {
        return jsonResponse(200, {
          id: "contact-1",
          name: "Fulano",
          phone: "5511999999999",
          email: null,
          ai_paused: false,
        });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await loadContact(newAdminClient(), "contact-1");
      if (!result.ok) throw new Error(`esperado ok=true, veio ${JSON.stringify(result)}`);
      if (result.contact.name !== "Fulano") throw new Error(`contact.name=${result.contact.name}`);
    } finally {
      uninstall();
    }
  });

  await t.step("contato não encontrado: reason=contact_not_found", async () => {
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/contacts" && req.method === "GET") {
        return jsonResponse(200, null);
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await loadContact(newAdminClient(), "contact-x");
      if (result.ok || result.reason !== "contact_not_found") {
        throw new Error(`esperado contact_not_found, veio ${JSON.stringify(result)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("contato com ai_paused=true: reason=ai_paused_contact", async () => {
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/contacts" && req.method === "GET") {
        return jsonResponse(200, {
          id: "contact-2",
          name: "Ciclana",
          phone: null,
          email: "c@x.com",
          ai_paused: true,
        });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await loadContact(newAdminClient(), "contact-2");
      if (result.ok || result.reason !== "ai_paused_contact") {
        throw new Error(`esperado ai_paused_contact, veio ${JSON.stringify(result)}`);
      }
    } finally {
      uninstall();
    }
  });
});

// -------------------- ensureAiSettings --------------------

Deno.test("ensureAiSettings", async (t) => {
  await t.step("settings existentes com model custom: usa o model do tenant", async () => {
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/ai_settings" && req.method === "GET") {
        return jsonResponse(200, {
          tenant_id: "tenant-1",
          base_system_prompt: "prompt base",
          handoff_default_keywords: ["falar com humano"],
          send_mode: "auto",
          model: "google/gemini-2.5-pro",
        });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await ensureAiSettings(
        newAdminClient(),
        "tenant-1",
        "google/gemini-2.5-flash",
      );
      if (!result.ok) throw new Error(`esperado ok:true, veio reason=${result.reason}`);
      if (result.effectiveModel !== "google/gemini-2.5-pro") {
        throw new Error(`effectiveModel=${result.effectiveModel}`);
      }
      if (result.defaultKeywords.length !== 1 || result.defaultKeywords[0] !== "falar com humano") {
        throw new Error(`defaultKeywords=${JSON.stringify(result.defaultKeywords)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "sem settings ainda: cria a linha e devolve defaults (keywords padrão, model do param)",
    async () => {
      let insertBody: Record<string, unknown> | null = null;
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/ai_settings" && req.method === "GET") {
          return jsonResponse(200, null);
        }
        if (req.pathname === "/rest/v1/ai_settings" && req.method === "POST") {
          insertBody = req.bodyJson as Record<string, unknown>;
          return jsonResponse(201, {
            tenant_id: "tenant-2",
            base_system_prompt: null,
            handoff_default_keywords: insertBody.handoff_default_keywords,
            send_mode: null,
            model: null,
          });
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const result = await ensureAiSettings(
          newAdminClient(),
          "tenant-2",
          "google/gemini-2.5-flash",
        );
        if (!result.ok) throw new Error(`esperado ok:true, veio reason=${result.reason}`);
        if (result.effectiveModel !== "google/gemini-2.5-flash") {
          throw new Error(`effectiveModel=${result.effectiveModel}`);
        }
        if (!result.defaultKeywords.includes("falar com humano")) {
          throw new Error(`defaultKeywords=${JSON.stringify(result.defaultKeywords)}`);
        }
        if (!insertBody) throw new Error("insert em ai_settings não foi chamado");
      } finally {
        uninstall();
      }
    },
  );

  // Regressão 05·H2: com o SELECT falhando, a versão antiga devolvia
  // settings=null e o pipeline respondia o cliente com a PERSONA DE FÁBRICA
  // (ai-respond/index.ts lê `settings?.base_system_prompt ?? null`), sem sinal
  // nenhum. Agora o gate nega e o incidente fica em ai_failure_logs.
  await t.step(
    "erro persistente no SELECT: nega o gate em vez de cair na persona padrão",
    async () => {
      let selects = 0;
      const failureLogs: Array<Record<string, unknown>> = [];
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/ai_settings" && req.method === "GET") {
          selects++;
          return jsonResponse(500, { message: "db indisponível", code: "XX000" });
        }
        if (req.pathname === "/rest/v1/ai_settings" && req.method === "POST") {
          return jsonResponse(201, { tenant_id: "tenant-3" });
        }
        if (req.pathname === "/rest/v1/ai_failure_logs" && req.method === "POST") {
          failureLogs.push(req.bodyJson as Record<string, unknown>);
          return jsonResponse(201, {});
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const result = await ensureAiSettings(
          newAdminClient(),
          "tenant-3",
          "google/gemini-2.5-flash",
        );
        if (result.ok) {
          throw new Error("erro de infra no SELECT não pode virar settings=null com ok:true");
        }
        if (result.reason !== "ai_settings_unavailable") {
          throw new Error(`reason=${result.reason}`);
        }
        if (selects !== 2) throw new Error(`esperava 1 retentativa do SELECT, houve ${selects}`);
        if (failureLogs.length === 0) {
          throw new Error("falha do SELECT tem que deixar rastro em ai_failure_logs");
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("blip transitório no SELECT: a retentativa resolve e o gate passa", async () => {
    let selects = 0;
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/ai_settings" && req.method === "GET") {
        selects++;
        if (selects === 1) return jsonResponse(500, { message: "blip", code: "XX000" });
        return jsonResponse(200, {
          tenant_id: "tenant-4",
          base_system_prompt: "persona do tenant",
          handoff_default_keywords: ["atendente"],
          send_mode: "auto",
          model: "default",
        });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await ensureAiSettings(
        newAdminClient(),
        "tenant-4",
        "google/gemini-2.5-flash",
      );
      if (!result.ok) throw new Error(`esperado ok:true, veio reason=${result.reason}`);
      if (result.settings?.base_system_prompt !== "persona do tenant") {
        throw new Error(`persona do tenant se perdeu: ${JSON.stringify(result.settings)}`);
      }
    } finally {
      uninstall();
    }
  });

  // Contraponto do bloqueio acima: aqui o SELECT foi LIMPO e disse que o
  // tenant não tem linha — não existe persona própria pra ser trocada, então
  // seguir com defaults é honesto. O que não pode é seguir mudo.
  await t.step(
    "INSERT falha sem conflito: segue com defaults, mas registra em ai_failure_logs",
    async () => {
      const failureLogs: Array<Record<string, unknown>> = [];
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/ai_settings" && req.method === "GET") {
          return jsonResponse(200, null);
        }
        if (req.pathname === "/rest/v1/ai_settings" && req.method === "POST") {
          return jsonResponse(500, { message: "insert failed", code: "XX000" });
        }
        if (req.pathname === "/rest/v1/ai_failure_logs" && req.method === "POST") {
          failureLogs.push(req.bodyJson as Record<string, unknown>);
          return jsonResponse(201, {});
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const result = await ensureAiSettings(
          newAdminClient(),
          "tenant-6",
          "google/gemini-2.5-flash",
        );
        if (!result.ok) {
          throw new Error(`tenant sem linha não pode ficar sem resposta: ${result.reason}`);
        }
        if (result.settings !== null) throw new Error("settings deveria ser null");
        if (failureLogs.length === 0) {
          throw new Error("insert que falhou não pode passar mudo");
        }
      } finally {
        uninstall();
      }
    },
  );

  // Corrida benigna: outra isolate criou a linha entre o nosso SELECT e o
  // INSERT. A linha EXISTE — reler é o certo; negar o gate aqui seria perder
  // uma resposta por concorrência normal.
  await t.step("conflito 23505 no INSERT: relê a linha e segue com a persona do tenant", async () => {
    let selects = 0;
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/ai_settings" && req.method === "GET") {
        selects++;
        if (selects === 1) return jsonResponse(200, null);
        return jsonResponse(200, {
          tenant_id: "tenant-5",
          base_system_prompt: "persona criada pela outra isolate",
          handoff_default_keywords: ["atendente"],
          send_mode: "auto",
          model: "default",
        });
      }
      if (req.pathname === "/rest/v1/ai_settings" && req.method === "POST") {
        return jsonResponse(409, { message: "duplicate key value", code: "23505" });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await ensureAiSettings(
        newAdminClient(),
        "tenant-5",
        "google/gemini-2.5-flash",
      );
      if (!result.ok) throw new Error(`corrida benigna não pode negar o gate: ${result.reason}`);
      if (result.settings?.base_system_prompt !== "persona criada pela outra isolate") {
        throw new Error(`não releu a linha após o conflito: ${JSON.stringify(result.settings)}`);
      }
    } finally {
      uninstall();
    }
  });
});

// -------------------- enforceRateLimit --------------------

const RATE_LIMIT_RPC = "/rest/v1/rpc/check_and_record_rate_limit";

Deno.test("enforceRateLimit", async (t) => {
  await t.step("dentro do limite: ok=true", async () => {
    const router: FetchMatcher = (req) => {
      if (req.pathname === RATE_LIMIT_RPC && req.method === "POST") {
        return jsonResponse(200, { allowed: true, retryAfterSeconds: 0 });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await enforceRateLimit(newAdminClient(), {
        conversationId: "conv-1",
        tenantId: "tenant-1",
        aiRateLimitMaxCalls: 5,
        aiRateLimitWindowMs: 60_000,
      });
      if (!result.ok) throw new Error(`esperado ok=true, veio ${JSON.stringify(result)}`);
    } finally {
      uninstall();
    }
  });

  await t.step(
    "RPC fora do ar (fail-closed), awaiting_human já era true: reason=rate_limited, NÃO notifica admin",
    async () => {
      // Flag síncrona em vez de throw-no-matcher — mesmo motivo do teste
      // equivalente em loadConversationAndTakeover acima: notifyAdminHandoff
      // nunca propaga exceção, então um throw aqui não pegaria a guarda
      // condicional do UPDATE sendo removida por engano.
      let recipientsQueried = false;
      const router: FetchMatcher = (req) => {
        if (req.pathname === RATE_LIMIT_RPC && req.method === "POST") {
          return jsonResponse(500, { message: "db indisponível" });
        }
        if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
          // Guarda otimista: awaiting_human já é true, 0 linhas casadas.
          return jsonResponse(200, []);
        }
        if (req.pathname === "/rest/v1/weekly_report_recipients" && req.method === "GET") {
          recipientsQueried = true;
          return jsonResponse(200, []);
        }
        return undefined; // ai_failure_logs cai no catch-all 501, sem lançar
      };
      const uninstall = installFetchMock(router);
      try {
        const result = await enforceRateLimit(newAdminClient(), {
          conversationId: "conv-2",
          tenantId: "tenant-1",
          aiRateLimitMaxCalls: 5,
          aiRateLimitWindowMs: 60_000,
        });
        if (result.ok || result.reason !== "rate_limited") {
          throw new Error(`esperado rate_limited, veio ${JSON.stringify(result)}`);
        }
        if (recipientsQueried) {
          throw new Error("não deveria notificar admin: guarda otimista não casou nenhuma linha");
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "RPC fora do ar (fail-closed), awaiting_human era false: reason=rate_limited E notifica admin (transição false→true)",
    async () => {
      let notifiedRecipientsQuery = false;
      let resendCalled = false;
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/conversations" && req.method === "GET") {
          return jsonResponse(200, {
            channels: { tenant_id: "tenant-1", provider_slug: "zapi", type: "whatsapp" },
          });
        }
        if (req.pathname === RATE_LIMIT_RPC && req.method === "POST") {
          return jsonResponse(500, { message: "db indisponível" });
        }
        if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
          // Guarda otimista: awaiting_human ainda é false, a linha casa.
          return jsonResponse(200, [{ id: "conv-3" }]);
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
          return jsonResponse(200, { id: "email-1" });
        }
        return undefined; // ai_failure_logs cai no catch-all 501, sem lançar
      };
      const uninstall = installFetchMock(router);
      try {
        const result = await enforceRateLimit(newAdminClient(), {
          conversationId: "conv-3",
          tenantId: "tenant-1",
          aiRateLimitMaxCalls: 5,
          aiRateLimitWindowMs: 60_000,
        });
        if (result.ok || result.reason !== "rate_limited") {
          throw new Error(`esperado rate_limited, veio ${JSON.stringify(result)}`);
        }
        if (!notifiedRecipientsQuery) {
          throw new Error("notifyAdminHandoff não consultou destinatários");
        }
        if (!resendCalled) throw new Error("notifyAdminHandoff não chamou o Resend");
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "TOCTOU: 2 chamadas concorrentes na mesma conversa (awaiting_human=false) resultam em só 1 notificação",
    async () => {
      let awaitingHuman = false;
      let notifyAttempts = 0;
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/conversations" && req.method === "GET") {
          return jsonResponse(200, {
            channels: { tenant_id: "tenant-1", provider_slug: "zapi", type: "whatsapp" },
          });
        }
        if (req.pathname === RATE_LIMIT_RPC && req.method === "POST") {
          return jsonResponse(500, { message: "db indisponível" });
        }
        if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
          const sp = new URL(req.url).searchParams;
          if (sp.get("awaiting_human") === "eq.false" && !awaitingHuman) {
            awaitingHuman = true;
            return jsonResponse(200, [{ id: "conv-race" }]);
          }
          return jsonResponse(200, []);
        }
        if (req.pathname === "/rest/v1/hitl_handoff_sla_events" && req.method === "GET") {
          return jsonResponse(200, []); // sem cooldown ativo
        }
        if (req.pathname === "/rest/v1/weekly_report_recipients" && req.method === "GET") {
          notifyAttempts++;
          return jsonResponse(200, []); // no-op silencioso, só queremos contar a tentativa
        }
        return undefined; // ai_failure_logs cai no catch-all 501, sem lançar
      };
      const uninstall = installFetchMock(router);
      try {
        const [r1, r2] = await Promise.all([
          enforceRateLimit(newAdminClient(), {
            conversationId: "conv-race",
            tenantId: "tenant-1",
            aiRateLimitMaxCalls: 5,
            aiRateLimitWindowMs: 60_000,
          }),
          enforceRateLimit(newAdminClient(), {
            conversationId: "conv-race",
            tenantId: "tenant-1",
            aiRateLimitMaxCalls: 5,
            aiRateLimitWindowMs: 60_000,
          }),
        ]);
        if (r1.ok || r2.ok) {
          throw new Error(
            `as duas chamadas deveriam negar por rate limit: ${JSON.stringify([r1, r2])}`,
          );
        }
        if (notifyAttempts !== 1) {
          throw new Error(`esperado exatamente 1 tentativa de notificação, veio ${notifyAttempts}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "H10 — RPC fora do ar E erro de banco no claim: ainda notifica admin (fail-closed não pode ser mudo)",
    async () => {
      // Mesmo terceiro estado do claim de takeover: aqui a IA já negou por
      // fail-closed (RPC quebrada); perder também o alerta deixa a conversa
      // muda dos dois lados.
      let notifiedRecipientsQuery = false;
      let resendCalled = false;
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/conversations" && req.method === "GET") {
          return jsonResponse(200, {
            channels: { tenant_id: "tenant-1", provider_slug: "zapi", type: "whatsapp" },
          });
        }
        if (req.pathname === RATE_LIMIT_RPC && req.method === "POST") {
          return jsonResponse(500, { message: "rpc indisponível" });
        }
        if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
          return jsonResponse(500, { message: "db indisponível" });
        }
        if (req.pathname === "/rest/v1/hitl_handoff_sla_events" && req.method === "GET") {
          return jsonResponse(200, []);
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
          return jsonResponse(200, { id: "email-1" });
        }
        return undefined; // ai_failure_logs cai no catch-all 501, sem lançar
      };
      const uninstall = installFetchMock(router);
      try {
        const result = await enforceRateLimit(newAdminClient(), {
          conversationId: "conv-claim-err-rl",
          tenantId: "tenant-1",
          aiRateLimitMaxCalls: 5,
          aiRateLimitWindowMs: 60_000,
        });
        if (result.ok || result.reason !== "rate_limited") {
          throw new Error(`esperado rate_limited, veio ${JSON.stringify(result)}`);
        }
        if (!notifiedRecipientsQuery) {
          throw new Error("erro no claim virou 'outra invocação cuidou': admin não foi consultado");
        }
        if (!resendCalled) {
          throw new Error("erro no claim engoliu o alerta: Resend não foi chamado");
        }
      } finally {
        uninstall();
      }
    },
  );
});

// -------------------- acquireConcurrencyLock --------------------

Deno.test("acquireConcurrencyLock", async (t) => {
  await t.step(
    "lock livre: ok=true com lockToken (token gerado pelo caller, não do body)",
    async () => {
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
          return jsonResponse(200, { ai_lock_token: "server-generated-token" });
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const result = await acquireConcurrencyLock(newAdminClient(), "conv-1", 30_000);
        if (!result.ok) throw new Error(`esperado ok=true, veio ${JSON.stringify(result)}`);
        if (!result.lockToken || result.lockToken.length === 0) {
          throw new Error(`lockToken vazio: ${result.lockToken}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("lock já tomado (0 linhas / PGRST116): reason=locked", async () => {
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
        return jsonResponse(406, { code: "PGRST116", message: "0 rows" });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await acquireConcurrencyLock(newAdminClient(), "conv-2", 30_000);
      if (result.ok || result.reason !== "locked") {
        throw new Error(`esperado locked, veio ${JSON.stringify(result)}`);
      }
    } finally {
      uninstall();
    }
  });
});
