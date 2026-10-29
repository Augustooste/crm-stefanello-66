import { useState } from "react";
import { MapPin, Video } from "lucide-react";
import { Card } from "@/components/ui/card";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import type { AppointmentRow } from "@/lib/api/appointments";

const HOURS = [
  "08:00",
  "09:00",
  "10:00",
  "11:00",
  "12:00",
  "13:00",
  "14:00",
  "15:00",
  "16:00",
  "17:00",
  "18:00",
  "19:00",
];

const DAYS = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];

interface WeeklyCalendarProps {
  weekStart: Date;
  appointments: AppointmentRow[];
  appointmentLabel: string;
  onSelectAppointment: (appointment: AppointmentRow) => void;
}

function dayAt(weekStart: Date, offset: number): Date {
  const d = new Date(weekStart);
  d.setDate(d.getDate() + offset);
  return d;
}

function dateKey(d: Date): string {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

function slotKey(dateStr: string, hour: string): string {
  return `${dateStr}-${hour}`;
}

/**
 * Bucketiza time_start ("HH:MM" ou "HH:MM:SS") na hora cheia (a grade só tem
 * uma linha por hora, não por minuto). Compromissos fora da hora cheia
 * (entrada manual sem `step` no input de horário, ou qualquer agendamento
 * sincronizado por adapter externo -- ex.: Feegow, cujos horários reais
 * raramente caem em HH:00) continuam visíveis, agrupados na linha da hora em
 * que começam.
 */
function hourBucket(timeStart: string): string {
  return `${timeStart.slice(0, 2)}:00`;
}

function AppointmentChip({
  appointment,
  onSelect,
}: {
  appointment: AppointmentRow;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="group/apt w-full rounded-md border border-primary/30 bg-primary/10 p-2 text-left transition-colors hover:bg-primary/20"
    >
      <div className="flex items-center justify-between gap-1">
        <p className="truncate text-caption font-bold text-foreground">{appointment.title}</p>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
          {appointment.time_start.slice(0, 5)}
        </span>
      </div>
      <div className="mt-1 flex items-center text-[10px] text-primary">
        {appointment.modality === "presencial" ? (
          <MapPin className="mr-1 h-3 w-3" />
        ) : (
          <Video className="mr-1 h-3 w-3" />
        )}
        {appointment.modality === "presencial" ? "Presencial" : "Online"}
      </div>
    </button>
  );
}

export function WeeklyCalendar({
  weekStart,
  appointments,
  appointmentLabel,
  onSelectAppointment,
}: WeeklyCalendarProps) {
  const isMobile = useIsMobile();
  const today = new Date().toDateString();

  const [activeDayIndex, setActiveDayIndex] = useState(() => {
    const todayDate = new Date().toDateString();
    const idx = DAYS.findIndex((_, i) => dayAt(weekStart, i).toDateString() === todayDate);
    return idx >= 0 ? idx : 0;
  });

  const bySlot = new Map<string, AppointmentRow[]>();
  for (const appt of appointments) {
    const key = slotKey(appt.date, hourBucket(appt.time_start));
    const bucket = bySlot.get(key);
    if (bucket) bucket.push(appt);
    else bySlot.set(key, [appt]);
  }
  for (const bucket of bySlot.values()) {
    bucket.sort((a, b) => a.time_start.localeCompare(b.time_start));
  }

  if (isMobile) {
    const activeDay = dayAt(weekStart, activeDayIndex);
    const activeDateKey = dateKey(activeDay);

    return (
      <Card className="flex flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 gap-2 overflow-x-auto border-b border-border bg-muted/30 px-3 py-2">
          {DAYS.map((day, i) => {
            const d = dayAt(weekStart, i);
            const isToday = d.toDateString() === today;
            const isActive = i === activeDayIndex;
            return (
              <button
                key={day}
                type="button"
                onClick={() => setActiveDayIndex(i)}
                className={cn(
                  "flex shrink-0 flex-col items-center rounded-xl px-3 py-1.5 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : isToday
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-muted",
                )}
              >
                <span className="text-caption">{day}</span>
                <span className="text-base font-bold">{d.getDate()}</span>
              </button>
            );
          })}
        </div>

        <div className="flex-1 overflow-y-auto">
          {HOURS.map((hour) => {
            const slotAppointments = bySlot.get(slotKey(activeDateKey, hour)) ?? [];
            return (
              <div key={hour} className="flex border-b border-border/30">
                <div className="w-16 shrink-0 border-r border-border bg-muted/10 p-3 text-center text-sm font-medium text-muted-foreground">
                  {hour}
                </div>
                <div className="flex min-h-[72px] flex-1 flex-col gap-1 p-1 transition-colors hover:bg-muted/20">
                  {slotAppointments.map((appt) => (
                    <AppointmentChip
                      key={appt.id}
                      appointment={appt}
                      onSelect={() => onSelectAppointment(appt)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    );
  }

  return (
    <Card className="flex flex-1 flex-col overflow-hidden">
      <div className="grid grid-cols-8 border-b border-border bg-muted/30 text-sm font-medium text-muted-foreground">
        <div className="border-r border-border p-4 text-center">{appointmentLabel}</div>
        {DAYS.map((day, i) => {
          const d = dayAt(weekStart, i);
          const isToday = d.toDateString() === today;
          return (
            <div
              key={day}
              className="flex flex-col items-center border-r border-border p-4 text-center"
            >
              <span>{day}</span>
              <span
                className={cn(
                  "mt-1 text-lead font-bold text-foreground",
                  isToday && "text-primary",
                )}
              >
                {d.getDate()}
              </span>
            </div>
          );
        })}
      </div>

      <div className="flex-1 overflow-y-auto">
        {HOURS.map((hour) => (
          <div key={hour} className="grid grid-cols-8 border-b border-border/30">
            <div className="border-r border-border bg-muted/10 p-3 text-center text-sm font-medium text-muted-foreground">
              {hour}
            </div>
            {DAYS.map((day, dayIdx) => {
              const d = dayAt(weekStart, dayIdx);
              const slotAppointments = bySlot.get(slotKey(dateKey(d), hour)) ?? [];
              return (
                <div
                  key={day}
                  className="flex min-h-[80px] flex-col gap-1 border-r border-border/30 p-1 transition-colors hover:bg-muted/20"
                >
                  {slotAppointments.map((appt) => (
                    <AppointmentChip
                      key={appt.id}
                      appointment={appt}
                      onSelect={() => onSelectAppointment(appt)}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </Card>
  );
}
