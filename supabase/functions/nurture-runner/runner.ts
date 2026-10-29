// Motor de envio de sequências de nutrição (Fase 4 do PRD —
// docs/PRD-CRM-IA-MULTINICHO.md, user story A). Lógica pura: SEM
// `Deno.serve`/`Deno.env` diretos — recebe `admin` (client-like, tipado só
// por `SupabaseClient` do supabase-js) injetado via `NurtureRunnerDeps`,
// mesmo padrão de DI já usado em
// supabase/functions/_shared/messaging/{conversation,provider-send}.ts, que
// este módulo consome. index.ts (I/O fino) monta o client real e chama
// `runNurtureRunner`.
//
// Testável com o mesmo harness Deno (`createClient` real + `installFetchMock`
// interceptando `fetch`) usado por todos os arquivos-irmãos em
// supabase/functions/tests/ (gates.test.ts, send-dispatch.test.ts,
// hitl-sla-monitor.test.ts) — ver supabase/functions/tests/_helpers.ts e
// docs/TESTING.md ("Edge functions (Deno) — deno test"). NÃO um arquivo
// Vitest: vitest.config.ts só inclui `src/**/*.test.{ts,tsx}` e estes módulos
// importam de esm.sh (URL), que o Vitest/Node não resolve — um `.test.ts`
// aqui com `import {describe,it} from "vitest"` não seria executado por
// nenhum runner configurado neste repo.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import {
  AUTOMATED_SEND_DAILY_LIMIT,
  AUTOMATED_SEND_WINDOW_HOURS,
  countRecentAutomatedSends,
  findOrCreateConversation,
  isPhoneSuppressed,
  logAutomatedSend,
} from "../_shared/messaging/conversation.ts";
import {
  isSupportedProviderSlug,
  loadProviderSecrets,
  sendViaProvider,
} from "../_shared/messaging/provider-send.ts";
import { resolveProviderDestination } from "../_shared/messaging/contact-identity.ts";
import { redactSecrets } from "../_shared/redact-secrets.ts";
import { captureEdgeError } from "../_shared/telemetry.ts";
import {
  type BusinessHours,
  janelaDeEnvio,
  parseBusinessHours,
} from "../_shared/business-hours.ts";

export interface NurtureRunnerDeps {
  admin: SupabaseClient;
}

/** Espelha o CHECK de status em nurture_enrollments (migration 20260710140000). */
export type NurtureEnrollmentStatus = "active" | "sending" | "paused" | "completed" | "cancelled";

export interface ClaimedEnrollment {
  id: string;
  tenant_id: string;
  sequence_id: string;
  deal_id: string | null;
  contact_id: string;
  current_step: number;
  status: NurtureEnrollmentStatus;
  next_send_at: string | null;
  attempts: number;
}

/** Colunas de nurture_enrollments que o worker efetivamente escreve. */
interface NurtureEnrollmentPatch {
  status?: NurtureEnrollmentStatus;
  current_step?: number;
  next_send_at?: string | null;
  completed_at?: string | null;
  attempts?: number;
}

interface NurtureStepRow {
  step_number: number;
  delay_hours: number;
  message_template: string;
}

interface ContactRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
}

export interface RunSummary {
  processed: number;
  sent: number;
  completed: number;
  skippedSuppressed: number;
  skippedCancelled: number;
  deferredFrequency: number;
  deferredHandoff: number;
  deferredWindow: number;
  exhausted: number;
  retried: number;
  errors: string[];
}

type ProcessOutcome =
  | { kind: "completed" }
  | { kind: "skipped_suppressed" }
  | { kind: "skipped_cancelled" }
  | { kind: "deferred_frequency" }
  | { kind: "deferred_handoff" }
  | { kind: "deferred_window" }
  | { kind: "exhausted"; error: string }
  | { kind: "sent" }
  | { kind: "retry"; error: string };

// Batch default do claim -- não pedido explicitamente, mas evita reivindicar
// um número ilimitado de linhas numa única execução dormente.
const DEFAULT_CLAIM_LIMIT = 50;

// Guard de frequência cruzada: limite e janela vêm de
// _shared/messaging/conversation.ts (mesma fonte do template-schedule-runner).
const MAX_AUTOMATED_SENDS_PER_DAY = AUTOMATED_SEND_DAILY_LIMIT;
const FREQUENCY_GUARD_WINDOW_HOURS = AUTOMATED_SEND_WINDOW_HOURS;
// Adiamento quando o guard de frequência bloqueia o envio: tenta de novo mais
// tarde no mesmo dia, sem martelar a cada poucos minutos.
const FREQUENCY_DEFER_HOURS = 6;
// Adiamento quando a conversa está na fila de atendimento humano: pausa, não
// cancela. O handoff costuma se resolver no mesmo dia e cancelar mataria a
// sequência inteira do contato por uma condição temporária.
const HANDOFF_DEFER_HOURS = 6;

const SEND_RETRY_BACKOFF_MINUTES = 30;

// Teto de tentativas. Antes disto, falha de envio era retry indefinido: um
// telefone inválido batia no provedor a cada 30 min para sempre -- 48 chamadas
// por dia, por contato, sem ninguém perceber. `attempts` zera a cada envio bem
// sucedido, então o teto vale para o passo atual, não para a sequência inteira.
const MAX_SEND_ATTEMPTS = 5;

// Quando não há nenhum dia de atendimento habilitado, `janelaDeEnvio` não tem
// próxima abertura para oferecer. Adiar um dia mantém a inscrição viva sem
// martelar: se o tenant configurar o horário amanhã, o envio volta sozinho.
const WINDOW_DEFER_HOURS_SEM_JANELA = 24;

function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function minutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

/**
 * Claim atômico: UPDATE ... RETURNING num único statement, nunca um SELECT
 * seguido de UPDATE separado (haveria race entre as 2 queries se 2 execuções
 * do cron se sobrepuserem). `order()+limit()` no UPDATE é o recurso de
 * "limited update" do PostgREST -- roda como 1 statement atômico em Postgres;
 * mesmo que a versão hospedada ignore o limit, o pior caso é reivindicar mais
 * linhas de uma vez, nunca duplicar uma linha já reivindicada por outra
 * execução concorrente (a 2ª só vê `status='active'` nas linhas que a 1ª
 * ainda não tiver marcado `status='sending'`).
 */
export async function claimDueEnrollments(
  deps: NurtureRunnerDeps,
  opts: { limit?: number } = {},
): Promise<ClaimedEnrollment[]> {
  const limit = opts.limit ?? DEFAULT_CLAIM_LIMIT;
  const nowIso = new Date().toISOString();

  const { data, error } = await deps.admin
    .from("nurture_enrollments")
    .update({ status: "sending" })
    .eq("status", "active")
    .lte("next_send_at", nowIso)
    .order("next_send_at", { ascending: true })
    .limit(limit)
    .select(
      "id, tenant_id, sequence_id, deal_id, contact_id, current_step, status, next_send_at, attempts",
    );

  if (error) {
    throw new Error(`Falha ao reivindicar inscrições de nurture: ${error.message}`);
  }
  return (data ?? []) as ClaimedEnrollment[];
}

async function loadStep(
  admin: SupabaseClient,
  sequenceId: string,
  stepNumber: number,
): Promise<NurtureStepRow | null> {
  const { data, error } = await admin
    .from("nurture_steps")
    .select("step_number, delay_hours, message_template")
    .eq("sequence_id", sequenceId)
    .eq("step_number", stepNumber)
    .maybeSingle();
  if (error) throw new Error(`Falha ao buscar nurture_steps: ${error.message}`);
  return (data as NurtureStepRow | null) ?? null;
}

async function loadContact(admin: SupabaseClient, contactId: string): Promise<ContactRow | null> {
  const { data, error } = await admin
    .from("contacts")
    .select("id, name, phone, email")
    .eq("id", contactId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(`Falha ao buscar contato: ${error.message}`);
  return (data as ContactRow | null) ?? null;
}

/**
 * Horário de atendimento do tenant, com cache por execução: um lote de 50
 * inscrições costuma repetir o mesmo tenant dezenas de vezes e nenhuma delas
 * precisa de uma consulta própria.
 *
 * Erro de leitura não bloqueia: cai no default de `parseBusinessHours` (seg a
 * sex, 9h-18h). Deixar de enviar porque a consulta de configuração falhou seria
 * pior que enviar dentro de um horário comercial padrão.
 */
async function loadBusinessHours(
  admin: SupabaseClient,
  tenantId: string,
  cache: Map<string, BusinessHours>,
): Promise<BusinessHours> {
  const emCache = cache.get(tenantId);
  if (emCache) return emCache;

  const { data, error } = await admin
    .from("tenants")
    .select("business_profile")
    .eq("id", tenantId)
    .maybeSingle();
  if (error) {
    console.error(`[nurture-runner] falha ao ler horário do tenant ${tenantId}:`, error.message);
  }
  const perfil = (data as { business_profile?: Record<string, unknown> } | null)?.business_profile;
  const hours = parseBusinessHours(perfil?.hours);
  cache.set(tenantId, hours);
  return hours;
}

async function loadSequenceChannelId(
  admin: SupabaseClient,
  sequenceId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("nurture_sequences")
    .select("channel_id")
    .eq("id", sequenceId)
    .maybeSingle();
  if (error) throw new Error(`Falha ao buscar nurture_sequences: ${error.message}`);
  return (data as { channel_id: string | null } | null)?.channel_id ?? null;
}

async function loadChannelProviderSlug(
  admin: SupabaseClient,
  channelId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("channels")
    .select("provider_slug")
    .eq("id", channelId)
    .maybeSingle();
  if (error) throw new Error(`Falha ao buscar channels: ${error.message}`);
  return (data as { provider_slug: string } | null)?.provider_slug ?? null;
}

async function updateEnrollment(
  admin: SupabaseClient,
  enrollmentId: string,
  patch: NurtureEnrollmentPatch,
): Promise<boolean> {
  // `cancelled` é terminal e vence qualquer escrita do worker. Sem esta guarda,
  // o lead responde durante o envio, o webhook cancela, e o `advanceOrComplete`
  // logo em seguida devolve a linha para `active` com o próximo passo agendado
  // — o cancelamento duraria segundos e o lead continuaria recebendo.
  const { data, error } = await admin
    .from("nurture_enrollments")
    .update(patch)
    .eq("id", enrollmentId)
    .neq("status", "cancelled")
    .select("id");
  if (error) {
    throw new Error(`Falha ao atualizar nurture_enrollments ${enrollmentId}: ${error.message}`);
  }
  return (data?.length ?? 0) > 0;
}

/**
 * Avança o enrollment para o próximo step (ou completa, se `nextStep` for
 * null). Só se aplica ao caminho de sucesso de envio: supressão agora
 * CANCELA a inscrição em vez de seguir o cronograma (ver
 * `cancelEnrollment`).
 *
 * A escrita é barrada quando o status já é `cancelled` (`updateEnrollment` faz
 * `.neq("status","cancelled")`) — se o lead respondeu durante o envio e o
 * webhook já cancelou a inscrição, este avanço não pode desfazer o
 * cancelamento.
 */
async function advanceOrComplete(
  admin: SupabaseClient,
  enrollment: ClaimedEnrollment,
  nextStep: NurtureStepRow | null,
): Promise<void> {
  const patch: NurtureEnrollmentPatch = nextStep
    ? {
        status: "active",
        current_step: enrollment.current_step + 1,
        next_send_at: hoursFromNow(nextStep.delay_hours),
        attempts: 0,
      }
    : {
        status: "completed",
        current_step: enrollment.current_step + 1,
        completed_at: new Date().toISOString(),
        next_send_at: null,
        attempts: 0,
      };
  const aplicado = await updateEnrollment(admin, enrollment.id, patch);
  if (!aplicado) {
    console.log(
      `[nurture-runner] avanço ignorado, inscrição foi cancelada durante o envio: enrollment=${enrollment.id}`,
    );
  }
}

/**
 * Encerra a inscrição de vez. Usado quando o contato pediu para não receber
 * mais: antes disso, a supressão só PULAVA o envio e avançava o passo assim
 * mesmo — quem pedia "parar" percorria a sequência inteira em silêncio e
 * terminava marcado como "concluída" sem ter recebido nada.
 *
 * Grava `completed_at` junto: os gatilhos de auto-inscrição do scanner olham
 * `completed_at` para decidir carência. Sem essa data, a linha cancelada
 * ficava elegível na varredura seguinte e o ciclo recomeçava
 * (reinscreve → reivindica → cancela → reinscreve).
 */
async function cancelEnrollment(
  admin: SupabaseClient,
  enrollment: ClaimedEnrollment,
  motivo: string,
): Promise<void> {
  const aplicado = await updateEnrollment(admin, enrollment.id, {
    status: "cancelled",
    completed_at: new Date().toISOString(),
    next_send_at: null,
  });
  // Estado terminal: `console.log` morre com o isolate e o cancelamento fica
  // sem rastro consultável. O caminho gêmeo no webhook grava `system_events`.
  await captureEdgeError(admin, {
    severity: "info",
    source: "edge",
    operation: "nurture.cancel_enrollment",
    tenantId: enrollment.tenant_id,
    message: aplicado
      ? `Inscrição cancelada pelo runner: ${motivo}.`
      : `Cancelamento ignorado, inscrição já estava cancelada: ${motivo}.`,
    context: { enrollment_id: enrollment.id, contact_id: enrollment.contact_id, motivo },
  });
}

/**
 * Reconfirma que a inscrição ainda é nossa antes de disparar o envio externo.
 *
 * Entre o claim (`status='sending'`) e o `sendViaProvider` há uma sequência de
 * consultas; se o contato responder nesse intervalo, o webhook cancela a
 * inscrição mas a mensagem já em voo era enviada assim mesmo — a guarda de
 * `updateEnrollment` só barra a escrita DEPOIS do envio.
 */
async function aindaReivindicada(admin: SupabaseClient, enrollmentId: string): Promise<boolean> {
  const { data, error } = await admin
    .from("nurture_enrollments")
    .select("status")
    .eq("id", enrollmentId)
    .maybeSingle();
  if (error) {
    throw new Error(`Falha ao reler nurture_enrollments ${enrollmentId}: ${error.message}`);
  }
  return (data as { status: string } | null)?.status === "sending";
}

/**
 * `true` quando a conversa está na fila de atendimento humano.
 *
 * O campo é `awaiting_human`, NÃO `ai_active`: `findOrCreateConversation`
 * (_shared/messaging/conversation.ts:66) cria TODA conversa de automação com
 * `ai_active: false`, então guardar por `ai_active` barraria 100% da nutrição.
 * Quem marca o handoff é `performHandoff` (_shared/ai/pipeline.ts:492-500),
 * que liga `awaiting_human=true` junto com `ai_active=false` — e o mesmo
 * `awaiting_human=true` é o que `human-attention.ts` usa como "tem gente
 * cuidando disto". Zerado quando o operador resolve (inbox) ou responde
 * (messaging-send/index.ts:245).
 *
 * Lança em erro de leitura, igual `aindaReivindicada`: não dá para decidir
 * "pode enviar por cima" a partir de uma consulta que falhou, e o catch de
 * `processClaimedEnrollment` já converte isso em retry com backoff. Linha
 * ausente (conversa recém-criada por este mesmo envio) = não aguardando.
 */
async function conversaEmAtendimentoHumano(
  admin: SupabaseClient,
  conversationId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("conversations")
    .select("awaiting_human")
    .eq("id", conversationId)
    .maybeSingle();
  if (error) {
    throw new Error(`Falha ao reler conversations ${conversationId}: ${error.message}`);
  }
  return (data as { awaiting_human?: boolean } | null)?.awaiting_human === true;
}

/** Substituição simples de variável -- sem motor de template genérico (YAGNI). */
function renderTemplate(template: string, contact: ContactRow): string {
  return template
    .replaceAll("{{contact.name}}", contact.name ?? "")
    .replaceAll("{{contact.phone}}", contact.phone ?? "");
}

/**
 * Processa 1 enrollment já reivindicado (`status='sending'`). Nunca lança:
 * qualquer erro é capturado, logado e resolvido revertendo a inscrição para
 * `active` com um retry de backoff curto -- EXCETO depois que o envio externo
 * já foi confirmado (`result.ok`): a partir desse ponto, uma falha ao gravar o
 * avanço de step é só logada (a linha pode ficar presa em 'sending'), nunca
 * revertida para 'active', porque reverter reenviaria a mesma mensagem de
 * marketing na próxima execução -- duplicar envio é pior que uma linha presa.
 */
export async function processClaimedEnrollment(
  deps: NurtureRunnerDeps,
  enrollment: ClaimedEnrollment,
  horariosPorTenant: Map<string, BusinessHours> = new Map(),
): Promise<ProcessOutcome> {
  const { admin } = deps;

  try {
    const stepToSend = await loadStep(admin, enrollment.sequence_id, enrollment.current_step + 1);
    if (!stepToSend) {
      const aplicado = await updateEnrollment(admin, enrollment.id, {
        status: "completed",
        completed_at: new Date().toISOString(),
        next_send_at: null,
      });
      if (!aplicado) {
        console.log(
          `[nurture-runner] conclusão ignorada, inscrição foi cancelada: enrollment=${enrollment.id}`,
        );
        return { kind: "skipped_cancelled" };
      }
      return { kind: "completed" };
    }

    // Janela de envio antes de qualquer outra consulta: só depende do tenant, e
    // adiar aqui evita carregar contato, canal e — principalmente — os segredos
    // do provedor para uma mensagem que não vai sair agora.
    //
    // O horário é o mesmo que o cliente configurou em Perfil do Negócio. Sem
    // isto, a sequência disparava no relógio do agendamento: um passo com
    // `delay_hours: 24` inscrito às 3h da tarde de sexta chegava às 3h da tarde
    // de sábado, e um inscrito de madrugada chegava de madrugada.
    const hours = await loadBusinessHours(admin, enrollment.tenant_id, horariosPorTenant);
    const janela = janelaDeEnvio(hours, new Date());
    if (!janela.dentro) {
      const adiadoPara = janela.proximaAbertura
        ? janela.proximaAbertura.toISOString()
        : hoursFromNow(WINDOW_DEFER_HOURS_SEM_JANELA);
      const aplicado = await updateEnrollment(admin, enrollment.id, {
        status: "active",
        next_send_at: adiadoPara,
      });
      console.log(
        aplicado
          ? `[nurture-runner] fora do horário de atendimento, adiado para ${adiadoPara}: enrollment=${enrollment.id}`
          : `[nurture-runner] adiamento por horário ignorado, inscrição foi cancelada: enrollment=${enrollment.id}`,
      );
      return aplicado ? { kind: "deferred_window" } : { kind: "skipped_cancelled" };
    }

    const nextStep = await loadStep(admin, enrollment.sequence_id, enrollment.current_step + 2);

    const contact = await loadContact(admin, enrollment.contact_id);
    if (!contact) {
      throw new Error("Contato do enrollment não encontrado (removido ou soft-deleted).");
    }

    const suppressed = await isPhoneSuppressed(admin, enrollment.tenant_id, contact.phone);
    if (suppressed) {
      console.log(
        `[nurture-runner] inscrição cancelada por supressão de telefone: enrollment=${enrollment.id} contact=${enrollment.contact_id}`,
      );
      await cancelEnrollment(admin, enrollment, "telefone na lista de supressão");
      return { kind: "skipped_suppressed" };
    }

    const recentSends = await countRecentAutomatedSends(admin, {
      tenantId: enrollment.tenant_id,
      contactId: enrollment.contact_id,
      windowHours: FREQUENCY_GUARD_WINDOW_HOURS,
    });
    if (recentSends >= MAX_AUTOMATED_SENDS_PER_DAY) {
      console.log(
        `[nurture-runner] envio adiado por guard de frequência: enrollment=${enrollment.id} contact=${enrollment.contact_id}`,
      );
      const adiado = await updateEnrollment(admin, enrollment.id, {
        status: "active",
        next_send_at: hoursFromNow(FREQUENCY_DEFER_HOURS),
      });
      if (!adiado) {
        console.log(
          `[nurture-runner] adiamento ignorado, inscrição foi cancelada: enrollment=${enrollment.id}`,
        );
        return { kind: "skipped_cancelled" };
      }
      return { kind: "deferred_frequency" };
    }

    const channelId = await loadSequenceChannelId(admin, enrollment.sequence_id);
    if (!channelId) {
      throw new Error("Sequence sem canal configurado (channel_id nulo).");
    }
    const providerSlug = await loadChannelProviderSlug(admin, channelId);
    if (!providerSlug) {
      throw new Error("Canal da sequence não encontrado.");
    }
    if (!isSupportedProviderSlug(providerSlug)) {
      throw new Error(`Canal usa provider de envio não suportado: ${providerSlug}`);
    }

    const content = renderTemplate(stepToSend.message_template, contact);
    const conversation = await findOrCreateConversation(admin, {
      tenantId: enrollment.tenant_id,
      contactId: enrollment.contact_id,
      channelId,
    });
    // Quinta guarda, antes de carregar segredo de provedor: conversa já
    // assumida por humano não leva mensagem de sequência por cima do
    // atendimento. `findOrCreateConversation` reusa exatamente a conversa que
    // o `performHandoff` desligou, e o envio sairia com `sender='automation'`
    // no meio do atendimento. O caminho normal (contato responde) já é coberto
    // por `cancelNurtureOnReply` no webhook, que é best-effort: o resíduo que
    // esta guarda cobre é o cancelamento que falhou/expirou e a reinscrição
    // feita pelo scanner de auto-enroll enquanto a conversa segue na fila.
    // Pausa (adia), não cancela: handoff é condição temporária.
    if (await conversaEmAtendimentoHumano(admin, conversation.id)) {
      console.log(
        `[nurture-runner] envio adiado, conversa em atendimento humano: enrollment=${enrollment.id} conversation=${conversation.id}`,
      );
      const adiado = await updateEnrollment(admin, enrollment.id, {
        status: "active",
        next_send_at: hoursFromNow(HANDOFF_DEFER_HOURS),
      });
      if (!adiado) {
        console.log(
          `[nurture-runner] adiamento ignorado, inscrição foi cancelada: enrollment=${enrollment.id}`,
        );
        return { kind: "skipped_cancelled" };
      }
      return { kind: "deferred_handoff" };
    }

    // ManyChat/telegram/...: destino é identidade do contato, não o telefone.
    const destino = await resolveProviderDestination(admin, {
      tenantId: enrollment.tenant_id,
      contactId: enrollment.contact_id,
      providerSlug,
    });
    if (!destino.ok) throw new Error(destino.error);

    const cred = await loadProviderSecrets(admin, enrollment.tenant_id, providerSlug);

    // Última porta antes do envio externo: o claim aconteceu várias consultas
    // atrás e a resposta do contato pode ter cancelado a inscrição no meio.
    if (!(await aindaReivindicada(admin, enrollment.id))) {
      console.log(
        `[nurture-runner] envio abortado, inscrição deixou de estar reivindicada: enrollment=${enrollment.id}`,
      );
      return { kind: "skipped_cancelled" };
    }

    const result = await sendViaProvider({
      admin,
      providerSlug,
      cred,
      phone: contact.phone ?? undefined,
      email: contact.email ?? undefined,
      content,
      destination: destino.destination,
    });

    if (!result.ok) {
      const friendly = result.error ?? "Não foi possível enviar a mensagem.";
      await logAutomatedSend(admin, {
        tenantId: enrollment.tenant_id,
        conversationId: conversation.id,
        content,
        status: "failed",
        errorMessage: friendly,
      });
      throw new Error(friendly);
    }

    // Envio confirmado -- daqui pra frente NUNCA reverter para 'active'/retry
    // (reenviar duplicaria uma mensagem de marketing já entregue). O contador
    // de tentativas zera aqui: o teto vale por passo, senão uma sequência longa
    // acumularia falhas antigas e morreria no meio por causa delas.
    await logAutomatedSend(admin, {
      tenantId: enrollment.tenant_id,
      conversationId: conversation.id,
      content,
      status: "sent",
      externalId: result.external_id ?? undefined,
    });

    try {
      await advanceOrComplete(admin, enrollment, nextStep);
    } catch (bookkeepingErr) {
      const detalhe = redactSecrets(bookkeepingErr);
      console.error(
        `[nurture-runner] envio ${enrollment.id} confirmado, mas falhou ao gravar o avanço de step (linha pode ficar presa em 'sending'):`,
        detalhe,
      );
      // A mensagem JÁ saiu: reverter para 'active'/retry aqui reenviaria
      // marketing entregue. O que faltava era sinal — `claimDueEnrollments` só
      // reivindica `status='active'` e não existe reaper, então a inscrição
      // morre em silêncio e a sequência do contato para para sempre. Sem este
      // evento ninguém descobre: `console.error` morre com o isolate.
      // (Correção estrutural do estado preso = achado `01b · M3`, fora daqui.)
      await captureEdgeError(admin, {
        severity: "error",
        source: "edge",
        operation: "nurture.advance_step",
        tenantId: enrollment.tenant_id,
        conversationId: conversation.id,
        errorCode: "enrollment_stuck_sending",
        message:
          `Envio confirmado, mas o avanço de step falhou: inscrição presa em 'sending' e a sequência não continua. ${detalhe}`,
        context: {
          enrollment_id: enrollment.id,
          contact_id: enrollment.contact_id,
          sequence_id: enrollment.sequence_id,
          current_step: enrollment.current_step,
        },
      });
    }

    return { kind: "sent" };
  } catch (err) {
    const message = redactSecrets(err);
    console.error(`[nurture-runner] falha ao processar enrollment ${enrollment.id}:`, message);
    const tentativas = (enrollment.attempts ?? 0) + 1;
    try {
      if (tentativas >= MAX_SEND_ATTEMPTS) {
        // Desiste. Usa `cancelled` em vez de um status novo: a carência do
        // scanner (migration 20260805200000) é temporária — passada a janela de
        // estagnação/periodicidade o contato volta a ser elegível, que é o
        // comportamento certo para um número que estava ruim naquele momento.
        // O motivo fica em system_events, senão "sumiu" é a única explicação
        // disponível depois.
        await cancelEnrollment(
          admin,
          enrollment,
          `${tentativas} tentativas de envio sem sucesso (última: ${message})`,
        );
        return { kind: "exhausted", error: message };
      }
      const revertido = await updateEnrollment(admin, enrollment.id, {
        status: "active",
        next_send_at: minutesFromNow(SEND_RETRY_BACKOFF_MINUTES),
        attempts: tentativas,
      });
      if (!revertido) {
        console.log(
          `[nurture-runner] retry ignorado, inscrição foi cancelada durante a falha: enrollment=${enrollment.id}`,
        );
      }
    } catch (revertErr) {
      console.error(
        `[nurture-runner] falha ao reverter enrollment ${enrollment.id} para retry:`,
        redactSecrets(revertErr),
      );
    }
    return { kind: "retry", error: message };
  }
}

/**
 * Ponto de entrada da lógica: reivindica o batch e processa cada linha em
 * isolamento (try/catch individual) -- erro em 1 enrollment nunca aborta o
 * loop inteiro nem impede o processamento dos demais claimados no mesmo lote.
 */
export async function runNurtureRunner(
  deps: NurtureRunnerDeps,
  opts: { limit?: number } = {},
): Promise<RunSummary> {
  const claimed = await claimDueEnrollments(deps, opts);
  const summary: RunSummary = {
    processed: claimed.length,
    sent: 0,
    completed: 0,
    skippedSuppressed: 0,
    skippedCancelled: 0,
    deferredFrequency: 0,
    deferredHandoff: 0,
    deferredWindow: 0,
    exhausted: 0,
    retried: 0,
    errors: [],
  };

  // Um lote repete o mesmo tenant várias vezes; o horário de atendimento dele é
  // lido uma vez por execução, não uma vez por inscrição.
  const horariosPorTenant = new Map<string, BusinessHours>();

  for (const enrollment of claimed) {
    try {
      const outcome = await processClaimedEnrollment(deps, enrollment, horariosPorTenant);
      switch (outcome.kind) {
        case "sent":
          summary.sent++;
          break;
        case "completed":
          summary.completed++;
          break;
        case "skipped_suppressed":
          summary.skippedSuppressed++;
          break;
        case "skipped_cancelled":
          summary.skippedCancelled++;
          break;
        case "deferred_frequency":
          summary.deferredFrequency++;
          break;
        case "deferred_handoff":
          summary.deferredHandoff++;
          break;
        case "deferred_window":
          summary.deferredWindow++;
          break;
        case "exhausted":
          summary.exhausted++;
          summary.errors.push(`${enrollment.id}: ${outcome.error} (teto de tentativas)`);
          break;
        case "retry":
          summary.retried++;
          summary.errors.push(`${enrollment.id}: ${outcome.error}`);
          break;
      }

      // Falha no histórico não pode reenfileirar uma mensagem já entregue.
      const { error: historyError } = await deps.admin.from("nurture_execution_history").insert({
        tenant_id: enrollment.tenant_id,
        enrollment_id: enrollment.id,
        step_number: enrollment.current_step + 1,
        outcome: outcome.kind,
        detail: "error" in outcome ? outcome.error : null,
      });
      if (historyError) {
        throw new Error(`Falha ao registrar histórico da inscrição ${enrollment.id}: ${historyError.message}`);
      }
    } catch (err) {
      // Defesa extra: processClaimedEnrollment já captura os próprios erros
      // internamente e nunca deveria propagar -- isolar aqui garante que 1
      // enrollment não derruba o processamento dos demais do batch mesmo se
      // essa garantia falhar.
      const message = redactSecrets(err);
      console.error(
        `[nurture-runner] erro inesperado processando enrollment ${enrollment.id}:`,
        message,
      );
      summary.errors.push(`${enrollment.id}: ${message}`);
    }
  }

  return summary;
}
