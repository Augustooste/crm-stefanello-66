import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { GripVertical, Pencil, Plus, Trash2, ArrowUp, ArrowDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/common/EmptyState";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { transitionDealStage } from "@/lib/api/pipeline-automation";
import { userFacingErrorMessage } from "@/lib/integrations/friendly-errors";

type Stage = {
  id: string;
  name: string;
  position: number;
  is_won: boolean;
  is_lost: boolean;
  board_id: string;
};

export function StagesTab() {
  const qc = useQueryClient();

  const boardQ = useQuery({
    queryKey: ["default-board"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("boards")
        .select("id, name")
        .eq("is_default", true)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const stagesQ = useQuery({
    queryKey: ["board-stages", boardQ.data?.id],
    enabled: !!boardQ.data?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("board_stages")
        .select("id, name, position, is_won, is_lost, board_id")
        .eq("board_id", boardQ.data!.id)
        .order("position");
      if (error) throw error;
      return (data ?? []) as Stage[];
    },
  });

  const [openForm, setOpenForm] = useState<{ stage?: Stage } | null>(null);
  const [deleting, setDeleting] = useState<Stage | null>(null);
  const [moveTarget, setMoveTarget] = useState<string>("");

  const reorderMut = useMutation({
    mutationFn: async ({ id, position }: { id: string; position: number }) => {
      const { error } = await supabase.from("board_stages").update({ position }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["board-stages"] });
      qc.invalidateQueries({ queryKey: ["deals"] });
    },
    onError: (e: Error) => toast.error(userFacingErrorMessage(e, "Erro ao reordenar")),
  });

  const dealsCountQ = useQuery({
    queryKey: ["deals-count-in-stage", deleting?.id],
    enabled: !!deleting?.id,
    queryFn: async () => {
      const { count, error } = await supabase
        .from("deals")
        .select("id", { count: "exact", head: true })
        .eq("stage_id", deleting!.id);
      if (error) throw error;
      return count ?? 0;
    },
  });

  const deleteMut = useMutation({
    mutationFn: async ({ stage, moveTo }: { stage: Stage; moveTo: string | null }) => {
      if (moveTo) {
        const { data: deals, error: dealsError } = await supabase
          .from("deals")
          .select("id, stage_id")
          .eq("stage_id", stage.id);
        if (dealsError) throw dealsError;
        await Promise.all(
          (deals ?? []).map((deal) =>
            transitionDealStage({
              dealId: deal.id,
              expectedStageId: deal.stage_id,
              targetStageId: moveTo,
              reason: `Remanejamento antes de excluir a etapa ${stage.name}`,
              evidence: { source: "settings.stage_delete" },
              idempotencyKey: `stage-delete:${stage.id}:${moveTo}:${deal.id}`,
            }),
          ),
        );
      }
      const { error } = await supabase.from("board_stages").delete().eq("id", stage.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["board-stages"] });
      qc.invalidateQueries({ queryKey: ["deals"] });
      toast.success("Etapa removida");
      setDeleting(null);
      setMoveTarget("");
    },
    onError: (e: Error) => toast.error(userFacingErrorMessage(e, "Erro ao remover")),
  });

  if (boardQ.isLoading) return <Skeleton className="h-64 w-full" />;
  if (!boardQ.data) {
    return (
      <EmptyState
        title="Nenhum funil configurado"
        description="Seu funil será criado no primeiro acesso, no assistente de primeiros passos."
      />
    );
  }

  const stages = stagesQ.data ?? [];
  const move = (index: number, dir: -1 | 1) => {
    const a = stages[index],
      b = stages[index + dir];
    if (!a || !b) return;
    reorderMut.mutate({ id: a.id, position: b.position });
    reorderMut.mutate({ id: b.id, position: a.position });
  };

  const otherStages = stages.filter((s) => s.id !== deleting?.id);
  const dealsCount = dealsCountQ.data ?? 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-card-title">Etapas do funil — {boardQ.data.name}</CardTitle>
        <Button size="sm" onClick={() => setOpenForm({})}>
          <Plus className="mr-1 h-4 w-4" /> Nova etapa
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {stagesQ.isLoading ? (
          <div className="p-4">
            <Skeleton className="h-24 w-full" />
          </div>
        ) : stages.length === 0 ? (
          <div className="p-6">
            <EmptyState title="Sem etapas" description="Adicione a primeira etapa do funil." />
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {stages.map((s, i) => (
              <li key={s.id} className="flex items-center gap-3 p-3">
                <div className="flex flex-col gap-0.5">
                  <button
                    className="text-muted-foreground disabled:opacity-30"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                    aria-label="Mover para cima"
                  >
                    <ArrowUp className="h-3 w-3" />
                  </button>
                  <button
                    className="text-muted-foreground disabled:opacity-30"
                    disabled={i === stages.length - 1}
                    onClick={() => move(i, 1)}
                    aria-label="Mover para baixo"
                  >
                    <ArrowDown className="h-3 w-3" />
                  </button>
                </div>
                <GripVertical className="h-4 w-4 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="text-body font-medium text-foreground">{s.name}</div>
                  <div className="text-caption text-muted-foreground">
                    {s.is_won
                      ? "Etapa de ganho"
                      : s.is_lost
                        ? "Etapa de perda"
                        : "Etapa intermediária"}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Editar ${s.name}`}
                  onClick={() => setOpenForm({ stage: s })}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Excluir ${s.name}`}
                  onClick={() => {
                    setDeleting(s);
                    setMoveTarget("");
                  }}
                >
                  <Trash2 className="h-4 w-4 text-muted-foreground" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {openForm && (
        <StageFormDialog
          open={!!openForm}
          onOpenChange={(v) => !v && setOpenForm(null)}
          stage={openForm.stage}
          boardId={boardQ.data.id}
          nextPosition={(stages[stages.length - 1]?.position ?? 0) + 1}
        />
      )}

      <AlertDialog
        open={!!deleting}
        onOpenChange={(v) => {
          if (!v) {
            setDeleting(null);
            setMoveTarget("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir etapa</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  Tem certeza que deseja excluir <strong>{deleting?.name}</strong>?
                </p>
                {dealsCount > 0 ? (
                  <>
                    <p>
                      Existem <strong>{dealsCount}</strong> negócio(s) nesta etapa. Escolha para
                      onde movê-los antes de excluir.
                    </p>
                    <Select value={moveTarget} onValueChange={setMoveTarget}>
                      <SelectTrigger>
                        <SelectValue placeholder="Selecione a nova etapa" />
                      </SelectTrigger>
                      <SelectContent>
                        {otherStages.map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </>
                ) : (
                  <p className="text-caption text-muted-foreground">Nenhum negócio nesta etapa.</p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancelar
            </Button>
            <Button
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteMut.isPending || (dealsCount > 0 && !moveTarget)}
              onClick={() =>
                deleting &&
                deleteMut.mutate({ stage: deleting, moveTo: dealsCount > 0 ? moveTarget : null })
              }
            >
              {deleteMut.isPending ? "Excluindo…" : "Excluir"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function StageFormDialog({
  open,
  onOpenChange,
  stage,
  boardId,
  nextPosition,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  stage?: Stage;
  boardId: string;
  nextPosition: number;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(stage?.name ?? "");
  const [kind, setKind] = useState<"normal" | "won" | "lost">(
    stage?.is_won ? "won" : stage?.is_lost ? "lost" : "normal",
  );

  const saveMut = useMutation({
    mutationFn: async () => {
      const payload = {
        name: name.trim(),
        is_won: kind === "won",
        is_lost: kind === "lost",
      };
      if (stage) {
        const { error } = await supabase.from("board_stages").update(payload).eq("id", stage.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("board_stages")
          .insert({ ...payload, board_id: boardId, position: nextPosition });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["board-stages"] });
      qc.invalidateQueries({ queryKey: ["deals"] });
      toast.success(stage ? "Etapa atualizada" : "Etapa criada");
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(userFacingErrorMessage(e, "Erro ao salvar")),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{stage ? "Editar etapa" : "Nova etapa"}</DialogTitle>
          <DialogDescription>Configure o nome e o tipo da etapa.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="stage-name">Nome *</Label>
            <Input id="stage-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Tipo</Label>
            <label className="flex items-center gap-2 text-body cursor-pointer">
              <Checkbox
                checked={kind === "won"}
                onCheckedChange={(v) => setKind(v ? "won" : "normal")}
              />{" "}
              Etapa de ganho
            </label>
            <label className="flex items-center gap-2 text-body cursor-pointer">
              <Checkbox
                checked={kind === "lost"}
                onCheckedChange={(v) => setKind(v ? "lost" : "normal")}
              />{" "}
              Etapa de perda
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button disabled={!name.trim() || saveMut.isPending} onClick={() => saveMut.mutate()}>
            {saveMut.isPending ? "Salvando…" : "Salvar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
