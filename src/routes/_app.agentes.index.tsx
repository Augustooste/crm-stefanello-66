import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Bot, Plus, RefreshCw, Search } from "lucide-react";

import { PageHeader } from "@/components/common/PageHeader";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { AgentCreateWizard } from "@/components/agents/AgentCreateWizard";
import { AgentPlatformNotConnected } from "@/components/agents/AgentPlatformNotConnected";
import { AGENT_TYPE_LABELS, COMMUNICATION_TYPE_LABELS } from "@/components/agents/agent-labels";
import { useAgentPlatformConnection, useAgentPlatformQuery } from "@/lib/api/agent-platform";
import type { AgentPlatformAgent } from "@/lib/api/agent-platform-contract";

export const Route = createFileRoute("/_app/agentes/")({
  head: () => ({
    meta: [
      { title: "Agentes de IA" },
      {
        name: "description",
        content:
          "Agentes do provedor de agentes conectados a esta empresa: perfil, treinamentos e canais.",
      },
      { property: "og:title", content: "Agentes de IA" },
      {
        property: "og:description",
        content:
          "Agentes do provedor de agentes conectados a esta empresa: perfil, treinamentos e canais.",
      },
      { property: "og:url", content: "https://aceleraflow.lovable.app/agentes" },
      { name: "twitter:title", content: "Agentes de IA" },
      {
        name: "twitter:description",
        content:
          "Agentes do provedor de agentes conectados a esta empresa: perfil, treinamentos e canais.",
      },
    ],
  }),
  component: AgentesPage,
});

const PAGE_SIZE = 25;
// Busca debounced -- evita 1 chamada ao proxy por tecla digitada (o
// contrato do provedor de agentes tem RATE_LIMITED).
const SEARCH_DEBOUNCE_MS = 300;

function AgentesPage() {
  const connection = useAgentPlatformConnection();
  const [openWizard, setOpenWizard] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [committedQuery, setCommittedQuery] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    // Só agenda o debounce quando a busca realmente mudou. Sem esta guarda, o
    // timer agendado no mount (busca vazia) continua pendente — `searchInput`
    // não muda, então o efeito não re-roda e o cleanup não dispara — e 300 ms
    // depois chama `setPage(1)`, jogando de volta pra página 1 quem clicou em
    // "Próxima" nesse intervalo. Era esse o flake da suíte sob contenção de CPU.
    const next = searchInput.trim();
    if (next === committedQuery) return;

    const handle = setTimeout(() => {
      setCommittedQuery(next);
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput, committedQuery]);

  const isConnected = connection.data?.status === "active";

  const agentsQuery = useAgentPlatformQuery(
    "agents.list",
    { params: { page, pageSize: PAGE_SIZE, query: committedQuery || undefined } },
    { enabled: isConnected },
  );

  if (connection.isPending) {
    return (
      <div className="col-span-12 flex flex-col gap-4">
        <PageHeader title="Agentes de IA" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!isConnected) {
    return <AgentPlatformNotConnected />;
  }

  // `agents.list` devolve um array simples de agentes -- o contrato não tem
  // total/contagem de páginas (D contrato: filtro por `page`/`pageSize`
  // existe, mas a resposta não expõe quantas páginas há). "Próxima" é uma
  // heurística: só habilita quando a página veio cheia.
  const agents = (agentsQuery.data ?? []).filter(
    (agent): agent is AgentPlatformAgent & { id: string } => typeof agent.id === "string",
  );
  const hasNextPage = agents.length === PAGE_SIZE;

  function clearSearch() {
    setSearchInput("");
    setCommittedQuery("");
    setPage(1);
  }

  return (
    <div className="col-span-12 flex flex-col gap-4">
      <PageHeader
        title="Agentes de IA"
        description="Agentes do provedor de agentes conectados a esta empresa."
        actions={
          <>
            <Button variant="secondary" onClick={() => void agentsQuery.refetch()}>
              <RefreshCw className="mr-1 h-4 w-4" />
              Sincronizar
            </Button>
            <Button onClick={() => setOpenWizard(true)}>
              <Plus className="mr-1 h-4 w-4" />
              Criar agente
            </Button>
          </>
        }
      />

      <div className="relative max-w-sm">
        <Search
          className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          aria-label="Buscar agente pelo nome"
          placeholder="Buscar agente pelo nome"
          className="pl-8"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
        />
      </div>

      {agentsQuery.isLoading ? (
        <div className="space-y-3 rounded-lg border border-border bg-surface p-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : agentsQuery.isError ? (
        <EmptyState
          title="Erro ao carregar agentes"
          description={agentsQuery.error?.message ?? "Não foi possível carregar os agentes."}
          actionLabel="Tentar de novo"
          onAction={() => void agentsQuery.refetch()}
        />
      ) : agents.length === 0 ? (
        <EmptyState
          icon={Bot}
          title={committedQuery ? "Nenhum agente encontrado" : "Nenhum agente ainda"}
          description={
            committedQuery
              ? "Ajuste a busca para tentar de novo."
              : "Crie o primeiro agente de IA desta empresa."
          }
          actionLabel={committedQuery ? "Limpar busca" : "Criar agente"}
          onAction={committedQuery ? clearSearch : () => setOpenWizard(true)}
        />
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
          {agents.map((agent) => (
            <li key={agent.id}>
              <Link
                to="/agentes/$agentId"
                params={{ agentId: agent.id }}
                className="flex flex-col gap-1 p-3 hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-center gap-2">
                  <Bot className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  <span className="font-medium text-foreground">
                    {agent.name || "Agente sem nome"}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-muted-foreground">
                  <span>Objetivo: {agent.type ? AGENT_TYPE_LABELS[agent.type] : "—"}</span>
                  <span>
                    Comunicação:{" "}
                    {agent.communicationType
                      ? COMMUNICATION_TYPE_LABELS[agent.communicationType]
                      : "—"}
                  </span>
                  <span>Empresa: {agent.jobName || "—"}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {agents.length > 0 && (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Anterior
          </Button>
          <span className="text-caption text-muted-foreground">Página {page}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={!hasNextPage}
            onClick={() => setPage((p) => p + 1)}
          >
            Próxima
          </Button>
        </div>
      )}

      <AgentCreateWizard open={openWizard} onOpenChange={setOpenWizard} />
    </div>
  );
}
