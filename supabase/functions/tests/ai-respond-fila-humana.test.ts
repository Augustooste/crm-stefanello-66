// Regressão do achado 05 · H7 do code review de 10/08
// (docs/code-review/10-code-review-e2e-2026-08-10.md):
//
// No catch de generation_failed, o `update({ last_error, awaiting_human: true })`
// não checava `error` e `notifyAdminHandoff` disparava logo em seguida. O admin
// lia "a conversa foi para a fila humana" enquanto `awaiting_human` continuava
// false — a conversa não aparecia em /inbox (src/lib/api/human-attention.ts
// filtra por awaiting_human=true) e o cliente ficava sem resposta e sem
// ninguém atribuído, sem nenhum sinal.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import {
  BASE_ENV,
  captureHandler,
  type FetchMatcher,
  installFetchMock,
  jsonResponse,
  setEnv,
} from "./_helpers.ts";

setEnv(BASE_ENV);
setEnv({ LOVABLE_API_KEY: "lovable-key" });

// captureHandler importa o módulo com Deno.serve interceptado; só depois é
// seguro reimportar para pegar o export nomeado (módulo já em cache).
await captureHandler("../ai-respond/index.ts");
const { enfileirarParaHumanoAposFalha } = (await import("../ai-respond/index.ts")) as {
  enfileirarParaHumanoAposFalha: (
    admin: SupabaseClient,
    params: {
      tenantId: string;
      conversationId: string;
      aiError: { code: string; message: string };
      wasAwaitingHuman: boolean;
      messageId: string;
    },
  ) => Promise<boolean>;
};

function newAdminClient() {
  return createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

interface MockState {
  /** Faz o UPDATE que coloca a conversa na fila humana falhar. */
  falharUpdateConversa: boolean;
  patchesConversa: Record<string, unknown>[];
  systemEvents: Record<string, unknown>[];
  /** notifyAdminHandoff começa lendo hitl_handoff_sla_events (cooldown). */
  notificacoesTentadas: number;
}

function defaultState(): MockState {
  return {
    falharUpdateConversa: false,
    patchesConversa: [],
    systemEvents: [],
    notificacoesTentadas: 0,
  };
}

function router(state: MockState): FetchMatcher {
  return (r) => {
    if (r.pathname === "/rest/v1/conversations" && r.method === "GET") {
      return jsonResponse(200, {
        channels: { tenant_id: "tenant-1", provider_slug: "zapi", type: "whatsapp" },
      });
    }
    if (r.pathname === "/rest/v1/conversations" && r.method === "PATCH") {
      if (state.falharUpdateConversa) {
        return jsonResponse(500, { message: "could not serialize access", code: "40001" });
      }
      state.patchesConversa.push(r.bodyJson as Record<string, unknown>);
      return new Response(null, { status: 204 });
    }

    if (r.pathname === "/rest/v1/system_events" && r.method === "POST") {
      state.systemEvents.push(r.bodyJson as Record<string, unknown>);
      return jsonResponse(201, []);
    }

    // Primeira query de notifyAdminHandoff. Devolver uma linha recente =
    // cooldown ativo: a notificação para aqui, sem precisar mockar
    // destinatários nem Resend. O que importa é SE ela foi tentada.
    if (r.pathname === "/rest/v1/hitl_handoff_sla_events" && r.method === "GET") {
      state.notificacoesTentadas++;
      return jsonResponse(200, [{ id: "sla-1" }, { id: "sla-2" }]);
    }

    return undefined;
  };
}

const AI_ERROR = { code: "provider_error", message: "gateway 503" };

Deno.test("ai-respond: fila humana só é anunciada se foi gravada (05 · H7)", async (t) => {
  await t.step("UPDATE falhou: não notifica o admin e grava evento consultável", async () => {
    const state = defaultState();
    state.falharUpdateConversa = true;
    const uninstall = installFetchMock(router(state));
    try {
      const enfileirado = await enfileirarParaHumanoAposFalha(newAdminClient(), {
        tenantId: "tenant-1",
        conversationId: "conv-1",
        aiError: AI_ERROR,
        wasAwaitingHuman: false,
        messageId: "msg-1",
      });

      if (enfileirado !== false) {
        throw new Error("esperava false: a conversa NÃO entrou na fila humana");
      }
      if (state.notificacoesTentadas !== 0) {
        throw new Error(
          "notificou o admin sobre um enfileiramento que não aconteceu (a conversa segue fora de /inbox)",
        );
      }
      const evento = state.systemEvents.find((e) => e.error_code === "handoff_write_failed");
      if (!evento) {
        throw new Error(
          `falha ao enfileirar não gerou system_events; eventos: ${
            JSON.stringify(state.systemEvents.map((e) => e.operation))
          }`,
        );
      }
      if (evento.severity !== "error") {
        throw new Error(`esperava severity=error, veio ${evento.severity}`);
      }
      if (evento.conversation_id !== "conv-1" || evento.tenant_id !== "tenant-1") {
        throw new Error(`evento sem conversa/tenant: ${JSON.stringify(evento)}`);
      }
    } finally {
      uninstall();
    }
  });

  // Controle positivo: sem ele, "nunca notificar" passaria no teste acima.
  await t.step("UPDATE ok e transição false→true: notifica o admin", async () => {
    const state = defaultState();
    const uninstall = installFetchMock(router(state));
    try {
      const enfileirado = await enfileirarParaHumanoAposFalha(newAdminClient(), {
        tenantId: "tenant-1",
        conversationId: "conv-1",
        aiError: AI_ERROR,
        wasAwaitingHuman: false,
        messageId: "msg-1",
      });

      if (enfileirado !== true) throw new Error("esperava true: fila humana gravada");
      if (state.notificacoesTentadas !== 1) {
        throw new Error(`esperava 1 notificação, veio ${state.notificacoesTentadas}`);
      }
      const patch = state.patchesConversa[0];
      if (patch?.awaiting_human !== true) {
        throw new Error(`esperava awaiting_human=true no patch, veio ${JSON.stringify(patch)}`);
      }
      if (state.systemEvents.some((e) => e.error_code === "handoff_write_failed")) {
        throw new Error("gravou evento de falha num caminho que deu certo");
      }
    } finally {
      uninstall();
    }
  });

  await t.step("já estava awaiting_human: grava mas não renotifica", async () => {
    const state = defaultState();
    const uninstall = installFetchMock(router(state));
    try {
      const enfileirado = await enfileirarParaHumanoAposFalha(newAdminClient(), {
        tenantId: "tenant-1",
        conversationId: "conv-1",
        aiError: AI_ERROR,
        wasAwaitingHuman: true,
        messageId: "msg-1",
      });
      if (enfileirado !== true) throw new Error("esperava true: fila humana gravada");
      if (state.notificacoesTentadas !== 0) {
        throw new Error("renotificou sem transição false→true");
      }
    } finally {
      uninstall();
    }
  });
});
