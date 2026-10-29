import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertCircle, Puzzle } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useActivePlugins, useTogglePlugin } from "@/lib/api/plugins";
import {
  useTenantIntegrations,
  useTenantChannels,
  type TenantIntegrationRow,
  type ChannelRow,
} from "@/lib/api/integrations";
import {
  IntegrationCard,
  useVisibleIntegrationsCatalog,
} from "@/components/integrations/IntegrationCard";
import { IntegrationHealthBanner } from "@/components/integrations/IntegrationHealthBanner";
import { IntegrationStatusTable } from "@/components/integrations/IntegrationStatusTable";
// ApifyCostsCard: fora do MVP (2026-07-27) — a integração Apify está oculta,
// então o dashboard de custos dela não é renderizado. Componente preservado.
import { EdgeFunctionAlertBanner } from "@/components/monitoring/EdgeFunctionAlertBanner";
import { userFacingErrorMessage } from "@/lib/integrations/friendly-errors";
import { SimulatorChannelCard } from "@/components/inbox/SimulatorChannelCard";

// Catálogo desta fase (Fase 6, Sub-feature 0) -- feature-flag de UI que só
// controla visibilidade de nav/rota, NUNCA a mesma coisa que
// `integrations`/`tenant_integrations` (conexão com serviço externo). Um
// niche_template já vem com alguns destes pré-ativados por padrão; o switch
// aqui grava a exceção por tenant (business_profile.plugin_overrides).
const PLUGIN_CATALOG: { slug: string; label: string }[] = [
  { slug: "agenda", label: "Agenda" },
  { slug: "catalogo", label: "Catálogo (produtos/serviços)" },
  // feegow, doutore e meta-ads: ocultos por ora (decisão de produto — fora
  // de uso). Backend e niche_templates default intactos; reexibir = remover
  // o comentário da linha correspondente.
  // { slug: "doutore", label: "doutore (leads)" },
  // { slug: "meta-ads", label: "Meta Ads (leads)" },
];

/**
 * Fundido com a antiga rota /integracoes (canais de mensagem/ferramentas
 * externas) -- as duas são a mesma família conceitual (ligar/desligar
 * capacidade), só a granularidade difere (flag de UI vs. conexão real com
 * serviço externo). Rota antiga vira redirect (ver _app.integracoes.tsx).
 */
export function PluginsTab() {
  const [requestedIntegrationSlug, setRequestedIntegrationSlug] = useState<string | null>(null);

  const openIntegrationFromAlert = (slug: string) => {
    setRequestedIntegrationSlug(slug);
    window.setTimeout(() => {
      document
        .getElementById("integrations-section")
        ?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    }, 0);
  };

  return (
    <div className="flex flex-col gap-6">
      <IntegrationHealthBanner onOpenIntegration={openIntegrationFromAlert} />
      <EdgeFunctionAlertBanner />
      <NichePluginsCard />
      <IntegrationStatusTable />
      <IntegrationsCard
        requestedIntegrationSlug={requestedIntegrationSlug}
        onOpenRequestHandled={() => setRequestedIntegrationSlug(null)}
      />
    </div>
  );
}

function NichePluginsCard() {
  const activePlugins = useActivePlugins();
  const toggle = useTogglePlugin();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-card-title">
          <Puzzle className="h-4 w-4" aria-hidden />
          Plugins do nicho
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        <ul className="divide-y divide-border">
          {PLUGIN_CATALOG.map((plugin) => {
            const active = activePlugins.includes(plugin.slug);
            return (
              <li key={plugin.slug} className="flex items-center justify-between gap-4 py-3">
                <Label htmlFor={`plugin-${plugin.slug}`}>{plugin.label}</Label>
                <Switch
                  id={`plugin-${plugin.slug}`}
                  checked={active}
                  disabled={toggle.isPending}
                  onCheckedChange={(checked) =>
                    toggle.mutate(
                      { slug: plugin.slug, active: checked },
                      {
                        onSuccess: () =>
                          toast.success(
                            checked ? `${plugin.label} ativado` : `${plugin.label} desativado`,
                          ),
                        onError: (e: Error) =>
                          toast.error(userFacingErrorMessage(e, "Erro ao atualizar plugin")),
                      },
                    )
                  }
                />
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function IntegrationsCard({
  requestedIntegrationSlug,
  onOpenRequestHandled,
}: {
  requestedIntegrationSlug: string | null;
  onOpenRequestHandled: () => void;
}) {
  const catalogQ = useVisibleIntegrationsCatalog();
  const tenantQ = useTenantIntegrations();
  const channelsQ = useTenantChannels();
  const isLoading = catalogQ.isLoading || tenantQ.isLoading || channelsQ.isLoading;

  useEffect(() => {
    if (!requestedIntegrationSlug || isLoading) return;
    if (catalogQ.error) {
      toast.error("Não foi possível carregar as integrações. Tente novamente em instantes.");
      onOpenRequestHandled();
      return;
    }
    const exists = (catalogQ.data ?? []).some((it) => it.slug === requestedIntegrationSlug);
    if (!exists) {
      toast.error("Integração não encontrada ou indisponível nesta tela.");
      onOpenRequestHandled();
    }
  }, [catalogQ.data, catalogQ.error, isLoading, onOpenRequestHandled, requestedIntegrationSlug]);

  const byslug = useMemo(() => {
    const m = new Map<string, TenantIntegrationRow>();
    (tenantQ.data ?? []).forEach((r) => m.set(r.slug, r));
    return m;
  }, [tenantQ.data]);

  // channels é keyed por provider_slug, que espelha catalog.slug/tenant_integrations.slug.
  const channelBySlug = useMemo(() => {
    const m = new Map<string, ChannelRow>();
    (channelsQ.data ?? []).forEach((c) => m.set(c.provider_slug, c));
    return m;
  }, [channelsQ.data]);

  return (
    <Card id="integrations-section" className="scroll-mt-24">
      <CardHeader>
        <CardTitle className="text-card-title">Canais e integrações</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2, 3].map((i) => (
              <Card key={i} className="h-52 animate-pulse bg-muted/40" />
            ))}
          </div>
        ) : catalogQ.error ? (
          <Card>
            <CardContent className="flex items-center gap-2 py-6 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              Não foi possível carregar as integrações.
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {(catalogQ.data ?? []).map((it) =>
              it.slug === "simulator" ? (
                <SimulatorChannelCard
                  key={it.slug}
                  connected={channelBySlug.get(it.slug)?.status === "connected"}
                />
              ) : (
                <IntegrationCard
                  key={it.slug}
                  catalog={it}
                  tenant={byslug.get(it.slug) ?? null}
                  channel={channelBySlug.get(it.slug) ?? null}
                  openRequested={requestedIntegrationSlug === it.slug}
                  onOpenRequestHandled={onOpenRequestHandled}
                />
              ),
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
