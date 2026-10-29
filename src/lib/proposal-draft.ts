/**
 * Proposta comercial (SIMULAÇÃO) montada a partir do que já está no CRM.
 *
 * Regras:
 * - Fatos (empresa, contato, cargo, negócio, valor, estágio) vêm do banco.
 * - Contexto e problemas vêm do resultado da reunião gravado pela Demo 4
 *   (activities.metadata.meeting), filtrado por `proposalRejectReason`:
 *   linha com número, tecnologia, orçamento ou atribuição de pedido não entra.
 * - Escopo, entregáveis e próximos passos são texto fixo, sem integração
 *   específica e sem compromisso (a reunião não combinou proposta).
 * - Nenhum número financeiro sai daqui: isso é `business-case.ts`.
 */

export interface ProposalMeeting {
  title: string;
  summary: string;
  painPoints: string[];
  objections: string[];
  priorities: string[];
  nextSteps: string[];
}

export interface ProposalSections {
  context: string[];
  problems: string[];
  concerns: string[];
  objectives: string[];
  scope: string[];
  deliverables: string[];
  howItWorks: string[];
  nextSteps: string[];
  previousNextStep: string[];
}

const TECH = [
  "erp",
  "sap",
  "totvs",
  "legado",
  "oracle",
  "protheus",
  "salesforce",
  "hubspot",
  "pipedrive",
  "outlook",
  "gmail",
  "excel",
  "zoom",
  "teams",
  "rd station",
];
const FORBIDDEN = [
  "orcamento",
  "budget",
  "faturamento",
  "margem",
  "cac",
  "ltv",
  "concorrente",
  "roi",
  "payback",
  "aprovad",
  "solicit",
  "pediu",
  "como combinado",
  "conforme combinado",
  "conforme alinhado",
  "segue a proposta",
];

function norm(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Motivo para um texto NÃO entrar na proposta, ou null. */
export function proposalRejectReason(text: string): string | null {
  const t = norm(text);
  if (/\d/.test(t)) return "numero";
  if (/r\$|%/.test(t)) return "valor";
  for (const w of TECH) if (new RegExp(`\\b${w}\\b`).test(t)) return `tecnologia:${w}`;
  for (const w of FORBIDDEN) if (new RegExp(`\\b${w}`).test(t)) return `proibido:${w}`;
  return null;
}

const keep = (items: string[]) => items.filter((s) => proposalRejectReason(s) === null);

export function buildProposalSections(meeting: ProposalMeeting | null): ProposalSections {
  return {
    context: meeting ? keep([meeting.summary]) : [],
    problems: meeting ? keep(meeting.painPoints) : [],
    concerns: meeting ? keep(meeting.objections) : [],
    objectives: [
      "Reduzir o esforço administrativo do time comercial.",
      "Aumentar a consistência dos registros de oportunidades.",
      "Melhorar a visibilidade do pipeline para a gestão.",
      "Reduzir a dependência de atualização manual do CRM.",
      "Estruturar follow-ups e próximos passos após cada reunião.",
    ],
    scope: [
      "Registro automático do resultado das reuniões no CRM.",
      "Consolidação de resumo, dores, objeções, prioridades e próximo passo.",
      "Geração assistida de follow-up como rascunho para revisão do vendedor.",
      "Identificação de oportunidades sem atualização recente.",
      "Visão operacional do pipeline para a gestão comercial.",
    ],
    deliverables: [
      "Mapeamento do fluxo comercial atual e das tarefas automatizáveis.",
      "Fluxo de registro pós-reunião configurado no CRM.",
      "Modelo de follow-up com revisão obrigatória pelo vendedor.",
      "Painel de oportunidades sem atualização.",
      "Business case revisado com as premissas validadas pelo cliente.",
    ],
    howItWorks: [
      "A reunião termina e o resultado estruturado entra no negócio, sem digitação.",
      "O vendedor revisa o resumo e o rascunho de follow-up antes de qualquer envio.",
      "A gestão enxerga quais oportunidades estão sem atualização.",
      "Nenhuma etapa nova é adicionada ao dia do vendedor.",
    ],
    nextSteps: [
      "Validar as premissas da simulação com a Atlas Industrial.",
      "Confirmar o escopo.",
      "Ajustar o business case com os dados validados.",
      "Revisar a proposta.",
      "Somente então avançar comercialmente.",
    ],
    previousNextStep: meeting ? keep(meeting.nextSteps) : [],
  };
}
