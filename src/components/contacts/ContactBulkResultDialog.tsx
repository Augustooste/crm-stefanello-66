import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ContactBulkActionReport } from "@/hooks/use-bulk-contact-actions";

interface ContactBulkResultDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Rótulo da ação executada (ex.: "aplicar etiqueta", "excluir") — usado no título. */
  actionLabel: string;
  report: ContactBulkActionReport | null;
  /** id -> nome, para mostrar qual contato falhou em vez de só o id. */
  namesById: Record<string, string | undefined>;
}

/**
 * Relatório de uma operação em lote: quantos sucessos, quantos falharam, e
 * o motivo de cada falha — mesmo padrão visual do relatório de import CSV
 * (`ContactImportDialog`), nunca mascara erro atrás de um toast genérico.
 */
export function ContactBulkResultDialog({
  open,
  onOpenChange,
  actionLabel,
  report,
  namesById,
}: ContactBulkResultDialogProps) {
  if (!report) return null;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Resultado — {actionLabel}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 text-center">
                <div className="rounded-md border border-border p-3">
                  <p className="text-h3 font-semibold text-foreground">{report.sucesso}</p>
                  <p className="text-caption text-muted-foreground">Sucesso</p>
                </div>
                <div className="rounded-md border border-border p-3">
                  <p className="text-h3 font-semibold text-foreground">{report.falhas}</p>
                  <p className="text-caption text-muted-foreground">Falha</p>
                </div>
              </div>

              {report.erros.length > 0 && (
                <div>
                  <p className="mb-1 text-caption font-medium text-destructive">
                    {report.erros.length} contato(s) com erro
                  </p>
                  <ScrollArea className="h-40 rounded-md border border-border p-2">
                    <ul className="space-y-1 text-caption text-muted-foreground">
                      {report.erros.map((err) => (
                        <li key={err.id}>
                          {namesById[err.id] ?? err.id}: {err.motivo}
                        </li>
                      ))}
                    </ul>
                  </ScrollArea>
                </div>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction onClick={() => onOpenChange(false)}>Fechar</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
