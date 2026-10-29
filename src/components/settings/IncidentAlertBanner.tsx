import { AlertTriangle, ArrowRight } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  INCIDENT_ALERT_WINDOW_HOURS,
  sortIncidentAlerts,
  useIncidentAlerts,
  type IncidentAlert,
} from "@/lib/api/incident-alerts";
import { INCIDENT_KIND_LABELS } from "@/lib/api/incidents";

/** Quantas linhas de alerta o banner mostra antes de resumir o resto. */
const MAX_VISIBLE = 3;

export type IncidentAlertBannerProps = {
  /** Abre os detalhes já filtrados pelo alerta clicado. */
  onOpenDetails?: (alert: IncidentAlert) => void;
};

/**
 * Banner de falhas recorrentes e erros críticos nas últimas 24h. Silencioso
 * quando não há nada acima do limiar. Só admin lê as fontes (RLS), então o
 * banner só rende para eles por definição.
 */
export function IncidentAlertBanner({ onOpenDetails }: IncidentAlertBannerProps) {
  const q = useIncidentAlerts();
  const alerts = sortIncidentAlerts(q.data ?? []);
  if (alerts.length === 0) return null;

  const hasCritical = alerts.some((a) => a.severity === "critical");
  const visible = alerts.slice(0, MAX_VISIBLE);
  const hidden = alerts.length - visible.length;

  return (
    <Alert variant={hasCritical ? "destructive" : "default"} role="alert">
      <AlertTriangle className="h-4 w-4" aria-hidden />
      <AlertTitle>
        {hasCritical ? "Erros críticos detectados" : "Falhas recorrentes detectadas"}
      </AlertTitle>
      <AlertDescription className="space-y-3">
        <p className="text-sm">
          {alerts.length} {alerts.length === 1 ? "situação" : "situações"} acima do limiar nas
          últimas {INCIDENT_ALERT_WINDOW_HOURS} horas.
        </p>
        <ul className="space-y-2">
          {visible.map((alert) => (
            <li
              key={`${alert.kind}:${alert.code}:${alert.scope}`}
              className="flex flex-wrap items-center gap-2 text-sm"
            >
              <Badge variant={alert.severity === "critical" ? "destructive" : "secondary"}>
                {alert.occurrences}× em 24h
              </Badge>
              <span className="text-muted-foreground">{INCIDENT_KIND_LABELS[alert.kind]}</span>
              <span className="font-medium break-all">{alert.code}</span>
              {alert.scope ? (
                <span className="text-muted-foreground break-all">· {alert.scope}</span>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                onClick={() => onOpenDetails?.(alert)}
              >
                Ver detalhes
                <ArrowRight className="ml-1 h-3.5 w-3.5" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
        {hidden > 0 ? (
          <p className="text-caption text-muted-foreground">
            e mais {hidden} {hidden === 1 ? "situação" : "situações"} na lista abaixo.
          </p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
