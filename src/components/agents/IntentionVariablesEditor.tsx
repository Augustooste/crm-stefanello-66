// Editor de `variables[]` — liga o valor extraído da conversa a um campo
// padrão de contato (`defaultFieldKey`) ou a um campo customizado do
// workspace (`customField`), mutuamente exclusivos por linha (ver
// contracts/agent-platform/CONTRACT_MATRIX.md §1.5).
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
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
import { CUSTOM_FIELD_TYPES } from "@/integrations/agent-platform/enums.gen";
import {
  DEFAULT_FIELD_KEYS,
  emptyIntentionVariable,
  type IntentionVariableDraft,
} from "@/components/agents/IntentionFormTypes";

const CUSTOM_FIELD_TYPE_LABELS: Record<(typeof CUSTOM_FIELD_TYPES)[number], string> = {
  STRING: "Texto",
  DATE: "Data",
  DATE_TIME: "Data e hora",
  NUMBER: "Número",
  BOOLEAN: "Verdadeiro/Falso",
  MONEY: "Valor monetário",
};

interface IntentionVariablesEditorProps {
  variables: IntentionVariableDraft[];
  onChange: (variables: IntentionVariableDraft[]) => void;
}

export function IntentionVariablesEditor({ variables, onChange }: IntentionVariablesEditorProps) {
  function updateVariable(index: number, patch: Partial<IntentionVariableDraft>) {
    onChange(variables.map((variable, i) => (i === index ? { ...variable, ...patch } : variable)));
  }

  function removeVariable(index: number) {
    onChange(variables.filter((_, i) => i !== index));
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label>Variáveis</Label>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onChange([...variables, emptyIntentionVariable()])}
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          Adicionar variável
        </Button>
      </div>
      <p className="text-caption text-muted-foreground">
        Liga o valor extraído da conversa a um campo padrão do contato ou a um campo personalizado
        do workspace.
      </p>

      {variables.length === 0 && (
        <p className="text-caption text-muted-foreground">Nenhuma variável adicionada.</p>
      )}

      {variables.map((variable, index) => (
        <div key={index} className="space-y-3 rounded-md border border-border p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 space-y-1">
              <Label htmlFor={`var-expr-${index}`}>Expressão do valor *</Label>
              <Input
                id={`var-expr-${index}`}
                value={variable.valueExpression}
                onChange={(event) => updateVariable(index, { valueExpression: event.target.value })}
                placeholder="Ex.: {{nome_do_produto}}"
              />
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => removeVariable(index)}
              aria-label={`Remover variável ${index + 1}`}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            </Button>
          </div>

          <label className="flex items-center gap-2 text-body text-foreground">
            <Switch
              checked={variable.useCustomField}
              onCheckedChange={(checked) => updateVariable(index, { useCustomField: checked })}
              aria-label={`Usar campo personalizado na variável ${index + 1}`}
            />
            Usar campo personalizado (em vez de um campo padrão do contato)
          </label>

          {variable.useCustomField ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor={`var-cf-id-${index}`}>ID do campo</Label>
                <Input
                  id={`var-cf-id-${index}`}
                  value={variable.customField.id}
                  onChange={(event) =>
                    updateVariable(index, {
                      customField: { ...variable.customField, id: event.target.value },
                    })
                  }
                  placeholder="ID obtido em Campos personalizados"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`var-cf-name-${index}`}>Nome</Label>
                <Input
                  id={`var-cf-name-${index}`}
                  value={variable.customField.name}
                  onChange={(event) =>
                    updateVariable(index, {
                      customField: { ...variable.customField, name: event.target.value },
                    })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`var-cf-json-${index}`}>Nome JSON</Label>
                <Input
                  id={`var-cf-json-${index}`}
                  value={variable.customField.jsonName}
                  onChange={(event) =>
                    updateVariable(index, {
                      customField: { ...variable.customField, jsonName: event.target.value },
                    })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`var-cf-type-${index}`}>Tipo</Label>
                <Select
                  value={variable.customField.type}
                  onValueChange={(value) =>
                    updateVariable(index, {
                      customField: {
                        ...variable.customField,
                        type: value as IntentionVariableDraft["customField"]["type"],
                      },
                    })
                  }
                >
                  <SelectTrigger id={`var-cf-type-${index}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CUSTOM_FIELD_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {CUSTOM_FIELD_TYPE_LABELS[type]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor={`var-cf-description-${index}`}>Descrição</Label>
                <Input
                  id={`var-cf-description-${index}`}
                  value={variable.customField.description}
                  onChange={(event) =>
                    updateVariable(index, {
                      customField: { ...variable.customField, description: event.target.value },
                    })
                  }
                />
              </div>
            </div>
          ) : (
            <div className="space-y-1">
              <Label htmlFor={`var-default-key-${index}`}>Campo padrão do contato</Label>
              <Input
                id={`var-default-key-${index}`}
                value={variable.defaultFieldKey}
                onChange={(event) => updateVariable(index, { defaultFieldKey: event.target.value })}
                placeholder="Ex.: contact_name"
                list={`default-field-keys-${index}`}
              />
              <datalist id={`default-field-keys-${index}`}>
                {DEFAULT_FIELD_KEYS.map((key) => (
                  <option key={key} value={key} />
                ))}
              </datalist>
              <p className="text-caption text-muted-foreground">
                Aceitos: {DEFAULT_FIELD_KEYS.join(", ")}.
              </p>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
