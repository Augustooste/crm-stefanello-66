import { Building2, Check, ChevronsUpDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSwitchWorkspace, useWorkspaces } from "@/lib/api/workspaces";

export function WorkspaceSwitcher() {
  // `isPending`, não `isLoading`: antes de a sessão ficar pronta a consulta está
  // desabilitada (pendente, sem buscar) e `isLoading` é false — mostraria a marca
  // padrão do produto no lugar do nome do workspace.
  const { data: workspaces = [], isPending } = useWorkspaces();
  const switchWorkspace = useSwitchWorkspace();
  const active = workspaces.find((workspace) => workspace.is_active) ?? workspaces[0];

  if (isPending || !active) {
    return (
      <span
        className="max-w-32 truncate text-body font-semibold text-foreground sm:max-w-48"
        aria-live="polite"
        aria-busy={isPending || undefined}
      >
        {isPending ? "Carregando…" : "CRM IA"}
      </span>
    );
  }
  if (workspaces.length === 1) {
    return (
      <span
        className="max-w-32 truncate text-body font-semibold text-foreground sm:max-w-48"
        title={active.tenant_name}
      >
        {active.tenant_name}
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Trocar empresa"
        className="flex h-9 min-w-0 items-center gap-2 rounded-md px-2 text-body font-semibold text-foreground hover:bg-muted"
      >
        <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="max-w-40 truncate">{active.tenant_name}</span>
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {workspaces.map((workspace) => (
          <DropdownMenuItem
            key={workspace.tenant_id}
            disabled={switchWorkspace.isPending || workspace.is_active}
            onClick={() => switchWorkspace.mutate(workspace.tenant_id)}
          >
            <span className="flex-1 truncate">{workspace.tenant_name}</span>
            <span className="text-caption text-muted-foreground">{workspace.role_key}</span>
            {workspace.is_active && <Check className="ml-2 h-4 w-4" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
