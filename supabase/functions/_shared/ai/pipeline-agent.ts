import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { type DomainEventDelivery, runDomainEventBatch } from "../domain-event-runner.ts";
import { evaluateStageAdvancement, loadStageAiConfig } from "./pipeline.ts";
import { getAIGatewayConfig } from "./gateway.ts";

const DEFAULT_MODEL = "google/gemini-3-flash-preview";
const TRANSCRIPT_LIMIT = 24;

interface DealRow {
  id: string;
  tenant_id: string;
  contact_id: string | null;
  stage_id: string;
  status: string | null;
  custom_fields: Record<string, unknown> | null;
}

interface ConversationRow {
  id: string;
  tenant_id: string;
  contact_id: string;
  awaiting_human: boolean;
  ai_active: boolean;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function resolveConversation(
  admin: SupabaseClient,
  delivery: DomainEventDelivery,
): Promise<ConversationRow | null> {
  const conversationId = stringValue(delivery.payload.conversation_id);
  if (conversationId) {
    const { data, error } = await admin
      .from("conversations")
      .select("id, tenant_id, contact_id, awaiting_human, ai_active")
      .eq("id", conversationId)
      .eq("tenant_id", delivery.tenant_id)
      .maybeSingle();
    if (error) throw new Error(`conversation lookup failed: ${error.message}`);
    return data as ConversationRow | null;
  }

  const contactId = stringValue(delivery.payload.contact_id);
  if (!contactId) return null;
  const { data, error } = await admin
    .from("conversations")
    .select("id, tenant_id, contact_id, awaiting_human, ai_active")
    .eq("tenant_id", delivery.tenant_id)
    .eq("contact_id", contactId)
    .eq("status", "open")
    .order("last_message_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`conversation lookup failed: ${error.message}`);
  return data as ConversationRow | null;
}

async function resolveDeal(
  admin: SupabaseClient,
  delivery: DomainEventDelivery,
  conversation: ConversationRow | null,
): Promise<DealRow | null> {
  const explicitDealId =
    stringValue(delivery.payload.deal_id) ??
    (delivery.aggregate_type === "deal" ? delivery.aggregate_id : null);
  let query = admin
    .from("deals")
    .select("id, tenant_id, contact_id, stage_id, status, custom_fields")
    .eq("tenant_id", delivery.tenant_id)
    .eq("status", "open");

  if (explicitDealId) {
    query = query.eq("id", explicitDealId);
  } else {
    const contactId = stringValue(delivery.payload.contact_id) ?? conversation?.contact_id;
    if (!contactId) return null;
    query = query.eq("contact_id", contactId);
  }

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`deal lookup failed: ${error.message}`);
  return data as DealRow | null;
}

async function loadTranscript(
  admin: SupabaseClient,
  conversationId: string | null,
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  if (!conversationId) return [];
  const { data, error } = await admin
    .from("messages")
    .select("sender, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(TRANSCRIPT_LIMIT);
  if (error) throw new Error(`message transcript failed: ${error.message}`);

  return (data ?? [])
    .reverse()
    .map((row) => ({
      role: row.sender === "contact" ? ("user" as const) : ("assistant" as const),
      content: String(row.content ?? ""),
    }))
    .filter((row) => row.content.trim().length > 0);
}

async function loadStructuredSignals(
  admin: SupabaseClient,
  deal: DealRow,
  delivery: DomainEventDelivery,
): Promise<Record<string, unknown>> {
  const [contactResult, appointmentResult, activityResult] = await Promise.all([
    deal.contact_id
      ? admin
          .from("contacts")
          .select("status, tags, source, custom_fields")
          .eq("id", deal.contact_id)
          .eq("tenant_id", deal.tenant_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    deal.contact_id
      ? admin
          .from("appointments")
          .select("status")
          .eq("tenant_id", deal.tenant_id)
          .eq("contact_id", deal.contact_id)
          .order("updated_at", { ascending: false })
          .limit(20)
      : Promise.resolve({ data: [], error: null }),
    admin
      .from("activities")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", deal.tenant_id)
      .eq("deal_id", deal.id)
      .not("completed_at", "is", null),
  ]);

  if (contactResult.error) {
    throw new Error(`contact signals failed: ${contactResult.error.message}`);
  }
  if (appointmentResult.error) {
    throw new Error(`appointment signals failed: ${appointmentResult.error.message}`);
  }
  if (activityResult.error) {
    throw new Error(`activity signals failed: ${activityResult.error.message}`);
  }

  const appointmentStatuses = new Set(
    (appointmentResult.data ?? []).map((row) => String(row.status)),
  );
  const dealFields = deal.custom_fields ?? {};
  const eventApproved = delivery.event_type === "payment.approved";
  const paymentStatus = String(
    delivery.payload.payment_status ?? delivery.payload.status ?? dealFields.payment_status ?? "",
  ).toLowerCase();

  return {
    event: {
      type: delivery.event_type,
      payload: delivery.payload,
    },
    contact: contactResult.data ?? {},
    deal: {
      custom_fields: dealFields,
    },
    appointment: {
      scheduled: appointmentStatuses.has("scheduled") || appointmentStatuses.has("confirmed"),
      confirmed: appointmentStatuses.has("confirmed"),
      completed: appointmentStatuses.has("completed"),
    },
    payment: {
      approved: eventApproved || ["approved", "paid", "succeeded"].includes(paymentStatus),
    },
    activity: {
      completed: (activityResult.count ?? 0) > 0,
    },
  };
}

async function loadModel(admin: SupabaseClient, tenantId: string): Promise<string> {
  const override = getAIGatewayConfig().model;
  if (override) return override;
  const { data, error } = await admin
    .from("ai_settings")
    .select("model")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw new Error(`ai settings lookup failed: ${error.message}`);
  const configured = String(data?.model ?? "");
  return configured && configured !== "default" ? configured : DEFAULT_MODEL;
}

export function createPipelineEventHandler(admin: SupabaseClient) {
  return async (delivery: DomainEventDelivery): Promise<void> => {
    if (!delivery.tenant_id) return;
    if (delivery.event_type === "message.sent" && delivery.payload.sender === "ai") {
      return;
    }

    const { data: tenant, error: tenantError } = await admin
      .from("tenants")
      .select("ai_enabled")
      .eq("id", delivery.tenant_id)
      .maybeSingle();
    if (tenantError) throw new Error(`tenant lookup failed: ${tenantError.message}`);
    if (tenant?.ai_enabled !== true) return;

    // O claim do lote não autoriza trabalho após desligar ou renovar o opt-in.
    const { data: feature, error: featureError } = await admin
      .from("tenant_ai_features")
      .select("enabled_at")
      .eq("tenant_id", delivery.tenant_id)
      .eq("feature_key", "pipeline_agent")
      .eq("enabled", true)
      .maybeSingle();
    if (featureError) throw new Error(`Falha ao revalidar opt-in: ${featureError.message}`);
    const pipelineAgentEnabledAt = stringValue(feature?.enabled_at);
    if (!pipelineAgentEnabledAt) return;
    const { data: event, error: eventError } = await admin
      .from("domain_events")
      .select("created_at")
      .eq("id", delivery.event_id)
      .eq("tenant_id", delivery.tenant_id)
      .gte("created_at", pipelineAgentEnabledAt)
      .maybeSingle();
    if (eventError) throw new Error(`Falha ao revalidar janela do evento: ${eventError.message}`);
    if (!event) return;

    const conversation = await resolveConversation(admin, delivery);
    const deal = await resolveDeal(admin, delivery, conversation);
    if (!deal || !deal.stage_id) return;

    const config = await loadStageAiConfig(admin, deal.tenant_id, deal.stage_id);
    if (config.stageAdvancement.length === 0) return;

    const [history, signals, effectiveModel] = await Promise.all([
      loadTranscript(admin, conversation?.id ?? null),
      loadStructuredSignals(admin, deal, delivery),
      loadModel(admin, deal.tenant_id),
    ]);
    const signalSummary = JSON.stringify({
      event: delivery.event_type,
      signals,
    });

    await evaluateStageAdvancement({
      admin,
      tenantId: deal.tenant_id,
      conversationId: conversation?.id ?? null,
      dealId: deal.id,
      dealStageId: deal.stage_id,
      stageAdvancement: config.stageAdvancement,
      stageGoal: config.stageGoal,
      effectiveModel,
      history,
      aiText: signalSummary,
      sourceEventId: delivery.event_id,
      triggerEvent: delivery.event_type,
      structuredSignals: signals,
      correlationId: delivery.event_id,
      promptSnapshot: {
        stage_goal: config.stageGoal,
        advancement_criteria: config.stageAdvancement,
        pipeline_agent_enabled_at: pipelineAgentEnabledAt,
      },
    });
  };
}

export async function runPipelineAgentBatch(admin: SupabaseClient, workerId: string, limit = 20) {
  return runDomainEventBatch(
    admin,
    workerId,
    { "*": createPipelineEventHandler(admin) },
    {
      limit,
      leaseSeconds: 180,
      subscriberIds: ["pipeline.agent"],
      eventTypes: null,
    },
  );
}
