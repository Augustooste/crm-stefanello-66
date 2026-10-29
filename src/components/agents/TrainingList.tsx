// Lista de treinamentos de um tipo (uma sub-aba por TRAINING_TYPES — o
// contrato exige `type` na listagem, não existe "todos os tipos" numa
// chamada só, divergência D2 em contracts/agent-platform/CONTRACT_MATRIX.md).
//
// Limitação de contrato: a resposta de `trainings.list` é só o array (sem
// total/hasMore). A paginação aqui é uma heurística: "próxima página" fica
// disponível quando a página atual devolve `pageSize` itens cheios.
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Plus, RefreshCw, Search } from "lucide-react";

import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAgentPlatformQuery } from "@/lib/api/agent-platform";
import type { TrainingType } from "@/integrations/agent-platform/enums.gen";
import { TRAINING_TYPE_LABELS, type TrainingItem } from "@/components/agents/TrainingTypes";
import { TrainingItemCard } from "@/components/agents/TrainingItemCard";
import { TrainingFormDialog } from "@/components/agents/TrainingFormDialog";
import { TrainingDeleteDialog } from "@/components/agents/TrainingDeleteDialog";
import { TrainingReplaceDialog } from "@/components/agents/TrainingReplaceDialog";

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 300;

interface TrainingListProps {
  agentId: string;
  type: TrainingType;
}

export function TrainingList({ agentId, type }: TrainingListProps) {
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<TrainingItem | null>(null);
  const [deleting, setDeleting] = useState<TrainingItem | null>(null);
  const [replacing, setReplacing] = useState<TrainingItem | null>(null);

  // Trocar de sub-aba ou digitar na busca reinicia a paginação — página 2 do
  // tipo anterior não faz sentido no tipo novo.
  useEffect(() => {
    setPage(1);
    setSearchInput("");
    setQuery("");
  }, [type]);

  useEffect(() => {
    // Só agenda o debounce quando a busca realmente mudou. Sem esta guarda, o
    // timer agendado no mount (busca vazia) continua pendente — `searchInput`
    // não muda enquanto o usuário só pagina, então o efeito não re-roda e o
    // cleanup não dispara — e 300 ms depois chama `setPage(1)`, jogando de
    // volta pra página 1 quem clicou em "Próxima" nesse intervalo. Mesma
    // causa do flake corrigido em #246 (src/routes/_app.agentes.index.tsx).
    const next = searchInput.trim();
    if (next === query) return;

    const timer = setTimeout(() => {
      setQuery(next);
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput, query]);

  const trainings = useAgentPlatformQuery("trainings.list", {
    params: { agentId, type, page, pageSize: PAGE_SIZE, ...(query ? { query } : {}) },
  });

  const typeLabel = TRAINING_TYPE_LABELS[type].toLowerCase();
  const items = (trainings.data ?? []) as TrainingItem[];
  const hasNextPage = items.length === PAGE_SIZE;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search
            className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder={`Buscar treinamento de ${typeLabel}...`}
            aria-label={`Buscar treinamento de ${typeLabel}`}
            className="pl-8"
          />
        </div>
        <Button
          variant="outline"
          onClick={() => trainings.refetch()}
          disabled={trainings.isFetching}
        >
          <RefreshCw
            className={`mr-1.5 h-3.5 w-3.5 ${trainings.isFetching ? "animate-spin" : ""}`}
            aria-hidden
          />
          Sincronizar
        </Button>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1.5 h-4 w-4" aria-hidden />
          Novo treinamento
        </Button>
      </div>

      {trainings.isPending ? (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : trainings.isError ? (
        <EmptyState
          title="Não foi possível carregar os treinamentos"
          description={trainings.error?.message ?? "Erro ao carregar os treinamentos."}
          actionLabel="Tentar de novo"
          onAction={() => trainings.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState
          title={`Nenhum treinamento de ${typeLabel}`}
          description="Adicione o primeiro treinamento acima para o agente aprender com esse conteúdo."
        />
      ) : (
        <div className="space-y-3">
          {items.map((item, index) => (
            <TrainingItemCard
              key={item.id ?? `${type}-${page}-${index}`}
              item={item}
              onEdit={() => setEditing(item)}
              onReplace={() => setReplacing(item)}
              onDelete={() => setDeleting(item)}
            />
          ))}
        </div>
      )}

      {items.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-caption text-muted-foreground">
            Página {page} · o provedor de agentes não informa o total de treinamentos, então a
            última página só é detectada ao abri-la.
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              <ChevronLeft className="mr-1 h-4 w-4" aria-hidden />
              Anterior
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!hasNextPage}
              onClick={() => setPage((current) => current + 1)}
            >
              Próxima
              <ChevronRight className="ml-1 h-4 w-4" aria-hidden />
            </Button>
          </div>
        </div>
      )}

      <TrainingFormDialog
        agentId={agentId}
        type={type}
        mode="create"
        open={createOpen}
        onOpenChange={setCreateOpen}
      />

      {editing && (
        <TrainingFormDialog
          agentId={agentId}
          type="TEXT"
          mode="edit"
          training={editing.type === "TEXT" ? editing : undefined}
          open={!!editing}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setEditing(null);
          }}
        />
      )}

      {deleting && (
        <TrainingDeleteDialog
          agentId={agentId}
          training={deleting}
          open={!!deleting}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setDeleting(null);
          }}
        />
      )}

      {replacing && (
        <TrainingReplaceDialog
          agentId={agentId}
          type={type}
          training={replacing}
          open={!!replacing}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setReplacing(null);
          }}
          onReplaced={() => {
            setReplacing(null);
            setCreateOpen(true);
          }}
        />
      )}
    </div>
  );
}
