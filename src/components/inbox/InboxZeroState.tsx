import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface InboxZeroStateProps {
  /** Conversas abertas fora do período atual que "Ampliar período" revelaria. */
  hiddenByPeriod?: number;
  periodLabel?: string;
  onWidenPeriod?: () => void;
}

/**
 * Estado vazio do Modo Foco quando a fila (aguardando humano + atrasadas)
 * está esgotada. Adaptado do `InboxZeroState` do medflow (trivial, 23
 * linhas), com tokens do design system em vez de gradiente hex hardcoded.
 *
 * Fila vazia pode ser só o recorte de período escondendo conversas: nesse caso
 * não afirma "Tudo em dia" e oferece ampliar o período.
 */
export function InboxZeroState({
  hiddenByPeriod = 0,
  periodLabel = "",
  onWidenPeriod,
}: InboxZeroStateProps) {
  if (hiddenByPeriod > 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <h2 className="text-page-title font-semibold text-foreground">Fila vazia neste período</h2>
        <p className="mt-2 max-w-md text-body text-muted-foreground">
          {hiddenByPeriod}{" "}
          {hiddenByPeriod === 1
            ? "conversa aberta mais antiga está"
            : "conversas abertas mais antigas estão"}{" "}
          fora de &quot;{periodLabel}&quot; e podem estar aguardando resposta.
        </p>
        <Button className="mt-4" variant="secondary" onClick={onWidenPeriod}>
          Ampliar período
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-success/12 text-success">
        <CheckCircle2 className="h-10 w-10" aria-hidden="true" />
      </div>
      <h2 className="text-page-title font-semibold text-foreground">Tudo em dia!</h2>
      <p className="mt-2 max-w-md text-body text-muted-foreground">
        Nenhuma conversa aguardando humano ou atrasada agora. Aproveite o momento ou planeje o
        próximo passo.
      </p>
    </div>
  );
}
