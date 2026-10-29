import { useMemo } from "react";
import { AlertCircle, CheckCircle2, Circle, Clock, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/common/StatusBadge";
import { relativeFromNow } from "@/lib/format";
import {
  useTenantIntegrations,
  useTenantChannels,
  type IntegrationStatus,
} from "@/lib/api/integrations";
import {
  isIntegrationHidden,
  useIntegrationsCatalog,
  type CatalogRow,
} from "@/components/integrations/IntegrationCard";
import { useTestIntegration } from "@/lib/api/integration-health";
import { friendlyIntegrationError } from "@/lib/integrations/friendly-errors";

/**
 * Tabela consolidada de status por integração. Renderiza apenas quando o
 * catálogo carrega. Cada linha resume:
 *  - status atual (tenant_integrations.status)
 *  - saúde do canal (channels.webhook_health)
 *  - horário da última verificação
 *  - mensagem de erro traduzida para instrução acionável (sem dados sensíveis)
 *  - botão "Testar conexão" (admin dispara revalidação imediata via edge)
 */
export function IntegrationStatusTable() {
  const catalogQ = useIntegrationsCatalog();
  const tenantQ = useTenantIntegrations();
  const channelsQ = useTenantChannels();
  const test = useTestIntegration();

  const rows = useMemo(() => {
    const catalog = catalogQ.data ?? [];
    const tenantBySlug = new Map((tenantQ.data ?? []).map((r) => [r.slug, r]));
    const channelBySlug = new Map((channelsQ.data ?? []).map((c) => [c.provider_slug, c]));
    return catalog
      .filter((c) => c.available && !isIntegrationHidden(c.slug))
      .map((cat: CatalogRow) => {
        const t = tenantBySlug.get(cat.slug) ?? null;
        const ch = channelBySlug.get(cat.slug) ?? null;
        return { cat, tenant: t, channel: ch };
      })
      .filter((r) => r.tenant); // só mostra o que já foi configurado alguma vez
  }, [catalogQ.data, tenantQ.data, channelsQ.data]);

  const loading = catalogQ.isLoading || tenantQ.isLoading || channelsQ.isLoading;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-card-title">Situação das integrações</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded-md bg-muted/40" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            Nenhuma integração configurada ainda. Conecte uma abaixo para começar.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-caption uppercase text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-2 pr-3 text-left font-medium">Integração</th>
                  <th className="py-2 pr-3 text-left font-medium">Situação</th>
                  <th className="py-2 pr-3 text-left font-medium">Última verificação</th>
                  <th className="py-2 pr-3 text-left font-medium">Detalhe</th>
                  <th className="py-2 text-right font-medium">Ação</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ cat, tenant, channel }) => {
                  const status = (tenant?.status ?? "disabled") as IntegrationStatus;
                  const isPendingTest = test.isPending && test.variables?.slug === cat.slug;
                  // Só mostramos detalhe de erro quando ainda há problema: com
                  // integração ativa e canal conectado, uma mensagem antiga do
                  // canal contradizia o selo "Ativa" na mesma linha.
                  const channelHealthy =
                    !channel ||
                    (channel.status === "connected" && channel.webhook_health !== "broken");

                  const rawError =
                    tenant?.last_error ??
                    (channelHealthy ? null : (channel?.status_message ?? null));
                  const friendly = rawError ? friendlyIntegrationError(cat.slug, rawError) : null;

                  return (
                    <tr key={cat.slug} className="border-b border-border/50 last:border-0">
                      <td className="py-3 pr-3">
                        <div className="flex items-center gap-2">
                          <StatusIcon status={status} />
                          <span className="font-medium text-foreground">{cat.name}</span>
                        </div>
                      </td>
                      <td className="py-3 pr-3">
                        <StatusBadge variant={badgeVariant(status)}>
                          {statusLabel(status)}
                        </StatusBadge>
                      </td>
                      <td className="py-3 pr-3 text-muted-foreground">
                        {tenant?.last_check_at ? (
                          <span className="inline-flex items-center gap-1">
                            <Clock className="h-3 w-3" aria-hidden />
                            {relativeFromNow(tenant.last_check_at)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-3 pr-3">
                        {friendly ? (
                          <span className="flex items-start gap-1 text-caption text-destructive">
                            <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                            {friendly.message}
                          </span>
                        ) : status === "active" ? (
                          <span className="text-caption text-muted-foreground">
                            Funcionando normalmente
                          </span>
                        ) : (
                          <span className="text-caption text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-3 text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={isPendingTest}
                          onClick={() =>
                            test.mutate(
                              { slug: cat.slug },
                              {
                                onSuccess: (res) =>
                                  res.ok
                                    ? toast.success(`${cat.name}: conexão OK.`)
                                    : toast.error(
                                        friendlyIntegrationError(cat.slug, res.error).message,
                                      ),
                                onError: (e) =>
                                  toast.error(
                                    friendlyIntegrationError(cat.slug, e.message).message,
                                  ),
                              },
                            )
                          }
                          aria-label={`Testar conexão de ${cat.name}`}
                        >
                          {isPendingTest ? (
                            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />
                          ) : (
                            <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden />
                          )}
                          Testar conexão
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StatusIcon({ status }: { status: IntegrationStatus }) {
  if (status === "active") return <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />;
  if (status === "error") return <AlertCircle className="h-4 w-4 text-destructive" aria-hidden />;
  if (status === "pending") return <Clock className="h-4 w-4 text-warning" aria-hidden />;
  return <Circle className="h-4 w-4 text-muted-foreground" aria-hidden />;
}

function badgeVariant(s: IntegrationStatus): "success" | "warning" | "destructive" | "neutral" {
  if (s === "active") return "success";
  if (s === "error") return "destructive";
  if (s === "pending") return "warning";
  return "neutral";
}

function statusLabel(s: IntegrationStatus): string {
  if (s === "active") return "Ativa";
  if (s === "error") return "Erro";
  if (s === "pending") return "Pendente";
  return "Desconectada";
}
