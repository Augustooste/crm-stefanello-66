// Catálogo de ações do copiloto interno.
//
// O gateway Lovable devolve só texto (`callLovableGateway` lê
// `choices[0].message.content` e descarta o resto), então tool-calling nativo
// não chega até aqui. O caminho de saída estruturada comprovado neste stack é
// `response_format: {type:"json_object"}` — já em produção no `pipeline.ts`.
// Daí o desenho: o modelo PLANEJA (devolve JSON com a ação e os parâmetros) e
// o servidor EXECUTA.
//
// Consequência de segurança que governa este arquivo inteiro: o JSON vem do
// modelo, e o modelo repete o que o usuário escreveu. **É entrada hostil.**
// Nome da ação vai contra whitelist, cada parâmetro é checado por tipo (nunca
// `typeof x === "string"` sozinho num campo que aceita número — type confusion
// já burlou guard assim antes), e toda consulta filtra `tenant_id`. A function
// roda com `service_role`: RLS não protege nada aqui, o filtro é o código.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import {
  type AtividadeFonte,
  calcularMetricas,
  type DealFonte,
  DIAS_SEM_ATIVIDADE_RECENTE,
  filtrarPorTermo,
  type LinhaNegocio,
  montarLinha,
  prioridadeDeAtencao,
  type RetornoFonte,
} from "./pipeline-snapshot.ts";

export interface CopilotAtor {
  tenantId: string;
  userId: string;
  /** "admin" | "agent" | outro. Não-admin só escreve no que é dele. */
  role: string | null;
}

export interface AcaoPlanejada {
  acao: string;
  parametros: Record<string, unknown>;
}

export interface ResultadoAcao {
  ok: boolean;
  /** Texto curto para o 2º turno redigir a resposta. Nunca é mostrado cru. */
  resumo: string;
  dados?: unknown;
}

const LIMITE_PADRAO = 10;
const LIMITE_MAXIMO = 50;
/** Teto de sanidade: valor de negócio acima disso é erro de digitação do modelo,
 * não venda. Integridade de dado, não segurança. */
const VALOR_MAXIMO = 1_000_000_000;

/**
 * Falha vinda do banco, distinta de falha de validação.
 *
 * Importa porque as duas seguem caminhos diferentes: a mensagem de validação é
 * escrita por nós e pode ser mostrada ao operador; `error.message` do PostgREST
 * carrega nome de coluna e texto de constraint, e não tem por que chegar na
 * tela. O detalhe cru fica em `detalhe`, para a telemetria.
 */
export class FalhaDeBanco extends Error {
  detalhe: string;
  constructor(contexto: string, detalhe: string) {
    super(`${contexto}. Tente novamente.`);
    this.name = "FalhaDeBanco";
    this.detalhe = detalhe;
  }
}

/** Catálogo em texto, injetado no prompt do planejador. Fonte única. */
export const CATALOGO_ACOES = `
LEITURA (todos os papéis):
- analisar_pipeline {} — visão da gestão: todos os negócios em aberto com empresa, contato,
  cargo, valor, estágio, última atividade, próximo passo e sinais de atenção, mais métricas
  calculadas (total, maior oportunidade, sem próximo passo, sem atividade recente, por estágio).
  Use para: atenção/prioridade, risco, pipeline desatualizado, sem próximo passo, maior
  oportunidade, totais, resumo do pipeline, onde agir.
- negocios_por_valor {limite?:int} — negócios em aberto, do maior valor para o menor
- buscar_negocios {termo:string, limite?:int} — busca por nome do negócio, da EMPRESA ou do
  contato; traz os fatos do negócio e o resultado da reunião registrada. Use para perguntas
  sobre um negócio ou empresa específica (ex.: "Atlas Industrial"), inclusive ERP,
  faturamento ou probabilidade dela.
- contatos_recentes {limite?:int} — contatos cadastrados mais recentemente
- atividades_pendentes {ate_dias?:int} — atividades não concluídas até N dias à frente

ESCRITA:
- criar_atividade {titulo:string, tipo:string, due_at:string, deal_id?:string}
- concluir_atividade {atividade_id:string}
- mover_negocio {deal_id:string, estagio:string}
- atualizar_valor {deal_id:string, valor:number}

SEM AÇÃO:
- responder {} — quando a pergunta não precisa de dado do CRM
`.trim();

const ACOES_ESCRITA = new Set([
  "criar_atividade",
  "concluir_atividade",
  "mover_negocio",
  "atualizar_valor",
]);

const ACOES_VALIDAS = new Set([
  "analisar_pipeline",
  "negocios_por_valor",
  "buscar_negocios",
  "contatos_recentes",
  "atividades_pendentes",
  ...ACOES_ESCRITA,
  "responder",
]);

// -------- validação de parâmetros (entrada hostil) --------

function texto(v: unknown, campo: string, maxLen = 200): string {
  if (typeof v !== "string") throw new Error(`Parâmetro "${campo}" precisa ser texto.`);
  const limpo = v.trim();
  if (!limpo) throw new Error(`Parâmetro "${campo}" veio vazio.`);
  return limpo.slice(0, maxLen);
}

function uuid(v: unknown, campo: string): string {
  const s = texto(v, campo, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
    throw new Error(`Parâmetro "${campo}" não é um identificador válido.`);
  }
  return s;
}

function numero(v: unknown, campo: string): number {
  // `typeof v === "number"` sozinho aceita NaN e Infinity; ambos viram
  // `null`/erro no PostgREST longe daqui.
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`Parâmetro "${campo}" precisa ser um número.`);
  }
  return v;
}

function limite(v: unknown): number {
  if (v === undefined || v === null) return LIMITE_PADRAO;
  const n = numero(v, "limite");
  return Math.min(Math.max(Math.trunc(n), 1), LIMITE_MAXIMO);
}

function dataIso(v: unknown, campo: string): string {
  const s = texto(v, campo, 40);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`Parâmetro "${campo}" não é uma data válida.`);
  return d.toISOString();
}

/**
 * Neutraliza os curingas do `ilike`. Sem isto, um termo com `%` vira varredura
 * da tabela inteira — e o termo vem do texto que o usuário digitou.
 */
export function escaparIlike(valor: string): string {
  return valor.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Monta o padrão de busca parcial. Existe separado do `ilike` para poder ser
 * testado: o `\` do escape não sobrevive à decodificação da querystring, então
 * asserção em cima da URL não prova que o escape foi aplicado.
 */
export function padraoBusca(termo: string): string {
  return `%${escaparIlike(termo)}%`;
}

/** Lê o JSON do planejador sem confiar em nada dele. */
export function lerPlano(bruto: unknown): AcaoPlanejada {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) {
    throw new Error("O planejador não devolveu um objeto.");
  }
  const obj = bruto as Record<string, unknown>;
  const acao = typeof obj.acao === "string" ? obj.acao.trim() : "";
  if (!ACOES_VALIDAS.has(acao)) throw new Error(`Ação desconhecida: ${acao || "(vazia)"}.`);
  const p = obj.parametros;
  const parametros = p && typeof p === "object" && !Array.isArray(p)
    ? p as Record<string, unknown>
    : {};
  return { acao, parametros };
}

// -------- guarda de posse (papel) --------

/**
 * Não-admin só escreve no que é dele. Admin escreve em qualquer negócio do
 * próprio tenant. Nos dois casos o `tenant_id` entra na consulta — posse não
 * substitui escopo de tenant.
 */
async function exigirNegocioPermitido(
  admin: SupabaseClient,
  ator: CopilotAtor,
  dealId: string,
): Promise<{ id: string; title: string; board_id: string }> {
  const { data, error } = await admin
    .from("deals")
    .select("id, title, board_id, owner_id")
    .eq("tenant_id", ator.tenantId)
    .eq("id", dealId)
    .maybeSingle();
  if (error) throw new FalhaDeBanco("Falha ao carregar o negócio", error.message);
  if (!data) throw new Error("Negócio não encontrado neste workspace.");
  if (ator.role !== "admin" && data.owner_id !== ator.userId) {
    throw new Error("Você só pode alterar negócios em que é o responsável.");
  }
  return data as { id: string; title: string; board_id: string };
}

// -------- visão do pipeline (leitura rica, sem id interno) --------

/**
 * Carrega negócios + estágio + contato + empresa + atividades + retornos e
 * devolve linhas de pipeline-snapshot.ts. Tudo filtrado por `tenant_id`.
 * ponytail: carrega até LIMITE_MAXIMO negócios e filtra/soma em memória — basta
 * para o pipeline de um time; paginar/agregar em SQL se passar disso.
 */
async function carregarLinhas(
  admin: SupabaseClient,
  ator: CopilotAtor,
  opts: { soAbertos: boolean; porValor: boolean; limite: number },
): Promise<LinhaNegocio[]> {
  let q = admin
    .from("deals")
    .select(
      "id, title, value, status, created_at, stage:board_stages(name), contact:contacts(name, job_title, company_id)",
    )
    .eq("tenant_id", ator.tenantId);
  if (opts.soAbertos) q = q.eq("status", "open");
  if (opts.porValor) q = q.order("value", { ascending: false, nullsFirst: false });
  const { data, error } = await q.limit(opts.limite);
  if (error) throw new FalhaDeBanco("Falha ao listar negócios", error.message);
  const deals = (data ?? []) as unknown as DealFonte[];
  if (deals.length === 0) return [];
  const ids = deals.map((d) => d.id);
  const empresaIds = [
    ...new Set(deals.map((d) => d.contact?.company_id).filter((x): x is string => !!x)),
  ];

  const [ativ, ret, emp] = await Promise.all([
    admin
      .from("activities")
      .select("deal_id, type, title, due_at, completed_at, created_at, metadata")
      .eq("tenant_id", ator.tenantId)
      .in("deal_id", ids),
    admin
      .from("deal_followups")
      .select("deal_id, scheduled_at, status, description")
      .eq("tenant_id", ator.tenantId)
      .in("deal_id", ids),
    empresaIds.length > 0
      ? admin
        .from("crm_companies")
        .select("id, name")
        .eq("tenant_id", ator.tenantId)
        .in("id", empresaIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  for (const r of [ativ, ret, emp]) {
    if (r.error) throw new FalhaDeBanco("Falha ao montar a visão do pipeline", r.error.message);
  }
  const empresas = new Map(
    ((emp.data ?? []) as Array<{ id: string; name: string }>).map((e) => [e.id, e.name]),
  );
  const atividades = (ativ.data ?? []) as AtividadeFonte[];
  const retornos = (ret.data ?? []) as RetornoFonte[];
  const agora = new Date();
  return deals.map((d) =>
    montarLinha(
      d,
      d.contact?.company_id ? empresas.get(d.contact.company_id) ?? null : null,
      atividades.filter((a) => a.deal_id === d.id),
      retornos.filter((r) => r.deal_id === d.id),
      agora,
    )
  );
}

// -------- execução --------

export function ehEscrita(acao: string): boolean {
  return ACOES_ESCRITA.has(acao);
}

export async function executarAcao(
  admin: SupabaseClient,
  ator: CopilotAtor,
  plano: AcaoPlanejada,
): Promise<ResultadoAcao> {
  const p = plano.parametros;

  switch (plano.acao) {
    case "responder":
      return { ok: true, resumo: "Nenhuma consulta ao CRM foi necessária." };

    case "analisar_pipeline": {
      const linhas = await carregarLinhas(admin, ator, {
        soAbertos: true,
        porValor: true,
        limite: LIMITE_MAXIMO,
      });
      const atencao = prioridadeDeAtencao(linhas);
      return {
        ok: true,
        resumo: `${linhas.length} negócio(s) em aberto. Sinais calculados pelo sistema; ` +
          `"sem atividade recente" = ${DIAS_SEM_ATIVIDADE_RECENTE}+ dias sem atividade. ` +
          `Ordem de atenção: mais sinais primeiro, depois maior valor.`,
        dados: {
          metricas: calcularMetricas(linhas),
          precisam_de_atencao: atencao,
          sem_sinal_de_atencao: linhas.filter((l) => l.sinais.length === 0),
        },
      };
    }

    case "negocios_por_valor": {
      const linhas = await carregarLinhas(admin, ator, {
        soAbertos: true,
        porValor: true,
        limite: limite(p.limite),
      });
      return {
        ok: true,
        resumo: `${linhas.length} negócio(s) em aberto, do maior valor para o menor.`,
        dados: linhas,
      };
    }

    case "buscar_negocios": {
      const termo = texto(p.termo, "termo");
      const n = limite(p.limite);
      const linhas = filtrarPorTermo(
        await carregarLinhas(admin, ator, { soAbertos: false, porValor: false, limite: LIMITE_MAXIMO }),
        termo,
      ).slice(0, n);
      return {
        ok: true,
        resumo: `${linhas.length} negócio(s) encontrados para "${termo}" (nome do negócio, empresa ou contato).`,
        dados: linhas,
      };
    }

    case "contatos_recentes": {
      const n = limite(p.limite);
      const { data, error } = await admin
        .from("contacts")
        .select("id, name, phone, email, created_at")
        .eq("tenant_id", ator.tenantId)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(n);
      if (error) throw new FalhaDeBanco("Falha ao listar contatos", error.message);
      return { ok: true, resumo: `${data?.length ?? 0} contato(s).`, dados: data ?? [] };
    }

    case "atividades_pendentes": {
      const dias = p.ate_dias === undefined ? 7 : Math.min(Math.max(numero(p.ate_dias, "ate_dias"), 0), 90);
      const ate = new Date(Date.now() + dias * 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await admin
        .from("activities")
        .select("title, type, due_at, deal:deals(title)")
        .eq("tenant_id", ator.tenantId)
        .is("completed_at", null)
        .lte("due_at", ate)
        .order("due_at", { ascending: true })
        .limit(LIMITE_MAXIMO);
      if (error) throw new FalhaDeBanco("Falha ao listar atividades", error.message);
      return {
        ok: true,
        resumo: `${data?.length ?? 0} atividade(s) pendente(s) nos próximos ${dias} dia(s).`,
        dados: data ?? [],
      };
    }

    case "criar_atividade": {
      const titulo = texto(p.titulo, "titulo");
      const tipo = texto(p.tipo, "tipo", 40);
      const dueAt = dataIso(p.due_at, "due_at");
      const dealId = p.deal_id === undefined || p.deal_id === null
        ? null
        : (await exigirNegocioPermitido(admin, ator, uuid(p.deal_id, "deal_id"))).id;
      const { data, error } = await admin
        .from("activities")
        .insert({
          tenant_id: ator.tenantId,
          title: titulo,
          type: tipo,
          due_at: dueAt,
          deal_id: dealId,
          owner_id: ator.userId,
        })
        .select("id, title, due_at")
        .single();
      if (error) throw new FalhaDeBanco("Falha ao criar a atividade", error.message);
      return { ok: true, resumo: `Atividade "${titulo}" criada.`, dados: data };
    }

    case "concluir_atividade": {
      const id = uuid(p.atividade_id, "atividade_id");
      const query = admin
        .from("activities")
        .update({ completed_at: new Date().toISOString() })
        .eq("tenant_id", ator.tenantId)
        .eq("id", id)
        .is("completed_at", null);
      // Não-admin só conclui a própria atividade.
      const escopada = ator.role === "admin" ? query : query.eq("owner_id", ator.userId);
      const { data, error } = await escopada.select("id, title");
      if (error) throw new FalhaDeBanco("Falha ao concluir a atividade", error.message);
      if (!data || data.length === 0) {
        return { ok: false, resumo: "Nenhuma atividade pendente sua com esse identificador." };
      }
      return { ok: true, resumo: `Atividade "${data[0].title}" concluída.`, dados: data[0] };
    }

    case "mover_negocio": {
      const dealId = uuid(p.deal_id, "deal_id");
      const nomeEstagio = texto(p.estagio, "estagio", 80);
      const negocio = await exigirNegocioPermitido(admin, ator, dealId);
      // Sem `tenant_id` aqui de propósito: `board_stages` não tem a coluna. O
      // escopo vem do `board_id`, que saiu de um `deals` já filtrado por tenant,
      // e `boards.tenant_id` é `not null` — um board pertence a um tenant só.
      const { data: estagio, error: errEstagio } = await admin
        .from("board_stages")
        .select("id, name")
        .eq("board_id", negocio.board_id)
        .ilike("name", escaparIlike(nomeEstagio))
        .maybeSingle();
      if (errEstagio) throw new FalhaDeBanco("Falha ao resolver o estágio", errEstagio.message);
      if (!estagio) throw new Error(`Não existe o estágio "${nomeEstagio}" neste quadro.`);
      // A posse é repetida no WHERE do próprio UPDATE, não só no SELECT acima:
      // entre um e outro o `owner_id` pode mudar, e aí a checagem já não vale.
      // Mesmo padrão de `concluir_atividade`.
      const mover = admin
        .from("deals")
        .update({ stage_id: estagio.id, stage_entered_at: new Date().toISOString() })
        .eq("tenant_id", ator.tenantId)
        .eq("id", dealId);
      const { error } = await (ator.role === "admin" ? mover : mover.eq("owner_id", ator.userId));
      if (error) throw new FalhaDeBanco("Falha ao mover o negócio", error.message);
      return {
        ok: true,
        resumo: `Negócio "${negocio.title}" movido para "${estagio.name}".`,
        dados: { deal_id: dealId, estagio: estagio.name },
      };
    }

    case "atualizar_valor": {
      const dealId = uuid(p.deal_id, "deal_id");
      const valor = numero(p.valor, "valor");
      if (valor < 0) throw new Error("O valor não pode ser negativo.");
      if (valor > VALOR_MAXIMO) throw new Error("O valor informado está fora da faixa aceita.");
      const negocio = await exigirNegocioPermitido(admin, ator, dealId);
      // Posse repetida no UPDATE — ver comentário em `mover_negocio`.
      const atualizar = admin
        .from("deals")
        .update({ value: valor })
        .eq("tenant_id", ator.tenantId)
        .eq("id", dealId);
      const { error } = await (ator.role === "admin"
        ? atualizar
        : atualizar.eq("owner_id", ator.userId));
      if (error) throw new FalhaDeBanco("Falha ao atualizar o valor", error.message);
      return {
        ok: true,
        resumo: `Valor do negócio "${negocio.title}" atualizado para ${valor}.`,
        dados: { deal_id: dealId, valor },
      };
    }

    default:
      // `lerPlano` já barra ação fora da whitelist; este ramo só existe para o
      // caso de alguém acrescentar nome ao Set e esquecer do switch.
      throw new Error(`Ação sem implementação: ${plano.acao}.`);
  }
}
