// Copiloto interno do AceleraFlow — o assistente do painel lateral.
//
// Por que uma function nova em vez de reusar `ai-playground`: o playground
// existe para SIMULAR o agente de atendimento ao lead (mesmo pipeline do
// `ai-respond`), então o system prompt dele é a persona de qualificação. Quando
// o operador perguntava "quais os negócios de maior valor?", o modelo obedecia o
// prompt que tinha e respondia em personagem, perguntando como o lead conheceu a
// empresa. Não era alucinação: era o prompt errado.
//
// Desenho, dois turnos por mensagem:
//   1. PLANEJADOR — recebe o catálogo de ações e devolve `{acao, parametros}`
//      em JSON (`response_format: json_object`, o mesmo caminho que o
//      `pipeline.ts` já usa em produção).
//   2. Servidor executa a ação com escopo de tenant + papel.
//   3. REDATOR — recebe o resultado e escreve a resposta em PT-BR.
//
// Tool-calling nativo não é opção aqui: `callLovableGateway` devolve só
// `choices[0].message.content`.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { captureEdgeError } from "../_shared/telemetry.ts";
import { loadProfileOrFail, PROFILE_DB_ERROR_MESSAGE } from "../_shared/load-profile.ts";
import { checkRateLimit } from "../_shared/ai/rate-limiter.ts";
import {
  callLovableGateway,
  type GatewayMessage,
  LovableGatewayHttpError,
  stripJsonFence,
} from "../_shared/ai/gateway.ts";
import {
  CATALOGO_ACOES,
  type CopilotAtor,
  ehEscrita,
  executarAcao,
  FalhaDeBanco,
  lerPlano,
} from "../_shared/ai/copilot-actions.ts";
import { removerIdsInternos, termoInventado } from "../_shared/ai/pipeline-snapshot.ts";

export const RESPOSTA_NAO_REGISTRADA =
  "Essa informação não está registrada no CRM. Posso mostrar o que está registrado sobre a oportunidade: empresa, contato, valor, estágio, atividades e próximo passo.";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const AI_MODEL = "google/gemini-3-flash-preview";
// São DUAS chamadas por mensagem: o teto de cada uma tem que caber no orçamento
// total do usuário esperando na tela, não herdar os 45s de quem só chama uma vez.
const TIMEOUT_PLANEJADOR_MS = 20_000;
const TIMEOUT_REDATOR_MS = 20_000;
const MAX_TOKENS_PLANEJADOR = 400;
const MAX_TOKENS_REDATOR = 1200;
const MAX_MENSAGENS_HISTORICO = 12;
// Cada mensagem do painel gasta DUAS chamadas ao gateway (planejador +
// redator), então o teto aqui vale o dobro do que parece. 6/min é folgado para
// uso humano e barra o loop de retry da UI, que é o jeito realista de esvaziar
// o crédito do workspace sem má-fé nenhuma.
const RATE_LIMIT_MAX_CALLS = 6;
const RATE_LIMIT_WINDOW_MS = 60_000;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

function promptPlanejador(role: string | null): string {
  const escrita = role === "admin"
    ? "Você pode executar ações de escrita em qualquer negócio do workspace."
    : "Você só pode executar ações de escrita em negócios e atividades onde o usuário é o responsável.";
  return [
    "Você decide qual consulta ao CRM responde a mensagem do operador.",
    "Responda SOMENTE com JSON no formato {\"acao\": \"...\", \"parametros\": {...}}.",
    "Sem texto fora do JSON, sem explicação, sem markdown.",
    escrita,
    "Se a mensagem não exigir dado do CRM, use a ação \"responder\".",
    "",
    "Ações disponíveis:",
    CATALOGO_ACOES,
  ].join("\n");
}

function promptRedator(role: string | null): string {
  return [
    "Você é o copiloto do AceleraFlow, falando com um operador de vendas DENTRO do CRM.",
    "Você NÃO fala com o cliente final: nunca se apresente, nunca pergunte como a pessoa",
    "conheceu a empresa, nunca qualifique lead.",
    "",
    "REGRAS:",
    "1. Sua fonte de verdade é SOMENTE o JSON de dados abaixo. Nunca invente empresa, contato,",
    "   cargo, estágio, valor, atividade, data, próximo passo, tecnologia, ERP, orçamento,",
    "   faturamento, concorrente, motivo de perda ou probabilidade de fechamento.",
    "2. Se a informação pedida não estiver nos dados, diga: \"Essa informação não está registrada",
    "   no CRM.\" Não diga \"provavelmente\" nem sugira valores. O CRM não tem campo de",
    "   probabilidade de fechamento: nunca dê percentual nem \"alta/baixa chance\".",
    "3. Copie nomes, cargos, valores, estágios e datas exatamente como estão nos dados.",
    "   O estágio é o campo \"estagio\"; \"situacao\" (em aberto/ganho/perdido) não é estágio.",
    "4. Não faça contas: totais, maior oportunidade, dias e sinais já vêm calculados em",
    "   \"metricas\", \"dias_sem_atividade\", \"sinais\" e \"evidencias\".",
    "5. Ao apontar atenção ou risco, escreva um bloco por negócio, cada item em SUA PRÓPRIA",
    "   LINHA (quebra de linha, nunca \" / \"), com linha em branco entre negócios:",
    "   **Empresa — Negócio** · valor · estágio",
    "   Motivo: (copie de \"motivos\", nunca o código de \"sinais\")",
    "   Evidência: (copie de \"evidencias\")",
    "   Ação sugerida: uma ação curta que resolve exatamente o sinal",
    "   (ex.: sem próximo passo → definir e registrar o próximo passo).",
    "   Formatação: só **negrito** e listas com \"- \"; sem títulos (#), tabelas ou links.",
    "   Não chame de \"arriscado\"/\"maior risco\" nem preveja perda: descreva o sinal.",
    "   A ordem de \"precisam_de_atencao\" já é a prioridade; não reordene.",
    "6. Nunca mostre identificadores internos (UUID, id).",
    "7. Seja curto e direto. Valores no formato R$ 1.234 e datas em dd/mm/aaaa.",
    "8. Quando uma ação de escrita foi executada, confirme exatamente o que mudou.",
    role === "admin" ? "" : "9. O usuário é atendente: não prometa ações fora do que é dele.",
  ].filter(Boolean).join("\n");
}

interface Body {
  messages?: Array<{ role?: unknown; content?: unknown }>;
}

/** Normaliza o histórico do painel: descarta o que não for turno de conversa. */
function lerHistorico(body: Body): GatewayMessage[] {
  const bruto = Array.isArray(body.messages) ? body.messages : [];
  const limpo: GatewayMessage[] = [];
  for (const m of bruto) {
    const role = m?.role === "assistant" ? "assistant" : m?.role === "user" ? "user" : null;
    const content = typeof m?.content === "string" ? m.content.trim() : "";
    if (!role || !content) continue;
    limpo.push({ role, content: content.slice(0, 4000) });
  }
  return limpo.slice(-MAX_MENSAGENS_HISTORICO);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
  const authHeader = req.headers.get("Authorization") ?? "";

  const userClient = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  });
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json(401, { error: "Não autenticado." });

  // Sem `requireAdmin`: o copiloto vale para atendente também — o que muda é o
  // escopo das ações de escrita, resolvido em `copilot-actions.ts`.
  const prof = await loadProfileOrFail(admin, userData.user.id, {
    operation: "ai.copilot.load_profile",
  });
  if (!prof.ok) {
    if (prof.reason === "db_error") return json(503, { error: PROFILE_DB_ERROR_MESSAGE });
    return json(403, { error: "Perfil não encontrado." });
  }

  const ator: CopilotAtor = {
    tenantId: prof.tenantId,
    userId: userData.user.id,
    role: prof.role,
  };

  let body: Body;
  try {
    body = await req.json() as Body;
  } catch {
    return json(400, { error: "Corpo inválido." });
  }
  const historico = lerHistorico(body);
  if (historico.length === 0) return json(400, { error: "Nenhuma mensagem para responder." });

  // Teto por USUÁRIO, não por tenant: um atendente em loop não pode derrubar o
  // copiloto do time inteiro, e o custo que interessa conter é o de quem está
  // segurando Enter. Fail-closed — negar custa um retry, permitir custa crédito
  // justamente quando a infra já está ruim.
  const limite = await checkRateLimit(
    admin,
    `ai-copilot:${ator.userId}`,
    RATE_LIMIT_MAX_CALLS,
    RATE_LIMIT_WINDOW_MS,
  );
  if (!limite.allowed) {
    if (limite.rpcFailed) {
      await captureEdgeError(admin, {
        severity: "error",
        source: "edge",
        operation: "ai.copilot.rate_limit",
        tenantId: ator.tenantId,
        message: "RPC check_and_record_rate_limit falhou; negado por fail-closed.",
        context: { user_id: ator.userId },
      });
      return json(500, { error: "Erro ao verificar limite de uso. Tente de novo em instantes." });
    }
    const retryAfterSeconds = Math.ceil((limite.retryAfterMs ?? RATE_LIMIT_WINDOW_MS) / 1000);
    return json(429, {
      error: "Muitas perguntas seguidas ao copiloto. Tente de novo em instantes.",
      retryAfterSeconds,
    });
  }

  try {
    // ---------- 1. planejar ----------
    let planoBruto: string;
    try {
      planoBruto = await callLovableGateway(promptPlanejador(ator.role), historico, AI_MODEL, {
        maxOutputTokens: MAX_TOKENS_PLANEJADOR,
        temperature: 0,
        responseFormat: { type: "json_object" },
        timeoutMs: TIMEOUT_PLANEJADOR_MS,
      });
    } catch (e) {
      if (e instanceof LovableGatewayHttpError && e.statusCode === 402) {
        return json(402, { error: "Créditos de IA esgotados no workspace." });
      }
      throw e;
    }

    let resultado;
    let acaoExecutada = "responder";
    try {
      let planoJson: unknown;
      try {
        planoJson = JSON.parse(stripJsonFence(planoBruto));
      } catch {
        // A mensagem nativa do SyntaxError ("Unexpected token … at position 0")
        // não diz nada ao operador e ainda iria parar no prompt do redator.
        throw new Error("O planejador não devolveu um plano válido.");
      }
      const plano = lerPlano(planoJson);
      acaoExecutada = plano.acao;
      resultado = await executarAcao(admin, ator, plano);
    } catch (e) {
      // Plano inválido, parâmetro fora do tipo ou ação barrada por posse: não é
      // erro de servidor. Vira insumo do redator, que explica ao operador.
      //
      // Falha de banco é outra história: `error.message` do PostgREST traz nome
      // de coluna e texto de constraint. Isso vai só para a telemetria — o
      // redator recebe a versão genérica, senão o detalhe interno reaparece
      // parafraseado na tela.
      const daBanco = e instanceof FalhaDeBanco;
      const paraOperador = e instanceof Error ? e.message : String(e);
      const paraTelemetria = daBanco ? (e as FalhaDeBanco).detalhe : paraOperador;
      resultado = { ok: false, resumo: `Não foi possível executar: ${paraOperador}` };
      await captureEdgeError(admin, {
        severity: daBanco ? "warn" : "info",
        source: "edge",
        operation: daBanco ? "ai.copilot.falha_de_dados" : "ai.copilot.plano_recusado",
        tenantId: ator.tenantId,
        message: paraTelemetria,
        context: { acao: acaoExecutada, papel: ator.role },
      });
    }

    // ---------- 2. redigir ----------
    const insumo = [
      `Ação executada: ${acaoExecutada}${ehEscrita(acaoExecutada) ? " (escrita)" : ""}`,
      `Resultado: ${resultado.resumo}`,
      resultado.dados === undefined
        ? "Dados: nenhum."
        : `Dados (JSON): ${JSON.stringify(resultado.dados).slice(0, 14000)}`,
    ].join("\n");

    const reply = await callLovableGateway(
      promptRedator(ator.role),
      [...historico, { role: "user", content: insumo }],
      AI_MODEL,
      { maxOutputTokens: MAX_TOKENS_REDATOR, temperature: 0.3, timeoutMs: TIMEOUT_REDATOR_MS },
    );
    const bruto = reply.trim();
    if (!bruto) return json(502, { error: "A IA não retornou resposta." });
    // Barreira determinística depois do modelo: termo que o CRM não registra
    // (ERP, faturamento, percentual...) só passa se estava na pergunta ou nos dados.
    const fonte = [...historico.map((m) => m.content), insumo].join("\n");
    const inventado = termoInventado(bruto, fonte);
    if (inventado) {
      await captureEdgeError(admin, {
        severity: "warn",
        source: "edge",
        operation: "ai.copilot.resposta_barrada",
        tenantId: ator.tenantId,
        message: `Resposta trocada: termo sem fonte (${inventado}).`,
        context: { acao: acaoExecutada },
      });
    }
    const texto = removerIdsInternos(inventado ? RESPOSTA_NAO_REGISTRADA : bruto);

    return json(200, { reply: texto, acao: acaoExecutada });
  } catch (e) {
    if (e instanceof LovableGatewayHttpError && e.statusCode === 429) {
      return json(429, { error: "Limite de requisições de IA atingido. Tente em alguns minutos." });
    }
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "ai.copilot.falha",
      tenantId: ator.tenantId,
      message: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? (e.stack ?? null) : null,
    });
    return json(500, { error: "Não foi possível gerar a resposta." });
  }
});
