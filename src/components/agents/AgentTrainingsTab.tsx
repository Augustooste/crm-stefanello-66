// Aba "Treinamentos" do agente provedor de agentes: uma sub-aba por TRAINING_TYPES
// (TEXT/WEBSITE/VIDEO/DOCUMENT) — o contrato exige `type` na listagem, então
// não existe uma visão "todos os tipos" numa chamada só (divergência D2 em
// contracts/agent-platform/CONTRACT_MATRIX.md §1.4).
import { useState } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TRAINING_TYPES, type TrainingType } from "@/integrations/agent-platform/enums.gen";
import { TRAINING_TYPE_LABELS } from "@/components/agents/TrainingTypes";
import { TrainingList } from "@/components/agents/TrainingList";

interface AgentTrainingsTabProps {
  agentId: string;
}

export function AgentTrainingsTab({ agentId }: AgentTrainingsTabProps) {
  const [activeType, setActiveType] = useState<TrainingType>(TRAINING_TYPES[0]);

  return (
    <Tabs value={activeType} onValueChange={(value) => setActiveType(value as TrainingType)}>
      <TabsList>
        {TRAINING_TYPES.map((type) => (
          <TabsTrigger key={type} value={type}>
            {TRAINING_TYPE_LABELS[type]}
          </TabsTrigger>
        ))}
      </TabsList>
      {TRAINING_TYPES.map((type) => (
        <TabsContent key={type} value={type}>
          <TrainingList agentId={agentId} type={type} />
        </TabsContent>
      ))}
    </Tabs>
  );
}
