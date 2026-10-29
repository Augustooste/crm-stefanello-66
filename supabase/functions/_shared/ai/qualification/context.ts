// qualification/context.ts — leitura do deal + resolução das dimensões de
// qualificação (por nicho do tenant) + mensagens do contato.
//
// Extraído de qualification.ts (split de simplificação): dimensões vêm de
// niche_templates.qualification_dimensions (jsonb) do nicho do tenant, nunca
// um conjunto fixo de chaves — ver banner de qualification.ts para o
// racional completo do porte do medflow.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { toStringArray } from "../gateway.ts";

const MAX_MESSAGES_FOR_QUALIFICATION = 50;

/** Mesmo default de niche_templates.qualification_dimensions (migration
 * 20260709110000) — usado quando o tenant não tem nicho configurado ou o
 * nicho não tem override das dimensões. */
const DEFAULT_QUALIFICATION_DIMENSIONS: QualificationDimensionConfig[] = [
  { key: "resource", label: "Recurso/orçamento" },
  { key: "authority", label: "Autoridade de decisão" },
  { key: "need", label: "Necessidade" },
  { key: "timeline", label: "Prazo" },
];

export interface QualificationDimensionConfig {
  key: string;
  label: string;
}

interface DealRow {
  id: string;
  title: string;
  value: number | null;
  contact_id: string | null;
  tenant_id: string;
  stage_id: string;
  created_at: string;
}

interface TenantRow {
  id: string;
  name: string;
  niche: string | null;
}

interface ContactRow {
  name: string | null;
  email: string | null;
  phone: string | null;
}

interface StageRow {
  name: string;
}

interface StageConfigRow {
  stage_goal: string | null;
  advancement_criteria: unknown;
}

interface MessageRow {
  sender: string;
  content: string | null;
  created_at: string;
}

export interface DealQualificationContext {
  deal: { id: string; title: string; value: number | null; createdAt: string };
  tenant: { id: string; name: string };
  contact: ContactRow | null;
  stage: { name: string; goal: string | null; advancementCriteria: string[] };
  dimensions: QualificationDimensionConfig[];
  messages: MessageRow[];
}

export async function buildDealQualificationContext(
  supabase: SupabaseClient,
  dealId: string,
): Promise<DealQualificationContext> {
  const { data: dealData, error: dealError } = await supabase
    .from("deals")
    .select("id, title, value, contact_id, tenant_id, stage_id, created_at")
    .eq("id", dealId)
    .maybeSingle();
  if (dealError || !dealData) {
    throw new Error("Deal não encontrado.");
  }
  const deal = dealData as DealRow;

  const [tenantResult, contactResult, stageResult, stageConfigResult] = await Promise.all([
    supabase.from("tenants").select("id, name, niche").eq("id", deal.tenant_id).maybeSingle(),
    deal.contact_id
      ? supabase
          .from("contacts")
          .select("name, email, phone")
          .eq("id", deal.contact_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabase.from("board_stages").select("name").eq("id", deal.stage_id).maybeSingle(),
    supabase
      .from("stage_ai_config")
      .select("stage_goal, advancement_criteria")
      .eq("tenant_id", deal.tenant_id)
      .eq("stage_id", deal.stage_id)
      .maybeSingle(),
  ]);

  // FAIL-CLOSED (contrato de generateQualificationSnapshot): supabase-js NÃO
  // lança em erro do PostgREST, devolve { error } com data null. Sem estes
  // checks um blip de rede/RLS vira contexto silenciosamente vazio — com
  // `stageConfigResult` em erro a IA qualifica o negócio sem `stage.goal` e
  // com `advancementCriteria: []`, e o snapshot gravado parece legítimo.
  // Mesmo padrão de _shared/ai/pipeline-agent.ts:143-151.
  if (tenantResult.error) {
    throw new Error(`Falha ao carregar o tenant do deal: ${tenantResult.error.message}`);
  }
  if (contactResult.error) {
    throw new Error(`Falha ao carregar o contato do deal: ${contactResult.error.message}`);
  }
  if (stageResult.error) {
    throw new Error(`Falha ao carregar o estágio do deal: ${stageResult.error.message}`);
  }
  if (stageConfigResult.error) {
    throw new Error(
      `Falha ao carregar a configuração de IA do estágio: ${stageConfigResult.error.message}`,
    );
  }

  const tenant = tenantResult.data as TenantRow | null;
  if (!tenant) {
    throw new Error("Tenant do deal não encontrado.");
  }

  const contact = (contactResult.data as ContactRow | null) ?? null;
  const stage = (stageResult.data as StageRow | null) ?? { name: "Estágio desconhecido" };
  const stageConfig = stageConfigResult.data as StageConfigRow | null;

  const dimensions = await resolveQualificationDimensions(supabase, tenant.niche);
  const messages = await fetchMessagesForContact(supabase, deal.contact_id);

  return {
    deal: { id: deal.id, title: deal.title, value: deal.value, createdAt: deal.created_at },
    tenant: { id: tenant.id, name: tenant.name },
    contact,
    stage: {
      name: stage.name,
      goal: stageConfig?.stage_goal ?? null,
      advancementCriteria: toStringArray(stageConfig?.advancement_criteria),
    },
    dimensions,
    messages,
  };
}

/** Dimensões configuradas para o nicho do tenant; cai no default se o tenant
 * não tem nicho ou o nicho não existe mais. */
async function resolveQualificationDimensions(
  supabase: SupabaseClient,
  nicheSlug: string | null,
): Promise<QualificationDimensionConfig[]> {
  if (!nicheSlug) return DEFAULT_QUALIFICATION_DIMENSIONS;

  const { data } = await supabase
    .from("niche_templates")
    .select("qualification_dimensions")
    .eq("slug", nicheSlug)
    .maybeSingle();

  const dims = toDimensionConfigArray(
    (data as { qualification_dimensions: unknown } | null)?.qualification_dimensions,
  );
  return dims.length > 0 ? dims : DEFAULT_QUALIFICATION_DIMENSIONS;
}

function toDimensionConfigArray(value: unknown): QualificationDimensionConfig[] {
  if (!Array.isArray(value)) return [];
  const out: QualificationDimensionConfig[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    if (
      typeof o.key === "string" &&
      o.key.trim() &&
      typeof o.label === "string" &&
      o.label.trim()
    ) {
      out.push({ key: o.key.trim(), label: o.label.trim() });
    }
  }
  return out;
}

/** Mensagens mais recentes de TODAS as conversas do contato do deal
 * (um contato pode ter conversas em múltiplos canais), em ordem cronológica. */
async function fetchMessagesForContact(
  supabase: SupabaseClient,
  contactId: string | null,
): Promise<MessageRow[]> {
  if (!contactId) return [];

  const { data: conversations, error: conversationsError } = await supabase
    .from("conversations")
    .select("id")
    .eq("contact_id", contactId);
  // Fail-closed (ver banner de qualification.ts): erro de query aqui vira []
  // silencioso e fica indistinguível de "contato sem histórico" — lança pra
  // não mascarar a falha num snapshot de qualificação enganoso.
  if (conversationsError) {
    throw new Error(`Falha ao buscar conversas do contato: ${conversationsError.message}`);
  }
  const conversationIds = ((conversations ?? []) as Array<{ id: string }>).map((c) => c.id);
  if (conversationIds.length === 0) return [];

  const { data: messagesData, error: messagesError } = await supabase
    .from("messages")
    .select("sender, content, created_at")
    .in("conversation_id", conversationIds)
    .order("created_at", { ascending: false })
    .limit(MAX_MESSAGES_FOR_QUALIFICATION);
  if (messagesError) {
    throw new Error(`Falha ao buscar mensagens do contato: ${messagesError.message}`);
  }

  return ((messagesData ?? []) as MessageRow[]).slice().reverse();
}
