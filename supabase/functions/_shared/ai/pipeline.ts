// pipeline.ts — pipeline de ai-respond DEPOIS que runGates (gates.ts) já
// autorizou a IA a responder: montagem de entidades (deal, stage_ai_config),
// montagem do prompt, execução de handoff e avaliação de avanço de estágio.
// A persistência + envio externo do texto final (finalizeAiReply,
// dispatchAiSend) vive em send-dispatch.ts — bloco separado porque tem
// dependências próprias (send-adapters.ts, memory-summary.ts) que o resto
// deste arquivo não usa.
//
// Extraído de ai-respond/index.ts nesta fase (fix de review) só para manter
// o arquivo principal dentro do teto de ~800 linhas do projeto e como um
// orquestrador curto — index.ts encadeia estas funções em sequência, cada
// uma concentrando um bloco que antes vivia inline no callback do
// Deno.serve.
//
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { buildVars, renderTemplate } from "./prompt-vars.ts";
import { sanitizeProviderError } from "./errors.ts";
import { reportAIFailure } from "./failure-log.ts";
import { callLovableGateway, getAIGatewayConfig, LovableGatewayHttpError } from "./gateway.ts";
import {
  buildAdaptiveContext,
  getTimeOfDay,
  LEAD_DATA_DISCLAIMER,
  sanitizeLeadText,
} from "./context-builder.ts";
import { buildKnowledgeContext } from "./knowledge-context.ts";
import { notifyAdminHandoff } from "./notify-admin-handoff.ts";
import { isAudioMedia } from "./voice.ts";

// Mesmo teto de saída de callLovableAI (ai-respond/index.ts) — a chamada de
// avaliação de avanço usa o mesmo modelo/gateway, então herda o mesmo limite.
const AI_MAX_OUTPUT_TOKENS = 1024;

// -------------------- Deal (busca/criação) --------------------

export interface DealContact {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
}

export interface DealLookupResult {
  dealId: string | null;
  dealStageId: string | null;
  lookupFailure: "open_deal_query" | "default_board_query" | "first_stage_query" | null;
}

/**
 * Busca o deal aberto mais recente do contato ou, se não houver nenhum, cria
 * um no board default do tenant (primeiro estágio por posição). Chamada
 * SEMPRE protegida pelo lock de conversa (claimAITurn, adquirido em
 * runGates) — sem o lock, duas mensagens quase simultâneas do mesmo contato
 * podiam cair aqui em paralelo e ambas encontrarem "nenhum deal aberto",
 * criando 2 deals duplicados.
 *
 * Nunca lança: falha de query de LEITURA é logada e retornada em lookupFailure
 * (não cria deal, a fim de evitar duplicatas por falha transitória); ausência
 * de board/estágio default apenas resulta em {dealId: null, dealStageId: null,
 * lookupFailure: null}. Se a leitura falha, nunca insere.
 */
export async function loadOrCreateOpenDeal(
  admin: SupabaseClient,
  tenantId: string,
  contact: DealContact,
): Promise<DealLookupResult> {
  const { data: openDealRow, error: openDealErr } = await admin
    .from("deals")
    .select("id, stage_id")
    .eq("tenant_id", tenantId)
    .eq("contact_id", contact.id)
    .or("status.is.null,status.eq.open")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (openDealErr) {
    console.error("[ai-respond] query deals (open) falhou:", openDealErr.message);
    return { dealId: null, dealStageId: null, lookupFailure: "open_deal_query" };
  }

  if (openDealRow) {
    return {
      dealId: (openDealRow.id as string | null) ?? null,
      dealStageId: (openDealRow.stage_id as string | null) ?? null,
      lookupFailure: null,
    };
  }

  return createDefaultDeal(admin, tenantId, contact);
}

/**
 * Cria o deal default de um contato sem deal aberto: board is_default do
 * tenant + primeiro estágio por posição. Degrada para {dealId: null,
 * dealStageId: null} se o tenant não tiver board default ou o board não
 * tiver nenhum estágio configurado (nunca lança).
 */
async function createDefaultDeal(
  admin: SupabaseClient,
  tenantId: string,
  contact: DealContact,
): Promise<DealLookupResult> {
  const { data: board, error: boardErr } = await admin
    .from("boards")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("is_default", true)
    .maybeSingle();
  if (boardErr) {
    console.error("[ai-respond] query boards falhou:", boardErr.message);
    return { dealId: null, dealStageId: null, lookupFailure: "default_board_query" };
  }
  if (!board) return { dealId: null, dealStageId: null, lookupFailure: null };

  const { data: firstStage, error: firstStageErr } = await admin
    .from("board_stages")
    .select("id")
    .eq("board_id", board.id as string)
    .order("position", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (firstStageErr) {
    console.error("[ai-respond] query board_stages (first) falhou:", firstStageErr.message);
    return { dealId: null, dealStageId: null, lookupFailure: "first_stage_query" };
  }
  if (!firstStage) return { dealId: null, dealStageId: null, lookupFailure: null };

  // Sanitiza nome (controlado pelo lead via senderName do WhatsApp) antes de
  // compor um título que vai parar no system prompt (formatExplicitDealBlock):
  // remove quebras de linha/controles e trunca em 80 chars.
  const safeName = String(contact.name ?? "")
    .replace(/[\r\n\t\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const title = `Contato ${safeName || contact.phone || contact.email || ""}`.trim();
  const { data: newDeal, error: newDealErr } = await admin
    .from("deals")
    .insert({
      tenant_id: tenantId,
      board_id: board.id,
      stage_id: firstStage.id,
      contact_id: contact.id,
      title: title || "Novo lead",
      status: "open",
    })
    .select("id")
    .single();
  if (newDealErr) console.error("[ai-respond] insert deals falhou:", newDealErr.message);

  return { dealId: (newDeal?.id as string | null) ?? null, dealStageId: firstStage.id as string, lookupFailure: null };
}

// -------------------- stage_ai_config --------------------

export interface StageAiConfigResult {
  stagePrompt: string;
  stageAdvancement: Array<string | { criterion?: string; description?: string; text?: string }>;
  stageHandoffKeywords: string[];
  stageGoal: string;
}

/**
 * Carrega a configuração de IA do estágio atual do deal (prompt específico,
 * critérios de avanço, palavras de handoff extras, meta do estágio). Sem
 * dealStageId (deal ainda sem estágio), devolve os valores neutros/vazios.
 */
export async function loadStageAiConfig(
  admin: SupabaseClient,
  tenantId: string,
  dealStageId: string | null,
): Promise<StageAiConfigResult> {
  let stagePrompt = "";
  let stageAdvancement: StageAiConfigResult["stageAdvancement"] = [];
  let stageHandoffKeywords: string[] = [];
  let stageGoal = "";

  if (dealStageId) {
    const { data: stageCfg, error: stageCfgErr } = await admin
      .from("stage_ai_config")
      .select("system_prompt, enabled, advancement_criteria, handoff_keywords, stage_goal")
      .eq("tenant_id", tenantId)
      .eq("stage_id", dealStageId)
      .maybeSingle();
    if (stageCfgErr) {
      console.error("[ai-respond] query stage_ai_config falhou:", stageCfgErr.message);
    }
    if (stageCfg?.enabled) stagePrompt = (stageCfg.system_prompt ?? "").trim();
    if (stageCfg) {
      const adv = stageCfg.advancement_criteria as unknown;
      if (Array.isArray(adv)) stageAdvancement = adv as StageAiConfigResult["stageAdvancement"];
      else if (
        adv &&
        typeof adv === "object" &&
        Array.isArray((adv as { criteria?: unknown[] }).criteria)
      ) {
        stageAdvancement = (adv as { criteria: StageAiConfigResult["stageAdvancement"] }).criteria;
      }
      stageHandoffKeywords = Array.isArray(stageCfg.handoff_keywords)
        ? (stageCfg.handoff_keywords as string[])
        : [];
      stageGoal = (stageCfg.stage_goal ?? "").trim();
    }
  }

  return { stagePrompt, stageAdvancement, stageHandoffKeywords, stageGoal };
}

// -------------------- Prompt assembly --------------------

export interface BuildSystemPromptParams {
  admin: SupabaseClient;
  tenantId: string;
  contactId: string;
  conversationId: string;
  dealId: string | null;
  tenantName: string;
  tenantBusinessProfile: Record<string, unknown> | null;
  baseSystemPrompt: string | null;
  stagePrompt: string;
  // Tipo da mensagem do lead que a IA está respondendo NESTE turno (já
  // transcrita quando áudio — ver ai-respond/index.ts). Sem isto o prompt
  // nunca dizia ao modelo se a mensagem atual era áudio ou texto; ver
  // mediaGuard abaixo para o incidente que motivou o campo.
  currentMessageIsAudio: boolean;
}

/**
 * Monta o system prompt final: template base do tenant (com fallback
 * genérico) + template específico do estágio + guarda de escopo (instrui a
 * IA a responder [TRANSFERIR_HUMANO] quando não souber) + guarda de horário
 * (timeGuard abaixo — período do dia do lead, sempre presente) + contexto
 * adaptativo (context-builder.ts — deal aberto ou perfil consolidado do
 * contato). Seções vazias são descartadas antes do join.
 */
export async function buildSystemPrompt(params: BuildSystemPromptParams): Promise<string> {
  const {
    admin,
    tenantId,
    contactId,
    conversationId,
    dealId,
    tenantName,
    tenantBusinessProfile,
    baseSystemPrompt,
    stagePrompt,
    currentMessageIsAudio,
  } = params;

  const vars = buildVars({ name: tenantName, business_profile: tenantBusinessProfile ?? {} });
  const basePrompt = renderTemplate(
    baseSystemPrompt?.trim() ||
      "Você é uma assistente virtual atenciosa que atende leads de {{empresa}}. Seja cordial, objetiva e ajude o cliente com clareza.",
    vars,
  );
  const stageRendered = stagePrompt ? renderTemplate(stagePrompt, vars) : "";
  // A segunda frase existe porque no QA de 54 perguntas (2026-08-04) o handoff
  // disparou 5 vezes, e em 3 delas a resposta estava escrita na base — a IA
  // escalou sem antes olhar os trechos que tinha em mãos.
  const scopeGuard =
    "Se a mensagem do lead fugir do seu escopo ou você não souber responder com segurança, seja honesta e responda literalmente com a frase [TRANSFERIR_HUMANO] para que um atendente humano assuma. " +
    "Antes de transferir, releia os trechos e o contexto que você recebeu: se a resposta estiver ali, responda você mesma — transferir com a informação em mãos desperdiça o tempo do lead e do atendente.";
  // Veracidade e procedência. Os três casos abaixo saíram do QA de 54 perguntas
  // (2026-08-04) e são falhas DIFERENTES, por isso três frases e não uma:
  //   1. inventou "recibo precisa ter CNPJ" — nenhum documento diz isso;
  //   2. inventou o cargo de um nome real ("Lucas é o responsável técnico");
  //   3. respondeu "das 09:00 às 18:00" a uma pergunta sobre o que os DOCUMENTOS
  //      dizem — o horário existe, mas no business_profile do tenant, não na base.
  // O terceiro não é alucinação: é fonte trocada sem avisar, e sem esta regra
  // nenhuma instrução de anti-alucinação o pegaria.
  const sourceGuard = [
    "Só afirme fato (número, prazo, valor, nome, cargo, e-mail, endereço) se ele estiver escrito nos trechos e no contexto que você recebeu. Se não estiver, diga que não encontrou essa informação — nunca preencha a lacuna com o que soa plausível.",
    "Nome que aparece no material não autoriza inventar o cargo, a função ou a área dele. Sem vínculo escrito, não existe vínculo.",
    "A base de conhecimento e os dados da empresa são fontes DIFERENTES. Quando a pergunta é sobre o que os documentos dizem e você só tem o dado no cadastro da empresa, responda dizendo de onde ele vem, em vez de apresentá-lo como se estivesse no documento.",
  ].join(" ");
  // Cadência. Isto é a METADE do formato: aqui a IA já escreve condensado, e
  // condenseForHumanCadence garante o resultado mesmo quando ela desobedece.
  // Só uma das duas não basta — prompt sozinho é sugestão, e limpeza sozinha
  // recebe texto pensado como documento e o achata na marra.
  // Formato + anti-slop, calibrado em DADOS, não em intuição.
  //
  // 322 mensagens de secretária humana real (base do medflow, 2026-08-04)
  // contra as respostas da Clara em produção no mesmo dia:
  //
  //                          humano real      Clara
  //   mediana de caracteres      80            ~250
  //   mensagens < 40 chars       27%             0%
  //   com linha em branco        23%            100%
  //   com emoji                  50%            100%
  //   "?" por mensagem          0,62             ~2
  //
  // O erro dominante é TAMANHO: a IA escreve 3x mais que uma pessoa. Os padrões
  // banidos abaixo saíram de respostas reais dela, não de teoria:
  //   "Essa é uma ótima pergunta estratégica 😊"   → bajulação de abertura
  //   "Maravilha! ... potencial enorme de escala"  → elogio inflado
  //   "Geralmente o aéreo é ideal para prazos"     → abstração sem número
  const cadenceRules = [
    "FORMATO: UMA mensagem por turno, curta. Mire em ~80 caracteres; passar de 300 é raro. Sem linha em branco, lista com marcadores, título ou markdown — ninguém formata documento numa conversa.",
    "Mensagem de uma linha só é normal e desejável ('Perfeito, anotei aqui', 'Consigo sim'). Não encha para parecer completo.",
    "NÃO comece elogiando a pergunta nem a empresa do lead ('ótima pergunta', 'que legal', 'maravilha', 'excelente'). Responda direto.",
    "NÃO infle: nada de 'enorme potencial', 'super estratégico', 'vai transformar'. Fato concreto vale mais que adjetivo — número, prazo, nome, exemplo.",
    "Verbo direto em vez de rodeio: 'decidimos', não 'tomamos a decisão'; 'dá para', não 'existe a possibilidade de'.",
    "No máximo uma pergunta, no fim — e nem toda mensagem precisa de uma. Duas perguntas juntas travam a resposta do lead.",
    "NUNCA repita uma pergunta que você já fez nesta conversa. Antes de perguntar, procure a pergunta no histórico acima: se já está lá, o lead ainda não quis responder — siga o assunto sem insistir. Perguntar de novo é o erro que mais entrega robô.",
    "Cada pergunta de qualificação (faturamento, meta, origem do contato, orçamento) vale UMA vez por conversa. Fez, não faz mais.",
    "Emoji: se a sua mensagem anterior no histórico tem emoji, esta NÃO leva. Nunca mais de um por mensagem, nunca em resposta a pergunta factual.",
  ].join(" ");
  // Guarda do tipo da mensagem ATUAL. Incidente reproduzido em produção
  // (2026-08-04 21:21): o lead mandou "teste 1820" e "teste 1821" como TEXTO
  // puro (messages.media_type IS NULL) e a IA respondeu "Não consigo ouvir
  // áudios por aqui ainda, você poderia escrever o que precisa?" — frase que
  // não existe em base_system_prompt, stage_ai_config.system_prompt,
  // prompt_override, business_profile nem niche_templates deste tenant.
  // Nada no prompt dizia, turno a turno, se a mensagem que a IA está
  // respondendo agora veio de áudio (já transcrito por loadRecentHistory)
  // ou foi digitada — sem esse sinal explícito o modelo generaliza de
  // menções a áudio mais antigas na mesma conversa. Esta frase fecha a
  // lacuna.
  const mediaGuard = currentMessageIsAudio
    ? "A mensagem do lead que você está respondendo agora veio de um ÁUDIO já transcrito para texto — trate o conteúdo como o que o lead disse, sem comentar que era áudio."
    : "A mensagem do lead que você está respondendo agora foi digitada como texto, não é áudio. Ignore qualquer menção a áudio em mensagens anteriores do histórico — são de outro momento da conversa. Só diga que não consegue ouvir áudio se a mensagem ATUAL for realmente um áudio.";
  // Horário do lead é informação de TODO turno, não de contato com memória
  // consolidada. Bug de produção (2026-08-05, 11:38 UTC = 08:38 em
  // Brasília): a IA abriu a resposta com "Boa noite!" de manhã. Causa: até
  // aqui getTimeOfDay() só era chamada dentro do bloco IMPLÍCITO de
  // context-builder.ts (memória consolidada + sem deal aberto) — contato
  // sem `ai_memory`, ou com deal aberto (bloco EXPLÍCITO nem chama a
  // função), nunca recebia o horário e o modelo chutava o período. Também
  // instrui explicitamente a saudação: antes a linha era passiva ("Horário
  // atual do lead: manhã.") e nada dizia ao modelo pra usar esse dado na
  // saudação.
  const timeGuard = `Horário atual do lead: ${getTimeOfDay()}. Se for cumprimentar, a saudação tem que combinar com este período (ex.: "bom dia" de manhã, nunca "boa noite" de manhã).`;
  // Nunca lança — "" quando não há nenhum sinal aproveitável.
  const adaptiveContext = await buildAdaptiveContext(admin, {
    tenantId,
    contactId,
    conversationId,
    dealId: dealId ?? undefined,
  });
  const knowledgeContext = await buildKnowledgeContext(admin, {
    tenantId,
    conversationId,
  });

  return [
    basePrompt,
    stageRendered,
    scopeGuard,
    sourceGuard,
    cadenceRules,
    mediaGuard,
    timeGuard,
    adaptiveContext,
    knowledgeContext,
  ]
    .filter((s) => s && s.length > 0)
    .join("\n\n");
}

// -------------------- History --------------------

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LoadRecentHistoryLimits {
  historyLimit: number;
  historyMaxChars: number;
}

/**
 * Carrega o histórico recente da conversa (só mensagens "sent", para não
 * replayar falhas) em ordem cronológica, rotulado por remetente, e aplica
 * uma janela por caracteres: mantém as mais recentes até historyMaxChars — a
 * mais recente sempre entra, mesmo que sozinha ultrapasse o teto.
 */
export async function loadRecentHistory(
  admin: SupabaseClient,
  conversationId: string,
  limits: LoadRecentHistoryLimits,
): Promise<HistoryMessage[]> {
  const { data: recent, error: recentErr } = await admin
    .from("messages")
    .select("sender, content, created_at, media_type")
    .eq("conversation_id", conversationId)
    .in("status", ["sent"])
    .order("created_at", { ascending: false })
    .limit(limits.historyLimit);
  if (recentErr) {
    console.error("[ai-respond] query messages (histórico) falhou:", recentErr.message);
  }

  const fullHistory: HistoryMessage[] = (recent ?? [])
    .slice()
    .reverse()
    .filter((m) => (m.content ?? "").trim().length > 0)
    .map((m) => {
      const role: "user" | "assistant" = m.sender === "contact" ? "user" : "assistant";
      // Só o atendente HUMANO leva rótulo. Para a própria IA o rótulo era
      // redundante — `role: "assistant"` já diz de quem é — e o modelo copiava
      // o "[IA] " para dentro da resposta enviada ao lead: 15 de 65 respostas
      // no QA de 2026-08-04, uma delas com "[IA] [IA] ", porque a resposta
      // contaminada volta ao histórico e ganha outro rótulo no turno seguinte.
      // Negativo de propósito: qualquer remetente que NÃO seja o lead, a IA ou
      // a automação (hoje 'agent' e 'human') continua sendo atendente humano e
      // mantém o rótulo — a distinção humano/IA no histórico é real e serve.
      // 'automation' (campanha/nutrição) entra como turno da própria empresa,
      // SEM rótulo, pelo mesmo motivo do vazamento de "[IA]": com "[Atendente]"
      // o modelo tratava a mensagem da campanha como fala de um humano.
      //
      // Mensagem do lead vinda de áudio (media_type de voz — ver isAudioMedia
      // em voice.ts) leva o rótulo "[Áudio transcrito]": sem isto o histórico
      // não distinguia texto digitado de transcrição, e um refúgio real de
      // áudio em turno ANTERIOR ficava indistinguível do turno atual — parte
      // do incidente de 2026-08-04 21:21 (ver mediaGuard em buildSystemPrompt).
      const isAudioTurn = m.sender === "contact" && isAudioMedia(m.media_type);
      const content = isAudioTurn
        ? `[Áudio transcrito] ${m.content ?? ""}`
        : m.sender === "contact" || m.sender === "ai" || m.sender === "automation"
        ? String(m.content ?? "")
        : `[Atendente] ${m.content ?? ""}`;
      return { role, content };
    });

  const kept: HistoryMessage[] = [];
  let historyChars = 0;
  for (const m of fullHistory.slice().reverse()) {
    historyChars += m.content.length;
    if (kept.length > 0 && historyChars > limits.historyMaxChars) break;
    kept.push(m);
  }
  return kept.slice().reverse();
}

// -------------------- Handoff --------------------

export interface PerformHandoffParams {
  admin: SupabaseClient;
  tenantId: string;
  conversationId: string;
  dealId: string | null;
  contact: DealContact;
  reason: string;
  // Valor de conversations.awaiting_human lido pelo caller ANTES deste
  // handoff (já disponível via gates.ts/runGates — nunca uma query extra).
  // Usado só para decidir se notifyAdminHandoff dispara (só na transição
  // false→true, A3: alerta imediato de handoff).
  previousAwaitingHuman: boolean;
}

/**
 * Executa o handoff para atendimento humano: desliga a IA da conversa
 * (ai_active=false, awaiting_human=true), cria uma activity de tarefa para o
 * dono do deal (se houver) e loga estruturado. Chamado tanto pelo pre-check
 * (mídia recebida / palavra-chave) quanto pela IA declarando
 * [TRANSFERIR_HUMANO] ou incerteza detectada — o caller decide o texto de
 * resposta HTTP, esta função só executa os efeitos colaterais e devolve o
 * reason para o caller ecoar.
 *
 * Ordem intencional (Fase 3 — schema HITL): a activity é criada ANTES do
 * UPDATE em conversations, para o handoff_activity_id ir na MESMA chamada
 * que liga awaiting_human=true. O trigger trg_conversations_open_handoff
 * (BEFORE UPDATE OF awaiting_human) depende disso para linkar
 * hitl_handoff_sla_events.activity_id sem uma segunda escrita.
 */
export async function performHandoff(params: PerformHandoffParams): Promise<{ reason: string }> {
  const { admin, tenantId, conversationId, dealId, contact, reason, previousAwaitingHuman } =
    params;

  let ownerId: string | null = null;
  if (dealId) {
    const { data: dealRow, error: dealRowErr } = await admin
      .from("deals")
      .select("owner_id")
      .eq("id", dealId)
      .maybeSingle();
    if (dealRowErr) console.error("[ai-respond] query deals (owner) falhou:", dealRowErr.message);
    ownerId = (dealRow?.owner_id as string | null) ?? null;
  }

  const contactLabel =
    [contact.name, contact.phone].filter((v) => v && String(v).trim().length > 0).join(" · ") ||
    String(contact.email ?? "Contato");

  const { data: activityRow, error: activityErr } = await admin
    .from("activities")
    .insert({
      tenant_id: tenantId,
      contact_id: contact.id,
      deal_id: dealId,
      owner_id: ownerId,
      type: "task",
      title: `Lead aguardando atendimento humano — ${contactLabel}`,
      due_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (activityErr) {
    // Degrada sem falhar o handoff todo: mesmo sem activity vinculada, a
    // conversa ainda precisa sair da IA e ir para awaiting_human=true.
    console.error("[ai-respond] insert activities (handoff) falhou:", activityErr.message);
  }
  const handoffActivityId = (activityRow?.id as string | null) ?? null;

  const { error: convErr } = await admin
    .from("conversations")
    .update({
      ai_active: false,
      awaiting_human: true,
      last_error: null,
      handoff_activity_id: handoffActivityId,
    })
    .eq("id", conversationId);
  if (convErr) {
    // Não lança: o caller já pode ter respondido a requisição (contrato de
    // performHandoff/evaluateStageAdvancement é nunca lançar). Mas este
    // UPDATE é o mecanismo de segurança do handoff (desligar a IA quando
    // deve entrar atendimento humano) — precisa ficar visível no log
    // estruturado, não falhar em silêncio disfarçado de sucesso.
    console.error("[ai-respond] update conversations (handoff) falhou:", convErr.message);
  }

  console.log("ai-respond handoff", { tenantId, conversationId, reason, handoffActivityId });

  // Só notifica na transição false→true — previousAwaitingHuman é o valor
  // que o caller já tinha em mãos ANTES deste handoff (nunca uma query
  // extra; ver comentário em PerformHandoffParams). notifyAdminHandoff nunca
  // lança (A3: alerta imediato de handoff).
  if (!previousAwaitingHuman) {
    await notifyAdminHandoff(admin, tenantId, conversationId, reason);
  }

  return { reason };
}

// -------------------- Avanço de estágio --------------------

export interface EvaluateStageAdvancementParams {
  admin: SupabaseClient;
  tenantId: string;
  conversationId: string | null;
  dealId: string | null;
  dealStageId: string | null;
  stageAdvancement: Array<string | { criterion?: string; description?: string; text?: string }>;
  stageGoal: string;
  effectiveModel: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  aiText: string;
  sourceEventId?: string | null;
  triggerEvent?: string;
  structuredSignals?: Record<string, unknown>;
  correlationId?: string | null;
  promptSnapshot?: Record<string, unknown> | null;
}

/**
 * Avalia se os critérios de avanço do estágio atual foram cumpridos com base
 * na conversa (só quando há critérios configurados e o deal segue no mesmo
 * estágio), persiste o progresso de cada critério e, se todos foram
 * cumpridos, envia a decisão ao comando transacional único.
 *
 * Nunca lança: qualquer falha (fetch, parse, query) é capturada, logada e
 * reportada em ai_failure_logs — o handler principal já respondeu ao caller
 * antes desta função rodar, então uma falha aqui não pode voltar a afetar a
 * resposta HTTP.
 */
export async function evaluateStageAdvancement(
  params: EvaluateStageAdvancementParams,
): Promise<void> {
  const {
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
    sourceEventId = null,
    triggerEvent = "message.sent",
    structuredSignals = {},
    correlationId = null,
    promptSnapshot = null,
  } = params;

  try {
    if (!dealStageId || !dealId) return;

    const evaluation = await evaluateAdvancementCriteria({
      stageAdvancement,
      stageGoal,
      effectiveModel,
      history,
      aiText,
    });
    if (!evaluation) return;

    await persistStageEvaluations(admin, {
      tenantId,
      dealId,
      dealStageId,
      evaluation,
      structuredSignals,
      sourceEventId,
      effectiveModel,
    });
    if (!evaluation.allMet) return;

    // Portão de ENTRADA do estágio de destino. Cumprir o avanço da origem
    // responde "o lead terminou o que tinha aqui?"; ainda falta "o lead pode ser
    // admitido lá?". São perguntas distintas e o motivo registrado precisa
    // distinguir as duas — barrado na entrada é diferente de não ter avançado.
    //
    // Estágio de destino sem entry_criteria devolve `admitted: true` sem gastar
    // chamada ao modelo, então nada muda para quem não configurou a lista.
    const entry = await evaluateTargetStageEntry(admin, {
      tenantId,
      dealStageId,
      stageGoal,
      effectiveModel,
      history,
      aiText,
    });
    if (!entry.admitted) {
      console.log("pipeline entrada barrada", {
        tenantId,
        dealId,
        from: dealStageId,
        to: entry.targetStageId,
        reason: entry.reason,
      });
      return;
    }

    await applyStageAdvancementDecision(admin, {
      tenantId,
      conversationId,
      dealId,
      dealStageId,
      overallConfidence: evaluation.overallConfidence,
      criteriaEvaluation: evaluation.criteriaEvaluation,
      effectiveModel,
      stageGoal,
      structuredSignals,
      sourceEventId,
      triggerEvent,
      correlationId,
      promptSnapshot,
    });
  } catch (e) {
    console.error("ai-respond advancement eval failed", (e as Error).message);
    const aiError = sanitizeProviderError(e);
    await reportAIFailure(admin, {
      tenantId,
      route: "ai-respond.advancement",
      errorCode: aiError.code,
      errorMessage: aiError.message,
      context: { dealId, dealStageId },
    });
  }
}

interface EvaluateAdvancementCriteriaParams {
  stageAdvancement: Array<string | { criterion?: string; description?: string; text?: string }>;
  stageGoal: string;
  effectiveModel: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  aiText: string;
}

interface CriteriaEvaluationItem {
  criterion: string;
  met: boolean;
  confidence: number;
  evidence: string;
}

interface EvaluateAdvancementCriteriaResult {
  allMet: boolean;
  overallConfidence: number;
  criteriaEvaluation: CriteriaEvaluationItem[];
}

interface RawCriterionResult {
  criterion?: unknown;
  met?: unknown;
  confidence?: unknown;
  evidence?: unknown;
}

/**
 * Monta o prompt de avaliação, chama o LLM avaliador e parseia o resultado.
 *
 * Devolve null nos casos de skip silencioso (sem critério configurado, sem
 * chave, HTTP não-ok do gateway) — o caller trata null exatamente como "não
 * avançar", sem reportar falha em ai_failure_logs. Resposta malformada
 * (JSON.parse falhando) e erros de rede (fetch falhando antes de uma
 * resposta) continuam propagando para o catch de evaluateStageAdvancement
 * (reportAIFailure), igual antes.
 *
 * Quando a avaliação roda com sucesso, devolve { allMet, overallConfidence,
 * criteriaEvaluation }: allMet só é true se TODOS os critérios configurados
 * vierem com met=true; overallConfidence é a média (clamped 0-1) da
 * confidence de cada critério retornado (0 se a lista vier vazia).
 */
async function evaluateAdvancementCriteria(
  params: EvaluateAdvancementCriteriaParams,
): Promise<EvaluateAdvancementCriteriaResult | null> {
  const { stageAdvancement, stageGoal, effectiveModel, history, aiText } = params;

  const criteriaList = stageAdvancement
    .map((c) => (typeof c === "string" ? c : (c?.criterion ?? c?.description ?? c?.text ?? "")))
    .map((s) => String(s ?? "").trim())
    .filter((s) => s.length > 0);
  if (criteriaList.length === 0) return null;

  const transcript = history
    .map((h) =>
      h.role === "user"
        ? `Lead: ${sanitizeLeadText(h.content, 1200)}`
        : `IA: ${sanitizeLeadText(h.content, 1200)}`
    )
    .concat(`IA: ${sanitizeLeadText(aiText, 1200)}`)
    .join("\n");
  const evalSystem =
    `Você avalia se cada critério de qualificação de um lead está cumprido com base na conversa. ` +
    `${LEAD_DATA_DISCLAIMER} ` +
    (stageGoal ? `Meta deste estágio: ${stageGoal}. ` : "") +
    `Responda em JSON: {"results":[{"criterion":"...","met":true|false,"confidence":0.0-1.0,"evidence":"..."}]}. ` +
    `confidence é o quão certa você está desta avaliação específica (0 = nenhuma evidência, 1 = evidência inequívoca). ` +
    `evidence é uma citação curta ou paráfrase do trecho da conversa que embasa "met" (string vazia se não houver). ` +
    `Só marque true se houver evidência clara na conversa.`;
  const evalUser = `Critérios:\n- ${criteriaList.join("\n- ")}\n\nConversa:\n${transcript}`;
  // Checado aqui (não delegado ao check interno de callLovableGateway) de
  // propósito: sem chave, este caller SILENCIA (pula a avaliação) — se o
  // erro viesse de dentro do gateway ele propagaria pro catch externo lá
  // embaixo, que reporta em ai_failure_logs, mudando o comportamento.
  if (!getAIGatewayConfig().apiKey) return null;

  let raw: string;
  try {
    raw = await callLovableGateway(
      evalSystem,
      [{ role: "user", content: evalUser }],
      effectiveModel,
      {
        maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
        responseFormat: { type: "json_object" },
      },
    );
  } catch (e) {
    // HTTP não-ok: mesmo silêncio do `if (!r.ok) return;` original — só
    // este caso específico não é reportado. Falha de rede/outro erro
    // propaga pro catch externo (reportAIFailure), igual antes.
    if (e instanceof LovableGatewayHttpError) return null;
    throw e;
  }

  // JSON.parse malformado NÃO é capturado aqui de propósito: propaga pro
  // catch externo (reportAIFailure/ai_failure_logs), igual ao comportamento
  // original pré-Fase 3 — só "sem chave" e "HTTP não-ok" são silenciados
  // (ver comentários acima), uma resposta malformada da IA avaliadora é sinal
  // de degradação que merece aparecer no log de falhas.
  const parsed = JSON.parse(raw || "{}") as { results?: RawCriterionResult[] };

  const rawResults = Array.isArray(parsed.results) ? parsed.results : [];
  const criteriaEvaluation: CriteriaEvaluationItem[] = rawResults.map((r, i) => ({
    criterion: typeof r?.criterion === "string" && r.criterion.trim().length > 0
      ? r.criterion.trim()
      : (criteriaList[i] ?? `criterio_${i + 1}`),
    met: r?.met === true,
    confidence: clampConfidence(r?.confidence),
    evidence: typeof r?.evidence === "string" ? r.evidence : "",
  }));

  const allMet = criteriaEvaluation.length >= criteriaList.length &&
    criteriaEvaluation.every((c) => c.met === true);
  const overallConfidence = criteriaEvaluation.length > 0
    ? clampConfidence(
      criteriaEvaluation.reduce((sum, c) => sum + c.confidence, 0) / criteriaEvaluation.length,
    )
    : 0;

  return { allMet, overallConfidence, criteriaEvaluation };
}

/** Defensivo: número fora de [0,1] ou ausente/inválido (NaN, string
 * não-numérica, campo faltando) vira 0 — nunca deixa uma confidence exótica
 * vazar para a banda de decisão. */
function clampConfidence(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

async function persistStageEvaluations(
  admin: SupabaseClient,
  params: {
    tenantId: string;
    dealId: string;
    dealStageId: string;
    evaluation: EvaluateAdvancementCriteriaResult;
    structuredSignals: Record<string, unknown>;
    sourceEventId: string | null;
    effectiveModel: string;
  },
): Promise<void> {
  const rows = params.evaluation.criteriaEvaluation.map((item, index) => ({
    tenant_id: params.tenantId,
    deal_id: params.dealId,
    stage_id: params.dealStageId,
    criterion_key: `criterion_${index + 1}`,
    criterion_label: item.criterion,
    status: item.met ? "met" : item.evidence.trim() ? "unmet" : "insufficient",
    confidence: item.confidence,
    evidence: item.evidence,
    structured_signals: params.structuredSignals,
    source_event_id: params.sourceEventId,
    model_version: params.effectiveModel,
    evaluated_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  }));
  if (rows.length === 0) return;

  const { error } = await admin
    .from("deal_stage_evaluations")
    .upsert(rows, { onConflict: "deal_id,stage_id,criterion_key" });
  if (error) throw new Error(`persistência dos critérios falhou: ${error.message}`);
}

interface ApplyStageAdvancementDecisionParams {
  tenantId: string;
  conversationId: string | null;
  dealId: string;
  dealStageId: string;
  overallConfidence: number;
  criteriaEvaluation: CriteriaEvaluationItem[];
  effectiveModel: string;
  stageGoal: string;
  structuredSignals: Record<string, unknown>;
  sourceEventId: string | null;
  triggerEvent: string;
  correlationId: string | null;
  promptSnapshot: Record<string, unknown> | null;
}

/**
 * Resolve a regra explícita e entrega a decisão à RPC única. A própria RPC
 * aplica shadow/assistido/autônomo, sinais estruturados, locks, cooldown,
 * circuit breaker, idempotência e auditoria.
 */
async function applyStageAdvancementDecision(
  admin: SupabaseClient,
  params: ApplyStageAdvancementDecisionParams,
): Promise<void> {
  const transition = await resolveNextStage(admin, params.dealStageId);
  if (!transition) return;

  const evidence = {
    conversation_id: params.conversationId,
    source_event_id: params.sourceEventId,
    signals: params.structuredSignals,
    criteria: params.criteriaEvaluation,
  };
  const idempotencyKey = params.sourceEventId
    ? [
      "pipeline",
      params.triggerEvent,
      params.sourceEventId,
      params.dealId,
    ].join(":")
    : [
      "pipeline",
      params.triggerEvent,
      params.conversationId ?? "no-source",
      params.dealId,
      params.dealStageId,
      transition.nextStageId,
    ].join(":");

  const { data, error } = await admin.rpc("transition_deal_stage", {
    p_deal_id: params.dealId,
    p_expected_stage_id: params.dealStageId,
    p_target_stage_id: transition.nextStageId,
    p_actor_type: "ai",
    p_actor_id: null,
    p_reason: "Critérios do estágio cumpridos pela avaliação da IA",
    p_evidence: evidence,
    p_confidence: params.overallConfidence,
    p_idempotency_key: idempotencyKey,
    p_model_version: params.effectiveModel,
    p_prompt_snapshot: params.promptSnapshot ?? {
      stage_goal: params.stageGoal,
    },
    p_criteria_evaluation: params.criteriaEvaluation,
    p_trigger_event: params.triggerEvent,
    p_correlation_id: params.correlationId,
    p_reversal_of_history_id: null,
  });
  if (error) throw new Error(`transition_deal_stage falhou: ${error.message}`);

  console.log("pipeline transition decision", {
    tenantId: params.tenantId,
    dealId: params.dealId,
    from: params.dealStageId,
    to: transition.nextStageId,
    result: data,
  });
}

interface StageTransition {
  nextStageId: string;
}

/**
 * Resolve somente regras explícitas. Configurações habilitadas pelo admin
 * vencem o default manual; ai_priority define o desempate e mantém o próximo
 * estágio como recomendação segura antes de qualquer opt-in.
 */
interface TargetStageEntryResult {
  admitted: boolean;
  targetStageId: string | null;
  reason: string | null;
}

/**
 * Avalia os critérios de ENTRADA do estágio de destino.
 *
 * Devolve `admitted: true` sem chamar o modelo quando não há destino resolvido
 * ou quando o destino não tem `entry_criteria` — é o que mantém a feature
 * inerte para quem não configurou nada, incluindo toda transição que já existia
 * antes desta coluna.
 *
 * Reaproveita `evaluateAdvancementCriteria` de propósito: o formato da lista é o
 * mesmo, e duplicar o parser/prompt criaria duas definições de "critério
 * cumprido" que divergiriam na primeira mudança.
 */
async function evaluateTargetStageEntry(
  admin: SupabaseClient,
  params: {
    tenantId: string;
    dealStageId: string;
    stageGoal: string;
    effectiveModel: string;
    history: Array<{ role: "user" | "assistant"; content: string }>;
    aiText: string;
  },
): Promise<TargetStageEntryResult> {
  const transition = await resolveNextStage(admin, params.dealStageId);
  if (!transition) return { admitted: true, targetStageId: null, reason: null };

  const { data: targetCfg, error } = await admin
    .from("stage_ai_config")
    .select("entry_criteria, stage_goal")
    .eq("tenant_id", params.tenantId)
    .eq("stage_id", transition.nextStageId)
    .maybeSingle();
  if (error) {
    // Falha de leitura NÃO barra o card: o comportamento sem esta feature era
    // avançar, e uma query instável não pode virar bloqueio silencioso do funil.
    console.error("[pipeline] query entry_criteria falhou:", error.message);
    return { admitted: true, targetStageId: transition.nextStageId, reason: null };
  }

  const raw = targetCfg?.entry_criteria as unknown;
  const entryCriteria = Array.isArray(raw)
    ? (raw as Array<string | { criterion?: string; description?: string; text?: string }>)
    : [];
  if (entryCriteria.length === 0) {
    return { admitted: true, targetStageId: transition.nextStageId, reason: null };
  }

  const evaluation = await evaluateAdvancementCriteria({
    stageAdvancement: entryCriteria,
    stageGoal: (targetCfg?.stage_goal ?? params.stageGoal ?? "").trim(),
    effectiveModel: params.effectiveModel,
    history: params.history,
    aiText: params.aiText,
  });
  // `null` = skip silencioso do avaliador (sem chave, HTTP não-ok). Mesmo
  // critério do caminho de avanço: skip não é reprovação.
  if (!evaluation) return { admitted: true, targetStageId: transition.nextStageId, reason: null };

  const naoCumpridos = evaluation.criteriaEvaluation
    .filter((c) => !c.met)
    .map((c) => c.criterion);

  return {
    admitted: evaluation.allMet,
    targetStageId: transition.nextStageId,
    reason: evaluation.allMet
      ? null
      : `Critérios de entrada do estágio de destino não cumpridos: ${naoCumpridos.join("; ")}`,
  };
}

async function resolveNextStage(
  admin: SupabaseClient,
  dealStageId: string,
): Promise<StageTransition | null> {
  const { data: transitions, error } = await admin
    .from("stage_transitions")
    .select("to_stage_id, autonomy_mode, ai_priority, created_at")
    .eq("from_stage_id", dealStageId)
    .eq("enabled", true)
    .order("ai_priority", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) {
    console.error("[pipeline] query stage_transitions falhou:", error.message);
    return null;
  }
  if (!transitions?.length) return null;

  const transition = [...transitions].sort((left, right) => {
    const leftManual = left.autonomy_mode === "manual" ? 1 : 0;
    const rightManual = right.autonomy_mode === "manual" ? 1 : 0;
    if (leftManual !== rightManual) return leftManual - rightManual;
    return Number(left.ai_priority ?? 100) - Number(right.ai_priority ?? 100);
  })[0];

  return { nextStageId: transition.to_stage_id as string };
}
