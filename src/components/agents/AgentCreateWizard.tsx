import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useNavigate } from "@tanstack/react-router";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAgentPlatformMutation } from "@/lib/api/agent-platform";
import type { AgentPlatformAgentCreate } from "@/lib/api/agent-platform-contract";
import { AGENT_TYPES, COMMUNICATION_TYPES } from "@/integrations/agent-platform/enums.gen";
import { AGENT_TYPE_LABELS, COMMUNICATION_TYPE_LABELS } from "./agent-labels";

const schema = z.object({
  name: z.string().min(1, "Nome é obrigatório"),
  avatar: z.string().optional(),
  behavior: z.string().optional(),
  communicationType: z.enum(COMMUNICATION_TYPES),
  type: z.enum(AGENT_TYPES),
  jobName: z.string().optional(),
  jobSite: z.string().optional(),
  jobDescription: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

const DEFAULT_VALUES: FormValues = {
  name: "",
  avatar: "",
  behavior: "",
  communicationType: "NORMAL",
  type: "SUPPORT",
  jobName: "",
  jobSite: "",
  jobDescription: "",
};

/** Campo opcional: string vazia vira `undefined` no payload remoto. */
function optionalField(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Wizard de criação de agente -- campos exatos de `POST
 * /v2/workspace/{workspaceId}/agents` (nomes remotos preservados). Após
 * criar, recarrega o agente e as configurações (via invalidate) e redireciona
 * para a tela de detalhe do novo agente.
 */
export function AgentCreateWizard({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: DEFAULT_VALUES,
  });

  useEffect(() => {
    if (open) reset(DEFAULT_VALUES);
  }, [open, reset]);

  const createMut = useAgentPlatformMutation("agents.create", {
    invalidate: ["agents.list", "agent.get", "agent.settings.get"],
    onSuccess: (created) => {
      const agentId = created.id;
      if (!agentId) {
        toast.error("O provedor de agentes não retornou o ID do agente criado.");
        return;
      }
      toast.success("Agente criado.");
      onOpenChange(false);
      void navigate({ to: "/agentes/$agentId", params: { agentId } });
    },
    onError: (error) => toast.error(error.message),
  });

  function onSubmit(values: FormValues) {
    const payload: AgentPlatformAgentCreate = {
      name: values.name,
      avatar: optionalField(values.avatar),
      behavior: optionalField(values.behavior),
      communicationType: values.communicationType,
      type: values.type,
      jobName: optionalField(values.jobName),
      jobSite: optionalField(values.jobSite),
      jobDescription: optionalField(values.jobDescription),
    };
    createMut.mutate({ body: payload });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Criar agente</DialogTitle>
          <DialogDescription>
            Defina o perfil inicial do agente no provedor de agentes. Você pode ajustar tudo depois.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="agent-name">Nome *</Label>
            <Input id="agent-name" {...register("name")} aria-invalid={!!errors.name} />
            {errors.name && <p className="text-caption text-destructive">{errors.name.message}</p>}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="agent-type">Objetivo</Label>
              <Controller
                control={control}
                name="type"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="agent-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {AGENT_TYPES.map((value) => (
                        <SelectItem key={value} value={value}>
                          {AGENT_TYPE_LABELS[value]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="agent-communication-type">Tipo de comunicação</Label>
              <Controller
                control={control}
                name="communicationType"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="agent-communication-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {COMMUNICATION_TYPES.map((value) => (
                        <SelectItem key={value} value={value}>
                          {COMMUNICATION_TYPE_LABELS[value]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="agent-avatar">URL do avatar</Label>
            <Input id="agent-avatar" {...register("avatar")} placeholder="https://…" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="agent-behavior">Comportamento</Label>
            <Textarea
              id="agent-behavior"
              rows={3}
              placeholder="Como o agente deve se comportar"
              {...register("behavior")}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="agent-job-name">Empresa ou produto</Label>
              <Input id="agent-job-name" {...register("jobName")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="agent-job-site">Site</Label>
              <Input id="agent-job-site" {...register("jobSite")} placeholder="https://…" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="agent-job-description">Descrição da empresa</Label>
            <Textarea id="agent-job-description" rows={3} {...register("jobDescription")} />
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={createMut.isPending}>
              {createMut.isPending ? "Criando…" : "Criar agente"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
