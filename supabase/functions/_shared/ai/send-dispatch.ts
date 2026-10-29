// send-dispatch.ts — bloco de persistência + envio externo da resposta da
// IA, extraído de pipeline.ts (que antes acumulava entidades, prompt,
// handoff, envio E avanço de estágio no mesmo arquivo). Este módulo
// concentra só "enviar": finalizeAiReply grava a mensagem e decide
// draft/auto, dispatchAiSend tenta o provider e grava o resultado. Cada um
// delega para um helper por seção (mesmo padrão de gates.ts) para caber no
// teto de 50L/função: persistDraft/persistAndDispatch (modo) e
// sendViaProvider/persistSendFailure/persistSendSuccess (envio).
//
// Import cross-diretório deliberado: send-adapters.ts mora em ai-respond/
// (é específico de auto-envio, não duplicado em outro lugar como errors.ts)
// mas os adaptadores em si não têm nada de específico de índice — trazê-los
// para cá evita duplicar ~150 linhas de HTTP por provider.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { loadSecrets, NET_ERR, type SendResult } from "./send-adapters.ts";
import {
  isSupportedProviderSlug,
  providerSupportsAudio,
  sendAudioViaProvider,
  sendViaProvider as sendViaProviderCanonical,
} from "../messaging/provider-send.ts";

import { sanitizeProviderError } from "./errors.ts";
import {
  AI_SEND_OPERATION_BUDGET_MS,
  AI_TTS_TOTAL_BUDGET_MS,
  AiResponseDeadlineError,
  limitAiResponseWait,
  requireAiResponseTime,
  type AiResponseBudget,
} from "./execution-budget.ts";
import { reportAIFailure } from "./failure-log.ts";
import { generateConversationSummary } from "./memory-summary.ts";
import { notifyAdminHandoff } from "./notify-admin-handoff.ts";
import { synthesizeSpeech, VoiceError } from "./voice.ts";
import { redactSecrets } from "../redact-secrets.ts";
import { resolveProviderDestination } from "../messaging/contact-identity.ts";

// Mantém trabalho em background vivo depois da resposta já ter sido enviada
// ao caller. No Supabase Edge (Deno Deploy) o isolate pode ser reciclado
// assim que o handler responde, derrubando uma promise não aguardada;
// EdgeRuntime.waitUntil adia o recycle até ela resolver. Fora da plataforma
// (dev local, testes) cai em fire-and-forget simples. Mesmo padrão já usado
// em messaging-webhook/index.ts (runInBackground) — duplicado aqui por ser
// um helper de poucas linhas sem dependências, mesma decisão de
// clientes/pedro/medflow-v0/lib/ai/errors.ts (ver header de errors.ts).
function runInBackground(promise: Promise<unknown>): void {
  const edge = (
    globalThis as {
      EdgeRuntime?: { waitUntil(p: Promise<unknown>): void };
    }
  ).EdgeRuntime;
  if (edge) {
    edge.waitUntil(promise);
  } else {
    void promise;
  }
}

// Um UPDATE desta lane + a checagem do erro que o supabase-js NÃO lança
// (H7-H9 de docs/code-review/05-silent-failures.md): `{ data, error }` sem
// destructure é indistinguível de sucesso, então uma mensagem já entregue ao
// cliente fica "pending" no CRM e o handoff que traria o humano nunca aparece
// na conversa. Erro aqui vira console.error + ai_failure_logs (mesmo sink de
// reportAIFailure já usado no resto do módulo) e NUNCA lança: o envio externo
// já aconteceu e não há como desfazê-lo.
async function patchOrReport(
  admin: SupabaseClient,
  params: {
    table: "messages" | "conversations";
    id: string;
    patch: Record<string, unknown>;
    step: string;
    tenantId: string;
    conversationId: string;
    context?: Record<string, unknown>;
    onlyWhileAiActive?: boolean;
  },
): Promise<void> {
  const { table, id, patch, step, tenantId, conversationId, context } = params;
  let query = admin.from(table).update(patch).eq("id", id);
  if (params.onlyWhileAiActive) {
    query = query.eq("tenant_id", tenantId).eq("ai_active", true).eq("awaiting_human", false);
  }
  const { error } = await query;
  if (!error) return;
  const detail = redactSecrets(error.message);
  console.error("ai-respond persist falhou", {
    table,
    step,
    tenantId,
    conversationId,
    ...context,
    error: detail,
  });
  await reportAIFailure(admin, {
    tenantId,
    route: "ai-respond",
    // errorCode fica em UNKNOWN de propósito: ai_failure_logs.error_code é
    // "mesmo enum AiErrorCode" (migration 20260709110000) e a UI mapeia esse
    // conjunto fechado — quem identifica a falha de persistência é o context.
    errorCode: "UNKNOWN",
    errorMessage: `Falha ao gravar ${table} (${step}): ${detail}`,
    context: { conversationId, phase: "persist", table, step, ...context },
  });
}

// -------------------- Persistência + envio final --------------------

/**
 * Voz resolvida para ESTA resposta. `null` = responder em texto. Quem decide
 * (modo do tenant + se a mensagem recebida era áudio) é o ai-respond, via
 * shouldReplyWithAudio; aqui só se executa.
 */
export interface VoiceReplyConfig {
  apiKey: string;
  voiceId: string;
  /** Modelo TTS do tenant; `null` usa o default da ElevenLabs configurado no módulo. */
  modelId?: string | null;
}

export interface FinalizeAiReplyParams {
  admin: SupabaseClient;
  tenantId: string;
  conversationId: string;
  contactId: string;
  dealId: string | null;
  aiText: string;
  sendMode: "draft" | "auto";
  providerSlug: string;
  contactPhone: unknown;
  contactEmail: unknown;
  subject: string | null;
  // Valor de conversations.awaiting_human lido pelo caller ANTES desta
  // chamada (já disponível via gates.ts/runGates — nunca uma query extra).
  // Usado só para decidir se notifyAdminHandoff dispara nas transições
  // false→true abaixo (persistDraft/persistAndDispatch/dispatchAiSend), A3:
  // alerta imediato de handoff — mesmo contrato de PerformHandoffParams em
  // pipeline.ts.
  previousAwaitingHuman: boolean;
  voice?: VoiceReplyConfig | null;
  /** Id da mensagem de entrada que originou a execução — ver failure-log.ts. */
  traceId?: string | null;
  /** Máximo de blocos por resposta (1-5). Default: 1 (runtime atual). */
  maxResponseBlocks?: number | null;
  /** Intervalo em ms entre blocos (0-10000). Default: 1200 (runtime atual). */
  responseBlockDelayMs?: number | null;
  /** Espera injetável para testar a cadência sem relógio real. */
  sleep?: (ms: number) => Promise<void>;
  budget?: AiResponseBudget;
}

export type FinalizeAiReplyResult =
  | { kind: "draft"; id: string }
  | { kind: "insert_failed" }
  | { kind: "sent"; id: string; sent: boolean }
  | {
    kind: "interrupted";
    id: string | null;
    sent: boolean;
    reason: "takeover" | "state_unavailable" | "deadline_exceeded";
  };

// -------------------- Modo draft --------------------
// Grava com status "draft" e marca a conversa awaiting_human (aguarda
// aprovação humana), sem tentar envio.
const VOICE_DRAFT_DISCARDED =
  "Resposta em áudio pedida, mas o modo rascunho não gera áudio: o texto foi para aprovação humana.";

async function persistDraft(params: FinalizeAiReplyParams): Promise<FinalizeAiReplyResult> {
  const { admin, tenantId, conversationId, aiText, previousAwaitingHuman, providerSlug, voice } =
    params;
  const { data: draftMsg, error: draftErr } = await admin
    .from("messages")
    .insert({
      tenant_id: tenantId,
      conversation_id: conversationId,
      sender: "ai",
      direction: "out",
      content: aiText,
      status: "draft",
    })
    .select("id")
    .single();
  if (draftErr || !draftMsg) {
    // Cascata (H9): o insert já falhou; se este UPDATE também falhar, a
    // conversa fica sem flag de atenção e sem last_error — checado.
    await patchOrReport(admin, {
      table: "conversations",
      id: conversationId,
      patch: { last_error: "Falha ao gravar o rascunho da IA.", awaiting_human: true },
      step: "rascunho não gravado",
      tenantId,
      conversationId,
    });
    // Só notifica na transição false→true (A3) — previousAwaitingHuman é o
    // valor que o caller já tinha em mãos ANTES desta chamada, nunca uma
    // query extra. notifyAdminHandoff nunca lança.
    if (!previousAwaitingHuman) {
      await notifyAdminHandoff(admin, tenantId, conversationId, "persist_failed");
    }
    return { kind: "insert_failed" };
  }
  await patchOrReport(admin, {
    table: "conversations",
    id: conversationId,
    patch: { awaiting_human: true, last_error: null },
    step: "rascunho aguardando aprovação",
    tenantId,
    conversationId,
    context: { aiMessageId: draftMsg.id },
  });
  console.log("ai-respond draft created", { tenantId, conversationId, messageId: draftMsg.id });
  // Draft não sintetiza áudio: quem aprova despacha o texto. Era o único dos
  // quatro caminhos de queda de voz sem linha em ai_failure_logs — o pedido
  // sumia sem rastro (audio_status fica no default not_requested e nada em
  // `messages` distingue rascunho de voz de rascunho de texto). Só registra a
  // perda; gerar áudio em draft é outra decisão.
  if (voice) {
    await reportVoiceFallback(
      admin,
      tenantId,
      conversationId,
      providerSlug,
      "modo_rascunho",
      VOICE_DRAFT_DISCARDED,
    );
  }
  // Modo draft É a espera por aprovação humana — dispara sempre que a
  // conversa ainda não estava aguardando humano (A3: alerta imediato).
  if (!previousAwaitingHuman) {
    await notifyAdminHandoff(admin, tenantId, conversationId, "draft_pending_approval");
  }
  return { kind: "draft", id: draftMsg.id as string };
}

// -------------------- Modo auto: pending + dispatch --------------------
// Grava como "pending" (bolha aparece já no thread) e então despacha via
// dispatchAiSend, que atualiza o status final (sent/failed).
/**
 * Teto de bolhas por resposta. **1 de propósito.**
 *
 * O medflow implementou a fragmentação (`splitForHumanCadence`) e depois a
 * desligou: análise comparativa com secretária humana real, em 3 conversas
 * (2026-05-19), mostrou 1 mensagem densa por turno — fragmentar é ANTIPADRÃO.
 * Adotamos a mesma conclusão em 2026-08-04, com o código de quebra preservado
 * para que subir este número volte atrás sem reescrever nada.
 */
const MAX_BUBBLES = 1;
/** Abaixo disso não vale quebrar: bolha de 2 palavras parece erro, não pessoa. */
const MIN_BUBBLE_CHARS = 25;
/** Pausa entre bolhas. Sai do orçamento do lock (AI_RESPONSE_LOCK_TTL_MS). */
const BUBBLE_DELAY_MS = 1_200;

/**
 * Quebra a resposta da IA em bolhas, como uma pessoa digitando.
 *
 * O modelo devolve um bloco só com parágrafos separados por linha em branco, e
 * era assim que chegava no WhatsApp: 240-330 caracteres num balão único, coisa
 * que ninguém escreve à mão. O corte é no parágrafo — `\n` solto dentro de um
 * parágrafo é lista ou continuação e NÃO vira bolha.
 *
 * Pura de propósito: a regra de quebra é o que precisa de teste, e ela não
 * depende de banco, provider nem relógio.
 */
export function splitIntoBubbles(text: string, maxBlocks = MAX_BUBBLES): string[] {
  const partes = String(text ?? "")
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (partes.length <= 1) return partes.length === 1 ? partes : [];

  // Junta pedaço curto no anterior: "Faz sentido?" sozinho parece mensagem
  // cortada pela metade.
  const juntadas: string[] = [];
  for (const parte of partes) {
    const anterior = juntadas[juntadas.length - 1];
    if (
      anterior !== undefined &&
      (parte.length < MIN_BUBBLE_CHARS || anterior.length < MIN_BUBBLE_CHARS)
    ) {
      juntadas[juntadas.length - 1] = `${anterior}\n\n${parte}`;
    } else {
      juntadas.push(parte);
    }
  }

  // Excedente do teto volta para a última bolha, em vez de sumir. A cola é
  // ESPAÇO, não linha em branco: juntar com "\n\n" devolveria exatamente o
  // balão formatado como documento que esta função existe para eliminar.
  if (juntadas.length > maxBlocks) {
    const resto = juntadas.splice(maxBlocks - 1);
    juntadas.push(resto.join(" "));
  }
  // Invariante de saída: NENHUMA bolha carrega linha em branco. A fusão acima
  // usa "\n\n" como cola, então sem esta normalização o próprio merge de
  // pedaço curto devolveria o balão formatado como documento — foi o bug que
  // o teste pegou. `\n` SOLTO sobrevive: lista e continuação são formatação
  // legítima que o lead lê bem; o que não passa é o parágrafo separado.
  return juntadas
    .map((b) => b.replace(/\n\s*\n+/g, " ").replace(/[ \t]+/g, " ").trim())
    .filter((b) => b.length > 0);
}

class AiSendInterruptedError extends Error {
  constructor(readonly reason: "takeover" | "state_unavailable") {
    super(reason === "takeover"
      ? "Envio interrompido porque a IA foi pausada ou o atendimento foi assumido."
      : "Envio interrompido porque não foi possível confirmar o estado da conversa.");
    this.name = "AiSendInterruptedError";
  }
}

async function assertAiSendAllowed(params: FinalizeAiReplyParams): Promise<void> {
  const [conversation, contact] = await Promise.all([
    params.admin.from("conversations").select("ai_active, awaiting_human")
      .eq("id", params.conversationId).eq("tenant_id", params.tenantId).maybeSingle(),
    params.admin.from("contacts").select("ai_paused")
      .eq("id", params.contactId).eq("tenant_id", params.tenantId).maybeSingle(),
  ]);
  if (conversation.error || contact.error || !conversation.data || !contact.data) {
    throw new AiSendInterruptedError("state_unavailable");
  }
  if (!conversation.data.ai_active || conversation.data.awaiting_human || contact.data.ai_paused) {
    throw new AiSendInterruptedError("takeover");
  }
  requireAiResponseTime(params.budget, AI_SEND_OPERATION_BUDGET_MS);
}

async function persistAndDispatch(params: FinalizeAiReplyParams): Promise<FinalizeAiReplyResult> {
  const { aiText, voice } = params;
  const maxResponseBlocks = params.maxResponseBlocks ?? MAX_BUBBLES;
  const responseBlockDelayMs = params.responseBlockDelayMs ?? BUBBLE_DELAY_MS;
  const sleep = params.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // A condensação vale SEMPRE, inclusive com voz. A versão anterior fazia
  // `voice ? [aiText] : split(...)` e pulava a limpeza inteira quando havia
  // pedido de áudio — em produção (2026-08-04) o TTS falhou, o texto caiu como
  // fallback e saiu cru, com as linhas em branco que a condensação existe para
  // tirar. O `audio_status: failed` daquela mensagem foi a evidência.
  //
  // O que a voz muda é só NUNCA picotar: o áudio é um arquivo só, da resposta
  // inteira. Por isso junta as partes em vez de descartá-las — com
  // MAX_BUBBLES=1 isso já é o caso, e continua correto se o teto subir.
  const partes = splitIntoBubbles(aiText, maxResponseBlocks);
  const bolhas = voice && partes.length > 1 ? [partes.join(" ")] : partes;
  let primeiroId: string | null = null;
  let ultimoEnvio = false;

  for (const [indice, bolha] of bolhas.entries()) {
    let resultado: FinalizeAiReplyResult;
    try {
      const reservedMs = AI_SEND_OPERATION_BUDGET_MS + (voice ? AI_TTS_TOTAL_BUDGET_MS : 0);
      requireAiResponseTime(params.budget, reservedMs);
      const delay = indice > 0
        ? limitAiResponseWait(responseBlockDelayMs, params.budget, reservedMs)
        : 0;
      if (delay > 0) await sleep(delay);
      await assertAiSendAllowed(params);
      resultado = await persistAndDispatchOne({ ...params, aiText: bolha });
    } catch (error) {
      if (!(error instanceof AiSendInterruptedError) && !(error instanceof AiResponseDeadlineError)) {
        throw error;
      }
      return {
        kind: "interrupted", id: primeiroId, sent: ultimoEnvio,
        reason: error instanceof AiResponseDeadlineError ? "deadline_exceeded" : error.reason,
      };
    }
    if (resultado.kind === "interrupted") {
      return { ...resultado, id: primeiroId ?? resultado.id, sent: ultimoEnvio };
    }
    if (resultado.kind === "insert_failed") {
      // Primeira bolha falhou: nada saiu, propaga como antes. Bolha do meio
      // falhando é outra coisa — o lead já recebeu o começo, e abortar calado
      // seria pior que entregar a resposta pela metade com rastro.
      if (indice === 0) return resultado;
      break;
    }
    if (resultado.kind !== "sent") break;
    primeiroId ??= resultado.id;
    ultimoEnvio = resultado.sent;
    if (!resultado.sent) break;
  }
  return { kind: "sent", id: primeiroId as string, sent: ultimoEnvio };
}

/** Uma bolha: grava a mensagem e despacha. Era o corpo de persistAndDispatch. */
async function persistAndDispatchOne(
  params: FinalizeAiReplyParams,
): Promise<FinalizeAiReplyResult> {
  const {
    admin,
    tenantId,
    conversationId,
    contactId,
    dealId,
    aiText,
    providerSlug,
    contactPhone,
    contactEmail,
    subject,
    previousAwaitingHuman,
    voice,
    traceId,
  } = params;
  // Insert AI message as pending so the thread shows the bubble immediately.
  const { data: inserted, error: insErr } = await admin
    .from("messages")
    .insert({
      tenant_id: tenantId,
      conversation_id: conversationId,
      sender: "ai",
      direction: "out",
      content: aiText,
      status: "pending",
      audio_status: voice ? "awaiting_generation" : "not_requested",
    })
    .select("id")
    .single();
  if (insErr || !inserted) {
    // Cascata (H9): mesmo tratamento de persistDraft — sem esta checagem,
    // banco instável derruba insert E update e ninguém é acionado.
    await patchOrReport(admin, {
      table: "conversations",
      id: conversationId,
      patch: { last_error: "Falha ao gravar a resposta da IA.", awaiting_human: true },
      step: "resposta não gravada",
      tenantId,
      conversationId,
    });
    // Só notifica na transição false→true (A3) — mesmo contrato de
    // persistDraft acima.
    if (!previousAwaitingHuman) {
      await notifyAdminHandoff(admin, tenantId, conversationId, "persist_failed");
    }
    return { kind: "insert_failed" };
  }
  const aiMessageId = inserted.id as string;
  try {
    const sendOk = await dispatchAiSend({
      admin,
      tenantId,
      conversationId,
      contactId,
      dealId,
      aiMessageId,
      aiText,
      providerSlug,
      contactPhone,
      contactEmail,
      subject,
      previousAwaitingHuman,
      voice,
      traceId: traceId ?? null,
      budget: params.budget,
      beforeSend: () => assertAiSendAllowed(params),
    });
    return { kind: "sent", id: aiMessageId, sent: sendOk };
  } catch (error) {
    if (!(error instanceof AiSendInterruptedError) && !(error instanceof AiResponseDeadlineError)) {
      throw error;
    }
    await patchOrReport(admin, {
      table: "messages", id: aiMessageId, tenantId, conversationId,
      patch: { status: "failed", send_error: error.message },
      step: "envio interrompido",
    });
    return {
      kind: "interrupted", id: aiMessageId, sent: false,
      reason: error instanceof AiResponseDeadlineError ? "deadline_exceeded" : error.reason,
    };
  }
}

/**
 * Persiste a resposta final da IA e, fora do modo rascunho, despacha o envio
 * externo (dispatchAiSend). Delega para persistDraft (modo draft) ou
 * persistAndDispatch (modo auto) — ver cada uma acima.
 *
 * Nunca lança: falha ao gravar a mensagem grava last_error/awaiting_human na
 * conversa e devolve {kind: "insert_failed"} — o caller decide a resposta
 * HTTP a partir do FinalizeAiReplyResult.
 */
/** Tokens úteis para comparar duas perguntas: sem acento, sem palavra curta. */
function tokensDaPergunta(frase: string): Set<string> {
  return new Set(
    frase
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 4),
  );
}

/** Última frase interrogativa do texto, ou null se não houver. */
export function extrairUltimaPergunta(texto: string): string | null {
  const frases = texto.match(/[^.!?]+\?/g);
  return frases?.length ? frases[frases.length - 1].trim() : null;
}

/**
 * Remove a pergunta final quando ela repete uma pergunta que a IA já fez nesta
 * conversa.
 *
 * Isto existe porque INSTRUÇÃO DE PROMPT NÃO SEGUROU. A PR #172 pôs em
 * `cadenceRules` um "NUNCA repita uma pergunta que você já fez nesta conversa"
 * e, em produção, 3 de 3 respostas seguidas terminaram com a MESMA frase
 * ("qual seu faturamento atual e a meta para os próximos 6 meses?") — com o
 * histórico carregado e visível para o modelo. O `base_system_prompt` do
 * tenant manda fazer a pergunta-chave e vem antes no join; "não repita" compete
 * com "pergunte" e perde.
 *
 * Mesmo padrão de `splitIntoBubbles`: o prompt pede, o código garante.
 *
 * Comparação por sobreposição de tokens (≥ 60%), não por igualdade: o modelo
 * varia a redação da mesma pergunta entre turnos.
 */
export function dropRepeatedQuestion(aiText: string, perguntasAnteriores: readonly string[]): string {
  const pergunta = extrairUltimaPergunta(aiText);
  if (!pergunta) return aiText;

  const atual = tokensDaPergunta(pergunta);
  if (atual.size < 3) return aiText;

  for (const anterior of perguntasAnteriores) {
    const antes = tokensDaPergunta(anterior);
    if (antes.size === 0) continue;
    let comuns = 0;
    for (const t of atual) if (antes.has(t)) comuns++;
    if (comuns / atual.size >= 0.6) {
      // Corta a frase repetida e o espaço/pontuação pendurados antes dela.
      const semPergunta = aiText.slice(0, aiText.lastIndexOf(pergunta)).trimEnd();
      // Nunca devolver vazio: se a resposta era SÓ a pergunta, ela fica.
      return semPergunta.length > 0 ? semPergunta : aiText;
    }
  }
  return aiText;
}

/**
 * Alterna quem faz pergunta, como duas pessoas conversando.
 *
 * A secretária humana real do medflow (322 mensagens) faz **0,62 pergunta por
 * mensagem** — mais de um terço das mensagens dela não devolve pergunta
 * nenhuma. A IA vinha em ~1,0: toda resposta terminava com interrogação, o que
 * obriga o lead a responder a cada turno e soa interrogatório, não
 * atendimento.
 *
 * Mesma forma do `capEmoji` e pelo mesmo motivo: a `#172` já pedia isso no
 * prompt ("nem toda mensagem precisa de uma") e o modelo não cumpre
 * frequência. Se a resposta ANTERIOR da IA terminou perguntando, esta sai sem
 * pergunta — a alternância cai perto dos 0,5 do humano.
 *
 * Roda DEPOIS de `dropRepeatedQuestion`: aquela tira a pergunta repetida, esta
 * tira a pergunta nova quando não é a vez dela. Nenhuma das duas encosta em
 * afirmação factual.
 */
/** Fonte de aleatoriedade injetável — o default é `Math.random`, o teste passa a sua. */
export type Rng = () => number;

/**
 * Probabilidade desta mensagem carregar o traço, corrigida pelo desvio recente.
 *
 * A primeira versão destes filtros alternava: se a anterior tinha, esta não
 * tinha. Alternância acerta a MÉDIA e erra o que importa — `0,1,0,1,0,1` é tão
 * reconhecível quanto `1,1,1,1`. Humano nenhum alterna; ele varia em torno de
 * uma taxa.
 *
 * Aqui a decisão é uma moeda enviesada: se a taxa observada nas últimas
 * mensagens está acima do alvo, a probabilidade cai; se está abaixo, sobe. A
 * série resultante é irregular (1,1,0,1,0,0,0,1) e ainda assim converge para o
 * alvo ao longo da conversa.
 *
 * O clamp em [0,15 · 0,85] é o ponto central: sem ele, uma sequência ruim
 * levaria a probabilidade a 0 ou 1 e o comportamento voltaria a ser
 * determinístico — exatamente o que esta função existe para evitar. Nenhuma
 * mensagem é previsível a partir da anterior.
 */
export function probabilidadeCorrigida(
  historico: readonly boolean[],
  alvo: number,
  min = 0.15,
  max = 0.85,
): number {
  if (historico.length === 0) return alvo;
  const observada = historico.filter(Boolean).length / historico.length;
  return Math.min(max, Math.max(min, alvo + (alvo - observada)));
}

/** Quantas das últimas respostas entram no cálculo da taxa. */
const JANELA_CADENCIA = 6;

/** Alvo medido em 322 mensagens de secretária humana real (base do medflow). */
const ALVO_PERGUNTA = 0.62;
const ALVO_EMOJI = 0.5;

/**
 * Deixa a resposta terminar em pergunta só às vezes.
 *
 * O humano real faz **0,62 pergunta por mensagem** — mais de um terço das
 * mensagens dele não devolve pergunta nenhuma. A IA vinha em ~1,0, o que soa
 * interrogatório.
 *
 * Só corta interrogação que está NO FIM: pergunta no meio faz parte da frase e
 * não é convite de turno. Nunca esvazia a resposta.
 */
export function dropTrailingQuestion(
  aiText: string,
  respostasAnteriores: readonly string[],
  rng: Rng = Math.random,
): string {
  if (!aiText.trimEnd().endsWith("?")) return aiText;
  const historico = respostasAnteriores
    .slice(0, JANELA_CADENCIA)
    .map((r) => r.trimEnd().endsWith("?"));
  if (rng() < probabilidadeCorrigida(historico, ALVO_PERGUNTA)) return aiText;

  const pergunta = extrairUltimaPergunta(aiText);
  if (pergunta === null) return aiText;
  const semPergunta = aiText.slice(0, aiText.lastIndexOf(pergunta)).trimEnd();
  // Nunca devolver vazio: se a resposta era só a pergunta, ela fica.
  return semPergunta.length > 0 ? semPergunta : aiText;
}

const EMOJI = /\p{Extended_Pictographic}\p{Emoji_Modifier}?️?/gu;

/** Quantos emojis o texto tem. */
export function contarEmojis(texto: string): number {
  return (texto.match(EMOJI) ?? []).length;
}

/**
 * Aplica ao emoji a cadência medida em humano real, e não uma regra de estilo.
 *
 * A base do medflow (322 mensagens de uma secretária real, 2026-08-04) mostra
 * emoji em **50%** das mensagens. A IA vinha usando em **100%** — e a `#172`
 * tentou corrigir por prompt ("se a sua mensagem anterior tem emoji, esta não
 * leva"). Medido em produção depois do deploy: 12 de 12 respostas com emoji, 4
 * delas com dois. Instrução de frequência é justamente o que um modelo sem
 * estado não consegue cumprir.
 *
 * A primeira versão alternava (se a anterior tinha, esta não tinha). Acertava a
 * média e errava o que importa: `0,1,0,1` é tão reconhecível quanto `1,1,1,1` —
 * dá para prever a próxima mensagem olhando a anterior, que é assinatura de
 * bot. Agora a decisão é a moeda enviesada de `probabilidadeCorrigida`: a série
 * fica irregular e mesmo assim converge para os ~50% do humano.
 */
export function capEmoji(
  aiText: string,
  respostasAnteriores: readonly string[],
  rng: Rng = Math.random,
): string {
  const historico = respostasAnteriores
    .slice(0, JANELA_CADENCIA)
    .map((r) => contarEmojis(r) > 0);
  // Teto de UM continua absoluto: duas carinhas na mesma mensagem não é
  // variação de estilo, é excesso — o humano real não faz em nenhuma.
  const limite = rng() < probabilidadeCorrigida(historico, ALVO_EMOJI) ? 1 : 0;
  let mantidos = 0;
  const semExcesso = aiText.replace(EMOJI, (m) => (++mantidos <= limite ? m : ""));
  // Remover emoji deixa espaço duplo e espaço antes de pontuação.
  return semExcesso
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,!?;:])/g, "$1")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

/**
 * Últimas respostas da IA nesta conversa, da mais recente para a mais antiga.
 *
 * Uma query só serve os dois filtros (pergunta repetida e cadência de emoji) —
 * duas queries no caminho de envio de toda mensagem seria desperdício.
 */
async function carregarRespostasAnteriores(
  admin: SupabaseClient,
  tenantId: string,
  conversationId: string,
): Promise<string[]> {
  const { data, error } = await admin
    .from("messages")
    .select("content")
    .eq("tenant_id", tenantId)
    .eq("conversation_id", conversationId)
    .eq("sender", "ai")
    .order("created_at", { ascending: false })
    .limit(12);
  // Best-effort: sem histórico a resposta sai como o modelo escreveu, que é o
  // comportamento anterior a este fix — nunca derrubar o envio por causa disto.
  if (error || !data) return [];
  return data.map((m) => String(m.content ?? ""));
}

export async function finalizeAiReply(
  params: FinalizeAiReplyParams,
): Promise<FinalizeAiReplyResult> {
  // Rascunho e áudio continuam inteiros. No envio automático em texto,
  // preserva os limites dos blocos até persistAndDispatch.
  const maxBlocks = params.sendMode === "auto" && !params.voice
    ? params.maxResponseBlocks ?? MAX_BUBBLES
    : MAX_BUBBLES;
  const condensado = splitIntoBubbles(params.aiText, maxBlocks).join("\n\n");
  // Uma leitura do histórico serve os dois filtros de cadência abaixo.
  const anteriores = await carregarRespostasAnteriores(
    params.admin,
    params.tenantId,
    params.conversationId,
  );
  const semRepeticao = dropRepeatedQuestion(
    condensado || params.aiText,
    anteriores.map(extrairUltimaPergunta).filter((p): p is string => p !== null),
  );
  // Ordem importa: repetida (perda zero) → nova fora de vez → emoji.
  const semPerguntaForaDeVez = dropTrailingQuestion(semRepeticao, anteriores);
  const normalizado = { ...params, aiText: capEmoji(semPerguntaForaDeVez, anteriores) };
  return normalizado.sendMode === "draft"
    ? persistDraft(normalizado)
    : persistAndDispatch(normalizado);
}

export interface DispatchAiSendParams {
  admin: SupabaseClient;
  tenantId: string;
  conversationId: string;
  contactId: string;
  dealId: string | null;
  aiMessageId: string;
  aiText: string;
  providerSlug: string;
  contactPhone: unknown;
  contactEmail: unknown;
  subject: string | null;
  // Ver FinalizeAiReplyParams.previousAwaitingHuman — thread até
  // persistSendFailure (via o closure failSend, mais abaixo).
  previousAwaitingHuman: boolean;
  voice?: VoiceReplyConfig | null;
  /** Id da mensagem de entrada que originou a execução — ver failure-log.ts. */
  traceId?: string | null;
  budget?: AiResponseBudget;
  beforeSend?: () => Promise<void>;
}

interface SendViaProviderParams {
  admin: SupabaseClient;
  /** Correlação obrigatória: sem isto o log de fallback de voz é inútil num app multi-tenant. */
  tenantId: string;
  conversationId: string;
  aiMessageId: string;
  providerSlug: string;
  cred: Record<string, string>;
  aiText: string;
  contactPhone: unknown;
  contactEmail: unknown;
  /** Destino por identidade (ManyChat: subscriber_id). Ver resolveProviderDestination. */
  destination?: string;
  subject: string | null;
  voice?: VoiceReplyConfig | null;
  budget?: AiResponseBudget;
  beforeSend?: () => Promise<void>;
}

// -------------------- Seleção de provider + envio --------------------
// Delegado ao dispatcher canônico de _shared/messaging/provider-send.ts —
// o mesmo usado pelo envio manual (messaging-send). Antes existia um
// if/else paralelo aqui que só cobria zapi/twilio/meta-cloud/resend, então
// canais como zappaz/evolution falhavam com "canal não suportado" apenas no
// caminho automático da IA. Aqui fica só o que é específico da IA: o
// assunto "Re: ..." do e-mail.
/**
 * Registra a queda de áudio -> texto COM correlação.
 *
 * Os três motivos de fallback eram console-only e sem tenantId/conversationId:
 * num app multi-tenant, nem com o log em mãos dava para dizer qual tenant ou
 * conversa caiu — e nada em `messages` distingue resposta em áudio de texto,
 * então também não havia auditoria post-hoc. `patchOrReport`, neste mesmo
 * arquivo, já fazia console.error + reportAIFailure; o caminho de voz tinha
 * metade da convenção. O sink de ai_failure_logs é lido pela tela IA/Falhas.
 */
async function reportVoiceFallback(
  admin: SupabaseClient,
  tenantId: string,
  conversationId: string,
  providerSlug: string,
  reason: string,
  detail: string,
): Promise<void> {
  console.error("ai-respond: resposta em audio caiu para texto", {
    tenantId,
    conversationId,
    providerSlug,
    reason,
    detail,
    fallback: "texto",
  });
  await reportAIFailure(admin, {
    tenantId,
    route: "ai-respond",
    provider: providerSlug,
    errorCode: "UNKNOWN",
    errorMessage: detail,
    context: { phase: "voice_fallback", reason, conversationId, providerSlug },
  });
}

function canRetrySynthesis(error: unknown): boolean {
  if (!(error instanceof VoiceError) || error.stage !== "synthesize") return false;
  const statusCode = error.statusCode;
  return statusCode !== null &&
    (statusCode === 408 || statusCode === 429 || (statusCode >= 500 && statusCode <= 599));
}

const TTS_RETRY_BACKOFF_MS = 250;

async function synthesizeWithRetry(
  admin: SupabaseClient,
  params: {
    tenantId: string;
    conversationId: string;
    aiMessageId: string;
    apiKey: string;
    voiceId: string;
    modelId?: string | null;
    text: string;
    budget?: AiResponseBudget;
  },
): Promise<{ bytes: ArrayBuffer; mime: string; attempts: number }> {
  const { tenantId, conversationId, aiMessageId, apiKey, voiceId, modelId, text } = params;
  const now = params.budget?.now ?? Date.now;
  const startedAt = now();
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    await patchOrReport(admin, {
      table: "messages",
      id: aiMessageId,
      patch: { audio_status: "generating", audio_attempts: attempt, audio_error: null },
      step: "geração de áudio",
      tenantId,
      conversationId,
      context: { aiMessageId, attempt },
    });
    try {
      requireAiResponseTime(params.budget, AI_SEND_OPERATION_BUDGET_MS + 1);
      const remainingMs = limitAiResponseWait(
        AI_TTS_TOTAL_BUDGET_MS - (now() - startedAt),
        params.budget,
        AI_SEND_OPERATION_BUDGET_MS,
      );
      if (remainingMs <= 0) throw lastError ?? new Error("Orçamento de síntese esgotado.");
      return {
        ...(await synthesizeSpeech(apiKey, voiceId, text, {
          timeoutMs: remainingMs,
          modelId: modelId ?? undefined,
        })),
        attempts: attempt,
      };
    } catch (error) {
      lastError = error;
      if (attempt === 2 || !canRetrySynthesis(error)) throw error;
      const remainingMs = limitAiResponseWait(
        AI_TTS_TOTAL_BUDGET_MS - (now() - startedAt),
        params.budget,
        AI_SEND_OPERATION_BUDGET_MS,
      );
      if (remainingMs <= TTS_RETRY_BACKOFF_MS) throw error;
      await new Promise((resolve) => setTimeout(resolve, TTS_RETRY_BACKOFF_MS));
    }
  }
  throw lastError;
}

/**
 * Link assinado (10 min) do áudio no bucket privado `ai-audio`. Usado pelos
 * provedores que buscam a mídia por URL em vez de receber os bytes.
 * Nunca lança: sem link, o caller usa o caminho embutido.
 */
async function createAudioSignedUrl(
  admin: SupabaseClient,
  storagePath: string,
): Promise<string | null> {
  try {
    const { data, error } = await admin.storage
      .from("ai-audio")
      .createSignedUrl(storagePath, 600);
    if (error) {
      console.error("[send-dispatch] falha ao assinar áudio:", redactSecrets(error.message));
      return null;
    }
    return data?.signedUrl ?? null;
  } catch (err) {
    console.error("[send-dispatch] erro inesperado ao assinar áudio:", err);
    return null;
  }
}

async function persistGeneratedAudio(

  admin: SupabaseClient,
  params: {
    tenantId: string;
    conversationId: string;
    aiMessageId: string;
    audio: { bytes: ArrayBuffer; mime: string; attempts: number };
  },
): Promise<string> {
  const { tenantId, conversationId, aiMessageId, audio } = params;
  const storagePath = `${tenantId}/${conversationId}/${aiMessageId}.mp3`;
  const { error } = await admin.storage
    .from("ai-audio")
    .upload(storagePath, new Uint8Array(audio.bytes), {
      contentType: audio.mime,
      upsert: true,
    });
  if (error) {
    throw new VoiceError(`Falha ao armazenar áudio: ${redactSecrets(error.message)}`, "synthesize");
  }

  await patchOrReport(admin, {
    table: "messages",
    id: aiMessageId,
    patch: {
      audio_status: "generated",
      audio_storage_path: storagePath,
      audio_bytes: audio.bytes.byteLength,
      audio_attempts: audio.attempts,
      audio_error: null,
      audio_generated_at: new Date().toISOString(),
      media_type: audio.mime,
    },
    step: "áudio gerado",
    tenantId,
    conversationId,
    context: { aiMessageId, audioBytes: audio.bytes.byteLength },
  });
  return storagePath;
}

async function markAudioFailed(
  admin: SupabaseClient,
  params: {
    tenantId: string;
    conversationId: string;
    aiMessageId: string;
    reason: string;
  },
): Promise<void> {
  await patchOrReport(admin, {
    table: "messages",
    id: params.aiMessageId,
    patch: { audio_status: "failed", audio_error: params.reason },
    step: "fallback de áudio",
    tenantId: params.tenantId,
    conversationId: params.conversationId,
    context: { aiMessageId: params.aiMessageId },
  });
}

async function sendViaProvider(params: SendViaProviderParams): Promise<SendResult> {
  const {
    admin,
    tenantId,
    conversationId,
    aiMessageId,
    providerSlug,
    cred,
    aiText,
    contactPhone,
    contactEmail,
    destination,
    subject,
    voice,
  } = params;

  if (!isSupportedProviderSlug(providerSlug)) {
    return { ok: false, error: "Canal desta conversa não é suportado para envio externo." };
  }

  // -------------------- Resposta em áudio (TTS) --------------------
  // Só entra aqui quando o tenant pediu voz E o canal sabe enviar áudio.
  // Falha na voz NÃO deixa o lead sem resposta: cai para o envio de texto
  // logo abaixo — receber o texto é estritamente melhor que silêncio. Mas
  // nunca em silêncio: os dois motivos de queda são logados, porque
  // "configurei áudio e chega texto" precisa ter explicação no log.
  if (voice) {
    if (!providerSupportsAudio(providerSlug)) {
      const detail = "Resposta em áudio pedida, mas o canal não suporta envio de áudio.";
      await markAudioFailed(admin, { tenantId, conversationId, aiMessageId, reason: detail });
      await reportVoiceFallback(
        admin,
        tenantId,
        conversationId,
        providerSlug,
        "canal_nao_suporta_audio",
        detail,
      );
    } else {
      try {
        requireAiResponseTime(params.budget, AI_TTS_TOTAL_BUDGET_MS + AI_SEND_OPERATION_BUDGET_MS);
        await params.beforeSend?.();
        const spoken = await synthesizeWithRetry(admin, {
          tenantId,
          conversationId,
          aiMessageId,
          apiKey: voice.apiKey,
          voiceId: voice.voiceId,
          modelId: voice.modelId ?? null,
          text: aiText,
          budget: params.budget,
        });
        const storagePath = await persistGeneratedAudio(admin, {
          tenantId,
          conversationId,
          aiMessageId,
          audio: spoken,
        });
        // Evolution Go busca a mídia por URL (POST /send/media). Link assinado
        // de vida curta: o bucket segue privado, a capacidade é o link.
        // Falha aqui não impede o envio — o adaptador cai para data URI.
        const signedUrl = await createAudioSignedUrl(admin, storagePath);
        await patchOrReport(admin, {
          table: "messages",
          id: aiMessageId,
          patch: { audio_status: "sending" },
          step: "envio de áudio",
          tenantId,
          conversationId,
          context: { aiMessageId },
        });
        requireAiResponseTime(params.budget, AI_SEND_OPERATION_BUDGET_MS);
        await params.beforeSend?.();
        const audioSent = await sendAudioViaProvider({
          providerSlug,
          cred,
          phone: contactPhone,
          audio: spoken,
          ...(signedUrl ? { audioSignedUrl: signedUrl } : {}),
        });

        if (audioSent.ok) {
          await patchOrReport(admin, {
            table: "messages",
            id: aiMessageId,
            patch: {
              audio_status: "sent",
              audio_error: null,
              audio_sent_at: new Date().toISOString(),
            },
            step: "áudio enviado",
            tenantId,
            conversationId,
            context: { aiMessageId, externalId: audioSent.external_id ?? null },
          });
          return audioSent;
        }
        const detail = `Provider recusou o áudio: ${audioSent.error ?? "sem detalhe"}`;
        await markAudioFailed(admin, { tenantId, conversationId, aiMessageId, reason: detail });
        await reportVoiceFallback(
          admin,
          tenantId,
          conversationId,
          providerSlug,
          "audio_recusado_pelo_provider",
          detail,
        );
      } catch (e) {
        if (e instanceof AiSendInterruptedError || e instanceof AiResponseDeadlineError) throw e;
        const detail = `Falha ao sintetizar áudio: ${
          redactSecrets(e instanceof Error ? e.message : String(e))
        }`;
        await markAudioFailed(admin, { tenantId, conversationId, aiMessageId, reason: detail });
        await reportVoiceFallback(
          admin,
          tenantId,
          conversationId,
          providerSlug,
          "falha_ao_sintetizar",
          detail,
        );
      }
    }
  }

  const baseSubject = subject ?? "";
  const subjectLine = baseSubject
    ? /^re:\s/i.test(baseSubject) ? baseSubject : `Re: ${baseSubject}`
    : "Nova mensagem";

  requireAiResponseTime(params.budget, AI_SEND_OPERATION_BUDGET_MS);
  await params.beforeSend?.();
  return await sendViaProviderCanonical({
    admin,
    providerSlug,
    cred,
    phone: String(contactPhone ?? ""),
    email: String(contactEmail ?? "").trim(),
    content: aiText,
    subject: subjectLine,
    destination,
  });
}

interface PersistSendFailureParams {
  admin: SupabaseClient;
  aiMessageId: string;
  conversationId: string;
  tenantId: string;
  providerSlug: string;
  message: string;
  errorCode: string;
  logMessage?: string;
  logProvider?: string;
  statusCode?: number | null;
  previousAwaitingHuman: boolean;
  voiceRequested: boolean;
  traceId?: string | null;
}

// Detalhes específicos de UMA falha (o que muda entre os dois pontos de
// chamada em dispatchAiSend); os identificadores (admin/ids/providerSlug) e
// previousAwaitingHuman/voiceRequested são fixos por invocação e entram via closure em
// dispatchAiSend (failSend).
type SendFailureDetails = Omit<
  PersistSendFailureParams,
  | "admin"
  | "aiMessageId"
  | "conversationId"
  | "tenantId"
  | "providerSlug"
  | "previousAwaitingHuman"
  | "voiceRequested"
  | "traceId"
>;

// -------------------- Persistência de falha de envio --------------------
// Compartilhado pelos dois jeitos de dispatchAiSend falhar: o provider
// recusou o envio (sendResult.ok=false) ou uma exceção interrompeu a
// tentativa. `message` é o texto gravado em messages.send_error e
// conversations.last_error (o que o operador vê); `logMessage`/`logProvider`
// permitem divergir do texto de ai_failure_logs quando o caller já tem um
// AiError sanitizado mais específico (branch de exceção) — default cai em
// `message`/`providerSlug`.
async function persistSendFailure(params: PersistSendFailureParams): Promise<void> {
  const {
    admin,
    aiMessageId,
    conversationId,
    tenantId,
    providerSlug,
    message,
    errorCode,
    logMessage,
    logProvider,
    statusCode,
    previousAwaitingHuman,
    voiceRequested,
    traceId,
  } = params;

  // H8: sem checagem, a falha de envio some — a mensagem fica "pending" (o
  // operador vê um envio em curso que na verdade morreu) e a conversa fica
  // sem awaiting_human. O alerta ao admin (notifyAdminHandoff) e o
  // ai_failure_logs abaixo já rodam independentes deste UPDATE; o que se
  // perdia era o estado no CRM, agora reportado.
  await patchOrReport(admin, {
    table: "messages",
    id: aiMessageId,
    patch: {
      status: "failed",
      send_error: message,
      ...(voiceRequested ? { audio_status: "failed", audio_error: message } : {}),
    },
    step: "falha de envio",
    tenantId,
    conversationId,
    context: { aiMessageId },
  });
  await patchOrReport(admin, {
    table: "conversations",
    id: conversationId,
    patch: { last_error: message, awaiting_human: true },
    step: "falha de envio",
    tenantId,
    conversationId,
    context: { aiMessageId },
  });
  // Só notifica na transição false→true (A3) — mesmo contrato dos demais
  // call-sites de notifyAdminHandoff.
  if (!previousAwaitingHuman) {
    await notifyAdminHandoff(admin, tenantId, conversationId, "send_failed");
  }
  await reportAIFailure(admin, {
    tenantId,
    route: "ai-respond",
    provider: providerSlug || logProvider || undefined,
    statusCode: statusCode ?? null,
    errorCode,
    errorMessage: logMessage ?? message,
    traceId: traceId ?? null,
    context: { conversationId, phase: "send", aiMessageId },
  });
}

interface PersistSendSuccessParams {
  admin: SupabaseClient;
  aiMessageId: string;
  conversationId: string;
  tenantId: string;
  contactId: string;
  dealId: string | null;
  externalId?: string | null;
}

// -------------------- Persistência de sucesso + resumo em background --------------------
async function persistSendSuccess(params: PersistSendSuccessParams): Promise<void> {
  const { admin, aiMessageId, conversationId, tenantId, contactId, dealId, externalId } = params;

  // H7: a mensagem JÁ chegou ao cliente — se este UPDATE falhar sem checagem,
  // o CRM mantém "pending" e o operador reenvia algo que já foi entregue.
  await patchOrReport(admin, {
    table: "messages",
    id: aiMessageId,
    patch: { status: "sent", external_id: externalId ?? null, send_error: null },
    step: "envio confirmado",
    tenantId,
    conversationId,
    context: { aiMessageId, externalId: externalId ?? null },
  });
  // O sucesso não pode apagar uma pausa/handoff ocorrido durante o envio.
  // O WHERE é atômico: o snapshot lido antes do provider não autoriza esta baixa.
  await patchOrReport(admin, {
    table: "conversations",
    id: conversationId,
    patch: { last_error: null, awaiting_human: false },
    step: "envio confirmado",
    tenantId,
    conversationId,
    context: { aiMessageId, externalId: externalId ?? null },
    onlyWhileAiActive: true,
  });

  runInBackground(
    generateConversationSummary(admin, {
      tenantId,
      contactId,
      conversationId,
      dealId: dealId ?? undefined,
    }).catch((err) => console.error("ai-respond summary generation failed", err)),
  );
}

/**
 * Tenta o envio externo da resposta da IA pelo provedor ativo da conversa
 * (sendViaProvider) e grava o resultado (status/erro) em messages +
 * conversations, reportando falha de infra em ai_failure_logs nos dois casos
 * que a chamada pode falhar: o provider recusou o envio (sendResult.ok=false)
 * ou uma exceção de rede/config interrompeu a tentativa — os dois casos
 * delegam para persistSendFailure via o closure `failSend` abaixo, que já
 * fixa os identificadores da mensagem/conversa/tenant/provider.
 *
 * Em sucesso, delega para persistSendSuccess, que também dispara
 * (fire-and-forget) a geração do resumo de memória da conversa — nunca
 * bloqueia a resposta ao caller.
 *
 * @returns true se o envio externo teve sucesso, false em qualquer outro caso.
 */
export async function dispatchAiSend(params: DispatchAiSendParams): Promise<boolean> {
  const {
    admin,
    tenantId,
    conversationId,
    contactId,
    dealId,
    aiMessageId,
    providerSlug,
    previousAwaitingHuman,
  } = params;
  const failSend = (fail: SendFailureDetails) =>
    persistSendFailure({
      admin,
      aiMessageId,
      conversationId,
      tenantId,
      providerSlug,
      previousAwaitingHuman,
      voiceRequested: Boolean(params.voice),
      traceId: params.traceId ?? null,
      ...fail,
    });

  try {
    // ManyChat sem subscriber_id do canal não tem para onde ir: falha clara +
    // handoff (persistSendFailure marca awaiting_human e avisa o admin). Nunca
    // cai para o telefone.
    const resolved = await resolveProviderDestination(admin, { tenantId, contactId, providerSlug });
    if (!resolved.ok) {
      await failSend({ message: resolved.error, errorCode: "UNKNOWN" });
      return false;
    }
    const cred = await loadSecrets(admin, tenantId, providerSlug);
    const sendResult = await sendViaProvider({
      admin,
      tenantId: params.tenantId,
      conversationId: params.conversationId,
      aiMessageId,
      providerSlug,

      cred,
      aiText: params.aiText,
      contactPhone: params.contactPhone,
      contactEmail: params.contactEmail,
      destination: resolved.destination,
      subject: params.subject,
      voice: params.voice ?? null,
      budget: params.budget,
      beforeSend: params.beforeSend,
    });

    if (!sendResult.ok) {
      // Falha do provider (não é exceção) — sem statusCode aqui (SendResult
      // não carrega o HTTP status bruto), então classifica genérico.
      await failSend({
        message: sendResult.error ?? "Não foi possível enviar a resposta da IA.",
        errorCode: "UNKNOWN",
      });
      return false;
    }

    await persistSendSuccess({
      admin,
      aiMessageId,
      conversationId,
      tenantId,
      contactId,
      dealId,
      externalId: sendResult.external_id,
    });
    return true;
  } catch (e) {
    if (e instanceof AiSendInterruptedError || e instanceof AiResponseDeadlineError) throw e;
    console.error("ai-respond send exception", redactSecrets((e as Error).message));
    const sendAiError = sanitizeProviderError(e);
    await failSend({
      message: NET_ERR,
      errorCode: sendAiError.code,
      logMessage: redactSecrets(sendAiError.message),
      logProvider: sendAiError.provider,
      statusCode: sendAiError.statusCode ?? null,
    });
    return false;
  }
}
