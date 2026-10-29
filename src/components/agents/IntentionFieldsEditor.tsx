// Editor de `fields[]` da intenção — dados que o agente extrai da conversa,
// válido para os dois tipos de intenção (WEBHOOK e INSTRUCTIONS): o schema é
// um objeto único sem `oneOf` por `type` (ver contracts/agent-platform/CONTRACT_MATRIX.md §1.5).
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { INTENTION_FIELD_TYPES } from "@/integrations/agent-platform/enums.gen";
import {
  emptyIntentionField,
  type IntentionFieldDraft,
} from "@/components/agents/IntentionFormTypes";

const FIELD_TYPE_LABELS: Record<(typeof INTENTION_FIELD_TYPES)[number], string> = {
  STRING: "Texto",
  URL: "URL",
  DATE_TIME: "Data e hora",
  DATE: "Data",
  NUMBER: "Número",
  BOOLEAN: "Verdadeiro/Falso",
};

interface IntentionFieldsEditorProps {
  fields: IntentionFieldDraft[];
  onChange: (fields: IntentionFieldDraft[]) => void;
}

export function IntentionFieldsEditor({ fields, onChange }: IntentionFieldsEditorProps) {
  function updateField(index: number, patch: Partial<IntentionFieldDraft>) {
    onChange(fields.map((field, i) => (i === index ? { ...field, ...patch } : field)));
  }

  function removeField(index: number) {
    onChange(fields.filter((_, i) => i !== index));
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label>Campos extraídos da conversa</Label>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onChange([...fields, emptyIntentionField()])}
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          Adicionar campo
        </Button>
      </div>
      <p className="text-caption text-muted-foreground">
        Dados que o agente deve identificar na conversa para esta intenção (ex.: nome do produto,
        data desejada).
      </p>

      {fields.length === 0 && (
        <p className="text-caption text-muted-foreground">Nenhum campo adicionado.</p>
      )}

      {fields.map((field, index) => (
        <div
          key={index}
          className="grid grid-cols-1 gap-2 rounded-md border border-border p-3 sm:grid-cols-2"
        >
          <div className="space-y-1">
            <Label htmlFor={`field-name-${index}`}>Nome</Label>
            <Input
              id={`field-name-${index}`}
              value={field.name}
              onChange={(event) => updateField(index, { name: event.target.value })}
              placeholder="Ex.: nome_do_produto"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`field-json-${index}`}>Nome JSON</Label>
            <Input
              id={`field-json-${index}`}
              value={field.jsonName}
              onChange={(event) => updateField(index, { jsonName: event.target.value })}
              placeholder="Ex.: productName"
            />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor={`field-description-${index}`}>Descrição</Label>
            <Input
              id={`field-description-${index}`}
              value={field.description}
              onChange={(event) => updateField(index, { description: event.target.value })}
              placeholder="O que este campo representa"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`field-type-${index}`}>Tipo</Label>
            <Select
              value={field.type}
              onValueChange={(value) =>
                updateField(index, { type: value as IntentionFieldDraft["type"] })
              }
            >
              <SelectTrigger id={`field-type-${index}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INTENTION_FIELD_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {FIELD_TYPE_LABELS[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end justify-between gap-2">
            <label className="flex items-center gap-2 text-body text-foreground">
              <Checkbox
                checked={field.required}
                onCheckedChange={(checked) => updateField(index, { required: checked === true })}
                aria-label={`Campo ${field.name || index + 1} obrigatório`}
              />
              Obrigatório
            </label>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => removeField(index)}
              aria-label={`Remover campo ${field.name || index + 1}`}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
