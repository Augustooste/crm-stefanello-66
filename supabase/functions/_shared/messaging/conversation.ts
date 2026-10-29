// conversation.ts — helpers de conversa/mensagem para os workers automáticos
// (nurture/broadcast, Fase 4) que enviam mensagem fora de uma sessão de
// usuário (service_role, via cron). Novo módulo: nada disto existia antes
// desta fase; não é extração de código existente.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

/**
 * Normaliza telefone para comparação em formato E.164 canônico ("+<dígitos>"),
 * removendo espaços, hífens, parênteses e outros separadores. Usado em TODOS
 * os pontos de escrita e leitura de messaging_phone_suppressions.phone e na
 * busca de contato por telefone em webhook inbound, pra evitar que
 * "+55 (11) 98765-4321" e "+5511987654321" sejam tratados como diferentes
 * (opt-out ignorado, contato duplicado a cada primeira mensagem inbound).
 *
 * Formato ("+<dígitos>") casa com o que o webhook já grava via toE164() em
 * messaging-webhook/index.ts. Puro, nunca lança. null/vazio -> "".
 */
export function normalizePhone(phone: string | null | undefined): string {
  const digits = String(phone ?? "").replace(/\D/g, "");
  return digits ? `+${digits}` : "";
}

export interface FindOrCreateConversationParams {
  tenantId: string;
  contactId: string;
  channelId: string;
  /**
   * `ai_active` só na CRIAÇÃO. Padrão false (nurture: sem IA). A campanha
   * passa true para a IA assumir quando o lead responder -- a IA só roda em
   * mensagem inbound, então o envio automático em si não a aciona. Conversa já
   * aberta nunca é alterada: handoff humano (ai_active=false) continua valendo.
   */
  aiActive?: boolean;
}

/**
 * Busca a conversation aberta (status='open') para este contact_id+channel_id
 * e cria uma nova se não existir.
 */
export async function findOrCreateConversation(
  admin: SupabaseClient,
  params: FindOrCreateConversationParams,
): Promise<{ id: string }> {
  const { tenantId, contactId, channelId, aiActive = false } = params;
  // .order+.limit(1) antes de .maybeSingle() é obrigatório: podem existir 2+
  // conversas abertas para o mesmo (contact_id, channel_id) por corrida entre
  // webhook inbound e este helper (find-then-insert sem lock). Sem .limit(1)
  // o .maybeSingle() lança e quebra permanentemente nurture/broadcast/template
  // pro contato. Mesmo padrão já usado em lead-form-submit/index.ts.
  const { data: existing, error: selectError } = await admin
    .from("conversations")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("contact_id", contactId)
    .eq("channel_id", channelId)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (selectError) {
    throw new Error(`Falha ao buscar conversa aberta existente: ${selectError.message}`);
  }
  if (existing) return { id: existing.id as string };

  const { data: created, error } = await admin
    .from("conversations")
    .insert({
      tenant_id: tenantId,
      contact_id: contactId,
      channel_id: channelId,
      status: "open",
      ai_active: aiActive,
    })
    .select("id")
    .single();
  if (error || !created) {
    throw new Error(`Falha ao criar conversa automática: ${error?.message ?? "sem retorno"}`);
  }
  return { id: created.id as string };
}

export interface LogAutomatedSendParams {
  tenantId: string;
  conversationId: string;
  content: string;
  status: "sent" | "failed";
  errorMessage?: string;
  externalId?: string;
}

/**
 * Grava o resultado de um envio automático (nurture/broadcast) em
 * public.messages com sender='automation', direction='out', e atualiza
 * conversations.last_message_at. Não mexe em ai_active/awaiting_human —
 * mensagem automática não é handoff humano.
 */
export async function logAutomatedSend(
  admin: SupabaseClient,
  params: LogAutomatedSendParams,
): Promise<void> {
  const { tenantId, conversationId, content, status, errorMessage, externalId } = params;
  const { error: insertError } = await admin.from("messages").insert({
    tenant_id: tenantId,
    conversation_id: conversationId,
    sender: "automation",
    direction: "out",
    content,
    status,
    send_error: errorMessage ?? null,
    external_id: externalId ?? null,
  });
  if (insertError) {
    console.error(
      "logAutomatedSend: falha ao gravar mensagem automática",
      { conversationId, tenantId, status },
      insertError.message,
    );
  }
  const { error: updateError } = await admin
    .from("conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", conversationId);
  if (updateError) {
    console.error(
      "logAutomatedSend: falha ao atualizar last_message_at",
      { conversationId, tenantId, status },
      updateError.message,
    );
  }
}

// Guard de frequência cruzada entre nurture-runner e template-schedule-runner
// (risco #3 do PRD): no máx. N mensagens automáticas por contato na janela.
// Fonte única -- antes cada runner tinha uma cópia "mantida em sincronia" à
// mão. Fixo por ora, não configurável por tenant (YAGNI).
export const AUTOMATED_SEND_DAILY_LIMIT = 1;
export const AUTOMATED_SEND_WINDOW_HOURS = 24;

export interface CountRecentAutomatedSendsParams {
  tenantId: string;
  contactId: string;
  windowHours: number;
}

/**
 * Conta mensagens sender='automation' status='sent' (entregas confirmadas,
 * não tentativas) enviadas a este contato nas últimas `windowHours` horas
 * (join messages -> conversations via conversation_id, filtrando por
 * contact_id + tenant_id). Guard de frequência cruzada entre nurture e
 * broadcast (no máx N mensagens automáticas por contato/dia).
 */
export async function countRecentAutomatedSends(
  admin: SupabaseClient,
  params: CountRecentAutomatedSendsParams,
): Promise<number> {
  const { tenantId, contactId, windowHours } = params;
  const sinceIso = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  const { count, error } = await admin
    .from("messages")
    .select("id, conversations!inner(contact_id, tenant_id)", { count: "exact", head: true })
    .eq("sender", "automation")
    .eq("status", "sent")
    .eq("conversations.tenant_id", tenantId)
    .eq("conversations.contact_id", contactId)
    .gte("created_at", sinceIso);
  if (error) {
    throw new Error(`Falha ao contar envios automáticos recentes: ${error.message}`);
  }
  return count ?? 0;
}

/**
 * true = telefone suprimido (opt-out) e ainda não reativado. Extraído de
 * nurture-runner/runner.ts e template-schedule-runner/runner.ts, que tinham
 * cópias byte-idênticas desta query (Fase 4, review).
 *
 * scope='phone' explícito: o índice único da tabela é (tenant_id, phone,
 * scope), então pode existir mais de uma linha ativa para o mesmo telefone
 * com scope diferente (ex.: 'phone' e 'contact') sem violar o índice — aqui
 * checamos só a supressão em nível de telefone, por isso o filtro de scope
 * em vez de `.maybeSingle()` (que lançaria erro em caso de múltiplas linhas).
 */
export async function isPhoneSuppressed(
  admin: SupabaseClient,
  tenantId: string,
  phone: string | null,
): Promise<boolean> {
  // Normalizamos o argumento pra bater com o formato canônico (só dígitos)
  // que gravamos em messaging_phone_suppressions.phone. Sem isso, opt-out
  // gravado como "5511987654321" nunca casa com contacts.phone digitado
  // como "+55 11 98765-4321" e o contato continua recebendo automações.
  const normalized = normalizePhone(phone);
  if (!normalized) return false;
  const { data, error } = await admin
    .from("messaging_phone_suppressions")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("phone", normalized)
    .eq("scope", "phone")
    .is("reactivated_at", null)
    .limit(1);
  if (error) throw new Error(`Falha ao checar supressão de telefone: ${error.message}`);
  return (data?.length ?? 0) > 0;
}
