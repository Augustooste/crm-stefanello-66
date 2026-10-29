import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTenantProfiles } from "@/lib/api/session";
import { useBoards } from "@/lib/api/boards";

/**
 * Barra de filtro do dashboard rico (Épico C): responsável + quadro (board);
 * o período é global (topbar, useGlobalPeriod). O estado é levantado em
 * `_app.app.tsx` e passado por props aos indicadores do topo e aos cards que
 * recebem `ownerId`/`boardId` — cada um decide se usa o período (janelas como
 * receita/taxa de ganho) ou é snapshot do estado atual (funil aberto, saúde
 * da carteira), e todos esses aplicam responsável e quadro.
 */

export type DashboardPeriodKey = "today" | "7" | "30" | "month";

export const DASHBOARD_PERIODS: Array<{ key: DashboardPeriodKey; label: string }> = [
  { key: "today", label: "Hoje" },
  { key: "7", label: "Últimos 7 dias" },
  { key: "30", label: "Últimos 30 dias" },
  { key: "month", label: "Este mês" },
];

export function dashboardPeriodRange(key: DashboardPeriodKey): { from: Date; to: Date } {
  const to = new Date();
  const from = new Date();
  if (key === "today") {
    from.setHours(0, 0, 0, 0);
  } else if (key === "7") {
    from.setDate(from.getDate() - 7);
  } else if (key === "30") {
    from.setDate(from.getDate() - 30);
  } else {
    from.setDate(1);
    from.setHours(0, 0, 0, 0);
  }
  return { from, to };
}

export function DashboardFilters({
  period,
  onPeriodChange,
  ownerId,
  onOwnerChange,
  boardId,
  onBoardChange,
}: {
  // Período agora é global (topbar). Só renderiza o seletor local se ambos
  // `period` e `onPeriodChange` forem passados — mantido para testes / uso
  // isolado. No Dashboard atual, o período vem de useGlobalPeriod().
  period?: DashboardPeriodKey;
  onPeriodChange?: (period: DashboardPeriodKey) => void;
  ownerId: string | null;
  onOwnerChange: (ownerId: string | null) => void;
  boardId: string | null;
  onBoardChange: (boardId: string | null) => void;
}) {
  const profilesQ = useTenantProfiles();
  const boardsQ = useBoards();
  const boards = boardsQ.data ?? [];

  return (
    <div className="flex flex-wrap items-center gap-3" aria-label="Filtros da visão geral">
      {period !== undefined && onPeriodChange && (
        <Select value={period} onValueChange={(v) => onPeriodChange(v as DashboardPeriodKey)}>
          <SelectTrigger className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DASHBOARD_PERIODS.map((p) => (
              <SelectItem key={p.key} value={p.key}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <Select value={ownerId ?? "all"} onValueChange={(v) => onOwnerChange(v === "all" ? null : v)}>
        <SelectTrigger className="w-[200px]">
          <SelectValue placeholder="Todos os responsáveis" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Todos os responsáveis</SelectItem>
          {(profilesQ.data ?? []).map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Só faz sentido oferecer o filtro com 2+ quadros -- com 1 só (caso
          comum hoje), "Todos os quadros" e o único quadro são a mesma coisa. */}
      {boards.length > 1 && (
        <Select
          value={boardId ?? "all"}
          onValueChange={(v) => onBoardChange(v === "all" ? null : v)}
        >
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Todos os quadros" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os quadros</SelectItem>
            {boards.map((b) => (
              <SelectItem key={b.id} value={b.id}>
                {b.name}
                {b.is_default ? " (padrão)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
