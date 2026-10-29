import { useEffect, useState } from "react";
import { useRouterState, useNavigate } from "@tanstack/react-router";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AiAssistantTab } from "./AiAssistantTab";
import { AiFailuresTab } from "./AiFailuresTab";
import { AiFeaturesTab } from "./AiFeaturesTab";
import { KnowledgeBaseTab } from "./KnowledgeBaseTab";

// Sub-abas da aba "IA" em Configurações. A aba raiz consolida as antigas
// abas Assistente/Falhas/Features em um único ponto de entrada.
// Hashes suportados na URL:
//   #ia                     → sub-aba padrão (assistente)
//   #ia/assistente          → Assistente
//   #ia/features            → Features
//   #ia/falhas              → Falhas
// Hashes legados (retrocompat com links já espalhados pelo app):
//   #assistente             → assistente
//   #falhas-ia              → falhas
// (o antigo hash "#ia" apontava para Features de IA; agora ele abre a aba
// raiz "IA" na sub-aba padrão — assistente. Mantivemos essa quebra
// intencional porque o novo default é o ponto de entrada mais usado.)
const SUB_TABS = ["assistente", "conhecimento", "features", "falhas"] as const;
type SubTab = (typeof SUB_TABS)[number];

const LEGACY_HASH_TO_SUB: Record<string, SubTab> = {
  assistente: "assistente",
  "falhas-ia": "falhas",
};

function parseSub(rawHash: string): SubTab {
  const clean = rawHash.replace(/^#/, "");
  if (clean.startsWith("ia/")) {
    const sub = clean.slice("ia/".length);
    if ((SUB_TABS as readonly string[]).includes(sub)) return sub as SubTab;
  }
  if (clean in LEGACY_HASH_TO_SUB) return LEGACY_HASH_TO_SUB[clean];
  return "assistente";
}

export function AiSettingsTab() {
  const routerHash = useRouterState({ select: (s) => s.location.hash });
  const [sub, setSub] = useState<SubTab>(() => parseSub(routerHash));
  const navigate = useNavigate();

  useEffect(() => {
    setSub(parseSub(routerHash));
  }, [routerHash]);

  return (
    <Tabs
      value={sub}
      onValueChange={(v) => {
        const next = v as SubTab;
        setSub(next);
        // Atualiza o hash para deep-link, sem empurrar novo estado quando
        // já está correto (evita histórico poluído).
        navigate({ to: "/configuracoes", hash: `ia/${next}`, replace: true });
      }}
      className="w-full"
    >
      <TabsList className="mb-4 flex h-auto w-full flex-wrap justify-start gap-1">
        <TabsTrigger value="assistente">Assistente</TabsTrigger>
        <TabsTrigger value="conhecimento">Conhecimento</TabsTrigger>
        <TabsTrigger value="features">Features</TabsTrigger>
        <TabsTrigger value="falhas">Falhas</TabsTrigger>
      </TabsList>
      <TabsContent value="assistente">
        <AiAssistantTab />
      </TabsContent>
      <TabsContent value="conhecimento">
        <KnowledgeBaseTab />
      </TabsContent>
      <TabsContent value="features">
        <AiFeaturesTab />
      </TabsContent>
      <TabsContent value="falhas">
        <AiFailuresTab />
      </TabsContent>
    </Tabs>
  );
}
