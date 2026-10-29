// Um card por intenção na lista da aba "Intenções" do agente provedor de agentes.
import { Pencil, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AgentPlatformIntention } from "@/lib/api/agent-platform-contract";
import type { IntentionType } from "@/integrations/agent-platform/enums.gen";

const TYPE_LABELS: Record<IntentionType, string> = {
  WEBHOOK: "Webhook",
  INSTRUCTIONS: "Instruções",
};

interface IntentionCardProps {
  intention: AgentPlatformIntention;
  onEdit: () => void;
  onDelete: () => void;
}

export function IntentionCard({ intention, onEdit, onDelete }: IntentionCardProps) {
  // D7 (contracts/agent-platform/CONTRACT_MATRIX.md): o tipo gerado para a
  // listagem só declara o literal "WEBHOOK"; alargamos para exibir também
  // "INSTRUCTIONS" quando o valor remoto vier assim.
  const type = (intention.type as IntentionType | undefined) ?? "WEBHOOK";

  return (
    <article className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate font-medium text-foreground">
              {intention.description || "(sem descrição)"}
            </h3>
            <Badge variant="outline">{TYPE_LABELS[type]}</Badge>
          </div>
          {type === "WEBHOOK" && (
            <p className="mt-1 truncate font-mono text-caption text-muted-foreground">
              {intention.httpMethod ?? "POST"} {intention.url || "(sem URL)"}
            </p>
          )}
          {type === "INSTRUCTIONS" && intention.instructions && (
            <p className="mt-1 line-clamp-2 text-caption text-muted-foreground">
              {intention.instructions}
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="outline" onClick={onEdit}>
            <Pencil className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            Editar
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete}>
            <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            Excluir
          </Button>
        </div>
      </div>
    </article>
  );
}
