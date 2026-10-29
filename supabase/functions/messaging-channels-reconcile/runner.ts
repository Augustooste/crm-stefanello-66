// Reconciliação genérica de status/webhook_health por canal (Fase 5 do PRD —
// docs/PRD-CRM-IA-MULTINICHO.md, "Multi-canal genérico", user story de
// reconciliação). Lógica pura: SEM `Deno.serve`/`Deno.env` diretos — recebe
// `admin` injetado via `MessagingChannelsReconcileDeps`, mesmo padrão de DI
// de nurture-runner/runner.ts, weekly-digest-generator/runner.ts e
// template-schedule-runner/runner.ts. index.ts (I/O fino) monta o client
// real e chama `runMessagingChannelsReconcile`.
//
// Testável com o mesmo harness Deno (`createClient` real + `installFetchMock`
// interceptando `fetch`) usado por todos os arquivos-irmãos em
// supabase/functions/tests/ — ver supabase/functions/tests/_helpers.ts e
// docs/TESTING.md ("Edge functions (Deno) — deno test"). NÃO um arquivo
// Vitest: vitest.config.ts só inclui `src/**/*.test.{ts,tsx}` e este módulo
// importa de esm.sh (URL), que o Vitest/Node não resolve.
//
// Anti-padrão #1 do PRD ("watchdog/reconciliação rodando sobre uma lista
// hardcoded de tenant/instância") é o risco central desta function: a query
// abaixo (`channels where status != 'disabled'`) é 100% genérica — nenhum
// tenant_id, channel_id ou instance_name aparece literal neste arquivo. Um
// canal Evolution criado depois do deploy é monitorado só por ter
// `provider_slug = 'evolution'`, sem qualquer alteração de código (critério
// de aceite do PRD, coberto pelo teste "genericidade" em
// messaging-channels-reconcile.test.ts).
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import {
  checkEvolutionInstanceStatus,
  type EvolutionCredentials,
  type EvolutionInstanceStatus,
} from "../_shared/messaging/evolution-client.ts";
import {
  checkZappazSession,
  registerZappazWebhook,
  type ZappazCredentials,
} from "../_shared/messaging/zappaz-client.ts";
import { loadProviderSecrets } from "../_shared/messaging/provider-send.ts";

export interface MessagingChannelsReconcileDeps {
  admin: SupabaseClient;
  /**
   * Base pública das edge functions (`SUPABASE_URL`). Só é usada para
   * remontar a URL de webhook do Zappaz quando o canal está silencioso —
   * o runner continua sem tocar em `Deno.env` (I/O fica no index.ts).
   * Ausente ⇒ o re-registro é pulado, o resto da reconciliação segue.
   */
  supabaseUrl?: string;
}

/** Espelha o CHECK de channels.status (migration 20260712100000_fase5_multicanal_schema.sql). */
export type ChannelStatus =
  | "pending"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error"
  | "waiting_qr"
  | "disabled";

/** Espelha o CHECK de channels.webhook_health (mesma migration). */
export type WebhookHealth = "ok" | "broken" | "unknown" | "silent";

export interface ChannelRow {
  id: string;
  tenant_id: string;
  type: string;
  provider_slug: string;
  status: ChannelStatus;
  config: Record<string, unknown>;
  created_at: string;
  webhook_health: WebhookHealth | null;
  webhook_health_checked_at: string | null;
  status_message: string | null;
  last_connected_at: string | null;
  webhook_token?: string | null;
}

// Batch default -- não pedido explicitamente, mas evita processar um número
// ilimitado de canais numa única execução dormente (mesmo racional de
// DEFAULT_CLAIM_LIMIT/DEFAULT_TENANT_LIMIT dos runners irmãos).
const DEFAULT_CHANNEL_LIMIT = 200;

// Janela de saúde de webhook -- constante nomeada, não pedida com um valor
// configurável por tenant nesta fase (YAGNI).
// 72h (era 24h até 2026-07-27): com 24h, um fim de semana sem mensagem já
// classificava canal saudável como `broken`. Observado em prod — Meta e Zappaz
// com 100% dos webhooks processados e zero falhas consecutivas apareciam como
// "webhook parou de receber" só por falta de tráfego.
const WEBHOOK_HEALTH_WINDOW_HOURS = 72;

/**
 * Todos os canais "vivos" (não desabilitados) de TODOS os tenants -- zero
 * filtro por provider/instância. `disabled` é o único status excluído
 * porque um canal desabilitado foi deliberadamente desligado pelo operador;
 * monitorar sua saúde geraria alertas de um canal que não deveria estar
 * funcionando mesmo.
 */
export async function loadActiveChannels(
  admin: SupabaseClient,
  opts: { limit?: number } = {},
): Promise<ChannelRow[]> {
  const limit = opts.limit ?? DEFAULT_CHANNEL_LIMIT;
  // Ordena por "menos recentemente checado" (nulls first) — evita starvation:
  // sem order, com >limit canais ativos, sempre voltavam os mesmos primeiros
  // N e o excedente nunca era processado (bug do lote 2, item 6).
  const { data, error } = await admin
    .from("channels")
    .select(
      "id, tenant_id, type, provider_slug, status, config, created_at, webhook_health, webhook_health_checked_at, status_message, last_connected_at, webhook_token",
    )
    .neq("status", "disabled")
    .order("webhook_health_checked_at", { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) throw new Error(`Falha ao buscar canais ativos: ${error.message}`);
  return (data ?? []) as ChannelRow[];
}

/**
 * Classifica a saúde do webhook a partir de `messaging_webhook_events`:
 * - `ok`: existe pelo menos 1 evento `processed=true` dentro da janela.
 * - `unknown`: canal criado há menos tempo que a janela -- nunca deveria ter
 *   recebido nada ainda, então "sem evento" não é sinal de problema.
 * - `silent`: canal mais velho que a janela e que nunca RECEBEU evento algum na
 *   história inteira -- nunca foi exercitado ponta a ponta (URL não cadastrada
 *   no provider, número sem tráfego, canal de teste). Não é falha.
 * - `broken`: canal mais velho que a janela, COM eventos recebidos na história,
 *   mas nenhum processado dentro dela -- recebia e parou. É o único estado que
 *   merece alarme.
 *
 * A separação silent/broken existe porque em 2026-07-27 os 6 canais de produção
 * estavam todos em `broken` com `webhook_consecutive_failures = 0`. "Quebrado"
 * com zero falhas manda o operador caçar bug inexistente: 4 daqueles canais
 * nunca tinham recebido evento algum.
 *
 * As duas contagens filtram DIFERENTE de propósito, e a distinção é o que faz
 * a classificação funcionar:
 * - janela: `processed=true` -- a pergunta é "processou alguma coisa nas
 *   últimas 24h?". `processed=true` (sem checar `error`) já é o sinal correto
 *   de "processado com sucesso": messaging-webhook/index.ts só chama
 *   `markWebhookEventProcessed` depois de `persistInbound` completar; a coluna
 *   `error` da tabela nunca é escrita por nenhum caminho hoje (confirmado por
 *   leitura direta do arquivo) -- não é um campo "sucesso vs falha", é reserva
 *   para uma função futura.
 * - histórica: SEM filtro de `processed` -- a pergunta é "esse canal chegou a
 *   RECEBER alguma coisa algum dia?", e recebimento independe de ter dado
 *   certo processar. Filtrar `processed=true` aqui invertia o diagnóstico do
 *   pior caso que existe: canal que recebe webhook mas falha em processar
 *   TODOS eles contava zero, virava `silent` ("nunca recebeu, não é falha") e
 *   o operador era mandado ignorar justamente o canal quebrado de verdade.
 */
async function computeWebhookHealth(
  admin: SupabaseClient,
  channel: ChannelRow,
  cutoffIso: string,
): Promise<WebhookHealth> {
  const { count, error } = await admin
    .from("messaging_webhook_events")
    .select("id", { count: "exact", head: true })
    .eq("channel_id", channel.id)
    .eq("processed", true)
    .gte("created_at", cutoffIso);
  if (error) {
    throw new Error(`Falha ao contar eventos processados do canal ${channel.id}: ${error.message}`);
  }
  if ((count ?? 0) > 0) return "ok";
  if (new Date(channel.created_at).getTime() > new Date(cutoffIso).getTime()) return "unknown";

  // Sem evento processado na janela. Segunda contagem, agora SEM recorte de
  // tempo e SEM filtro de `processed`, para separar "nunca recebeu nada" de
  // "recebia e parou". Só roda nesta ramificação: o caminho feliz (`ok`)
  // continua custando uma query só.
  const { count: everCount, error: everError } = await admin
    .from("messaging_webhook_events")
    .select("id", { count: "exact", head: true })
    .eq("channel_id", channel.id);
  if (everError) {
    throw new Error(
      `Falha ao contar eventos históricos do canal ${channel.id}: ${everError.message}`,
    );
  }
  return (everCount ?? 0) > 0 ? "broken" : "silent";
}

/**
 * Atualiza webhook_health + webhook_health_checked_at de 1 canal. Grava o
 * checked_at SEMPRE (mesmo quando o health não mudou) -- é o que permite a
 * UI/operador saberem quando foi a última checagem, distinto de "quando foi
 * a última mudança". Retorna se o valor de webhook_health efetivamente
 * mudou (usado só para o resumo, não muda o comportamento de escrita).
 */
async function reconcileWebhookHealth(
  admin: SupabaseClient,
  channel: ChannelRow,
): Promise<{ changed: boolean; health: WebhookHealth }> {
  const cutoffIso = new Date(Date.now() - WEBHOOK_HEALTH_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const health = await computeWebhookHealth(admin, channel, cutoffIso);
  const changed = health !== channel.webhook_health;

  const { error } = await admin
    .from("channels")
    .update({ webhook_health: health, webhook_health_checked_at: new Date().toISOString() })
    .eq("id", channel.id);
  if (error) {
    throw new Error(`Falha ao atualizar webhook_health do canal ${channel.id}: ${error.message}`);
  }
  // Devolve o valor recém-calculado: a reconciliação Zappaz logo abaixo decide
  // re-registrar o webhook a partir dele, e `channel.webhook_health` em memória
  // é o valor ANTIGO (lido antes deste UPDATE).
  return { changed, health };
}

/**
 * Credenciais Evolution de 1 canal: `api_url`/`instance_name` vêm de
 * `channels.config` (metadado não sensível, mesmos nomes de campo da
 * interface `EvolutionCredentials` documentada em evolution-client.ts);
 * `api_key`/`instance_token` vêm de `integration_secrets` (segredo, mesma
 * convenção de zapi/twilio/meta-cloud/resend em provider-send.ts). Não há
 * hoje nenhum outro consumidor real gravando `channels.config` para
 * Evolution (integration-connect ainda não tem suporte a este provider,
 * fora do escopo desta function) -- esta leitura fixa o contrato que esse
 * fluxo futuro precisará escrever.
 */
async function buildEvolutionCredentials(admin: SupabaseClient, channel: ChannelRow): Promise<EvolutionCredentials> {
  const config = channel.config ?? {};
  const apiUrl = typeof config.api_url === "string" ? config.api_url : "";
  const instanceName = typeof config.instance_name === "string" ? config.instance_name : "";
  const secrets = await loadProviderSecrets(admin, channel.tenant_id, "evolution");
  return {
    api_url: apiUrl,
    instance_name: instanceName,
    api_key: secrets.api_key ?? "",
    instance_token: secrets.instance_token,
  };
}

function hasCompleteEvolutionConfig(cred: EvolutionCredentials): boolean {
  return Boolean(cred.api_url && cred.instance_name && (cred.instance_token || cred.api_key));
}

/**
 * Reconcilia status de 1 canal Evolution com o estado real da API:
 * - `connected`: status='connected', last_connected_at=now(). status_message
 *   é limpo (null) -- um erro antigo parado ali depois de uma reconexão bem
 *   sucedida seria enganoso pro operador, mesmo não sendo pedido literal do
 *   ticket.
 * - `disconnected`: status='disconnected'. status_message também limpo --
 *   desconectado é um estado definitivo da API, não um erro transitório.
 * - `error` (falha HTTP ou de rede na checagem): SÓ status_message é escrito
 *   (a chave `status` fica de fora do patch, nunca é reenviada com o valor
 *   antigo) -- isso é o que garante que uma falha transitória de rede nunca
 *   mascara um estado real que outra escrita (ex.: o webhook confirmando
 *   reconexão) possa ter gravado entre esta leitura e este UPDATE.
 *
 * Config/credenciais incompletas são tratadas como o mesmo caso "error" sem
 * sequer chamar a API -- não há prevenção contra request para
 * api_url vazia (checkEvolutionInstanceStatus já devolve `state:"error"` com
 * segurança nesse caso), mas evitar o fetch aqui poupa uma chamada
 * destinada a falhar.
 */
async function reconcileEvolutionStatus(admin: SupabaseClient, channel: ChannelRow): Promise<boolean> {
  const cred = await buildEvolutionCredentials(admin, channel);
  const result: EvolutionInstanceStatus = hasCompleteEvolutionConfig(cred)
    ? await checkEvolutionInstanceStatus(cred)
    : { state: "error", message: "Canal Evolution sem configuração completa (api_url/instance_name/credenciais)." };

  const patch: Record<string, unknown> = {};
  let statusChanged = false;

  if (result.state === "connected") {
    statusChanged = channel.status !== "connected";
    patch.status = "connected";
    patch.last_connected_at = new Date().toISOString();
    patch.status_message = null;
  } else if (result.state === "disconnected") {
    statusChanged = channel.status !== "disconnected";
    patch.status = "disconnected";
    patch.status_message = null;
  } else {
    // "status" propositalmente NUNCA entra neste patch -- ver docstring acima.
    patch.status_message = result.message ?? "Falha ao consultar status da Evolution.";
  }

  const { error } = await admin.from("channels").update(patch).eq("id", channel.id);
  if (error) {
    throw new Error(`Falha ao atualizar status do canal Evolution ${channel.id}: ${error.message}`);
  }
  return statusChanged;
}

/**
 * Status de canal Evolution que são PROPRIEDADE do evolution-watchdog (job
 * separado, outro cron -- ver evolution-watchdog/runner.ts): `waiting_qr` é
 * gravado ali quando um QR code novo foi gerado e aguarda o operador
 * escanear; `connecting` é o mesmo tipo de estado transitório para uma
 * conexão em andamento. Reconciliar o status desses canais aqui é uma race
 * condition real -- checkEvolutionInstanceStatus() DEVE devolver
 * "disconnected" enquanto o QR não foi escaneado (isso é o estado esperado
 * da API nesse meio-tempo, não um erro), e reconcileEvolutionStatus()
 * sobrescreveria `waiting_qr`/`connecting` com `disconnected`
 * incondicionalmente. Na passada seguinte do watchdog (que rebusca canais
 * `disconnected`/`error`), esse canal seria repego e um QR NOVO seria
 * gerado, invalidando o QR que o operador estava prestes a escanear -- loop
 * silencioso, sem nenhum job reportar erro. O reconcile só deve atuar sobre
 * `connected`/`disconnected`/`error`/`pending`, os estados que ele
 * efetivamente possui.
 */
const EVOLUTION_TRANSITIONAL_STATUSES: readonly ChannelStatus[] = ["waiting_qr", "connecting"];

/**
 * Credenciais Zappaz de 1 canal: `api_key` vem de `integration_secrets`
 * (segredo, nunca de `channels.config`); `session_id` vem de
 * `channels.config` (metadado gravado por integration-connect) com fallback
 * para o segredo, porque o connect grava os dois.
 */
async function buildZappazCredentials(
  admin: SupabaseClient,
  channel: ChannelRow,
): Promise<ZappazCredentials> {
  const config = channel.config ?? {};
  const secrets = await loadProviderSecrets(admin, channel.tenant_id, "zappaz");
  const sessionId = typeof config.session_id === "string" && config.session_id
    ? config.session_id
    : (secrets.session_id ?? "");
  return { api_key: secrets.api_key ?? "", session_id: sessionId };
}

/**
 * Reconcilia o canal Zappaz com o estado REAL da sessão no provedor.
 *
 * Motivação (2026-07-31): até aqui só `evolution` tinha checagem ao vivo. Para
 * Zappaz a UI derivava tudo de `webhook_health`, que é só "recebeu evento nas
 * últimas 72h" — com a sessão do WhatsApp caída (ou o webhook desregistrado no
 * painel), o card continuava exibindo "Ativo / Webhook ok / Mensagens chegando
 * normalmente" por até 3 dias depois de parar de funcionar.
 *
 * Mesma disciplina do Evolution quanto a estado transitório:
 * - sessão viva  ⇒ status='connected', last_connected_at, status_message=null;
 * - `invalid_key`/`invalid_session` (estado DEFINITIVO devolvido pela Zappaz)
 *   ⇒ status='disconnected' + status_message explicando o que fazer;
 * - `network` (5xx/timeout/queda) ⇒ SÓ status_message; a chave `status` fica
 *   fora do patch para que uma falha transitória nunca sobrescreva um estado
 *   real gravado por outro caminho (webhook confirmando reconexão, connect).
 *
 * Bônus quando a sessão está viva mas o canal não recebe nada (webhook_health
 * `broken`/`silent`): reregistra a URL de webhook na sessão. É exatamente o
 * modo de falha observado — sessão OK, registro do webhook perdido do lado da
 * Zappaz — e o re-registro é idempotente. Best-effort: falha aqui só vira
 * status_message, não erro do lote.
 */
export async function reconcileZappazStatus(
  admin: SupabaseClient,
  channel: ChannelRow,
  supabaseUrl?: string,
): Promise<boolean> {
  const cred = await buildZappazCredentials(admin, channel);
  const result = cred.api_key && cred.session_id
    ? await checkZappazSession(cred)
    : ({
      ok: false,
      error: "Canal Zappaz sem credenciais completas (API Key/Session ID). Reconecte a integração.",
      code: "invalid_key",
    } as const);

  const patch: Record<string, unknown> = {};
  let statusChanged = false;

  if (result.ok) {
    statusChanged = channel.status !== "connected";
    patch.status = "connected";
    patch.last_connected_at = new Date().toISOString();
    patch.status_message = null;

    const silent = channel.webhook_health === "broken" || channel.webhook_health === "silent";
    if (silent && supabaseUrl && channel.webhook_token) {
      const callbackUrl =
        `${supabaseUrl}/functions/v1/messaging-webhook/zappaz/${channel.id}?token=${channel.webhook_token}`;
      const reg = await registerZappazWebhook(cred, callbackUrl, cred.api_key);
      if (!reg.ok) {
        patch.status_message =
          "Sessão ativa, mas não conseguimos registrar a URL de webhook na Zappaz. Cadastre-a manualmente no painel (evento \"Ao receber\").";
      }
    }
  } else if (result.code === "network") {
    // "status" propositalmente fora do patch -- ver docstring acima.
    patch.status_message = result.error;
  } else {
    statusChanged = channel.status !== "disconnected";
    patch.status = "disconnected";
    patch.status_message = result.error;
  }

  const { error } = await admin.from("channels").update(patch).eq("id", channel.id);
  if (error) {
    throw new Error(`Falha ao atualizar status do canal Zappaz ${channel.id}: ${error.message}`);
  }
  return statusChanged;
}

export interface RunSummary {
  channelsProcessed: number;
  webhookHealthChanged: number;
  statusChanged: number;
  skippedTransitional: number;
  errors: string[];
}

/**
 * Ponto de entrada da lógica: para cada canal não desabilitado (de todos os
 * tenants), recalcula webhook_health e, só para provider_slug='evolution',
 * reconcilia o status de conexão com a API real. As duas checagens são
 * isoladas em try/catch PRÓPRIOS -- uma falha na checagem de webhook_health
 * de um canal não impede a checagem de status Evolution do MESMO canal, e um
 * erro em qualquer uma delas nunca aborta o processamento dos demais canais
 * do lote (mesmo padrão de isolamento de nurture-runner/weekly-digest-
 * generator).
 */
export async function runMessagingChannelsReconcile(
  deps: MessagingChannelsReconcileDeps,
  opts: { limit?: number } = {},
): Promise<RunSummary> {
  const { admin } = deps;
  const channels = await loadActiveChannels(admin, opts);

  const summary: RunSummary = {
    channelsProcessed: 0,
    webhookHealthChanged: 0,
    statusChanged: 0,
    skippedTransitional: 0,
    errors: [],
  };

  for (const channel of channels) {
    summary.channelsProcessed++;

    let freshHealth: WebhookHealth | null = channel.webhook_health;
    try {
      const { changed, health } = await reconcileWebhookHealth(admin, channel);
      freshHealth = health;
      if (changed) summary.webhookHealthChanged++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[messaging-channels-reconcile] falha ao checar webhook_health do canal ${channel.id}:`, message);
      summary.errors.push(`${channel.id} (webhook_health): ${message}`);
    }

    if (channel.provider_slug === "evolution") {
      if (EVOLUTION_TRANSITIONAL_STATUSES.includes(channel.status)) {
        // Skip normal, não um erro -- ver docstring de
        // EVOLUTION_TRANSITIONAL_STATUSES acima.
        summary.skippedTransitional++;
      } else {
        try {
          const changed = await reconcileEvolutionStatus(admin, channel);
          if (changed) summary.statusChanged++;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[messaging-channels-reconcile] falha ao reconciliar status Evolution do canal ${channel.id}:`, message);
          summary.errors.push(`${channel.id} (evolution status): ${message}`);
        }
      }
    }

    if (channel.provider_slug === "zappaz") {
      try {
        const changed = await reconcileZappazStatus(
          admin,
          { ...channel, webhook_health: freshHealth },
          deps.supabaseUrl,
        );
        if (changed) summary.statusChanged++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[messaging-channels-reconcile] falha ao reconciliar status Zappaz do canal ${channel.id}:`,
          message,
        );
        summary.errors.push(`${channel.id} (zappaz status): ${message}`);
      }
    }
  }

  return summary;
}
