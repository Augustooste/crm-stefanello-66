import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreVertical, Plus, Target } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";

export type Board = {
  id: string;
  name: string;
  is_default: boolean;
  position: number;
  /** Meta de negócios ativos (status=open) pro board; null/undefined = sem meta. */
  goal_target?: number | null;
  /** Cadência da meta, só rótulo (weekly/monthly/quarterly/yearly); não filtra a métrica. */
  goal_period?: string | null;
};

/** Rótulos PT-BR da cadência da meta — puramente informativo, não afeta o cálculo. */
const GOAL_PERIOD_LABEL: Record<string, string> = {
  weekly: "semanal",
  monthly: "mensal",
  quarterly: "trimestral",
  yearly: "anual",
};

const GOAL_PERIOD_NONE = "none";

/** Etapas padrão semeadas em todo quadro novo — mesmo modelo do onboarding. */
const DEFAULT_STAGE_TEMPLATE = [
  { name: "Novo", is_won: false, is_lost: false },
  { name: "Contatado", is_won: false, is_lost: false },
  { name: "Proposta", is_won: false, is_lost: false },
  { name: "Ganho", is_won: true, is_lost: false },
  { name: "Perdido", is_won: false, is_lost: true },
] as const;

/** Chave por tenant — evita vazar o board selecionado de um tenant pra outro ao trocar de conta. */
export function boardStorageKey(tenantId: string): string {
  return `aceleraflow.pipeline.board-id:${tenantId}`;
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

interface BoardSwitcherProps {
  tenantId: string | undefined;
  isAdmin: boolean;
  boards: Board[];
  boardsLoading: boolean;
  selectedBoardId: string | undefined;
  onSelect: (boardId: string) => void;
  /** Quantidade de negócios ativos (status=open) no quadro selecionado, pra barra de progresso da meta. */
  activeDealsCount?: number;
}

/** Seletor de quadro (board) do pipeline + gestão (criar/renomear/remover/meta), restrita a admins. */
export function BoardSwitcher({
  tenantId,
  isAdmin,
  boards,
  boardsLoading,
  selectedBoardId,
  onSelect,
  activeDealsCount = 0,
}: BoardSwitcherProps) {
  const qc = useQueryClient();
  const [openNew, setOpenNew] = useState(false);
  const [openRename, setOpenRename] = useState(false);
  const [openDelete, setOpenDelete] = useState(false);
  const [openGoal, setOpenGoal] = useState(false);
  const [name, setName] = useState("");
  const [goalTarget, setGoalTarget] = useState("");
  const [goalPeriod, setGoalPeriod] = useState(GOAL_PERIOD_NONE);

  const activeBoard = boards.find((b) => b.id === selectedBoardId);

  const handleSelect = (id: string) => {
    if (tenantId) localStorage.setItem(boardStorageKey(tenantId), id);
    onSelect(id);
  };

  const createMut = useMutation({
    mutationFn: async (boardName: string) => {
      if (!tenantId) throw new Error("Empresa não identificada.");
      const { data: board, error } = await supabase
        .from("boards")
        .insert({ tenant_id: tenantId, name: boardName, position: boards.length })
        .select("id")
        .single();
      if (error) throw error;
      const { error: stagesError } = await supabase.from("board_stages").insert(
        DEFAULT_STAGE_TEMPLATE.map((stage, i) => ({
          board_id: board.id,
          name: stage.name,
          position: i,
          is_won: stage.is_won,
          is_lost: stage.is_lost,
        })),
      );
      if (stagesError) {
        // Sem etapas o quadro fica órfão e inutilizável; melhor remover que
        // deixar um quadro vazio listado no seletor.
        const { error: rollbackError } = await supabase.from("boards").delete().eq("id", board.id);
        if (rollbackError) {
          // Limpeza automática também falhou: o quadro órfão persiste, então
          // o usuário precisa saber explicitamente (não dá pra engolir).
          throw new Error(
            `Não foi possível criar as etapas, e a limpeza automática do quadro "${boardName}" também falhou — ele pode ter ficado listado sem etapas. Remova manualmente se necessário.`,
          );
        }
        throw stagesError;
      }
      return board.id as string;
    },
    onSuccess: (boardId) => {
      qc.invalidateQueries({ queryKey: ["boards", tenantId] });
      handleSelect(boardId);
      setOpenNew(false);
      setName("");
      toast.success("Quadro criado.");
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error, "Não foi possível criar o quadro."));
    },
  });

  const renameMut = useMutation({
    mutationFn: async (boardName: string) => {
      if (!activeBoard) throw new Error("Nenhum quadro selecionado.");
      const { error } = await supabase
        .from("boards")
        .update({ name: boardName })
        .eq("id", activeBoard.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["boards", tenantId] });
      setOpenRename(false);
      toast.success("Quadro renomeado.");
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error, "Não foi possível renomear o quadro."));
    },
  });

  const deleteMut = useMutation({
    mutationFn: async () => {
      if (!activeBoard) throw new Error("Nenhum quadro selecionado.");
      const { error } = await supabase.from("boards").delete().eq("id", activeBoard.id);
      if (error) throw error;
    },
    onSuccess: () => {
      const fallback = boards.find((b) => b.id !== activeBoard?.id);
      qc.invalidateQueries({ queryKey: ["boards", tenantId] });
      setOpenDelete(false);
      toast.success("Quadro removido.");
      if (fallback) handleSelect(fallback.id);
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error, "Não foi possível remover o quadro."));
    },
  });

  const goalMut = useMutation({
    mutationFn: async ({ target, period }: { target: number | null; period: string | null }) => {
      if (!activeBoard) throw new Error("Nenhum quadro selecionado.");
      const { error } = await supabase
        .from("boards")
        .update({ goal_target: target, goal_period: period })
        .eq("id", activeBoard.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["boards", tenantId] });
      setOpenGoal(false);
      toast.success("Meta do quadro atualizada.");
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error, "Não foi possível atualizar a meta do quadro."));
    },
  });

  if (boardsLoading || boards.length === 0) return null;

  const goalTargetNumber = activeBoard?.goal_target ?? null;
  const goalProgressPercent =
    goalTargetNumber && goalTargetNumber > 0
      ? Math.min(100, Math.round((activeDealsCount / goalTargetNumber) * 100))
      : 0;
  const goalPeriodLabel = activeBoard?.goal_period
    ? GOAL_PERIOD_LABEL[activeBoard.goal_period]
    : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1">
        <Select value={selectedBoardId} onValueChange={handleSelect}>
          <SelectTrigger className="h-9 w-[220px]" aria-label="Selecionar quadro">
            <SelectValue placeholder="Selecione um quadro" />
          </SelectTrigger>
          <SelectContent>
            {boards.map((b) => (
              <SelectItem key={b.id} value={b.id}>
                {b.name}
                {b.is_default ? " (padrão)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {isAdmin && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Gerenciar quadros">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => {
                  setName("");
                  setOpenNew(true);
                }}
              >
                <Plus className="mr-2 h-4 w-4" /> Novo quadro
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!activeBoard}
                onSelect={() => {
                  setName(activeBoard?.name ?? "");
                  setOpenRename(true);
                }}
              >
                Renomear quadro
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!activeBoard}
                onSelect={() => {
                  setGoalTarget(activeBoard?.goal_target ? String(activeBoard.goal_target) : "");
                  setGoalPeriod(activeBoard?.goal_period ?? GOAL_PERIOD_NONE);
                  setOpenGoal(true);
                }}
              >
                <Target className="mr-2 h-4 w-4" /> Editar meta
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!activeBoard || activeBoard.is_default}
                onSelect={() => setOpenDelete(true)}
                className="text-destructive focus:text-destructive"
              >
                Remover quadro
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {goalTargetNumber !== null && (
        <div className="flex w-[220px] flex-col gap-1" aria-label="Progresso da meta do quadro">
          <div className="flex items-center justify-between text-caption text-muted-foreground">
            <span>
              Objetivo{goalPeriodLabel ? ` (${goalPeriodLabel})` : ""}: {activeDealsCount}/
              {goalTargetNumber}
            </span>
            <span>{goalProgressPercent}%</span>
          </div>
          <Progress value={goalProgressPercent} className="h-1.5" />
        </div>
      )}

      <Dialog open={openNew} onOpenChange={setOpenNew}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Novo quadro</DialogTitle>
            <DialogDescription>
              Cria um funil separado com as etapas padrão (Novo, Contatado, Proposta, Ganho,
              Perdido).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="new-board-name">Nome do quadro</Label>
            <Input
              id="new-board-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex.: Pós-venda"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenNew(false)}>
              Cancelar
            </Button>
            <Button
              disabled={!name.trim() || createMut.isPending}
              onClick={() => createMut.mutate(name.trim())}
            >
              Criar quadro
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={openRename} onOpenChange={setOpenRename}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Renomear quadro</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="rename-board-name">Nome do quadro</Label>
            <Input id="rename-board-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenRename(false)}>
              Cancelar
            </Button>
            <Button
              disabled={!name.trim() || renameMut.isPending}
              onClick={() => renameMut.mutate(name.trim())}
            >
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={openDelete} onOpenChange={setOpenDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remover quadro</DialogTitle>
            <DialogDescription>
              Todos os negócios de &ldquo;{activeBoard?.name}&rdquo; serão removidos junto com o
              quadro. Esta ação não pode ser desfeita.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenDelete(false)}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              disabled={deleteMut.isPending}
              onClick={() => deleteMut.mutate()}
            >
              Remover
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={openGoal} onOpenChange={setOpenGoal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Editar meta do quadro</DialogTitle>
            <DialogDescription>
              Meta de negócios ativos (em aberto) pro quadro &ldquo;{activeBoard?.name}&rdquo;.
              Deixe em branco pra remover a meta.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="goal-target">Quantidade de negócios ativos</Label>
              <Input
                id="goal-target"
                type="number"
                min={1}
                value={goalTarget}
                onChange={(e) => setGoalTarget(e.target.value)}
                placeholder="Ex.: 50"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="goal-period">Cadência (opcional, só rótulo)</Label>
              <Select value={goalPeriod} onValueChange={setGoalPeriod}>
                <SelectTrigger id="goal-period" className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={GOAL_PERIOD_NONE}>Sem cadência</SelectItem>
                  <SelectItem value="weekly">Semanal</SelectItem>
                  <SelectItem value="monthly">Mensal</SelectItem>
                  <SelectItem value="quarterly">Trimestral</SelectItem>
                  <SelectItem value="yearly">Anual</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenGoal(false)}>
              Cancelar
            </Button>
            <Button
              disabled={goalMut.isPending}
              onClick={() => {
                const trimmed = goalTarget.trim();
                const parsed = trimmed ? Number(trimmed) : null;
                if (parsed !== null && (!Number.isFinite(parsed) || parsed <= 0)) {
                  toast.error("Meta deve ser um número maior que zero.");
                  return;
                }
                goalMut.mutate({
                  target: parsed !== null ? Math.floor(parsed) : null,
                  period: goalPeriod === GOAL_PERIOD_NONE ? null : goalPeriod,
                });
              }}
            >
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
