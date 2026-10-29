import { useState } from "react";
import { Plus, Webhook } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/common/EmptyState";
import { StatusBadge } from "@/components/common/StatusBadge";
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
import { Skeleton } from "@/components/ui/skeleton";
import { useBoardStagesForBoard } from "@/hooks/use-decision-queue";
import { useBoards } from "@/lib/api/boards";
import {
  useCreateWebhookEndpoint,
  useDeleteWebhookEndpoint,
  useRotateWebhookSecret,
  useSendTestWebhook,
  useSetWebhookActive,
  useUpdateWebhookEndpoint,
  useWebhookDeliveryStats,
  useWebhookEndpoints,
  type WebhookEndpoint,
} from "@/lib/api/developer";
import { errorText, formatDateTime } from "./format";
import { SecretRevealDialog } from "./SecretRevealDialog";
import { WebhookDeliveriesDialog } from "./WebhookDeliveriesDialog";
import { WebhookEndpointDialog } from "./WebhookEndpointDialog";
import { WebhooksDocsInlineLink, WebhooksHelpLink } from "./WebhooksHelpLink";

type Confirm = { kind: "rotate" | "delete"; endpoint: WebhookEndpoint } | null;

export function WebhookEndpointsSection() {
  const endpointsQ = useWebhookEndpoints();
  const createM = useCreateWebhookEndpoint();
  const rotateM = useRotateWebhookSecret();
  const deleteM = useDeleteWebhookEndpoint();
  const activeM = useSetWebhookActive();
  const testM = useSendTestWebhook();
  const updateM = useUpdateWebhookEndpoint();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<WebhookEndpoint | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [deliveriesFor, setDeliveriesFor] = useState<WebhookEndpoint | null>(null);

  const run = async (action: () => Promise<unknown>, success: string) => {
    try {
      await action();
      toast.success(success);
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  const runConfirmed = async () => {
    if (!confirm) return;
    const { kind, endpoint } = confirm;
    setConfirm(null);
    if (kind === "rotate") {
      await run(() => rotateM.mutateAsync(endpoint.id), "Segredo rotacionado.");
    } else {
      await run(() => deleteM.mutateAsync(endpoint.id), "Webhook excluído.");
    }
  };

  const endpoints = endpointsQ.data ?? [];

  return (
    <section aria-labelledby="webhooks-title" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="webhooks-title" className="text-section-title font-semibold text-foreground">
            Webhooks
          </h2>
          <p className="text-body text-muted-foreground">
            Receba eventos do CRM em tempo real em uma URL sua, com assinatura para validar a
            origem.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {endpointsQ.isFetching && !endpointsQ.isLoading && (
            <span role="status" className="text-caption text-muted-foreground">
              Atualizando…
            </span>
          )}
          <WebhooksHelpLink hash="saida" topic="webhooks de saída" />
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
            Criar webhook
          </Button>
        </div>
      </div>

      {endpointsQ.isLoading ? (
        <div role="status" aria-label="Carregando webhooks" className="flex flex-col gap-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : endpointsQ.error ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>{errorText(endpointsQ.error)}</span>
            <Button variant="secondary" size="sm" onClick={() => void endpointsQ.refetch()}>
              Tentar novamente
            </Button>
          </AlertDescription>
        </Alert>
      ) : endpoints.length === 0 ? (
        <div className="flex flex-col gap-2">
          <EmptyState
            icon={Webhook}
            title="Nenhum webhook"
            description="Cadastre uma URL para receber eventos como negócio ganho ou perdido e contato criado."
            actionLabel="Criar webhook"
            onAction={() => setCreateOpen(true)}
          />
          <p className="text-center">
            <WebhooksDocsInlineLink hash="saida">
              Como funcionam os webhooks de saída
            </WebhooksDocsInlineLink>
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
          {endpoints.map((endpoint) => (
            <EndpointRow
              key={endpoint.id}
              endpoint={endpoint}
              busy={activeM.isPending || testM.isPending}
              onToggle={() =>
                void run(
                  () => activeM.mutateAsync({ id: endpoint.id, active: !endpoint.active }),
                  endpoint.active ? "Webhook pausado." : "Webhook ativado.",
                )
              }
              onTest={() =>
                void run(() => testM.mutateAsync(endpoint.id), "Evento de teste enviado.")
              }
              onRotate={() => setConfirm({ kind: "rotate", endpoint })}
              onDelete={() => setConfirm({ kind: "delete", endpoint })}
              onDeliveries={() => setDeliveriesFor(endpoint)}
              onEdit={() => setEditing(endpoint)}
            />
          ))}
        </ul>
      )}

      <WebhookEndpointDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSubmit={async (input) => {
          await createM.mutateAsync(input);
          setCreateOpen(false);
        }}
      />

      {editing && (
        <WebhookEndpointDialog
          key={editing.id}
          open
          initial={editing}
          onOpenChange={(next) => {
            if (!next) setEditing(null);
          }}
          onSubmit={async (input) => {
            await updateM.mutateAsync({ id: editing.id, ...input });
            setEditing(null);
            toast.success("Webhook atualizado.");
          }}
        />
      )}

      <SecretRevealDialog
        open={!!createM.data}
        title="Webhook criado"
        description="Use o segredo para validar a assinatura de cada requisição recebida."
        secretLabel="Segredo"
        copyLabel="Copiar segredo"
        closeLabel="Já guardei o segredo"
        secret={createM.data?.secret}
        onClose={() => createM.reset()}
      />
      <SecretRevealDialog
        open={!!rotateM.data}
        title="Novo segredo gerado"
        description="O novo segredo vale a partir de agora. O anterior continua válido por 24 horas e depois para de funcionar; atualize a sua integração nesse período."
        secretLabel="Segredo"
        copyLabel="Copiar segredo"
        closeLabel="Já guardei o segredo"
        secret={rotateM.data}
        onClose={() => rotateM.reset()}
      />

      {deliveriesFor && (
        <WebhookDeliveriesDialog
          endpointId={deliveriesFor.id}
          endpointUrl={deliveriesFor.url}
          open
          onOpenChange={(next) => {
            if (!next) setDeliveriesFor(null);
          }}
        />
      )}

      <AlertDialog
        open={!!confirm}
        onOpenChange={(next) => {
          if (!next) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === "rotate" ? "Rotacionar o segredo?" : "Excluir este webhook?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "rotate"
                ? "O novo segredo passa a valer agora e é mostrado uma única vez. O segredo anterior continua válido por 24 horas e depois para de funcionar; atualize a sua integração nesse período."
                : `O webhook ${confirm?.endpoint.url ?? ""} e o histórico de entregas serão apagados. Não é possível desfazer.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => void runConfirmed()}>
              {confirm?.kind === "rotate" ? "Rotacionar" : "Excluir"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function SuccessRate({ endpointId }: { endpointId: string }) {
  const statsQ = useWebhookDeliveryStats(endpointId);
  if (statsQ.isLoading)
    return <span className="text-caption text-muted-foreground">Calculando…</span>;
  if (statsQ.error || !statsQ.data) {
    return <span className="text-caption text-muted-foreground">Taxa indisponível</span>;
  }
  const finished = statsQ.data.delivered + statsQ.data.dead_letter;
  if (finished === 0)
    return <span className="text-caption text-muted-foreground">Sem entregas</span>;
  const rate = Math.round((statsQ.data.delivered / finished) * 100);
  return (
    <span className="text-caption text-muted-foreground">
      Taxa de sucesso: {rate}% ({statsQ.data.delivered} de {finished})
    </span>
  );
}

const FILTER_TARGET_DELETED = "filter_target_deleted";

function FilterSummary({ endpoint }: { endpoint: WebhookEndpoint }) {
  const boardsQ = useBoards();
  // A UI grava um funil por vez; com mais de um (via RPC) mostra só a contagem.
  const singleBoard = endpoint.board_ids.length === 1 ? endpoint.board_ids[0] : null;
  const stagesQ = useBoardStagesForBoard(singleBoard);
  if (endpoint.board_ids.length === 0 && endpoint.stage_ids.length === 0) {
    return <span className="text-caption text-muted-foreground">Todos os negócios</span>;
  }
  // Sem os funis carregados não dá para distinguir funil apagado de funil ainda não lido.
  if (boardsQ.isLoading || (singleBoard && stagesQ.isLoading)) {
    return <span className="text-caption text-muted-foreground">Carregando filtro…</span>;
  }
  const boardName = singleBoard
    ? (boardsQ.data?.find((b) => b.id === singleBoard)?.name ?? "funil apagado")
    : endpoint.board_ids.length === 0
      ? "Todos"
      : `${endpoint.board_ids.length} funis`;
  const stageNames =
    endpoint.stage_ids.length === 0
      ? "Todas"
      : endpoint.stage_ids
          .map((id) => stagesQ.data?.find((s) => s.id === id)?.name)
          .filter((name): name is string => !!name)
          .join(", ") || `${endpoint.stage_ids.length} etapa(s)`;
  return (
    <span className="text-caption text-muted-foreground">
      Funil: {boardName} · Etapas: {stageNames}
    </span>
  );
}

function EndpointRow({
  endpoint,
  busy,
  onToggle,
  onTest,
  onRotate,
  onDelete,
  onDeliveries,
  onEdit,
}: {
  endpoint: WebhookEndpoint;
  busy: boolean;
  onToggle: () => void;
  onTest: () => void;
  onRotate: () => void;
  onDelete: () => void;
  onDeliveries: () => void;
  onEdit: () => void;
}) {
  return (
    <li className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="break-all font-mono text-body text-foreground">{endpoint.url}</span>
        {endpoint.active ? (
          <StatusBadge variant="success">Ativo</StatusBadge>
        ) : (
          <StatusBadge variant="warning">Pausado</StatusBadge>
        )}
      </div>
      {endpoint.description && (
        <p className="text-body text-muted-foreground">{endpoint.description}</p>
      )}
      {!endpoint.active && endpoint.disabled_reason === FILTER_TARGET_DELETED ? (
        <p className="text-caption text-warning-foreground dark:text-warning">
          Desativado: o funil ou a etapa do filtro foi apagado. Edite o filtro para reativar.
        </p>
      ) : (
        !endpoint.active &&
        endpoint.disabled_reason && (
          <p className="text-caption text-warning-foreground dark:text-warning">
            Motivo: {endpoint.disabled_reason}
          </p>
        )
      )}
      <FilterSummary endpoint={endpoint} />
      <div className="flex flex-wrap gap-1">
        {endpoint.event_types.map((type) => (
          <StatusBadge key={type} variant="outline" showDot={false}>
            {type}
          </StatusBadge>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <SuccessRate endpointId={endpoint.id} />
        {endpoint.previous_secret_expires_at && (
          <span className="text-caption text-muted-foreground">
            Segredo anterior vale até {formatDateTime(endpoint.previous_secret_expires_at)}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={onDeliveries}>
          Ver entregas
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={onTest}>
          Enviar evento de teste
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={onToggle}>
          {endpoint.active ? "Pausar" : "Ativar"}
          <span className="sr-only"> webhook {endpoint.url}</span>
        </Button>
        <Button variant="outline" size="sm" onClick={onEdit}>
          Editar
          <span className="sr-only"> webhook {endpoint.url}</span>
        </Button>
        <Button variant="outline" size="sm" onClick={onRotate}>
          Rotacionar segredo
        </Button>
        <Button variant="outline" size="sm" onClick={onDelete}>
          Excluir
          <span className="sr-only"> webhook {endpoint.url}</span>
        </Button>
      </div>
    </li>
  );
}
