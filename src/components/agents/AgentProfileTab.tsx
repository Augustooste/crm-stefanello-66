import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useAgentPlatformMutation, useAgentPlatformQuery } from "@/lib/api/agent-platform";
import type {
  AgentPlatformAgent,
  AgentPlatformRequestBody,
} from "@/lib/api/agent-platform-contract";
import {
  AGENT_TYPES,
  COMMUNICATION_TYPES,
  type AgentType,
  type CommunicationType,
} from "@/integrations/agent-platform/enums.gen";

// Aba "Perfil" do agente provedor de agentes — ver contracts/agent-platform/CONTRACT_MATRIX.md
// §1.3. Lê e grava só os campos que o contrato expõe em GET/PUT
// `/v2/agent/{agentId}` (nomes remotos preservados no payload).

type AgentUpdatePayload = AgentPlatformRequestBody<"agent.update">;

const COMMUNICATION_TYPE_LABELS: Record<CommunicationType, string> = {
  FORMAL: "Formal",
  NORMAL: "Normal",
  RELAXED: "Descontraído",
};

const AGENT_TYPE_LABELS: Record<AgentType, string> = {
  SUPPORT: "Suporte",
  SALE: "Vendas",
  PERSONAL: "Pessoal",
};

/**
 * Monta a lista de opções do Select incluindo o valor atual mesmo quando ele
 * não está no enum conhecido — o provedor de agentes pode devolver um valor fora do
 * contrato e a tela não pode quebrar nem esconder o dado (regra do escopo).
 */
function buildSelectOptions<T extends string>(
  known: readonly T[],
  labels: Record<T, string>,
  current: string,
): Array<{ value: string; label: string }> {
  // Tipado como `string` (não `T`) de propósito: a opção sintética do valor
  // não mapeado abaixo não pertence ao enum conhecido.
  const options: Array<{ value: string; label: string }> = known.map((value) => ({
    value,
    label: labels[value],
  }));
  const trimmed = current.trim();
  if (trimmed && !known.includes(trimmed as T)) {
    options.push({
      value: trimmed,
      label: `${trimmed} (valor não mapeado pelo provedor de agentes)`,
    });
  }
  return options;
}

const agentProfileSchema = z.object({
  name: z.string().optional(),
  avatar: z.string().url("URL inválida").optional().or(z.literal("")),
  behavior: z.string().optional(),
  jobName: z.string().optional(),
  jobSite: z.string().url("URL inválida").optional().or(z.literal("")),
  jobDescription: z.string().optional(),
  communicationType: z.string().optional(),
  type: z.string().optional(),
});
type AgentProfileFormValues = z.infer<typeof agentProfileSchema>;

function buildDefaults(agent: AgentPlatformAgent): AgentProfileFormValues {
  return {
    name: agent.name ?? "",
    avatar: agent.avatar ?? "",
    behavior: agent.behavior ?? "",
    jobName: agent.jobName ?? "",
    jobSite: agent.jobSite ?? "",
    jobDescription: agent.jobDescription ?? "",
    communicationType: agent.communicationType ?? "",
    type: agent.type ?? "",
  };
}

/** Só inclui no payload o que foi preenchido — contrato não exige nenhum campo. */
function buildUpdatePayload(values: AgentProfileFormValues): AgentUpdatePayload {
  const payload: AgentUpdatePayload = {};

  const name = (values.name ?? "").trim();
  if (name) payload.name = name;

  const avatar = (values.avatar ?? "").trim();
  if (avatar) payload.avatar = avatar;

  const behavior = (values.behavior ?? "").trim();
  if (behavior) payload.behavior = behavior;

  const jobName = (values.jobName ?? "").trim();
  if (jobName) payload.jobName = jobName;

  const jobSite = (values.jobSite ?? "").trim();
  if (jobSite) payload.jobSite = jobSite;

  const jobDescription = (values.jobDescription ?? "").trim();
  if (jobDescription) payload.jobDescription = jobDescription;

  const communicationType = (values.communicationType ?? "").trim();
  if (communicationType) {
    // Campo tipado como union estrita no contrato, mas o GET pode já ter
    // devolvido um valor fora dela — repassamos como veio, sem inventar
    // campo novo (regra de tolerância desta aba).
    payload.communicationType = communicationType as CommunicationType;
  }

  const type = (values.type ?? "").trim();
  if (type) {
    payload.type = type as AgentType;
  }

  return payload;
}

function AgentProfileForm({ agentId, agent }: { agentId: string; agent: AgentPlatformAgent }) {
  const { register, handleSubmit, watch, setValue, reset, formState } =
    useForm<AgentProfileFormValues>({
      resolver: zodResolver(agentProfileSchema),
      defaultValues: buildDefaults(agent),
    });

  useEffect(() => {
    reset(buildDefaults(agent));
  }, [agent, reset]);

  const updateMutation = useAgentPlatformMutation("agent.update", {
    onSuccess: () => toast.success("Perfil do agente salvo."),
    onError: (error) => toast.error(error.message),
  });

  const communicationType = watch("communicationType") ?? "";
  const type = watch("type") ?? "";
  const communicationOptions = buildSelectOptions(
    COMMUNICATION_TYPES,
    COMMUNICATION_TYPE_LABELS,
    communicationType,
  );
  const typeOptions = buildSelectOptions(AGENT_TYPES, AGENT_TYPE_LABELS, type);

  const onSubmit = handleSubmit((values) => {
    updateMutation.mutate({ params: { agentId }, body: buildUpdatePayload(values) });
  });

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="agent-name">Nome</Label>
          <Input id="agent-name" {...register("name")} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="agent-avatar">URL do avatar</Label>
          <Input
            id="agent-avatar"
            type="url"
            placeholder="https://…"
            {...register("avatar")}
            aria-invalid={!!formState.errors.avatar}
          />
          {formState.errors.avatar && (
            <p className="text-caption text-destructive">{formState.errors.avatar.message}</p>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="agent-behavior">Comportamento</Label>
        <Textarea
          id="agent-behavior"
          rows={12}
          className="min-h-60 font-mono text-sm"
          placeholder="Instruções que definem como o agente conversa (o prompt do agente)…"
          {...register("behavior")}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="agent-job-name">Nome da empresa ou produto</Label>
          <Input id="agent-job-name" {...register("jobName")} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="agent-job-site">Site</Label>
          <Input
            id="agent-job-site"
            type="url"
            placeholder="https://…"
            {...register("jobSite")}
            aria-invalid={!!formState.errors.jobSite}
          />
          {formState.errors.jobSite && (
            <p className="text-caption text-destructive">{formState.errors.jobSite.message}</p>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="agent-job-description">Descrição da empresa</Label>
        <Textarea id="agent-job-description" rows={3} {...register("jobDescription")} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Tipo de comunicação</Label>
          <Select
            value={communicationType}
            onValueChange={(value) => setValue("communicationType", value, { shouldDirty: true })}
          >
            <SelectTrigger aria-label="Tipo de comunicação">
              <SelectValue placeholder="Selecione o tipo de comunicação" />
            </SelectTrigger>
            <SelectContent>
              {communicationOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Objetivo do agente</Label>
          <Select
            value={type}
            onValueChange={(value) => setValue("type", value, { shouldDirty: true })}
          >
            <SelectTrigger aria-label="Objetivo do agente">
              <SelectValue placeholder="Selecione o objetivo do agente" />
            </SelectTrigger>
            <SelectContent>
              {typeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex justify-end">
        <Button type="submit" disabled={updateMutation.isPending}>
          {updateMutation.isPending ? "Salvando…" : "Salvar perfil do agente"}
        </Button>
      </div>
    </form>
  );
}

function AgentProfileSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
      <Skeleton className="h-60 w-full" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    </div>
  );
}

export function AgentProfileTab({ agentId }: { agentId: string }) {
  const agentQuery = useAgentPlatformQuery("agent.get", { params: { agentId } });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-card-title">Perfil do agente</CardTitle>
      </CardHeader>
      <CardContent>
        {agentQuery.isPending ? (
          <AgentProfileSkeleton />
        ) : agentQuery.isError ? (
          <EmptyState
            icon={AlertTriangle}
            title="Erro ao carregar perfil do agente"
            description={agentQuery.error.message}
            actionLabel="Tentar novamente"
            onAction={() => agentQuery.refetch()}
          />
        ) : (
          <AgentProfileForm agentId={agentId} agent={agentQuery.data} />
        )}
      </CardContent>
    </Card>
  );
}
