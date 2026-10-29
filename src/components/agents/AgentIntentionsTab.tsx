// Aba "Intenções" do agente provedor de agentes.
// GET/POST /v2/agent/{agentId}/intentions · PUT/DELETE /v2/intention/{intentionId}
// (ver contracts/agent-platform/CONTRACT_MATRIX.md §1.5 e divergência D7).
//
// Limitação de contrato: a listagem devolve um array simples (`Intention[]`),
// sem total nem contagem de páginas — "Próxima" fica disponível enquanto a
// página atual vier completa (heurística, não uma garantia do contrato).
import { useEffect, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, RefreshCw, Search, Target } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/common/EmptyState";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAgentPlatformMutation, useAgentPlatformQuery } from "@/lib/api/agent-platform";
import type { AgentPlatformIntention } from "@/lib/api/agent-platform-contract";
import { IntentionCard } from "@/components/agents/IntentionCard";
import { IntentionFormDialog } from "@/components/agents/IntentionFormDialog";

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 300;

export function AgentIntentionsTab({ agentId }: { agentId: string }) {
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [formState, setFormState] = useState<{ intention?: AgentPlatformIntention } | null>(null);
  const [deleting, setDeleting] = useState<AgentPlatformIntention | null>(null);

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

  const intentionsQuery = useAgentPlatformQuery("intentions.list", {
    params: { agentId, page, pageSize: PAGE_SIZE, query: query || undefined },
  });
  const deleteMutation = useAgentPlatformMutation("intention.delete", {
    invalidate: ["intentions.list"],
  });

  const items = intentionsQuery.data ?? [];
  const hasPreviousPage = page > 1;
  const hasNextPage = items.length === PAGE_SIZE;

  function handleDelete() {
    const target = deleting;
    if (!target?.id) return;
    deleteMutation.mutate(
      { params: { agentId, intentionId: target.id } },
      {
        onSuccess: () => {
          toast.success("Intenção excluída.");
          setDeleting(null);
          // Evita ficar numa página vazia depois de excluir o último item dela.
          if (items.length === 1 && page > 1) setPage((p) => p - 1);
        },
        onError: (error) => toast.error(error.message),
      },
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-card-title">
            <Target className="h-4 w-4" aria-hidden />
            Intenções
          </CardTitle>
          <CardDescription>
            Objetivos que o agente reconhece na conversa e como ele deve agir em cada um.
          </CardDescription>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => intentionsQuery.refetch()}
            disabled={intentionsQuery.isFetching}
          >
            <RefreshCw
              className={`mr-1.5 h-3.5 w-3.5 ${intentionsQuery.isFetching ? "animate-spin" : ""}`}
              aria-hidden
            />
            Sincronizar
          </Button>
          <Button size="sm" onClick={() => setFormState({})}>
            Nova intenção
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert>
          <AlertDescription>
            O CRM IA não executa a URL cadastrada em uma intenção — quem chama o webhook durante a
            conversa é o próprio provedor de agentes.
          </AlertDescription>
        </Alert>

        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Buscar por descrição"
            className="pl-9"
            aria-label="Buscar intenções por descrição"
          />
        </div>

        {intentionsQuery.isPending ? (
          <div className="space-y-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : intentionsQuery.isError ? (
          <EmptyState
            icon={AlertTriangle}
            title="Não foi possível carregar as intenções"
            description={intentionsQuery.error.message}
            actionLabel="Tentar de novo"
            onAction={() => intentionsQuery.refetch()}
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon={Target}
            title={query ? "Nenhuma intenção encontrada" : "Nenhuma intenção cadastrada"}
            description={
              query
                ? "Ajuste a busca ou limpe o campo para ver todas as intenções."
                : 'Use o botão "Nova intenção" acima para criar a primeira e o agente reconhecer objetivos na conversa.'
            }
          />
        ) : (
          <div className="space-y-3">
            {items.map((intention) => (
              <IntentionCard
                key={intention.id}
                intention={intention}
                onEdit={() => setFormState({ intention })}
                onDelete={() => setDeleting(intention)}
              />
            ))}
          </div>
        )}

        {!intentionsQuery.isPending && !intentionsQuery.isError && (
          <div className="flex items-center justify-between pt-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!hasPreviousPage}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ChevronLeft className="mr-1 h-3.5 w-3.5" aria-hidden />
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
              <ChevronRight className="ml-1 h-3.5 w-3.5" aria-hidden />
            </Button>
          </div>
        )}
      </CardContent>

      {formState && (
        <IntentionFormDialog
          open={!!formState}
          onOpenChange={(next) => !next && setFormState(null)}
          agentId={agentId}
          intention={formState.intention}
        />
      )}

      <AlertDialog open={!!deleting} onOpenChange={(next) => !next && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir intenção</AlertDialogTitle>
            <AlertDialogDescription>
              A intenção <strong>{deleting?.description}</strong> será removida do agente. Esta ação
              não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? "Excluindo…" : "Excluir"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
