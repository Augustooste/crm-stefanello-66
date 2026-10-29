import { AlertTriangle, ExternalLink, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useIntegrationHealthAlerts, useTestIntegration } from "@/lib/api/integration-health";
import { friendlyIntegrationError, remediationHint } from "@/lib/integrations/friendly-errors";
import { isIntegrationHidden } from "@/components/integrations/IntegrationCard";

/**
 * Banner exibido no topo da aba "Integrações e Plugins" (e opcionalmente
 * em outras telas — ex.: Inbox) sempre que houver integrações inativas por
 * erro repetido. Silencioso quando não há alertas.
 *
 * O componente NÃO exibe segredos: cada alerta passa por friendlyIntegrationError,
 * que trata o texto como não-confiável mesmo já vindo redigido do backend.
 */
export function IntegrationHealthBanner({
  /** Se preenchido, filtra alertas para provedores desse conjunto (ex.: canais de mensagem no inbox). */
  slugs,
  /** Abre o card/modal da integração correspondente quando o banner está dentro da tela de configurações. */
  onOpenIntegration,
}: {
  slugs?: string[];
  onOpenIntegration?: (slug: string) => void;
} = {}) {
  const q = useIntegrationHealthAlerts();
  const test = useTestIntegration();
  const alerts = (q.data ?? []).filter(
    (a) => !isIntegrationHidden(a.slug) && (!slugs || slugs.includes(a.slug)),
  );

  if (alerts.length === 0) return null;

  return (
    <Alert
      variant="destructive"
      role="alert"
      aria-live="polite"
      data-testid="integration-health-banner"
    >
      <AlertTriangle className="h-4 w-4" aria-hidden />
      <AlertTitle>
        {alerts.length === 1
          ? "Uma integração precisa da sua atenção"
          : `${alerts.length} integrações precisam da sua atenção`}
      </AlertTitle>
      <AlertDescription className="space-y-3">
        <ul className="space-y-3">
          {alerts.map((a) => {
            const friendly = friendlyIntegrationError(a.slug, a.human_message);
            const remediation = remediationHint(a.slug, a.reason_code);
            return (
              <li key={`${a.slug}-${a.reason_code}`} className="space-y-1">
                <p className="text-sm">
                  <strong className="capitalize">{a.slug}</strong>: {friendly.message}
                </p>
                <p className="text-caption text-muted-foreground">{remediation}</p>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={test.isPending}
                    onClick={() =>
                      test.mutate(
                        { slug: a.slug },
                        {
                          onSuccess: (res) =>
                            res.ok
                              ? toast.success(`${a.slug}: conexão OK.`)
                              : toast.error(friendlyIntegrationError(a.slug, res.error).message),
                          onError: (e) =>
                            toast.error(friendlyIntegrationError(a.slug, e.message).message),
                        },
                      )
                    }
                  >
                    <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden />
                    Testar conexão
                  </Button>
                  {onOpenIntegration && (
                    <Button
                      size="sm"
                      variant="ghost"
                      type="button"
                      onClick={() => onOpenIntegration(a.slug)}
                      aria-label={`Abrir integração ${a.slug}`}
                    >
                      <ExternalLink className="mr-1 h-3.5 w-3.5" aria-hidden />
                      Abrir integração
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
