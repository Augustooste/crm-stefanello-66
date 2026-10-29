import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { format } from "date-fns";
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
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { useAppointmentLabel } from "@/routes/_app.agenda";
import { useCreateAppointment } from "@/lib/api/appointments";
import { useCurrentProfile } from "@/lib/api/session";
import { enrollInManualNurtureSequence } from "@/lib/api/retornos";

// Fase 6, Sub-feature 4 (PRD linhas 2603-2617) -- "Retornos / recontatos
// agendados": não é tabela nem mecanismo novo, só cria uma `appointments`
// futura (Sub-feature 1) vinculada ao contato + tenta (best-effort) inscrever
// numa nurture_sequence manual (Fase 4).
const schema = z.object({
  date: z.string().min(1, "Data é obrigatória"),
  time: z.string().min(1, "Horário é obrigatório"),
  notes: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

const DEFAULT_TIME = "09:00";

/** Data default do formulário: amanhã -- um retorno agendado é sempre futuro. */
function defaultDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return format(d, "yyyy-MM-dd");
}

export function RetornoDialog({
  open,
  onOpenChange,
  contactId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  contactId: string;
}) {
  const appointmentLabel = useAppointmentLabel();
  const { data: profile } = useCurrentProfile();
  const createMut = useCreateAppointment();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { date: defaultDate(), time: DEFAULT_TIME, notes: "" },
  });

  const onSubmit = (data: FormValues) => {
    createMut.mutate(
      {
        contactId,
        title: appointmentLabel,
        date: data.date,
        timeStart: data.time,
        timeEnd: null,
        modality: "presencial",
        notes: data.notes || null,
      },
      {
        onSuccess: async () => {
          // Nurture: 100% best-effort, nunca bloqueia o sucesso do
          // agendamento -- ver enrollInManualNurtureSequence. Mas "best-effort"
          // não pode virar silêncio: sem sequência manual ativa a RPC devolve
          // false, o compromisso entra na agenda e o acompanhamento automático
          // simplesmente não acontece. A descrição do toast é o único lugar
          // onde o operador descobre isso.
          const inscrito = profile
            ? await enrollInManualNurtureSequence(supabase, {
                tenantId: profile.tenant_id,
                contactId,
                appointmentAt: new Date(`${data.date}T${data.time}:00`),
              })
            : false;
          toast.success(`${appointmentLabel} agendado`, {
            description: inscrito
              ? undefined
              : "O acompanhamento automático não foi iniciado: não há sequência manual ativa ou o contato já está inscrito em uma.",
          });
          reset();
          onOpenChange(false);
        },
        onError: (e: Error) =>
          toast.error(e.message ?? `Erro ao agendar ${appointmentLabel.toLowerCase()}`),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Agendar {appointmentLabel.toLowerCase()}</DialogTitle>
          <DialogDescription>
            Cria um novo compromisso futuro para este contato, visível na Agenda.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="retorno-date">Data *</Label>
              <Input
                id="retorno-date"
                type="date"
                {...register("date")}
                aria-invalid={!!errors.date}
              />
              {errors.date && (
                <p className="text-caption text-destructive">{errors.date.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="retorno-time">Horário</Label>
              <Input
                id="retorno-time"
                type="time"
                {...register("time")}
                aria-invalid={!!errors.time}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="retorno-notes">Observações</Label>
            <Textarea id="retorno-notes" {...register("notes")} rows={3} />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={createMut.isPending}>
              {createMut.isPending ? "Agendando…" : "Agendar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
