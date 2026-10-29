import { AlertTriangle, TrendingUp } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EDGE_ALERT_WINDOW_MINUTES, useEdgeFunctionErrorAlerts } from "@/lib/api/edge-health";

function formatTime(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Banner de alerta de erros nas funções de background (Edge Functions),
 * alimentado pela telemetria em `system_events`. Silencioso quando não há
 * erros na janela. Só admins recebem dados (RLS + RPC fail-closed).
 */
export function EdgeFunctionAlertBanner() {
  const q = useEdgeFunctionErrorAlerts();
  const alerts = q.data ?? [];

  if (alerts.length === 0) return null;

  return (
    <Alert
      variant="destructive"
      role="alert"
      aria-live="polite"
      data-testid="edge-function-alert-banner"
    >
      <AlertTriangle className="h-4 w-4" aria-hidden />
      <AlertTitle>
        {alerts.length === 1
          ? "Uma função de background registrou erros"
          : `${alerts.length} funções de background registraram erros`}
      </AlertTitle>
      <AlertDescription className="space-y-3">
        <p className="text-caption text-muted-foreground">
          Erros registrados nos últimos {EDGE_ALERT_WINDOW_MINUTES} minutos.
        </p>
        <ul className="space-y-2">
          {alerts.map((a) => (
            <li key={a.function_name} className="min-w-0 space-y-1">
              <p className="flex flex-wrap items-center gap-2 text-sm">
                <strong className="break-all">{a.function_name}</strong>
                <span>
                  {a.errors_15m} {a.errors_15m === 1 ? "erro" : "erros"}
                </span>
                {a.spike && (
                  <Badge variant="destructive" className="whitespace-nowrap">
                    <TrendingUp className="mr-1 h-3 w-3" aria-hidden />
                    Aumento de erros
                  </Badge>
                )}
                <span className="text-caption text-muted-foreground">
                  último às {formatTime(a.last_at)}
                </span>
              </p>
              <p className="break-words text-caption text-muted-foreground">
                {a.last_error_code ? `${a.last_error_code}: ` : ""}
                {a.last_message ?? a.operation}
              </p>
            </li>
          ))}
        </ul>
        <div>
          <Button size="sm" variant="outline" onClick={() => q.refetch()} disabled={q.isFetching}>
            {q.isFetching ? "Verificando…" : "Verificar novamente"}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
