// AI auto-response for inbound contact messages.
// Called internally by messaging-webhook after persisting an inbound message.
// Auth: fail-closed — Bearer must equal SUPABASE_SERVICE_ROLE_KEY.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { renderTemplate } from "../_shared/ai/prompt-vars.ts";
import { type AiError, sanitizeProviderError } from "../_shared/ai/errors.ts";
import { callLovableGateway, LovableGatewayHttpError } from "../_shared/ai/gateway.ts";
import { releaseAITurn } from "../_shared/ai/turn-coalescer.ts";
import { limitEmojis } from "../_shared/ai/emoji-limiter.ts";
import { detectAssistantUncertainty } from "../_shared/ai/uncertainty.ts";
import { reportAIFailure } from "../_shared/ai/failure-log.ts";
import { notifyAdminHandoff } from "../_shared/ai/notify-admin-handoff.ts";
import { matchHandoffReason } from "../_shared/ai/handoff-intent.ts";
import { finishMessageClaim, runGates } from "../_shared/ai/gates.ts";
import {
  AI_GATEWAY_TIMEOUT_MS,
  AI_RESPONSE_CLEANUP_BUDGET_MS,
  AI_RESPONSE_LOCK_TTL_MS,
  AI_TRANSCRIPTION_OPERATION_BUDGET_MS,
  AiResponseDeadlineError,
  createAiResponseBudget,
  requireAiResponseTime,
} from "../_shared/ai/execution-budget.ts";
import {
  buildSystemPrompt,
  evaluateStageAdvancement,
  loadOrCreateOpenDeal,
  loadRecentHistory,
  loadStageAiConfig,
  performHandoff,
} from "../_shared/ai/pipeline.ts";
import { finalizeAiReply } from "../_shared/ai/send-dispatch.ts";
import {
  isAudioMedia,
  isElevenLabsActive,
  isEncryptedWhatsAppMediaUrl,
  isMetaMediaReference,
  loadVoiceReplyPreference,
  shouldReplyWithAudio,
  transcribeAudio,
  transcribeMetaCloudAudio,
} from "../_shared/ai/voice.ts";
import { loadProviderSecrets } from "../_shared/messaging/provider-send.ts";
import { captureEdgeError } from "../_shared/telemetry.ts";

// Reexportado para preservar o import direto que
// supabase/functions/tests/ai-respond.test.ts já fazia antes da extração
// deste módulo (`const { renderTemplate } = await import("../ai-respond/index.ts")`).
export { renderTemplate };

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Exportado para o teste comparar o modelo efetivamente usado sem duplicar o
// literal (ver supabase/functions/tests/ai-respond.test.ts, seção "modelo").
export const DEFAULT_AI_MODEL = "google/gemini-3-flash-preview";
// Tetos de contexto: janela de histórico (mensagens e caracteres) + limite de
// tokens de saída, para a chamada nunca estourar contexto silenciosamente.
const HISTORY_LIMIT = 20;
const HISTORY_MAX_CHARS = 8000;
const AI_MAX_OUTPUT_TOKENS = 1024;

// Resposta para áudio que chega cifrado (WhatsApp nativo via Zappaz). Texto
// fixo de propósito: não há transcrição para o modelo trabalhar em cima, e
// gerar via LLM só adiciona latência e risco de alucinar sobre o que o lead
// disse. Exportado para o teste conferir sem duplicar o literal.
//
// AFIRMAÇÃO, não pergunta ("Pode me mandar por escrito?" era a versão
// anterior): `dropTrailingQuestion` (send-dispatch.ts) sorteia — com
// `Math.random` — se apaga a pergunta final, para a IA não terminar toda
// mensagem perguntando. Numa resposta gerada isso é bom; aqui apagaria
// justamente o pedido que é a razão da mensagem existir, e o lead receberia só
// "Ainda não consigo ouvir áudios por aqui." em ~1 de cada 4 envios. Sem "?"
// no fim, a função devolve o texto intacto no primeiro `if`.
export const AUDIO_CIFRADO_REPLY =
  "Ainda não consigo ouvir áudios por aqui. Me manda por escrito que eu te respondo.";

// Rate limit por conversa (substitui o antigo teto diário ingênuo por
// tenant): 5 chamadas/60s via RPC atômica (rate-limiter.ts). Alto o
// suficiente para não travar um burst legítimo de handoff/qualificação,
// baixo o suficiente para travar um loop de erro (ex.: retry de webhook).
const AI_RATE_LIMIT_MAX_CALLS = 5;
const AI_RATE_LIMIT_WINDOW_MS = 60_000;
// Minutos sem mensagem de um atendente humano para a IA poder assumir uma
// conversa. Abaixo do limiar, presume atendente ainda engajado (não
// interrompe). Mesmo abaixo do limiar, se ALGUM humano já respondeu nesta
// conversa (não só recentemente), o gate bloqueia de qualquer forma —
// mesma proteção do incidente 2026-06-17 do medflow-v0 (gaps naturais de
// atendimento humano não podem liberar a IA para responder por cima dele).
const AI_TAKEOVER_MINUTES = 30;

interface Payload {
  message_id: string;
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

/**
 * Coloca a conversa na fila de atendimento humano depois de uma falha da IA e
 * só então notifica o admin. Devolve `true` se a fila foi mesmo gravada.
 *
 * O UPDATE é o mecanismo: quem faz a conversa aparecer em /inbox é
 * `awaiting_human=true` (src/lib/api/human-attention.ts filtra por ele).
 * supabase-js NÃO lança em erro do PostgREST — devolve `{ error }` — então,
 * sem checar, o admin recebia "a conversa foi para a fila humana" enquanto a
 * conversa continuava fora da fila, sem resposta e sem ninguém atribuído. Em
 * erro: evento consultável com código próprio e NENHUMA notificação (avisar
 * de um enfileiramento que não aconteceu é pior que não avisar).
 */
export async function enfileirarParaHumanoAposFalha(
  admin: SupabaseClient,
  params: {
    tenantId: string;
    conversationId: string;
    aiError: AiError;
    /** Valor lido por runGates ANTES desta falha: notifica só na transição false→true. */
    wasAwaitingHuman: boolean;
    messageId: string;
  },
): Promise<boolean> {
  const { tenantId, conversationId, aiError, wasAwaitingHuman, messageId } = params;
  const { error: filaErr } = await admin
    .from("conversations")
    .update({ last_error: aiError, awaiting_human: true })
    .eq("id", conversationId);

  if (filaErr) {
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "ai-respond.handoff_fila_humana",
      tenantId,
      conversationId,
      errorCode: "handoff_write_failed",
      message:
        `Falha da IA não entrou na fila humana: UPDATE conversations falhou (${filaErr.message}). Conversa segue sem awaiting_human e sem ninguém atribuído.`,
      context: { message_id: messageId, ai_error_code: aiError.code },
    });
    return false;
  }

  // notifyAdminHandoff nunca lança (A3: alerta imediato de handoff).
  if (!wasAwaitingHuman) {
    await notifyAdminHandoff(admin, tenantId, conversationId, "generation_failed");
  }
  return true;
}

// -------------------- AI call --------------------
// Chamada HTTP em si delegada a gateway.ts (compartilhada com pipeline.ts,
// qualification.ts, memory-summary.ts, memory-consolidator.ts) — este
// wrapper só preserva o contrato de erro específico deste caller (mensagem
// amigável por statusCode + provider="lovable-gateway" + validação de texto
// vazio, usados pelo catch abaixo em Deno.serve via sanitizeProviderError).
async function callLovableAI(
  systemPrompt: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  model: string,
): Promise<string> {
  let text: string;
  try {
    text = (
      await callLovableGateway(systemPrompt, history, model, {
        maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
      })
    ).trim();
  } catch (e) {
    if (e instanceof LovableGatewayHttpError) {
      const friendly = e.statusCode === 429
        ? "Muitas requisições à IA agora. Tentaremos de novo em instantes."
        : e.statusCode === 402
        ? "Créditos de IA esgotados. Recarregue para continuar respondendo."
        : "A IA não conseguiu responder desta vez.";
      throw Object.assign(new Error(friendly), {
        provider: "lovable-gateway",
        statusCode: e.statusCode,
        ...(e.retryAfterSeconds !== undefined ? { retryAfterSeconds: e.retryAfterSeconds } : {}),
      });
    }
    throw e;
  }
  if (!text) throw new Error("A IA retornou uma resposta vazia.");
  return text;
}

// -------------------- Main --------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Fail-closed: only accept service-role bearer.
  const authHeader = req.headers.get("Authorization") ?? "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!bearer || bearer !== SERVICE_ROLE) {
    return json(401, { error: "Unauthorized" });
  }
  const budget = createAiResponseBudget();

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => fetch(input, {
        ...init,
        signal: AbortSignal.any([
          req.signal,
          ...(init?.signal ? [init.signal] : []),
          AbortSignal.timeout(Math.max(
            1,
            budget.deadlineAt + AI_RESPONSE_CLEANUP_BUDGET_MS - budget.now(),
          )),
        ]),
      }),
    },
  });

  // Catch de topo: zero sink hoje para qualquer falha de infra entre aqui e o
  // fim do handler (runGates, loadOrCreateOpenDeal, loadStageAiConfig,
  // buildSystemPrompt, loadRecentHistory...) — só o bloco de geração da IA
  // (try abaixo, já existente) tem sink hoje (reportAIFailure). tenantId só é
  // conhecido depois de runGates suceder; guardamos em variável hoisted para
  // o catch poder correlacionar o evento por tenant mesmo em falha tardia.
  let tenantIdForTelemetry: string | null = null;
  let conversationIdForTelemetry: string | null = null;
  let releaseActiveLock: (() => Promise<unknown>) | null = null;
  let finishActiveClaim:
    | ((status: "failed" | "completed", reason?: string) => Promise<boolean>)
    | null = null;
  try {
    let body: Payload;
    try {
      body = (await req.json()) as Payload;
    } catch {
      return json(400, { error: "Corpo inválido." });
    }
    if (!body.message_id) return json(400, { error: "message_id obrigatório." });

    // -------------------- Gates (pipeline.ts) --------------------
    // Carrega a mensagem-gatilho e encadeia, com early return, todos os
    // pré-requisitos para a IA poder responder: claim atômico por mensagem,
    // coalescer de burst, conversation/tenant/contact + seus próprios flags
    // (ai_active/ai_enabled/ai_paused), gate de takeover humano, ai_settings e
    // por fim rate limit + lock de concorrência (token devolvido em
    // gates.lockToken, liberado abaixo via releaseLock em todo caminho de
    // saída). Ver runGates em pipeline.ts para o detalhe de cada etapa.
    const gates = await runGates({
      admin,
      messageId: body.message_id,
      defaultAiModel: DEFAULT_AI_MODEL,
      aiTakeoverMinutes: AI_TAKEOVER_MINUTES,
      aiRateLimitMaxCalls: AI_RATE_LIMIT_MAX_CALLS,
      aiRateLimitWindowMs: AI_RATE_LIMIT_WINDOW_MS,
      aiLockTtlMs: AI_RESPONSE_LOCK_TTL_MS,
      budget,
    });
    if (!gates.ok) return json(200, { ok: false, reason: gates.reason });

    const { msg, tenantId, conversationId, conv, tenant, contact, settings, defaultKeywords } =
      gates;
    tenantIdForTelemetry = tenantId;
    conversationIdForTelemetry = conversationId;
    const effectiveModel = gates.effectiveModel;
    // Alias não-nulo: o closure doHandoff captura a variável e o TS não preserva
    // o narrowing do guard de runGates dentro dele.
    const contactRow = contact;
    const releaseLock = async () => {
      try {
        return await releaseAITurn(admin, { conversationId, token: gates.lockToken });
      } finally {
        releaseActiveLock = null;
      }
    };
    releaseActiveLock = releaseLock;
    const finishClaim = async (
      status: "failed" | "completed",
      reason?: string,
    ): Promise<boolean> => {
      try {
        return await finishMessageClaim(admin, {
          messageId: msg.id,
          claimToken: gates.aiClaimToken,
          tenantId,
          conversationId,
          status,
          reason,
        });
      } finally {
        finishActiveClaim = null;
      }
    };
    finishActiveClaim = finishClaim;

    // -------------------- Deal + stage_ai_config (pipeline.ts) — PROTEGIDO PELO LOCK --------------------
    // Duas mensagens quase simultâneas do mesmo contato podiam, antes desta
    // fix, cair aqui ANTES do lock e ambas encontrarem "nenhum deal aberto",
    // criando 2 deals duplicados. Agora a busca/criação (loadOrCreateOpenDeal)
    // só roda depois que este disparo já detém o lock exclusivo da conversa —
    // um segundo disparo concorrente nem chega a passar do gate de lock em
    // runGates, então nunca corre esta busca em paralelo.
    const { dealId, dealStageId } = await loadOrCreateOpenDeal(admin, tenantId, contact);
    const { stagePrompt, stageAdvancement, stageHandoffKeywords, stageGoal } =
      await loadStageAiConfig(admin, tenantId, dealStageId);

    // -------------------- Handoff pre-check --------------------
    const hasMedia = !!(msg.media_url || (msg.media_type && String(msg.media_type).trim()));
    const conversationChannel = Array.isArray(conv.channels) ? conv.channels[0] : conv.channels;

    /**
     * Responde ao lead SEM desligar a IA da conversa.
     *
     * Existe porque `performHandoff` grava `ai_active=false`: depois dele, TODA
     * mensagem seguinte daquela conversa morre em `runGates` com
     * `ai_paused_conversation`, mesmo texto puro. Para o que um humano precisa
     * assumir (imagem, palavra-chave, IA sem resposta) isso está certo. Para
     * "chegou mídia que a gente ainda não decodifica" não estava: em produção,
     * um único áudio do Zappaz em 05/08 11:38 deixou o canal inteiro mudo — o
     * lead mandou texto às 12:23 e a IA não respondeu mais.
     */
    async function replyWithoutHandoff(text: string, reason: string) {
      const finalize = await finalizeAiReply({
        admin,
        tenantId,
        conversationId,
        contactId: contactRow.id,
        dealId,
        aiText: text,
        sendMode: settings?.send_mode === "draft" ? "draft" : "auto",
        maxResponseBlocks: settings?.max_response_blocks,
        responseBlockDelayMs: settings?.response_block_delay_ms,
        budget,
        providerSlug: conversationChannel?.provider_slug ?? "",
        contactPhone: contactRow.phone,
        contactEmail: contactRow.email,
        subject: conv.subject ?? null,
        previousAwaitingHuman: conv.awaiting_human,
        voice: null,
      });
      // O caminho irmão (performHandoff) deixa 3 rastros: activity,
      // awaiting_human e alerta ao admin. Este não deixava nenhum — contar
      // quantos leads mandaram áudio e não foram ouvidos dependia de casar o
      // TEXTO da resposta, que já mudou uma vez hoje. Evento resolve.
      await captureEdgeError(admin, {
        severity: "warn",
        source: "edge",
        operation: "ai.audio.degradado",
        tenantId,
        conversationId,
        message: "Áudio recebido sem transcrição possível — respondido pedindo texto.",
        context: { stage: reason, message_id: msg.id, provider: conversationChannel?.provider_slug },
      });
      const ok = finalize.kind !== "insert_failed";
      if (finalize.kind === "interrupted") {
        if (finalize.reason !== "takeover") await flagInterruptedReply(finalize.reason);
        await finishClaim("completed");
        await releaseLock();
        return json(200, { ok: true, sent: finalize.sent, interrupted: finalize.reason });
      }
      await finishClaim(ok ? "completed" : "failed", ok ? undefined : "insert_failed");
      await releaseLock();
      return json(200, {
        ok,
        reason,
        sent: finalize.kind === "sent" ? finalize.sent : false,
      });
    }

    async function doHandoff(reason: string) {
      const result = await performHandoff({
        admin,
        tenantId,
        conversationId,
        dealId,
        contact: contactRow,
        reason,
        previousAwaitingHuman: conv.awaiting_human,
      });
      return json(200, { ok: true, handoff: true, reason: result.reason });
    }

    async function handoffAndRelease(reason: string) {
      try {
        const response = await doHandoff(reason);
        await finishClaim("completed");
        return response;
      } catch (error) {
        await finishClaim("failed", `handoff:${reason}`);
        throw error;
      } finally {
        // A pausa/handoff precisa ser persistida antes de liberar o lock para
        // impedir que outro turno entre entre a decisão e a transição.
        await releaseLock();
      }
    }

    async function flagInterruptedReply(reason: string) {
      // Não desfaz takeover nem substitui um handoff mais recente.
      const { error } = await admin.from("conversations").update({
        awaiting_human: true,
        last_error: `Resposta da IA interrompida: ${reason}. Revise a conversa antes de retomar.`,
      }).eq("id", conversationId).eq("tenant_id", tenantId)
        .eq("ai_active", true).eq("awaiting_human", false);
      if (error) console.error("ai-respond: falha ao sinalizar resposta interrompida", error.message);
    }

    // -------------------- Áudio: a IA escuta em vez de passar pro humano --------------------
    // Antes, QUALQUER mídia caía em doHandoff("media_received"). Agora só áudio
    // é transcrito; imagem/vídeo/documento seguem em handoff, porque o modelo
    // desta rota é texto puro e não saberia o que fazer com eles.
    //
    // Roda DENTRO do lock de propósito: soltar o lock antes de uma operação de
    // ~30s reabriria a janela de disparo concorrente que o lock existe pra
    // fechar — a mesma que gerava deals duplicados antes de loadOrCreateOpenDeal
    // passar pra dentro dele. Orçamento de tempo em _shared/ai/voice.ts.
    let effectiveContent = String(msg.content ?? "");
    let inboundWasAudio = false;
    let transcriptionProvider = "elevenlabs";
    if (hasMedia) {
      if (!isAudioMedia(msg.media_type) || !msg.media_url) {
        return await handoffAndRelease("media_received");
      }

      // Áudio cifrado do WhatsApp nativo (`.enc` na CDN whatsapp.net, protocolo
      // Baileys — Zappaz e similares). A transcrição não decodifica isso hoje,
      // então baixar 27 KB de ciphertext e queimar uma chamada da ElevenLabs só
      // para cair no mesmo erro é desperdício: corta antes.
      //
      // O ponto importante é NÃO fazer handoff aqui. Ver replyWithoutHandoff.
      if (isEncryptedWhatsAppMediaUrl(msg.media_url)) {
        return await replyWithoutHandoff(AUDIO_CIFRADO_REPLY, "audio_cifrado_sem_suporte");
      }

      inboundWasAudio = true;
      // A leitura da credencial fica DENTRO deste try de propósito:
      // loadProviderSecrets lança em erro de banco (provider-send.ts), e aqui
      // já estamos com o lock tomado. Uma exceção subindo até o catch de topo
      // não passa por nenhum releaseLock — e, pior, o claim em
      // ai_processing_log (gates.ts) não tem TTL nem delete, então aquela
      // mensagem do lead nunca mais seria reprocessada. Um blip de banco
      // apagava o áudio do cliente em definitivo.
      try {
        // Gate de integração ANTES de ler o segredo: `disconnect` marca
        // tenant_integrations.status='disabled' mas DEIXA a chave gravada em
        // integration_secrets (só `forget` apaga), e loadProviderSecrets lê os
        // segredos direto, sem olhar o status. Sem esta checagem o tenant
        // desconectava a ElevenLabs na UI e a transcrição continuava rodando,
        // queimando crédito da conta DELE sem nenhuma forma de parar a não ser
        // apagando a chave. O commit e1e0c31 fechou o mesmo buraco na RESPOSTA
        // (TTS, via loadVoiceReplyPreference); esta é a ENTRADA (STT).
        //
        // Vem antes de loadProviderSecrets de propósito: integração desligada
        // não deve nem pagar a query do segredo.
        if (!(await isElevenLabsActive(admin, tenantId))) {
          return await handoffAndRelease("audio_sem_transcricao");
        }

        const elevenCred = await loadProviderSecrets(admin, tenantId, "elevenlabs");
        const elevenKey = elevenCred.api_key ?? "";
        if (!elevenKey) {
          // Tenant sem ElevenLabs conectado mantém o comportamento antigo —
          // áudio vira handoff. Razão distinta pra não mascarar nos relatórios
          // como se fosse falha técnica. Dois casos usam esta razão, os dois
          // "não dá pra transcrever" e nenhum deles falha técnica: integração
          // não-ativa (gate acima) e chave ausente (aqui). Falha de LEITURA —
          // exceção de banco — é outra coisa e cai no catch abaixo.
          return await handoffAndRelease("audio_sem_transcricao");
        }

        let transcript: string;
        if (
          conversationChannel?.provider_slug === "meta-cloud" &&
          isMetaMediaReference(msg.media_url)
        ) {
          transcriptionProvider = "meta-cloud";
          const metaCred = await loadProviderSecrets(admin, tenantId, "meta-cloud");
          requireAiResponseTime(budget, AI_TRANSCRIPTION_OPERATION_BUDGET_MS);
          transcript = await transcribeMetaCloudAudio(
            elevenKey,
            metaCred.access_token ?? "",
            msg.media_url,
            { phoneNumberId: metaCred.phone_number_id },
          );
        } else {
          requireAiResponseTime(budget, AI_TRANSCRIPTION_OPERATION_BUDGET_MS);
          transcript = await transcribeAudio(elevenKey, msg.media_url);
        }
        // Persistir é OBRIGATÓRIO, não cosmético: loadRecentHistory (pipeline.ts)
        // lê `content` do banco e descarta mensagem de content vazio — sem
        // gravar, a IA receberia o histórico SEM o áudio que acabou de ouvir.
        // Efeito colateral desejado: o atendente humano passa a ver no inbox o
        // que o cliente falou.
        // ponytail: grava direto em `content`; se um dia precisar distinguir
        // transcrição de texto digitado, criar coluna `transcript` + migration.
        effectiveContent = effectiveContent.trim()
          ? `${effectiveContent.trim()}\n${transcript}`
          : transcript;
        const { error: updErr } = await admin
          .from("messages")
          .update({ content: effectiveContent })
          .eq("id", msg.id);
        if (updErr) throw new Error(`falha ao gravar a transcrição: ${updErr.message}`);
      } catch (e) {
        if (e instanceof AiResponseDeadlineError) throw e;
        const voiceError = sanitizeProviderError(e);
        await reportAIFailure(admin, {
          tenantId,
          route: "ai-respond",
          provider: transcriptionProvider,
          model: null,
          statusCode: voiceError.statusCode ?? null,
          errorCode: voiceError.code,
          errorMessage: voiceError.message,
          traceId: msg.id,
          context: { conversationId, messageId: msg.id, stage: "transcribe" },
        });
        console.error("ai-respond transcription failed", {
          tenantId,
          conversationId,
          err: voiceError.message,
        });
        // Falha de transcrição NÃO pode virar "mensagem vazia" — o cliente
        // falou algo e ninguém ouviu. Vai pra fila humana com razão própria.
        return await handoffAndRelease("transcription_failed");
      }
    }

    // Keywords rodam sobre o texto EFETIVO: com áudio transcrito, um "quero
    // falar com um humano" falado dispara handoff igual ao digitado.
    const handoffReason = matchHandoffReason(effectiveContent, [
      ...stageHandoffKeywords,
      ...defaultKeywords,
    ]);

    if (handoffReason) {
      return await handoffAndRelease(handoffReason);
    }

    // -------------------- Prompt assembly + history (pipeline.ts) --------------------
    const systemPrompt = await buildSystemPrompt({
      admin,
      tenantId,
      contactId: contact.id,
      conversationId,
      dealId,
      tenantName: tenant.name,
      tenantBusinessProfile: tenant.business_profile,
      baseSystemPrompt: settings?.base_system_prompt ?? null,
      stagePrompt,
      currentMessageIsAudio: inboundWasAudio,
    });

    // Skip pending/failed to avoid replaying failures; janela por caracteres
    // aplicada dentro de loadRecentHistory (mantém as mais recentes até
    // HISTORY_MAX_CHARS — a mais recente entra sempre).
    const history = await loadRecentHistory(admin, conversationId, {
      historyLimit: HISTORY_LIMIT,
      historyMaxChars: HISTORY_MAX_CHARS,
    });

    // Generate reply.
    let aiText: string;
    try {
      requireAiResponseTime(budget, AI_GATEWAY_TIMEOUT_MS);
      aiText = await callLovableAI(systemPrompt, history, effectiveModel);
    } catch (e) {
      if (e instanceof AiResponseDeadlineError) throw e;
      // Contrato de erro tipado (errors.ts): normaliza qualquer erro de
      // provider num shape único, sem vazar segredo, gravado estruturado em
      // conversations.last_error (jsonb desde a migration desta fase) e
      // espelhado em ai_failure_logs para observabilidade.
      const aiError = sanitizeProviderError(e);
      // Falha da IA precisa ser acionável: joga a conversa na fila humana, não só grava o erro.
      // Enfileira ANTES de notificar: notificação só sai se o enfileiramento
      // foi mesmo gravado (ver enfileirarParaHumanoAposFalha).
      await enfileirarParaHumanoAposFalha(admin, {
        tenantId,
        conversationId,
        aiError,
        wasAwaitingHuman: conv.awaiting_human,
        messageId: msg.id,
      });
      await reportAIFailure(admin, {
        tenantId,
        route: "ai-respond",
        provider: aiError.provider ?? "lovable-gateway",
        model: effectiveModel,
        statusCode: aiError.statusCode ?? null,
        errorCode: aiError.code,
        errorMessage: aiError.message,
        traceId: msg.id,
        context: { conversationId, messageId: msg.id },
      });
      console.error("ai-respond generation failed", { tenantId, conversationId, err: aiError });
      await finishClaim("failed", "generation_failed");
      await releaseLock();
      return json(200, { ok: false, reason: "generation_failed", error: aiError.message });
    }

    // Cap de emojis (emoji-limiter.ts): enforced em código, aplicado ANTES de
    // qualquer outro processamento (handoff/draft/envio) — regra só no prompt
    // é ignorada por parte dos modelos.
    aiText = limitEmojis(aiText);

    // AI-declared handoff (does not know / off-scope).
    if (/\[TRANSFERIR_HUMANO\]/i.test(aiText)) {
      return await handoffAndRelease("ai_declared_unknown");
    }

    // Incerteza detectada na resposta gerada (uncertainty.ts) → mesmo handoff
    // automático do caminho acima, sem mandar mensagem extra ao lead.
    if (detectAssistantUncertainty(aiText)) {
      return await handoffAndRelease("ai_detected_uncertainty");
    }

    // -------------------- Persistência + envio final (pipeline.ts) --------------------
    // Relação to-one via FK: o supabase-js tipa como array, mas em runtime é objeto único.
    const providerSlug = conversationChannel?.provider_slug ?? "";
    const sendMode = settings?.send_mode === "draft" ? "draft" : "auto";

    // Resposta em áudio: preferência do tenant + formato do que chegou.
    // loadVoiceReplyPreference nunca lança (cai em "off" se a migration
    // 20260727120000 ainda não tiver sido aplicada), e a chave da ElevenLabs só
    // é buscada quando a preferência realmente pede áudio.
    const voicePref = await loadVoiceReplyPreference(admin, tenantId);
    let voice: { apiKey: string; voiceId: string; modelId: string | null } | null = null;
    if (shouldReplyWithAudio(voicePref, inboundWasAudio) && voicePref.voiceId) {
      // Mesmo motivo do try da transcrição: loadProviderSecrets lança em erro
      // de banco e ainda estamos dentro do lock, com o claim de
      // ai_processing_log (sem TTL nem delete) já gravado. Aqui a queda é ainda
      // mais barata que lá: áudio é enfeite opcional, texto é a resposta
      // obrigatória — deixar a exceção subir trocava "responde em texto" por
      // "não responde nunca mais". Mesma filosofia do loadVoiceReplyPreference.
      try {
        const cred = await loadProviderSecrets(admin, tenantId, "elevenlabs");
        const key = cred.api_key ?? "";
        if (key) {
          voice = { apiKey: key, voiceId: voicePref.voiceId, modelId: voicePref.modelId };
        } else {
          console.warn("ai-respond: modo de voz ligado sem api_key da ElevenLabs", {
            tenantId,
            conversationId,
            fallback: "texto",
          });
        }
      } catch (e) {
        console.error(
          "ai-respond: falha ao ler a credencial da ElevenLabs para responder em áudio",
          {
            tenantId,
            conversationId,
            fallback: "texto",
            err: e instanceof Error ? e.message : String(e),
          },
        );
      }
    }

    // finalizeAiReply grava a resposta (draft ou pending→despacho de envio) —
    // best-effort, nunca lança; avaliação de avanço de estágio só roda no
    // caminho "sent" (mesma condição do fluxo original: pulada em draft mode).
    const finalize = await finalizeAiReply({
      admin,
      tenantId,
      conversationId,
      contactId: contact.id,
      dealId,
      aiText,
      sendMode,
      maxResponseBlocks: settings?.max_response_blocks,
      responseBlockDelayMs: settings?.response_block_delay_ms,
      budget,
      providerSlug,
      contactPhone: contact.phone,
      contactEmail: contact.email,
      subject: conv.subject ?? null,
      previousAwaitingHuman: conv.awaiting_human,
      voice,
      // traceId = id da mensagem de ENTRADA: liga falha de envio, evento de
      // sistema e erro de frontend da mesma execução na visão de incidentes.
      traceId: msg.id,
    });

    if (finalize.kind === "insert_failed") {
      await finishClaim("failed", "insert_failed");
      await releaseLock();
      return json(200, { ok: false, reason: "insert_failed" });
    }
    if (finalize.kind === "draft") {
      await finishClaim("completed");
      await releaseLock();
      return json(200, { ok: true, id: finalize.id, draft: true, sent: false });
    }
    if (finalize.kind === "interrupted") {
      if (finalize.reason !== "takeover") await flagInterruptedReply(finalize.reason);
      await finishClaim("completed");
      await releaseLock();
      return json(200, {
        ok: true, id: finalize.id, sent: finalize.sent, interrupted: finalize.reason,
      });
    }

    // O claim fecha AQUI, assim que o envio está confirmado — antes do avanço
    // de estágio, não depois. Motivo: evaluateStageAdvancement faz uma SEGUNDA
    // chamada ao gateway e o turno inteiro corre contra o teto de 150 s do
    // isolate (SUPABASE_EDGE_REQUEST_IDLE_TIMEOUT_MS). Com o finishClaim no fim,
    // um turno que já enviou e estoura o teto durante a avaliação morre com o
    // claim aberto: a lease de 180 s (claimMessageOnce) expira, o job volta a
    // ser reivindicado e a MESMA resposta é enviada de novo — já fora da janela
    // de 30 s do coalescer, que por isso não deduplica.
    //
    // Fechar antes é seguro porque o avanço de estágio é best-effort: a própria
    // evaluateStageAdvancement engole os erros dela (pipeline.ts), então não há
    // desfecho em que valha a pena reprocessar a mensagem depois do envio.
    await finishClaim("completed");
    // A segunda chamada ao modelo é best-effort; não atrasa a confirmação
    // de uma mensagem já entregue quando o orçamento do turno está no fim.
    if (budget.now() + AI_GATEWAY_TIMEOUT_MS > budget.deadlineAt) {
      await releaseLock();
      return json(200, { ok: true, id: finalize.id, sent: finalize.sent });
    }

    await evaluateStageAdvancement({
      admin,
      tenantId,
      conversationId,
      dealId,
      dealStageId,
      stageAdvancement,
      stageGoal,
      effectiveModel,
      history,
      aiText,
      sourceEventId: body.message_id,
      triggerEvent: "message.sent",
      structuredSignals: {},
      promptSnapshot: {
        stage_goal: stageGoal,
        advancement_criteria: stageAdvancement,
      },
    });

    await releaseLock();
    return json(200, { ok: true, id: finalize.id, sent: finalize.sent });
  } catch (e) {
    if (e instanceof AiResponseDeadlineError) {
      if (conversationIdForTelemetry && tenantIdForTelemetry) {
        const { error } = await admin.from("conversations").update({
          awaiting_human: true,
          last_error: e.message,
        }).eq("id", conversationIdForTelemetry).eq("tenant_id", tenantIdForTelemetry)
          .eq("ai_active", true).eq("awaiting_human", false);
        if (error) console.error("ai-respond: falha ao sinalizar prazo esgotado", error.message);
      }
      if (finishActiveClaim) await finishActiveClaim("completed").catch(() => false);
      if (releaseActiveLock) await releaseActiveLock().catch(() => undefined);
      return json(200, { ok: true, sent: false, interrupted: "deadline_exceeded" });
    }
    if (releaseActiveLock) {
      await releaseActiveLock().catch(() => undefined);
    }
    if (finishActiveClaim) {
      await finishActiveClaim("failed", "handler_exception").catch(() => false);
    }
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "ai.respond.handler",
      tenantId: tenantIdForTelemetry,
      message: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? (e.stack ?? null) : null,
    });
    return json(500, { error: "Erro interno ao processar a mensagem." });
  }
});
