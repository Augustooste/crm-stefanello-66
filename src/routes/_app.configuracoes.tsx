import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { PageHeader } from "@/components/common/PageHeader";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { requireAdmin, useCurrentProfile } from "@/lib/api/session";
import { AppearanceTab } from "@/components/settings/AppearanceTab";
import { CompanyTab } from "@/components/settings/CompanyTab";
import { StagesTab } from "@/components/settings/StagesTab";
import { TagsTab } from "@/components/settings/TagsTab";
import { TeamTab } from "@/components/settings/TeamTab";
import { NotificationsTab } from "@/components/settings/NotificationsTab";

export const Route = createFileRoute("/_app/configuracoes")({
  beforeLoad: ({ context }) => requireAdmin(context.queryClient),
  head: () => ({
    meta: [
      { title: "Configurações — Laticínio Stefanello" },
      { name: "description", content: "Preferências da conta, da empresa e do time no Laticínio Stefanello." },
      { property: "og:title", content: "Configurações — Laticínio Stefanello" },
      { property: "og:description", content: "Preferências da conta, da empresa e do time no Laticínio Stefanello." },
      { property: "og:url", content: "https://crmstefanello.lovable.app/configuracoes" },
      { name: "twitter:title", content: "Configurações — Laticínio Stefanello" },
      { name: "twitter:description", content: "Preferências da conta, da empresa e do time no Laticínio Stefanello." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://crmstefanello.lovable.app/configuracoes" }],
  }),
  component: ConfiguracoesPage,
});

// Catálogo único: troque `visible` para religar uma aba sem recriar sua rota ou tela.
const SETTINGS_TABS = [
  { key: "empresa", label: "Empresa", visible: true },
  { key: "funil", label: "Funil de vendas", visible: true },
  { key: "tags", label: "Etiquetas", visible: true },
  { key: "equipe", label: "Equipe", visible: true },
  { key: "aparencia", label: "Aparência", visible: true },
  { key: "notificacoes", label: "Notificações", visible: true },
  { key: "perfil", label: "Perfil do negócio", visible: false },
  { key: "ia", label: "IA", visible: false },
  { key: "plugins", label: "Integrações e Plugins", visible: false },
  { key: "visualizacao", label: "Visualização", visible: false },
  { key: "desenvolvedores", label: "Desenvolvedores", visible: false },
  { key: "supressoes", label: "Supressões", visible: false },
  { key: "erros", label: "Erros do app", visible: false },
  { key: "incidentes", label: "Incidentes", visible: false },
  { key: "ambiente", label: "Ambiente", visible: false },
] as const;

type TabKey = (typeof SETTINGS_TABS)[number]["key"];
const VISIBLE_TABS = SETTINGS_TABS.filter((tab) => tab.visible);
const VISIBLE_TAB_KEYS = new Set<string>(VISIBLE_TABS.map((tab) => tab.key));

function parseTabKey(rawHash: string): TabKey | null {
  const clean = rawHash.replace(/^#/, "");
  return VISIBLE_TAB_KEYS.has(clean) ? (clean as TabKey) : null;
}

function ConfiguracoesPage() {
  const { isLoading } = useCurrentProfile();
  const [tab, setTab] = useState<TabKey>("aparencia");
  const routerHash = useRouterState({ select: (state) => state.location.hash });

  useEffect(() => {
    if (isLoading) return;
    const hashTab = parseTabKey(routerHash);
    if (hashTab) setTab(hashTab);
  }, [routerHash, isLoading]);

  return (
    <div className="col-span-12 flex flex-col gap-6">
      <PageHeader title="Configurações" description="Preferências e ajustes da empresa." />
      {isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <Tabs value={tab} onValueChange={(value) => setTab(value as TabKey)} className="w-full">
          <TabsList className="mb-4 flex h-auto w-full flex-wrap justify-start gap-1">
            {VISIBLE_TABS.map((item) => (
              <TabsTrigger key={item.key} value={item.key}>{item.label}</TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="empresa" forceMount className="data-[state=inactive]:hidden">
            <CompanyTab />
          </TabsContent>
          <TabsContent value="funil"><StagesTab /></TabsContent>
          <TabsContent value="tags"><TagsTab /></TabsContent>
          <TabsContent value="equipe"><TeamTab /></TabsContent>
          <TabsContent value="aparencia"><AppearanceTab /></TabsContent>
          <TabsContent value="notificacoes"><NotificationsTab /></TabsContent>
        </Tabs>
      )}
    </div>
  );
}
