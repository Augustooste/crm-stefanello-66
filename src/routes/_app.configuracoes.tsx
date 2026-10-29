import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { StepAmbiente } from "@/components/onboarding/StepAmbiente";
import { PageHeader } from "@/components/common/PageHeader";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCurrentProfile } from "@/lib/api/session";
import { AppearanceTab } from "@/components/settings/AppearanceTab";
import { CompanyTab } from "@/components/settings/CompanyTab";
import { BusinessProfileTab } from "@/components/settings/BusinessProfileTab";
import { StagesTab } from "@/components/settings/StagesTab";
import { TagsTab } from "@/components/settings/TagsTab";
import { TeamTab } from "@/components/settings/TeamTab";
import { PhoneSuppressionsTab } from "@/components/settings/PhoneSuppressionsTab";
import { PluginsTab } from "@/components/settings/PluginsTab";
import { NotificationsTab } from "@/components/settings/NotificationsTab";
import { AiSettingsTab } from "@/components/settings/AiSettingsTab";
import { ViewPrefsTab } from "@/components/settings/ViewPrefsTab";
import { ClientErrorsTab } from "@/components/settings/ClientErrorsTab";
import { IncidentsTab } from "@/components/settings/IncidentsTab";
import { DeveloperTab } from "@/components/settings/developer/DeveloperTab";
import { useCanManageDeveloper } from "@/lib/api/developer";

export const Route = createFileRoute("/_app/configuracoes")({
  head: () => ({
    meta: [
      { title: "Configurações" },
      {
        name: "description",
        content: "Preferências da conta, da empresa e do time no CRM IA.",
      },
      { property: "og:title", content: "Configurações" },
      {
        property: "og:description",
        content: "Preferências da conta, da empresa e do time no CRM IA.",
      },
      { property: "og:url", content: "https://aceleraflow.lovable.app/configuracoes" },
      { name: "twitter:title", content: "Configurações" },
      {
        name: "twitter:description",
        content: "Preferências da conta, da empresa e do time no CRM IA.",
      },
    ],
    links: [{ rel: "canonical", href: "https://aceleraflow.lovable.app/configuracoes" }],
  }),
  component: ConfiguracoesPage,
});

// Chaves válidas de aba — usadas para validar o hash da URL. Também é o
// destino de redirect das antigas rotas /assistente, /falhas-ia,
// /integracoes e /digest-semanal (ver beforeLoad de cada uma). As antigas
// abas Assistente/Falhas/Features foram consolidadas em uma
// única aba "ia" com sub-abas internas (ver AiSettingsTab).
const TAB_KEYS = [
  "aparencia",
  "notificacoes",
  "empresa",
  "perfil",
  "funil",
  "tags",
  "equipe",
  "ia",
  "visualizacao",
  "plugins",
  "desenvolvedores",
  "supressoes",
  "erros",
  "incidentes",
  "ambiente",
] as const;
type TabKey = (typeof TAB_KEYS)[number];

// Hashes legados (mantidos por retrocompat com links já espalhados pelo
// app) normalizados para a nova aba "ia" — o AiSettingsTab lê o hash bruto
// e escolhe a sub-aba correta.
const LEGACY_HASH_TO_TAB: Record<string, TabKey> = {
  assistente: "ia",
  "falhas-ia": "ia",
};

// Abas visíveis a qualquer usuário autenticado do tenant, não só admin
// (Aparência é preferência pessoal; Notificações replica a leitura liberada
// por RLS que a antiga rota /digest-semanal já tinha — só a escrita, dentro
// do próprio NotificationsTab, é admin-gated).
const ALWAYS_VISIBLE_TABS = new Set<TabKey>(["aparencia", "notificacoes"]);

function parseTabKey(rawHash: string): TabKey | null {
  const clean = rawHash.replace(/^#/, "");
  // Sub-hash da aba IA (ex.: "ia/falhas") → ainda é aba "ia".
  if (clean.startsWith("ia/")) return "ia";
  if (clean in LEGACY_HASH_TO_TAB) return LEGACY_HASH_TO_TAB[clean];
  return (TAB_KEYS as readonly string[]).includes(clean) ? (clean as TabKey) : null;
}

function ConfiguracoesPage() {
  const { data: profile, isLoading } = useCurrentProfile();
  const isAdmin = profile?.role === "admin";
  // Aba Desenvolvedores depende de `developer.manage` (não de is_admin); a defesa
  // real é o banco. Enquanto carrega, não decide: nem mostra nem trata o hash.
  const { allowed: canDeveloper, isLoading: developerLoading } = useCanManageDeveloper();
  // Começa em "aparencia" sempre (nunca confia no hash antes de saber se é
  // admin) — o efeito abaixo promove a aba certa assim que `isAdmin` está
  // resolvido, e só então (evita "vazar" aba admin pra quem não pode vê-la
  // caso o hash aponte, por exemplo, para #ia).
  const [tab, setTab] = useState<TabKey>("aparencia");
  // Lê o hash via `useRouterState` (reativo à navegação do TanStack Router),
  // não `window.location.hash` + evento `hashchange` nativo do browser --
  // <Link> navega via `history.pushState`, que NÃO dispara `hashchange`
  // (só back/forward ou atribuição direta a `location.hash` disparam). Sem
  // isso, um link entre abas desta mesma página (ex.: "falhas recentes" no
  // AiAssistantTab apontando pra #falhas-ia) mudaria a URL mas nunca trocaria
  // de aba -- confirmado quebrado em teste manual no browser real antes
  // desse fix (jsdom mascarava o bug porque dispatchEvent manual funciona).
  const routerHash = useRouterState({ select: (s) => s.location.hash });
  useEffect(() => {
    if (isLoading) return;
    const hashTab = parseTabKey(routerHash);
    if (hashTab === "desenvolvedores") {
      if (!developerLoading && canDeveloper) setTab(hashTab);
      return;
    }
    if (hashTab && (ALWAYS_VISIBLE_TABS.has(hashTab) || isAdmin)) {
      setTab(hashTab);
    }
  }, [routerHash, isLoading, isAdmin, canDeveloper, developerLoading]);

  return (
    <div className="col-span-12 flex flex-col gap-6">
      <PageHeader title="Configurações" description="Preferências e ajustes da empresa." />

      {isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        // Aparência é preferência por usuário → visível a todos; abas de
        // workspace ficam restritas a admin.
        <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)} className="w-full">
          <TabsList className="mb-4 flex h-auto w-full flex-wrap justify-start gap-1">
            <TabsTrigger value="aparencia">Aparência</TabsTrigger>
            <TabsTrigger value="notificacoes">Notificações</TabsTrigger>
            {isAdmin && (
              <>
                <TabsTrigger value="empresa">Empresa</TabsTrigger>
                <TabsTrigger value="perfil">Perfil do negócio</TabsTrigger>
                <TabsTrigger value="funil">Funil de vendas</TabsTrigger>
                <TabsTrigger value="tags">Etiquetas</TabsTrigger>
                <TabsTrigger value="equipe">Equipe</TabsTrigger>
                <TabsTrigger value="ia">IA</TabsTrigger>
                <TabsTrigger value="visualizacao">Visualização</TabsTrigger>
                <TabsTrigger value="plugins">Integrações e Plugins</TabsTrigger>
              </>
            )}
            {canDeveloper && <TabsTrigger value="desenvolvedores">Desenvolvedores</TabsTrigger>}
            {isAdmin && (
              <>
                <TabsTrigger value="supressoes">Supressões</TabsTrigger>
                <TabsTrigger value="erros">Erros do app</TabsTrigger>
                <TabsTrigger value="incidentes">Incidentes</TabsTrigger>
                <TabsTrigger value="ambiente">Ambiente</TabsTrigger>
              </>
            )}
          </TabsList>
          <TabsContent value="aparencia">
            <AppearanceTab />
          </TabsContent>
          <TabsContent value="notificacoes">
            <NotificationsTab />
          </TabsContent>
          {canDeveloper && (
            <TabsContent value="desenvolvedores">
              <DeveloperTab />
            </TabsContent>
          )}
          {isAdmin && (
            <>
              {/*
                Empresa e Perfil do negócio são as duas abas com formulário de
                texto livre: sem `forceMount` o Radix desmonta o painel inativo,
                o `useState` do formulário morre junto e a digitação some ao
                voltar. `forceMount` mantém o painel montado — mas o Radix então
                passa `hidden={false}` (só usa `hidden` quando o conteúdo NÃO
                está montado), então esconder é responsabilidade nossa. Tem que
                ser `display:none` (`hidden` do Tailwind), não `opacity`/
                `sr-only`: o Content carrega `tabIndex={0}` e só `display:none`
                o tira da ordem de tabulação.
                As demais abas ficam sem `forceMount` de propósito — montar as
                13 dispararia as queries de todas no primeiro load da página.
              */}
              <TabsContent value="empresa" forceMount className="data-[state=inactive]:hidden">
                <CompanyTab />
              </TabsContent>
              <TabsContent value="perfil" forceMount className="data-[state=inactive]:hidden">
                <BusinessProfileTab />
              </TabsContent>
              <TabsContent value="funil">
                <StagesTab />
              </TabsContent>
              <TabsContent value="tags">
                <TagsTab />
              </TabsContent>
              <TabsContent value="equipe">
                <TeamTab />
              </TabsContent>
              <TabsContent value="ia">
                <AiSettingsTab />
              </TabsContent>
              <TabsContent value="visualizacao">
                <ViewPrefsTab />
              </TabsContent>
              <TabsContent value="plugins">
                <PluginsTab />
              </TabsContent>
              <TabsContent value="supressoes">
                <PhoneSuppressionsTab />
              </TabsContent>
              <TabsContent value="erros">
                <ClientErrorsTab />
              </TabsContent>
              <TabsContent value="incidentes">
                <IncidentsTab />
              </TabsContent>
              {/* Diagnóstico do ambiente: mesma tela do passo 1 do wizard, sem
                  auto-configurar ao abrir — aqui a reconfiguração é sempre um
                  clique explícito do administrador. */}
              <TabsContent value="ambiente">
                <StepAmbiente auto={false} />
              </TabsContent>
            </>
          )}
        </Tabs>
      )}
    </div>
  );
}
