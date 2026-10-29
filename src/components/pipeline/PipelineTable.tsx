import { StatusBadge } from "@/components/common/StatusBadge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCustomFieldValue, type CustomFieldColumn } from "@/lib/custom-field-display";
import {
  ACTIVITY_STATUS_LABEL,
  ACTIVITY_STATUS_VARIANT,
  type ActivityStatus,
} from "@/lib/deal-health";
import { formatBRL } from "@/lib/format";
import { cn } from "@/lib/utils";

export type PipelineTableStage = {
  id: string;
  name: string;
  is_won: boolean;
  is_lost: boolean;
};

/**
 * Linha já "achatada" pro consumo da tabela — sinais de saúde (isHot/rotting
 * /activityStatus) e nomes resolvidos (dono/empresa) vêm prontos de
 * `_app.pipeline.tsx` (`computeDealHealthSignals`, `ownerNameById`,
 * `companyNameById`), a mesma fonte usada pelo card do kanban. A tabela só
 * renderiza, não recalcula saúde nem resolve nomes.
 */
export type PipelineTableRow = {
  id: string;
  title: string;
  value: number | null;
  stageId: string;
  ownerName: string | null;
  companyName: string | null;
  isHot: boolean;
  rotting: boolean;
  activityStatus: ActivityStatus | null;
  customFieldValues: Record<string, unknown>;
};

export interface PipelineTableProps {
  stages: PipelineTableStage[];
  rows: PipelineTableRow[];
  customFieldDefs: CustomFieldColumn[];
  showCompanyColumn: boolean;
  highlightDealId: string | null;
  /** Mesmo mecanismo "Mover para…" do card do kanban — ver `handleMoveToStage` em _app.pipeline.tsx. */
  onMoveDeal: (dealId: string, stageId: string) => void;
}

const STAGE_BADGE_TONE = {
  won: "bg-success/12 text-success border-success/25",
  lost: "bg-destructive/12 text-destructive border-destructive/25",
  open: "bg-muted text-muted-foreground border-border",
} as const;

function stageTone(stage: PipelineTableStage | undefined): string {
  if (!stage) return STAGE_BADGE_TONE.open;
  if (stage.is_won) return STAGE_BADGE_TONE.won;
  if (stage.is_lost) return STAGE_BADGE_TONE.lost;
  return STAGE_BADGE_TONE.open;
}

/**
 * Visão em tabela do pipeline — alternativa densa ao kanban (Column/
 * DraggableCard em _app.pipeline.tsx) pra quem prefere escanear o funil em
 * lista. Mesmos dados/filtros/mutations da rota, só a apresentação muda.
 */
export function PipelineTable({
  stages,
  rows,
  customFieldDefs,
  showCompanyColumn,
  highlightDealId,
  onMoveDeal,
}: PipelineTableProps) {
  const stageById = new Map(stages.map((s) => [s.id, s]));

  if (rows.length === 0) {
    return (
      <div className="flex min-h-[200px] items-center justify-center rounded-lg border border-dashed border-border p-6 text-center text-caption text-muted-foreground">
        Nenhum negócio encontrado com os filtros atuais
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Negócio</TableHead>
            {showCompanyColumn && <TableHead>Empresa</TableHead>}
            <TableHead>Estágio</TableHead>
            <TableHead className="text-right">Valor</TableHead>
            <TableHead>Dono</TableHead>
            {customFieldDefs.map((def) => (
              <TableHead key={def.key} className="text-right">
                {def.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const stage = stageById.get(row.stageId);
            const otherStages = stages.filter((s) => s.id !== row.stageId);
            return (
              <TableRow
                key={row.id}
                data-deal-id={row.id}
                className={cn(highlightDealId === row.id && "ring-2 ring-primary ring-inset")}
              >
                <TableCell>
                  <div className="flex flex-col gap-1">
                    <span className="font-medium text-foreground">{row.title}</span>
                    {(row.isHot || row.rotting || row.activityStatus) && (
                      <div className="flex flex-wrap gap-1">
                        {row.isHot && <StatusBadge variant="success">Lead quente</StatusBadge>}
                        {row.rotting && (
                          <StatusBadge variant="destructive">Parado (+10d)</StatusBadge>
                        )}
                        {row.activityStatus && (
                          <StatusBadge variant={ACTIVITY_STATUS_VARIANT[row.activityStatus]}>
                            {ACTIVITY_STATUS_LABEL[row.activityStatus]}
                          </StatusBadge>
                        )}
                      </div>
                    )}
                  </div>
                </TableCell>
                {showCompanyColumn && (
                  <TableCell className="text-muted-foreground">{row.companyName ?? "—"}</TableCell>
                )}
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        aria-label={`Estágio de ${row.title}: ${stage?.name ?? "—"} — mover para outra etapa`}
                        className={cn(
                          "inline-flex items-center rounded-md border px-2 py-0.5 text-caption font-medium transition-opacity hover:opacity-80",
                          stageTone(stage),
                        )}
                      >
                        {stage?.name ?? "—"}
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuLabel>Mover para…</DropdownMenuLabel>
                      {otherStages.map((s) => (
                        <DropdownMenuItem key={s.id} onClick={() => onMoveDeal(row.id, s.id)}>
                          {s.name}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
                <TableCell className="text-right font-semibold text-primary">
                  {formatBRL(Number(row.value ?? 0))}
                </TableCell>
                <TableCell className="text-muted-foreground">{row.ownerName ?? "—"}</TableCell>
                {customFieldDefs.map((def) => (
                  <TableCell key={def.key} className="text-right text-muted-foreground">
                    {formatCustomFieldValue(def, row.customFieldValues[def.key])}
                  </TableCell>
                ))}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
