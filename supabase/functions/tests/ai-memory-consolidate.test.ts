// Testa o handler de supabase/functions/ai-memory-consolidate/index.ts: auth
// fail-closed (service role), validação de corpo, e orquestração de
// findContactsNeedingConsolidation + consolidateContactMemory (a lógica de
// negócio em si já é coberta por memory-consolidator.test.ts).
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

const handler = await captureHandler("../ai-memory-consolidate/index.ts");

const TENANT_ID = "tenant-1";

function req(body?: unknown, opts: { method?: string; auth?: string | null } = {}): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.auth !== null) {
    headers.set("Authorization", opts.auth ?? `Bearer ${BASE_ENV.SUPABASE_SERVICE_ROLE_KEY}`);
  }
  return new Request("http://fn.local", {
    method: opts.method ?? "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

Deno.test("ai-memory-consolidate", async (t) => {
  await t.step("OPTIONS responde CORS sem corpo", async () => {
    const res = await handler(req(undefined, { method: "OPTIONS" }));
    if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
    if (await res.text()) throw new Error("esperado corpo vazio");
  });

  await t.step("método não-POST retorna 405", async () => {
    const res = await handler(req(undefined, { method: "GET" }));
    if (res.status !== 405) throw new Error(`esperado 405, veio ${res.status}`);
  });

  await t.step("sem Authorization retorna 401", async () => {
    const res = await handler(req({ tenantId: TENANT_ID }, { auth: null }));
    if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
  });

  await t.step("bearer diferente do service role retorna 401", async () => {
    const res = await handler(req({ tenantId: TENANT_ID }, { auth: "Bearer errado" }));
    if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
  });

  await t.step("corpo inválido (JSON quebrado) retorna 400", async () => {
    const res = await handler(
      new Request("http://fn.local", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${BASE_ENV.SUPABASE_SERVICE_ROLE_KEY}`,
          "content-type": "application/json",
        },
        body: "{not-json",
      }),
    );
    const body = await res.json();
    if (res.status !== 400 || body.error !== "Corpo inválido.") {
      throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("tenantId ausente retorna 400", async () => {
    const res = await handler(req({}));
    const body = await res.json();
    if (res.status !== 400 || body.error !== "tenantId obrigatório.") {
      throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("sem contatos elegíveis: processed=0 sem chamar a IA", async () => {
    let aiCalled = false;
    const router: FetchMatcher = (r) => {
      if (r.pathname === "/rest/v1/ai_conversation_summaries" && r.method === "GET") {
        return jsonResponse(200, []);
      }
      if (r.url === "https://ai.gateway.lovable.dev/v1/chat/completions") {
        aiCalled = true;
        return jsonResponse(200, { choices: [{ message: { content: "{}" } }] });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const res = await handler(req({ tenantId: TENANT_ID }));
      const body = await res.json();
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
      if (body.processed !== 0 || body.succeeded !== 0 || body.failed !== 0) {
        throw new Error(`inesperado: ${JSON.stringify(body)}`);
      }
      if (aiCalled) throw new Error("a IA foi chamada sem nenhum contato elegível");
    } finally {
      uninstall();
    }
  });

  await t.step("consolida um contato elegível com sucesso e reporta no resumo", async () => {
    const validMemoryJson = JSON.stringify({
      personality: null,
      preferences: [],
      history_summary: "Contato negociou preço e fechou.",
      important_dates: [],
      relationship_notes: null,
    });
    const router: FetchMatcher = (r) => {
      const sp = new URL(r.url).searchParams;
      if (r.pathname === "/rest/v1/ai_conversation_summaries" && r.method === "GET") {
        // findContactsNeedingConsolidation não filtra por contact_id;
        // fetchSummariesForConsolidation (dentro de consolidateContactMemory) filtra.
        if (sp.has("contact_id")) {
          return jsonResponse(200, [
            {
              summary: "Perguntou sobre preço",
              key_facts: ["orçamento 5k"],
              sentiment: "neutral",
              topics_discussed: ["preço"],
              commitments: [],
              objections: [],
              period_start: "2026-07-01T10:00:00Z",
              period_end: "2026-07-01T11:00:00Z",
            },
          ]);
        }
        return jsonResponse(200, [{ contact_id: "contact-1", period_end: "2026-07-05T00:00:00Z" }]);
      }
      if (r.pathname === "/rest/v1/contacts" && r.method === "GET") {
        // .in("id", candidateIds) → "in.(...)" (findContactsNeedingConsolidation);
        // .eq("id", contactId) → "eq.<id>" (fetchContactName).
        if (sp.get("id")?.startsWith("in.")) {
          return jsonResponse(200, [{ id: "contact-1", ai_memory: null }]);
        }
        return jsonResponse(200, [{ name: "Maria" }]);
      }
      if (r.pathname === "/rest/v1/contacts" && r.method === "PATCH") {
        return new Response("", { status: 200 });
      }
      if (r.url === "https://ai.gateway.lovable.dev/v1/chat/completions") {
        return jsonResponse(200, { choices: [{ message: { content: validMemoryJson } }] });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const res = await handler(req({ tenantId: TENANT_ID, limit: 5 }));
      const body = await res.json();
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
      if (body.processed !== 1 || body.succeeded !== 1 || body.failed !== 0) {
        throw new Error(`inesperado: ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("falha de consolidação de um contato é reportada em failed/errors", async () => {
    const router: FetchMatcher = (r) => {
      const sp = new URL(r.url).searchParams;
      if (r.pathname === "/rest/v1/ai_conversation_summaries" && r.method === "GET") {
        if (sp.has("contact_id")) {
          return jsonResponse(200, [
            {
              summary: "x",
              key_facts: [],
              sentiment: null,
              topics_discussed: [],
              commitments: [],
              objections: [],
              period_start: "2026-07-01T10:00:00Z",
              period_end: "2026-07-01T11:00:00Z",
            },
          ]);
        }
        return jsonResponse(200, [{ contact_id: "contact-2", period_end: "2026-07-05T00:00:00Z" }]);
      }
      if (r.pathname === "/rest/v1/contacts" && r.method === "GET") {
        if (sp.get("id")?.startsWith("in.")) {
          return jsonResponse(200, [{ id: "contact-2", ai_memory: null }]);
        }
        return jsonResponse(200, [{ name: "João" }]);
      }
      if (r.url === "https://ai.gateway.lovable.dev/v1/chat/completions") {
        return jsonResponse(200, { choices: [{ message: { content: "não é json" } }] });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const res = await handler(req({ tenantId: TENANT_ID }));
      const body = await res.json();
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
      if (body.processed !== 1 || body.succeeded !== 0 || body.failed !== 1) {
        throw new Error(`inesperado: ${JSON.stringify(body)}`);
      }
      if (!Array.isArray(body.errors) || body.errors.length !== 1) {
        throw new Error(`errors inesperado: ${JSON.stringify(body.errors)}`);
      }
    } finally {
      uninstall();
    }
  });
});
