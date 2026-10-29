// Outbound send: called from the app (authenticated user) to deliver a message
// through the provider configured on the conversation's channel.
// Providers: allowlist canônica SUPPORTED_PROVIDER_SLUGS (provider-send.ts).
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import {
  loadProviderSecrets,
  NETWORK_MSG,
  isSupportedProviderSlug,
  sendViaProvider,
} from "../_shared/messaging/provider-send.ts";
import { resolveProviderDestination } from "../_shared/messaging/contact-identity.ts";
import { redactSecrets } from "../_shared/redact-secrets.ts";
import { estimateProviderCostMicros } from "../_shared/messaging/router.ts";
import { computeBackoffMs, sleep } from "../_shared/backoff.ts";
import { captureEdgeError } from "../_shared/telemetry.ts";
import { loadProfileOrFail, PROFILE_DB_ERROR_MESSAGE } from "../_shared/load-profile.ts";

const MAX_SEND_ATTEMPTS = 3;

function isTransientNetworkError(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e ?? "")).toLowerCase();
  return (
    m.includes("timeout") ||
    m.includes("network") ||
    m.includes("failed to fetch") ||
    m.includes("connection") ||
    m.includes("econn") ||
    m.includes("dns")
  );
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

interface Body {
  conversation_id: string;
  content: string;
  // Quando presente, envia uma mensagem já salva com status='draft' em vez de criar nova.
  draft_message_id?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;

  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  });
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json(401, { error: "Não autenticado." });

  const prof = await loadProfileOrFail(admin, userData.user.id, {
    operation: "messaging.send.load_profile",
  });
  if (!prof.ok) {
    if (prof.reason === "db_error") return json(503, { error: PROFILE_DB_ERROR_MESSAGE });
    return json(403, { error: "Perfil não encontrado." });
  }
  const tenantId = prof.tenantId;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json(400, { error: "Corpo inválido." });
  }
  let content = (body.content ?? "").trim();
  if (!body.conversation_id || (!content && !body.draft_message_id)) {
    return json(400, { error: "Conversa e mensagem são obrigatórias." });
  }

  // HIGH (code review 2026-07-24, 05-silent-failures H14): o `error` era
  // descartado e qualquer falha de banco virava 404 "Conversa não encontrada" —
  // o operador via isso numa conversa aberta na tela dele, e o suporte ia
  // investigar dado corrompido quando a causa era indisponibilidade. 404 fica
  // para o caso real de conversa inexistente ou de outro tenant.
  const { data: conv, error: convError } = await admin
    .from("conversations")
    .select(
      "id, tenant_id, contact_id, channel_id, subject, channels:channels!conversations_channel_id_fkey(provider_slug, type, status)",
    )
    .eq("id", body.conversation_id)
    .maybeSingle();
  if (convError) {
    console.error("messaging-send: falha ao carregar conversa", {
      conversationId: body.conversation_id,
      err: convError.message,
    });
    return json(503, { error: "Instabilidade ao acessar a conversa. Tente de novo." });
  }
  if (!conv || conv.tenant_id !== tenantId) return json(404, { error: "Conversa não encontrada." });

  const channels = (
    conv as unknown as { channels?: { provider_slug: string; type: string; status: string } }
  ).channels;
  const providerSlug = channels?.provider_slug ?? "";
  const channelType = channels?.type ?? "";
  if (!isSupportedProviderSlug(providerSlug)) {
    return json(400, { error: "Canal desta conversa não é suportado para envio externo." });
  }
  if (channels?.status !== "connected") {
    return json(400, {
      error: "O canal desta conversa está inativo. Reative o canal antes de enviar.",
    });
  }

  // A integração do provider precisa estar conectada/ativa para este tenant.
  const { data: integration } = await admin
    .from("tenant_integrations")
    .select("status")
    .eq("tenant_id", tenantId)
    .eq("slug", providerSlug)
    .maybeSingle();
  if (!integration || integration.status !== "active") {
    return json(400, {
      error:
        "A integração deste canal não está conectada. Reconecte em Integrações antes de enviar.",
    });
  }

  const { data: contact } = await admin
    .from("contacts")
    .select("phone, email")
    .eq("id", conv.contact_id as string)
    .is("deleted_at", null)
    .maybeSingle();

  // Destino por identidade (ManyChat: subscriber_id; telegram/discord/...:
  // provider_user). Resolvido ANTES de gravar a mensagem pendente: sem destino
  // não há o que enviar, e o operador precisa ver o motivo, não uma bolha presa.
  const destination = await resolveProviderDestination(admin, {
    tenantId,
    contactId: conv.contact_id as string,
    providerSlug,
  });
  if (!destination.ok) return json(200, { ok: false, error: destination.error });
  const channelDestination = destination.destination;

  // Compose subject for email replies.
  let subject = "";
  if (providerSlug === "resend") {
    const base = (conv as { subject?: string | null }).subject ?? "";
    // If there are prior messages, treat as reply.
    const { count } = await admin
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", body.conversation_id);
    if (base) {
      subject = /^re:\s/i.test(base) || !count ? base : `Re: ${base}`;
    } else {
      subject = "Nova mensagem";
    }
  }

  let messageId: string;
  if (body.draft_message_id) {
    // Reaproveita a mensagem draft existente em vez de criar uma nova. O
    // "claim" é a própria UPDATE condicionada a status='draft': se dois
    // cliques (ex.: "Aprovar e enviar" na bolha + "Enviar draft" no card de
    // próxima ação) chegarem em corrida, só o primeiro encontra a linha ainda
    // em 'draft' e a atualiza — o segundo recebe 0 linhas de volta e é tratado
    // como "já reivindicado" em vez de reenviar ao provider.
    const { data: claimed, error: claimErr } = await admin
      .from("messages")
      .update({ status: "sending" })
      .eq("id", body.draft_message_id)
      .eq("tenant_id", tenantId)
      .eq("conversation_id", body.conversation_id)
      .eq("status", "draft")
      .select("id, content")
      .maybeSingle();
    if (claimErr) return json(500, { error: "Não foi possível reivindicar o rascunho." });
    if (!claimed) {
      return json(409, { ok: false, error: "Este rascunho já foi enviado ou descartado." });
    }
    content = String(claimed.content ?? "").trim();
    if (!content) {
      await admin
        .from("messages")
        .update({ status: "failed", send_error: "Rascunho sem conteúdo." })
        .eq("id", claimed.id as string);
      return json(400, { error: "Rascunho sem conteúdo para enviar." });
    }
    messageId = claimed.id as string;
  } else {
    // Insert pending message first so the UI shows the bubble immediately.
    const { data: pending, error: pErr } = await admin
      .from("messages")
      .insert({
        tenant_id: tenantId,
        conversation_id: body.conversation_id,
        sender: "agent",
        direction: "out",
        content,
        status: "pending",
      })
      .select("id")
      .single();
    if (pErr) return json(500, { error: "Não foi possível salvar a mensagem." });
    messageId = pending.id as string;

    // Manual human message → always pause AI on this conversation. Reactivation is
    // only via explicit click by the agent in the inbox (never auto).
    //
    // Fica DENTRO deste ramo de propósito: aprovar um rascunho da IA não é uma
    // mensagem humana. Quando isto rodava fora do if/else, o modo send_mode='draft'
    // gerava exatamente um rascunho por conversa na vida — o primeiro aprovado
    // desligava a IA e nenhum outro era gerado.
    const { error: pausaErr } = await admin
      .from("conversations")
      .update({ ai_active: false, awaiting_human: false })
      .eq("id", body.conversation_id);
    if (pausaErr) {
      // Não aborta o envio: a mensagem do atendente vale mais que a pausa. Mas
      // registra, porque uma pausa que não gravou significa IA respondendo por
      // cima de um humano na próxima mensagem do lead.
      await captureEdgeError(admin, {
        severity: "error",
        source: "edge",
        operation: "messaging.send.pausar_ia",
        tenantId,
        conversationId: body.conversation_id,
        message: `Falha ao pausar a IA após mensagem manual: ${pausaErr.message}`,
        context: { conversation_id: body.conversation_id },
      });
    }
  }


  const cred = await loadProviderSecrets(admin, tenantId, providerSlug);
  // `external_id` precisa aceitar null: é assim que `SendResult` o declara
  // (provider-send.ts:32). Com `string | undefined` o `result = r` abaixo não
  // compila, e o `deno check` deste arquivo estava vermelho desde antes desta
  // rodada — ou seja, nenhuma correção feita aqui era type-checked.
  let result: { ok: boolean; error?: string; external_id?: string | null } | null = null;
  let lastErrorMsg: string | null = null;
  let attempt = 0;
  for (attempt = 0; attempt < MAX_SEND_ATTEMPTS; attempt++) {
    try {
      // já validado contra a allowlist de providers suportados acima.
      const r = await sendViaProvider({
        admin,
        providerSlug,
        cred,
        phone: contact?.phone ?? undefined,
        email: contact?.email ?? undefined,
        content,
        subject,
        destination: channelDestination,
      });
      result = r;
      lastErrorMsg = r.ok ? null : (r.error ?? null);
      // Só retentamos falhas transitórias de nível de rede. `{ ok: false }`
      // do adapter é erro de API (credenciais, número inválido, template
      // rejeitado): retry não muda o resultado e gera duplicata no provider.
      break;
    } catch (e) {
      lastErrorMsg = redactSecrets((e as Error).message);
      if (!isTransientNetworkError(e) || attempt === MAX_SEND_ATTEMPTS - 1) {
        result = { ok: false, error: NETWORK_MSG };
        break;
      }
      await sleep(computeBackoffMs(attempt));
    }
  }

  const attempts = attempt + 1;
  if (!result || !result.ok) {
    const friendly = result?.error ?? NETWORK_MSG;
    // Mesmo motivo do bloco de sucesso mais abaixo: se este UPDATE falhar, a
    // linha fica presa em `sending` (não existe reaper de `sending` em
    // migration nenhuma). Aqui não há evento novo — o incidente já vira
    // system_events logo abaixo; só anexamos se o status chegou ao banco.
    const { error: falhaPersistErr } = await admin
      .from("messages")
      .update({
        status: "failed",
        send_error: friendly,
        send_attempts: attempts,
        last_attempt_error: lastErrorMsg,
      })
      .eq("id", messageId);
    // Registra o incidente em system_events — a RPC get_integration_health_alerts
    // agrega esses eventos por provider_slug pra emitir o alerta na UI depois
    // de 3+ falhas em 15 min. `context.provider_slug` é o campo que a RPC
    // procura; não renomear sem atualizar lá também.
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: `messaging.send.${providerSlug}`,
      tenantId,
      conversationId: body.conversation_id,
      message: `Falha ao enviar mensagem via ${providerSlug} após ${attempts} tentativa(s).`,
      context: {
        provider_slug: providerSlug,
        attempts,
        last_error: lastErrorMsg,
        status_persistido: !falhaPersistErr,
        erro_persistencia: falhaPersistErr?.message ?? null,
      },
    });
    console.error("messaging-send error", providerSlug, redactSecrets(friendly));
    return json(200, { ok: false, error: friendly });
  }

  // Persist subject on first outbound email of a new thread.
  if (providerSlug === "resend") {
    const currentSubject = (conv as { subject?: string | null }).subject ?? null;
    if (!currentSubject && subject) {
      await admin.from("conversations").update({ subject }).eq("id", body.conversation_id);
    }
  }

  // O provider JÁ entregou a mensagem. Se este UPDATE falhar e ninguém olhar,
  // a linha fica em `sending` PARA SEMPRE (não existe reaper de `sending` em
  // migration nenhuma), `external_id` nunca é persistido e a UI mostra a
  // mensagem como não enviada — o atendente reenvia na mão e o cliente recebe
  // duas vezes. Uma retentativa cobre o blip transitório; o que sobrar vira
  // telemetria + aviso no retorno. NUNCA `ok:false` aqui: o envio deu certo, e
  // `_app.inbox.tsx:249` transforma `ok:false` em erro na tela, que é
  // exatamente o gatilho do reenvio duplicado que este fix existe pra evitar.
  const sentPatch = {
    status: "sent",
    external_id: result.external_id ?? null,
    send_error: null,
    send_attempts: attempts,
    last_attempt_error: null,
  };
  let statusPersistErr: string | null = null;
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const { error: sentErr } = await admin
      .from("messages")
      .update(sentPatch)
      .eq("id", messageId);
    statusPersistErr = sentErr?.message ?? null;
    if (!statusPersistErr) break;
    if (tentativa === 0) await sleep(computeBackoffMs(0));
  }
  if (statusPersistErr) {
    console.error(
      "messaging-send status-persist error",
      providerSlug,
      redactSecrets(statusPersistErr),
    );
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "messaging.send.persistir_status_enviado",
      tenantId,
      conversationId: body.conversation_id,
      message:
        `Mensagem entregue por ${providerSlug}, mas o status não foi salvo: ${statusPersistErr}`,
      context: {
        provider_slug: providerSlug,
        message_id: messageId,
        external_id: result.external_id ?? null,
        attempts,
      },
    });
  }

  // Ledger de metering em try/catch PRÓPRIO: a mensagem JÁ foi entregue pelo
  // provider e marcada como `sent`. Uma falha ao gravar o evento de uso (blip
  // de rede, RLS) NUNCA pode reverter o status para `failed` — o cliente já
  // recebeu a mensagem, e reverter faria o app reenviar (mensagem duplicada).
  // Só logamos, para não perder o evento silenciosamente (subfaturamento).
  // idempotency_key torna o retry seguro via índice único parcial da tabela.
  try {
    const { error: usageErr } = await admin.from("communication_usage_events").insert({
      tenant_id: tenantId,
      message_id: messageId,
      provider_slug: providerSlug,
      event_type: "message.sent",
      units: 1,
      estimated_cost_micros: estimateProviderCostMicros(providerSlug),
      idempotency_key: `${messageId}:message.sent`,
      metadata: { sandbox: String(result.external_id ?? "").startsWith("sandbox:") },
    });
    // 23505 = violação do índice único de idempotência (retry do mesmo evento):
    // é a guarda funcionando, não um erro — não polui o log.
    if (usageErr && (usageErr as { code?: string }).code !== "23505") {
      console.error("messaging-send usage-ledger error", providerSlug, redactSecrets(usageErr.message));
    }
  } catch (ledgerErr) {
    console.error(
      "messaging-send usage-ledger exception",
      providerSlug,
      redactSecrets((ledgerErr as Error).message),
    );
  }

  return json(200, {
    ok: true,
    id: messageId,
    status_persistido: statusPersistErr === null,
    ...(statusPersistErr
      ? {
        aviso:
          "Mensagem entregue ao destinatário, mas não foi possível salvar o status. NÃO reenvie: a tela pode continuar mostrando 'enviando'.",
      }
      : {}),
  });
});
