import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { runContactEnrichmentBatch } from "../_shared/ai/contact-enrichment.ts";
import { captureHandler, installFetchMock, jsonResponse } from "./_helpers.ts";

const messageId = "f5310000-0000-4000-8000-000000000001";
const job = {
  contact_id: "f5320000-0000-4000-8000-000000000001", tenant_id: "tenant-1", lease_token: "lease-1",
  contact: { name: "Ana", ai_memory: null, custom_fields: {} }, definitions: [],
  messages: [{ id: messageId, conversation_id: "conversation-1", content: "Meu e-mail é ana@example.test", sender: "contact", direction: "in", created_at: "2026-10-15T10:00:00Z" }],
};
const answer = {
  memory: { history_summary: "Ana informou seu e-mail.", preferences: [] },
  summaries: [{ conversation_id: "conversation-1", summary: "Ana informou e-mail." }],
  fields: [{ field_name: "email", field_type: "native", value: "ana@example.test", confidence: 0.98, source_message_ids: [messageId] }],
};
const client = () => createClient("http://sb.local", "test-service", { auth: { persistSession: false, autoRefreshToken: false } });

Deno.test("enriquecimento: debounce, idempotência ou feature off sem claim não chamam LLM", async () => {
  let llmCalls = 0;
  const restore = installFetchMock((request) => {
    if (request.pathname.endsWith("claim_event_deliveries")) return jsonResponse(200, []);
    if (request.pathname.endsWith("claim_contact_enrichment")) return jsonResponse(200, null);
    llmCalls++;
    throw new Error("Não pode haver processamento sem claim elegível");
  });
  try {
    assertEquals((await runContactEnrichmentBatch(client(), "teste")).processed, 0);
    assertEquals(llmCalls, 0);
  } finally { restore(); }
});

Deno.test("enriquecimento: grava resultado via RPC protegida, nunca PATCH de campos", async () => {
  const previous = Deno.env.get("LOVABLE_API_KEY");
  Deno.env.set("LOVABLE_API_KEY", "chave-teste");
  let claimCount = 0;
  let completed: Record<string, unknown> | undefined;
  const restore = installFetchMock((request) => {
    if (request.pathname.endsWith("claim_event_deliveries")) return jsonResponse(200, []);
    if (request.pathname.endsWith("claim_contact_enrichment")) return jsonResponse(200, claimCount++ === 0 ? job : null);
    if (request.pathname.endsWith("chat/completions")) return jsonResponse(200, { choices: [{ message: { content: JSON.stringify(answer) } }] });
    if (request.pathname.endsWith("complete_contact_enrichment")) {
      completed = request.bodyJson as Record<string, unknown>;
      return jsonResponse(200, { applied: 0, ignored: 1, qualification_deal_ids: [] });
    }
    throw new Error(`Escrita fora da transação: ${request.method} ${request.pathname}`);
  });
  try {
    const result = await runContactEnrichmentBatch(client(), "teste");
    assertEquals(result.processed, 1);
    assertEquals(result.ignored, 1);
    assertEquals(completed?.p_lease_token, "lease-1");
    const payload = completed?.p_result as typeof answer;
    assertEquals(payload.fields[0].source_message_ids, [messageId]);
  } finally {
    restore();
    if (previous === undefined) Deno.env.delete("LOVABLE_API_KEY"); else Deno.env.set("LOVABLE_API_KEY", previous);
  }
});

Deno.test("enriquecimento: fonte inventada pelo modelo aborta antes da aplicação", async () => {
  Deno.env.set("LOVABLE_API_KEY", "chave-teste");
  const restore = installFetchMock((request) => {
    if (request.pathname.endsWith("claim_event_deliveries")) return jsonResponse(200, []);
    if (request.pathname.endsWith("claim_contact_enrichment")) return jsonResponse(200, job);
    if (request.pathname.endsWith("chat/completions")) return jsonResponse(200, { choices: [{ message: { content: JSON.stringify({ ...answer, fields: [{ ...answer.fields[0], source_message_ids: ["outra-mensagem"] }] }) } }] });
    throw new Error("Resultado sem evidência não deve ser aplicado");
  });
  try {
    await assertRejects(() => runContactEnrichmentBatch(client(), "teste"), Error, "mensagem-fonte");
  } finally { restore(); Deno.env.delete("LOVABLE_API_KEY"); }
});

// A resposta original não foi capturada; estes casos reproduzem os dois ramos
// da guarda que lançou "Identificação do campo inválida." e nomes desconhecidos.
for (const invalid of [
  { name: "tipo do valor confundido com categoria", field: { field_name: "servico_interesse", field_type: "text" }, expectedType: "text" },
  { name: "nome não textual", field: { field_name: 42, field_type: "custom" }, expectedType: "invalid" },
  { name: "categoria ausente", field: { field_name: "servico_interesse" }, expectedType: "invalid" },
  { name: "campo custom desconhecido", field: { field_name: "campo_inventado", field_type: "custom" }, expectedType: "custom" },
  { name: "campo nativo não permitido", field: { field_name: "phone", field_type: "native" }, expectedType: "native" },
]) {
  Deno.test(`enriquecimento: ${invalid.name} segue para histórico ignorado sem perder o lote`, async () => {
    const previous = Deno.env.get("LOVABLE_API_KEY");
    Deno.env.set("LOVABLE_API_KEY", "chave-teste");
    let completed: Record<string, unknown> | undefined;
    const response = { ...answer, fields: [
      answer.fields[0],
      { ...invalid.field, value: "Implante dentário", confidence: 0.91, source_message_ids: [messageId] },
    ] };
    const restore = installFetchMock((request) => {
      if (request.pathname.endsWith("claim_event_deliveries")) return jsonResponse(200, []);
      if (request.pathname.endsWith("claim_contact_enrichment")) return jsonResponse(200, job);
      if (request.pathname.endsWith("chat/completions")) return jsonResponse(200, { choices: [{ message: { content: JSON.stringify(response) } }] });
      if (request.pathname.endsWith("complete_contact_enrichment")) {
        completed = request.bodyJson as Record<string, unknown>;
        return jsonResponse(200, { applied: 1, ignored: 1, qualification_deal_ids: [] });
      }
      throw new Error(`Nenhuma escrita fora da transação: ${request.pathname}`);
    });
    try {
      const result = await runContactEnrichmentBatch(client(), "teste");
      assertEquals([result.processed, result.applied, result.ignored], [1, 1, 1]);
      const payload = completed?.p_result as typeof answer;
      assertEquals(payload.memory.history_summary, answer.memory.history_summary);
      assertEquals(payload.summaries[0].summary, answer.summaries[0].summary);
      assertEquals(payload.fields[0], answer.fields[0]);
      assertEquals(payload.fields.length, 2);
      assertEquals(payload.fields[1].field_type, invalid.expectedType);
      assertEquals(typeof payload.fields[1].field_name, "string");
      assertEquals(payload.fields[1].source_message_ids, [messageId]);
    } finally {
      restore();
      if (previous === undefined) Deno.env.delete("LOVABLE_API_KEY"); else Deno.env.set("LOVABLE_API_KEY", previous);
    }
  });
}

Deno.test("prompt distingue categoria native/custom do tipo de valor cadastrado", async () => {
  const previous = Deno.env.get("LOVABLE_API_KEY");
  Deno.env.set("LOVABLE_API_KEY", "chave-teste");
  let definitions: Array<Record<string, unknown>> = [];
  const restore = installFetchMock((request) => {
    if (request.pathname.endsWith("claim_event_deliveries")) return jsonResponse(200, []);
    if (request.pathname.endsWith("claim_contact_enrichment")) return jsonResponse(200, {
      ...job, definitions: [{ key: "servico_interesse", label: "Serviço de interesse", field_type: "text", options: [] }],
    });
    if (request.pathname.endsWith("chat/completions")) {
      const body = request.bodyJson as { messages: Array<{ role: string; content: string }> };
      definitions = JSON.parse(body.messages.find((message) => message.role === "user")!.content).definitions;
      return jsonResponse(200, { choices: [{ message: { content: JSON.stringify(answer) } }] });
    }
    if (request.pathname.endsWith("complete_contact_enrichment")) return jsonResponse(200, { applied: 1, ignored: 0, qualification_deal_ids: [] });
    throw new Error(`Chamada inesperada: ${request.pathname}`);
  });
  try {
    assertEquals((await runContactEnrichmentBatch(client(), "teste")).applied, 1);
    assertEquals(definitions[0].value_type, "text");
    assertEquals(definitions[0].field_type, undefined);
    assertEquals(definitions[0].key, "servico_interesse");
  } finally {
    restore();
    if (previous === undefined) Deno.env.delete("LOVABLE_API_KEY"); else Deno.env.set("LOVABLE_API_KEY", previous);
  }
});

Deno.test("qualificação: opt-in revogado não consome rate limit nem chama outro LLM", async () => {
  Deno.env.set("LOVABLE_API_KEY", "chave-teste");
  let rateCalls = 0;
  const restore = installFetchMock((request) => {
    if (request.pathname.endsWith("claim_event_deliveries")) return jsonResponse(200, []);
    if (request.pathname.endsWith("claim_contact_enrichment")) return jsonResponse(200, job);
    if (request.pathname.endsWith("chat/completions")) return jsonResponse(200, { choices: [{ message: { content: JSON.stringify(answer) } }] });
    if (request.pathname.endsWith("complete_contact_enrichment")) return jsonResponse(200, { applied: 1, ignored: 0, qualification_deal_ids: ["deal-1"] });
    if (request.pathname.endsWith("tenant_ai_features")) return jsonResponse(200, { enabled: false, config: { auto_qualify: true } });
    if (request.pathname.endsWith("check_and_record_rate_limit")) {
      rateCalls++;
      return jsonResponse(200, { allowed: true });
    }
    throw new Error("Qualificação não autorizada");
  });
  try {
    assertEquals((await runContactEnrichmentBatch(client(), "teste")).qualified, 0);
    assertEquals(rateCalls, 0);
  } finally { restore(); Deno.env.delete("LOVABLE_API_KEY"); }
});

Deno.test("qualificação automática respeita o limite e namespace do endpoint sob demanda", async () => {
  Deno.env.set("LOVABLE_API_KEY", "chave-teste");
  let limits: unknown;
  const restore = installFetchMock((request) => {
    if (request.pathname.endsWith("claim_event_deliveries")) return jsonResponse(200, []);
    if (request.pathname.endsWith("claim_contact_enrichment")) return jsonResponse(200, job);
    if (request.pathname.endsWith("chat/completions")) return jsonResponse(200, { choices: [{ message: { content: JSON.stringify(answer) } }] });
    if (request.pathname.endsWith("complete_contact_enrichment")) return jsonResponse(200, { applied: 1, ignored: 0, qualification_deal_ids: ["deal-1"] });
    if (request.pathname.endsWith("tenant_ai_features")) return jsonResponse(200, { enabled: true, config: { auto_qualify: true } });
    if (request.pathname.endsWith("check_and_record_rate_limit")) {
      limits = request.bodyJson;
      return jsonResponse(200, { allowed: false, retryAfterSeconds: 60 });
    }
    throw new Error("Qualificação não deve buscar contexto quando limitada");
  });
  try {
    assertEquals((await runContactEnrichmentBatch(client(), "teste")).qualified, 0);
    assertEquals(limits, { p_key: "ai-agent:ai-qualification:deal-1", p_max_calls: 3, p_window_seconds: 60 });
  } finally { restore(); Deno.env.delete("LOVABLE_API_KEY"); }
});

Deno.test("enriquecimento: revogação durante LLM impede qualificação e contabilização de aplicação", async () => {
  Deno.env.set("LOVABLE_API_KEY", "chave-teste");
  const restore = installFetchMock((request) => {
    if (request.pathname.endsWith("claim_event_deliveries")) return jsonResponse(200, []);
    if (request.pathname.endsWith("claim_contact_enrichment")) return jsonResponse(200, job);
    if (request.pathname.endsWith("chat/completions")) return jsonResponse(200, { choices: [{ message: { content: JSON.stringify(answer) } }] });
    if (request.pathname.endsWith("complete_contact_enrichment")) return jsonResponse(200, { skipped: "feature_off" });
    throw new Error("Opt-in revogado não admite continuação");
  });
  try {
    const result = await runContactEnrichmentBatch(client(), "teste");
    assertEquals([result.processed, result.applied, result.qualified], [0, 0, 0]);
  } finally { restore(); Deno.env.delete("LOVABLE_API_KEY"); }
});

Deno.test("dispatcher rejeita JWT de usuário e chave ausente mesmo sem verify_jwt", async () => {
  const handler = await captureHandler("../contact-enrichment-dispatcher/index.ts");
  const previous = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-local");
  const restore = installFetchMock(() => { throw new Error("Não pode consultar banco sem autenticação"); });
  try {
    assertEquals((await handler(new Request("http://local", { method: "POST", headers: { authorization: "Bearer jwt-usuario" } }))).status, 401);
    Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
    assertEquals((await handler(new Request("http://local", { method: "POST" }))).status, 401);
  } finally {
    restore();
    if (previous === undefined) Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY"); else Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", previous);
  }
});
