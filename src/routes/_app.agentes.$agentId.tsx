import { useEffect, useState } from "react";
import { createFileRoute, Link, useRouterState } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

import { PageHeader } from "@/components/common/PageHeader";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAgentPlatformQuery } from "@/lib/api/agent-platform";
import { AgentOverviewTab, AgentSessionStatusProvider } from "@/components/agents/AgentOverviewTab";
import { useAgentSessionStatus } from "@/components/agents/agent-session-status";
import { AgentProfileTab } from "@/components/agents/AgentProfileTab";
import { AgentSettingsTab } from "@/components/agents/AgentSettingsTab";
import { AgentTrainingsTab } from "@/components/agents/AgentTrainingsTab";
import { AgentIntentionsTab } from "@/components/agents/AgentIntentionsTab";
import { AgentIntegrationsTab } from "@/components/agents/AgentIntegrationsTab";
import { AgentChannelsTab } from "@/components/agents/AgentChannelsTab";
import { AgentWebhooksTab } from "@/components/agents/AgentWebhooksTab";
import { AgentPlaygroundTab } from "@/components/agents/AgentPlaygroundTab";
import { AgentAdvancedTab } from "@/components/agents/AgentAdvancedTab";

export const Route = createFileRoute("/_app/agentes/$agentId")({
  head: ({ params }) => {
    const url = `https://aceleraflow.lovable.app/agentes/${params.agentId}`;
    const title = "Agente";
    const description = "Perfil, treinamentos, canais e configurações do agente de IA.";
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        { property: "og:url", content: url },
        { name: "twitter:title", content: title },
        { name: "twitter:description", content: description },
        { name: "robots", content: "noindex" },
      ],
      links: [{ rel: "canonical", href: url }],
    };
  },
  component: AgentDetailPage,
});

// Chaves e rótulos na ordem definida pelo escopo (10 abas).
const TAB_KEYS = [
  "visao-geral",
  "perfil",
  "modelo",
  "treinamentos",
  "intencoes",
  "integracoes",
  "canais",
  "webhooks",
  "testar",
  "avancado",
] as const;
type TabKey = (typeof TAB_KEYS)[number];
const DEFAULT_TAB: TabKey = "visao-geral";

const TAB_LABELS: Record<TabKey, string> = {
  "visao-geral": "Visão geral",
  perfil: "Perfil",
  modelo: "Modelo e configurações",
  treinamentos: "Treinamentos",
  intencoes: "Intenções",
  integracoes: "Integrações",
  canais: "Canais",
  webhooks: "Webhooks",
  testar: "Testar agente",
  avancado: "Avançado",
};

function parseTabKey(rawHash: string): TabKey | null {
  const clean = rawHash.replace(/^#/, "");
  return (TAB_KEYS as readonly string[]).includes(clean) ? (clean as TabKey) : null;
}

function AgentDetailPage() {
  const { agentId } = Route.useParams();
  const [tab, setTab] = useState<TabKey>(DEFAULT_TAB);
  // Lê o hash via `useRouterState` (reativo à navegação do TanStack Router),
  // não `window.location.hash` + evento `hashchange` nativo do browser --
  // <Link> navega via `history.pushState`, que NÃO dispara `hashchange` (só
  // back/forward ou atribuição direta a `location.hash` disparam). Mesmo
  // padrão de `_app.configuracoes.tsx`.
  const routerHash = useRouterState({ select: (s) => s.location.hash });
  useEffect(() => {
    const hashTab = parseTabKey(routerHash);
    if (hashTab) setTab(hashTab);
  }, [routerHash]);

  return (
    // `key={agentId}` -- força remontar o Provider (e zerar o "último status
    // aplicado nesta sessão", ver D6 em AgentOverviewTab.tsx) ao navegar de
    // um agente para outro nesta mesma rota.
    <AgentSessionStatusProvider key={agentId}>
      <AgentDetailContent agentId={agentId} tab={tab} setTab={setTab} />
    </AgentSessionStatusProvider>
  );
}

function AgentDetailContent({
  agentId,
  tab,
  setTab,
}: {
  agentId: string;
  tab: TabKey;
  setTab: (tab: TabKey) => void;
}) {
  const agentQuery = useAgentPlatformQuery("agent.get", { params: { agentId } });
  const sessionStatus = useAgentSessionStatus();

  return (
    <div className="col-span-12 flex flex-col gap-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2">
          <Link to="/agentes">
            <ArrowLeft className="mr-1 h-4 w-4" /> Agentes
          </Link>
        </Button>
        <PageHeader
          title={
            agentQuery.isLoading ? (
              <Skeleton className="h-6 w-40" />
            ) : (
              agentQuery.data?.name || "Agente"
            )
          }
          actions={
            <StatusBadge
              variant={
                sessionStatus === "active"
                  ? "success"
                  : sessionStatus === "inactive"
                    ? "neutral"
                    : "outline"
              }
            >
              {sessionStatus === "active"
                ? "Ativado nesta sessão"
                : sessionStatus === "inactive"
                  ? "Inativado nesta sessão"
                  : "Sem alteração nesta sessão"}
            </StatusBadge>
          }
        />
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)} className="w-full">
        <TabsList className="mb-4 flex h-auto w-full flex-wrap justify-start gap-1">
          {TAB_KEYS.map((key) => (
            <TabsTrigger key={key} value={key}>
              {TAB_LABELS[key]}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="visao-geral">
          <AgentOverviewTab agentId={agentId} />
        </TabsContent>
        <TabsContent value="perfil">
          <AgentProfileTab agentId={agentId} />
        </TabsContent>
        <TabsContent value="modelo">
          <AgentSettingsTab agentId={agentId} />
        </TabsContent>
        <TabsContent value="treinamentos">
          <AgentTrainingsTab agentId={agentId} />
        </TabsContent>
        <TabsContent value="intencoes">
          <AgentIntentionsTab agentId={agentId} />
        </TabsContent>
        <TabsContent value="integracoes">
          <AgentIntegrationsTab agentId={agentId} />
        </TabsContent>
        <TabsContent value="canais">
          <AgentChannelsTab agentId={agentId} />
        </TabsContent>
        <TabsContent value="webhooks">
          <AgentWebhooksTab agentId={agentId} />
        </TabsContent>
        <TabsContent value="testar">
          <AgentPlaygroundTab agentId={agentId} />
        </TabsContent>
        <TabsContent value="avancado">
          <AgentAdvancedTab agentId={agentId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
