// meeting-result.ts — núcleo puro do "Resultado da reunião" (process-meeting).
//
// Regra do módulo: o resultado estruturado da reunião (resumo, dores,
// objeções, prioridades, próximos passos) é GRAVADO como veio — sem IA — numa
// atividade nova do negócio. Nada aqui escreve em deals/contacts: empresa,
// contato, cargo, valor e estágio continuam sendo os do CRM.
//
// A IA só redige o RASCUNHO de follow-up, e o rascunho inteiro é recusado
// (volta o modelo determinístico) se trouxer número, data, dia da semana,
// preço, prazo, proposta ou tecnologia que não estão na reunião.
//
// Sem import de Deno/supabase: testável direto por `deno test`.

import { norm, TECH_TERMS } from "./meeting-prep.ts";

export const MEETING_RESULT_KIND = "meeting_result";

export interface MeetingInput {
  meetingId: string;
  title: string;
  seller: string | null;
  participants: string[];
  summary: string;
  painPoints: string[];
  objections: string[];
  priorities: string[];
  nextSteps: string[];
}

export interface FollowupDraft {
  subject: string;
  email: string;
  whatsapp: string;
  source: "ai" | "template";
  generatedAt: string;
}

export interface MeetingResultMetadata {
  kind: typeof MEETING_RESULT_KIND;
  idempotency_key: string;
  meeting: MeetingInput;
  followup_draft: FollowupDraft | null;
}

const MAX_TEXT = 2000;
const MAX_ITEMS = 10;
const MEETING_ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/;

function text(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 && t.length <= MAX_TEXT ? t : null;
}

function list(v: unknown): string[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_ITEMS) return null;
  const out = v.map(text);
  return out.every((x): x is string => x !== null) ? out : null;
}

/** Valida o payload. Campos de empresa/contato/valor/estágio não existem no
 * contrato: se vierem, são ignorados (nunca chegam ao banco). */
export function parseMeetingInput(
  raw: unknown,
): { ok: true; meeting: MeetingInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "meeting ausente." };
  const o = raw as Record<string, unknown>;
  const meetingId = typeof o.meetingId === "string" ? o.meetingId.trim() : "";
  if (!MEETING_ID_RE.test(meetingId)) return { ok: false, error: "meetingId inválido." };
  const title = text(o.title);
  const summary = text(o.summary);
  if (!title) return { ok: false, error: "title obrigatório." };
  if (!summary) return { ok: false, error: "summary obrigatório." };
  const participants = list(o.participants);
  const painPoints = list(o.painPoints);
  const objections = list(o.objections);
  const priorities = list(o.priorities);
  const nextSteps = list(o.nextSteps);
  if (!participants || !painPoints || !objections || !priorities || !nextSteps)
    return { ok: false, error: `Listas: até ${MAX_ITEMS} textos não vazios.` };
  if (nextSteps.length === 0) return { ok: false, error: "nextSteps obrigatório." };
  return {
    ok: true,
    meeting: {
      meetingId,
      title,
      seller: text(o.seller),
      participants,
      summary,
      painPoints,
      objections,
      priorities,
      nextSteps,
    },
  };
}

/** Mesma reunião no mesmo negócio = mesma chave = não duplica. */
export function idempotencyKey(dealId: string, meetingId: string): string {
  return `meeting:${dealId}:${meetingId}`;
}

export function activityTitle(m: MeetingInput): string {
  return `${m.title} concluída`;
}

// ---------------------------------------------------------------------------
// Follow-up (rascunho — nunca enviado)
// ---------------------------------------------------------------------------

export interface FollowupContext {
  contactName: string | null;
  companyName: string | null;
  meeting: MeetingInput;
}

export const FOLLOWUP_SYSTEM_PROMPT = `Você redige RASCUNHOS de follow-up comercial B2B após uma reunião.
O rascunho será revisado pelo vendedor antes de qualquer envio.

REGRAS:
1. Use SOMENTE os fatos do JSON recebido (resumo, dores, objeções, prioridades, próximos passos).
2. Não invente números, percentuais, horas, economia, ROI, preço, desconto, orçamento, prazo ou datas.
3. Não cite tecnologias, ferramentas, sistemas ou integrações que não estejam no JSON.
4. Não marque reunião, não sugira data ou dia da semana, não diga quando a reunião aconteceu (nada de "hoje"/"ontem"), não prometa proposta nem envio de material.
5. Não assuma compromisso que não esteja em "proximos_passos".
6. Trate a objeção com respeito, sem minimizar e sem prometer resultado.
7. Tom cordial e direto, em português do Brasil, primeira pessoa do vendedor.

Responda SOMENTE com um objeto JSON, sem markdown:
{"subject": string, "email": string, "whatsapp": string}
- subject: curto, com o nome da empresa.
- email: 4 a 7 frases, começando pelo primeiro nome do contato, assinado pelo vendedor.
- whatsapp: 2 a 3 frases, versão curta do mesmo conteúdo.`;

export function buildFollowupPrompt(ctx: FollowupContext): string {
  const m = ctx.meeting;
  return JSON.stringify(
    {
      contato: ctx.contactName,
      empresa: ctx.companyName,
      vendedor: m.seller,
      reuniao: m.title,
      resumo: m.summary,
      dores: m.painPoints,
      objecoes: m.objections,
      prioridades: m.priorities,
      proximos_passos: m.nextSteps,
    },
    null,
    2,
  );
}

export function parseDraft(raw: string): Pick<FollowupDraft, "subject" | "email" | "whatsapp"> | null {
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
  const [subject, email, whatsapp] = [o.subject, o.email, o.whatsapp].map(text);
  return subject && email && whatsapp ? { subject, email, whatsapp } : null;
}

// Termos que só podem aparecer se a própria reunião os mencionou.
const EXTRA_TECH = ["outlook", "gmail", "excel", "zoom", "teams", "pipedrive", "rd station", "crm"];
// Prefixo: pega plural e conjugação ("propostas", "agendamos", "horas").
const COMMITMENT_PREFIXES = [
  "prazo",
  "desconto",
  "proposta",
  "orcamento",
  "faturamento",
  "concorrente",
  "hora",
  "minuto",
  "semana",
  "agend",
  "enviarei",
  "vou enviar",
];
// Palavra inteira: "marco" não pode casar com "marcou".
const COMMITMENT_WORDS = [
  "preco",
  "roi",
  "amanha",
  // A reunião não tem data no contrato: "hoje"/"ontem" afirmam quando ela foi.
  "hoje",
  "ontem",
  "segunda-feira",
  "terca",
  "quarta-feira",
  "quinta-feira",
  "sexta-feira",
  "sabado",
  "domingo",
  "janeiro",
  "fevereiro",
  "marco",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

function sourceText(ctx: FollowupContext): string {
  const m = ctx.meeting;
  return norm(
    [
      ctx.contactName,
      ctx.companyName,
      m.seller,
      m.title,
      m.summary,
      ...m.participants,
      ...m.painPoints,
      ...m.objections,
      ...m.priorities,
      ...m.nextSteps,
    ]
      .filter(Boolean)
      .join(" \n "),
  );
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Motivo para recusar o rascunho INTEIRO, ou null. Frase a frase deixaria
 * um e-mail incoerente; recusado, volta o modelo determinístico. */
export function draftRejectReason(draftText: string, ctx: FollowupContext): string | null {
  const t = norm(draftText);
  const source = sourceText(ctx);
  if (/r\$|%/.test(t) && !/r\$|%/.test(source)) return "valor";
  for (const d of t.match(/\d+/g) ?? []) {
    if (!new RegExp(`\\b${d}\\b`).test(source)) return `numero:${d}`;
  }
  for (const term of [...TECH_TERMS, ...EXTRA_TECH]) {
    const re = new RegExp(`\\b${escapeRe(term)}\\b`);
    if (re.test(t) && !re.test(source)) return `tecnologia:${term}`;
  }
  const commitments = [
    ...COMMITMENT_PREFIXES.map((w) => [w, new RegExp(`\\b${escapeRe(w)}`)] as const),
    ...COMMITMENT_WORDS.map((w) => [w, new RegExp(`\\b${escapeRe(w)}\\b`)] as const),
  ];
  for (const [term, re] of commitments) {
    if (re.test(t) && !re.test(source)) return `compromisso:${term}`;
  }
  return null;
}

function firstName(name: string | null): string | null {
  return name?.trim().split(/\s+/)[0] ?? null;
}

/** "Reduzir atividades administrativas." → "reduzir atividades administrativas" */
function clause(s: string): string {
  const t = s.trim().replace(/[.;]+$/, "");
  return t.charAt(0).toLowerCase() + t.slice(1);
}

function joinPt(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} e ${items[items.length - 1]}`;
}

/** Rascunho sem IA: só remonta os campos da reunião. Fallback garantido. */
export function templateDraft(ctx: FollowupContext, now: Date): FollowupDraft {
  const m = ctx.meeting;
  const nome = firstName(ctx.contactName);
  const saudacao = nome ? `${nome},` : "Olá,";
  const empresa = ctx.companyName ? ` — ${ctx.companyName}` : "";
  const prioridades = m.priorities.map(clause);
  const objecao = m.objections[0] ? clause(m.objections[0]) : null;
  const passos = joinPt(m.nextSteps.map(clause));
  const linhas = [
    saudacao,
    "",
    "obrigado pela conversa.",
    prioridades.length > 0
      ? `Ficaram claras as prioridades para vocês: ${joinPt(prioridades)}.`
      : null,
    objecao ? `Também registrei sua preocupação: ${objecao}.` : null,
    `Como combinamos, o próximo passo é ${passos}.`,
    "",
    "Fico à disposição para qualquer ajuste.",
    m.seller ? `\nAbraço,\n${m.seller}` : null,
  ].filter((l): l is string => l !== null);
  return {
    subject: `Próximos passos${empresa}`,
    email: linhas.join("\n"),
    whatsapp: `${saudacao} obrigado pela conversa. Como combinamos, o próximo passo é ${passos}.`,
    source: "template",
    generatedAt: now.toISOString(),
  };
}
