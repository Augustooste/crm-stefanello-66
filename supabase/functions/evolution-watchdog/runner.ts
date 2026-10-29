// Watchdog de reconexão automática de canais Evolution (WhatsApp
// self-hosted) caídos — Fase 5 do PRD (docs/PRD-CRM-IA-MULTINICHO.md,
// "Fase 5 — Multi-canal genérico").
//
// Lógica pura: SEM Deno.serve/Deno.env diretos — recebe `admin` injetado via
// EvolutionWatchdogDeps, mesmo padrão de DI de weekly-digest-generator/
// runner.ts e nurture-runner/runner.ts. index.ts (I/O fino) monta o client
// real e chama runEvolutionWatchdog.
//
// Genericidade (anti-padrão #1 do medflow-v0, confirmado lendo
// supabase/functions/evolution-watchdog/index.ts daquele repo:
// TARGET_INSTANCES hardcoded com 3 nomes de clínica): este runner porta só a
// LÓGICA de detecção/reconexão. A query abaixo é 100% dinâmica
// (type='whatsapp' AND provider_slug='evolution' AND status IN
// ('disconnected','error')) — zero nome de tenant/clínica/instância em
// qualquer lugar deste arquivo. Um canal Evolution criado depois do deploy
// deste watchdog é monitorado sem alteração de código (critério de aceite
// do PRD).
//
// Credenciais: MESMO contrato de messaging-channels-reconcile/runner.ts
// (confirmado lendo antes de escrever este arquivo, ver
// buildEvolutionCredentials lá) e documentado no header de
// evolution-client.ts — `api_url`/`instance_name` são metadado não sensível
// e vêm de `channels.config` (gravado pelo onboarding em
// integration-connect/index.ts); `api_key`/`instance_token` são segredo e
// vêm de `loadProviderSecrets(admin, tenantId, 'evolution')`, mesmo padrão
// já wireado por nurture-runner/runner.ts e template-schedule-runner/
// runner.ts. Os dois pedaços são combinados em `credentialsFromChannel`
// abaixo antes de irem como `cred` para o provider.
//
// QR pendente: reconnectEvolutionInstance (evolution-client.ts) pode
// devolver um QR novo quando a sessão foi invalidada e precisa de scan
// humano. O valor é credencial efêmera de pareamento: fica nas colunas
// channels.qr_code/qr_code_expires_at, sem SELECT direto para authenticated,
// e só sai pela RPC admin-only get_channel_qr_codes().
//
// Erro isolado por canal: falha em um canal (credenciais ausentes, rede,
// update do banco) não pode travar os demais — mesmo padrão de
// hitl-sla-monitor/weekly-digest-generator (try/catch por item, erro
// reportado em `errors`, loop continua para o próximo canal).
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import {
  reconnectEvolutionInstance,
  type EvolutionCredentials,
} from "../_shared/messaging/evolution-client.ts";
import { loadProviderSecrets } from "../_shared/messaging/provider-send.ts";

export interface EvolutionWatchdogDeps {
  admin: SupabaseClient;
}

/** Espelha o CHECK de status em public.channels após a migration da Fase 5. */
const DOWN_STATUSES = ["disconnected", "error"] as const;
const QR_CODE_TTL_MS = 10 * 60 * 1000;

interface EvolutionChannelRow {
  id: string;
  tenant_id: string;
  config: Record<string, unknown> | null;
}

type ChannelOutcome = "reconnected" | "waiting_qr" | "failed";

export interface EvolutionWatchdogSummary {
  scanned: number;
  reconnected: number;
  waitingQr: number;
  stillDown: number;
  errors: string[];
}

/**
 * Monta EvolutionCredentials combinando `channel.config` (api_url/
 * instance_name -- metadado não sensível) com o Record plano de
 * loadProviderSecrets (api_key/instance_token -- segredo). MESMO contrato de
 * buildEvolutionCredentials em messaging-channels-reconcile/runner.ts. `null`
 * quando o mínimo necessário (api_url/instance_name/api_key) não está
 * configurado -- caller trata como canal ainda não pronto para reconexão
 * automática, não como exceção.
 */
function credentialsFromChannel(
  channel: EvolutionChannelRow,
  secrets: Record<string, string>,
): EvolutionCredentials | null {
  const config = channel.config ?? {};
  const apiUrl = typeof config.api_url === "string" ? config.api_url : "";
  const instanceName = typeof config.instance_name === "string" ? config.instance_name : "";
  const { api_key, instance_token } = secrets;
  if (!apiUrl || !instanceName || !api_key) return null;
  return {
    api_url: apiUrl,
    instance_name: instanceName,
    api_key,
    instance_token: instance_token || undefined,
  };
}

async function updateChannel(
  admin: SupabaseClient,
  channelId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await admin
    .from("channels")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", channelId);
  if (error) throw new Error(`falha ao atualizar channels ${channelId}: ${error.message}`);
}

/**
 * Processa um canal caído: tenta reconectar e persiste o resultado. Nunca
 * lança por credenciais ausentes/reconexão recusada (vira outcome
 * "failed" com status_message explicando o motivo) -- só uma falha real de
 * update no banco propaga como exceção para o loop do handler isolar.
 */
async function processChannel(
  admin: SupabaseClient,
  channel: EvolutionChannelRow,
): Promise<ChannelOutcome> {
  const secrets = await loadProviderSecrets(admin, channel.tenant_id, "evolution");
  const cred = credentialsFromChannel(channel, secrets);

  if (!cred) {
    await updateChannel(admin, channel.id, {
      status_message:
        "Canal Evolution sem configuração completa (channels.config.api_url/instance_name ou integration_secrets.api_key).",
    });
    return "failed";
  }

  const result = await reconnectEvolutionInstance(cred);

  if (!result.ok) {
    await updateChannel(admin, channel.id, {
      status_message: result.error ?? "Falha ao reconectar a instância Evolution.",
    });
    return "failed";
  }

  if (result.qrCode) {
    await updateChannel(admin, channel.id, {
      status: "waiting_qr",
      status_message: "Sessão expirou -- escaneie o novo QR code para reconectar.",
      qr_code: result.qrCode,
      qr_code_expires_at: new Date(Date.now() + QR_CODE_TTL_MS).toISOString(),
    });
    return "waiting_qr";
  }

  await updateChannel(admin, channel.id, {
    status: "connected",
    status_message: null,
    last_connected_at: new Date().toISOString(),
    qr_code: null,
    qr_code_expires_at: null,
  });
  return "reconnected";
}

/**
 * Reconecta automaticamente canais Evolution (WhatsApp self-hosted) caídos.
 * Query 100% dinâmica -- ZERO nome de tenant/clínica/instância hardcoded
 * (ver header do arquivo). Só age em canais type='whatsapp' AND
 * provider_slug='evolution' AND status IN ('disconnected','error') -- canais
 * já conectados e canais de outro provider nunca são lidos nem tocados.
 */
export async function runEvolutionWatchdog(
  deps: EvolutionWatchdogDeps,
): Promise<EvolutionWatchdogSummary> {
  const { admin } = deps;
  const summary: EvolutionWatchdogSummary = {
    scanned: 0,
    reconnected: 0,
    waitingQr: 0,
    stillDown: 0,
    errors: [],
  };

  const { data: channels, error: fetchError } = await admin
    .from("channels")
    .select("id, tenant_id, config")
    .eq("type", "whatsapp")
    .eq("provider_slug", "evolution")
    .in("status", DOWN_STATUSES)
    .returns<EvolutionChannelRow[]>();

  if (fetchError) {
    summary.errors.push(`falha ao buscar canais Evolution caídos: ${fetchError.message}`);
    return summary;
  }

  summary.scanned = channels?.length ?? 0;

  for (const channel of channels ?? []) {
    try {
      const outcome = await processChannel(admin, channel);
      if (outcome === "reconnected") summary.reconnected++;
      else if (outcome === "waiting_qr") summary.waitingQr++;
      else summary.stillDown++;
    } catch (err) {
      summary.stillDown++;
      summary.errors.push(`${channel.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return summary;
}
