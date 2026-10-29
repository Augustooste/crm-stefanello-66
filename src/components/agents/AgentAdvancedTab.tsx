// Aba "Avançado" do agente provedor de agentes: campos customizados, regras de
// transferência, ações de inatividade, histórico de comportamento e
// informações técnicas da integração.
//
// As seções ficam num Accordion aberto por padrão (`type="multiple"` com
// `defaultValue` listando todos os itens) para que as queries disparem ao
// montar — nenhuma seção fica "presa" atrás de um clique.
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BehaviorHistorySection } from "@/components/agents/BehaviorHistorySection";
import { CustomFieldsSection } from "@/components/agents/CustomFieldsSection";
import { IdleActionsSection } from "@/components/agents/IdleActionsSection";
import { TransferRulesSection } from "@/components/agents/TransferRulesSection";
import { useAgentPlatformConnection, type AgentPlatformConnection } from "@/lib/api/agent-platform";

const SECTION_IDS = ["custom-fields", "transfer-rules", "idle-actions", "behavior-history"];

const CONNECTION_STATUS_LABELS: Record<AgentPlatformConnection["status"], string> = {
  disabled: "Desativado",
  pending: "Pendente",
  active: "Ativo",
  error: "Erro",
};

export function AgentAdvancedTab({ agentId }: { agentId: string }) {
  return (
    <div className="space-y-6">
      <Accordion type="multiple" defaultValue={SECTION_IDS} className="space-y-2">
        <AccordionItem value="custom-fields" className="rounded-md border border-border px-4">
          <AccordionTrigger>Campos customizados</AccordionTrigger>
          <AccordionContent>
            <CustomFieldsSection />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="transfer-rules" className="rounded-md border border-border px-4">
          <AccordionTrigger>Regras de transferência</AccordionTrigger>
          <AccordionContent>
            <TransferRulesSection agentId={agentId} />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="idle-actions" className="rounded-md border border-border px-4">
          <AccordionTrigger>Ações de inatividade</AccordionTrigger>
          <AccordionContent>
            <IdleActionsSection agentId={agentId} />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="behavior-history" className="rounded-md border border-border px-4">
          <AccordionTrigger>Histórico de comportamento</AccordionTrigger>
          <AccordionContent>
            <BehaviorHistorySection agentId={agentId} />
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      <TechnicalInfoSection agentId={agentId} />
    </div>
  );
}

function TechnicalInfoSection({ agentId }: { agentId: string }) {
  const connectionQ = useAgentPlatformConnection();
  const connection = connectionQ.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-card-title">Informações técnicas</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-body text-foreground">
        <div>
          <span className="text-muted-foreground">ID do agente: </span>
          <code className="rounded bg-muted/50 px-1.5 py-0.5 text-caption">{agentId}</code>
        </div>
        <div>
          <span className="text-muted-foreground">Empresa configurada: </span>
          <strong>{connection?.workspaceIdConfigured ? "Sim" : "Não"}</strong>
        </div>
        <div>
          <span className="text-muted-foreground">Situação da conexão: </span>
          <strong>{connection ? CONNECTION_STATUS_LABELS[connection.status] : "—"}</strong>
        </div>
        {connection?.lastError && (
          <div className="text-destructive">Último erro: {connection.lastError}</div>
        )}
        <p className="pt-2 text-caption text-muted-foreground">
          O provedor de agentes é a fonte de verdade desta integração: valores podem mudar
          diretamente no painel deles a qualquer momento, sem passar pelo CRM IA.
        </p>
      </CardContent>
    </Card>
  );
}
