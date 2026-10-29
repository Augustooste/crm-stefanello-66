// Envio tipado (provider-send.ts::OutboundMessage) na Meta Cloud: texto livre
// vira `type: "text"`, modelo aprovado vira `type: "template"` com nome, idioma
// e variáveis na ordem de {{1}}..{{n}} (contrato da doc oficial "Template
// fundamentals", conferido em 25/09/2026). Nenhuma requisição real: fetch
// mockado com installFetchMock.
import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { BASE_ENV, installFetchMock, jsonResponse, type MockRequest } from "./_helpers.ts";
import {
  buildMetaTemplatePayload,
  providerSupportsTemplates,
  type ProviderTemplateMessage,
  sendMessageViaProvider,
} from "../_shared/messaging/provider-send.ts";
import { loadRecentHistory } from "../_shared/ai/pipeline.ts";

const META_URL = "https://graph.facebook.com/v23.0/1234567890/messages";
const TOKEN = "EAAB-token-secreto-123";
const CRED = { access_token: TOKEN, phone_number_id: "1234567890" };

const admin = createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const TEMPLATE: ProviderTemplateMessage = {
  kind: "provider_template",
  name: "reativacao_cliente",
  languageCode: "pt_BR",
  bodyParameters: ["Ana", "20%"],
};

function send(
  message: Parameters<typeof sendMessageViaProvider>[0]["message"],
  slug = "meta-cloud",
) {
  return sendMessageViaProvider({
    admin,
    providerSlug: slug as "meta-cloud",
    cred: CRED,
    phone: "+55 11 99999-9999",
    message,
  });
}

function captureMeta(response: Response | (() => Response)) {
  const requests: MockRequest[] = [];
  const uninstall = installFetchMock((req) => {
    if (req.url !== META_URL) return undefined;
    requests.push(req);
    return typeof response === "function" ? response() : response.clone();
  });
  return { requests, uninstall };
}

/** Captura console.error/warn/log durante `fn` (para provar que o token não vaza). */
async function captureConsole(fn: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const original = { error: console.error, warn: console.warn, log: console.log };
  const grab = (...args: unknown[]) =>
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  console.error = grab;
  console.warn = grab;
  console.log = grab;
  try {
    await fn();
  } finally {
    Object.assign(console, original);
  }
  return lines.join("\n");
}

const OK = jsonResponse(200, { messages: [{ id: "wamid.abc" }] });

Deno.test("Meta Cloud — tipo de mensagem no fio", async (t) => {
  await t.step("freeform gera type=text com o corpo", async () => {
    const { requests, uninstall } = captureMeta(OK);
    try {
      const r = await send({ kind: "freeform", text: "Oi Ana" });
      assertEquals(r, { ok: true, external_id: "wamid.abc" });
      const body = requests[0].bodyJson as Record<string, unknown>;
      assertEquals(body.type, "text");
      assertEquals(body.text, { body: "Oi Ana" });
      assertEquals(body.template, undefined);
    } finally {
      uninstall();
    }
  });

  await t.step("provider_template gera type=template com nome, idioma e variáveis", async () => {
    const { requests, uninstall } = captureMeta(OK);
    try {
      const r = await send(TEMPLATE);
      assert(r.ok);
      const body = requests[0].bodyJson as Record<string, unknown>;
      assertEquals(body.type, "template");
      assertEquals(body.to, "5511999999999");
      assertEquals(body.text, undefined);
      assertEquals(body.template, {
        name: "reativacao_cliente",
        language: { code: "pt_BR" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "Ana" },
              { type: "text", text: "20%" },
            ],
          },
        ],
      });
      assertEquals(requests[0].headers.get("authorization"), `Bearer ${TOKEN}`);
      assert(requests[0].signal, "envio de modelo precisa de deadline");
    } finally {
      uninstall();
    }
  });

  await t.step("modelo sem variáveis não manda components", () => {
    const payload = buildMetaTemplatePayload("5511", { ...TEMPLATE, bodyParameters: [] });
    assertEquals(payload.template, { name: "reativacao_cliente", language: { code: "pt_BR" } });
  });

  await t.step("idioma vai exatamente como cadastrado", () => {
    const payload = buildMetaTemplatePayload("5511", { ...TEMPLATE, languageCode: "en_US" });
    assertEquals((payload.template as { language: unknown }).language, { code: "en_US" });
  });
});

Deno.test("provedor sem modelo aprovado recusa sem chamar a rede", async () => {
  let calls = 0;
  const uninstall = installFetchMock(() => {
    calls++;
    return OK.clone();
  });
  try {
    for (const slug of ["zapi", "twilio", "evolution", "zappaz"]) {
      assert(!providerSupportsTemplates(slug));
      const r = await send(TEMPLATE, slug);
      assert(!r.ok);
      assertStringIncludes(r.error, "não envia modelo aprovado");
    }
    assertEquals(calls, 0);
    assert(providerSupportsTemplates("meta-cloud"));
  } finally {
    uninstall();
  }
});

Deno.test("Meta Cloud — erros HTTP viram mensagem acionável", async (t) => {
  await t.step("400 com 132000 cita variáveis; não é reenfileirável", async () => {
    const { uninstall } = captureMeta(
      jsonResponse(400, {
        error: { code: 132000, message: "Number of parameters does not match" },
      }),
    );
    try {
      const r = await send(TEMPLATE);
      assert(!r.ok);
      assertStringIncludes(r.error, "número de variáveis");
      assertEquals(r.retryable, undefined);
    } finally {
      uninstall();
    }
  });

  await t.step("400 com 131047 (fora da janela) pede modelo aprovado", async () => {
    const { uninstall } = captureMeta(jsonResponse(400, { error: { code: 131047 } }));
    try {
      const r = await send({ kind: "freeform", text: "oi" });
      assert(!r.ok);
      assertStringIncludes(r.error, "24h");
    } finally {
      uninstall();
    }
  });

  await t.step("400 sem código conhecido cai na mensagem genérica de recusa", async () => {
    const { uninstall } = captureMeta(jsonResponse(400, { error: { code: 999999 } }));
    try {
      const r = await send(TEMPLATE);
      assert(!r.ok);
      assertStringIncludes(r.error, "O provedor recusou a mensagem");
    } finally {
      uninstall();
    }
  });

  await t.step("401 pede reconexão e o token ecoado não aparece em log nem no erro", async () => {
    const echo = {
      error: {
        code: 190,
        message: `Invalid OAuth access token: Bearer ${TOKEN}`,
        access_token: TOKEN,
      },
    };
    const { uninstall } = captureMeta(jsonResponse(401, echo));
    try {
      let result: Awaited<ReturnType<typeof send>> | null = null;
      const logs = await captureConsole(async () => {
        result = await send(TEMPLATE);
      });
      const r = result as unknown as { ok: false; error: string };
      assert(!r.ok);
      assertStringIncludes(r.error, "Access Token da Meta");
      assert(logs.length > 0, "a recusa precisa ser logada");
      assert(!logs.includes(TOKEN), `token vazou no log: ${logs}`);
      assert(!r.error.includes(TOKEN), "token vazou no erro devolvido");
    } finally {
      uninstall();
    }
  });

  await t.step("429 é reenfileirável (a Meta não enviou)", async () => {
    const { uninstall } = captureMeta(
      jsonResponse(429, { error: { code: 130429, message: "(#130429) Rate limit hit" } }),
    );
    try {
      const r = await send(TEMPLATE);
      assert(!r.ok);
      assertEquals(r.retryable, true);
      assertStringIncludes(r.error, "limitou a taxa");
    } finally {
      uninstall();
    }
  });

  await t.step(
    "timeout propaga como exceção (resultado incerto, quem decide é o caller)",
    async () => {
      const uninstall = installFetchMock((req) => {
        if (req.url !== META_URL) return undefined;
        throw new DOMException("Signal timed out.", "TimeoutError");
      });
      try {
        await assertRejects(() => send(TEMPLATE), DOMException, "timed out");
      } finally {
        uninstall();
      }
    },
  );
});

Deno.test("histórico da IA: mensagem da campanha entra como turno da empresa, sem rótulo", async () => {
  const rows = [
    {
      sender: "contact",
      content: "Quero sim",
      created_at: "2026-09-25T10:02:00Z",
      media_type: null,
    },
    {
      sender: "automation",
      content: "Oi Ana, volte com 20%",
      created_at: "2026-09-25T10:00:00Z",
      media_type: null,
    },
  ];
  const uninstall = installFetchMock((req) =>
    req.pathname === "/rest/v1/messages" ? jsonResponse(200, rows) : undefined
  );
  try {
    // Cliente criado DEPOIS do mock: o supabase-js guarda o fetch da criação.
    const client = createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const hist = await loadRecentHistory(client, "conv-1", {
      historyLimit: 20,
      historyMaxChars: 5000,
    });
    assertEquals(hist, [
      { role: "assistant", content: "Oi Ana, volte com 20%" },
      { role: "user", content: "Quero sim" },
    ]);
  } finally {
    uninstall();
  }
});
