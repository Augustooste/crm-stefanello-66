import { assert, assertEquals } from "jsr:@std/assert";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { createPipelineEventHandler, runPipelineAgentBatch } from "../_shared/ai/pipeline-agent.ts";
import { installFetchMock, jsonResponse } from "./_helpers.ts";

// O SQL é a autoridade dos quatro modos (pgTAP). Aqui se prova que a edge
// preserva o limiar da avaliação até a RPC, sem descartar sugestões de 0.79.
for (const mode of ["manual", "shadow", "assisted", "autonomous"]) {
  for (const confidence of [0.79, 0.80]) {
    Deno.test(`pipeline ${mode}: encaminha confiança ${confidence} ao comando usando gateway local`, async () => {
      const names = ["AI_GATEWAY_URL", "AI_GATEWAY_API_KEY", "AI_GATEWAY_MODEL", "LOVABLE_API_KEY"];
      const previous = names.map((name) => Deno.env.get(name));
      Deno.env.set("AI_GATEWAY_URL", "http://llm.local/chat/completions");
      Deno.env.set("AI_GATEWAY_API_KEY", "chave-local");
      Deno.env.set("AI_GATEWAY_MODEL", "modelo-local");
      Deno.env.delete("LOVABLE_API_KEY");
      const commands: unknown[] = [];
      let directMove = false;
      let evaluationSaved = false;
      const uninstall = installFetchMock((req) => {
        if (req.url === "http://llm.local/chat/completions") {
          assertEquals(req.headers.get("authorization"), "Bearer chave-local");
          return jsonResponse(200, {
            choices: [{ message: { content: JSON.stringify({ results: [{
              criterion: "Pagamento aprovado", met: true, confidence, evidence: "payment.approved",
            }] }) } }],
          });
        }
        if (req.pathname === "/rest/v1/tenants") return jsonResponse(200, { ai_enabled: true });
        if (req.pathname === "/rest/v1/tenant_ai_features") {
          return jsonResponse(200, { enabled_at: "2026-10-15T11:00:00.123456Z" });
        }
        if (req.pathname === "/rest/v1/domain_events") {
          return jsonResponse(200, { created_at: "2026-10-15T12:00:00Z" });
        }
        if (req.pathname === "/rest/v1/deals" && req.method === "PATCH") {
          directMove = true;
          return jsonResponse(200, []);
        }
        if (req.pathname === "/rest/v1/deals") {
          return jsonResponse(200, { id: "deal-1", tenant_id: "tenant-1", contact_id: null, stage_id: "origem", status: "open", custom_fields: {} });
        }
        if (req.pathname === "/rest/v1/stage_ai_config") {
          const isSource = new URL(req.url).searchParams.get("stage_id") === "eq.origem";
          return jsonResponse(200, isSource
            ? { advancement_criteria: ["Pagamento aprovado"], stage_goal: "Confirmar pagamento", enabled: true }
            : { entry_criteria: [] });
        }
        if (req.pathname === "/rest/v1/activities") return jsonResponse(200, []);
        if (req.pathname === "/rest/v1/stage_transitions") {
          return jsonResponse(200, [{ to_stage_id: "destino", autonomy_mode: mode, ai_priority: 0, min_confidence: 0.80 }]);
        }
        if (req.pathname === "/rest/v1/deal_stage_evaluations") {
          evaluationSaved = true;
          return jsonResponse(201, []);
        }
        if (req.pathname === "/rest/v1/rpc/transition_deal_stage") {
          commands.push(req.bodyJson);
          return jsonResponse(200, { success: true });
        }
        return undefined;
      });
      try {
        const admin = createClient("http://sb.local", "sr-key", { auth: { persistSession: false } });
        await createPipelineEventHandler(admin)({
          delivery_id: "delivery-1", event_id: "evento-1", tenant_id: "tenant-1",
          subscriber_id: "pipeline.agent", event_type: "payment.approved", schema_version: 1,
          aggregate_type: "deal", aggregate_id: "deal-1", payload: { deal_id: "deal-1" },
          metadata: {}, occurred_at: "2026-10-15T12:00:00Z", attempts: 1, max_attempts: 8,
        });
        assertEquals(commands.length, 1, "A avaliação não pode desaparecer antes da política SQL");
        const command = commands[0];
        assert(command !== null && typeof command === "object" && "p_confidence" in command && "p_actor_type" in command && "p_model_version" in command && "p_target_stage_id" in command);
        assertEquals(command.p_confidence, confidence);
        assertEquals(command.p_actor_type, "ai");
        assertEquals(command.p_model_version, "modelo-local");
        assertEquals(command.p_target_stage_id, "destino");
        assert("p_prompt_snapshot" in command);
        assertEquals(command.p_prompt_snapshot, {
          stage_goal: "Confirmar pagamento",
          advancement_criteria: ["Pagamento aprovado"],
          pipeline_agent_enabled_at: "2026-10-15T11:00:00.123456Z",
        });
        assertEquals(evaluationSaved, true);
        assertEquals(directMove, false, "Só a RPC pode movimentar o card");
      } finally {
        uninstall();
        names.forEach((name, index) => {
          if (previous[index] === undefined) Deno.env.delete(name);
          else Deno.env.set(name, previous[index]!);
        });
      }
    });
  }
}

for (const change of ["desligar", "religar"]) {
  Deno.test(`pipeline revalida cada evento quando admin decide ${change} durante o lote`, async () => {
    const names = ["AI_GATEWAY_URL", "AI_GATEWAY_API_KEY", "AI_GATEWAY_MODEL"];
    const previous = names.map((name) => Deno.env.get(name));
    Deno.env.set("AI_GATEWAY_URL", "http://llm.local/chat/completions");
    Deno.env.set("AI_GATEWAY_API_KEY", "chave-local");
    Deno.env.set("AI_GATEWAY_MODEL", "modelo-local");
    const originalWindow = "2026-10-15T11:00:00.123456Z";
    let enabled = true;
    let enabledAt = originalWindow;
    let gatewayCalls = 0;
    let featureReads = 0;
    const commands: unknown[] = [];
    const deliveries = [1, 2].map((id) => ({
      delivery_id: `delivery-${id}`, event_id: `evento-${id}`, tenant_id: "tenant-1",
      subscriber_id: "pipeline.agent", event_type: "payment.approved", schema_version: 1,
      aggregate_type: "deal", aggregate_id: `deal-${id}`, payload: { deal_id: `deal-${id}` },
      metadata: {}, occurred_at: "2026-10-15T12:00:00Z", attempts: 1, max_attempts: 8,
    }));
    const uninstall = installFetchMock((req) => {
      const query = new URL(req.url).searchParams;
      if (req.pathname === "/rest/v1/rpc/claim_event_deliveries") return jsonResponse(200, deliveries);
      if (req.pathname === "/rest/v1/rpc/ack_event_delivery") return jsonResponse(200, true);
      if (req.pathname === "/rest/v1/tenants") return jsonResponse(200, { ai_enabled: true });
      if (req.pathname === "/rest/v1/tenant_ai_features") {
        featureReads++;
        assertEquals(query.get("tenant_id"), "eq.tenant-1");
        assertEquals(query.get("feature_key"), "eq.pipeline_agent");
        assertEquals(query.get("enabled"), "eq.true");
        return jsonResponse(200, enabled ? { enabled_at: enabledAt } : null);
      }
      if (req.pathname === "/rest/v1/domain_events") {
        assertEquals(query.get("tenant_id"), "eq.tenant-1");
        assertEquals(query.get("created_at"), `gte.${enabledAt}`);
        return jsonResponse(200, enabledAt === originalWindow
          ? { created_at: "2026-10-15T12:00:00Z" } : null);
      }
      if (req.pathname === "/rest/v1/deals") {
        return jsonResponse(200, { id: "deal-1", tenant_id: "tenant-1", contact_id: null, stage_id: "origem", status: "open", custom_fields: {} });
      }
      if (req.pathname === "/rest/v1/stage_ai_config") {
        return jsonResponse(200, query.get("stage_id") === "eq.origem"
          ? { advancement_criteria: ["Pagamento aprovado"], stage_goal: "Confirmar pagamento", enabled: true }
          : { entry_criteria: [] });
      }
      if (req.pathname === "/rest/v1/activities") return jsonResponse(200, []);
      if (req.pathname === "/rest/v1/stage_transitions") {
        return jsonResponse(200, [{ to_stage_id: "destino", autonomy_mode: "autonomous", ai_priority: 0 }]);
      }
      if (req.pathname === "/rest/v1/deal_stage_evaluations") return jsonResponse(201, []);
      if (req.url === "http://llm.local/chat/completions") {
        gatewayCalls++;
        if (change === "desligar") enabled = false;
        else enabledAt = "2026-10-15T13:00:00Z";
        return jsonResponse(200, { choices: [{ message: { content: JSON.stringify({
          results: [{ criterion: "Pagamento aprovado", met: true, confidence: 1, evidence: "payment.approved" }],
        }) } }] });
      }
      if (req.pathname === "/rest/v1/rpc/transition_deal_stage") {
        commands.push(req.bodyJson);
        return jsonResponse(200, { success: false, status: "blocked", reason: "pipeline_agent_opt_in_changed" });
      }
      return undefined;
    });
    try {
      const admin = createClient("http://sb.local", "sr-key", { auth: { persistSession: false } });
      assertEquals(await runPipelineAgentBatch(admin, "worker-1"), { claimed: 2, delivered: 2, failed: 0 });
      assertEquals(gatewayCalls, 1, "O segundo evento já reclamado não pode gastar LLM após revogação");
      assertEquals(featureReads, 2, "A janela não pode ficar em cache durante o lote");
      assertEquals(commands.length, 1);
      const command = commands[0];
      assert(command !== null && typeof command === "object" && "p_prompt_snapshot" in command);
      assertEquals(command.p_prompt_snapshot, {
        stage_goal: "Confirmar pagamento",
        advancement_criteria: ["Pagamento aprovado"],
        pipeline_agent_enabled_at: originalWindow,
      }, "A RPC recebe a janela anterior à avaliação, não a janela renovada");
    } finally {
      uninstall();
      names.forEach((name, index) => {
        if (previous[index] === undefined) Deno.env.delete(name);
        else Deno.env.set(name, previous[index]!);
      });
    }
  });
}
