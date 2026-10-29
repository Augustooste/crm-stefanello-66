import { Copy, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Mostra um segredo (token de API ou segredo de webhook) uma única vez.
 * `secret` vem de `mutation.data`; quem usa abre com `open={!!secret}` e, em
 * `onClose`, chama `reset()` da mutation para que o valor deixe de existir.
 */
export function SecretRevealDialog({
  open,
  title,
  description,
  secretLabel,
  copyLabel,
  closeLabel,
  secret,
  usage,
  onClose,
}: {
  open: boolean;
  title: string;
  description: string;
  secretLabel: string;
  copyLabel: string;
  closeLabel: string;
  secret: string | undefined;
  usage?: React.ReactNode;
  onClose: () => void;
}) {
  const copy = async () => {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      toast.success("Copiado para a área de transferência.");
    } catch {
      toast.error("Não foi possível copiar. Selecione o texto e copie manualmente.");
    }
  };

  return (
    <Dialog open={open && !!secret} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="grid-cols-[minmax(0,1fr)]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Alert>
          <TriangleAlert className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Guarde agora</AlertTitle>
          <AlertDescription>
            Este valor não será mostrado novamente. Se perder, será preciso gerar outro.
          </AlertDescription>
        </Alert>
        <div className="flex flex-col gap-2">
          <span className="text-caption font-medium text-muted-foreground">{secretLabel}</span>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-md border border-border bg-muted px-3 py-2 font-mono text-body text-foreground">
              {secret}
            </code>
            <Button type="button" variant="secondary" onClick={copy}>
              <Copy className="mr-2 h-4 w-4" aria-hidden="true" />
              {copyLabel}
            </Button>
          </div>
        </div>
        {usage && <div className="text-body text-muted-foreground">{usage}</div>}
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {closeLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
