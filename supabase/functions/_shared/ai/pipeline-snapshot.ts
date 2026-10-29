// pipeline-snapshot.ts — visão do pipeline para o copiloto, 100% determinística.
//
// O copiloto antigo mandava ao redator `deals(id, title, value, status)`: sem
// empresa, sem contato, sem cargo, sem nome de estágio. O modelo completava o
// resto — trocou "Diretora Comercial" por "Gerente Comercial", chamou o estágio
// de "Aberto" (deals.status), mostrou o UUID do negócio e não achou "Atlas
// Industrial" (a busca era só no título). Validação Demo 2/6, 23/09/2026.
//
// Aqui cada negócio vira uma linha só com fatos do banco, SEM id interno, e
// tudo que é conta (soma, maior, dias sem atividade, sinais de atenção, ordem
// de prioridade) sai deste arquivo. O modelo só redige.
//
// Sem import de Deno/supabase: testável direto por `deno test`.

export const DIAS_SEM_ATIVIDADE_RECENTE = 14;
const DIA_MS = 24 * 60 * 60 * 1000;
const TZ = "America/Sao_Paulo";

export interface DealFonte {
  id: string;
  title: string;
  value: number | string | null;
  status: string;
  created_at: string;
  stage: { name: string } | null;
  contact: { name: string; job_title: string | null; company_id: string | null } | null;
}

export interface AtividadeFonte {
  deal_id: string | null;
  type: string;
  title: string;
  due_at: string | null;
  completed_at: string | null;
  created_at: string;
  metadata?: unknown;
}

export interface RetornoFonte {
  deal_id: string | null;
  scheduled_at: string;
  status: string;
  description: string | null;
}

export type Sinal =
  | "SEM_PROXIMO_PASSO"
  | "PROXIMO_PASSO_VENCIDO"
  | "SEM_ATIVIDADE"
  | "SEM_ATIVIDADE_RECENTE";

/** Rótulo mostrado ao usuário — o código do sinal nunca vai para a tela. */
export const ROTULO_SINAL: Record<Sinal, string> = {
  SEM_PROXIMO_PASSO: "Sem próximo passo",
  PROXIMO_PASSO_VENCIDO: "Próximo passo vencido",
  SEM_ATIVIDADE: "Sem nenhuma atividade",
  SEM_ATIVIDADE_RECENTE: `Sem atividade há ${DIAS_SEM_ATIVIDADE_RECENTE}+ dias`,
};

export interface LinhaNegocio {
  negocio: string;
  empresa: string | null;
  contato: string | null;
  cargo: string | null;
  valor: number | null;
  valor_formatado: string;
  estagio: string | null;
  situacao: string;
  ultima_atividade: string | null;
  dias_sem_atividade: number | null;
  proximo_passo: { titulo: string; data: string; vencido: boolean } | null;
  sinais: Sinal[];
  motivos: string[];
  evidencias: string[];
  reuniao_registrada: {
    resumo: string;
    objecoes: string[];
    prioridades: string[];
    proximos_passos: string[];
  } | null;
}

export interface MetricasPipeline {
  quantidade: number;
  valor_total: string;
  maior_oportunidade: { negocio: string; empresa: string | null; valor: string; estagio: string | null } | null;
  sem_proximo_passo: string[];
  sem_atividade_recente: string[];
  por_estagio: Array<{ estagio: string; quantidade: number; valor: string }>;
}

export function formatarBRL(v: number): string {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 })
    .replace(/ /g, " ");
}

function data(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric" })
    .format(new Date(iso));
}

function numero(v: number | string | null): number | null {
  if (v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

const SITUACAO: Record<string, string> = { open: "em aberto", won: "ganho", lost: "perdido" };

/** Data em que a atividade aconteceu, ou null se ainda não aconteceu.
 * Log de sistema (`ai_log`: rascunho de proposta etc.) não conta como contato comercial. */
function quandoAconteceu(a: AtividadeFonte): number | null {
  if (a.type === "ai_log") return null;
  if (a.completed_at) return Date.parse(a.completed_at);
  if (a.type === "note") return Date.parse(a.created_at);
  return null;
}

function reuniao(atividades: AtividadeFonte[]): LinhaNegocio["reuniao_registrada"] {
  const m = atividades
    .map((a) => a.metadata as { kind?: string; meeting?: Record<string, unknown> } | null)
    .find((md) => md?.kind === "meeting_result" && md.meeting);
  if (!m?.meeting) return null;
  const lista = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    resumo: typeof m.meeting.summary === "string" ? m.meeting.summary : "",
    objecoes: lista(m.meeting.objections),
    prioridades: lista(m.meeting.priorities),
    proximos_passos: lista(m.meeting.nextSteps),
  };
}

export function montarLinha(
  deal: DealFonte,
  empresa: string | null,
  atividades: AtividadeFonte[],
  retornos: RetornoFonte[],
  agora: Date,
): LinhaNegocio {
  const valor = numero(deal.value);
  const ocorridas = atividades.map(quandoAconteceu).filter((t): t is number => t !== null);
  const ultima = ocorridas.length > 0 ? Math.max(...ocorridas) : null;
  const dias = ultima === null ? null : Math.max(0, Math.floor((agora.getTime() - ultima) / DIA_MS));

  const abertos = [
    ...atividades
      .filter((a) => (a.type === "task" || a.type === "call") && !a.completed_at && a.due_at)
      .map((a) => ({ titulo: a.title, quando: Date.parse(a.due_at!) })),
    ...retornos
      .filter((r) => r.status === "pending")
      .map((r) => ({ titulo: r.description?.trim() || "Retorno agendado", quando: Date.parse(r.scheduled_at) })),
  ].sort((a, b) => a.quando - b.quando);
  const prox = abertos[0] ?? null;
  const vencido = prox !== null && prox.quando < agora.getTime();

  const sinais: Sinal[] = [];
  const evidencias: string[] = [];
  if (!prox) {
    sinais.push("SEM_PROXIMO_PASSO");
    evidencias.push("Não existe próximo passo cadastrado.");
  } else if (vencido) {
    sinais.push("PROXIMO_PASSO_VENCIDO");
    evidencias.push(`Próximo passo "${prox.titulo}" venceu em ${data(new Date(prox.quando).toISOString())}.`);
  }
  if (dias === null) {
    sinais.push("SEM_ATIVIDADE");
    evidencias.push("Nenhuma atividade registrada no negócio.");
  } else if (dias >= DIAS_SEM_ATIVIDADE_RECENTE) {
    sinais.push("SEM_ATIVIDADE_RECENTE");
    evidencias.push(`Sem atividade registrada há ${dias} dias.`);
  }

  return {
    negocio: deal.title,
    empresa,
    contato: deal.contact?.name ?? null,
    cargo: deal.contact?.job_title?.trim() || null,
    valor,
    valor_formatado: valor === null ? "Valor não informado" : formatarBRL(valor),
    estagio: deal.stage?.name ?? null,
    situacao: SITUACAO[deal.status] ?? deal.status,
    ultima_atividade: ultima === null ? null : data(new Date(ultima).toISOString()),
    dias_sem_atividade: dias,
    proximo_passo: prox
      ? { titulo: prox.titulo, data: data(new Date(prox.quando).toISOString()), vencido }
      : null,
    sinais,
    motivos: sinais.map((x) => ROTULO_SINAL[x]),
    evidencias,
    reuniao_registrada: reuniao(atividades),
  };
}

/** Ordem de atenção, explícita e sem score opaco:
 * 1) mais sinais objetivos; 2) maior valor. Negócio sem sinal fica de fora. */
export function prioridadeDeAtencao(linhas: LinhaNegocio[]): LinhaNegocio[] {
  return linhas
    .filter((l) => l.sinais.length > 0)
    .sort((a, b) => b.sinais.length - a.sinais.length || (b.valor ?? 0) - (a.valor ?? 0));
}

export function calcularMetricas(linhas: LinhaNegocio[]): MetricasPipeline {
  const abertas = linhas.filter((l) => l.situacao === "em aberto");
  const total = abertas.reduce((s, l) => s + (l.valor ?? 0), 0);
  const maior = abertas.reduce<LinhaNegocio | null>(
    (m, l) => (l.valor !== null && (m === null || l.valor > (m.valor ?? -1)) ? l : m),
    null,
  );
  const porEstagio = new Map<string, { quantidade: number; valor: number }>();
  for (const l of abertas) {
    const k = l.estagio ?? "Estágio não identificado";
    const acc = porEstagio.get(k) ?? { quantidade: 0, valor: 0 };
    porEstagio.set(k, { quantidade: acc.quantidade + 1, valor: acc.valor + (l.valor ?? 0) });
  }
  return {
    quantidade: abertas.length,
    valor_total: formatarBRL(total),
    maior_oportunidade: maior
      ? { negocio: maior.negocio, empresa: maior.empresa, valor: maior.valor_formatado, estagio: maior.estagio }
      : null,
    sem_proximo_passo: abertas.filter((l) => l.sinais.includes("SEM_PROXIMO_PASSO")).map((l) => l.negocio),
    sem_atividade_recente: abertas
      .filter((l) => l.sinais.includes("SEM_ATIVIDADE") || l.sinais.includes("SEM_ATIVIDADE_RECENTE"))
      .map((l) => l.negocio),
    por_estagio: [...porEstagio].map(([estagio, v]) => ({
      estagio,
      quantidade: v.quantidade,
      valor: formatarBRL(v.valor),
    })),
  };
}

function norm(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** Busca por negócio, empresa OU contato — "Atlas Industrial" é empresa, não título. */
export function filtrarPorTermo(linhas: LinhaNegocio[], termo: string): LinhaNegocio[] {
  const t = norm(termo);
  if (!t) return linhas;
  return linhas.filter((l) =>
    [l.negocio, l.empresa, l.contato].some((campo) => campo !== null && norm(campo).includes(t))
  );
}

const UUID_GLOBAL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Última barreira: identificador interno nunca chega à tela. */
export function removerIdsInternos(texto: string): string {
  return texto.replace(UUID_GLOBAL, "[referência interna]");
}

/** Termos que o CRM não registra. Se aparecerem na resposta sem estarem no dado
 * entregue ao redator, a resposta é trocada pela recusa honesta. */
const NAO_REGISTRADOS = [
  "erp", "sap", "totvs", "oracle", "protheus", "salesforce", "hubspot", "pipedrive",
  "outlook", "gmail", "faturamento", "budget", "orcamento aprovado", "concorrente",
];

export function termoInventado(resposta: string, dadosEntregues: string): string | null {
  const r = norm(resposta);
  const d = norm(dadosEntregues);
  for (const t of NAO_REGISTRADOS) {
    const re = new RegExp(`\\b${t}\\b`);
    if (re.test(r) && !re.test(d)) return t;
  }
  // Percentual de fechamento não existe no CRM: nenhum "NN%" pode aparecer
  // se não veio nos dados.
  for (const m of r.match(/\d+(?:[.,]\d+)?\s?%/g) ?? []) {
    if (!d.includes(m.replace(/\s/g, ""))) return `percentual:${m}`;
  }
  return null;
}
