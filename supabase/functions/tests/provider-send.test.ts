// Testa direto sendViaProvider (extraído de messaging-send/index.ts na Fase
// 4) — 1 caso feliz + 1 caso de falha para Z-API, o suficiente para os
// próximos consumidores (workers de nurture/broadcast) confiarem que o
// dispatcher compartilhado funciona. Cobertura completa de todos os
// providers/branches de erro já existe em messaging-send.test.ts (via
// captureHandler), que também passa a exercitar este módulo indiretamente.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { BASE_ENV, type FetchMatcher, installFetchMock, jsonResponse, setEnv } from "./_helpers.ts";
import { sendAudioViaProvider, sendViaProvider } from "../_shared/messaging/provider-send.ts";
import {
  checkZappazSession,
  registerZappazWebhook,
  sendZappazText,
} from "../_shared/messaging/zappaz-client.ts";
import { sendEvolutionMessage } from "../_shared/messaging/evolution-client.ts";
import { createMultichannelAdapter } from "../_shared/messaging/multichannel-adapters.ts";
import { sendResend } from "../_shared/ai/send-adapters.ts";
import { assert, assertEquals } from "jsr:@std/assert@1";

setEnv(BASE_ENV);

function newAdminClient() {
  return createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const ZAPI_CRED = { instance_id: "inst-1", instance_token: "tok-1", client_token: "ctok-1" };
const ZAPI_SEND_URL = "https://api.z-api.io/instances/inst-1/token/tok-1/send-text";

Deno.test("sendViaProvider — zapi", async (t) => {
  await t.step("sucesso: retorna ok:true com external_id do messageId", async () => {
    const router: FetchMatcher = (req) => {
      if (req.url === ZAPI_SEND_URL && req.method === "POST") {
        return jsonResponse(200, { messageId: "ext-123" });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await sendViaProvider({
        admin: newAdminClient(),
        providerSlug: "zapi",
        cred: ZAPI_CRED,
        phone: "+55 11 99999-9999",
        content: "Olá, tudo bem?",
      });
      if (!result.ok || result.external_id !== "ext-123") {
        throw new Error(`resultado inesperado: ${JSON.stringify(result)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("falha: 401 do provedor retorna ok:false com mensagem amigável", async () => {
    const router: FetchMatcher = (req) => {
      if (req.url === ZAPI_SEND_URL && req.method === "POST") {
        return jsonResponse(401, { message: "unauthorized" });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await sendViaProvider({
        admin: newAdminClient(),
        providerSlug: "zapi",
        cred: ZAPI_CRED,
        phone: "+55 11 99999-9999",
        content: "Olá, tudo bem?",
      });
      if (
        result.ok ||
        result.error !== "Credenciais da Z-API não estão mais válidas. Reconecte a integração."
      ) {
        throw new Error(`resultado inesperado: ${JSON.stringify(result)}`);
      }
    } finally {
      uninstall();
    }
  });

  // H12 (docs/code-review/05-silent-failures.md): 400/422 é recusa PERMANENTE
  // (número inexistente, template não aprovado, janela de 24h expirada) e o
  // corpo do provider — a única pista do motivo — era descartado.
  await t.step(
    "falha: 400 do provedor não convida a retentar e o corpo vai para o log, redigido",
    async () => {
      const router: FetchMatcher = (req) => {
        if (req.url === ZAPI_SEND_URL && req.method === "POST") {
          return new Response(
            "phone 5511999999999 is not registered on WhatsApp (token: tok-abc123)",
            { status: 400 },
          );
        }
        return undefined;
      };
      const logged: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => {
        logged.push(args.map((arg) => String(arg)).join(" "));
      };
      const uninstall = installFetchMock(router);
      try {
        const result = await sendViaProvider({
          admin: newAdminClient(),
          providerSlug: "zapi",
          cred: ZAPI_CRED,
          phone: "+55 11 99999-9999",
          content: "Olá, tudo bem?",
        });
        if (result.ok) throw new Error(`esperado ok:false, veio ${JSON.stringify(result)}`);
        if (/tente novamente/i.test(result.error)) {
          throw new Error(`400 é falha permanente, não pode pedir retry: ${result.error}`);
        }
        const body = logged.join("\n");
        if (!body.includes("is not registered on WhatsApp")) {
          throw new Error(`corpo do erro do provider não foi logado: ${JSON.stringify(logged)}`);
        }
        if (body.includes("tok-abc123") || !body.includes("[REDACTED]")) {
          throw new Error(`segredo não foi redigido no log: ${JSON.stringify(logged)}`);
        }
      } finally {
        console.error = originalError;
        uninstall();
      }
    },
  );

  await t.step(
    "falha: status HTTP desconhecido (ex.: 402) — mensagem inclui status e corpo redigido",
    async () => {
      const router: FetchMatcher = (req) => {
        if (req.url === ZAPI_SEND_URL && req.method === "POST") {
          return new Response("saldo insuficiente (token: tok-abc123)", { status: 402 });
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const result = await sendViaProvider({
          admin: newAdminClient(),
          providerSlug: "zapi",
          cred: ZAPI_CRED,
          phone: "+55 11 99999-9999",
          content: "Olá, tudo bem?",
        });
        if (result.ok) throw new Error(`esperado ok:false, veio ${JSON.stringify(result)}`);
        if (!result.error.includes("402")) {
          throw new Error(`mensagem não traz o status HTTP: ${result.error}`);
        }
        if (!result.error.includes("saldo insuficiente")) {
          throw new Error(`mensagem não traz o corpo do provedor: ${result.error}`);
        }
        if (result.error.includes("tok-abc123")) {
          throw new Error(`segredo vazou na mensagem: ${result.error}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("sem telefone: retorna ok:false sem chamar o provedor", async () => {
    const uninstall = installFetchMock(() => {
      throw new Error("não deveria chamar o provedor sem telefone");
    });
    try {
      const result = await sendViaProvider({
        admin: newAdminClient(),
        providerSlug: "zapi",
        cred: ZAPI_CRED,
        phone: undefined,
        content: "Olá, tudo bem?",
      });
      if (result.ok || result.error !== "Contato sem telefone cadastrado.") {
        throw new Error(`resultado inesperado: ${JSON.stringify(result)}`);
      }
    } finally {
      uninstall();
    }
  });
});

// Nenhum dos 8 fetch deste módulo tinha AbortSignal: um provider que aceita a
// conexão e não responde segurava o isolate até a plataforma matá-lo. Como o
// envio da resposta da IA roda DENTRO do lock de conversa do ai-respond e o
// claim em ai_processing_log não tem TTL nem delete, isso deixava a mensagem
// daquele lead sem resposta para sempre.
//
// Este teste usa um stub próprio de fetch (e não o installFetchMock) porque o
// MockRequest do harness compartilhado não expõe o `signal` -- e o `signal` é
// justamente o que está sob teste. O harness é congelado, não dá pra estendê-lo.
Deno.test("todo fetch de provider carrega deadline (AbortSignal)", async () => {
  const chamadas: Array<{ url: string; signal: AbortSignal | null }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const signal = input instanceof Request ? input.signal : (init?.signal ?? null);
    chamadas.push({ url, signal });
    // Corpo genérico: cada adapter lê a chave que lhe interessa e ignora o resto.
    const body = url.endsWith("/media")
      ? { id: "media-1" }
      : { messageId: "m1", sid: "s1", id: "r1", messages: [{ id: "wa1" }] };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;

  const admin = newAdminClient();
  const audio = { bytes: new Uint8Array([0x49, 0x44, 0x33]).buffer, mime: "audio/mpeg" };

  try {
    // Texto: 4 fetch (zapi, twilio, meta-cloud, resend).
    await sendViaProvider({
      admin,
      providerSlug: "zapi",
      cred: ZAPI_CRED,
      phone: "+5511999999999",
      content: "oi",
    });
    await sendViaProvider({
      admin,
      providerSlug: "twilio",
      cred: { account_sid: "AC1", auth_token: "tok", whatsapp_number: "+5511888888888" },
      phone: "+5511999999999",
      content: "oi",
    });
    await sendViaProvider({
      admin,
      providerSlug: "meta-cloud",
      cred: { access_token: "at-1", phone_number_id: "123456" },
      phone: "+5511999999999",
      content: "oi",
    });
    await sendViaProvider({
      admin,
      providerSlug: "resend",
      cred: { api_key: "re_1", from_domain: "exemplo.com" },
      email: "lead@exemplo.com",
      content: "oi",
      subject: "Assunto",
    });

    // Áudio: 4 fetch (zapi, zappaz, meta upload + meta envio por media id).
    await sendAudioViaProvider({
      providerSlug: "zapi",
      cred: ZAPI_CRED,
      phone: "+5511999999999",
      audio,
    });
    await sendAudioViaProvider({
      providerSlug: "zappaz",
      cred: { api_key: "zk-1", session_id: "sess-1" },
      phone: "+5511999999999",
      audio,
    });
    await sendAudioViaProvider({
      providerSlug: "meta-cloud",
      cred: { access_token: "at-1", phone_number_id: "123456" },
      phone: "+5511999999999",
      audio,
    });

    assertEquals(chamadas.length, 8, `esperava 8 fetch, veio ${chamadas.length}`);
    for (const c of chamadas) {
      assert(
        c.signal instanceof AbortSignal,
        `fetch sem deadline (pode travar o isolate para sempre): ${c.url}`,
      );
      assertEquals(c.signal.aborted, false, `signal já nasceu abortado: ${c.url}`);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

// Fecha o "residual conhecido" que o commit 7e0e6ff deixou registrado: ele
// cobriu os 8 fetch de provider-send.ts, mas sendZappazText, o /send/text da
// Evolution, os adapters multicanal (telegram/discord/sms/email/push) e o
// sendResend de ai-respond/send-adapters.ts vivem em OUTROS arquivos e ficaram
// sem teto. Mesmo bug com outro nome: todos são chamados de dentro do lock de
// conversa do ai-respond, e o claim em ai_processing_log não tem TTL nem
// delete — isolate preso até o wall-clock da plataforma = mensagem daquele lead
// nunca mais reprocessada.
//
// Stub próprio de fetch pelo mesmo motivo do teste acima: o MockRequest do
// installFetchMock não expõe o `signal`, que é justamente o que está sob teste.
Deno.test("residual do deadline: zappaz, evolution, multicanal e resend também carregam AbortSignal", async () => {
  const chamadas: Array<{ url: string; signal: AbortSignal | null }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const signal = input instanceof Request ? input.signal : (init?.signal ?? null);
    chamadas.push({ url, signal });
    // Corpo genérico: cada cliente lê a chave que lhe interessa e ignora o resto.
    return Promise.resolve(
      new Response(JSON.stringify({ messageId: "m1", id: "r1", data: { Info: { ID: "wa1" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;

  try {
    // Zappaz: 3 fetch (check de sessão, envio de texto, registro de webhook).
    const zappazCred = { api_key: "zk-1", session_id: "sess-1" };
    await checkZappazSession(zappazCred);
    await sendZappazText(zappazCred, "5511999999999", "oi");
    await registerZappazWebhook(zappazCred, "https://app.exemplo.com/hook", "seg-1");

    // Evolution: 1 fetch (POST /send/text). api_url tem que sobreviver ao
    // validatePublicHttpsUrl anti-SSRF que roda ANTES do fetch — host público,
    // nada de .local/.internal/IP privado, senão o fetch nem acontece e o
    // teste passaria sem testar nada.
    await sendEvolutionMessage(
      {
        api_url: "https://evo.example.com",
        instance_name: "cel-teste",
        api_key: "global-key-1234567890",
        instance_token: "instance-token-abc",
      },
      "+5511999999999",
      "oi",
    );

    // Multicanal: 1 fetch pelo transporte REAL (sem passar `transport`, que é o
    // que os outros testes injetam). Credencial precisa ser truthy, senão o
    // adapter devolve sandboxResult e não chega a fazer fetch nenhum.
    const telegram = createMultichannelAdapter("telegram", { bot_token: "bot-1" });
    await telegram.send({ destination: "chat-1", content: "oi" });

    // Resend (ai-respond/send-adapters.ts): 1 fetch.
    await sendResend(
      { api_key: "re_1", from_domain: "exemplo.com" },
      "lead@exemplo.com",
      "oi",
      "Assunto",
    );

    assertEquals(
      chamadas.length,
      6,
      `esperava 6 fetch, veio ${chamadas.length} — algum caller saiu antes do fetch (validação de URL, credencial vazia ou sandbox), o teste não estaria medindo nada: ${
        chamadas.map((c) => c.url).join(", ")
      }`,
    );
    for (const c of chamadas) {
      assert(
        c.signal instanceof AbortSignal,
        `fetch sem deadline (pode travar o isolate para sempre): ${c.url}`,
      );
      assertEquals(c.signal.aborted, false, `signal já nasceu abortado: ${c.url}`);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

// P0 observabilidade (2026-08-04): o ramo final `!r.ok` de sendZappazText
// (linha ~134) descartava r.status e o corpo da resposta — os 4 ramos
// anteriores (401/403/404/429/5xx) já cobrem os status conhecidos, então
// era exatamente o 4xx desconhecido (400/402/422 etc.) que caía numa frase
// genérica sem nenhuma pista aproveitável em reason_detail. Confere que o
// status e o corpo (redigido) aparecem na mensagem devolvida.
Deno.test("sendZappazText — status desconhecido (4xx) inclui status + corpo na mensagem", async () => {
  const router: FetchMatcher = (req) => {
    if (req.url.includes("/message/text") && req.method === "POST") {
      return jsonResponse(402, { message: "Saldo insuficiente para enviar mensagem." });
    }
    return undefined;
  };
  const uninstall = installFetchMock(router);
  try {
    const r = await sendZappazText(
      { api_key: "zk-1", session_id: "sess-1" },
      "5511999999999",
      "oi",
    );
    assertEquals(r.ok, false);
    assert(!r.ok);
    assert(
      r.error.includes("402"),
      `mensagem deveria conter o status HTTP 402, veio: ${r.error}`,
    );
    assert(
      r.error.includes("Saldo insuficiente"),
      `mensagem deveria conter o corpo da resposta, veio: ${r.error}`,
    );
  } finally {
    uninstall();
  }
});

// O corpo da resposta pode ecoar segredo (ex.: a própria URL chamada, com
// query string de token) — não pode vazar cru para o log/reason_detail.
// `redactSecrets` cobre `?access_token=...`; confere que ele passa pelo
// caminho novo do ramo `!r.ok`.
Deno.test("sendZappazText — corpo do erro é redigido antes de virar mensagem", async () => {
  const router: FetchMatcher = (req) => {
    if (req.url.includes("/message/text") && req.method === "POST") {
      return jsonResponse(400, {
        message:
          "Falha ao autenticar: https://api.zappaz.io/v1/session/sess-1?access_token=SECRETVALUE123 inválido",
      });
    }
    return undefined;
  };
  const uninstall = installFetchMock(router);
  try {
    const r = await sendZappazText(
      { api_key: "zk-1", session_id: "sess-1" },
      "5511999999999",
      "oi",
    );
    assertEquals(r.ok, false);
    assert(!r.ok);
    assert(
      !r.error.includes("SECRETVALUE123"),
      `segredo vazou na mensagem de erro: ${r.error}`,
    );
    assert(
      r.error.includes("[REDACTED]"),
      `esperava marcador de redação na mensagem: ${r.error}`,
    );
  } finally {
    uninstall();
  }
});

// Envelope de resposta da Zappaz: `MessageResponse` do OpenAPI é
// `{ status: "success" | "failed", data }`. Tratar todo 2xx como sucesso
// gravava a mensagem como `sent` num envio que a Zappaz recusou, e o
// `external_id` nascia null porque o id mora dentro de `data`.
Deno.test("sendZappazText: HTTP 200 com status failed não conta como enviado", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      jsonResponse(200, { status: "failed", message: "session is not connected" }),
    )) as typeof fetch;
  try {
    const r = await sendZappazText({ api_key: "zk-1", session_id: "s1" }, "5511999999999", "oi");
    assertEquals(r.ok, false);
    assert(!r.ok && r.error.includes("recusou"), `erro inesperado: ${JSON.stringify(r)}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("sendZappazText: external_id sai de dentro do envelope data", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      jsonResponse(200, { status: "success", data: { key: { id: "3EB0CC7282AFD65986DC00" } } }),
    )) as typeof fetch;
  try {
    const r = await sendZappazText({ api_key: "zk-1", session_id: "s1" }, "5511999999999", "oi");
    assert(r.ok, `esperado sucesso: ${JSON.stringify(r)}`);
    assertEquals(r.ok && r.external_id, "3EB0CC7282AFD65986DC00");
  } finally {
    globalThis.fetch = realFetch;
  }
});
