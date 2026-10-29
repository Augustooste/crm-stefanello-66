import type { AgentType, CommunicationType } from "@/integrations/agent-platform/enums.gen";

export const AGENT_TYPE_LABELS: Record<AgentType, string> = {
  SUPPORT: "Suporte",
  SALE: "Vendas",
  PERSONAL: "Pessoal",
};

export const COMMUNICATION_TYPE_LABELS: Record<CommunicationType, string> = {
  FORMAL: "Formal",
  NORMAL: "Normal",
  RELAXED: "Descontraído",
};
