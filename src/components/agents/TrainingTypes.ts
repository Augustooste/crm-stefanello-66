// Tipos e rótulos PT-BR compartilhados entre os componentes da aba
// "Treinamentos" do agente provedor de agentes. Nenhum campo aqui é inventado: os tipos
// vêm do contrato gerado (schema.gen.ts); os rótulos só traduzem enums do
// contrato para PT-BR — ver contracts/agent-platform/CONTRACT_MATRIX.md §1.4.
import type { components } from "@/integrations/agent-platform/schema.gen";
import type {
  TrainingInterval,
  TrainingSubPages,
  TrainingType,
} from "@/integrations/agent-platform/enums.gen";

export type TextTrainingItem = components["schemas"]["TextTraining"];
export type WebsiteTrainingItem = components["schemas"]["WebsiteTraining"];
export type VideoTrainingItem = components["schemas"]["VideoTraining"];
export type DocumentTrainingItem = components["schemas"]["DocumentTraining"];

/** Um item de qualquer variante retornada por `trainings.list`. */
export type TrainingItem =
  TextTrainingItem | WebsiteTrainingItem | VideoTrainingItem | DocumentTrainingItem;

export const TRAINING_TYPE_LABELS: Record<TrainingType, string> = {
  TEXT: "Texto",
  WEBSITE: "Site",
  VIDEO: "Vídeo",
  DOCUMENT: "Documento",
};

export const TRAINING_SUB_PAGES_LABELS: Record<TrainingSubPages, string> = {
  DISABLED: "Desativado",
  ACTIVE: "Ativado",
};

export const TRAINING_INTERVAL_LABELS: Record<TrainingInterval, string> = {
  THIRTY_SECONDS: "30 segundos",
  NEVER: "Nunca",
  ONE_HOUR: "1 hora",
  FOUR_HOUR: "4 horas",
  EIGHT_HOUR: "8 horas",
  TWELVE_HOUR: "12 horas",
  ONE_DAY: "1 dia",
  ONE_WEEK: "1 semana",
  ONE_MONTH: "1 mês",
};

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Descrição curta e legível de um treinamento, usada nos diálogos de confirmação. */
export function trainingSummary(item: TrainingItem): string {
  if (item.type === "TEXT") {
    return `O treinamento de texto "${truncate(item.text ?? "", 40)}"`;
  }
  if (item.type === "WEBSITE") {
    return `O treinamento do site "${item.website ?? "sem endereço"}"`;
  }
  if (item.type === "VIDEO") {
    return `O treinamento do vídeo "${item.video ?? "sem link"}"`;
  }
  if (item.type === "DOCUMENT") {
    return `O treinamento do documento "${item.documentName ?? "sem nome"}"`;
  }
  return "O treinamento selecionado";
}
