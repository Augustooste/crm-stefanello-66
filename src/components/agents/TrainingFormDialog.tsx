// Diálogo de criação de treinamento (4 variantes do `oneOf`, uma por
// TRAINING_TYPES) e de edição — edição só existe para TEXT, porque o
// contrato só aceita `PUT /v2/training/{trainingId}` com `type: "TEXT"`
// (divergência D1 em contracts/agent-platform/CONTRACT_MATRIX.md §1.4). Os
// demais tipos usam o fluxo de "substituir" (ver TrainingReplaceDialog).
//
// `callbackUrl` não aparece em nenhum campo: o proxy injeta a URL assinada
// no servidor e descarta qualquer valor vindo do cliente.
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import { type AgentPlatformCallError, useAgentPlatformMutation } from "@/lib/api/agent-platform";
import {
  TRAINING_INTERVALS,
  TRAINING_SUB_PAGES,
  type TrainingInterval,
  type TrainingSubPages,
  type TrainingType,
} from "@/integrations/agent-platform/enums.gen";
import {
  TRAINING_INTERVAL_LABELS,
  TRAINING_SUB_PAGES_LABELS,
  TRAINING_TYPE_LABELS,
  type TextTrainingItem,
} from "@/components/agents/TrainingTypes";

interface TrainingFormDialogProps {
  agentId: string;
  /** Tipo do treinamento a criar. Em `mode: "edit"` é sempre "TEXT". */
  type: TrainingType;
  mode: "create" | "edit";
  /** Obrigatório em `mode: "edit"`. */
  training?: TextTrainingItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TrainingFormDialog({
  agentId,
  type,
  mode,
  training,
  open,
  onOpenChange,
}: TrainingFormDialogProps) {
  const effectiveType = mode === "edit" ? "TEXT" : type;

  const [text, setText] = useState("");
  const [image, setImage] = useState("");
  const [website, setWebsite] = useState("");
  const [subPages, setSubPages] = useState<TrainingSubPages>("DISABLED");
  const [interval, setInterval] = useState<TrainingInterval>("NEVER");
  const [video, setVideo] = useState("");
  const [documentUrl, setDocumentUrl] = useState("");
  const [documentName, setDocumentName] = useState("");
  const [documentMimetype, setDocumentMimetype] = useState("");

  useEffect(() => {
    if (!open) return;
    if (mode === "edit") {
      setText(training?.text ?? "");
      setImage(training?.image ?? "");
      return;
    }
    setText("");
    setImage("");
    setWebsite("");
    setSubPages("DISABLED");
    setInterval("NEVER");
    setVideo("");
    setDocumentUrl("");
    setDocumentName("");
    setDocumentMimetype("");
  }, [open, mode, training]);

  const createMutation = useAgentPlatformMutation("trainings.create", {
    invalidate: ["trainings.list"],
    onSuccess: () => {
      toast.success("Treinamento adicionado. O processamento continua em segundo plano.");
      onOpenChange(false);
    },
    onError: (error: AgentPlatformCallError) => toast.error(error.message),
  });

  const updateMutation = useAgentPlatformMutation("training.update", {
    invalidate: ["trainings.list"],
    onSuccess: () => {
      toast.success("Treinamento de texto atualizado.");
      onOpenChange(false);
    },
    onError: (error: AgentPlatformCallError) => toast.error(error.message),
  });

  const mutation = mode === "edit" ? updateMutation : createMutation;

  const isValid =
    effectiveType === "TEXT"
      ? text.trim().length > 0
      : effectiveType === "WEBSITE"
        ? website.trim().length > 0
        : effectiveType === "VIDEO"
          ? video.trim().length > 0
          : documentUrl.trim().length > 0 &&
            documentName.trim().length > 0 &&
            documentMimetype.trim().length > 0;

  function handleSubmit() {
    if (mode === "edit") {
      if (!training?.id) {
        toast.error("Este treinamento não tem identificador — não é possível editá-lo.");
        return;
      }
      updateMutation.mutate({
        params: { agentId, trainingId: training.id },
        body: { type: "TEXT", text: text.trim(), image: image.trim() || undefined },
      });
      return;
    }

    if (type === "TEXT") {
      createMutation.mutate({
        params: { agentId },
        body: { type: "TEXT", text: text.trim(), image: image.trim() || undefined },
      });
      return;
    }
    if (type === "WEBSITE") {
      createMutation.mutate({
        params: { agentId },
        body: {
          type: "WEBSITE",
          website: website.trim(),
          trainingSubPages: subPages,
          trainingInterval: interval,
        },
      });
      return;
    }
    if (type === "VIDEO") {
      createMutation.mutate({
        params: { agentId },
        body: { type: "VIDEO", video: video.trim() },
      });
      return;
    }
    createMutation.mutate({
      params: { agentId },
      body: {
        type: "DOCUMENT",
        documentUrl: documentUrl.trim(),
        documentName: documentName.trim(),
        documentMimetype: documentMimetype.trim(),
      },
    });
  }

  const title =
    mode === "edit"
      ? "Editar treinamento de texto"
      : `Novo treinamento de ${TRAINING_TYPE_LABELS[type].toLowerCase()}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {mode === "edit"
              ? 'O provedor de agentes só permite atualizar treinamentos de texto — para os demais tipos, use "Substituir".'
              : "Preencha os dados abaixo para adicionar este treinamento ao agente."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {effectiveType === "TEXT" && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="training-text">Texto do treinamento</Label>
                <Textarea
                  id="training-text"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  rows={8}
                  placeholder="Cole aqui o conteúdo que o agente deve aprender."
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="training-image">Imagem (URL, opcional)</Label>
                <Input
                  id="training-image"
                  value={image}
                  onChange={(event) => setImage(event.target.value)}
                  placeholder="https://..."
                />
                {mode === "edit" && (
                  <p className="text-caption text-muted-foreground">
                    O contrato não define o que acontece ao deixar este campo vazio ao salvar — esta
                    tela não garante que uma imagem já cadastrada seja removida.
                  </p>
                )}
              </div>
            </>
          )}

          {effectiveType === "WEBSITE" && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="training-website">Endereço do site</Label>
                <Input
                  id="training-website"
                  value={website}
                  onChange={(event) => setWebsite(event.target.value)}
                  placeholder="https://minhaempresa.com.br"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Subpáginas</Label>
                <Select
                  value={subPages}
                  onValueChange={(value) => setSubPages(value as TrainingSubPages)}
                >
                  <SelectTrigger aria-label="Subpáginas">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TRAINING_SUB_PAGES.map((option) => (
                      <SelectItem key={option} value={option}>
                        {TRAINING_SUB_PAGES_LABELS[option]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Intervalo de atualização</Label>
                <Select
                  value={interval}
                  onValueChange={(value) => setInterval(value as TrainingInterval)}
                >
                  <SelectTrigger aria-label="Intervalo de atualização">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TRAINING_INTERVALS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {TRAINING_INTERVAL_LABELS[option]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          {effectiveType === "VIDEO" && (
            <div className="space-y-1.5">
              <Label htmlFor="training-video">Link do vídeo</Label>
              <Input
                id="training-video"
                value={video}
                onChange={(event) => setVideo(event.target.value)}
                placeholder="https://www.youtube.com/watch?v=..."
              />
              <p className="text-caption text-muted-foreground">
                A documentação funcional do provedor de agentes recomenda vídeos do YouTube de até
                60 segundos — o contrato da API não valida essa duração, é só um aviso.
              </p>
            </div>
          )}

          {effectiveType === "DOCUMENT" && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="training-document-url">URL do documento</Label>
                <Input
                  id="training-document-url"
                  value={documentUrl}
                  onChange={(event) => setDocumentUrl(event.target.value)}
                  placeholder="https://.../arquivo.pdf"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="training-document-name">Nome do documento</Label>
                <Input
                  id="training-document-name"
                  value={documentName}
                  onChange={(event) => setDocumentName(event.target.value)}
                  placeholder="Manual de vendas.pdf"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="training-document-mimetype">Tipo MIME</Label>
                <Input
                  id="training-document-mimetype"
                  value={documentMimetype}
                  onChange={(event) => setDocumentMimetype(event.target.value)}
                  placeholder="application/pdf"
                />
              </div>
              <p className="text-caption text-muted-foreground">
                O provedor de agentes recebe o documento por URL — esta tela não faz upload de
                arquivo nem converte PDF localmente.
              </p>
            </>
          )}

          {mode === "create" && (
            <p className="text-caption text-muted-foreground">
              O acompanhamento do processamento é automático: o CRM IA recebe a notificação do
              provedor de agentes quando o treinamento termina, sem nada para configurar aqui.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            Cancelar
          </Button>
          <Button onClick={handleSubmit} disabled={mutation.isPending || !isValid}>
            {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
            {mode === "edit" ? "Salvar" : "Adicionar treinamento"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
