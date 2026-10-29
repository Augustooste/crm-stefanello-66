// Diálogo de criar/editar intenção do agente provedor de agentes.
// POST /v2/agent/{agentId}/intentions · PUT /v2/intention/{intentionId}
// (ver contracts/agent-platform/CONTRACT_MATRIX.md §1.5 e divergência D7).
//
// O CRM IA NUNCA chama a URL cadastrada aqui — quem executa o webhook
// durante a conversa é o próprio provedor de agentes. Este formulário só salva a
// configuração da intenção.
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { INTENTION_HTTP_METHODS } from "@/integrations/agent-platform/enums.gen";
import { useAgentPlatformMutation } from "@/lib/api/agent-platform";
import type { AgentPlatformIntention } from "@/lib/api/agent-platform-contract";
import { IntentionFieldsEditor } from "@/components/agents/IntentionFieldsEditor";
import { IntentionKeyValueEditor } from "@/components/agents/IntentionKeyValueEditor";
import { IntentionVariablesEditor } from "@/components/agents/IntentionVariablesEditor";
import {
  buildIntentionCreateBody,
  buildIntentionUpdateBody,
  emptyIntentionFormValues,
  intentionToFormValues,
  validateIntentionForm,
  type IntentionFormValues,
} from "@/components/agents/IntentionFormTypes";

interface IntentionFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  intention?: AgentPlatformIntention;
}

export function IntentionFormDialog({
  open,
  onOpenChange,
  agentId,
  intention,
}: IntentionFormDialogProps) {
  const isEditing = !!intention?.id;
  const [values, setValues] = useState<IntentionFormValues>(() =>
    intention ? intentionToFormValues(intention) : emptyIntentionFormValues(),
  );
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setValues(intention ? intentionToFormValues(intention) : emptyIntentionFormValues());
    setFormError(null);
    // Recarrega os valores do formulário só quando o diálogo é reaberto — evita
    // perder o que o usuário está digitando enquanto edita.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, intention?.id]);

  const createMutation = useAgentPlatformMutation("intentions.create", {
    invalidate: ["intentions.list"],
  });
  const updateMutation = useAgentPlatformMutation("intention.update", {
    invalidate: ["intentions.list"],
  });
  const isSaving = createMutation.isPending || updateMutation.isPending;

  function updateValues(patch: Partial<IntentionFormValues>) {
    setValues((prev) => ({ ...prev, ...patch }));
    if (formError) setFormError(null);
  }

  function handleSubmit() {
    const validationError = validateIntentionForm(values);
    if (validationError) {
      setFormError(validationError);
      return;
    }

    if (isEditing && intention?.id) {
      updateMutation.mutate(
        { params: { agentId, intentionId: intention.id }, body: buildIntentionUpdateBody(values) },
        {
          onSuccess: () => {
            toast.success("Intenção atualizada.");
            onOpenChange(false);
          },
          onError: (error) => toast.error(error.message),
        },
      );
      return;
    }

    createMutation.mutate(
      { params: { agentId }, body: buildIntentionCreateBody(values) },
      {
        onSuccess: () => {
          toast.success("Intenção criada.");
          onOpenChange(false);
        },
        onError: (error) => toast.error(error.message),
      },
    );
  }

  const isWebhook = values.type === "WEBHOOK";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Editar intenção" : "Nova intenção"}</DialogTitle>
          <DialogDescription>
            Define quando e como o agente deve agir para atender a este objetivo. O CRM IA não
            executa a URL cadastrada — quem chama o webhook durante a conversa é o provedor de
            agentes.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor="intention-description">Descrição *</Label>
            <Textarea
              id="intention-description"
              value={values.description}
              onChange={(event) => updateValues({ description: event.target.value })}
              placeholder="Ex.: Agendar uma demonstração do produto"
              rows={2}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Tipo de intenção</Label>
            <ToggleGroup
              type="single"
              value={values.type}
              onValueChange={(value) =>
                value && updateValues({ type: value as typeof values.type })
              }
              className="justify-start"
            >
              <ToggleGroupItem value="WEBHOOK" aria-label="Webhook">
                Webhook
              </ToggleGroupItem>
              <ToggleGroupItem value="INSTRUCTIONS" aria-label="Instruções">
                Instruções
              </ToggleGroupItem>
            </ToggleGroup>
            <p className="text-caption text-muted-foreground">
              {isWebhook
                ? "O provedor de agentes chama uma URL sua quando identifica esta intenção na conversa."
                : "O agente segue instruções de texto para responder, sem chamar nenhuma URL."}
            </p>
          </div>

          {isWebhook && (
            <div className="space-y-4 rounded-md border border-border p-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[8rem_1fr]">
                <div className="space-y-1">
                  <Label htmlFor="intention-method">Método</Label>
                  <Select
                    value={values.httpMethod}
                    onValueChange={(value) =>
                      updateValues({ httpMethod: value as typeof values.httpMethod })
                    }
                  >
                    <SelectTrigger id="intention-method">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {INTENTION_HTTP_METHODS.map((method) => (
                        <SelectItem key={method} value={method}>
                          {method}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="intention-url">URL *</Label>
                  <Input
                    id="intention-url"
                    value={values.url}
                    onChange={(event) => updateValues({ url: event.target.value })}
                    placeholder="https://minha-api.com/webhook"
                  />
                </div>
              </div>

              <p className="text-caption text-muted-foreground">
                Este endereço é chamado pelo próprio provedor de agentes durante a conversa — o CRM
                IA nunca dispara essa URL, então não há botão de "testar" aqui.
              </p>

              <div className="flex flex-col gap-3 sm:flex-row sm:gap-6">
                <label className="flex items-center gap-2 text-body text-foreground">
                  <Switch
                    checked={values.autoGenerateParams}
                    onCheckedChange={(checked) => updateValues({ autoGenerateParams: checked })}
                  />
                  Gerar parâmetros automaticamente
                </label>
                <label className="flex items-center gap-2 text-body text-foreground">
                  <Switch
                    checked={values.autoGenerateBody}
                    onCheckedChange={(checked) => updateValues({ autoGenerateBody: checked })}
                  />
                  Gerar corpo automaticamente
                </label>
              </div>

              <IntentionKeyValueEditor
                title="Cabeçalhos (headers)"
                addLabel="Adicionar cabeçalho"
                emptyLabel="Nenhum cabeçalho adicionado."
                namePlaceholder="Ex.: Authorization"
                valuePlaceholder="Valor do cabeçalho"
                items={values.headers}
                onChange={(headers) => updateValues({ headers })}
                maskValues
              />

              <IntentionKeyValueEditor
                title="Parâmetros de URL (params)"
                addLabel="Adicionar parâmetro"
                emptyLabel="Nenhum parâmetro adicionado."
                namePlaceholder="Ex.: origem"
                valuePlaceholder="Valor do parâmetro"
                items={values.params}
                onChange={(params) => updateValues({ params })}
              />

              <IntentionVariablesEditor
                variables={values.variables}
                onChange={(variables) => updateValues({ variables })}
              />

              <div className="space-y-1.5">
                <Label htmlFor="intention-request-body">Corpo da requisição (JSON)</Label>
                <Textarea
                  id="intention-request-body"
                  value={values.requestBody}
                  onChange={(event) => updateValues({ requestBody: event.target.value })}
                  placeholder='Ex.: {"produto": "{{nome_do_produto}}"}'
                  rows={4}
                  className="font-mono text-sm"
                />
                <p className="text-caption text-muted-foreground">
                  Texto de um JSON válido. Validamos antes de salvar.
                </p>
              </div>
            </div>
          )}

          <IntentionFieldsEditor
            fields={values.fields}
            onChange={(fields) => updateValues({ fields })}
          />

          <div className="space-y-1.5">
            <Label htmlFor="intention-instructions">Instruções para o agente</Label>
            <Textarea
              id="intention-instructions"
              value={values.instructions}
              onChange={(event) => updateValues({ instructions: event.target.value })}
              placeholder="Como o agente deve se comportar ao identificar esta intenção"
              rows={3}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="intention-details">Detalhes dos dados de saída</Label>
            <Textarea
              id="intention-details"
              value={values.details}
              onChange={(event) => updateValues({ details: event.target.value })}
              rows={2}
            />
          </div>

          {formError && <p className="text-caption text-destructive">{formError}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isSaving}>
            Cancelar
          </Button>
          <Button onClick={handleSubmit} disabled={isSaving}>
            {isSaving ? "Salvando…" : "Salvar intenção"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
