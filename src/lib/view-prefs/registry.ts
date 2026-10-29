// Registro central dos "widgets" (cards/KPIs) que o Admin pode ligar/desligar
// em Configurações → Visualização. Fonte única da verdade -- a aba de
// configurações lista o que está aqui, e cada página consulta este registry
// via useViewPrefs().isVisible(page, key) para decidir se renderiza a seção.
//
// Adicionar um card novo em qualquer página é 1 linha aqui + 1 wrap na
// página. Nenhuma alteração de schema é necessária (prefs é jsonb solto).

export type WidgetDef = {
  /** Chave estável usada no banco (jsonb key). Nunca renomear em produção. */
  key: string;
  /** Rótulo mostrado na aba de Configurações. */
  label: string;
  /** Texto de apoio na aba. */
  description: string;
  /** Se o default (quando o Admin nunca tocou) é visível. */
  defaultOn: boolean;
};

export type PageDef = {
  key: PageKey;
  label: string;
  widgets: WidgetDef[];
};

// v1 -- apenas o Dashboard entra no toggler. Relatórios/Inbox virão em
// PRs seguintes usando o MESMO registry (só adicionar entradas).
export const VIEW_REGISTRY = {
  dashboard: {
    key: "dashboard",
    label: "Visão geral",
    widgets: [
      {
        key: "action_briefing",
        label: "Prioridade do dia",
        description: "Cartão de foco operacional com os 3 sinais mais urgentes.",
        defaultOn: true,
      },
      {
        key: "kpi_pipeline",
        label: "Indicador — Total no funil (R$)",
        description: "Soma do valor dos negócios em aberto.",
        defaultOn: true,
      },
      {
        key: "kpi_active_deals",
        label: "Indicador — Negócios ativos",
        description: "Contagem de negócios em aberto no funil.",
        defaultOn: true,
      },
      {
        key: "kpi_win_rate",
        label: "Indicador — Taxa de ganho (coorte)",
        description: "Ganhos ÷ (ganhos + perdidos) no mês atual.",
        defaultOn: true,
      },
      {
        key: "kpi_revenue",
        label: "Indicador — Receita ganha (R$)",
        description: "Soma dos negócios ganhos no mês.",
        defaultOn: true,
      },
      {
        key: "wallet_health",
        label: "Saúde da carteira",
        description: "Contatos ativos/inativos, negócios parados e LTV médio.",
        defaultOn: true,
      },
      {
        key: "messaging_performance",
        label: "Performance de mensagens",
        description: "FRT, taxa de resposta e volume enviado (IA vs humano).",
        defaultOn: true,
      },
      {
        key: "ai_hitl",
        label: "IA e revisão humana",
        description: "Cobertura da IA, aprovações, edições e passagens para atendimento humano.",
        defaultOn: true,
      },
      {
        key: "pending_returns",
        label: "Retornos pendentes",
        description: "Conversas aguardando resposta humana com prazo estourado.",
        defaultOn: true,
      },
      {
        key: "pipeline_funnel",
        label: "Funil de vendas",
        description: "Distribuição de negócios por estágio (aberto/ganho/perdido).",
        defaultOn: true,
      },
      {
        key: "recent_activity",
        label: "Mural de atividades recentes",
        description: "Últimas 15 ações do time (contatos, notas, ligações).",
        defaultOn: true,
      },
      {
        key: "today_activities",
        label: "Atividades de hoje",
        description: "Tarefas, ligações e notas agendadas para hoje.",
        defaultOn: true,
      },
      {
        key: "unanswered_leads",
        label: "Leads sem resposta",
        description: "Conversas abertas aguardando retorno.",
        defaultOn: true,
      },
    ],
  },
} as const satisfies Record<string, PageDef>;

export type PageKey = "dashboard";

/** Lista de páginas na ordem canônica da UI de Configurações. */
export function listPages(): PageDef[] {
  return Object.values(VIEW_REGISTRY);
}

/** Encontra a definição de um widget. Retorna null se a chave sumiu do código
 *  (ex.: alguém desligou "kpi_x" no banco mas o card foi removido). */
export function findWidget(page: PageKey, key: string): WidgetDef | null {
  return VIEW_REGISTRY[page].widgets.find((w) => w.key === key) ?? null;
}
