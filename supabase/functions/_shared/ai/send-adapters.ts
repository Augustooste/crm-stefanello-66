// send-adapters.ts — o que sobrou do módulo de envio do auto-envio de
// ai-respond: `sendResend` (e-mail do handoff para admin) e `loadSecrets`.
//
// A duplicação que este arquivo carregava ACABOU. Ele nasceu como mirror de
// messaging-send/index.ts com quatro adaptadores (zapi/twilio/meta-cloud/
// resend), e o header antigo registrava que unificar com o canônico ficaria
// para depois. Enquanto isso, `_shared/messaging/provider-send.ts` virou o
// despacho canônico por provider (`switch (slug)`) e absorveu todos eles —
// `_shared/ai/send-dispatch.ts` já roteia por lá. Os três adaptadores daqui
// ficaram sem nenhum importador e foram removidos.
//
// Por que `sendResend` continua: `_shared/ai/notify-admin-handoff.ts` importa
// ele diretamente, fora do caminho de `sendViaProvider`. Migrar esse caller
// para o canônico é a próxima etapa da unificação, e aí este arquivo some.
//
// `friendlyHttp` deixou de ser exportado junto com os adaptadores: nada fora
// daqui o importava, só `resendHttpError` o usa. O `friendlyHttp` que os
// outros providers usam é o de provider-send.ts, que é outra função.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { redactSecrets } from "../redact-secrets.ts";

export type SendResult = { ok: boolean; external_id?: string | null; error?: string };

// Teto do único fetch que restou aqui. O gêmeo dele em provider-send.ts ganhou
// deadline no commit 7e0e6ff e este ficou de fora por viver noutro arquivo —
// mesmo bug, outro nome. Sem teto, um Resend que aceita a conexão e não
// responde prende a edge function até o wall-clock da plataforma.
// 15s = mesmo valor de POST de texto do resto do repo.
//
// AbortSignal.timeout, não AbortController manual: o corpo (`r.text()` no erro,
// `r.json()` no caminho feliz) é lido DEPOIS que o fetch resolve, e só assim o
// deadline continua valendo na leitura (buraco do commit 5219925).
const RESEND_TIMEOUT_MS = 15_000;
export const NET_ERR = "Não conseguimos falar com o provedor agora — tente novamente em instantes.";

// Só o Resend chega aqui agora — os ramos de zapi/twilio/meta-cloud saíram
// junto com os adaptadores deles. O equivalente multi-provider vive em
// _shared/messaging/provider-send.ts, que é quem atende os outros.
function friendlyHttp(status: number, body: string): string {
  if (status === 401 || status === 403) {
    return "Chave do Resend não está mais válida. Reconecte a integração.";
  }
  if (status >= 500) return "O provedor está indisponível no momento. Tente de novo em instantes.";
  if (status === 429) return "O provedor pediu para aguardar um pouco antes de enviar de novo.";
  // Mesma recusa permanente de _shared/messaging/provider-send.ts (H12): 400/422
  // é o provider dizendo que a mensagem nunca vai passar assim, e "tente
  // novamente" faz o operador retentar para sempre.
  if (status === 400 || status === 422) {
    return "O provedor recusou a mensagem (cadastro do contato, template não aprovado ou janela de 24h expirada). Corrija o cadastro antes de reenviar.";
  }
  // Status desconhecido: status e corpo (redigido, truncado) vão para a
  // mensagem devolvida ao caller — sem isso, qualquer 4xx/5xx não mapeado
  // virava a mesma frase genérica, indiagnosticável depois do fato
  // (docs/PLANO-OBSERVABILIDADE-2026-08-04.md).
  const detail = redactSecrets(body).slice(0, 300);
  return `Não foi possível enviar a mensagem — o provedor respondeu HTTP ${status}.${
    detail ? ` Detalhe: ${detail}` : ""
  }`;
}

// Gêmeo do providerHttpError de _shared/messaging/provider-send.ts, para o
// único sender que restou aqui. O corpo do erro do provider é a única pista
// do motivo real da recusa; passa por redactSecrets antes de ir para o log.
async function resendHttpError(r: Response): Promise<SendResult> {
  const body = await r.text().catch(() => "");
  console.error(
    `[send-adapters] resend recusou o envio (HTTP ${r.status})`,
    redactSecrets(body).slice(0, 500),
  );
  return { ok: false, error: friendlyHttp(r.status, body) };
}

export async function sendResend(
  cred: Record<string, string>,
  toEmail: string,
  content: string,
  subject: string,
): Promise<SendResult> {
  const { api_key, from_domain } = cred;
  if (!api_key || !from_domain) return { ok: false, error: "Integração Resend não configurada." };
  const from =
    cred.from_email && cred.from_email.includes("@") ? cred.from_email : `contato@${from_domain}`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${api_key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [toEmail],
      subject: subject || "Nova mensagem",
      text: content,
    }),
    signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
  });
  if (!r.ok) return await resendHttpError(r);
  const data = await r.json().catch(() => ({}) as Record<string, unknown>);
  return { ok: true, external_id: (data.id as string) ?? null };
}

export async function loadSecrets(
  admin: SupabaseClient,
  tenantId: string,
  slug: string,
): Promise<Record<string, string>> {
  const { data, error } = await admin
    .from("integration_secrets")
    .select("key, value")
    .eq("tenant_id", tenantId)
    .eq("slug", slug);
  // Erro de infra (DB fora do ar, timeout etc.) é diferente de "credencial
  // realmente ausente": aqui só propagamos (o caller em index.ts já envolve
  // esta chamada num try/catch que marca a mensagem como falha com NET_ERR),
  // sem mascarar a causa real como "Integração X não configurada".
  if (error) throw new Error(`Falha ao carregar credenciais (${slug}): ${error.message}`);
  const cred: Record<string, string> = {};
  for (const r of data ?? []) cred[r.key as string] = r.value as string;
  return cred;
}
