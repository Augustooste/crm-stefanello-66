import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { AlertTriangle, Calendar as CalendarIcon, CalendarClock, Check, Plus } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile } from "@/lib/api/session";
import { formatDate, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  useFollowupQueue,
  useCompleteFollowup,
  useCreateFollowup,
  type FollowupRow,
} from "@/hooks/use-followup-queue";

const FOLLOWUP_DAYS_AHEAD = 7;

export function FollowupQueueSection() {
  const [openNew, setOpenNew] = useState(false);
  const { atrasados, hoje, proximos, isLoading, isError, error, refetch } =
    useFollowupQueue(FOLLOWUP_DAYS_AHEAD);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-caption text-muted-foreground">
          Fila de recontato — horários calculados no fuso America/Sao_Paulo (limitação conhecida
          para tenants fora do Brasil).
        </p>
        <Button onClick={() => setOpenNew(true)}>
          <Plus className="mr-1 h-4 w-4" /> Novo retorno
        </Button>
      </div>

      {isLoading ? (
        <>
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </>
      ) : isError ? (
        <EmptyState
          title="Erro ao carregar"
          description={(error as Error).message}
          actionLabel="Tentar novamente"
          onAction={() => refetch()}
        />
      ) : (
        <>
          <FollowupSection
            title={`Atrasados${atrasados.length ? ` (${atrasados.length})` : ""}`}
            tone="destructive"
            icon={<AlertTriangle className="h-4 w-4" />}
            items={atrasados}
            emptyLabel="Nenhum retorno atrasado"
          />
          <FollowupSection
            title={`Hoje${hoje.length ? ` (${hoje.length})` : ""}`}
            tone="primary"
            icon={<CalendarClock className="h-4 w-4" />}
            items={hoje}
            emptyLabel="Nenhum retorno para hoje"
          />
          <FollowupSection
            title={`Próximos ${FOLLOWUP_DAYS_AHEAD} dias${proximos.length ? ` (${proximos.length})` : ""}`}
            tone="neutral"
            icon={<CalendarClock className="h-4 w-4" />}
            items={proximos}
            emptyLabel="Nada agendado para os próximos dias"
          />
        </>
      )}

      <NewFollowupDialog open={openNew} onOpenChange={setOpenNew} />
    </div>
  );
}

function FollowupSection({
  title,
  tone,
  icon,
  items,
  emptyLabel,
}: {
  title: string;
  tone: "destructive" | "primary" | "neutral";
  icon: React.ReactNode;
  items: FollowupRow[];
  emptyLabel: string;
}) {
  return (
    <Card>
      <CardHeader
        className={cn(
          "flex flex-row items-center gap-2 space-y-0",
          tone === "destructive" && "text-destructive",
          tone === "primary" && "text-primary",
        )}
      >
        {icon}
        <CardTitle className="text-card-title">{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {items.length === 0 ? (
          <div className="p-6">
            <EmptyState title={emptyLabel} />
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((f) => (
              <FollowupRowItem key={f.id} followup={f} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function FollowupRowItem({ followup }: { followup: FollowupRow }) {
  const { data: profile } = useCurrentProfile();
  const completeMut = useCompleteFollowup();

  return (
    <li className="flex items-center gap-3 p-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {followup.contact && (
            <Link
              to="/contatos/$id"
              params={{ id: followup.contact.id }}
              className="truncate text-body font-medium text-foreground hover:underline"
            >
              {followup.contact.name}
            </Link>
          )}
          {followup.source === "ai_suggested" && (
            <span className="rounded-full bg-accent px-1.5 py-0.5 text-caption font-medium text-accent-foreground">
              IA
            </span>
          )}
        </div>
        {followup.description && (
          <p className="truncate text-caption text-muted-foreground">{followup.description}</p>
        )}
        {followup.deal && (
          <p className="truncate text-caption text-muted-foreground">{followup.deal.title}</p>
        )}
      </div>
      <span className="shrink-0 text-caption font-medium text-muted-foreground">
        {formatDateTime(followup.scheduled_at)}
      </span>
      <Button
        variant="outline"
        size="sm"
        className="h-8 shrink-0"
        disabled={completeMut.isPending || !profile}
        onClick={() => {
          if (!profile) return;
          completeMut.mutate(
            { id: followup.id, completedBy: profile.id },
            {
              onSuccess: () => toast.success("Retorno concluído"),
              onError: (e: Error) => toast.error(e.message ?? "Erro ao concluir retorno"),
            },
          );
        }}
        aria-label={`Concluir retorno com ${followup.contact?.name ?? "contato"}`}
      >
        <Check className="h-4 w-4" />
      </Button>
    </li>
  );
}

const followupSchema = z.object({
  contactId: z.string().min(1, "Selecione um contato"),
  dealId: z.string().optional(),
  description: z.string().optional(),
  date: z.string().min(1),
  time: z.string().min(1),
});
type FollowupForm = z.infer<typeof followupSchema>;

function NewFollowupDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { data: profile } = useCurrentProfile();
  const createMut = useCreateFollowup();
  const [date, setDate] = useState<Date | undefined>(new Date());

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
  const dealsQ = useQuery({
    queryKey: ["deals-min"],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deals")
        .select("id, title, contact_id")
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return data ?? [];
    },
  });

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors },
  } = useForm<FollowupForm>({
    resolver: zodResolver(followupSchema),
    defaultValues: {
      contactId: "",
      dealId: "",
      description: "",
      date: format(new Date(), "yyyy-MM-dd"),
      time: "10:00",
    },
  });

  const contactId = watch("contactId");
  const dealId = watch("dealId");
  const dealsForContact = (dealsQ.data ?? []).filter((d) => d.contact_id === contactId);

  const onSubmit = (data: FollowupForm) => {
    if (!profile) return;
    const [h, m] = data.time.split(":").map(Number);
    const [yy, mm, dd] = data.date.split("-").map(Number);
    const scheduled = new Date(yy, (mm || 1) - 1, dd || 1, h || 0, m || 0, 0, 0);
    createMut.mutate(
      {
        tenantId: profile.tenant_id,
        contactId: data.contactId,
        dealId: data.dealId || null,
        scheduledAt: scheduled.toISOString(),
        description: data.description || null,
        createdBy: profile.id,
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
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Novo retorno</DialogTitle>
          <DialogDescription>Agende um recontato com um contato.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label>Contato *</Label>
            <Select
              value={contactId}
              onValueChange={(v) => {
                setValue("contactId", v);
                setValue("dealId", "");
              }}
            >
              <SelectTrigger aria-invalid={!!errors.contactId}>
                <SelectValue placeholder="Selecionar…" />
              </SelectTrigger>
              <SelectContent>
                {(contactsQ.data ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.contactId && (
              <p className="text-caption text-destructive">{errors.contactId.message}</p>
            )}
          </div>
          {contactId && dealsForContact.length > 0 && (
            <div className="space-y-1.5">
              <Label>Negócio (opcional)</Label>
              <Select value={dealId} onValueChange={(v) => setValue("dealId", v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Nenhum" />
                </SelectTrigger>
                <SelectContent>
                  {dealsForContact.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="description">Descrição</Label>
            <Textarea id="description" {...register("description")} rows={2} />
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
              <Label htmlFor="time">Hora *</Label>
              <Input id="time" type="time" {...register("time")} />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={createMut.isPending}>
              {createMut.isPending ? "Criando…" : "Criar retorno"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
