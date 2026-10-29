// Editor reaproveitado por `headers[]` e `params[]` da intenção (mesmo shape
// `{name, value}` no contrato — ver contracts/agent-platform/CONTRACT_MATRIX.md §1.5).
// Quando `maskValues` está ativo, um valor carregado de uma intenção existente
// nunca aparece cru na tela: só o rótulo mascarado + botão "Substituir". Ao
// clicar em "Substituir", o valor real é descartado (campo começa vazio) —
// ele nunca fica exposto no atributo `value` de um `<input>` inspecionável.
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  emptyIntentionKeyValue,
  maskSecret,
  type IntentionKeyValueDraft,
} from "@/components/agents/IntentionFormTypes";

interface IntentionKeyValueEditorProps {
  title: string;
  addLabel: string;
  emptyLabel: string;
  namePlaceholder: string;
  valuePlaceholder: string;
  items: IntentionKeyValueDraft[];
  onChange: (items: IntentionKeyValueDraft[]) => void;
  maskValues?: boolean;
}

export function IntentionKeyValueEditor({
  title,
  addLabel,
  emptyLabel,
  namePlaceholder,
  valuePlaceholder,
  items,
  onChange,
  maskValues = false,
}: IntentionKeyValueEditorProps) {
  function updateItem(index: number, patch: Partial<IntentionKeyValueDraft>) {
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function removeItem(index: number) {
    onChange(items.filter((_, i) => i !== index));
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label>{title}</Label>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onChange([...items, emptyIntentionKeyValue()])}
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          {addLabel}
        </Button>
      </div>

      {items.length === 0 && <p className="text-caption text-muted-foreground">{emptyLabel}</p>}

      {items.map((item, index) => (
        <div
          key={index}
          className="flex flex-col gap-2 rounded-md border border-border p-3 sm:flex-row sm:items-end"
        >
          <div className="flex-1 space-y-1">
            <Label htmlFor={`kv-name-${title}-${index}`}>Nome</Label>
            <Input
              id={`kv-name-${title}-${index}`}
              value={item.name}
              onChange={(event) => updateItem(index, { name: event.target.value })}
              placeholder={namePlaceholder}
            />
          </div>
          <div className="flex-1 space-y-1">
            <Label htmlFor={`kv-value-${title}-${index}`}>Valor</Label>
            {maskValues && item.masked ? (
              <div className="flex items-center gap-2">
                <span className="rounded-md border border-input bg-muted/40 px-3 py-2 font-mono text-sm text-muted-foreground">
                  {maskSecret(item.value)}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => updateItem(index, { value: "", masked: false })}
                >
                  Substituir
                </Button>
              </div>
            ) : (
              <Input
                id={`kv-value-${title}-${index}`}
                value={item.value}
                onChange={(event) => updateItem(index, { value: event.target.value })}
                placeholder={valuePlaceholder}
              />
            )}
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => removeItem(index)}
            aria-label={`Remover ${item.name || `item ${index + 1}`}`}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>
      ))}
    </div>
  );
}
