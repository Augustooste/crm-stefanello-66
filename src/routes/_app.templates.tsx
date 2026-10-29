import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { requireAdmin } from "@/lib/api/session";
import { TemplatesTab } from "@/components/marketing/TemplatesTab";
import { AgendamentosTab } from "@/components/marketing/AgendamentosTab";

export const Route = createFileRoute("/_app/templates")({
  beforeLoad: ({ context }) => requireAdmin(context.queryClient),
  head: () => ({
    meta: [
      { title: "Campanhas" },
      {
        name: "description",
        content:
          "Campanhas de reativação, recuperação, nutrição e recompra, e os modelos de mensagem aprovados.",
      },
      { property: "og:title", content: "Campanhas" },
      {
        property: "og:description",
        content:
          "Campanhas de reativação, recuperação, nutrição e recompra, e os modelos de mensagem aprovados.",
      },
      { property: "og:url", content: "https://aceleraflow.lovable.app/templates" },
      { name: "twitter:title", content: "Campanhas" },
      {
        name: "twitter:description",
        content:
          "Campanhas de reativação, recuperação, nutrição e recompra, e os modelos de mensagem aprovados.",
      },
    ],
    links: [{ rel: "canonical", href: "https://aceleraflow.lovable.app/templates" }],
  }),
  component: CampanhasPage,
});

// Chaves válidas de aba — usadas para validar o hash da URL (mesmo padrão
// de /configuracoes). "agendamentos" é alias de "campanhas": o redirect da
// antiga rota /agendamentos aponta pra /templates#agendamentos.
const TAB_KEYS = ["campanhas", "modelos"] as const;
type TabKey = (typeof TAB_KEYS)[number];
const TAB_ALIASES: Record<string, TabKey> = { agendamentos: "campanhas" };

function parseTabKey(rawHash: string): TabKey | null {
  const clean = rawHash.replace(/^#/, "");
  if (clean in TAB_ALIASES) return TAB_ALIASES[clean];
  return (TAB_KEYS as readonly string[]).includes(clean) ? (clean as TabKey) : null;
}

function CampanhasPage() {
  const [tab, setTab] = useState<TabKey>("campanhas");
  // useRouterState (não window.location.hash + evento `hashchange` nativo) --
  // <Link>/redirect() navegam via `history.pushState`, que não dispara
  // `hashchange`. Ver comentário equivalente em _app.configuracoes.tsx.
  const routerHash = useRouterState({ select: (s) => s.location.hash });
  useEffect(() => {
    const hashTab = parseTabKey(routerHash);
    if (hashTab) setTab(hashTab);
  }, [routerHash]);

  return (
    <div className="col-span-12 flex flex-col gap-4">
      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)} className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="campanhas">Campanhas</TabsTrigger>
          <TabsTrigger value="modelos">Modelos</TabsTrigger>
        </TabsList>
        <TabsContent value="campanhas">
          <AgendamentosTab />
        </TabsContent>
        <TabsContent value="modelos">
          <TemplatesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
