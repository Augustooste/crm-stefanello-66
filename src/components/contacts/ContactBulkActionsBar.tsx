import { useState } from "react";
import { Loader2, Tag, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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

interface ContactBulkActionsBarProps {
  selectedCount: number;
  allTags: string[];
  onApplyTag: (tag: string) => void;
  onDelete: () => void;
  onClearSelection: () => void;
  isApplyingTag: boolean;
  isDeleting: boolean;
}

/**
 * Barra de ações em lote — aparece quando >=1 contato está selecionado.
 *
 * Escopo desta fase: aplicar etiqueta e excluir (soft-delete) em lote.
 * "Mudar responsável/owner" e "mover de estágio" ficaram de fora porque
 * `contacts` não tem `owner_id` nem `stage_id` (essas colunas só existem em
 * `deals`) — ver nota em `use-bulk-contact-actions.ts`.
 */
export function ContactBulkActionsBar({
  selectedCount,
  allTags,
  onApplyTag,
  onDelete,
  onClearSelection,
  isApplyingTag,
  isDeleting,
}: ContactBulkActionsBarProps) {
  const [customTag, setCustomTag] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [tagPopoverOpen, setTagPopoverOpen] = useState(false);

  if (selectedCount === 0) return null;

  const applyTag = (tag: string) => {
    const trimmed = tag.trim();
    if (!trimmed) return;
    onApplyTag(trimmed);
    setCustomTag("");
    setTagPopoverOpen(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
      <span className="text-body font-medium text-foreground">
        {selectedCount} contato(s) selecionado(s)
      </span>

      <div className="ml-auto flex items-center gap-2">
        <Popover open={tagPopoverOpen} onOpenChange={setTagPopoverOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" disabled={isApplyingTag}>
              {isApplyingTag ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Tag className="mr-1 h-4 w-4" aria-hidden />
              )}
              Aplicar etiqueta
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-56 space-y-2 p-2">
            {allTags.length > 0 && (
              <div className="max-h-48 space-y-1 overflow-y-auto">
                {allTags.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => applyTag(t)}
                    className="block w-full rounded-sm px-2 py-1 text-left text-body hover:bg-muted"
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}
            <div className="flex gap-1 border-t border-border pt-2">
              <Input
                placeholder="Nova etiqueta"
                value={customTag}
                onChange={(e) => setCustomTag(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    applyTag(customTag);
                  }
                }}
              />
              <Button size="sm" onClick={() => applyTag(customTag)} disabled={!customTag.trim()}>
                Aplicar
              </Button>
            </div>
          </PopoverContent>
        </Popover>

        <Button
          variant="outline"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={() => setConfirmingDelete(true)}
          disabled={isDeleting}
        >
          {isDeleting ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Trash2 className="mr-1 h-4 w-4" aria-hidden />
          )}
          Excluir selecionados
        </Button>

        <Button variant="ghost" size="icon" aria-label="Limpar seleção" onClick={onClearSelection}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir {selectedCount} contato(s)</AlertDialogTitle>
            <AlertDialogDescription>
              Tem certeza que deseja excluir os {selectedCount} contato(s) selecionado(s)? Os
              negócios, conversas e atividades relacionados não são apagados.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmingDelete(false);
                onDelete();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
