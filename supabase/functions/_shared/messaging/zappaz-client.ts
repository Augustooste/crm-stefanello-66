// zappaz-client.ts — cliente da Zappaz API (WhatsApp não-oficial), Fase 6.
//
// Segue o mesmo padrão funcional dos outros providers (Deno-puro, sem npm/CDN,
// SendResult reaproveitado de provider-send.ts). Endpoints usados vêm de
// https://docs.zappaz.io/api-reference:
//   - GET  /session/{sessionId}                 → check session (teste de conexão)
//   - POST /session/{sessionId}/message/text    → envio de texto
//   - POST /session/{sessionId}/webhook         → registra URL de webhook
//
// Auth: header `Authorization: <api-key>` (chave opaca, SEM prefixo `Bearer`,
// exatamente como documentado no OpenAPI da Zappaz — securitySchemes.bearerAuth
// é do tipo apiKey/header, o rótulo "bearer" no nome é enganoso).

import type { SendResult } from "./provider-send.ts";
import { redactSecrets } from "../redact-secrets.ts";

export interface ZappazCredentials {
  api_key: string;
  session_id: string;
}

const BASE_URL = "https://api.zappaz.io/api/v1";

// Teto de cada chamada à Zappaz. Nenhum dos 3 fetch daqui tinha deadline: um
// host que aceita a conexão e nunca responde (ou entrega o header e segura o
// corpo) prendia a edge function até o wall-clock da plataforma. `sendZappazText`
// é o caso grave — roda dentro do lock de conversa do ai-respond, e o claim em
// ai_processing_log não tem TTL nem delete, então isolate morto = mensagem
// daquele lead nunca mais reprocessada.
//
// 15s é o valor de POST de texto já usado em provider-send.ts e
// evolution-client.ts; nenhuma chamada daqui carrega mídia.
//
// AbortSignal.timeout (e não AbortController + clearTimeout manual) de
// propósito: o deadline continua valendo durante `r.json()`/`r.text()`, que é
// exatamente o buraco corrigido no commit 5219925.
const ZAPPAZ_TIMEOUT_MS = 15_000;

function authHeaders(api_key: string): HeadersInit {
  return { Authorization: api_key, "Content-Type": "application/json" };
}

/**
 * Motivo da falha, para quem precisa decidir se o estado é DEFINITIVO
 * (credencial/sessão inválida — pode marcar o canal como desconectado) ou
 * TRANSITÓRIO (rede/5xx — não deve sobrescrever status). O reconcile
 * (messaging-channels-reconcile/runner.ts) depende dessa distinção; o
 * connect interativo continua usando só `error`.
 */
export type ZappazCheckCode = "invalid_key" | "invalid_session" | "network";

export type ZappazCheckResult =
  | { ok: true }
  | { ok: false; error: string; code: ZappazCheckCode };

/** Testa credenciais + existência da sessão. */
export async function checkZappazSession(
  cred: ZappazCredentials,
): Promise<ZappazCheckResult> {
  const { api_key, session_id } = cred;
  const badKey = "API Key inválida — gere uma nova no painel da Zappaz.";
  const badSession =
    "Session ID não encontrada — confira o identificador da sessão no painel da Zappaz.";
  const unreachable = "Não conseguimos falar com a Zappaz agora — tente novamente em instantes.";
  try {
    const r = await fetch(
      `${BASE_URL}/session/${encodeURIComponent(session_id)}`,
      { headers: { Authorization: api_key }, signal: AbortSignal.timeout(ZAPPAZ_TIMEOUT_MS) },
    );
    if (r.status === 401 || r.status === 403) {
      return { ok: false, error: badKey, code: "invalid_key" };
    }
    if (r.status === 404) return { ok: false, error: badSession, code: "invalid_session" };
    if (!r.ok) return { ok: false, error: unreachable, code: "network" };
    return { ok: true };
  } catch (e) {
    // Deno lança TypeError tanto para header inválido quanto para queda de
    // rede. Distinguir importa: `invalid_key` é DEFINITIVO (o reconcile marca
    // o canal como desconectado), `network` é transitório. Só classificamos
    // como credencial inválida quando a própria string tem caractere ilegal
    // de header — caso contrário é rede.
    if (e instanceof TypeError && /[\r\n\t]|^\s|\s$|[^\x20-\x7e]/.test(api_key)) {
      return {
        ok: false,
        error:
          "A API Key ou o Session ID tem caractere inválido (quebra de linha ou espaço). Copie e cole novamente sem espaços extras.",
        code: "invalid_key",
      };
    }
    return { ok: false, error: unreachable, code: "network" };
  }
}

/** Envia mensagem de texto. Devolve SendResult (idem outros providers). */
export async function sendZappazText(
  cred: ZappazCredentials,
  phoneDigits: string,
  content: string,
): Promise<SendResult> {
  const { api_key, session_id } = cred;
  if (!api_key || !session_id) {
    return { ok: false, error: "Integração Zappaz não configurada." };
  }
  if (!phoneDigits) return { ok: false, error: "Número do contato inválido." };
  try {
    const r = await fetch(
      `${BASE_URL}/session/${encodeURIComponent(session_id)}/message/text`,
      {
        method: "POST",
        headers: authHeaders(api_key),
        body: JSON.stringify({ number: phoneDigits, message: content }),
        signal: AbortSignal.timeout(ZAPPAZ_TIMEOUT_MS),
      },
    );
    if (r.status === 401 || r.status === 403) {
      return {
        ok: false,
        error:
          "Credenciais da Zappaz não estão mais válidas. Reconecte a integração.",
      };
    }
    if (r.status === 404) {
      return {
        ok: false,
        error:
          "Sessão da Zappaz não encontrada — reconecte a integração e escaneie o QR novamente.",
      };
    }
    if (r.status === 429) {
      return { ok: false, error: "A Zappaz pediu para aguardar antes de enviar de novo." };
    }
    if (r.status >= 500) {
      return { ok: false, error: "A Zappaz está indisponível no momento. Tente de novo em instantes." };
    }
    if (!r.ok) {
      // Os 4 ramos acima já cobrem os status conhecidos (401/403/404/429/5xx).
      // Este é o fallback para o desconhecido (400/402/403 fora do teste de
      // credencial/422 etc.) — aqui o status e o corpo são justamente a única
      // pista do motivo real, e antes eram descartados: a mensagem genérica
      // virava reason_detail em channel_status_events sem nada aproveitável
      // (achado do plano de observabilidade, 2026-08-04). Corpo redigido
      // (pode ecoar dado sensível do payload) e truncado em 300 chars.
      const body = await r.text().catch(() => "");
      const detail = redactSecrets(body).slice(0, 300);
      return {
        ok: false,
        error: `Não foi possível enviar a mensagem (HTTP ${r.status})${detail ? `: ${detail}` : ""}.`,
      };
    }
    const data = await r.json().catch(() => ({}) as Record<string, unknown>);
    // HTTP 200 não é sucesso aqui: o `MessageResponse` do OpenAPI da Zappaz é
    // `{ status: "success" | "failed", data }`, e o 200-com-failed passava como
    // enviado — a mensagem ficava `sent` no inbox sem nunca ter saído.
    if (typeof data.status === "string" && data.status.toLowerCase() === "failed") {
      const detail = typeof data.message === "string" ? redactSecrets(data.message).slice(0, 200) : "";
      return {
        ok: false,
        error: `A Zappaz recusou o envio${detail ? `: ${detail}` : "."}`,
      };
    }
    // O id da mensagem vem DENTRO do envelope (`data.data`); os fallbacks de
    // raiz ficam para variação de versão da API. Sem isto o external_id nascia
    // null e o recibo de entrega não tinha em que casar.
    const payload = (typeof data.data === "object" && data.data !== null ? data.data : data) as Record<
      string,
      unknown
    >;
    const externalId =
      (payload.messageId as string | undefined) ??
      ((payload.key as { id?: string } | undefined)?.id) ??
      (payload.id as string | undefined) ??
      (data.messageId as string | undefined) ??
      ((data.key as { id?: string } | undefined)?.id) ??
      (data.id as string | undefined) ??
      null;
    return { ok: true, external_id: externalId };
  } catch (e) {
    if (e instanceof TypeError) {
      return { ok: false, error: "Credenciais com caractere inválido. Reconecte a integração." };
    }
    throw e;
  }
}

/**
 * Registra a URL de webhook desta app na sessão Zappaz, com um custom header
 * `x-webhook-secret` que o webhook receiver valida em tempo constante — mesmo
 * padrão de "2º fator" usado por outros providers.
 *
 * Best-effort: falha aqui NÃO deve impedir o connect, porque o admin ainda pode
 * cadastrar o webhook manualmente no painel. Log fica em console.warn.
 */
export async function registerZappazWebhook(
  cred: ZappazCredentials,
  callbackUrl: string,
  webhookSecret: string,
): Promise<{ ok: boolean; error?: string }> {
  const { api_key, session_id } = cred;
  try {
    const r = await fetch(
      `${BASE_URL}/session/${encodeURIComponent(session_id)}/webhook`,
      {
        method: "POST",
        headers: authHeaders(api_key),
        body: JSON.stringify({
          url: callbackUrl,
          displayName: "AceleraFlow CRM",
          enabled: true,
          events: {
            "inbound-message.upsert": true,
            "outbound-message.upsert": true,
            "message-receipt.update": true,
            "connection.update": true,
          },
          headers: { "x-webhook-secret": webhookSecret },
        }),
        signal: AbortSignal.timeout(ZAPPAZ_TIMEOUT_MS),
      },
    );
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      console.warn("[zappaz] registerWebhook failed", { status: r.status, body: body.slice(0, 200) });
      return { ok: false, error: `HTTP ${r.status}` };
    }
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[zappaz] registerWebhook exception", { msg });
    return { ok: false, error: msg };
  }
}
