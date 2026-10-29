// inbound-ai-flow.test.ts — regressão do incidente 2026-07-31 (a IA parou de
// responder em Zappaz e Meta WhatsApp, e o áudio não era processado).
//
// A causa raiz não estava na normalização do webhook e sim no gate de
// takeover: qualquer mensagem de atendente no histórico bloqueava a IA para
// SEMPRE, então toda nova mensagem do lead (texto ou áudio) voltava a marcar
// awaiting_human e o pipeline morria antes da transcrição. A reativação
// explícita (conversations.ai_resumed_at) é o único caminho de retomada.
//
// Este arquivo roda a MESMA matriz para os dois provedores contra os helpers
// reais de gates.ts, com um PostgREST de mentira que aplica os filtros de
// verdade (eq/gt/order/limit) — sem isso, um teste passa mesmo que o corte
// temporal nunca chegue à query.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { assertEquals } from "jsr:@std/assert@1";
import { BASE_ENV, installFetchMock, jsonResponse, setEnv } from "./_helpers.ts";
import { loadConversationAndTakeover, loadTriggerMessage } from "../_shared/ai/gates.ts";

setEnv(BASE_ENV);

const TAKEOVER_MINUTES = 30;
const TENANT = "tenant-1";
const CONV = "conv-1";

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

interface DbMessage {
  id: string;
  tenant_id: string;
  conversation_id: string;
  sender: "contact" | "agent" | "ai" | "automation";
  direction: "in" | "out";
  content: string;
  media_url: string | null;
  media_type: string | null;
  created_at: string;
}

interface DbConversation {
  id: string;
  tenant_id: string;
  contact_id: string;
  channel_id: string;
  ai_active: boolean;
  awaiting_human: boolean;
  subject: string | null;
  ai_resumed_at: string | null;
  channels: { provider_slug: string; type: string };
}

interface Db {
  messages: DbMessage[];
  conversation: DbConversation;
  /** PATCHes recebidos em conversations — prova o claim de awaiting_human. */
  conversationPatches: Array<Record<string, unknown>>;
}

/** Aplica os filtros que o supabase-js serializa na querystring. */
function applyFilters(rows: DbMessage[], params: URLSearchParams): DbMessage[] {
  let out = [...rows];
  for (const [column, raw] of params.entries()) {
    if (["select", "order", "limit", "offset"].includes(column)) continue;
    const [op, ...rest] = raw.split(".");
    const value = rest.join(".");
    out = out.filter((row) => {
      const actual = (row as unknown as Record<string, unknown>)[column];
      if (op === "eq") return String(actual) === value;
      if (op === "gt") return String(actual) > value;
      if (op === "gte") return String(actual) >= value;
      return true;
    });
  }
  const order = params.get("order");
  if (order?.startsWith("created_at")) {
    const desc = order.includes("desc");
    out.sort((a, b) =>
      desc ? b.created_at.localeCompare(a.created_at) : a.created_at.localeCompare(b.created_at)
    );
  }
  return out;
}

function installDb(db: Db): () => void {
  return installFetchMock((req) => {
    const url = new URL(req.url);
    if (req.pathname === "/rest/v1/messages" && req.method === "GET") {
      const rows = applyFilters(db.messages, url.searchParams);
      return jsonResponse(200, rows[0] ?? null);
    }
    if (req.pathname === "/rest/v1/conversations" && req.method === "GET") {
      return jsonResponse(200, db.conversation);
    }
    if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
      db.conversationPatches.push(req.bodyJson as Record<string, unknown>);
      // O claim é `.eq("awaiting_human", false)`: só casa linha quando ESTA
      // invocação causou a transição.
      const matched = db.conversation.awaiting_human === false;
      if (matched) db.conversation.awaiting_human = true;
      return jsonResponse(200, matched ? [{ id: CONV }] : []);
    }
    // Qualquer outra escrita de telemetria/handoff: aceita e ignora.
    return jsonResponse(200, []);
  });
}

function newAdminClient() {
  return createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

type Provider = "zappaz" | "meta-cloud";
type Kind = "text" | "audio";

/** Mensagem do lead como o webbook de cada provedor a persiste hoje. */
function inboundMessage(provider: Provider, kind: Kind): DbMessage {
  const base = {
    id: "msg-trigger",
    tenant_id: TENANT,
    conversation_id: CONV,
    sender: "contact" as const,
    direction: "in" as const,
    created_at: minutesAgo(0),
  };
  if (kind === "text") {
    return { ...base, content: "teste2029", media_url: null, media_type: null };
  }
  return {
    ...base,
    // Marcador único dos dois canais (messaging-webhook/index.ts e
    // normalizers.ts) — a transcrição usa media_url, não o texto.
    content: "[audio recebida — abra no WhatsApp para ver]",
    media_url: provider === "zappaz"
      ? "https://mmg.whatsapp.net/v/audio-enc.enc"
      : "meta-media:987654321",
    media_type: "audio/ogg; codecs=opus",
  };
}

function makeDb(
  provider: Provider,
  kind: Kind,
  opts: {
    agentRepliedMinutesAgo?: number;
    resumedMinutesAgo?: number;
    aiActive?: boolean;
    awaitingHuman?: boolean;
  } = {},
): Db {
  const messages: DbMessage[] = [inboundMessage(provider, kind)];
  if (opts.agentRepliedMinutesAgo !== undefined) {
    messages.push({
      id: "msg-agent",
      tenant_id: TENANT,
      conversation_id: CONV,
      sender: "agent",
      direction: "out",
      content: "eu assumo daqui",
      media_url: null,
      media_type: null,
      created_at: minutesAgo(opts.agentRepliedMinutesAgo),
    });
  }
  return {
    messages,
    conversationPatches: [],
    conversation: {
      id: CONV,
      tenant_id: TENANT,
      contact_id: "contact-1",
      channel_id: "chan-1",
      ai_active: opts.aiActive ?? true,
      awaiting_human: opts.awaitingHuman ?? false,
      subject: null,
      ai_resumed_at: opts.resumedMinutesAgo === undefined
        ? null
        : minutesAgo(opts.resumedMinutesAgo),
      channels: { provider_slug: provider, type: "whatsapp" },
    },
  };
}

async function runGateChain(db: Db): Promise<
  { ok: true } | { ok: false; reason: string }
> {
  const uninstall = installDb(db);
  try {
    const admin = newAdminClient();
    const trigger = await loadTriggerMessage(admin, "msg-trigger");
    if (!trigger.ok) return { ok: false, reason: trigger.reason };
    const conv = await loadConversationAndTakeover(admin, {
      conversationId: CONV,
      tenantId: TENANT,
      aiTakeoverMinutes: TAKEOVER_MINUTES,
    });
    if (!conv.ok) return { ok: false, reason: conv.reason };
    return { ok: true };
  } finally {
    uninstall();
  }
}

const PROVIDERS: Provider[] = ["zappaz", "meta-cloud"];
const KINDS: Kind[] = ["text", "audio"];

for (const provider of PROVIDERS) {
  for (const kind of KINDS) {
    Deno.test(`fluxo inbound ${provider} / ${kind}`, async (t) => {
      await t.step("conversa nunca tocada por humano: IA liberada", async () => {
        const result = await runGateChain(makeDb(provider, kind));
        assertEquals(result, { ok: true });
      });

      await t.step(
        "atendente respondeu e não houve reativação: IA bloqueada",
        async () => {
          const db = makeDb(provider, kind, { agentRepliedMinutesAgo: 120 });
          const result = await runGateChain(db);
          assertEquals(result, {
            ok: false,
            reason: "takeover_blocked_human_responded",
          });
          // E marca a conversa para atendimento humano (badge do inbox).
          assertEquals(db.conversationPatches[0], { awaiting_human: true });
        },
      );

      await t.step(
        "atendente respondeu ANTES da reativação explícita: IA liberada (regressão)",
        async () => {
          const result = await runGateChain(
            makeDb(provider, kind, {
              agentRepliedMinutesAgo: 120,
              resumedMinutesAgo: 60,
            }),
          );
          assertEquals(result, { ok: true });
        },
      );

      await t.step(
        "atendente respondeu DEPOIS da reativação: IA volta a sair",
        async () => {
          const result = await runGateChain(
            makeDb(provider, kind, {
              agentRepliedMinutesAgo: 45,
              resumedMinutesAgo: 120,
            }),
          );
          assertEquals(result, {
            ok: false,
            reason: "takeover_blocked_human_responded",
          });
        },
      );

      await t.step(
        "atendente respondeu há poucos minutos: operador ativo bloqueia",
        async () => {
          const result = await runGateChain(
            makeDb(provider, kind, { agentRepliedMinutesAgo: 2 }),
          );
          assertEquals(result, {
            ok: false,
            reason: "takeover_blocked_operator_active",
          });
        },
      );

      await t.step(
        "lead responde a uma campanha (modelo enviado como automação): IA assume",
        async () => {
          // Conversa criada pela campanha nasce com ai_active=true
          // (template-schedule-runner -> findOrCreateConversation aiActive).
          // A mensagem da campanha é sender='automation': não conta como
          // atendente humano, então não bloqueia a IA por takeover.
          const db = makeDb(provider, kind, { aiActive: true });
          db.messages.push({
            id: "msg-campanha",
            tenant_id: TENANT,
            conversation_id: CONV,
            sender: "automation",
            direction: "out",
            content: "Oi Ana, volte com 20% de desconto",
            media_url: null,
            media_type: null,
            created_at: minutesAgo(90),
          });
          const result = await runGateChain(db);
          assertEquals(result, { ok: true });
          assertEquals(db.conversationPatches, []);
        },
      );

      await t.step(
        "lead responde 2 min depois da campanha: automação não conta como operador ativo",
        async () => {
          const db = makeDb(provider, kind, { aiActive: true });
          db.messages.push({
            id: "msg-campanha",
            tenant_id: TENANT,
            conversation_id: CONV,
            sender: "automation",
            direction: "out",
            content: "Oi Ana, volte com 20% de desconto",
            media_url: null,
            media_type: null,
            created_at: minutesAgo(2),
          });
          assertEquals(await runGateChain(db), { ok: true });
        },
      );

      await t.step("IA pausada na conversa continua pausada", async () => {
        const result = await runGateChain(
          makeDb(provider, kind, { aiActive: false }),
        );
        assertEquals(result, { ok: false, reason: "ai_paused_conversation" });
      });

      await t.step(
        "mensagem da própria IA nunca dispara resposta (sem loop)",
        async () => {
          const db = makeDb(provider, kind);
          db.messages[0] = {
            ...db.messages[0],
            sender: "ai",
            direction: "out",
          };
          const result = await runGateChain(db);
          assertEquals(result, { ok: false, reason: "not_contact_inbound" });
        },
      );
    });
  }
}

Deno.test("corte de reativação é exclusivo na borda (created_at = ai_resumed_at)", async () => {
  const db = makeDb("zappaz", "text", { agentRepliedMinutesAgo: 90 });
  // Reativação exatamente no instante da mensagem do atendente: o filtro é
  // `gt`, então aquela mensagem NÃO conta e a IA volta.
  db.conversation.ai_resumed_at = db.messages[1].created_at;
  assertEquals(await runGateChain(db), { ok: true });
});

Deno.test("áudio do lead chega aos gates com media_url e MIME preservados", async () => {
  for (const provider of PROVIDERS) {
    const db = makeDb(provider, "audio");
    const uninstall = installDb(db);
    try {
      const trigger = await loadTriggerMessage(newAdminClient(), "msg-trigger");
      if (!trigger.ok) throw new Error(`gate barrou o áudio: ${trigger.reason}`);
      assertEquals(trigger.msg.media_type, "audio/ogg; codecs=opus");
      if (!trigger.msg.media_url) {
        throw new Error(`${provider}: media_url perdido — transcrição impossível`);
      }
    } finally {
      uninstall();
    }
  }
});
