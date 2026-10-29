import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { AlertCircle, CalendarDays, ChevronLeft, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { PageHeader } from "@/components/common/PageHeader";
import { EmptyState } from "@/components/common/EmptyState";
import { WeeklyCalendar } from "@/components/agenda/WeeklyCalendar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { supabase } from "@/integrations/supabase/client";
import { requirePluginActive } from "@/lib/api/plugins";
import { useTenantOnboarding } from "@/lib/api/onboarding";
import {
  useAppointments,
  useCreateAppointment,
  useUpdateAppointment,
  useDeleteAppointment,
  type AppointmentRow,
  type AppointmentModality,
  type AppointmentStatus,
} from "@/lib/api/appointments";

export const Route = createFileRoute("/_app/agenda")({
  beforeLoad: ({ context }) => requirePluginActive(context.queryClient, "agenda"),
  head: () => ({
    meta: [
      { title: "Agenda" },
      {
        name: "description",
        content: "Agenda semanal de compromissos do seu negócio.",
      },
    ],
  }),
  component: AgendaPage,
});

const STATUS_LABEL: Record<AppointmentStatus, string> = {
  scheduled: "Agendado",
  confirmed: "Confirmado",
  completed: "Concluído",
  no_show: "Não compareceu",
  cancelled: "Cancelado",
  rescheduled: "Reagendado",
};

/** Rótulo customizável por tenant (business_profile.appointment_label) --
 * ex.: "Consulta" (clínica), "Visita" (imobiliária), "Aula experimental"
 * (academia). Nunca hardcoded -- ver PRD Sub-feature 1, critério de aceite.
 * Exportado (Fase 6, Sub-feature 4) -- reaproveitado pelo botão "Agendar
 * retorno" do detalhe do contato; nunca duplicar esta lógica lá. */
export function useAppointmentLabel(): string {
  const { data: tenant } = useTenantOnboarding();
  const businessProfile = tenant?.business_profile as unknown as Record<string, unknown> | null;
  const label = businessProfile?.appointment_label;
  return typeof label === "string" && label.trim() ? label : "Compromisso";
}

function getMonday(offsetWeeks: number): Date {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diff + offsetWeeks * 7);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function AgendaPage() {
  const [weekOffset, setWeekOffset] = useState(0);
  const [dialogAppointment, setDialogAppointment] = useState<AppointmentRow | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState<AppointmentRow | null>(null);

  const appointmentLabel = useAppointmentLabel();
  const weekStart = useMemo(() => getMonday(weekOffset), [weekOffset]);
  const weekEnd = useMemo(() => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + 6);
    return d;
  }, [weekStart]);
  const weekLabel = `${format(weekStart, "dd MMM", { locale: ptBR })} – ${format(weekEnd, "dd MMM yyyy", { locale: ptBR })}`;

  const appointmentsQ = useAppointments(weekStart);
  const deleteMut = useDeleteAppointment();

  const openCreate = () => {
    setDialogAppointment(null);
    setDialogOpen(true);
  };
  const openEdit = (appointment: AppointmentRow) => {
    setDialogAppointment(appointment);
    setDialogOpen(true);
  };

  return (
    <div className="col-span-12 flex h-full flex-col gap-4">
      <PageHeader
        title="Agenda"
        description={
          appointmentLabel.toLowerCase() === "compromisso"
            ? "Compromissos do seu negócio, semana a semana."
            : `Compromissos (${appointmentLabel.toLowerCase()}) do seu negócio, semana a semana.`
        }
        actions={
          <Button onClick={openCreate}>
            <Plus className="mr-1 h-4 w-4" /> Novo {appointmentLabel.toLowerCase()}
          </Button>
        }
      />

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            aria-label="Semana anterior"
            onClick={() => setWeekOffset((w) => w - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setWeekOffset(0)}>
            Hoje
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label="Próxima semana"
            onClick={() => setWeekOffset((w) => w + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <span className="text-body font-medium capitalize text-foreground">{weekLabel}</span>
      </div>

      {appointmentsQ.isLoading ? (
        <Skeleton className="h-[560px] w-full" />
      ) : appointmentsQ.isError ? (
        <Card>
          <CardContent className="flex items-center gap-2 py-6 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            {(appointmentsQ.error as Error).message}
          </CardContent>
        </Card>
      ) : appointmentsQ.data && appointmentsQ.data.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          title={`Nenhum ${appointmentLabel.toLowerCase()} nesta semana`}
          description="Crie o primeiro compromisso da semana."
          actionLabel={`Novo ${appointmentLabel.toLowerCase()}`}
          onAction={openCreate}
        />
      ) : (
        <WeeklyCalendar
          weekStart={weekStart}
          appointments={appointmentsQ.data ?? []}
          appointmentLabel={appointmentLabel}
          onSelectAppointment={openEdit}
        />
      )}

      <AppointmentDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        appointment={dialogAppointment}
        appointmentLabel={appointmentLabel}
        onRequestDelete={(appointment) => {
          setDialogOpen(false);
          setDeleting(appointment);
        }}
      />

      <AlertDialog open={!!deleting} onOpenChange={(v) => !v && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir {appointmentLabel.toLowerCase()}</AlertDialogTitle>
            <AlertDialogDescription>
              Tem certeza que deseja excluir <strong>{deleting?.title}</strong>? Esta ação não pode
              ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!deleting) return;
                deleteMut.mutate(deleting.id, {
                  onSuccess: () => {
                    toast.success(`${appointmentLabel} excluído`);
                    setDeleting(null);
                  },
                  onError: (e: Error) => toast.error(e.message ?? "Erro ao excluir"),
                });
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

const appointmentSchema = z.object({
  title: z.string().min(1, "Título é obrigatório"),
  contactId: z.string().optional(),
  date: z.string().min(1, "Data é obrigatória"),
  timeStart: z.string().min(1, "Horário é obrigatório"),
  timeEnd: z.string().optional(),
  modality: z.enum(["presencial", "online"]),
  status: z.enum(["scheduled", "confirmed", "completed", "no_show", "cancelled", "rescheduled"]),
  notes: z.string().optional(),
});
type AppointmentForm = z.infer<typeof appointmentSchema>;

function AppointmentDialog({
  open,
  onOpenChange,
  appointment,
  appointmentLabel,
  onRequestDelete,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  appointment: AppointmentRow | null;
  appointmentLabel: string;
  onRequestDelete: (appointment: AppointmentRow) => void;
}) {
  const isEditing = !!appointment;

  const contactsQ = useQuery({
    queryKey: ["contacts-min"],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("contacts")
        .select("id, name")
        .is("deleted_at", null)
        .order("name")
        .limit(500);
      if (error) throw error;
      return data ?? [];
    },
  });

  const createMut = useCreateAppointment();
  const updateMut = useUpdateAppointment();

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors },
  } = useForm<AppointmentForm>({
    resolver: zodResolver(appointmentSchema),
    values: {
      title: appointment?.title ?? "",
      contactId: appointment?.contact_id ?? "none",
      date: appointment?.date ?? format(new Date(), "yyyy-MM-dd"),
      timeStart: appointment?.time_start.slice(0, 5) ?? "10:00",
      timeEnd: appointment?.time_end?.slice(0, 5) ?? "",
      modality: appointment?.modality ?? "presencial",
      status: appointment?.status ?? "scheduled",
      notes: appointment?.notes ?? "",
    },
  });

  const modality = watch("modality");
  const status = watch("status");
  const contactId = watch("contactId") || "none";

  const isPending = createMut.isPending || updateMut.isPending;

  const onSubmit = (data: AppointmentForm) => {
    const input = {
      contactId: data.contactId && data.contactId !== "none" ? data.contactId : null,
      title: data.title,
      date: data.date,
      timeStart: data.timeStart,
      timeEnd: data.timeEnd || null,
      modality: data.modality as AppointmentModality,
      notes: data.notes || null,
    };

    const onSuccess = () => {
      toast.success(isEditing ? `${appointmentLabel} atualizado` : `${appointmentLabel} criado`);
      reset();
      onOpenChange(false);
    };
    const onError = (e: Error) =>
      toast.error(e.message ?? `Erro ao salvar ${appointmentLabel.toLowerCase()}`);

    if (isEditing && appointment) {
      updateMut.mutate(
        { ...input, id: appointment.id, status: data.status },
        { onSuccess, onError },
      );
    } else {
      createMut.mutate(input, { onSuccess, onError });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEditing
              ? `Editar ${appointmentLabel.toLowerCase()}`
              : `Novo ${appointmentLabel.toLowerCase()}`}
          </DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Atualize os dados deste compromisso."
              : "Agende um novo compromisso na sua agenda."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="title">Título *</Label>
            <Input id="title" {...register("title")} aria-invalid={!!errors.title} />
            {errors.title && (
              <p className="text-caption text-destructive">{errors.title.message}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="date">Data *</Label>
              <Input id="date" type="date" {...register("date")} aria-invalid={!!errors.date} />
            </div>
            <div className="space-y-1.5">
              <Label>Modalidade</Label>
              <Select
                value={modality}
                onValueChange={(v) => setValue("modality", v as AppointmentModality)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="presencial">Presencial</SelectItem>
                  <SelectItem value="online">Online</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="timeStart">Início *</Label>
              <Input id="timeStart" type="time" {...register("timeStart")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="timeEnd">Término</Label>
              <Input id="timeEnd" type="time" {...register("timeEnd")} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Contato</Label>
            <Select value={contactId} onValueChange={(v) => setValue("contactId", v)}>
              <SelectTrigger>
                <SelectValue placeholder="Selecionar…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Nenhum</SelectItem>
                {(contactsQ.data ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {isEditing && (
            <div className="space-y-1.5">
              <Label>Situação</Label>
              <Select
                value={status}
                onValueChange={(v) => setValue("status", v as AppointmentStatus)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(STATUS_LABEL).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="notes">Observações</Label>
            <Textarea id="notes" {...register("notes")} rows={3} />
          </div>

          <DialogFooter className="gap-2 sm:justify-between">
            {isEditing && appointment ? (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => onRequestDelete(appointment)}
              >
                <Trash2 className="mr-1 h-4 w-4" /> Excluir
              </Button>
            ) : (
              <div />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancelar
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending ? "Salvando…" : "Salvar"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
