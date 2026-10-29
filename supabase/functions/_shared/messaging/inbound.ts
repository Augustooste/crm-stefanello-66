import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { normalizePhone } from "./conversation.ts";
import { ensureContactIdentity, resolveContactIdentity } from "./contact-identity.ts";
import { isManyChatSlug } from "./manychat-client.ts";
import { captureEdgeError } from "../telemetry.ts";
import { AI_RESPONSE_CALLER_TIMEOUT_MS } from "../ai/execution-budget.ts";
import { RETRYABLE_GATE_REASONS } from "../ai/gates.ts";

// Canonical inbound shape. Every provider normalizer produces this.
export interface InboundMessage {
  provider:
    | "zapi"
    | "twilio"
    | "resend"
    | "meta-cloud"
    | "evolution"
    | "zappaz"
    | "telegram"
    | "discord"
    | "sms"
    | "email"
    | "push"
    | "manychat-whatsapp"
    | "manychat-instagram"
    | "simulator"
    | "manychat-messenger";
  external_id: string;
  from: string;
  to: string;
  content: string;
  // media.type é sempre um MIME type (ex.: "image/jpeg") — o inbox decide o render
  // por prefixo ("image/", "audio/"), então tokens genéricos como "image" quebram a UI.
  // `key`: mediaKey do protocolo nativo do WhatsApp (Baileys), presente só nos
  // providers não-oficiais. Vive apenas dentro desta requisição — é usada para
  // decifrar a mídia antes de persistir e nunca vai para o banco.
  // `base64`: arquivo já decifrado embutido no próprio webhook (Evolution Go
  // com WEBHOOK_FILES=true). Também vive só dentro desta requisição.
  media?: { url: string; type: string; key?: string; base64?: string };

  timestamp: string;
  fromMe: boolean;
  senderName?: string;
  subject?: string;
  // ManyChat: `from` é o subscriber_id; telefone/e-mail reais vêm à parte.
  contactPhone?: string;
  contactEmail?: string;
}
// Teto para o UPDATE de cancelamento de acompanhamento. O webhook responde ao
// provedor no fim do handler: sem teto, um banco lento segura a resposta até o
// provedor desistir e reentregar a mesma mensagem.
const CANCEL_NURTURE_TIMEOUT_MS = 5000;
/**
 * O contato respondeu — encerra as inscrições de acompanhamento automático
 * dele.
 *
 * Antes disso, responder não interrompia nada: a pessoa dizia "já comprei" ou
 * "pode parar" e continuava recebendo os passos seguintes da sequência no
 * cronograma normal. Para quem recebe, isso não é automação, é insistência de
 * robô — e é o caminho mais curto para o número ser denunciado.
 *
 * Inclui `sending` de propósito: se o worker está no meio do envio, o
 * cancelamento vale mesmo assim e o `advanceOrComplete` do runner (que barra a
 * escrita quando o status já é `cancelled`) não consegue reverter.
 *
 * Inclui `paused` de propósito também, e essa é a parte que surpreende: uma
 * pausa deliberada do operador é destruída pela resposta do contato, sem volta
 * (`cancelled` é terminal). A alternativa — respeitar a pausa — deixaria a
 * sequência retomar sozinha depois de alguém já ter dito "pode parar", que é o
 * problema que esta função existe para resolver. Decisão consciente: a resposta
 * do contato vence a pausa do operador.
 *
 * Best-effort: nunca lança. Uma falha aqui não pode derrubar o webhook de uma
 * mensagem que já foi persistida — mas fica registrada, porque "parou de
 * cancelar" é o tipo de regressão que ninguém percebe olhando a tela.
 */
export async function cancelNurtureOnReply(
  admin: SupabaseClient,
  tenantId: string,
  contactId: string,
): Promise<void> {
  try {
    const { data, error } = await admin
      .from("nurture_enrollments")
      // `completed_at` não é enfeite de auditoria: é o que segura a carência do
      // scanner de auto-inscrição. Sem essa data, a varredura seguinte
      // reinscreve quem acabou de pedir para parar.
      .update({
        status: "cancelled",
        completed_at: new Date().toISOString(),
        next_send_at: null,
      })
      .eq("tenant_id", tenantId)
      .eq("contact_id", contactId)
      .in("status", ["active", "paused", "sending"])
      .select("id")
      // Caminho crítico do webhook: banco lento não pode pendurar a resposta
      // ao provedor, que estoura o timeout dele e vira reentrega.
      .abortSignal(AbortSignal.timeout(CANCEL_NURTURE_TIMEOUT_MS));
    if (error) {
      await captureEdgeError(admin, {
        severity: "warn",
        source: "edge",
        operation: "nurture.cancel_on_reply",
        tenantId,
        message: `Falha ao encerrar acompanhamento após resposta: ${error.message}`,
        context: { contact_id: contactId },
      });
      return;
    }
    const encerradas = data?.length ?? 0;
    if (encerradas > 0) {
      await captureEdgeError(admin, {
        severity: "info",
        source: "edge",
        operation: "nurture.cancel_on_reply",
        tenantId,
        message: `Acompanhamento encerrado porque o contato respondeu (${encerradas}).`,
        context: { contact_id: contactId, encerradas },
      });
    }
  } catch (e) {
    // `captureEdgeError` nunca lança, então o único throw que chega aqui é o
    // fetch do PostgREST — exatamente o caso em que o cancelamento NÃO
    // aconteceu. Em `console.error` isso morria com o isolate: o evento não é
    // marcado como processado, o provedor reentrega, o dedupe devolve
    // `messageId: null` e ninguém retenta o cancelamento.
    await captureEdgeError(admin, {
      severity: "warn",
      source: "edge",
      operation: "nurture.cancel_on_reply",
      tenantId,
      message: `Cancelamento de acompanhamento lançou: ${
        e instanceof Error ? e.message : String(e)
      }`,
      stack: e instanceof Error ? (e.stack ?? null) : null,
      context: { contact_id: contactId },
    });
  }
}

// ------- Persist canonical InboundMessage -------
export async function persistInbound(
  admin: SupabaseClient,
  tenantId: string,
  channelId: string,
  channelType: string,
  providerSlug: string,
  msg: InboundMessage,
): Promise<{
  messageId: string | null;
  isContactInbound: boolean;
  contactId: string | null;
  conversationId?: string;
}> {
  // Dedupe by (tenant_id, external_id).
  //
  // HIGH (code review 2026-07-24, 05-silent-failures H1): o `error` era
  // descartado, então falha de banco devolvia `existing = null` — lido como
  // "mensagem nova". A mensagem entrava duplicada E `triggerAiRespond`
  // disparava de novo: o cliente recebia duas respostas da IA e o custo de LLM
  // dobrava. Em erro não dá para saber se é duplicata; lançar é o certo, porque
  // o catch de topo transforma isso em 503 e o provider reentrega — e a
  // reentrega é segura, `claimWebhookEvent` reserva o evento por
  // ON CONFLICT DO NOTHING.
  const { data: existing, error: dedupeError } = await admin
    .from("messages")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("external_id", msg.external_id)
    .maybeSingle();
  if (dedupeError) {
    // PGRST116 = a consulta casou MAIS DE UMA linha, ou seja, a duplicata
    // existe (provavelmente criada pelo próprio fail-open que este fix corrige).
    // Lançar aqui seria pior que o bug original: o erro é determinístico, cada
    // reentrega falharia igual, o teto de falhas consecutivas estouraria e o
    // canal inteiro do tenant iria para 'broken' por causa de um único
    // external_id envenenado — sem se recuperar sozinho, já que o contador só
    // zera num inbound bem-sucedido. Este caso é "é duplicata", não "não sei".
    if (dedupeError.code === "PGRST116") {
      console.error("dedupe: external_id com múltiplas linhas", {
        tenant: tenantId,
        external_id: msg.external_id,
      });
      return { messageId: null, isContactInbound: false, contactId: null };
    }
    // Diverge do `throw error` cru usado nas outras 5 leituras deste arquivo de
    // propósito: o catch de topo grava só `message` em system_events, e sem
    // dizer QUAL consulta falhou o evento não é acionável. O código do Postgres
    // vai junto para não perder o que o throw cru daria.
    throw new Error(
      `Falha ao checar duplicata de mensagem (${dedupeError.code}): ${dedupeError.message}`,
    );
  }
  if (existing) return { messageId: null, isContactInbound: false, contactId: null };

  // Contact identity depends on channel: whatsapp → phone, email → email.
  const rawIdentifier = msg.fromMe ? msg.to : msg.from;
  if (!rawIdentifier) return { messageId: null, isContactInbound: false, contactId: null };
  // Canonicaliza o telefone (E.164 "+<dígitos>") antes de casar/gravar em
  // contacts.phone, senão "+55 (11) 98765-4321" e "+5511987654321" criam
  // contatos diferentes a cada primeira mensagem inbound.
  // ManyChat endereça por subscriber_id em qualquer superfície — mesmo no
  // canal "whatsapp", `from` NÃO é telefone.
  const identityType = isManyChatSlug(providerSlug)
    ? "provider_user"
    : channelType === "whatsapp" || channelType === "sms"
    ? "phone"
    : channelType === "email"
    ? "email"
    : channelType === "push"
    ? "push_device"
    : "provider_user";
  const contactIdentifier = identityType === "phone"
    ? normalizePhone(rawIdentifier)
    : rawIdentifier.trim();
  if (!contactIdentifier) return { messageId: null, isContactInbound: false, contactId: null };

  let contactId: string | null = null;
  if (identityType === "phone" || identityType === "email") {
    const resolved = await resolveContactIdentity(admin, tenantId, identityType, contactIdentifier);
    contactId = resolved.contactId;
    // Contato fundido/removido (deleted_at) não deve "ressuscitar" recebendo
    // mensagem nova -- trata como não encontrado e cria um contato novo.
    // Roteamento pro sobrevivente do merge (merged_into_id) fica para a task de merge.
    if (!contactId) {
      const { data: inserted, error } = await admin
        .from("contacts")
        .insert({
          tenant_id: tenantId,
          name: msg.senderName || contactIdentifier,
          phone: identityType === "phone" ? contactIdentifier : null,
          email: identityType === "email" ? contactIdentifier.toLowerCase() : null,
          source: providerSlug,
        })
        .select("id")
        .single();
      if (error) throw error;
      contactId = inserted.id as string;
    }
    const identitySync = await ensureContactIdentity(admin, {
      tenantId,
      contactId,
      type: identityType,
      rawValue: contactIdentifier,
    });
    // Conflito = a identidade normalizada já está mapeada a OUTRO contato do
    // tenant. Antes o retorno era ignorado silenciosamente (a mensagem seguia
    // presa no contato recém-resolvido/criado sem sinal nenhum). Loga o
    // conflito para diagnóstico; a resolução (merge/roteamento) fica para a
    // task de merge de contatos.
    if (identitySync === "conflict") {
      console.warn(
        "[messaging-webhook] conflito de contact identity (identidade já mapeada a outro contato)",
        {
          tenant: tenantId,
          contactId,
          type: identityType,
        },
      );
    }
  } else {
    const resolved = await resolveContactIdentity(
      admin,
      tenantId,
      identityType,
      contactIdentifier,
      providerSlug,
    );
    contactId = resolved.contactId;
    // ManyChat: primeiro contato por este subscriber_id, mas a pessoa pode já
    // existir no CRM pelo telefone/e-mail que veio junto. Reaproveita em vez de
    // duplicar; o subscriber_id vira identidade extra do mesmo contato abaixo.
    if (!contactId && msg.contactPhone) {
      contactId = (await resolveContactIdentity(admin, tenantId, "phone", msg.contactPhone))
        .contactId;
    }
    if (!contactId && msg.contactEmail) {
      contactId = (await resolveContactIdentity(admin, tenantId, "email", msg.contactEmail))
        .contactId;
    }
    // Mesma lógica: contato fundido/removido não deve ressuscitar via e-mail novo.
    if (!contactId) {
      const { data: inserted, error } = await admin
        .from("contacts")
        .insert({
          tenant_id: tenantId,
          name: msg.senderName || msg.contactPhone || contactIdentifier,
          ...(msg.contactPhone ? { phone: normalizePhone(msg.contactPhone) } : {}),
          ...(msg.contactEmail ? { email: msg.contactEmail } : {}),
          source: providerSlug,
        })
        .select("id")
        .single();
      if (error) throw error;
      contactId = inserted.id as string;
    }
    const identitySync = await ensureContactIdentity(admin, {
      tenantId,
      contactId,
      type: identityType,
      rawValue: contactIdentifier,
      providerSlug,
    });
    if (identitySync === "conflict") {
      console.warn(
        "[messaging-webhook] conflito de contact identity (identidade já mapeada a outro contato)",
        {
          tenant: tenantId,
          contactId,
          type: identityType,
          providerSlug,
        },
      );
    }
  }
  if (!contactId) return { messageId: null, isContactInbound: false, contactId: null };

  // Backfill do nome quando o provider mandou `senderName` (ex.: profile.name
  // da Meta Cloud, PushName do Evolution, ProfileName do Twilio). O contato
  // pode ter sido criado por uma mensagem anterior SEM esse campo, ficando com
  // `name = telefone/e-mail`. Só sobrescreve quando o nome atual é vazio ou
  // igual ao identificador — nunca pisa em nome já editado no CRM.
  const senderName = (msg.senderName ?? "").trim();
  if (senderName && senderName !== contactIdentifier) {
    const { data: current } = await admin
      .from("contacts")
      .select("name")
      .eq("id", contactId)
      .maybeSingle();
    const currentName = (current?.name ?? "").trim();
    if (!currentName || currentName === contactIdentifier) {
      const { error: nameErr } = await admin
        .from("contacts")
        .update({ name: senderName })
        .eq("id", contactId);
      if (nameErr) {
        console.warn("[messaging-webhook] falha ao atualizar nome do contato", {
          tenant: tenantId,
          contactId,
          error: nameErr.message,
        });
      }
    }
  }

  // Find/create open conversation for (contact, channel).
  let conversationId: string | null = null;
  // HIGH (code review 2026-07-24, 05-silent-failures H2): o `error` desta
  // leitura era descartado, e `!conversationId` caía no INSERT abaixo — uma
  // falha transitória criava uma SEGUNDA conversa para o mesmo (contato,
  // canal). O histórico rachava em duas threads, a IA perdia o contexto e o
  // inbox mostrava duplicata. O INSERT logo abaixo já fazia `if (error) throw`;
  // a leitura é que estava desprotegida. Mesmo tratamento nos dois.
  const { data: conv, error: convError } = await admin
    .from("conversations")
    .select("id, deleted_at")
    .eq("tenant_id", tenantId)
    .eq("contact_id", contactId)
    .eq("channel_id", channelId)
    .in("status", ["open", "aberto", "active"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (convError) {
    throw new Error(`Falha ao buscar conversa aberta (${convError.code}): ${convError.message}`);
  }
  if (conv) conversationId = conv.id as string;
  if (!conversationId) {
    const { data: inserted, error } = await admin
      .from("conversations")
      .insert({
        tenant_id: tenantId,
        contact_id: contactId,
        channel_id: channelId,
        status: "open",
        ai_active: true,
        subject: msg.subject ?? null,
      })
      .select("id")
      .single();
    if (error) throw error;
    conversationId = inserted.id as string;
  } else {
    // Ressuscitar conversa soft-deletada: se o contato volta a mandar mensagem,
    // a conversa reaparece pro usuário (deleted_at → null). Só dispara o UPDATE
    // quando ela estava de fato excluída, evitando um write a cada mensagem de
    // conversa já ativa.
    if ((conv as { deleted_at?: string | null }).deleted_at) {
      await admin.from("conversations").update({ deleted_at: null }).eq("id", conversationId);
    }
    if (msg.subject) {
      await admin
        .from("conversations")
        .update({ subject: msg.subject })
        .eq("id", conversationId)
        .is("subject", null);
    }
  }

  const isContactInbound = !msg.fromMe;
  // Eco fromMe: quando o provider (Z-API/Evolution) reenvia como inbound uma
  // mensagem que NÓS mesmos acabamos de mandar (IA ou automação), o
  // normalizador marca sender='agent' — mas se o external_id do eco não bater
  // com o id retornado pela API de envio, `hasHumanResponded()` passaria a
  // devolver true para sempre e a IA congelaria naquela conversa. Antes de
  // gravar, procura mensagem outbound recente (sender in ('ai','automation'))
  // com conteúdo idêntico na mesma conversa e, se achar, reclassifica o eco
  // pra `sender` dela — assim `hasHumanResponded` continua enxergando só
  // atendentes reais.
  let effectiveSender: "agent" | "ai" | "automation" | "contact" = msg.fromMe ? "agent" : "contact";
  if (msg.fromMe && (msg.content ?? "").trim().length > 0) {
    const echoSinceIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: recentOutbound } = await admin
      .from("messages")
      .select("sender")
      .eq("conversation_id", conversationId)
      .eq("direction", "out")
      .in("sender", ["ai", "automation"])
      .eq("content", msg.content)
      .gte("created_at", echoSinceIso)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (recentOutbound?.sender === "ai" || recentOutbound?.sender === "automation") {
      effectiveSender = recentOutbound.sender as "ai" | "automation";
    }
  }
  const { data: newMsg, error: mErr } = await admin
    .from("messages")
    .insert({
      tenant_id: tenantId,
      conversation_id: conversationId,
      external_id: msg.external_id,
      sender: effectiveSender,
      direction: msg.fromMe ? "out" : "in",
      content: msg.content,
      media_url: msg.media?.url ?? null,
      media_type: msg.media?.type ?? null,
      status: "sent",
      created_at: msg.timestamp,
    })
    .select("id")
    .single();
  if (mErr) {
    if ((mErr as { code?: string }).code !== "23505") throw mErr;
    return { messageId: null, isContactInbound: false, contactId: null };
  }
  return { messageId: (newMsg?.id as string) ?? null, isContactInbound, contactId, conversationId };
}

export async function enqueueAIResponseJob(
  admin: SupabaseClient,
  tenantId: string,
  messageId: string,
): Promise<{ jobId: string; shouldDispatch: boolean }> {
  const { data, error } = await admin.rpc("enqueue_ai_response_job", {
    p_tenant_id: tenantId,
    p_message_id: messageId,
  });
  if (error) throw new Error(`Falha ao enfileirar resposta da IA: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as
    | { job_id?: unknown; should_dispatch?: unknown }
    | null;
  if (typeof row?.job_id !== "string") {
    throw new Error("RPC enqueue_ai_response_job devolveu resposta inválida");
  }
  return { jobId: row.job_id, shouldDispatch: row.should_dispatch === true };
}

export async function isDurableAIQueueEnabled(
  admin: SupabaseClient,
  tenantId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("tenant_ai_features")
    .select("enabled")
    .eq("tenant_id", tenantId)
    .eq("feature_key", "durable_ai_response_queue")
    .maybeSingle();
  if (error) {
    console.error("messaging-webhook durable queue flag failed", {
      tenantId,
      error: error.message,
      fallback: "dispatch_direto",
    });
    return false;
  }
  return data?.enabled === true;
}

async function patchAIResponseJob(
  admin: SupabaseClient,
  jobId: string,
  patch: Record<string, unknown>,
): Promise<string | null> {
  const { error } = await admin.from("job_queue").update(patch).eq("id", jobId);
  return error?.message ?? null;
}

export async function triggerAiRespond(
  admin: SupabaseClient,
  supabaseUrl: string,
  serviceRole: string,
  tenantId: string,
  messageId: string,
  jobId: string,
): Promise<void> {
  const startError = await patchAIResponseJob(admin, jobId, {
    status: "running",
    started_at: new Date().toISOString(),
    finished_at: null,
    attempts: 1,
    error: null,
  });
  if (startError) {
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "messaging-webhook.ai_job_start",
      tenantId,
      message: startError,
      context: { job_id: jobId, message_id: messageId },
    });
    return;
  }

  try {
    const r = await fetch(`${supabaseUrl}/functions/v1/ai-respond`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceRole}`,
      },
      body: JSON.stringify({ message_id: messageId }),
      signal: AbortSignal.timeout(AI_RESPONSE_CALLER_TIMEOUT_MS),
    });
    const body = await r.text().catch(() => "");
    // HIGH (code review 2026-07-24, 05-silent-failures H6): só a rejeição de
    // rede era capturada; `r.ok` nunca era checado. `ai-respond` devolvendo
    // 500/429/401 ficava indistinguível de sucesso — o cliente não recebia
    // resposta, o log do webhook ficava limpo, e a investigação começava no
    // lugar errado.
    if (!r.ok) {
      throw new Error(`ai-respond HTTP ${r.status}: ${body.slice(0, 500)}`);
    }
    let responseBody: { ok?: unknown; reason?: unknown } | null = null;
    try {
      responseBody = JSON.parse(body) as { ok?: unknown; reason?: unknown };
    } catch {
      responseBody = null;
    }
    // Lista única em `_shared/ai/gates.ts` — ver `RETRYABLE_GATE_REASONS`. A
    // cópia local que vivia aqui ficou para trás quando o `05·H2` criou
    // `ai_settings_unavailable`, e o job era marcado como sucesso com o lead sem
    // resposta nenhuma (achado `12 · H1`).
    if (
      responseBody?.ok === false &&
      typeof responseBody.reason === "string" &&
      RETRYABLE_GATE_REASONS.has(responseBody.reason)
    ) {
      throw new Error(`ai-respond adiou processamento: ${responseBody.reason}`);
    }
    const completionError = await patchAIResponseJob(admin, jobId, {
      status: "success",
      finished_at: new Date().toISOString(),
      error: null,
    });
    if (completionError) throw new Error(`Falha ao concluir job da IA: ${completionError}`);
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    console.error("ai-respond invoke failed", { messageId, jobId, err: errorMessage });
    const retryError = await patchAIResponseJob(admin, jobId, {
      status: "pending",
      scheduled_for: new Date(Date.now() + 30_000).toISOString(),
      started_at: null,
      finished_at: null,
      error: errorMessage.slice(0, 2_000),
    });
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "messaging-webhook.ai_dispatch",
      tenantId,
      message: errorMessage,
      context: {
        job_id: jobId,
        message_id: messageId,
        retry_persist_error: retryError,
      },
    });
  }
}

// Keep background work alive after we return the response. On Supabase Edge the
// isolate can be recycled once the handler responds, dropping an un-awaited
// promise; EdgeRuntime.waitUntil defers recycling until it settles. Falls back
// to plain fire-and-forget off-platform (e.g. local dev).
export async function runInBackground(promise: Promise<unknown>): Promise<void> {
  const edge = (
    globalThis as {
      EdgeRuntime?: { waitUntil(p: Promise<unknown>): void };
    }
  ).EdgeRuntime;
  if (edge) {
    edge.waitUntil(promise);
  } else {
    await promise;
  }
}
