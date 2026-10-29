// gates.ts — pré-checagens (gates) de ai-respond: decide, com early return em
// cada etapa, se a IA tem permissão para gerar uma resposta para uma
// mensagem-gatilho. Extraído de ai-respond/index.ts (fix de review) junto
// com pipeline.ts, para manter index.ts como um orquestrador curto e cada
// módulo abaixo do teto de ~800 linhas do projeto — este arquivo concentra
// só a cadeia de pré-requisitos (runGates); pipeline.ts concentra o resto do
// pipeline (montagem de entidades/prompt, envio, avanço de estágio).
//
// runGates é o orquestrador público: encadeia um helper por seção (um por
// bloco de comentário abaixo), cada um devolvendo `{ ok: true; ... }` ou
// `{ ok: false; reason }`, com early return na primeira falha — mesmo
// formato de GateResult, só decomposto para caber no teto de 50L/função.
//
// Cada helper de seção é exportado (além de runGates) para permitir teste
// unitário direto em tests/gates.test.ts — sem isso, só dava pra exercitar
// cada etapa indiretamente via mock HTTP do Deno.serve completo
// (tests/ai-respond.test.ts), que cobre os casos de borda mas não isola
// qual etapa quebrou quando algo falha.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { reportAIFailure } from "./failure-log.ts";
import { evaluateTakeoverGate } from "./takeover-gate.ts";
import { claimAITurn, coalesceTurn } from "./turn-coalescer.ts";
import { checkRateLimit } from "./rate-limiter.ts";
import { notifyAdminHandoff } from "./notify-admin-handoff.ts";
import {
  AI_GATEWAY_TIMEOUT_MS,
  AI_SEND_OPERATION_BUDGET_MS,
  AI_TRANSCRIPTION_OPERATION_BUDGET_MS,
  AI_TTS_TOTAL_BUDGET_MS,
  type AiResponseBudget,
} from "./execution-budget.ts";
import { isAudioMedia } from "./voice.ts";

// Palavras-gatilho padrão de handoff quando o tenant ainda não configurou as
// próprias em ai_settings.handoff_default_keywords — usado só dentro de
// ensureAiSettings (garante a linha existir/populada) e devolvido ao caller
// via GateResult.defaultKeywords.
const DEFAULT_HANDOFF_KEYWORDS = [
  "falar com humano",
  "atendente",
  "pessoa real",
  "agendar",
  "marcar",
];

export interface GateMessage {
  id: string;
  tenant_id: string;
  conversation_id: string;
  content: string | null;
  media_url: string | null;
  media_type: string | null;
  created_at?: string;
}

export interface GateConversation {
  id: string;
  contact_id: string;
  subject: string | null;
  awaiting_human: boolean;
  ai_resumed_at?: string | null;
  channels?:
    | { provider_slug: string; type: string }
    | { provider_slug: string; type: string }[]
    | null;
}

export interface GateTenant {
  id: string;
  name: string;
  business_profile: Record<string, unknown> | null;
}

export interface GateContact {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
}

export interface GateSettings {
  max_response_blocks?: number | null;
  response_block_delay_ms?: number | null;
  message_coalesce_window_ms?: number | null;
  voice_reply_mode?: string | null;
  tenant_id: string;
  base_system_prompt: string | null;
  send_mode: string | null;
  model: string | null;
}

// Todos os "reason" que algum gate pode devolver quando bloqueia a IA.
// coalesced_* e takeover_blocked_* são os prefixos fixos de runGates
// concatenados com o reason literal devolvido por coalesceTurn/
// evaluateTakeoverGate (turn-coalescer.ts / takeover-gate.ts) — o template
// literal abaixo é checado pelo TS contra essas uniões, não é string solta.
export type GateFailureReason =
  | "message_not_found"
  | "not_contact_inbound"
  | "message_already_processing"
  | `coalesced_${"not_latest" | "duplicate_answer"}`
  | "conversation_not_found"
  | "ai_paused_conversation"
  | "awaiting_human"
  | `takeover_blocked_${"operator_active" | "human_responded"}`
  | "tenant_not_found"
  | "ai_disabled_tenant"
  | "contact_not_found"
  | "ai_paused_contact"
  // Não conseguimos ler/criar a linha de ai_settings do tenant. Bloqueia em vez
  // de seguir com settings=null, que faria a IA responder o cliente com a
  // persona de fábrica no lugar da do tenant (fix 05·H2).
  | "ai_settings_unavailable"
  | "rate_limited"
  | "locked";

/**
 * Recusas do gate que são TRANSITÓRIAS: quem chamou deve reagendar em vez de
 * marcar o job como concluído.
 *
 * Vive aqui, junto do tipo, porque a lista existia duplicada em
 * `messaging-webhook/index.ts` e `ai-response-worker/index.ts` — e a duplicata
 * cobrou: o `05·H2` acrescentou `ai_settings_unavailable` ao tipo e nenhuma das
 * duas cópias soube. Um blip no SELECT de `ai_settings` marcava o job como
 * sucesso e o lead ficava sem resposta, sem `awaiting_human`, sem notificação e
 * sem retentativa (achado `12 · H1`). Razão nova que for transitória entra
 * NESTA linha e os dois caminhos herdam.
 */
export const RETRYABLE_GATE_REASONS: ReadonlySet<string> = new Set<GateFailureReason>([
  "message_already_processing",
  "locked",
  "rate_limited",
  "ai_settings_unavailable",
]);

export type GateResult =
  | { ok: false; reason: GateFailureReason }
  | {
    ok: true;
    msg: GateMessage;
    tenantId: string;
    conversationId: string;
    conv: GateConversation;
    tenant: GateTenant;
    contact: GateContact;
    settings: GateSettings | null;
    defaultKeywords: string[];
    effectiveModel: string;
    lockToken: string;
    aiClaimToken: string;
  };

export type GateStep<T> = ({ ok: true } & T) | { ok: false; reason: GateFailureReason };

export interface RunGatesParams {
  admin: SupabaseClient;
  messageId: string;
  defaultAiModel: string;
  aiTakeoverMinutes: number;
  aiRateLimitMaxCalls: number;
  aiRateLimitWindowMs: number;
  aiLockTtlMs: number;
  budget?: AiResponseBudget;
}

// -------------------- Load the trigger message --------------------
// tenantId ainda não existe neste ponto (só sabemos o tenant DEPOIS de ler
// `msg.tenant_id`) — reportAIFailure exige tenantId, então aqui só logamos
// estruturado. Hard filter embutido: só responde a mensagens inbound
// enviadas pelo contato.
export async function loadTriggerMessage(
  admin: SupabaseClient,
  messageId: string,
): Promise<GateStep<{ msg: GateMessage }>> {
  const { data: msg, error: msgErr } = await admin
    .from("messages")
    .select(
      "id, tenant_id, conversation_id, sender, direction, content, media_url, media_type, created_at",
    )
    .eq("id", messageId)
    .maybeSingle();
  if (msgErr) {
    console.error("[ai-respond] query messages (trigger) falhou:", msgErr.message);
  }
  if (!msg) return { ok: false, reason: "message_not_found" };

  if (msg.direction !== "in" || msg.sender !== "contact") {
    return { ok: false, reason: "not_contact_inbound" };
  }

  return { ok: true, msg: msg as GateMessage };
}

// -------------------- Claim atômico por mensagem --------------------
// Complementa o lock por conversa (mais abaixo) com uma lease por mensagem.
// A lease mantém concorrentes fora, mas pode ser retomada depois de falha ou
// expiração; uma claim concluída continua definitivamente deduplicada.
export async function claimMessageOnce(
  admin: SupabaseClient,
  params: { messageId: string; conversationId: string; tenantId: string },
): Promise<GateStep<{ claimToken: string }>> {
  const { messageId, conversationId, tenantId } = params;
  const { data, error: claimErr } = await admin.rpc("claim_ai_processing_message", {
    p_message_id: messageId,
    p_conversation_id: conversationId,
    p_tenant_id: tenantId,
    p_lease_seconds: 180,
  });
  if (claimErr) {
    console.error("[ai-respond] claim_ai_processing_message falhou:", claimErr.message);
    await reportAIFailure(admin, {
      tenantId,
      route: "ai-respond",
      errorCode: "UNKNOWN",
      errorMessage: claimErr.message,
      context: { conversationId, phase: "claim" },
    });
    return { ok: false, reason: "message_already_processing" };
  }
  const row = (Array.isArray(data) ? data[0] : data) as
    | { claimed?: unknown; claim_state?: unknown; lease_token?: unknown }
    | null;
  const claimState = String(row?.claim_state ?? "");
  const claimToken = typeof row?.lease_token === "string" ? row.lease_token : "";
  if (row?.claimed !== true) {
    return { ok: false, reason: "message_already_processing" };
  }
  if (!claimToken || (claimState !== "claimed" && claimState !== "reclaimed")) {
    await reportAIFailure(admin, {
      tenantId,
      route: "ai-respond",
      errorCode: "UNKNOWN",
      errorMessage: "claim_ai_processing_message devolveu resposta inválida",
      context: { conversationId, phase: "claim_response" },
    });
    return { ok: false, reason: "message_already_processing" };
  }
  return { ok: true, claimToken };
}

export async function finishMessageClaim(
  admin: SupabaseClient,
  params: {
    messageId: string;
    claimToken: string;
    tenantId: string;
    conversationId: string;
    status: "failed" | "completed";
    reason?: string;
  },
): Promise<boolean> {
  const { data, error } = await admin.rpc("finish_ai_processing_message", {
    p_message_id: params.messageId,
    p_lease_token: params.claimToken,
    p_status: params.status,
    p_error: params.status === "failed" ? (params.reason ?? "unknown") : null,
  });
  if (!error) return data === true;

  console.error("[ai-respond] finish_ai_processing_message falhou:", error.message);
  await reportAIFailure(admin, {
    tenantId: params.tenantId,
    route: "ai-respond",
    errorCode: "UNKNOWN",
    errorMessage: error.message,
    context: {
      conversationId: params.conversationId,
      messageId: params.messageId,
      phase: "finish_claim",
      status: params.status,
      reason: params.reason ?? null,
    },
  });
  return false;
}

// -------------------- Coalescer de turno (burst de mensagens) --------------------
// O claim acima dedupe por message_id; isto complementa dedupe por
// CONVERSA — quando o lead manda várias mensagens em rajada, cada uma
// reivindica seu próprio message_id (passa no claim acima) mas só a mais
// recente do burst deve gerar resposta da IA.
export async function coalesceBurst(
  admin: SupabaseClient,
  params: {
    conversationId: string;
    tenantId: string;
    messageId: string;
    messageCreatedAt: string | undefined;
    coalesceWindowMs?: number | null;
    budget?: AiResponseBudget;
    reservedOperationMs?: number;
  },
): Promise<GateStep<Record<never, never>>> {
  const { conversationId, tenantId, messageId, messageCreatedAt } = params;
  const coalesce = await coalesceTurn(admin, {
    conversationId,
    messageId,
    messageCreatedAt,
    coalesceWindowMs: params.coalesceWindowMs,
    budget: params.budget,
    reservedOperationMs: params.reservedOperationMs,
  });
  if (!coalesce.proceed) {
    console.log("ai-respond coalesced", { tenantId, conversationId, reason: coalesce.reason });
    return { ok: false, reason: `coalesced_${coalesce.reason}` };
  }
  return { ok: true };
}

// -------------------- Load conversation + gate de takeover humano --------------------
// Mesmo com ai_active=true, a IA não deve responder por cima de um
// atendente humano: operador ativo (mensagem recente) OU QUALQUER humano
// já respondeu nesta conversa em algum momento → bloqueia e marca
// awaiting_human. Fail-closed: erro de query também bloqueia (ver
// has-human-responded.ts).
//
// `assignedAt` é passado como null DE PROPÓSITO: este projeto não tem
// coluna de assignment/atribuição em conversations (diferente do
// medflow-v0, de onde este gate foi portado). A proteção "operador recém
// atribuído" descrita no header de takeover-gate.ts só é alcançável hoje
// pelo fallback interno de isOperatorActive quando NENHUMA mensagem de
// agente existe — ou seja, na prática o gate atual só enxerga "operador
// ativo" via ÚLTIMA MENSAGEM humana na conversa, nunca via recência de
// atribuição. Ver header de takeover-gate.ts para o detalhe. TODO futuro:
// se este projeto ganhar tracking de assignment, passar o timestamp real
// aqui em vez de null.
export async function loadConversationAndTakeover(
  admin: SupabaseClient,
  params: { conversationId: string; tenantId: string; aiTakeoverMinutes: number },
): Promise<GateStep<{ conv: GateConversation }>> {
  const { conversationId, tenantId, aiTakeoverMinutes } = params;
  const { data: conv, error: convErr } = await admin
    .from("conversations")
    .select(
      "id, tenant_id, contact_id, channel_id, ai_active, subject, awaiting_human, ai_resumed_at, channels:channels!conversations_channel_id_fkey(provider_slug, type)",
    )
    .eq("id", conversationId)
    .maybeSingle();
  if (convErr) console.error("[ai-respond] query conversations falhou:", convErr.message);
  if (!conv || conv.tenant_id !== tenantId) return { ok: false, reason: "conversation_not_found" };
  if (!conv.ai_active) return { ok: false, reason: "ai_paused_conversation" };
  if (conv.awaiting_human) return { ok: false, reason: "awaiting_human" };

  const takeover = await evaluateTakeoverGate(
    admin,
    conversationId,
    null,
    aiTakeoverMinutes,
    undefined,
    (conv as { ai_resumed_at?: string | null }).ai_resumed_at ?? null,
  );
  if (!takeover.allowed) {
    // Guarda otimista (.eq("awaiting_human", false)): roda ANTES do lock de
    // concorrência (acquireConcurrencyLock, fim de runGates), então duas
    // invocações concorrentes desta MESMA conversa podem chegar aqui com o
    // mesmo snapshot conv.awaiting_human=false lido acima (TOCTOU). Decidir
    // notificar por esse snapshot em memória permitiria as duas notificarem;
    // decidir pelo resultado do UPDATE é atômico no Postgres — só uma das
    // duas invocações concorrentes casa a linha (a outra já vê
    // awaiting_human=true e o WHERE não casa nenhuma linha). .select("id")
    // devolve as linhas casadas (mesmo padrão de advanceDealStage em
    // pipeline.ts).
    const { data: transitioned, error: claimErr } = await admin
      .from("conversations")
      .update({ awaiting_human: true })
      .eq("id", conversationId)
      .eq("awaiting_human", false)
      .select("id");
    if (claimErr) {
      // Terceiro estado (H10): supabase-js não lança em erro de banco, então
      // `transitioned = null` por FALHA é idêntico a "outra invocação venceu a
      // corrida". Sem esta checagem o cliente pede humano e o admin nunca sabe.
      // Notifica mesmo assim — alerta duplicado é melhor que handoff perdido.
      console.error("[ai-respond] claim de awaiting_human (takeover) falhou:", claimErr.message);
    }
    console.log("ai-respond takeover_blocked", {
      tenantId,
      conversationId,
      reason: takeover.reason,
    });
    // Só notifica quando ESTA invocação foi quem realmente causou a
    // transição false→true (transitioned.length > 0), nunca pelo snapshot em
    // memória (A3: alerta imediato de handoff, ver notify-admin-handoff.ts) —
    // ou quando o próprio UPDATE falhou (claimErr), caso em que não dá pra
    // saber se a transição aconteceu e o silêncio custa mais que o ruído.
    if (claimErr || (transitioned && transitioned.length > 0)) {
      await notifyAdminHandoff(
        admin,
        tenantId,
        conversationId,
        `takeover_blocked_${takeover.reason}`,
      );
    }
    return { ok: false, reason: `takeover_blocked_${takeover.reason}` };
  }

  return { ok: true, conv: conv as GateConversation };
}

// -------------------- Load tenant --------------------
export async function loadTenant(
  admin: SupabaseClient,
  tenantId: string,
): Promise<GateStep<{ tenant: GateTenant }>> {
  const { data: tenant, error: tenantErr } = await admin
    .from("tenants")
    .select("id, name, business_profile, ai_enabled")
    .eq("id", tenantId)
    .maybeSingle();
  if (tenantErr) console.error("[ai-respond] query tenants falhou:", tenantErr.message);
  if (!tenant) return { ok: false, reason: "tenant_not_found" };
  if (!tenant.ai_enabled) return { ok: false, reason: "ai_disabled_tenant" };
  return { ok: true, tenant: tenant as GateTenant };
}

// -------------------- Load contact --------------------
export async function loadContact(
  admin: SupabaseClient,
  contactId: string,
): Promise<GateStep<{ contact: GateContact }>> {
  const { data: contact, error: contactErr } = await admin
    .from("contacts")
    .select("id, name, phone, email, ai_paused")
    .eq("id", contactId)
    .is("deleted_at", null)
    .maybeSingle();
  if (contactErr) console.error("[ai-respond] query contacts falhou:", contactErr.message);
  if (!contact) return { ok: false, reason: "contact_not_found" };
  if (contact.ai_paused) return { ok: false, reason: "ai_paused_contact" };
  return { ok: true, contact: contact as GateContact };
}

// -------------------- Ensure ai_settings row exists (on-demand default) --------------------
// Bloqueia quando não consegue garantir a linha do tenant. Antes seguia com
// `settings=null` em qualquer erro de query/insert — e ai-respond/index.ts lê
// `settings?.base_system_prompt ?? null`, então um blip transitório no SELECT
// fazia a IA responder o cliente com a PERSONA DE FÁBRICA no lugar da do
// tenant, sem sinal na UI e sem registro em lugar nenhum (fix 05·H2). Agora:
// uma retentativa cobre o blip; o que sobrar vira ai_failure_logs + gate
// negado (a resposta não sai, mas ninguém é atendido por outra persona).
const AI_SETTINGS_COLS =
  "tenant_id, base_system_prompt, handoff_default_keywords, send_mode, model, max_response_blocks, response_block_delay_ms, message_coalesce_window_ms, voice_reply_mode";

interface AiSettingsRow extends GateSettings {
  handoff_default_keywords: string[] | null;
}

export async function ensureAiSettings(
  admin: SupabaseClient,
  tenantId: string,
  defaultAiModel: string,
): Promise<
  GateStep<{ settings: GateSettings | null; defaultKeywords: string[]; effectiveModel: string }>
> {
  const lerSettings = async (): Promise<{ row: AiSettingsRow | null; erro: string | null }> => {
    const { data, error } = await admin
      .from("ai_settings")
      .select(AI_SETTINGS_COLS)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    return { row: (data as AiSettingsRow | null) ?? null, erro: error?.message ?? null };
  };

  let leitura = await lerSettings();
  if (leitura.erro) leitura = await lerSettings();
  if (leitura.erro) {
    console.error("[ai-respond] query ai_settings falhou:", leitura.erro);
    await reportAIFailure(admin, {
      tenantId,
      route: "ai-respond",
      errorCode: "UNKNOWN",
      errorMessage: leitura.erro,
      context: { phase: "ai_settings_select" },
    });
    return { ok: false, reason: "ai_settings_unavailable" };
  }

  let settings = leitura.row;
  if (!settings) {
    const { data: created, error: createdErr } = await admin
      .from("ai_settings")
      .insert({
        tenant_id: tenantId,
        handoff_default_keywords: DEFAULT_HANDOFF_KEYWORDS,
      })
      .select(AI_SETTINGS_COLS)
      .single();
    // 23505 = outra isolate criou a linha entre o nosso SELECT e o INSERT.
    // A linha EXISTE: reler é o certo, não bloquear um turno por corrida benigna.
    const conflito = (createdErr as { code?: string } | null)?.code === "23505";
    const relido = conflito ? await lerSettings() : null;
    if (createdErr) {
      console.error("[ai-respond] insert ai_settings falhou:", createdErr.message);
      await reportAIFailure(admin, {
        tenantId,
        route: "ai-respond",
        errorCode: "UNKNOWN",
        errorMessage: createdErr.message,
        context: { phase: "ai_settings_insert", releitura_apos_conflito: relido?.erro ?? null },
      });
    }
    // Só bloqueia quando SABEMOS que existe linha e não conseguimos lê-la
    // (conflito + releitura falha) — aí sim o tenant tem persona própria e
    // responder com a de fábrica seria a troca silenciosa do fix 05·H2. Insert
    // que falha por outro motivo NÃO substitui persona nenhuma: o SELECT
    // limpo acima provou que o tenant ainda não tem linha, então seguir com
    // defaults é o comportamento honesto — agora com rastro em ai_failure_logs.
    if (conflito && !relido?.row) return { ok: false, reason: "ai_settings_unavailable" };
    settings = relido?.row ?? (created as AiSettingsRow | null);
  } else if (
    !settings.handoff_default_keywords ||
    (settings.handoff_default_keywords as string[]).length === 0
  ) {
    await admin
      .from("ai_settings")
      .update({ handoff_default_keywords: DEFAULT_HANDOFF_KEYWORDS })
      .eq("tenant_id", tenantId);
    settings.handoff_default_keywords = DEFAULT_HANDOFF_KEYWORDS;
  }

  const defaultKeywords = (settings?.handoff_default_keywords as string[] | null) ??
    DEFAULT_HANDOFF_KEYWORDS;

  // "default" é o valor de fábrica da coluna (ai_settings.model) — só troca o
  // modelo hardcoded quando o tenant configurou algo diferente disso.
  const effectiveModel = settings?.model && (settings.model as string) !== "default"
    ? (settings.model as string)
    : defaultAiModel;

  return {
    ok: true,
    settings: (settings as GateSettings | null) ?? null,
    defaultKeywords,
    effectiveModel,
  };
}

// -------------------- Rate limit (chamadas de IA por conversa) --------------------
// RPC atômica (rate-limiter.ts) — substitui a antiga contagem diária
// ingênua por tenant por um teto por CONVERSA, que não trava outras
// conversas do mesmo tenant quando uma delas está em loop de retry.
// Chamado ANTES do lock (abaixo) de propósito: não vale a pena adquirir o
// lock de conversa se a chamada já vai ser negada por rate limit.
export async function enforceRateLimit(
  admin: SupabaseClient,
  params: {
    conversationId: string;
    tenantId: string;
    aiRateLimitMaxCalls: number;
    aiRateLimitWindowMs: number;
  },
): Promise<GateStep<Record<never, never>>> {
  const { conversationId, tenantId, aiRateLimitMaxCalls, aiRateLimitWindowMs } = params;
  const rateLimit = await checkRateLimit(
    admin,
    conversationId,
    aiRateLimitMaxCalls,
    aiRateLimitWindowMs,
  );
  if (!rateLimit.allowed) {
    // rpcFailed=true = a RPC em si quebrou (banco fora do ar, etc.) — não é
    // um rate-limit legítimo, é uma falha de infra fail-closed disfarçada de
    // rate limit. Diferente do caso legítimo (rpcFailed ausente/false):
    // acionável, marca awaiting_human e reporta em ai_failure_logs.
    if (rateLimit.rpcFailed) {
      // Guarda otimista (mesmo motivo/padrão de loadConversationAndTakeover
      // acima): este gate também roda ANTES do lock de concorrência, então
      // decidir notificar por um snapshot em memória permitiria duas
      // invocações concorrentes notificarem a mesma transição. O resultado
      // do UPDATE condicional é a fonte de verdade, não previousAwaitingHuman.
      const { data: transitioned, error: claimErr } = await admin
        .from("conversations")
        .update({ awaiting_human: true })
        .eq("id", conversationId)
        .eq("awaiting_human", false)
        .select("id");
      if (claimErr) {
        // Mesmo terceiro estado do claim de takeover (H10): erro no UPDATE não
        // é "a corrida foi vencida por outra invocação". Aqui a IA já falhou
        // fail-closed por RPC quebrada — perder o alerta deixa a conversa muda.
        console.error(
          "[ai-respond] claim de awaiting_human (rate limit) falhou:",
          claimErr.message,
        );
      }
      await reportAIFailure(admin, {
        tenantId,
        route: "ai-respond.rate-limit",
        errorCode: "UNKNOWN",
        errorMessage: "RPC check_and_record_rate_limit falhou; negado por fail-closed.",
        context: { conversationId },
      });
      if (claimErr || (transitioned && transitioned.length > 0)) {
        await notifyAdminHandoff(admin, tenantId, conversationId, "rate_limit_rpc_failed");
      }
    }
    console.log("ai-respond rate_limited", {
      tenantId,
      conversationId,
      retryAfterMs: rateLimit.retryAfterMs,
      rpcFailed: !!rateLimit.rpcFailed,
    });
    return { ok: false, reason: "rate_limited" };
  }
  return { ok: true };
}

// -------------------- Lock de concorrência (evita respostas duplicadas) --------------------
// Duas mensagens do mesmo contato podem disparar ai-respond quase ao mesmo
// tempo. claimAITurn é um test-and-set atômico com token (turn-coalescer.ts):
// 0 linhas afetadas = outro disparo detém o lock = pula sem retrigger. TTL
// auto-cura um release perdido; o token evita liberar o lock de um disparo
// concorrente que já reclamou depois de um timeout.
export async function acquireConcurrencyLock(
  admin: SupabaseClient,
  conversationId: string,
  aiLockTtlMs: number,
): Promise<GateStep<{ lockToken: string }>> {
  const claim = await claimAITurn(admin, { conversationId, lockTtlMs: aiLockTtlMs });
  if (!claim.claimed) {
    return { ok: false, reason: "locked" };
  }
  return { ok: true, lockToken: claim.token };
}

/**
 * Encadeia todas as pré-checagens de ai-respond que decidem, com early
 * return, se a IA deve gerar uma resposta: carrega a mensagem-gatilho,
 * reivindica-a atomicamente (dedupe por message_id), coalesce um burst de
 * mensagens (coalesceTurn), carrega conversation/tenant/contact e valida
 * cada um (ai_active/ai_enabled/ai_paused), aplica o gate de takeover humano
 * (evaluateTakeoverGate), garante a linha de ai_settings, checa o rate limit
 * por conversa (checkRateLimit) e por fim adquire o lock de concorrência
 * (claimAITurn) — o mesmo lock que o caller deve liberar via releaseAITurn
 * quando a resposta terminar (sucesso, falha ou handoff).
 *
 * Nunca lança: qualquer falha de query é logada e, quando já há tenantId,
 * reportada via reportAIFailure; o retorno é sempre um GateResult tipado.
 * Cada etapa é um helper acima (uma seção do runGates original antes desta
 * decomposição) — este orquestrador só encadeia com early-return.
 */
export async function runGates(params: RunGatesParams): Promise<GateResult> {
  const {
    admin,
    messageId,
    defaultAiModel,
    aiTakeoverMinutes,
    aiRateLimitMaxCalls,
    aiRateLimitWindowMs,
    aiLockTtlMs,
  } = params;

  const messageStep = await loadTriggerMessage(admin, messageId);
  if (!messageStep.ok) return messageStep;
  const { msg } = messageStep;
  const tenantId = msg.tenant_id;
  const conversationId = msg.conversation_id;

  const claimStep = await claimMessageOnce(admin, { messageId: msg.id, conversationId, tenantId });
  if (!claimStep.ok) return claimStep;
  const releaseClaim = async (failure: { ok: false; reason: GateFailureReason }) => {
    await finishMessageClaim(admin, {
      messageId: msg.id,
      claimToken: claimStep.claimToken,
      tenantId,
      conversationId,
      status: "failed",
      reason: failure.reason,
    });
    return failure;
  };

  const settingsStep = await ensureAiSettings(admin, tenantId, defaultAiModel);
  if (!settingsStep.ok) return await releaseClaim(settingsStep);
  const { settings, defaultKeywords, effectiveModel } = settingsStep;
  const inboundAudio = !!msg.media_url && isAudioMedia(msg.media_type);
  const voiceReply = settings?.voice_reply_mode === "always" ||
    (settings?.voice_reply_mode === "on_audio" && inboundAudio);
  const reservedOperationMs = AI_GATEWAY_TIMEOUT_MS + AI_SEND_OPERATION_BUDGET_MS +
    (inboundAudio ? AI_TRANSCRIPTION_OPERATION_BUDGET_MS : 0) +
    (voiceReply ? AI_TTS_TOTAL_BUDGET_MS : 0);

  const coalesceStep = await coalesceBurst(admin, {
    coalesceWindowMs: settings?.message_coalesce_window_ms,
    budget: params.budget,
    reservedOperationMs,
    conversationId,
    tenantId,
    messageId: msg.id,
    messageCreatedAt: msg.created_at,
  });
  if (!coalesceStep.ok) return await releaseClaim(coalesceStep);

  const convStep = await loadConversationAndTakeover(admin, {
    conversationId,
    tenantId,
    aiTakeoverMinutes,
  });
  if (!convStep.ok) return await releaseClaim(convStep);
  const { conv } = convStep;

  const tenantStep = await loadTenant(admin, tenantId);
  if (!tenantStep.ok) return await releaseClaim(tenantStep);
  const { tenant } = tenantStep;

  const contactStep = await loadContact(admin, conv.contact_id);
  if (!contactStep.ok) return await releaseClaim(contactStep);
  const { contact } = contactStep;

  const rateLimitStep = await enforceRateLimit(admin, {
    conversationId,
    tenantId,
    aiRateLimitMaxCalls,
    aiRateLimitWindowMs,
  });
  if (!rateLimitStep.ok) return await releaseClaim(rateLimitStep);

  const lockStep = await acquireConcurrencyLock(admin, conversationId, aiLockTtlMs);
  if (!lockStep.ok) return await releaseClaim(lockStep);

  return {
    ok: true,
    msg,
    tenantId,
    conversationId,
    conv,
    tenant,
    contact,
    settings,
    defaultKeywords,
    effectiveModel,
    lockToken: lockStep.lockToken,
    aiClaimToken: claimStep.claimToken,
  };
}
