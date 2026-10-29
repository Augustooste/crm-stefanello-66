// gateway.ts — chamada HTTP compartilhada ao gateway Lovable (chat
// completions), usada por todo caller de LLM deste projeto.
//
// Extraído nesta fase (fix de simplificação/review): a mesma requisição
// fetch (URL, headers, body shape) estava duplicada quase idêntica em
// ai-respond/index.ts (callLovableAI), pipeline.ts (avaliação de avanço de
// estágio), qualification.ts (callQualificationLLM), memory-summary.ts
// (callSummaryLLM) e memory-consolidator.ts (callConsolidatorLLM).
//
// Este módulo centraliza SÓ o fetch em si (montar o body, ler a chave,
// extrair o texto da resposta em sucesso). O tratamento de erro
// específico de cada caller (mensagem amigável por statusCode, se lança ou
// silencia, se anexa provider/statusCode ao erro) continua em cada um
// deles — eles capturam LovableGatewayHttpError e decidem o que fazer,
// exatamente como decidiam antes com `r.status` direto.
//
// Também exporta os dois helpers de parsing defensivo que estavam
// duplicados 3x (stripJsonFence) e 3x-4x (toStringArray) entre
// qualification/parsing.ts, qualification/context.ts, memory-summary.ts e
// memory-consolidator.ts.

import { extractProviderErrorMeta } from "./errors.ts";
import { AI_GATEWAY_TIMEOUT_MS } from "./execution-budget.ts";

const LOVABLE_GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const LOVABLE_EMBEDDINGS_URL = "https://ai.gateway.lovable.dev/v1/embeddings";

export interface AIGatewayConfig {
  url: string;
  apiKey: string | undefined;
  model: string | undefined;
  missingKeyMessage: string;
  reasoningEffort: "none" | undefined;
}

/** Override de chat para provas locais; embeddings continuam no gateway Lovable. */
export function getAIGatewayConfig(): AIGatewayConfig {
  const overrideUrl = Deno.env.get("AI_GATEWAY_URL");
  return {
    url: overrideUrl || LOVABLE_GATEWAY_URL,
    apiKey: overrideUrl
      ? Deno.env.get("AI_GATEWAY_API_KEY")
      : Deno.env.get("LOVABLE_API_KEY"),
    model: Deno.env.get("AI_GATEWAY_MODEL"),
    missingKeyMessage: overrideUrl ? "AI_GATEWAY_API_KEY ausente." : "LOVABLE_API_KEY ausente.",
    reasoningEffort: overrideUrl ? "none" : undefined,
  };
}

// Teto de tempo da chamada ao gateway. Sem isso o fetch pode pendurar ate a
// plataforma matar o isolate, e o claim em ai_processing_log ja gravado impede
// qualquer reprocessamento daquela mensagem. Mesmo padrao de evolution-client.ts.
//
// Este teto faz parte do orçamento compartilhado em execution-budget.ts.
export const KNOWLEDGE_EMBEDDING_DIMENSIONS = 768;
const KNOWLEDGE_EMBEDDING_MODEL = "openai/text-embedding-3-small";

export interface GatewayMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CallLovableGatewayOpts {
  /** Teto de tokens de saída — cada caller tem o seu (varia de 700 a 1200
   * nos callers atuais), por isso é obrigatório na prática mesmo sendo
   * opcional no tipo (sem default aqui para nunca alterar silenciosamente o
   * comportamento de um caller que esqueceu de passar). */
  maxOutputTokens?: number;
  temperature?: number;
  /** Só a avaliação de avanço de estágio (pipeline.ts) usa
   * response_format: {type:"json_object"} hoje — os demais omitem o campo
   * inteiramente, então ele só entra no body quando explicitamente passado. */
  responseFormat?: { type: string };
  /** Teto por chamada. Só quem faz mais de uma chamada por requisição precisa
   * (o copiloto planeja e depois redige): sem isso, as duas herdariam
   * `AI_GATEWAY_TIMEOUT_MS` e a primeira poderia consumir o orçamento inteiro
   * de quem está esperando na tela. Omitido = comportamento de antes. */
  timeoutMs?: number;
}

/**
 * Erro específico de resposta HTTP não-ok do gateway (`r.ok === false`) —
 * distinto de uma falha de rede (fetch rejeitando) ou de um corpo malformado
 * (JSON.parse falhando ao ler a resposta), que propagam como o erro nativo
 * que os gerou. Callers que precisavam tratar HTTP-não-ok de forma diferente
 * dos outros dois casos (ex.: a avaliação de avanço em pipeline.ts, que
 * silencia só este caso) usam `instanceof LovableGatewayHttpError` pra
 * distinguir.
 */
export class LovableGatewayHttpError extends Error {
  statusCode: number;
  retryAfterSeconds?: number;

  constructor(statusCode: number, retryAfterSeconds?: number) {
    super(`Gateway Lovable respondeu HTTP ${statusCode}.`);
    this.name = "LovableGatewayHttpError";
    this.statusCode = statusCode;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Chama o gateway Lovable (chat completions) e devolve o texto bruto da
 * resposta (`choices[0].message.content ?? ""`, sem trim) — cada caller
 * decide se precisa trim/validação de vazio, igual antes.
 *
 * Lança LovableGatewayHttpError quando a resposta HTTP não é ok (statusCode +
 * retryAfterSeconds, quando o header Retry-After vier presente). Uma falha
 * de rede (fetch rejeitando) ou LOVABLE_API_KEY ausente lançam o erro nativo
 * sem encapsular.
 */
export async function callLovableGateway(
  systemPrompt: string,
  history: GatewayMessage[],
  model: string,
  opts: CallLovableGatewayOpts = {},
): Promise<string> {
  const gateway = getAIGatewayConfig();
  if (!gateway.apiKey) throw new Error(gateway.missingKeyMessage);

  const body: Record<string, unknown> = {
    model: gateway.model || model,
    messages: [{ role: "system", content: systemPrompt }, ...history],
    max_tokens: opts.maxOutputTokens,
    reasoning_effort: gateway.reasoningEffort,
  };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.responseFormat) body.response_format = opts.responseFormat;

  const r = await fetch(gateway.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${gateway.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? AI_GATEWAY_TIMEOUT_MS),
  });
  if (!r.ok) {
    const meta = extractProviderErrorMeta(r);
    throw new LovableGatewayHttpError(r.status, meta.retryAfterSeconds);
  }
  const data = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}

export type KnowledgeEmbeddingTaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

/**
 * Gera embeddings em lote pelo gateway Lovable (endpoint OpenAI-compatível
 * /v1/embeddings). Usa openai/text-embedding-3-small com `dimensions: 768`
 * porque a coluna pgvector de kb_chunks é vector(768).
 *
 * O LlamaParse extrai o texto do arquivo; esta etapa apenas vetoriza o texto
 * extraído. Não exige chave própria: reaproveita LOVABLE_API_KEY. Erros do
 * gateway viram mensagens legíveis (créditos, limite, indisponibilidade) para
 * chegarem à UI em kb_documents.error_message.
 */
export async function callKnowledgeEmbeddings(
  input: string[],
  opts: {
    timeoutMs?: number;
    taskType?: KnowledgeEmbeddingTaskType;
  } = {},
): Promise<number[][]> {

  if (input.length < 1 || input.length > 32) {
    throw new Error("Embeddings exigem entre 1 e 32 textos.");
  }
  const apiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!apiKey) throw new Error("LOVABLE_API_KEY ausente.");

  const response = await fetch(LOVABLE_EMBEDDINGS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: KNOWLEDGE_EMBEDDING_MODEL,
      input,
      dimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS,
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? AI_GATEWAY_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(embeddingsErrorMessage(response.status));
  }

  const payload = (await response.json()) as {
    data?: Array<{ index?: number; embedding?: unknown }>;
  };
  const rows = payload.data ?? [];
  if (rows.length !== input.length) {
    throw new Error("Gateway devolveu quantidade inválida de embeddings.");
  }

  const ordered: number[][] = new Array(input.length);
  rows.forEach((row, position) => {
    const index = typeof row.index === "number" ? row.index : position;
    const values = row.embedding;
    if (
      !Array.isArray(values) ||
      values.length !== KNOWLEDGE_EMBEDDING_DIMENSIONS ||
      values.some((value) => typeof value !== "number" || !Number.isFinite(value))
    ) {
      throw new Error(
        `Gateway devolveu embedding inválido; esperado ${KNOWLEDGE_EMBEDDING_DIMENSIONS} dimensões.`,
      );
    }
    if (index < 0 || index >= input.length) {
      throw new Error("Gateway devolveu índice de embedding fora do intervalo.");
    }
    ordered[index] = values as number[];
  });
  if (ordered.some((row) => !row)) {
    throw new Error("Gateway devolveu quantidade inválida de embeddings.");
  }
  return ordered;
}

/** Mensagens legíveis (PT-BR) para os erros do gateway de embeddings. */
function embeddingsErrorMessage(status: number): string {
  if (status === 402) {
    return "Créditos de IA esgotados no workspace. Adicione créditos para indexar a base de conhecimento.";
  }
  if (status === 429) {
    return "Limite de requisições de IA atingido. Tente novamente em alguns minutos.";
  }
  if (status === 403 || status === 404) {
    return "Serviço de embeddings indisponível para este workspace.";
  }
  if (status >= 500) {
    return `Serviço de embeddings temporariamente indisponível (HTTP ${status}). Tente novamente.`;
  }
  return `Gateway de embeddings respondeu HTTP ${status}.`;
}


/** Remove cercas ```json``` / ``` do início e fim (a IA às vezes embrulha a
 * resposta em markdown mesmo pedindo JSON puro). Duplicado antes em
 * qualification/parsing.ts e memory-summary.ts / memory-consolidator.ts. */
export function stripJsonFence(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
}

/** Helper de parsing defensivo: filtra e trima só os elementos string
 * não-vazios de um valor desconhecido. Duplicado antes em
 * qualification/context.ts, qualification/parsing.ts, memory-summary.ts e
 * memory-consolidator.ts. */
export function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim());
}
