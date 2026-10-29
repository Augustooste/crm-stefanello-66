// qualification/prompt.ts — monta o system prompt (dimensões do nicho) e o
// contexto do deal formatado como texto para o LLM.
//
// Extraído de qualification.ts (split de simplificação) — ver banner de
// qualification.ts para o racional completo do porte do medflow.

import type { DealQualificationContext, QualificationDimensionConfig } from "./context.ts";

export function buildSystemPrompt(dimensions: QualificationDimensionConfig[]): string {
  const dimensionKeys = dimensions.map((d) => `"${d.key}"`).join(", ");
  const dimensionList = dimensions.map((d) => `- ${d.key}: ${d.label}`).join("\n");

  return `Você é um assistente de vendas brasileiro especializado em qualificação de leads.

IMPORTANTE: TODO o conteúdo gerado DEVE estar em PORTUGUÊS BRASILEIRO.

Analise o histórico de comunicação com um lead e gere uma qualificação estruturada usando EXATAMENTE estas dimensões (definidas pelo nicho deste negócio, não são fixas):
${dimensionList}

Responda APENAS com um objeto JSON puro (sem markdown, sem texto extra), no formato:
{
  "executiveSummary": "resumo executivo conciso do status do deal em português",
  "dimensions": [{"key": "<uma das chaves: ${dimensionKeys}>", "status": "ex: desconhecido|mencionado|confirmado", "notes": "contexto em português"}],
  "pendingPoints": [{"point": "ponto pendente em português", "context": "breve contexto", "priority": "high" | "medium" | "low"}],
  "recommendedApproach": {"opening": "sugestão de abertura", "keyQuestions": ["pergunta 1"], "objectionsToAnticipate": ["objeção 1"], "suggestedNextStep": "próximo passo"},
  "alerts": [{"type": "warning" | "opportunity" | "risk", "message": "alerta acionável em português"}],
  "confidence": 0.0
}

REGRAS:
- O array "dimensions" deve ter EXATAMENTE uma entrada para CADA chave listada acima, nunca invente chaves novas.
- Extraia informações concretas das conversas, não invente.
- Se algo não foi mencionado, use status "desconhecido" e notes "Nenhuma informação disponível".
- confidence reflete a quantidade e qualidade de informações disponíveis (0 a 1).
- SEMPRE responda em português brasileiro, nunca em inglês.`;
}

export function formatContextForPrompt(context: DealQualificationContext): string {
  const lines: string[] = [];

  lines.push("## Informações do Deal");
  lines.push(`Título: ${context.deal.title}`);
  if (context.deal.value) lines.push(`Valor: R$ ${context.deal.value.toLocaleString("pt-BR")}`);
  lines.push(`Estágio: ${context.stage.name}`);
  lines.push(`Criado em: ${new Date(context.deal.createdAt).toLocaleDateString("pt-BR")}`);
  lines.push("");

  lines.push("## Contato");
  if (context.contact) {
    if (context.contact.name) lines.push(`Nome: ${context.contact.name}`);
    if (context.contact.email) lines.push(`Email: ${context.contact.email}`);
    if (context.contact.phone) lines.push(`Telefone: ${context.contact.phone}`);
  } else {
    lines.push("Nenhum contato vinculado");
  }
  lines.push("");

  if (context.stage.goal) {
    lines.push("## Objetivo do Estágio");
    lines.push(context.stage.goal);
    lines.push("");
  }
  if (context.stage.advancementCriteria.length > 0) {
    lines.push("## Critérios para Avançar");
    context.stage.advancementCriteria.forEach((c) => lines.push(`- ${c}`));
    lines.push("");
  }

  lines.push("## Histórico de Conversas");
  if (context.messages.length === 0) {
    lines.push("Nenhuma mensagem registrada");
  } else {
    context.messages.forEach((m) => {
      const time = new Date(m.created_at).toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      lines.push(
        `[${time}] ${roleLabel(m.sender)}: ${m.content?.trim() || "[mensagem sem texto]"}`,
      );
    });
  }

  return lines.join("\n");
}

function roleLabel(sender: string): string {
  if (sender === "contact") return "LEAD";
  if (sender === "ai") return "IA";
  return "ATENDENTE";
}
