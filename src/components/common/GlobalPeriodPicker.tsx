import { CalendarRange } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  PERIOD_OPTIONS,
  useGlobalPeriod,
  type PeriodKey,
} from "@/lib/view-prefs/use-global-period";

/**
 * Seletor global de período — vive no Topbar. A escolha só afeta a sessão
 * atual (sessionStorage). O Admin define o default do tenant em
 * Configurações → Visualização.
 */
export function GlobalPeriodPicker() {
  const { period, setPeriod } = useGlobalPeriod();
  const label = PERIOD_OPTIONS.find((o) => o.key === period)?.label;
  // Abaixo de sm o topbar não cabe em 390 px com o texto: o gatilho vira só ícone.
  return (
    <div className="flex items-center gap-2">
      <CalendarRange className="hidden h-4 w-4 text-muted-foreground sm:block" aria-hidden />
      <Select value={period} onValueChange={(v) => setPeriod(v as PeriodKey)}>
        <SelectTrigger
          className="h-9 w-auto gap-1 px-2 sm:w-[170px] sm:px-3"
          aria-label="Selecionar período do filtro global"
          title={label}
        >
          <CalendarRange
            className="h-4 w-4 shrink-0 text-muted-foreground sm:hidden"
            aria-hidden
            data-testid="period-picker-compact-icon"
          />
          {/* SelectValue do Radix ignora className: o sr-only vai no invólucro. */}
          <span className="max-sm:sr-only">
            <SelectValue />
          </span>
        </SelectTrigger>
        <SelectContent align="end">
          {PERIOD_OPTIONS.map((o) => (
            <SelectItem key={o.key} value={o.key}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
