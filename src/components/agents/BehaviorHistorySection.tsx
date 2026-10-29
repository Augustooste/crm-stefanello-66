// Histórico de comportamento do agente.
//
// ACHADO D5 (CONTRACT_MATRIX.md): `GET /v2/agent/{id}/list-behavior-history`
// exige `page` (começando em 0, conforme comentário do schema gerado) e
// `pageSize` — nunca opcionais aqui, diferente de outras listagens paginadas.
//
// Não existe endpoint de restauração: a única forma de voltar a um
// comportamento antigo é copiar o texto e colar manualmente no editor de
// Perfil, salvando pelo `PUT /v2/agent/{agentId}` normal.
import { useState } from "react";
import { AlertTriangle, Copy } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/common/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime } from "@/lib/format";
import { useAgentPlatformQuery } from "@/lib/api/agent-platform";
import type { AgentPlatformBehaviorHistory } from "@/lib/api/agent-platform-contract";

const PAGE_SIZE = 10;

/**
 * ACHADO (fora de D1-D14): o contrato documenta a resposta 200 deste
 * endpoint como um objeto ÚNICO de histórico (todos os campos obrigatórios),
 * apesar de `page`/`pageSize` implicarem múltiplos registros por página.
 * Normalizamos defensivamente, igual às demais listagens desta aba.
 */
function toItems(
  value: AgentPlatformBehaviorHistory | AgentPlatformBehaviorHistory[] | null | undefined,
): AgentPlatformBehaviorHistory[] {
  if (Array.isArray(value)) return value;
  if (value && "id" in value) return [value];
  return [];
}

export function BehaviorHistorySection({ agentId }: { agentId: string }) {
  const [page, setPage] = useState(0);
  const [viewing, setViewing] = useState<AgentPlatformBehaviorHistory | null>(null);

  // `page` e `pageSize` são enviados SEMPRE (D5) — o contrato não os torna
  // opcionais neste endpoint.
  const historyQ = useAgentPlatformQuery("agent.behaviorHistory.list", {
    params: { agentId, page, pageSize: PAGE_SIZE },
  });

  const items = toItems(historyQ.data);

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Comportamento copiado — cole no editor de Perfil e salve");
    } catch {
      toast.error("Não foi possível copiar. Selecione e copie o texto manualmente.");
    }
  }

  return (
    <Card>
      <CardHeader>
        {/* O título já está no AccordionTrigger — aqui só a descrição, sem repetir o heading. */}
        <CardDescription>
          Não existe restauração automática: copie o texto de uma versão antiga e cole no editor de
          Perfil deste agente, depois salve normalmente.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {historyQ.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : historyQ.error ? (
          <EmptyState
            icon={AlertTriangle}
            title="Não foi possível carregar o histórico"
            description={historyQ.error.message}
            actionLabel="Tentar de novo"
            onAction={() => historyQ.refetch()}
          />
        ) : items.length === 0 ? (
          <EmptyState
            title="Sem histórico nesta página"
            description="Alterações de comportamento salvas no Perfil aparecerão aqui."
          />
        ) : (
          <ul className="divide-y divide-border">
            {items.map((h, i) => (
              <li key={h.id ?? i} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="text-body font-medium text-foreground">
                    {formatDateTime(new Date(h.createdAt))}
                  </div>
                  <div className="text-caption text-muted-foreground">
                    {h.userName} ({h.userLogin})
                  </div>
                </div>
                <Button variant="outline" size="sm" onClick={() => setViewing(h)}>
                  Ver texto completo
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Copiar para o editor"
                  onClick={() => copyToClipboard(h.behaviorText)}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center justify-between">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            Anterior
          </Button>
          <span className="text-caption text-muted-foreground">Página {page + 1}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={items.length < PAGE_SIZE}
            onClick={() => setPage((p) => p + 1)}
          >
            Próxima
          </Button>
        </div>
      </CardContent>

      <Dialog open={!!viewing} onOpenChange={(v) => !v && setViewing(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              Comportamento salvo em {viewing && formatDateTime(new Date(viewing.createdAt))}
            </DialogTitle>
            <DialogDescription>
              Por {viewing?.userName} ({viewing?.userLogin})
            </DialogDescription>
          </DialogHeader>
          <p className="max-h-80 overflow-y-auto whitespace-pre-wrap text-body text-foreground">
            {viewing?.behaviorText}
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setViewing(null)}>
              Fechar
            </Button>
            <Button onClick={() => viewing && copyToClipboard(viewing.behaviorText)}>
              <Copy className="mr-2 h-4 w-4" />
              Copiar para o editor
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
