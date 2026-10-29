import { LayoutDashboard, List, Target } from "lucide-react";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type InboxMode = "geral" | "lista" | "foco";

/**
 * Abas de modo da inbox (Visão geral / Lista / Foco). Reusa o `Tabs` do
 * shadcn (já usado em `_app.atividades.tsx`) em vez de um toggle customizado
 * — mesmo papel do `ViewModeToggle` do medflow, componente shadcn padrão.
 */
export function InboxModeTabs({
  mode,
  onChange,
}: {
  mode: InboxMode;
  onChange: (mode: InboxMode) => void;
}) {
  return (
    <Tabs value={mode} onValueChange={(v) => onChange(v as InboxMode)}>
      <TabsList>
        <TabsTrigger value="geral" className="gap-1.5">
          <LayoutDashboard className="h-3.5 w-3.5" aria-hidden="true" />
          Visão geral
        </TabsTrigger>
        <TabsTrigger value="lista" className="gap-1.5">
          <List className="h-3.5 w-3.5" aria-hidden="true" />
          Lista
        </TabsTrigger>
        <TabsTrigger value="foco" className="gap-1.5">
          <Target className="h-3.5 w-3.5" aria-hidden="true" />
          Foco
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
