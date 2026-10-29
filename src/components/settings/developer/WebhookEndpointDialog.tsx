import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useBoardStagesForBoard } from "@/hooks/use-decision-queue";
import { useBoards } from "@/lib/api/boards";
import { useAllowedWebhookEventTypes, type WebhookEndpoint } from "@/lib/api/developer";
import { errorText } from "./format";

const MAX_URL_LENGTH = 2048;
const MAX_DESCRIPTION_LENGTH = 500;
// Valor do Select para "sem filtro de funil" (o Radix não aceita string vazia).
const ALL_BOARDS = "all";

export type WebhookEndpointInput = {
  url: string;
  eventTypes: string[];
  description: string | null;
  /** Vazio = todos os funis. */
  boardIds: string[];
  /** Vazio = todas as etapas do funil. */
  stageIds: string[];
};

/** Devolve a mensagem em português do primeiro problema, ou null se a URL é aceitável. */
// Espelha o CHECK do banco (migration 20261020120000_webhook_endpoints.sql):
// url ~ '^https://[^@/\s]+(/[^\s]*)?$' e char_length(url) <= 2048.
const DB_URL_PATTERN = /^https:\/\/[^@/\s]+(\/[^\s]*)?$/;

function validateWebhookUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return "Informe a URL do webhook.";
  if (value.length > MAX_URL_LENGTH)
    return `A URL pode ter no máximo ${MAX_URL_LENGTH} caracteres.`;
  if (/\s/.test(value)) return "A URL não pode conter espaços.";
  if (!value.startsWith("https://")) return "A URL precisa usar https://.";
  if (value.slice("https://".length).split("/")[0].includes("@")) {
    return "A URL não pode conter usuário e senha.";
  }
  if (!DB_URL_PATTERN.test(value)) {
    return "Informe uma URL válida, como https://sistema.exemplo.com.br/webhook.";
  }
  return null;
}

/**
 * Criação e, com `initial`, edição. A UI expõe um funil por vez (o banco aceita lista);
 * com "Todos os funis" o filtro de etapa fica desabilitado.
 */
export function WebhookEndpointDialog({
  open,
  onOpenChange,
  onSubmit,
  initial,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: WebhookEndpointInput) => Promise<void>;
  initial?: WebhookEndpoint;
}) {
  const eventsQ = useAllowedWebhookEventTypes();
  const boardsQ = useBoards();
  const [url, setUrl] = useState(initial?.url ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [events, setEvents] = useState<string[]>(initial?.event_types ?? []);
  const [board, setBoard] = useState(initial?.board_ids[0] ?? ALL_BOARDS);
  const [stages, setStages] = useState<string[]>(initial?.stage_ids ?? []);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const stagesQ = useBoardStagesForBoard(board === ALL_BOARDS ? null : board);
  const stagesWithoutBoard = initial && initial.board_ids.length === 0 ? initial.stage_ids : [];
  // Ids marcados que não existem mais no funil (etapa apagada): ficam visíveis e
  // desmarcáveis, nunca filtrados em silêncio (lista vazia = todas as etapas).
  const deletedStages =
    board === ALL_BOARDS || !stagesQ.data
      ? []
      : stages.filter((id) => !stagesQ.data.some((stage) => stage.id === id));
  const boardName = boardsQ.data?.find((b) => b.id === board)?.name;
  const toggleStage = (id: string, checked: boolean) =>
    setStages((current) => (checked ? [...current, id] : current.filter((s) => s !== id)));

  const reset = () => {
    setUrl(initial?.url ?? "");
    setDescription(initial?.description ?? "");
    setEvents(initial?.event_types ?? []);
    setBoard(initial?.board_ids[0] ?? ALL_BOARDS);
    setStages(initial?.stage_ids ?? []);
    setError(null);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const urlError = validateWebhookUrl(url);
    if (urlError) return setError(urlError);
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      return setError(`A descrição pode ter no máximo ${MAX_DESCRIPTION_LENGTH} caracteres.`);
    }
    if (events.length === 0) return setError("Selecione ao menos um evento.");
    if (deletedStages.length > 0) return setError("Desmarque as etapas apagadas para salvar.");
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit({
        url: url.trim(),
        eventTypes: events,
        description: description.trim() || null,
        boardIds: board === ALL_BOARDS ? [] : [board],
        // Etapas sem funil só existem via RPC direta: mantidas, salvar não amplia o filtro.
        stageIds: board === ALL_BOARDS ? stagesWithoutBoard : stages,
      });
      reset();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{initial ? "Editar webhook" : "Novo webhook"}</DialogTitle>
            <DialogDescription>
              Enviamos um POST assinado para esta URL a cada evento escolhido.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="webhook-url">URL de destino</Label>
            <Input
              id="webhook-url"
              type="url"
              inputMode="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://sistema.exemplo.com.br/webhooks/aceleraflow"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="webhook-description">Descrição (opcional)</Label>
            <Textarea
              id="webhook-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-body font-medium text-foreground">Eventos</legend>
            {eventsQ.isLoading && <Skeleton className="h-8 w-full" />}
            {eventsQ.error && (
              <p className="text-body text-destructive">{errorText(eventsQ.error)}</p>
            )}
            {(eventsQ.data ?? []).map((type) => (
              <div key={type} className="flex items-center gap-2">
                <Checkbox
                  id={`event-${type}`}
                  checked={events.includes(type)}
                  onCheckedChange={(checked) =>
                    setEvents((current) =>
                      checked === true ? [...current, type] : current.filter((e) => e !== type),
                    )
                  }
                />
                <Label htmlFor={`event-${type}`} className="font-mono">
                  {type}
                </Label>
              </div>
            ))}
          </fieldset>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-body font-medium text-foreground">
              Filtrar negócios (opcional)
            </legend>
            <p className="text-caption text-muted-foreground">
              Vale para eventos de negócio. Se a etapa for de ganho, você recebe deal.won e
              deal.stage_changed.
            </p>
            <Label htmlFor="webhook-board">Funil</Label>
            {boardsQ.isLoading ? (
              <Skeleton role="status" aria-label="Carregando funis" className="h-9 w-full" />
            ) : (
              <Select
                value={board}
                onValueChange={(next) => {
                  setBoard(next);
                  setStages([]);
                }}
              >
                <SelectTrigger id="webhook-board" aria-label="Funil">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_BOARDS}>Todos os funis</SelectItem>
                  {(boardsQ.data ?? []).map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {boardsQ.error && (
              <p className="text-body text-destructive">Não foi possível carregar os funis.</p>
            )}
            <span className="text-body font-medium text-foreground">Etapas</span>
            {board === ALL_BOARDS ? (
              <p className="text-caption text-muted-foreground">
                Escolha um funil para filtrar por etapa. Sem etapa marcada, vale qualquer etapa.
              </p>
            ) : (
              <>
                {stagesQ.isLoading && <Skeleton className="h-8 w-full" />}
                {stagesQ.error && (
                  <p className="text-body text-destructive">Não foi possível carregar as etapas.</p>
                )}
                {(stagesQ.data ?? []).map((stage) => (
                  <div key={stage.id} className="flex items-center gap-2">
                    <Checkbox
                      id={`stage-${stage.id}`}
                      checked={stages.includes(stage.id)}
                      onCheckedChange={(checked) => toggleStage(stage.id, checked === true)}
                    />
                    <Label htmlFor={`stage-${stage.id}`}>{stage.name}</Label>
                  </div>
                ))}
                {deletedStages.map((id) => (
                  <div key={id} className="flex items-center gap-2">
                    <Checkbox
                      id={`stage-${id}`}
                      checked
                      onCheckedChange={(checked) => toggleStage(id, checked === true)}
                    />
                    <Label htmlFor={`stage-${id}`} className="text-destructive">
                      Etapa apagada
                    </Label>
                  </div>
                ))}
                {stagesQ.data && stages.length === 0 && (
                  <p className="text-caption text-muted-foreground">
                    Nenhuma etapa marcada: vale para todas as etapas do funil{" "}
                    {boardName ?? "escolhido"}.
                  </p>
                )}
              </>
            )}
          </fieldset>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={submitting}>
              {initial ? "Salvar" : "Criar webhook"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
