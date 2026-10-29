// Um card por treinamento na lista da aba "Treinamentos". O conteúdo exibido
// varia por tipo (texto/site/vídeo/documento); as ações também variam: só
// treinamento de TEXTO pode ser editado (contrato só aceita `PUT` para TEXT —
// D1 em contracts/agent-platform/CONTRACT_MATRIX.md), os demais só "substituir".
import { FileText, Globe, Pencil, Repeat, Trash2, Video as VideoIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  TRAINING_INTERVAL_LABELS,
  TRAINING_SUB_PAGES_LABELS,
  type TrainingItem,
} from "@/components/agents/TrainingTypes";

interface TrainingItemCardProps {
  item: TrainingItem;
  onEdit: () => void;
  onReplace: () => void;
  onDelete: () => void;
}

export function TrainingItemCard({ item, onEdit, onReplace, onDelete }: TrainingItemCardProps) {
  return (
    <article className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">{renderContent(item)}</div>
        <div className="flex shrink-0 gap-2">
          {item.type === "TEXT" ? (
            <Button size="sm" variant="outline" onClick={onEdit}>
              <Pencil className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              Editar
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={onReplace}>
              <Repeat className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              Substituir
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onDelete}>
            <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            Excluir
          </Button>
        </div>
      </div>
    </article>
  );
}

function renderContent(item: TrainingItem) {
  if (item.type === "TEXT") {
    return (
      <div className="flex items-start gap-2">
        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className="line-clamp-3 text-body text-foreground">{item.text || "(sem texto)"}</p>
      </div>
    );
  }
  if (item.type === "WEBSITE") {
    return (
      <div className="flex items-start gap-2">
        <Globe className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">{item.website || "(sem endereço)"}</p>
          <p className="text-caption text-muted-foreground">
            Subpáginas:{" "}
            {item.trainingSubPages ? TRAINING_SUB_PAGES_LABELS[item.trainingSubPages] : "—"} ·
            Atualização:{" "}
            {item.trainingInterval ? TRAINING_INTERVAL_LABELS[item.trainingInterval] : "—"}
          </p>
        </div>
      </div>
    );
  }
  if (item.type === "VIDEO") {
    return (
      <div className="flex items-start gap-2">
        <VideoIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className="truncate text-foreground">{item.video || "(sem vídeo)"}</p>
      </div>
    );
  }
  if (item.type === "DOCUMENT") {
    return (
      <div className="flex items-start gap-2">
        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">
            {item.documentName || "(sem nome)"}
          </p>
          <p className="text-caption text-muted-foreground">{item.documentMimetype || "—"}</p>
        </div>
      </div>
    );
  }
  return <p className="text-body text-muted-foreground">Treinamento de tipo desconhecido.</p>;
}
