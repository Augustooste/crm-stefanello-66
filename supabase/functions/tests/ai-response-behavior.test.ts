import { assertEquals } from "jsr:@std/assert@1";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { finalizeAiReply, splitIntoBubbles } from "../_shared/ai/send-dispatch.ts";
import { coalesceTurn } from "../_shared/ai/turn-coalescer.ts";
import { BASE_ENV, installFetchMock, jsonResponse, setEnv } from "./_helpers.ts";

setEnv(BASE_ENV);
const PARAGRAPHS = [
  "A avaliação identifica o tratamento adequado.",
  "Nossa equipe explica as opções disponíveis.",
  "Você recebe um orçamento após a avaliação.",
];
const newAdmin = () => createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.test("blocos configuráveis: preserva conteúdo e junta saudação curta ao próximo bloco", () => {
  assertEquals(splitIntoBubbles(`Olá!\n\n${PARAGRAPHS.join("\n\n")}`, 3), [
    `Olá! ${PARAGRAPHS[0]}`,
    PARAGRAPHS[1],
    PARAGRAPHS[2],
  ]);
});

Deno.test("blocos configuráveis: excedente e trecho curto não viram mensagens isoladas", () => {
  assertEquals(splitIntoBubbles(`${PARAGRAPHS.join("\n\n")}\n\nAté logo.`, 2), [
    PARAGRAPHS[0],
    `${PARAGRAPHS[1]} ${PARAGRAPHS[2]} Até logo.`,
  ]);
});

async function dispatchWithClock(config: {
  maxResponseBlocks?: number;
  responseBlockDelayMs?: number;
  pauseAfterSleep?: "conversation" | "handoff" | "contact";
  handoffDuringSend?: boolean;
  initialClock?: number;
  sendDurationMs?: number;
  withBudget?: boolean;
  interrupted?: boolean;
}) {
  let clock = config.initialClock ?? 0;
  const conversation = { ai_active: true, awaiting_human: false };
  const contact = { ai_paused: false };
  const sent: Array<{ text: string; at: number }> = [];
  const sleeps: number[] = [];
  const restore = installFetchMock((req) => {
    if (req.pathname === "/rest/v1/conversations" && req.method === "GET") {
      return jsonResponse(200, [conversation]);
    }
    if (req.pathname === "/rest/v1/contacts" && req.method === "GET") {
      return jsonResponse(200, [contact]);
    }
    if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
      const filters = new URL(req.url).searchParams;
      if (filters.get("awaiting_human") === "eq.false" && conversation.awaiting_human) {
        return jsonResponse(200, []);
      }
      Object.assign(conversation, req.bodyJson);
      return jsonResponse(200, {});
    }
    if (req.pathname === "/rest/v1/messages" && req.method === "POST") {
      return jsonResponse(201, { id: `reply-${sent.length}` });
    }
    if (req.method === "PATCH") return jsonResponse(200, {});
    if (req.pathname === "/rest/v1/integration_secrets") {
      return jsonResponse(200, [
        { key: "instance_id", value: "inst-1" },
        { key: "instance_token", value: "tok-1" },
        { key: "client_token", value: "client-1" },
      ]);
    }
    if (req.url === "https://api.z-api.io/instances/inst-1/token/tok-1/send-text") {
      const body = req.bodyJson;
      if (!body || typeof body !== "object" || !("message" in body) || typeof body.message !== "string") {
        throw new Error("Envio sem texto válido.");
      }
      sent.push({ text: body.message, at: clock });
      clock += config.sendDurationMs ?? 0;
      if (config.handoffDuringSend) conversation.awaiting_human = true;
      return jsonResponse(200, { messageId: `sent-${sent.length}` });
    }
    if (req.method === "GET") return jsonResponse(200, []);
    throw new Error(`Rota inesperada: ${req.method} ${req.pathname}`);
  });
  try {
    const params = {
      admin: newAdmin(), tenantId: "tenant-1", conversationId: "conv-1", contactId: "contact-1",
      dealId: null, aiText: PARAGRAPHS.join("\n\n"), sendMode: "auto" as const,
      providerSlug: "zapi", contactPhone: "5511999999999", contactEmail: null,
      subject: null, previousAwaitingHuman: true,
      ...config,
      budget: config.withBudget ? { deadlineAt: 140000, now: () => clock } : undefined,
      sleep: (ms: number) => {
        sleeps.push(ms);
        clock += ms;
        if (config.pauseAfterSleep === "conversation") conversation.ai_active = false;
        if (config.pauseAfterSleep === "handoff") conversation.awaiting_human = true;
        if (config.pauseAfterSleep === "contact") contact.ai_paused = true;
        return Promise.resolve();
      },
    };
    const result = await finalizeAiReply(params);
    assertEquals(result.kind, config.interrupted ? "interrupted" : "sent");
    if (config.handoffDuringSend) assertEquals(conversation.awaiting_human, true);
    if (config.withBudget) assertEquals(clock <= 140000, true);
    return { sent, sleeps };
  } finally {
    restore();
  }
}

Deno.test("despacho configurado: envia três blocos com intervalo somente entre envios", async () => {
  assertEquals(await dispatchWithClock({ maxResponseBlocks: 3, responseBlockDelayMs: 250 }), {
    sent: [
      { text: PARAGRAPHS[0], at: 0 },
      { text: PARAGRAPHS[1], at: 250 },
      { text: PARAGRAPHS[2], at: 500 },
    ],
    sleeps: [250, 250],
  });
});

Deno.test("despacho sem configuração: uma mensagem condensada, sem espera", async () => {
  assertEquals(await dispatchWithClock({}), {
    sent: [{ text: PARAGRAPHS.join(" "), at: 0 }], sleeps: [],
  });
});

Deno.test("despacho com blocos e intervalo ausente: mantém 1200 ms", async () => {
  assertEquals(await dispatchWithClock({ maxResponseBlocks: 2 }), {
    sent: [
      { text: PARAGRAPHS[0], at: 0 },
      { text: `${PARAGRAPHS[1]} ${PARAGRAPHS[2]}`, at: 1200 },
    ],
    sleeps: [1200],
  });
});

for (const pause of ["conversation", "handoff", "contact"] as const) {
  Deno.test(`despacho interrompe os próximos blocos após pausa: ${pause}`, async () => {
    assertEquals(await dispatchWithClock({
      maxResponseBlocks: 3, responseBlockDelayMs: 250,
      pauseAfterSleep: pause, interrupted: true,
    }), {
      sent: [{ text: PARAGRAPHS[0], at: 0 }], sleeps: [250],
    });
  });
}

Deno.test("sucesso do provider não apaga handoff criado durante o envio", async () => {
  assertEquals(await dispatchWithClock({
    maxResponseBlocks: 3, responseBlockDelayMs: 0,
    handoffDuringSend: true, interrupted: true,
  }), {
    sent: [{ text: PARAGRAPHS[0], at: 0 }], sleeps: [],
  });
});

Deno.test("deadline compartilhado inclui áudio de entrada e corta blocos antes do caller", async () => {
  // Agrupamento 30 s + STT 30 s + gateway 25 s já consumiram 85 s do turno.
  assertEquals(await dispatchWithClock({
    maxResponseBlocks: 3, responseBlockDelayMs: 10000,
    initialClock: 85000, sendDurationMs: 15000, withBudget: true, interrupted: true,
  }), {
    sent: [
      { text: PARAGRAPHS[0], at: 85000 },
      { text: PARAGRAPHS[1], at: 110000 },
    ],
    sleeps: [10000],
  });
});

async function coalesceWithClock(coalesceWindowMs?: number, messageId = "newer", withBudget = false) {
  let clock = Date.parse("2026-10-15T12:00:00.000Z");
  const budget = withBudget ? { deadlineAt: clock + 140000, now: () => clock } : undefined;
  const inbound = [
    { id: "newer", created_at: new Date(clock - 1000).toISOString() },
    { id: "older", created_at: new Date(clock - 2000).toISOString() },
  ];
  const sleeps: number[] = [];
  const restore = installFetchMock((req) => {
    const params = new URL(req.url).searchParams;
    if (params.get("direction") !== "eq.in") return jsonResponse(200, []);
    const cutoff = params.get("created_at")!.replace("gte.", "");
    return jsonResponse(200, inbound.filter((row) => row.created_at >= cutoff));
  });
  try {
    const decision = await coalesceTurn(newAdmin(), {
      conversationId: "conv-1", messageId, coalesceWindowMs,
      now: () => new Date(clock),
      budget,
      // STT Meta 40 s + gateway 25 s + TTS 15 s + envio Meta 30 s.
      reservedOperationMs: 110000,
      sleep: (ms) => {
        sleeps.push(ms);
        clock += ms;
        return Promise.resolve();
      },
    });
    return { decision, sleeps };
  } finally {
    restore();
  }
}

Deno.test("coalesce configurável: janela de 120s não libera a mensagem antiga da rajada", async () => {
  assertEquals(await coalesceWithClock(120000, "older"), {
    decision: { proceed: false, reason: "not_latest", latestMessageId: "newer" },
    sleeps: [120000],
  });
});

Deno.test("coalesce sem configuração: janela original de 3000 ms", async () => {
  assertEquals(await coalesceWithClock(), { decision: { proceed: true }, sleeps: [3000] });
});

Deno.test("coalesce configurado em zero: sem espera artificial", async () => {
  assertEquals(await coalesceWithClock(0), { decision: { proceed: true }, sleeps: [] });
});

Deno.test("agrupamento encurta a janela para reservar STT, geração, TTS e envio", async () => {
  assertEquals(await coalesceWithClock(90000, "newer", true), {
    decision: { proceed: true }, sleeps: [30000],
  });
});
