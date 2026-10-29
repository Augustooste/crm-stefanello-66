// Watchdog de SLA de handoff humano (Fase 3 do PRD — docs/PRD-CRM-IA-MULTINICHO.md
// linhas ~1646/1681, riscos #3 e #7).
//
// Risco #7 do PRD ("watchdog rodando sobre dado errado"): a tabela real desta
// fase é `hitl_handoff_sla_events` (aplicada por
// supabase/migrations/20260710120000_fase3_hitl_decision_queue_schema.sql),
// confirmada por leitura direta da migration antes de escrever a query
// abaixo — não confiar em nome de tabela citado de memória. Essa mesma
// migration também confirma que `conversations` NÃO tem coluna `deal_id`
// (só `contact_id`) e que `hitl_decisions` NÃO tem coluna de "assignee"
// dedicada — ver `resolveOwnerId` e o campo `suggested_action` abaixo para
// como isso é contornado sem inventar schema novo.
//
// Risco #3 do PRD ("alerta hardcoded para uma pessoa"): NENHUM telefone/
// contato fixo aparece neste arquivo. O destinatário é resolvido
// dinamicamente por evento: conversation -> contact_id -> deal mais recente
// desse contato -> deals.owner_id; sem deal (ou deal sem owner), cai para o
// admin mais antigo do tenant. Notificação por canal configurado em
// `ai_settings` fica como TODO (ver abaixo) — `ai_settings` hoje não tem
// coluna de canal de notificação; criar isso é fora de escopo desta function.
//
// Dormente por design: sem pg_cron/migration de agendamento. Chamada manual
// (curl com a service role key) ou por um scheduler futuro.
//
// Contrato com a Decision Queue (UI, fase Frontend/task #3, ainda não
// construída): como `hitl_decisions` não tem coluna de assignee, o owner
// resolvido vem em `suggested_action.owner_id` -- a UI (e os outros
// analisadores de hitl_decisions do task #2) precisam ler esse campo daí,
// não de uma coluna dedicada.
//
// Concorrência (limitação conhecida, não resolvida aqui): duas execuções
// sobrepostas do watchdog podem ambas ler o mesmo evento com
// `sla_alerted_at IS NULL` antes de qualquer uma marcar, gerando 2 decisions
// para o mesmo evento. O claim atômico (`UPDATE ... WHERE ... RETURNING`,
// mesmo padrão de outras filas do projeto) é o primitivo da Fase 4 do PRD
// (linha ~1736) -- não adiantar aqui enquanto a function está dormente/sem
// cron real. Preferir "alertar 2x" a "nunca alertar" é a escolha segura
// desta function caso a concorrência realmente aconteça.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { captureEdgeError } from "../_shared/telemetry.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Default razoável enquanto não há UI/coluna de configuração por tenant para
// o limite de SLA de handoff; configurável via env var.
const DEFAULT_BREACH_MINUTES = 30;

interface HandoffSlaEvent {
  id: string;
  tenant_id: string;
  conversation_id: string;
  activity_id: string | null;
  awaiting_human_since: string;
}

interface ConversationRow {
  contact_id: string | null;
}

interface DealRow {
  id: string;
  owner_id: string | null;
}

interface ProfileRow {
  id: string;
}

interface OwnerResolution {
  ownerId: string | null;
  dealId: string | null;
  contactId: string | null;
}

interface MonitorSummary {
  scanned: number;
  alerted: number;
  errors: string[];
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

function resolveBreachMinutes(): number {
  const raw = Deno.env.get("HITL_SLA_BREACH_MINUTES");
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_BREACH_MINUTES;
  return parsed;
}

function minutesElapsed(sinceIso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(sinceIso).getTime()) / 60_000));
}

// deno-lint-ignore no-explicit-any
type AdminClient = ReturnType<typeof createClient<any>>;

/**
 * Descobre quem deve ser escalado por um handoff estourado. NUNCA um
 * telefone/pessoa fixa (risco #3 do PRD).
 *
 * `conversations` não tem `deal_id` (validado no schema real) — o vínculo é
 * via `contact_id`. Como um contato pode ter mais de um deal, pega o mais
 * recentemente atualizado (heurística simples e documentada, não uma regra
 * de negócio nova). Sem deal, ou deal sem `owner_id`, cai para o admin mais
 * antigo do tenant — nunca um contato fixo.
 */
async function resolveOwnerId(
  admin: AdminClient,
  tenantId: string,
  conversationId: string,
): Promise<OwnerResolution> {
  const { data: conversation, error: conversationError } = await admin
    .from("conversations")
    .select("contact_id")
    .eq("id", conversationId)
    .maybeSingle<ConversationRow>();

  if (conversationError) {
    console.error("[hitl-sla-monitor] query conversations falhou:", conversationError.message);
  }

  const contactId = conversation?.contact_id ?? null;

  let dealId: string | null = null;
  let ownerId: string | null = null;

  if (contactId) {
    const { data: deal, error: dealError } = await admin
      .from("deals")
      .select("id, owner_id")
      .eq("tenant_id", tenantId)
      .eq("contact_id", contactId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle<DealRow>();

    if (dealError) {
      console.error("[hitl-sla-monitor] query deals falhou:", dealError.message);
    }

    if (deal) {
      dealId = deal.id;
      ownerId = deal.owner_id;
    }
  }

  if (!ownerId) {
    const { data: fallbackAdmin, error: profileError } = await admin
      .from("profiles")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("role", "admin")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle<ProfileRow>();

    if (profileError) {
      console.error("[hitl-sla-monitor] query profiles falhou:", profileError.message);
    }
    ownerId = fallbackAdmin?.id ?? null;
  }

  return { ownerId, dealId, contactId };
}

/**
 * Processa um evento estourado: resolve o owner, cria a `hitl_decisions` e
 * marca `sla_alerted_at` (idempotência — critério de aceite do PRD:1681).
 * Retorna o erro (se houver) em vez de lançar, para o loop do handler seguir
 * processando os demais eventos da leva.
 */
async function processBreachedEvent(
  admin: AdminClient,
  event: HandoffSlaEvent,
  breachMinutes: number,
): Promise<{ alerted: boolean; duplicate?: boolean; error?: string }> {
  const { ownerId, dealId, contactId } = await resolveOwnerId(admin, event.tenant_id, event.conversation_id);
  const elapsedMinutes = minutesElapsed(event.awaiting_human_since);

  const { error: insertError } = await admin.from("hitl_decisions").insert({
    tenant_id: event.tenant_id,
    type: "sla_breach",
    priority: "critical",
    category: "deadline",
    title: `Atendimento humano aguardando há ${elapsedMinutes} min`,
    description:
      `Handoff aberto em ${event.awaiting_human_since} sem resposta humana ` +
      `(limite configurado: ${breachMinutes} min).`,
    reasoning: "hitl-sla-monitor detectou handoff sem resposta humana dentro do prazo configurado.",
    deal_id: dealId,
    contact_id: contactId,
    activity_id: event.activity_id,
    suggested_action: {
      // hitl_decisions não tem coluna de "assignee" dedicada (schema real
      // validado nesta sessão) -- o owner resolvido dinamicamente vai aqui
      // para a Decision Queue exibir/rotear, nunca um contato fixo.
      action: "escalate_handoff",
      owner_id: ownerId,
      conversation_id: event.conversation_id,
      sla_event_id: event.id,
    },
  });

  if (insertError) {
    // 23505 aqui não é falha de insert real: é a race documentada no
    // cabeçalho deste arquivo (duas execuções sobrepostas do watchdog lendo
    // o mesmo evento com sla_alerted_at IS NULL antes de qualquer uma
    // marcar). A unique index parcial
    // idx_hitl_decisions_one_pending_per_activity (activity_id, type) WHERE
    // status='pending' AND activity_id IS NOT NULL barra a segunda tentativa
    // quando o evento tem activity_id — é o único ponto em que essa race
    // conhecida vira algo detectável em runtime. Reporta como warn
    // (esperado, não incidente), não error.
    if (insertError.code === "23505") {
      await captureEdgeError(admin, {
        severity: "warn",
        source: "edge",
        operation: "hitl.sla_monitor.duplicate",
        tenantId: event.tenant_id,
        conversationId: event.conversation_id,
        message:
          `Alerta de SLA duplicado para o evento ${event.id} (race entre execuções sobrepostas do watchdog).`,
        context: { slaEventId: event.id, activityId: event.activity_id },
      });
      return { alerted: false, duplicate: true, error: `${event.id}: ${insertError.message}` };
    }
    return { alerted: false, error: `${event.id}: ${insertError.message}` };
  }

  // TODO(fora de escopo desta function): notificar o owner pelo canal
  // configurado em `ai_settings` (ex.: WhatsApp/e-mail) quando essa coluna
  // existir no schema -- hoje `ai_settings` não tem canal de notificação.
  // A `hitl_decisions` criada acima já é o que a Decision Queue exibe.

  const { error: updateError } = await admin
    .from("hitl_handoff_sla_events")
    .update({ sla_alerted_at: new Date().toISOString() })
    .eq("id", event.id);

  if (updateError) {
    return { alerted: false, error: `${event.id}: falha ao marcar sla_alerted_at: ${updateError.message}` };
  }

  return { alerted: true };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Fail-closed: só aceita bearer = service role (mesmo padrão de
  // ai-memory-consolidate/index.ts). Não é rota pública nem chamada com JWT
  // de usuário; pensada para ser chamada por um processo server-side.
  const authHeader = req.headers.get("Authorization") ?? "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!bearer || bearer !== SERVICE_ROLE) {
    return json(401, { error: "Unauthorized" });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false, autoRefreshToken: false } });
  const breachMinutes = resolveBreachMinutes();
  const cutoffIso = new Date(Date.now() - breachMinutes * 60_000).toISOString();

  const { data: events, error: fetchError } = await admin
    .from("hitl_handoff_sla_events")
    .select("id, tenant_id, conversation_id, activity_id, awaiting_human_since")
    .is("resolved_at", null)
    .is("sla_alerted_at", null)
    .lt("awaiting_human_since", cutoffIso)
    .returns<HandoffSlaEvent[]>();

  if (fetchError) {
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "hitl.sla_monitor",
      message: fetchError.message,
      context: { cutoffIso, breachMinutes },
    });
    return json(500, { error: fetchError.message });
  }

  const summary: MonitorSummary = { scanned: events?.length ?? 0, alerted: 0, errors: [] };

  // Separado de summary.errors.length: a race de 23505 (duplicate) já vira
  // warn individual dentro de processBreachedEvent, mas AINDA cai em
  // summary.errors (resposta HTTP não muda). Sem descontar duplicates aqui,
  // um run cuja ÚNICA anomalia é a race documentada geraria também um
  // evento .process de severity "error" — invertendo o que devia ser warn.
  let duplicates = 0;
  for (const event of events ?? []) {
    try {
      const result = await processBreachedEvent(admin, event, breachMinutes);
      if (result.alerted) {
        summary.alerted++;
      } else if (result.error) {
        summary.errors.push(result.error);
        if (result.duplicate) duplicates++;
      }
    } catch (err) {
      summary.errors.push(`${event.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Um evento agregado por execução (não um por evento processado): cobre
  // o que sobra depois de descontar as duplicatas já reportadas como warn
  // acima (updateError de sla_alerted_at, insertError não-23505, exceptions
  // inesperadas do catch acima) — hoje só vira string em summary.errors e
  // nunca é lido por ninguém (chamada é fire-and-forget de cron via pg_net).
  const nonDuplicateFailures = summary.errors.length - duplicates;
  if (nonDuplicateFailures > 0) {
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "hitl.sla_monitor.process",
      message:
        `${nonDuplicateFailures} evento(s) de SLA falharam ao processar de ${summary.scanned} escaneado(s).`,
      context: {
        scanned: summary.scanned,
        alerted: summary.alerted,
        duplicates,
        errors: summary.errors.slice(0, 10),
      },
    });
  }

  return json(200, summary);
});
