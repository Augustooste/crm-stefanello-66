import { createContext, useContext } from "react";

// --- Estado de sessão do "último status aplicado" (ver D6 da matriz) -----
// O contrato do provedor de agentes não expõe se um agente está ativo/inativo em
// nenhuma resposta (nem `agent.get`, nem `agents.list`) -- só as ações
// activate/deactivate, que devolvem apenas `{success}`. Por isso o único
// "status" que o CRM IA pode mostrar é o que o próprio usuário acionou
// nesta aba, durante esta sessão do navegador -- nunca um campo remoto
// inventado.
//
// O header da rota (`_app.agentes.$agentId.tsx`) também precisa desse estado
// para o badge no topo da página, mas a assinatura de todas as abas é fixa
// em `{ agentId }` (sem callbacks) -- o compartilhamento é via Context, não
// prop drilling. A rota envolve header + abas em `AgentSessionStatusProvider`
// (com `key={agentId}` para resetar ao trocar de agente); só esta aba
// escreve no Context.
export type AgentSessionStatus = "active" | "inactive" | null;

interface AgentSessionStatusContextValue {
  status: AgentSessionStatus;
  setStatus: (status: AgentSessionStatus) => void;
}

export const AgentSessionStatusContext = createContext<AgentSessionStatusContextValue>({
  status: null,
  setStatus: () => {},
});

/** Lido pelo header da rota para exibir o badge de "último estado aplicado". */
export function useAgentSessionStatus(): AgentSessionStatus {
  return useContext(AgentSessionStatusContext).status;
}

export function useSetAgentSessionStatus(): (status: AgentSessionStatus) => void {
  return useContext(AgentSessionStatusContext).setStatus;
}
