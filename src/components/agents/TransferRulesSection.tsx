// Regras de transferência do agente — quando transferir para humano ou para
// outro agente. CRUD real por item (diferente das ações de inatividade).
import { useState } from "react";
import { AlertTriangle, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/common/EmptyState";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  TRANSFER_RULE_TYPES,
  type TransferRuleType,
} from "@/integrations/agent-platform/enums.gen";
import { useAgentPlatformMutation, useAgentPlatformQuery } from "@/lib/api/agent-platform";
import type { AgentPlatformTransferRule } from "@/lib/api/agent-platform-contract";

const TYPE_LABELS: Record<TransferRuleType, string> = {
  HUMAN: "Atendente humano",
  AGENT: "Outro agente",
};

/**
 * ACHADO (fora de D1-D14): igual ao de campos customizados — o contrato
 * documenta a resposta 200 de `GET /v2/agent/{id}/transfer-rules` como um
 * objeto ÚNICO, sem array/paginação. Normalizamos defensivamente.
 */
function toItems(
  value: AgentPlatformTransferRule | AgentPlatformTransferRule[] | null | undefined,
): AgentPlatformTransferRule[] {
  if (Array.isArray(value)) return value;
  if (value && "id" in value) return [value];
  return [];
}

export function TransferRulesSection({ agentId }: { agentId: string }) {
  const [formOpen, setFormOpen] = useState<{ rule?: AgentPlatformTransferRule } | null>(null);
  const [deleting, setDeleting] = useState<AgentPlatformTransferRule | null>(null);

  const listQ = useAgentPlatformQuery("transferRules.list", { params: { agentId } });

  const deleteMut = useAgentPlatformMutation("transferRule.delete", {
    invalidate: ["transferRules.list"],
    onSuccess: () => {
      toast.success("Regra removida");
      setDeleting(null);
    },
    onError: (e) => toast.error(e.message),
  });

  const items = toItems(listQ.data);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        {/* O título já está no AccordionTrigger — aqui só a descrição, sem repetir o heading. */}
        <CardDescription>
          Define quando o agente transfere a conversa para um humano ou outro agente.
        </CardDescription>
        <Button size="sm" onClick={() => setFormOpen({})}>
          <Plus className="mr-1 h-4 w-4" /> Nova regra
        </Button>
      </CardHeader>
      <CardContent>
        {listQ.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : listQ.error ? (
          <EmptyState
            icon={AlertTriangle}
            title="Não foi possível carregar as regras de transferência"
            description={listQ.error.message}
            actionLabel="Tentar de novo"
            onAction={() => listQ.refetch()}
          />
        ) : items.length === 0 ? (
          <EmptyState
            title="Sem regras de transferência"
            description="Crie regras para o agente saber quando transferir a conversa."
          />
        ) : (
          <ul className="divide-y divide-border">
            {items.map((r, i) => (
              <li key={r.id ?? i} className="flex flex-wrap items-start gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="text-body font-medium text-foreground">
                    {(r.type && TYPE_LABELS[r.type]) ?? r.type ?? "—"}
                    {r.returnOnFinish && (
                      <span className="ml-2 text-caption text-muted-foreground">
                        (retorna ao assistente ao concluir)
                      </span>
                    )}
                  </div>
                  <p className="text-body text-muted-foreground">{r.instructions}</p>
                  <p className="text-caption text-muted-foreground">
                    Destino: {r.type === "HUMAN" ? (r.userId ?? "—") : (r.agentId ?? "—")}
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={() => setFormOpen({ rule: r })}>
                  <Pencil className="mr-1 h-4 w-4" /> Editar
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Excluir regra"
                  onClick={() => setDeleting(r)}
                >
                  <Trash2 className="h-4 w-4 text-muted-foreground" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {formOpen && (
        <TransferRuleFormDialog
          open
          onOpenChange={(v) => !v && setFormOpen(null)}
          agentId={agentId}
          rule={formOpen.rule}
        />
      )}

      <AlertDialog open={!!deleting} onOpenChange={(v) => !v && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir regra de transferência</AlertDialogTitle>
            <AlertDialogDescription>
              Esta regra será removida do agente no provedor de agentes. Esta ação não pode ser
              desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() =>
                deleting?.id &&
                deleteMut.mutate({ params: { agentId, transferRuleId: deleting.id } })
              }
            >
              {deleteMut.isPending ? "Removendo…" : "Excluir"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function TransferRuleFormDialog({
  open,
  onOpenChange,
  agentId,
  rule,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  agentId: string;
  rule?: AgentPlatformTransferRule;
}) {
  const [instructions, setInstructions] = useState(rule?.instructions ?? "");
  const [returnOnFinish, setReturnOnFinish] = useState(rule?.returnOnFinish ?? false);
  const [type, setType] = useState<TransferRuleType>(rule?.type ?? "HUMAN");
  const [targetUserId, setTargetUserId] = useState(rule?.userId ?? "");
  const [targetAgentId, setTargetAgentId] = useState(rule?.agentId ?? "");

  const createMut = useAgentPlatformMutation("transferRules.create", {
    invalidate: ["transferRules.list"],
    onSuccess: () => {
      toast.success("Regra criada");
      onOpenChange(false);
    },
    onError: (e) => toast.error(e.message),
  });

  const updateMut = useAgentPlatformMutation("transferRule.update", {
    invalidate: ["transferRules.list"],
    onSuccess: () => {
      toast.success("Regra atualizada");
      onOpenChange(false);
    },
    onError: (e) => toast.error(e.message),
  });

  const isPending = createMut.isPending || updateMut.isPending;

  function handleSave() {
    const body = {
      instructions: instructions.trim(),
      returnOnFinish,
      type,
      userId: type === "HUMAN" ? targetUserId.trim() || null : null,
      agentId: type === "AGENT" ? targetAgentId.trim() || null : null,
    };
    if (rule?.id) {
      updateMut.mutate({ params: { agentId, transferRuleId: rule.id }, body });
    } else {
      createMut.mutate({ params: { agentId }, body });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {rule ? "Editar regra de transferência" : "Nova regra de transferência"}
          </DialogTitle>
          <DialogDescription>Diga ao agente quando e para quem transferir.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="tr-instructions">Instruções *</Label>
            <Textarea
              id="tr-instructions"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={3}
              placeholder="Ex.: transfira quando o cliente pedir para falar com uma pessoa"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Transferir para</Label>
            <Select value={type} onValueChange={(v) => setType(v as TransferRuleType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRANSFER_RULE_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {type === "HUMAN" ? (
            <div className="space-y-1.5">
              <Label htmlFor="tr-user-id">ID do usuário de destino</Label>
              <Input
                id="tr-user-id"
                value={targetUserId}
                onChange={(e) => setTargetUserId(e.target.value)}
                placeholder="Cole o ID do usuário no provedor de agentes"
              />
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="tr-agent-id">ID do agente de destino</Label>
              <Input
                id="tr-agent-id"
                value={targetAgentId}
                onChange={(e) => setTargetAgentId(e.target.value)}
                placeholder="Cole o ID do agente no provedor de agentes"
              />
            </div>
          )}
          <label className="flex items-center gap-2 text-body text-foreground">
            <Switch checked={returnOnFinish} onCheckedChange={setReturnOnFinish} />
            Retornar a este agente ao concluir o atendimento
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button disabled={!instructions.trim() || isPending} onClick={handleSave}>
            {isPending ? "Salvando…" : "Salvar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
