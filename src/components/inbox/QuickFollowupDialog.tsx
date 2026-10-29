import { useState } from "react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Calendar as CalendarIcon } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCreateFollowup } from "@/hooks/use-followup-queue";
import { formatDate } from "@/lib/format";

const quickFollowupSchema = z.object({
  description: z.string().optional(),
  date: z.string().min(1),
  time: z.string().min(1),
});
type QuickFollowupForm = z.infer<typeof quickFollowupSchema>;

interface QuickFollowupDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  contactId: string;
  dealId: string | null;
  tenantId: string;
  createdBy: string;
}

/**
 * Criação manual de follow-up sempre disponível na conversa — o atalho de IA
 * (FollowUpSuggestionBanner) é opcional e pode não detectar nada; este botão
 * nunca deve depender da detecção (PRD, riscos/armadilhas #7).
 */
export function QuickFollowupDialog({
  open,
  onOpenChange,
  contactId,
  dealId,
  tenantId,
  createdBy,
}: QuickFollowupDialogProps) {
  const createFollowup = useCreateFollowup();
  const [date, setDate] = useState<Date | undefined>(new Date());

  const {
    register,
    handleSubmit,
    setValue,
    reset,
    formState: { errors },
  } = useForm<QuickFollowupForm>({
    resolver: zodResolver(quickFollowupSchema),
    defaultValues: {
      description: "",
      date: format(new Date(), "yyyy-MM-dd"),
      time: "10:00",
    },
  });

  const onSubmit = (data: QuickFollowupForm) => {
    const [h, m] = data.time.split(":").map(Number);
    const [yy, mm, dd] = data.date.split("-").map(Number);
    const scheduled = new Date(yy, (mm || 1) - 1, dd || 1, h || 0, m || 0, 0, 0);
    createFollowup.mutate(
      {
        tenantId,
        contactId,
        dealId,
        scheduledAt: scheduled.toISOString(),
        description: data.description || null,
        createdBy,
        source: "manual",
        aiSuggested: false,
      },
      {
        onSuccess: () => {
          toast.success("Retorno criado");
          reset();
          setDate(new Date());
          onOpenChange(false);
        },
        onError: (e: Error) => toast.error(e.message ?? "Erro ao criar retorno"),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Criar retorno</DialogTitle>
          <DialogDescription>Agende um recontato com este contato.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="quick-followup-description">Descrição</Label>
            <Textarea id="quick-followup-description" {...register("description")} rows={2} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Data *</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-full justify-start font-normal">
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {date ? formatDate(date) : "Escolher…"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-auto p-0 pointer-events-auto">
                  <Calendar
                    mode="single"
                    selected={date}
                    onSelect={(d) => {
                      if (d) {
                        setDate(d);
                        setValue("date", format(d, "yyyy-MM-dd"));
                      }
                    }}
                    initialFocus
                    locale={ptBR}
                    className="p-3 pointer-events-auto"
                  />
                </PopoverContent>
              </Popover>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="quick-followup-time">Hora *</Label>
              <Input
                id="quick-followup-time"
                type="time"
                {...register("time")}
                aria-invalid={!!errors.time}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={createFollowup.isPending}>
              {createFollowup.isPending ? "Criando…" : "Criar retorno"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
