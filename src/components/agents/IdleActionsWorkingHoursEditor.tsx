// Editor de horários de funcionamento de uma ação de inatividade.
//
// ACHADO (fora de D1-D14): o GET de `idle-actions` devolve `workingHours` como
// OBJETO com `days[]` aninhado (cada dia com `hours[]` cheio de metadados
// tenant/createdAt/sequence); o POST/PUT esperam `workingHours` como ARRAY de
// dias direto, só com `dayWeek`/`active`/`hours[{start,end}]`. As duas formas
// não são espelhadas — CONTRACT_MATRIX.md §1.10 só documenta a forma do PUT.
// Este editor trabalha só com a forma "achatada" (array de 7 dias fixos);
// `IdleActionsSection` faz a conversão nos dois sentidos.
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface EditableHourRange {
  start: string;
  end: string;
}

export interface EditableWorkingDay {
  dayWeek: number;
  active: boolean;
  hours: EditableHourRange[];
}

const DAY_LABELS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

export function createDefaultWorkingDays(): EditableWorkingDay[] {
  return DAY_LABELS.map((_, dayWeek) => ({
    dayWeek,
    active: false,
    hours: [{ start: "", end: "" }],
  }));
}

export function IdleActionsWorkingHoursEditor({
  days,
  onChange,
  idPrefix,
}: {
  days: EditableWorkingDay[];
  onChange: (days: EditableWorkingDay[]) => void;
  idPrefix: string;
}) {
  function updateDay(dayWeek: number, patch: Partial<EditableWorkingDay>) {
    onChange(days.map((d) => (d.dayWeek === dayWeek ? { ...d, ...patch } : d)));
  }

  function updateHour(dayWeek: number, patch: Partial<EditableHourRange>) {
    onChange(
      days.map((d) => (d.dayWeek === dayWeek ? { ...d, hours: [{ ...d.hours[0], ...patch }] } : d)),
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <p className="text-caption text-muted-foreground">
        Marque os dias e o horário em que esta ação pode ser executada (um período por dia).
      </p>
      {days.map((d) => (
        <div key={d.dayWeek} className="flex flex-wrap items-center gap-2">
          <label className="flex w-32 shrink-0 items-center gap-2 text-body text-foreground">
            <input
              type="checkbox"
              checked={d.active}
              onChange={(e) => updateDay(d.dayWeek, { active: e.target.checked })}
              aria-label={DAY_LABELS[d.dayWeek]}
            />
            {DAY_LABELS[d.dayWeek]}
          </label>
          <div className="flex items-center gap-1.5">
            <Label htmlFor={`${idPrefix}-${d.dayWeek}-start`} className="sr-only">
              Início em {DAY_LABELS[d.dayWeek]}
            </Label>
            <Input
              id={`${idPrefix}-${d.dayWeek}-start`}
              type="time"
              className="w-28"
              disabled={!d.active}
              value={d.hours[0]?.start ?? ""}
              onChange={(e) => updateHour(d.dayWeek, { start: e.target.value })}
            />
            <span className="text-caption text-muted-foreground">até</span>
            <Label htmlFor={`${idPrefix}-${d.dayWeek}-end`} className="sr-only">
              Fim em {DAY_LABELS[d.dayWeek]}
            </Label>
            <Input
              id={`${idPrefix}-${d.dayWeek}-end`}
              type="time"
              className="w-28"
              disabled={!d.active}
              value={d.hours[0]?.end ?? ""}
              onChange={(e) => updateHour(d.dayWeek, { end: e.target.value })}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
