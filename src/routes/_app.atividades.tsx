import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  AlertTriangle,
  CalendarClock,
  ChevronDown,
  FileText,
  Phone,
  Plus,
  StickyNote,
} from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { PageHeader } from "@/components/common/PageHeader";
import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FollowupQueueSection } from "@/components/activities/FollowupQueueSection";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile, useTenantProfiles } from "@/lib/api/session";
import { formatDate, formatDateTime, isSameDay, isPast, startOfDay, isAfter } from "@/lib/format";
import { cn } from "@/lib/utils";

type ActivityType = "task" | "call" | "note";
type ActivityRow = {
  id: string;
  tenant_id: string;
  type: ActivityType;
  title: string;
  due_at: string | null;
  completed_at: string | null;
  owner_id: string | null;
  contact_id: string | null;
  deal_id: string | null;
  contact: { id: string; name: string } | null;
  deal: { id: string; title: string } | null;
  owner: { id: string; name: string } | null;
};

export const Route = createFileRoute("/_app/atividades")({
  head: () => ({
    meta: [
      { title: "Atividades" },
      {
        name: "description",
        content: "Tarefas, ligações e retornos organizados por atrasadas, hoje e próximas.",
      },
      { property: "og:title", content: "Atividades" },
      {
        property: "og:description",
        content: "Tarefas, ligações e retornos organizados por atrasadas, hoje e próximas.",
      },
      { property: "og:url", content: "https://aceleraflow.lovable.app/atividades" },
      { name: "twitter:title", content: "Atividades" },
      {
        name: "twitter:description",
        content: "Tarefas, ligações e retornos organizados por atrasadas, hoje e próximas.",
      },
    ],
    links: [{ rel: "canonical", href: "https://aceleraflow.lovable.app/atividades" }],
  }),
  component: ActivitiesPage,
});

const typeIcon: Record<ActivityType, typeof FileText> = {
  task: FileText,
  call: Phone,
  note: StickyNote,
};
const typeLabel: Record<ActivityType, string> = { task: "Tarefa", call: "Ligação", note: "Nota" };

function useActivities() {
  return useQuery({
    queryKey: ["activities"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("activities")
        .select(
          "id, tenant_id, type, title, due_at, completed_at, owner_id, contact_id, deal_id, contact:contacts(id, name, deleted_at), deal:deals(id, title), owner:profiles(id, name)",
        )
        .order("due_at", { ascending: true, nullsFirst: false });
      if (error) throw error;
      const rows = (data ?? []) as unknown as (Omit<ActivityRow, "contact"> & {
        contact: (ActivityRow["contact"] & { deleted_at: string | null }) | null;
      })[];
      // Join to-one: contato fundido/removido não deve reaparecer na atividade.
      return rows.map((a) => ({
        ...a,
        contact: a.contact?.deleted_at ? null : a.contact,
      })) as ActivityRow[];
    },
  });
}

function ActivitiesPage() {
  const [openNew, setOpenNew] = useState(false);
  const activitiesQ = useActivities();

  const now = new Date();
  const today = startOfDay(now);

  const { atrasadas, hoje, proximas, concluidasHoje } = useMemo(() => {
    const activities = activitiesQ.data ?? [];
    const atrasadas: ActivityRow[] = [];
    const hoje: ActivityRow[] = [];
    const proximas: ActivityRow[] = [];
    const concluidasHoje: ActivityRow[] = [];
    for (const a of activities) {
      if (a.completed_at) {
        if (isSameDay(new Date(a.completed_at), today)) concluidasHoje.push(a);
        continue;
      }
      if (!a.due_at) {
        proximas.push(a);
        continue;
      }
      const due = new Date(a.due_at);
      if (isSameDay(due, today)) hoje.push(a);
      else if (isPast(due)) atrasadas.push(a);
      else if (isAfter(due, today)) proximas.push(a);
    }
    return { atrasadas, hoje, proximas, concluidasHoje };
  }, [activitiesQ.data, today]);

  return (
    <div className="col-span-12 flex flex-col gap-4">
      <PageHeader title="Atividades" description="Tarefas, ligações, notas e retornos do time." />

      <Tabs defaultValue="atividades">
        <TabsList>
          <TabsTrigger value="atividades">Atividades</TabsTrigger>
          <TabsTrigger value="followups">Retornos</TabsTrigger>
        </TabsList>

        <TabsContent value="atividades" className="mt-4 flex flex-col gap-4">
          <div className="flex justify-end">
            <Button onClick={() => setOpenNew(true)}>
              <Plus className="mr-1 h-4 w-4" /> Nova atividade
            </Button>
          </div>

          {activitiesQ.isLoading ? (
            <>
              <Skeleton className="h-32 w-full" />
              <Skeleton className="h-32 w-full" />
            </>
          ) : activitiesQ.isError ? (
            <EmptyState
              title="Erro ao carregar"
              description={(activitiesQ.error as Error).message}
              actionLabel="Tentar novamente"
              onAction={() => activitiesQ.refetch()}
            />
          ) : (
            <>
              <Section
                title={`Atrasadas${atrasadas.length ? ` (${atrasadas.length})` : ""}`}
                tone="destructive"
                icon={<AlertTriangle className="h-4 w-4" />}
                items={atrasadas}
                emptyLabel="Nada atrasado"
              />
              <Section
                title={`Hoje${hoje.length ? ` (${hoje.length})` : ""}`}
                tone="primary"
                icon={<CalendarClock className="h-4 w-4" />}
                items={hoje}
                emptyLabel="Nenhuma tarefa para hoje"
              />
              <Section
                title={`Próximas${proximas.length ? ` (${proximas.length})` : ""}`}
                tone="neutral"
                icon={<CalendarClock className="h-4 w-4" />}
                items={proximas}
                emptyLabel="Sem próximas tarefas"
              />

              {concluidasHoje.length > 0 && (
                <Collapsible>
                  <Card>
                    <CollapsibleTrigger asChild>
                      <button className="flex w-full items-center justify-between p-4 text-left">
                        <span className="text-card-title font-semibold text-foreground">
                          Concluídas hoje ({concluidasHoje.length})
                        </span>
                        <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform data-[state=open]:rotate-180" />
                      </button>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="border-t border-border">
                        {concluidasHoje.map((a) => (
                          <Row key={a.id} activity={a} />
                        ))}
                      </div>
                    </CollapsibleContent>
                  </Card>
                </Collapsible>
              )}
            </>
          )}
        </TabsContent>

        <TabsContent value="followups" className="mt-4">
          <FollowupQueueSection />
        </TabsContent>
      </Tabs>

      <NewActivityDialog open={openNew} onOpenChange={setOpenNew} />
    </div>
  );
}

function Section({
  title,
  tone,
  icon,
  items,
  emptyLabel,
}: {
  title: string;
  tone: "destructive" | "primary" | "neutral";
  icon: React.ReactNode;
  items: ActivityRow[];
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
            {items.map((a) => (
              <Row key={a.id} activity={a} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function Row({ activity }: { activity: ActivityRow }) {
  const qc = useQueryClient();
  const Icon = typeIcon[activity.type] ?? FileText;
  const overdue =
    !activity.completed_at &&
    activity.due_at &&
    new Date(activity.due_at) < new Date() &&
    !isSameDay(new Date(activity.due_at), new Date());

  const [date, setDate] = useState<Date>(activity.due_at ? new Date(activity.due_at) : new Date());
  const [time, setTime] = useState(
    activity.due_at ? format(new Date(activity.due_at), "HH:mm") : "10:00",
  );
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (activity.due_at) {
      setDate(new Date(activity.due_at));
      setTime(format(new Date(activity.due_at), "HH:mm"));
    }
  }, [activity.due_at]);

  const toggleMut = useMutation({
    mutationFn: async () => {
      const completed_at = activity.completed_at ? null : new Date().toISOString();
      const { error } = await supabase
        .from("activities")
        .update({ completed_at })
        .eq("id", activity.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["activities"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["contact-activities", activity.contact_id] });
    },
    onError: (e: Error) => toast.error(e.message ?? "Erro ao atualizar"),
  });

  const rescheduleMut = useMutation({
    mutationFn: async (iso: string) => {
      const { error } = await supabase
        .from("activities")
        .update({ due_at: iso })
        .eq("id", activity.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["activities"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success("Atividade reagendada");
    },
    onError: (e: Error) => toast.error(e.message ?? "Erro ao reagendar"),
  });

  const applyReschedule = () => {
    const [h, m] = time.split(":").map(Number);
    const d = new Date(date);
    d.setHours(h || 0, m || 0, 0, 0);
    rescheduleMut.mutate(d.toISOString());
    setOpen(false);
  };

  return (
    <li className="flex items-center gap-3 p-3">
      <Checkbox
        checked={!!activity.completed_at}
        onCheckedChange={() => toggleMut.mutate()}
        aria-label={`Concluir ${activity.title}`}
      />
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "truncate text-body font-medium text-foreground",
            activity.completed_at && "line-through text-muted-foreground",
          )}
        >
          {activity.title}
        </div>
        <div className="text-caption text-muted-foreground flex items-center gap-2">
          <span>{typeLabel[activity.type] ?? activity.type}</span>
          {activity.contact && (
            <>
              <span>•</span>
              <Link
                to="/contatos/$id"
                params={{ id: activity.contact.id }}
                className="hover:underline"
              >
                {activity.contact.name}
              </Link>
            </>
          )}
          {activity.deal && (
            <>
              <span>•</span>
              <span>{activity.deal.title}</span>
            </>
          )}
          {activity.owner && (
            <>
              <span>•</span>
              <span>Resp.: {activity.owner.name}</span>
            </>
          )}
        </div>
      </div>
      <span
        className={cn(
          "text-caption font-medium",
          overdue ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {activity.due_at ? formatDateTime(activity.due_at) : "Sem data"}
      </span>
      {!activity.completed_at && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-8">
              Reagendar
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-auto p-0 pointer-events-auto">
            <Calendar
              mode="single"
              selected={date}
              onSelect={(d) => d && setDate(d)}
              initialFocus
              locale={ptBR}
              className="p-3 pointer-events-auto"
            />
            <div className="flex items-center gap-2 border-t border-border p-3">
              <Input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="w-32"
              />
              <Button size="sm" className="ml-auto" onClick={applyReschedule}>
                Aplicar
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      )}
    </li>
  );
}

const activitySchema = z
  .object({
    type: z.enum(["task", "call", "note"]),
    title: z.string().min(1, "Título é obrigatório"),
    linkKind: z.enum(["contact", "deal", "none"]),
    linkId: z.string().optional(),
    ownerId: z.string().optional(),
    date: z.string().min(1),
    time: z.string().min(1),
  })
  .superRefine((data, ctx) => {
    // Vínculo != "none" exige um item selecionado: sem isso, o insert em
    // activities.contact_id/deal_id recebia "" e o Postgres devolvia erro
    // cru de UUID inválido (bug do lote 2, item 8).
    if (data.linkKind !== "none" && !data.linkId?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["linkId"],
        message: data.linkKind === "contact" ? "Selecione um contato" : "Selecione um negócio",
      });
    }
  });
type ActivityForm = z.infer<typeof activitySchema>;

function NewActivityDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const { data: profile } = useCurrentProfile();
  const { data: tenantProfiles = [] } = useTenantProfiles();
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
        .select("id, title")
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
  } = useForm<ActivityForm>({
    resolver: zodResolver(activitySchema),
    defaultValues: {
      type: "task",
      title: "",
      linkKind: "none",
      linkId: "",
      ownerId: "",
      date: format(new Date(), "yyyy-MM-dd"),
      time: "10:00",
    },
  });

  const type = watch("type");
  const linkKind = watch("linkKind");
  const linkId = watch("linkId");
  const ownerId = watch("ownerId") || profile?.id || "";

  const createMut = useMutation({
    mutationFn: async (data: ActivityForm) => {
      if (!profile) throw new Error("Sessão inválida");
      const [h, m] = data.time.split(":").map(Number);
      const [yy, mm, dd] = data.date.split("-").map(Number);
      const d = new Date(yy, (mm || 1) - 1, dd || 1, h || 0, m || 0, 0, 0);
      const { error } = await supabase.from("activities").insert({
        tenant_id: profile.tenant_id,
        type: data.type,
        title: data.title,
        contact_id: data.linkKind === "contact" ? data.linkId || null : null,
        deal_id: data.linkKind === "deal" ? data.linkId || null : null,
        due_at: d.toISOString(),
        owner_id: data.ownerId || profile.id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["activities"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success("Atividade criada");
      reset();
      setDate(new Date());
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message ?? "Erro ao criar atividade"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Nova atividade</DialogTitle>
          <DialogDescription>Agende uma tarefa, ligação ou nota.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit((v) => createMut.mutate(v))} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Tipo</Label>
              <Select value={type} onValueChange={(v) => setValue("type", v as ActivityType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="task">Tarefa</SelectItem>
                  <SelectItem value="call">Ligação</SelectItem>
                  <SelectItem value="note">Nota</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Vínculo</Label>
              <Select
                value={linkKind}
                onValueChange={(v) => {
                  setValue("linkKind", v as "contact" | "deal" | "none");
                  setValue("linkId", "");
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Nenhum</SelectItem>
                  <SelectItem value="contact">Contato</SelectItem>
                  <SelectItem value="deal">Negócio</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="title">Título *</Label>
            <Input id="title" {...register("title")} aria-invalid={!!errors.title} />
            {errors.title && (
              <p className="text-caption text-destructive">{errors.title.message}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>Responsável</Label>
            <Select value={ownerId} onValueChange={(v) => setValue("ownerId", v)}>
              <SelectTrigger>
                <SelectValue placeholder="Selecionar…" />
              </SelectTrigger>
              <SelectContent>
                {tenantProfiles.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                    {p.id === profile?.id ? " (você)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {linkKind !== "none" && (
            <div className="space-y-1.5">
              <Label>{linkKind === "contact" ? "Contato" : "Negócio"}</Label>
              <Select value={linkId} onValueChange={(v) => setValue("linkId", v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecionar…" />
                </SelectTrigger>
                <SelectContent>
                  {linkKind === "contact"
                    ? (contactsQ.data ?? []).map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))
                    : (dealsQ.data ?? []).map((d) => (
                        <SelectItem key={d.id} value={d.id}>
                          {d.title}
                        </SelectItem>
                      ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Data *</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-full justify-start font-normal">
                    <CalendarClock className="mr-2 h-4 w-4" />
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
              {createMut.isPending ? "Criando…" : "Criar atividade"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
