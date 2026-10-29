// meeting-prep.ts — núcleo puro do "Preparar reunião" (prepare-meeting).
//
// Regra do módulo: FATOS do CRM (empresa, contato, cargo, valor, estágio,
// reunião, responsável, próximo passo) saem daqui deterministicamente, a
// partir das linhas do banco. A IA só produz resumo, hipóteses, perguntas e
// pontos de atenção — e o que ela devolve passa por `sanitizeGenerated`, que
// descarta item com UUID, cargo diferente do cadastrado ou tecnologia (ERP,
// SAP, TOTVS, legado) que não aparece nas fontes. A UI nunca lê fato da IA.
//
// Origem: o Copiloto trocou "Diretora Comercial" por "Gerente Comercial",
// inventou risco de "ERP legado" e mostrou `deals.status` ("Aberto") no lugar
// do nome do estágio (validação Demo 2, 23/09/2026).
//
// Sem import de Deno/supabase: testável direto por `deno test`.

export const MEETING_TIME_ZONE = "America/Sao_Paulo";

export interface DealRow {
  title: string;
  value: number | string | null;
  status: string;
  owner_id: string | null;
}

export interface ContactRow {
  name: string;
  job_title: string | null;
  email: string | null;
  phone: string | null;
  description: string | null;
  notes: string | null;
  address_city: string | null;
}

export interface CompanyRow {
  name: string;
  industry: string | null;
}

export interface ActivityRow {
  type: string;
  title: string;
  due_at: string | null;
  completed_at: string | null;
}

export interface MeetingFacts {
  company: { name: string; industry: string | null; city: string | null } | null;
  contact: {
    name: string;
    title: string | null;
    email: string | null;
    phone: string | null;
  } | null;
  deal: {
    title: string;
    value: number | null;
    valueLabel: string;
    stageName: string | null;
    ownerName: string | null;
  };
  meeting: { title: string; dateLabel: string; timeLabel: string; dueAt: string } | null;
  objective: string | null;
  knownContext: string[];
  recordedHypotheses: string[];
  nextStep: { title: string; dateLabel: string | null } | null;
  attentionPoints: string[];
}

export interface GeneratedBriefing {
  summary: string | null;
  hypotheses: Array<{ text: string; reason: string }>;
  suggestedQuestions: string[];
  attentionPoints: string[];
}

const HYPOTHESIS_RE = /hip[oó]tese/i;
const MEETING_TITLE_RE = /reuni[aã]o|call|diagn[oó]stico|apresenta/i;
const OBJECTIVE_RE = /^\s*objetivo[^:]*:\s*/i;

export function formatBRL(v: number): string {
  return v.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  });
}

export function formatDateSP(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: MEETING_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(iso));
}

export function formatTimeSP(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: MEETING_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function toNumber(v: number | string | null): number | null {
  if (v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function clean(s: string | null | undefined): string | null {
  const t = (s ?? "").trim();
  return t.length > 0 ? t : null;
}

/** Atividades abertas, com data, que não são nota nem log de IA — as
 * candidatas a "reunião" e "próximo passo", em ordem cronológica. */
function openScheduled(activities: ActivityRow[]): ActivityRow[] {
  return activities
    .filter((a) => (a.type === "task" || a.type === "call") && !a.completed_at && a.due_at)
    .sort((a, b) => Date.parse(a.due_at!) - Date.parse(b.due_at!));
}

/** Reunião = atividade aberta mais próxima a partir de hoje cujo título fala
 * de reunião; sem nenhuma assim, a atividade aberta mais próxima a partir de
 * hoje. Passadas não contam: reunião de ontem não é "a próxima reunião". */
export function selectMeeting(activities: ActivityRow[], now: Date): ActivityRow | null {
  // ponytail: janela fixa de 24h para trás (cobre "hoje" em qualquer fuso), não início do dia em SP.
  const cutoff = now.getTime() - 24 * 60 * 60 * 1000;
  const upcoming = openScheduled(activities).filter((a) => Date.parse(a.due_at!) >= cutoff);
  return upcoming.find((a) => MEETING_TITLE_RE.test(a.title)) ?? upcoming[0] ?? null;
}

/** Objetivo = nota da negociação que começa com "Objetivo…:". */
export function selectObjective(activities: ActivityRow[]): string | null {
  const note = activities.find((a) => a.type === "note" && OBJECTIVE_RE.test(a.title));
  return note ? clean(note.title.replace(OBJECTIVE_RE, "")) : null;
}

export function buildMeetingFacts(input: {
  deal: DealRow;
  stageName: string | null;
  ownerName: string | null;
  contact: ContactRow | null;
  company: CompanyRow | null;
  activities: ActivityRow[];
  now: Date;
}): MeetingFacts {
  const { deal, contact, company, activities, now } = input;
  const value = toNumber(deal.value);
  const meetingRow = selectMeeting(activities, now);
  const nextRow = openScheduled(activities)[0] ?? null;

  const knownContext: string[] = [];
  const recordedHypotheses: string[] = [];
  const description = clean(contact?.description);
  if (description) knownContext.push(description);
  const notes = clean(contact?.notes);
  if (notes) (HYPOTHESIS_RE.test(notes) ? recordedHypotheses : knownContext).push(notes);
  for (const a of activities) {
    if (a.type !== "note" || OBJECTIVE_RE.test(a.title)) continue;
    const t = clean(a.title);
    if (t) (HYPOTHESIS_RE.test(t) ? recordedHypotheses : knownContext).push(t);
  }

  const title = clean(contact?.job_title);
  const facts: MeetingFacts = {
    company: company
      ? {
          name: company.name,
          industry: clean(company.industry),
          city: clean(contact?.address_city),
        }
      : null,
    contact: contact
      ? { name: contact.name, title, email: clean(contact.email), phone: clean(contact.phone) }
      : null,
    deal: {
      title: deal.title,
      value,
      valueLabel: value === null ? "Valor não informado" : formatBRL(value),
      stageName: clean(input.stageName),
      ownerName: clean(input.ownerName),
    },
    meeting: meetingRow
      ? {
          title: meetingRow.title,
          dateLabel: formatDateSP(meetingRow.due_at!),
          timeLabel: formatTimeSP(meetingRow.due_at!),
          dueAt: meetingRow.due_at!,
        }
      : null,
    objective: selectObjective(activities),
    knownContext,
    recordedHypotheses,
    nextStep: nextRow ? { title: nextRow.title, dateLabel: formatDateSP(nextRow.due_at!) } : null,
    attentionPoints: [],
  };
  facts.attentionPoints = deterministicAttentionPoints(facts);
  return facts;
}

/** Pontos de atenção que não precisam de IA: valor, cargo, estágio, reunião,
 * hipóteses pendentes. Calculados aqui para a IA nunca fazer conta. */
export function deterministicAttentionPoints(f: MeetingFacts): string[] {
  const out: string[] = [];
  if (f.deal.value !== null) out.push(`Oportunidade de ${f.deal.valueLabel}.`);
  if (f.contact) {
    out.push(
      f.contact.title
        ? `Contato principal: ${f.contact.name}, ${f.contact.title}.`
        : `Cargo de ${f.contact.name} não informado no CRM — confirmar na reunião.`,
    );
  } else {
    out.push("Negócio sem contato vinculado.");
  }
  out.push(
    f.deal.stageName
      ? `Estágio atual: ${f.deal.stageName}.`
      : "Estágio do negócio não identificado.",
  );
  out.push(
    f.meeting
      ? `Reunião agendada para ${f.meeting.dateLabel} às ${f.meeting.timeLabel}.`
      : "Nenhuma reunião agendada.",
  );
  if (f.recordedHypotheses.length > 0)
    out.push("Existem hipóteses registradas ainda não validadas.");
  return out;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const MEETING_PREP_SYSTEM_PROMPT = `Você é um assistente de preparação de reuniões comerciais B2B.
Você receberá fatos estruturados provenientes do CRM.

REGRAS:
1. Não altere nomes, cargos, empresas, valores, estágios ou datas.
2. Não invente faturamento, número de funcionários, tecnologias, ERP, concorrentes, dores, orçamento, decisores, ferramentas utilizadas ou histórico.
3. Qualquer inferência deve aparecer explicitamente como hipótese.
4. Diferencie fatos conhecidos de hipóteses a validar. O resumo só pode conter fatos presentes no contexto.
5. Não reproduza IDs técnicos nem UUIDs.
6. Não atribua ao contato um cargo diferente daquele fornecido. Se o cargo for null, não mencione cargo.
7. Não use status técnico do banco como nome do estágio.
8. Se uma informação não estiver disponível, não complete.
9. Perguntas sugeridas devem buscar validar as hipóteses.

Responda SOMENTE com um objeto JSON, sem markdown:
{"summary": string, "hypotheses": [{"text": string, "reason": string}], "suggestedQuestions": [string], "attentionPoints": [string]}
- summary: 2 a 3 frases com o que se sabe (fatos do contexto).
- hypotheses: 2 a 5 itens; "reason" diz de qual informação do contexto a hipótese veio.
- suggestedQuestions: 4 a 6 perguntas abertas para a reunião.
- attentionPoints: 0 a 3 cuidados de condução da reunião (não repita valor, estágio ou data).`;

/** Contexto enviado à IA: só fatos, sem nenhum id. */
export function buildPromptContext(f: MeetingFacts): string {
  const ctx = {
    empresa: f.company,
    contato: f.contact ? { nome: f.contact.name, cargo: f.contact.title } : null,
    negocio: { nome: f.deal.title, valor: f.deal.valueLabel, estagio: f.deal.stageName },
    reuniao: f.meeting
      ? { titulo: f.meeting.title, data: f.meeting.dateLabel, horario: f.meeting.timeLabel }
      : null,
    objetivo: f.objective,
    contexto_conhecido: f.knownContext,
    hipoteses_registradas: f.recordedHypotheses,
  };
  return JSON.stringify(ctx, null, 2);
}

// ---------------------------------------------------------------------------
// Parsing + filtro anti-alucinação
// ---------------------------------------------------------------------------

function strings(v: unknown): string[] {
  return Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x) => x.trim())
    : [];
}

export function parseGenerated(raw: string): GeneratedBriefing | null {
  let data: unknown;
  try {
    data = JSON.parse(
      raw
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```\s*$/, "")
        .trim(),
    );
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  const hypotheses = Array.isArray(o.hypotheses)
    ? o.hypotheses.flatMap((h) => {
        if (typeof h === "string" && h.trim()) return [{ text: h.trim(), reason: "" }];
        if (h && typeof h === "object" && typeof (h as { text?: unknown }).text === "string") {
          const r = (h as { reason?: unknown }).reason;
          return [
            {
              text: (h as { text: string }).text.trim(),
              reason: typeof r === "string" ? r.trim() : "",
            },
          ];
        }
        return [];
      })
    : [];
  return {
    summary: typeof o.summary === "string" && o.summary.trim() ? o.summary.trim() : null,
    hypotheses,
    suggestedQuestions: strings(o.suggestedQuestions),
    attentionPoints: strings(o.attentionPoints),
  };
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
export const TECH_TERMS = ["erp", "sap", "totvs", "legado", "oracle", "protheus", "salesforce", "hubspot"];
const ROLE_RE =
  /\b(gerente|diretora?|ceo|cfo|cto|coo|cmo|presidente|vice-presidente|coordenadora?|supervisora?|head|s[oó]cia?|fundadora?)\b/gi;

export function norm(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Motivo pelo qual um texto gerado não pode ir para a tela, ou null. */
export function rejectReason(text: string, facts: MeetingFacts): string | null {
  if (UUID_RE.test(text)) return "uuid";
  const source = norm(
    [
      facts.company?.name,
      facts.company?.industry,
      facts.contact?.name,
      facts.contact?.title,
      facts.deal.title,
      facts.objective,
      facts.meeting?.title,
      ...facts.knownContext,
      ...facts.recordedHypotheses,
    ]
      .filter(Boolean)
      .join(" \n "),
  );
  const t = norm(text);
  for (const term of TECH_TERMS) {
    if (new RegExp(`\\b${term}\\b`).test(t) && !new RegExp(`\\b${term}\\b`).test(source))
      return `termo:${term}`;
  }
  const titleWords = new Set(
    norm(facts.contact?.title ?? "")
      .split(/\s+/)
      .filter(Boolean),
  );
  for (const m of t.matchAll(ROLE_RE)) {
    if (!titleWords.has(norm(m[0]))) return `cargo:${m[0]}`;
  }
  return null;
}

export function sanitizeGenerated(
  gen: GeneratedBriefing,
  facts: MeetingFacts,
): { briefing: GeneratedBriefing; rejected: string[] } {
  const rejected: string[] = [];
  const keep = (s: string) => {
    const why = rejectReason(s, facts);
    if (why) rejected.push(why);
    return !why;
  };
  return {
    briefing: {
      summary: gen.summary && keep(gen.summary) ? gen.summary : null,
      hypotheses: gen.hypotheses.filter((h) => keep(`${h.text} ${h.reason}`)).slice(0, 5),
      suggestedQuestions: gen.suggestedQuestions.filter(keep).slice(0, 6),
      attentionPoints: gen.attentionPoints.filter(keep).slice(0, 3),
    },
    rejected,
  };
}
