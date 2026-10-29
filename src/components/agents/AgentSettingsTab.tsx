// Aba "Modelo e configurações" do agente provedor de agentes.
//
// Lê/grava GET|PUT /v2/agent/{agentId}/settings via useAgentPlatformQuery /
// useAgentPlatformMutation (nunca chama a API do provedor direto). Grafia remota
// preservada: prefferModel, onLackKnowLedge, THIRD_SEC. Ver
// contracts/agent-platform/CONTRACT_MATRIX.md §1.2 e divergências D3/D4. Lógica
// de formulário (sem JSX) mora em agent-settings-form.ts.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SlidersHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/common/EmptyState";
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
import { Switch } from "@/components/ui/switch";
import { useAgentPlatformMutation, useAgentPlatformQuery } from "@/lib/api/agent-platform";
import type { AgentPlatformAgentSettingsUpdate } from "@/lib/api/agent-platform-contract";
import {
  MAX_DAILY_MESSAGES_LIMIT_ACTIONS,
  MESSAGE_GROUPING_TIMES,
  PREFFER_MODELS,
  type MaxDailyMessagesLimitAction,
  type MessageGroupingTime,
} from "@/integrations/agent-platform/enums.gen";
import {
  buildUpdatePayload,
  formatModelLabel,
  isValidUrl,
  MAX_DAILY_LIMIT_ACTION_LABELS,
  MESSAGE_GROUPING_LABELS,
  NONE,
  toFormState,
  withCurrentValue,
  type FormState,
} from "./agent-settings-form";

export function AgentSettingsTab({ agentId }: { agentId: string }) {
  const settingsQ = useAgentPlatformQuery("agent.settings.get", { params: { agentId } });
  const updateMut = useAgentPlatformMutation("agent.settings.update", {
    invalidate: ["agent.settings.get"],
    onSuccess: () => {
      setDirty(false);
      setSignMessagesTouched(false);
      toast.success("Configurações do agente salvas.");
    },
    onError: (error) => toast.error(error.message),
  });

  const [form, setForm] = useState<FormState | null>(null);
  const [dirty, setDirty] = useState(false);
  const [signMessagesTouched, setSignMessagesTouched] = useState(false);

  useEffect(() => {
    if (settingsQ.data && !dirty) {
      setForm(toFormState(settingsQ.data));
    }
  }, [settingsQ.data, dirty]);

  function patchForm(patch: Partial<FormState>) {
    setForm((prev) => (prev ? { ...prev, ...patch } : prev));
    setDirty(true);
  }

  if (settingsQ.isLoading || !form) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-card-title">Modelo e configurações</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (settingsQ.isError) {
    return (
      <Card>
        <CardContent className="p-6">
          <EmptyState
            title="Erro ao carregar as configurações do agente"
            description={settingsQ.error.message}
            actionLabel="Tentar de novo"
            onAction={() => settingsQ.refetch()}
          />
        </CardContent>
      </Card>
    );
  }

  const webhookValid = isValidUrl(form.onLackKnowLedge);
  const hasLimit = form.maxDailyMessages.trim() !== "";

  function handleSave() {
    if (!form || !webhookValid) return;
    updateMut.mutate({
      params: { agentId },
      // D4 — ver comentário de buildUpdatePayload em agent-settings-form.ts.
      body: buildUpdatePayload(form, signMessagesTouched) as AgentPlatformAgentSettingsUpdate,
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-card-title">
          <SlidersHorizontal className="h-4 w-4" aria-hidden />
          Modelo e configurações
        </CardTitle>
        <CardDescription>
          Modelo de linguagem, comportamento de mensagens e limites do agente no provedor de
          agentes.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="agent-preffer-model">Modelo de LLM preferido</Label>
            <Select
              value={form.prefferModel || NONE}
              onValueChange={(v) => patchForm({ prefferModel: v === NONE ? "" : v })}
            >
              <SelectTrigger id="agent-preffer-model">
                <SelectValue placeholder="Modelo padrão do provedor de agentes" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Padrão do provedor de agentes</SelectItem>
                {withCurrentValue(PREFFER_MODELS, form.prefferModel).map((model) => (
                  <SelectItem key={model} value={model}>
                    {formatModelLabel(model)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-caption text-muted-foreground">Modelo de LLM preferido do agente.</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="agent-timezone">Fuso horário</Label>
            <Input
              id="agent-timezone"
              value={form.timezone}
              onChange={(e) => patchForm({ timezone: e.target.value })}
              placeholder="Ex.: America/Sao_Paulo"
            />
            <p className="text-caption text-muted-foreground">Timezone do agente.</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="agent-message-grouping">Agrupamento de mensagens</Label>
            <Select
              value={form.messageGroupingTime || NONE}
              onValueChange={(v) => patchForm({ messageGroupingTime: v === NONE ? "" : v })}
            >
              <SelectTrigger id="agent-message-grouping">
                <SelectValue placeholder="Sem preferência definida" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Sem preferência definida</SelectItem>
                {withCurrentValue(MESSAGE_GROUPING_TIMES, form.messageGroupingTime).map((v) => (
                  <SelectItem key={v} value={v}>
                    {MESSAGE_GROUPING_LABELS[v as MessageGroupingTime] ?? v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-caption text-muted-foreground">
              Tempo de espera para agrupar mensagens seguidas antes de responder.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="agent-max-daily-messages">Limite de mensagens por atendimento</Label>
            <Input
              id="agent-max-daily-messages"
              inputMode="numeric"
              value={form.maxDailyMessages}
              onChange={(e) =>
                patchForm({ maxDailyMessages: e.target.value.replace(/[^0-9]/g, "") })
              }
              placeholder="Sem limite"
            />
            <p className="text-caption text-muted-foreground">
              Ex.: 20, 50, 100, 200, 500, 1000. Deixe vazio para não limitar.
            </p>
          </div>

          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="agent-max-daily-limit-action">Ao atingir o limite de mensagens</Label>
            <Select
              value={form.maxDailyMessagesLimitAction || NONE}
              onValueChange={(v) => patchForm({ maxDailyMessagesLimitAction: v === NONE ? "" : v })}
              disabled={!hasLimit}
            >
              <SelectTrigger id="agent-max-daily-limit-action">
                <SelectValue placeholder="Sem ação definida" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Sem ação definida</SelectItem>
                {withCurrentValue(
                  MAX_DAILY_MESSAGES_LIMIT_ACTIONS,
                  form.maxDailyMessagesLimitAction,
                ).map((v) => (
                  <SelectItem key={v} value={v}>
                    {MAX_DAILY_LIMIT_ACTION_LABELS[v as MaxDailyMessagesLimitAction] ?? v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-caption text-muted-foreground">
              {hasLimit
                ? "Usado apenas quando há limite de mensagens definido acima."
                : "Defina um limite de mensagens acima para escolher a ação."}
            </p>
          </div>

          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="agent-on-lack-knowledge">Webhook de falta de conhecimento</Label>
            <Input
              id="agent-on-lack-knowledge"
              value={form.onLackKnowLedge}
              onChange={(e) => patchForm({ onLackKnowLedge: e.target.value })}
              placeholder="https://sua-integracao.com/webhook"
              aria-invalid={!webhookValid}
            />
            <p className="text-caption text-muted-foreground">
              URL chamada quando o agente não sabe responder por falta de conhecimento.
            </p>
            {!webhookValid && (
              <p className="text-caption text-destructive">
                Informe uma URL válida ou deixe em branco.
              </p>
            )}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <ToggleRow
            id="agent-enabled-human-transfer"
            label="Transferência para humano"
            help="Define se o agente pode transferir para humano."
            checked={form.enabledHumanTransfer}
            onCheckedChange={(v) => patchForm({ enabledHumanTransfer: v })}
          />
          <ToggleRow
            id="agent-enabled-reminder"
            label="Lembretes"
            help="Define se o agente pode agendar lembretes."
            checked={form.enabledReminder}
            onCheckedChange={(v) => patchForm({ enabledReminder: v })}
          />
          <ToggleRow
            id="agent-split-messages"
            label="Dividir mensagens grandes"
            help="Divide a resposta em várias mensagens quando ela for muito grande."
            checked={form.splitMessages}
            onCheckedChange={(v) => patchForm({ splitMessages: v })}
          />
          <ToggleRow
            id="agent-enabled-emoji"
            label="Emojis nas respostas"
            help="Define se o agente pode usar emojis nas respostas."
            checked={form.enabledEmoji}
            onCheckedChange={(v) => patchForm({ enabledEmoji: v })}
          />
          <ToggleRow
            id="agent-limit-subjects"
            label="Limitar assuntos"
            help="Restringe o agente a falar apenas da empresa/produto, em vez de qualquer assunto."
            checked={form.limitSubjects}
            onCheckedChange={(v) => patchForm({ limitSubjects: v })}
          />
          <ToggleRow
            id="agent-knowledge-by-function"
            label="Busca inteligente no treinamento"
            help="Consulta a base de treinamentos no momento certo para respostas mais precisas."
            checked={form.knowledgeByFunction}
            onCheckedChange={(v) => patchForm({ knowledgeByFunction: v })}
          />
          <ToggleRow
            id="agent-sign-messages"
            label="Assinar mensagens"
            help="Define se a mensagem do agente vai ser assinada ou não."
            checked={form.signMessages}
            onCheckedChange={(v) => {
              setSignMessagesTouched(true);
              patchForm({ signMessages: v });
            }}
            warning="A API não expõe o valor atual desse campo — este controle sempre começa desmarcado e só é enviado se você alterá-lo. Para enviar 'desligado' de propósito, ligue e desligue antes de salvar."
          />
        </div>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={!dirty || !webhookValid || updateMut.isPending}>
            {updateMut.isPending ? "Salvando..." : "Salvar configurações"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

interface ToggleRowProps {
  id: string;
  label: string;
  help: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  warning?: string;
}

function ToggleRow({ id, label, help, checked, onCheckedChange, warning }: ToggleRowProps) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
      <div className="space-y-0.5">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-caption text-muted-foreground">{help}</p>
        {warning && <p className="text-caption text-warning">{warning}</p>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}
