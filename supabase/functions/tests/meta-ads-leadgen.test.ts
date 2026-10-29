// Testa o handler Deno.serve de meta-ads-leadgen/index.ts: handshake GET de
// verificação do Meta, assinatura x-hub-signature-256 no POST de leadgen,
// dedupe por leadgen_id e o contrato "verdict de IA é best-effort, contato é
// mandatório" (Fase 6, sub-feature 5).
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

const handler = await captureHandler("../meta-ads-leadgen/index.ts");

const TENANT_ID = "tenant-1";
const TOKEN = "meta-ads-webhook-tok";
const APP_SECRET = "app-secret-123";
const ACCESS_TOKEN = "system-user-access-token";
const CREATED_CONTACT_ID = "contact-new-1";

interface FieldDatum {
  name: string;
  values: string[];
}

interface State {
  tenantIntegration:
    | { tenant_id: string; slug: string; status: string; webhook_token: string }
    | null;
  secrets: Array<{ key: string; value: string }>;
  fieldData: FieldDatum[];
  graphShouldFail: boolean;
  existingContactId: string | null;
  aiShouldFail: boolean;
  aiVerdict: { verdict: string; rationale: string } | null;
  calls: {
    contactInserts: Array<Record<string, unknown>>;
    verdictUpserts: Array<Record<string, unknown>>;
  };
}

function defaultState(): State {
  return {
    tenantIntegration: {
      tenant_id: TENANT_ID,
      slug: "meta-ads",
      status: "active",
      webhook_token: TOKEN,
    },
    secrets: [
      { key: "app_secret", value: APP_SECRET },
      { key: "access_token", value: ACCESS_TOKEN },
    ],
    fieldData: [
      { name: "full_name", values: ["Maria Silva"] },
      { name: "email", values: ["maria@example.com"] },
      { name: "phone_number", values: ["+5511999999999"] },
    ],
    graphShouldFail: false,
    existingContactId: null,
    aiShouldFail: false,
    aiVerdict: { verdict: "hot", rationale: "Respondeu rápido e já tem orçamento definido." },
    calls: { contactInserts: [], verdictUpserts: [] },
  };
}

// PostgREST manda o operador junto do valor (ex.: "eq.meta-ads") -- mesmo
// padrão de messaging-webhook.test.ts / evolution-watchdog.test.ts.
function stripOp(raw: string | null): string | null {
  return raw?.replace(/^[a-z]+\./, "") ?? null;
}

function router(state: State): FetchMatcher {
  return (req) => {
    const sp = new URL(req.url).searchParams;

    if (req.pathname === "/rest/v1/tenant_integrations" && req.method === "GET") {
      const slug = stripOp(sp.get("slug"));
      const token = stripOp(sp.get("webhook_token"));
      const ti = state.tenantIntegration;
      const matches = !!ti && slug === ti.slug && token === ti.webhook_token;
      return jsonResponse(200, matches && ti ? [ti] : []);
    }

    if (req.pathname === "/rest/v1/integration_secrets" && req.method === "GET") {
      return jsonResponse(200, state.secrets);
    }

    // Graph API: GET https://graph.facebook.com/v23.0/{leadgen_id}?fields=field_data&access_token=...
    if (req.pathname.startsWith("/v23.0/") && req.method === "GET") {
      if (state.graphShouldFail) {
        return jsonResponse(500, { error: { message: "Graph API indisponível" } });
      }
      return jsonResponse(200, { field_data: state.fieldData });
    }

    if (req.url === "https://ai.gateway.lovable.dev/v1/chat/completions") {
      if (state.aiShouldFail) return jsonResponse(500, { error: "gateway indisponível" });
      return jsonResponse(200, {
        choices: [
          { message: { content: state.aiVerdict ? JSON.stringify(state.aiVerdict) : "" } },
        ],
      });
    }

    if (req.pathname === "/rest/v1/contacts" && req.method === "GET") {
      // Dedupe: .eq("custom_fields->>meta_lead_id", leadgenId).maybeSingle()
      return jsonResponse(200, state.existingContactId ? [{ id: state.existingContactId }] : []);
    }
    if (req.pathname === "/rest/v1/contacts" && req.method === "POST") {
      state.calls.contactInserts.push(req.bodyJson as Record<string, unknown>);
      // Espelha o efeito real no DB: da próxima vez que o dedupe rodar pra
      // este tenant, o contato já existe -- é o que faz o teste de
      // leadgen_id duplicado ser uma prova real de idempotência, não só de
      // `state.existingContactId` setado manualmente.
      state.existingContactId = CREATED_CONTACT_ID;
      // .insert(...).select("id").single() => Accept: application/vnd.pgrst.object+json,
      // o "servidor" devolve o objeto puro, não array (mesmo padrão de
      // messaging-webhook.test.ts:184-186).
      return jsonResponse(201, { id: CREATED_CONTACT_ID });
    }

    if (req.pathname === "/rest/v1/ai_lead_verdicts" && req.method === "POST") {
      state.calls.verdictUpserts.push(req.bodyJson as Record<string, unknown>);
      return jsonResponse(201, []);
    }

    return undefined;
  };
}

function webhookUrl(params: Record<string, string>): string {
  const qs = new URLSearchParams(params);
  return `http://fn.local/functions/v1/meta-ads-leadgen?${qs.toString()}`;
}

function leadgenPayload(leadgenId: string): unknown {
  return {
    entry: [
      {
        changes: [
          {
            field: "leadgen",
            value: {
              leadgen_id: leadgenId,
              page_id: "page-1",
              form_id: "form-1",
              ad_id: "ad-1",
              campaign_id: "camp-1",
            },
          },
        ],
      },
    ],
  };
}

async function computeMetaSignature(appSecret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

async function postReq(
  bodyText: string,
  extraHeaders: Record<string, string> = {},
  token = TOKEN,
): Promise<Request> {
  return new Request(webhookUrl({ token }), {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: bodyText,
  });
}

async function signedPostReq(
  payload: unknown,
  appSecret = APP_SECRET,
  token = TOKEN,
): Promise<Request> {
  const bodyText = JSON.stringify(payload);
  const sig = await computeMetaSignature(appSecret, bodyText);
  return postReq(bodyText, { "x-hub-signature-256": sig }, token);
}

Deno.test("meta-ads-leadgen", async (t) => {
  await t.step("OPTIONS responde CORS sem corpo", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(new Request(webhookUrl({ token: TOKEN }), { method: "OPTIONS" }));
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
    } finally {
      uninstall();
    }
  });

  await t.step("token da URL não resolve nenhum tenant -> 401", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(
        new Request(webhookUrl({ token: "token-invalido" }), { method: "GET" }),
      );
      if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
    } finally {
      uninstall();
    }
  });

  await t.step("GET com hub.verify_token correto ecoa hub.challenge", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(
        new Request(
          webhookUrl({
            token: TOKEN,
            "hub.mode": "subscribe",
            "hub.verify_token": TOKEN,
            "hub.challenge": "desafio-123",
          }),
          { method: "GET" },
        ),
      );
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
      const text = await res.text();
      if (text !== "desafio-123") throw new Error(`esperado eco do challenge, veio "${text}"`);
    } finally {
      uninstall();
    }
  });

  await t.step("GET com hub.verify_token errado -> 403", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(
        new Request(
          webhookUrl({
            token: TOKEN,
            "hub.mode": "subscribe",
            "hub.verify_token": "token-errado",
            "hub.challenge": "desafio-123",
          }),
          { method: "GET" },
        ),
      );
      if (res.status !== 403) throw new Error(`esperado 403, veio ${res.status}`);
    } finally {
      uninstall();
    }
  });

  await t.step("POST sem x-hub-signature-256 -> 403", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const bodyText = JSON.stringify(leadgenPayload("lead-no-sig"));
      const res = await handler(await postReq(bodyText));
      if (res.status !== 403) throw new Error(`esperado 403, veio ${res.status}`);
    } finally {
      uninstall();
    }
  });

  await t.step("POST com assinatura forjada -> 403", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const bodyText = JSON.stringify(leadgenPayload("lead-forged-sig"));
      const res = await handler(
        await postReq(bodyText, { "x-hub-signature-256": "sha256=" + "0".repeat(64) }),
      );
      if (res.status !== 403) throw new Error(`esperado 403, veio ${res.status}`);
    } finally {
      uninstall();
    }
  });

  await t.step(
    "POST com assinatura válida cria contato com atribuição + verdict de IA",
    async () => {
      const state = defaultState();
      const uninstall = installFetchMock(router(state));
      try {
        const req = await signedPostReq(leadgenPayload("lead-1"));
        const res = await handler(req);
        if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);

        if (state.calls.contactInserts.length !== 1) {
          throw new Error(
            `esperado 1 insert de contato, veio ${state.calls.contactInserts.length}`,
          );
        }
        const inserted = state.calls.contactInserts[0];
        if (inserted.name !== "Maria Silva") throw new Error(`nome inesperado: ${inserted.name}`);
        if (inserted.phone !== "+5511999999999") {
          throw new Error(
            `phone inesperado: ${inserted.phone}`,
          );
        }
        if (inserted.email !== "maria@example.com") {
          throw new Error(
            `email inesperado: ${inserted.email}`,
          );
        }
        if (inserted.source !== "meta-ads") {
          throw new Error(
            `source inesperado: ${inserted.source}`,
          );
        }
        const customFields = inserted.custom_fields as Record<string, string>;
        if (customFields.meta_lead_id !== "lead-1") {
          throw new Error(`meta_lead_id inesperado: ${customFields.meta_lead_id}`);
        }
        if (
          customFields.campaign_id !== "camp-1" || customFields.ad_id !== "ad-1" ||
          customFields.form_id !== "form-1"
        ) {
          throw new Error(
            `atribuição de campanha/anúncio incompleta: ${JSON.stringify(customFields)}`,
          );
        }

        if (state.calls.verdictUpserts.length !== 1) {
          throw new Error(
            `esperado 1 upsert de verdict, veio ${state.calls.verdictUpserts.length}`,
          );
        }
        const verdict = state.calls.verdictUpserts[0];
        if (verdict.verdict !== "hot") throw new Error(`verdict inesperado: ${verdict.verdict}`);
        if (verdict.contact_id !== CREATED_CONTACT_ID) {
          throw new Error(`contact_id do verdict inesperado: ${verdict.contact_id}`);
        }
        if (verdict.tenant_id !== TENANT_ID) {
          throw new Error(
            `tenant_id do verdict inesperado: ${verdict.tenant_id}`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("leadgen_id duplicado (retry do Meta) não duplica contato nem verdict", async () => {
    const state = defaultState();
    const uninstall = installFetchMock(router(state));
    try {
      const payload = leadgenPayload("lead-dup-1");
      const first = await handler(await signedPostReq(payload));
      if (first.status !== 200) throw new Error(`1a chamada: esperado 200, veio ${first.status}`);
      if (state.calls.contactInserts.length !== 1) {
        throw new Error(`1a chamada: esperado 1 insert, veio ${state.calls.contactInserts.length}`);
      }

      const second = await handler(await signedPostReq(payload));
      if (second.status !== 200) throw new Error(`2a chamada: esperado 200, veio ${second.status}`);
      if (state.calls.contactInserts.length !== 1) {
        throw new Error(
          `2a chamada (retry do mesmo leadgen_id): não deveria duplicar contato, veio ${state.calls.contactInserts.length} inserts`,
        );
      }
      if (state.calls.verdictUpserts.length !== 1) {
        throw new Error(
          `2a chamada (retry do mesmo leadgen_id): não deveria duplicar verdict, veio ${state.calls.verdictUpserts.length} upserts`,
        );
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "falha da IA (best-effort): contato é criado mesmo assim, verdict fica ausente",
    async () => {
      const state = defaultState();
      state.aiShouldFail = true;
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(await signedPostReq(leadgenPayload("lead-ai-fail")));
        if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);

        if (state.calls.contactInserts.length !== 1) {
          throw new Error(
            `falha da IA nunca pode bloquear a criação do contato -- esperado 1 insert, veio ${state.calls.contactInserts.length}`,
          );
        }
        if (state.calls.verdictUpserts.length !== 0) {
          throw new Error(
            `verdict deveria ficar ausente quando a IA falha, veio ${state.calls.verdictUpserts.length} upserts`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "falha do Graph API ao buscar field_data (best-effort): contato ainda é criado, com fallback de nome",
    async () => {
      const state = defaultState();
      state.graphShouldFail = true;
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(await signedPostReq(leadgenPayload("lead-graph-fail")));
        if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
        if (state.calls.contactInserts.length !== 1) {
          throw new Error(
            `falha do Graph API nunca pode bloquear a criação do contato -- esperado 1 insert, veio ${state.calls.contactInserts.length}`,
          );
        }
        const inserted = state.calls.contactInserts[0];
        if (inserted.name !== "Lead sem nome") {
          throw new Error(`esperado fallback de nome sem field_data, veio "${inserted.name}"`);
        }
      } finally {
        uninstall();
      }
    },
  );
});
