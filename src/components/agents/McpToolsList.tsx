// Ferramentas de uma conexão MCP: listar, sincronizar, ativar e inativar.
//
// ATENÇÃO: mcp.tools.sync, mcp.tool.activate e mcp.tool.deactivate são GET
// que MUDAM estado no provedor (contracts/agent-platform/CONTRACT_MATRIX.md
// §1.6, divergência D12) — por isso as três usam useAgentPlatformMutation, nunca
// useAgentPlatformQuery com refetch automático. Sem optimistic update: o switch
// só reflete o novo estado depois que o servidor confirma e a lista é
// invalidada.
import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/common/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Switch } from "@/components/ui/switch";
import { useAgentPlatformMutation, useAgentPlatformQuery } from "@/lib/api/agent-platform";

export function McpToolsList({ agentId, mcpId }: { agentId: string; mcpId: string }) {
  const [busyToolId, setBusyToolId] = useState<string | null>(null);

  const toolsQ = useAgentPlatformQuery(
    "mcp.tools.list",
    { params: { agentId, mcpId } },
    { enabled: !!agentId && !!mcpId },
  );

  const syncMut = useAgentPlatformMutation("mcp.tools.sync", {
    invalidate: ["mcp.tools.list"],
    onSuccess: () => toast.success("Ferramentas sincronizadas."),
    onError: (error) => toast.error(error.message),
  });
  const activateMut = useAgentPlatformMutation("mcp.tool.activate", {
    invalidate: ["mcp.tools.list"],
    onSuccess: () => toast.success("Ferramenta ativada."),
    onError: (error) => toast.error(error.message),
  });
  const deactivateMut = useAgentPlatformMutation("mcp.tool.deactivate", {
    invalidate: ["mcp.tools.list"],
    onSuccess: () => toast.success("Ferramenta inativada."),
    onError: (error) => toast.error(error.message),
  });

  function handleToggle(toolId: string, nextActive: boolean) {
    setBusyToolId(toolId);
    const mutation = nextActive ? activateMut : deactivateMut;
    mutation.mutate(
      { params: { agentId, mcpId, toolId } },
      { onSettled: () => setBusyToolId(null) },
    );
  }

  if (toolsQ.isLoading) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (toolsQ.isError) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Erro ao carregar as ferramentas do MCP"
        description={toolsQ.error.message}
        actionLabel="Tentar de novo"
        onAction={() => toolsQ.refetch()}
      />
    );
  }

  const tools = toolsQ.data ?? [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="font-medium text-foreground">Ferramentas ({tools.length})</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => syncMut.mutate({ params: { agentId, mcpId } })}
          disabled={syncMut.isPending}
        >
          <RefreshCw
            className={`mr-1.5 h-3.5 w-3.5 ${syncMut.isPending ? "animate-spin" : ""}`}
            aria-hidden
          />
          Sincronizar
        </Button>
      </div>

      {tools.length === 0 ? (
        <EmptyState
          title="Nenhuma ferramenta encontrada"
          description="Sincronize para buscar as ferramentas expostas por este MCP."
        />
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {tools.map((tool, index) => {
            const toolId = tool.id ?? "";
            const isBusy = busyToolId === toolId;
            const isActive = !!tool.active;
            return (
              <li
                key={toolId || `${tool.name ?? "ferramenta"}-${index}`}
                className="flex items-center justify-between gap-3 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">{tool.name ?? "Sem nome"}</p>
                  {tool.description && (
                    <p className="truncate text-caption text-muted-foreground">
                      {tool.description}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusBadge variant={isActive ? "success" : "neutral"}>
                    {isActive ? "Ativa" : "Inativa"}
                  </StatusBadge>
                  <Switch
                    aria-label={
                      isActive
                        ? `Inativar ${tool.name ?? "ferramenta"}`
                        : `Ativar ${tool.name ?? "ferramenta"}`
                    }
                    checked={isActive}
                    disabled={isBusy || !toolId}
                    onCheckedChange={(checked) => {
                      if (!toolId) return;
                      handleToggle(toolId, checked);
                    }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
