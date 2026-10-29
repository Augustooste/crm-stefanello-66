import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useAiInsightsFailureAlert } from "@/lib/api/insights-health";

/**
 * Banner exibido no topo de /relatorios quando o tenant registrou N ou mais
 * falhas de escrita da análise da IA na janela recente. Silencioso quando não
 * há incidentes — não ocupa espaço à toa. Só admins consultam a tabela (RLS),
 * então o banner só rende para eles por definição.
 */
export function AiInsightsHealthBanner() {
  const q = useAiInsightsFailureAlert();
  const data = q.data;

  if (!data || data.count < data.threshold) return null;

  return (
    <Alert variant="destructive" role="alert">
      <AlertTriangle className="h-4 w-4" aria-hidden />
      <AlertTitle>Falhas ao salvar análises da IA</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>
          Detectamos <strong>{data.count} falhas</strong> ao salvar análises da IA nos últimos{" "}
          {data.windowMinutes} minutos. Isso não afeta o relatório visível — a análise ainda é
          gerada —, mas o cache diário pode não estar sendo persistido. Se persistir por muito
          tempo, contate o suporte.
        </p>
        <div>
          <Button size="sm" variant="outline" onClick={() => q.refetch()} disabled={q.isFetching}>
            {q.isFetching ? "Verificando…" : "Verificar novamente"}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
