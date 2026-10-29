// Presets built-in de visualização. Ficam em código (não em banco) — são
// read-only, aparecem para todos os tenants, e Admin aplica com um clique.
// Custom presets por tenant serão uma migração futura (tabela dedicada).
import type { ViewPrefsMap } from "@/lib/api/view-prefs";

export type Preset = {
  id: string;
  name: string;
  description: string;
  prefs: ViewPrefsMap;
};

// Todas as widget keys que os presets referenciam. Manter sincronizado
// com src/lib/view-prefs/registry.ts.
const OFF = false;
const ON = true;

export const BUILTIN_PRESETS: Preset[] = [
  {
    id: "vendas",
    name: "Vendas",
    description:
      "Foco em performance financeira e conversão: KPIs monetários, funil, atividades e mensagens.",
    prefs: {
      dashboard: {
        action_briefing: ON,
        kpi_pipeline: ON,
        kpi_active_deals: ON,
        kpi_win_rate: ON,
        kpi_revenue: ON,
        wallet_health: OFF,
        messaging_performance: ON,
        ai_hitl: OFF,
        pending_returns: OFF,
        pipeline_funnel: ON,
        recent_activity: ON,
        today_activities: ON,
        unanswered_leads: OFF,
      },
    },
  },
  {
    id: "sdr",
    name: "SDR",
    description:
      "Prospecção e primeira resposta: prioridade do dia, leads sem resposta, mensagens e HITL.",
    prefs: {
      dashboard: {
        action_briefing: ON,
        kpi_pipeline: OFF,
        kpi_active_deals: ON,
        kpi_win_rate: OFF,
        kpi_revenue: OFF,
        wallet_health: OFF,
        messaging_performance: ON,
        ai_hitl: ON,
        pending_returns: ON,
        pipeline_funnel: OFF,
        recent_activity: ON,
        today_activities: ON,
        unanswered_leads: ON,
      },
    },
  },
  {
    id: "gestor",
    name: "Gestor",
    description:
      "Visão executiva completa: todos os indicadores, saúde da carteira, IA/revisão humana e funil.",
    prefs: {
      dashboard: {
        action_briefing: ON,
        kpi_pipeline: ON,
        kpi_active_deals: ON,
        kpi_win_rate: ON,
        kpi_revenue: ON,
        wallet_health: ON,
        messaging_performance: ON,
        ai_hitl: ON,
        pending_returns: ON,
        pipeline_funnel: ON,
        recent_activity: ON,
        today_activities: OFF,
        unanswered_leads: OFF,
      },
    },
  },
];

export function findPreset(id: string): Preset | null {
  return BUILTIN_PRESETS.find((p) => p.id === id) ?? null;
}
