// notify-admin-handoff.ts — notifica administradores do tenant por e-mail
// quando uma conversa transita para awaiting_human=true (handoff para
// atendimento humano). Reusa weekly_report_recipients (channel="email") como
// lista de destinatários — tabela criada para o weekly digest (Fase 4 PR-B,
// 20260711100000_fase4_prb_weekly_digest_schema.sql), mas o schema
// (tenant_id, channel, address, active) serve igual para este alerta
// operacional; não duplicar tabela/coluna nova para isto.
//
// Chamado só na TRANSIÇÃO false→true de awaiting_human — cada call site
// (gates.ts/pipeline.ts/ai-respond/index.ts) já decide isso antes de chamar,
// comparando com o valor anterior que já tinha em mãos; esta função não
// verifica de novo a transição; canais simulados nunca enviam e-mail.
//
// Mesmo padrão defensivo de failure-log.ts/telemetry.ts: NUNCA lança — todo o
// corpo em try/catch aninhado. Uma falha de e-mail (credencial ausente,
// Resend fora do ar, query falhando) jamais pode derrubar o gate/pipeline
// principal de ai-respond que chama isto. Falhas são reportadas via
// captureEdgeError (system_events) — não ai_failure_logs (failure-log.ts),
// porque isto não é uma falha de provider de IA, é uma notificação
// operacional best-effort.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { loadSecrets, sendResend } from "./send-adapters.ts";
import { captureEdgeError } from "../telemetry.ts";

interface EmailRecipientRow {
  address: string;
}

// Throttle de flood: durante uma instabilidade do provider de IA a conversa
// pode oscilar false→true→false→true várias vezes em minutos, cada oscilação
// disparando um e-mail real (ver isNotifyCooldownActive abaixo). 15min é o
// mesmo teto informal já usado para o watchdog de SLA desta fase (Fase 3 —
// hitl_handoff_sla_events).
const HANDOFF_NOTIFY_COOLDOWN_MINUTES = 15;

async function reportNotifyFailure(
  supabase: SupabaseClient,
  params: {
    tenantId: string;
    conversationId: string;
    phase: "query" | "credentials" | "send" | "unexpected";
    message: string;
    severity?: "error" | "warn";
  },
): Promise<void> {
  await captureEdgeError(supabase, {
    severity: params.severity ?? "error",
    source: "edge",
    operation: "ai-respond.notify-admin-handoff",
    tenantId: params.tenantId,
    conversationId: params.conversationId,
    message: params.message,
    context: { phase: params.phase },
  });
}

/**
 * Throttle best-effort contra flood de e-mail: reusa hitl_handoff_sla_events
 * (Fase 3 — já populada pelo trigger trg_conversations_open_handoff toda vez
 * que awaiting_human vira true, ver migration
 * 20260710120000_fase3_hitl_decision_queue_schema.sql), sem tabela/coluna
 * nova. O UPDATE que causou ESTA chamada já rodou antes de notifyAdminHandoff
 * ser invocada — o trigger BEFORE UPDATE já inseriu a própria linha desta
 * transição, então "existe pelo menos 1 evento na janela" é sempre verdade
 * (é o próprio evento atual). Por isso o corte é `> 1`: só há cooldown ativo
 * quando existe outro evento além do atual dentro da janela.
 */
async function isNotifyCooldownActive(
  supabase: SupabaseClient,
  tenantId: string,
  conversationId: string,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - HANDOFF_NOTIFY_COOLDOWN_MINUTES * 60_000).toISOString();
  const { data, error } = await supabase
    .from("hitl_handoff_sla_events")
    .select("id")
    .eq("conversation_id", conversationId)
    .gt("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(2);

  if (error) {
    // Fail-open (diferente da query de destinatários abaixo, que é
    // fail-closed): isto é só um throttle de conveniência, não um gate de
    // segurança — melhor arriscar um e-mail a mais do que deixar o admin no
    // escuro por causa de uma falha nesta checagem best-effort.
    await reportNotifyFailure(supabase, {
      tenantId,
      conversationId,
      phase: "query",
      message: `Falha ao checar cooldown de notificação: ${error.message}`,
    });
    return false;
  }

  return (data ?? []).length > 1;
}

/**
 * Envia um e-mail de alerta para cada destinatário ativo (channel="email")
 * em weekly_report_recipients do tenant, avisando que uma conversa precisa
 * de atendimento humano.
 * Conversas simuladas mantêm o handoff local, sem notificação externa.
 *
 * Throttle: pula o envio (só loga) se já houver outro evento de handoff desta
 * conversa em hitl_handoff_sla_events dentro da janela de cooldown (ver
 * isNotifyCooldownActive) — protege contra flood de e-mail quando a conversa
 * oscila false→true→false→true durante uma instabilidade do provider de IA.
 *
 * Sem destinatário configurado, no-op silencioso (só um log informativo).
 * Nunca lança: qualquer falha (query, credencial do Resend ausente/errada,
 * envio) é capturada e reportada via captureEdgeError, nunca propagada ao
 * caller.
 */
export async function notifyAdminHandoff(
  supabase: SupabaseClient,
  tenantId: string,
  conversationId: string,
  reason: string,
): Promise<void> {
  try {
    const { data: conversation, error: channelError } = await supabase
      .from("conversations")
      .select(
        "channels:channels!conversations_channel_id_fkey(tenant_id, provider_slug, type)",
      )
      .eq("id", conversationId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    const linkedChannel = conversation?.channels;
    const channel = Array.isArray(linkedChannel) ? linkedChannel[0] : linkedChannel;
    if (channelError || !channel || channel.tenant_id !== tenantId) {
      await reportNotifyFailure(supabase, {
        tenantId,
        conversationId,
        phase: "query",
        message: channelError
          ? `Falha ao identificar o canal da conversa: ${channelError.message}`
          : "Canal da conversa não encontrado no tenant; notificação externa bloqueada.",
      });
      return;
    }
    if (channel.provider_slug === "simulator" || channel.type === "simulator") return;

    if (await isNotifyCooldownActive(supabase, tenantId, conversationId)) {
      console.log("[notifyAdminHandoff] cooldown ativo, pulando e-mail", {
        tenantId,
        conversationId,
        reason,
      });
      return;
    }

    const { data: recipients, error: queryErr } = await supabase
      .from("weekly_report_recipients")
      .select("address")
      .eq("tenant_id", tenantId)
      .eq("channel", "email")
      .eq("active", true);

    if (queryErr) {
      await reportNotifyFailure(supabase, {
        tenantId,
        conversationId,
        phase: "query",
        message: `Falha ao buscar destinatários de e-mail: ${queryErr.message}`,
      });
      return;
    }

    const emails = (recipients ?? []) as EmailRecipientRow[];
    if (emails.length === 0) {
      console.log("[notifyAdminHandoff] nenhum destinatário de e-mail ativo", {
        tenantId,
        conversationId,
      });
      return;
    }

    let cred: Record<string, string>;
    try {
      cred = await loadSecrets(supabase, tenantId, "resend");
    } catch (credErr) {
      await reportNotifyFailure(supabase, {
        tenantId,
        conversationId,
        phase: "credentials",
        message: credErr instanceof Error ? credErr.message : String(credErr),
      });
      return;
    }

    const subject = "Conversa aguardando atendimento humano";
    const body =
      `Uma conversa passou a aguardar atendimento humano.\n\n` +
      `Conversa: ${conversationId}\n` +
      `Motivo: ${reason}`;

    for (const recipient of emails) {
      try {
        const result = await sendResend(cred, recipient.address, body, subject);
        if (!result.ok) {
          await reportNotifyFailure(supabase, {
            tenantId,
            conversationId,
            phase: "send",
            severity: "warn",
            message: `Falha ao enviar e-mail de handoff para ${recipient.address}: ${
              result.error ?? "erro desconhecido"
            }`,
          });
        }
      } catch (sendErr) {
        await reportNotifyFailure(supabase, {
          tenantId,
          conversationId,
          phase: "send",
          message: `Exceção ao enviar e-mail de handoff para ${recipient.address}: ${
            sendErr instanceof Error ? sendErr.message : String(sendErr)
          }`,
        });
      }
    }
  } catch (outerErr) {
    // Swallow externo — garante que notifyAdminHandoff NUNCA lança, mesmo se
    // algo inesperado quebrar antes das etapas acima (ex.: params malformado).
    // Também via captureEdgeError (reportNotifyFailure nunca lança, mesmo
    // contrato de captureEdgeError em telemetry.ts) — o docstring desta
    // função promete isso sempre, não só console.error.
    console.error("[notifyAdminHandoff] erro inesperado:", outerErr);
    await reportNotifyFailure(supabase, {
      tenantId,
      conversationId,
      phase: "unexpected",
      message: outerErr instanceof Error ? outerErr.message : String(outerErr),
    });
  }
}
