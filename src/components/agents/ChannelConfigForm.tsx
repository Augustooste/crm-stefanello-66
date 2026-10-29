// Configuração do canal — `GET`/`PUT /v2/channel/{id}/config`.
//
// Divergência D9 (contracts/agent-platform/CONTRACT_MATRIX.md §1.7 e §2): o corpo
// do PUT só declara `id`, `tenant`, `audioAction`, `startTrigger`, `endTrigger`.
// `id` e `tenant` são identificadores (o `channelId` já viaja na URL, e
// `tenant` é um ID interno do provedor de agentes que não temos motivo pra ecoar de
// volta) — por isso só os 3 gatilhos são editáveis aqui; o próprio texto do
// PUT no contrato diz "envie apenas as configurações que deseja alterar".
// `audioAction`/`startTrigger`/`endTrigger` são `string` livre no contrato —
// SEM enum declarado (só exemplos por campo: DISABLED / ONLY_WHEN_CALLING_BY_NAME
// / WHEN_SAY_GOODBYE) — por isso são campos de texto livre, nunca um Select.
//
// O GET devolve 4 variantes (`oneOf`): Z_API, WHATSAPP, INSTAGRAM e uma
// genérica (TWILIO_SMS/TELEGRAM/MERCADO_LIVRE/MESSENGER). CLOUD_API e WIDGET
// não têm variante própria descrita no contrato — avisamos isso na tela em
// vez de fingir que sabemos o formato.
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { EmptyState } from "@/components/common/EmptyState";
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
import { Skeleton } from "@/components/ui/skeleton";
import type { ChannelType } from "@/integrations/agent-platform/enums.gen";
import { useAgentPlatformMutation, useAgentPlatformQuery } from "@/lib/api/agent-platform";
import type { AgentPlatformRequestBody } from "@/lib/api/agent-platform-contract";

import { CHANNEL_TYPE_LABELS, type NormalizedChannel } from "./channel-labels";

type ConfigUpdateBody = AgentPlatformRequestBody<"channel.config.update">;

// Sem variante própria no `oneOf` de GET — o contrato simplesmente não
// descreve o retorno pra estes dois tipos.
const TYPES_WITHOUT_CONFIG_VARIANT = new Set<ChannelType>(["CLOUD_API", "WIDGET"]);

// Conexão/configuração avançada destes tipos é feita no painel do provedor de agentes
// (OAuth ou número oficial) — o contrato só expõe os 3 gatilhos comuns.
const OAUTH_MANAGED_TYPES = new Set<ChannelType>([
  "INSTAGRAM",
  "MESSENGER",
  "MERCADO_LIVRE",
  "CLOUD_API",
  "TELEGRAM",
  "TWILIO_SMS",
]);

interface ExtraField {
  key: string;
  label: string;
  kind: "boolean" | "text";
}

// Campos extras de cada variante do GET, mostrados só como leitura — quem
// decide qual lista usar é o `channel.type` já conhecido pela listagem (a
// variante genérica e a do INSTAGRAM não trazem um discriminador `type` no
// retorno, então não dá pra confiar nisso pra decidir).
const EXTRA_FIELDS_BY_TYPE: Partial<Record<ChannelType, ExtraField[]>> = {
  Z_API: [
    { key: "enabledTyping", label: "Indicador de 'digitando'", kind: "boolean" },
    { key: "enableGroupsResponse", label: "Responde em grupos", kind: "boolean" },
    { key: "replyGroupsType", label: "Tipo de resposta em grupos", kind: "text" },
    { key: "enablePrivateChatResponse", label: "Responde em chat privado", kind: "boolean" },
    { key: "callRejectAuto", label: "Rejeita chamadas automaticamente", kind: "boolean" },
    { key: "callRejectMessage", label: "Mensagem ao rejeitar chamada", kind: "text" },
    {
      key: "takeOutsideService",
      label: "Retira atendimento para fora do serviço",
      kind: "boolean",
    },
    { key: "takeOutsideServiceMember", label: "Membro alvo da ação", kind: "text" },
    { key: "takeOutsideServiceCommand", label: "Comando utilizado", kind: "text" },
    { key: "takeOutsideServiceMessage", label: "Mensagem utilizada", kind: "text" },
    { key: "takeOutsideServiceCommandReturn", label: "Retorna após o comando", kind: "boolean" },
    { key: "takeOutsideServiceReturnMessage", label: "Mensagem de retorno", kind: "text" },
    { key: "waitingMessageEnabled", label: "Mensagem de espera habilitada", kind: "boolean" },
    { key: "waitingMessageText", label: "Texto da mensagem de espera", kind: "text" },
  ],
  WHATSAPP: [{ key: "enabledTyping", label: "Indicador de 'digitando'", kind: "boolean" }],
  INSTAGRAM: [
    { key: "notReactInstagramStories", label: "Ignora stories do Instagram", kind: "boolean" },
    {
      key: "takeOutsideService",
      label: "Retira atendimento para fora do serviço",
      kind: "boolean",
    },
    { key: "takeOutsideServiceMember", label: "Membro alvo da ação", kind: "text" },
    { key: "takeOutsideServiceCommand", label: "Comando utilizado", kind: "text" },
    { key: "takeOutsideServiceMessage", label: "Mensagem utilizada", kind: "text" },
    { key: "takeOutsideServiceCommandReturn", label: "Retorna após o comando", kind: "boolean" },
    { key: "takeOutsideServiceReturnMessage", label: "Mensagem de retorno", kind: "text" },
    { key: "commentsReplyEnabled", label: "Responde comentários", kind: "boolean" },
    { key: "commentsReplyAllEnabled", label: "Responde todos os comentários", kind: "boolean" },
    {
      key: "commentsReplyAllInstruction",
      label: "Instrução p/ responder comentários",
      kind: "text",
    },
    { key: "commentsCallDirectInstruction", label: "Instrução p/ chamar no direct", kind: "text" },
  ],
};

function readExtra(config: Record<string, unknown> | undefined, key: string): unknown {
  return config?.[key];
}

interface ChannelConfigFormProps {
  channel: NormalizedChannel;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ChannelConfigForm({ channel, open, onOpenChange }: ChannelConfigFormProps) {
  const configQuery = useAgentPlatformQuery(
    "channel.config.get",
    { params: { channelId: channel.id } },
    { enabled: open },
  );

  const [draft, setDraft] = useState({ audioAction: "", startTrigger: "", endTrigger: "" });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!open) setLoaded(false);
  }, [open]);

  useEffect(() => {
    if (open && configQuery.data && !loaded) {
      setDraft({
        audioAction: configQuery.data.audioAction ?? "",
        startTrigger: configQuery.data.startTrigger ?? "",
        endTrigger: configQuery.data.endTrigger ?? "",
      });
      setLoaded(true);
    }
  }, [open, configQuery.data, loaded]);

  const updateMut = useAgentPlatformMutation("channel.config.update", {
    invalidate: ["channels.list", "channel.config.get"],
    onSuccess: () => {
      toast.success("Configuração do canal salva.");
      onOpenChange(false);
    },
    onError: (error) => toast.error(error.message),
  });

  function handleSave() {
    const body: ConfigUpdateBody = {
      audioAction: draft.audioAction.trim() || null,
      startTrigger: draft.startTrigger.trim() || null,
      endTrigger: draft.endTrigger.trim() || null,
    };
    updateMut.mutate({ params: { channelId: channel.id }, body });
  }

  const extraFields = EXTRA_FIELDS_BY_TYPE[channel.type] ?? [];
  const rawConfig = configQuery.data as unknown as Record<string, unknown> | undefined;
  const missingVariant = TYPES_WITHOUT_CONFIG_VARIANT.has(channel.type);
  const oauthManaged = OAUTH_MANAGED_TYPES.has(channel.type);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Configurar {channel.name}</DialogTitle>
          <DialogDescription>{CHANNEL_TYPE_LABELS[channel.type]}</DialogDescription>
        </DialogHeader>

        {configQuery.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : configQuery.isError ? (
          <EmptyState
            title="Não foi possível carregar a configuração"
            description={configQuery.error?.message ?? "Erro ao carregar a configuração."}
            actionLabel="Tentar de novo"
            onAction={() => configQuery.refetch()}
          />
        ) : (
          <div className="flex flex-col gap-4">
            {missingVariant && (
              <p className="rounded-md border border-border bg-surface p-3 text-caption text-muted-foreground">
                O contrato público do provedor de agentes não descreve o formato de configuração
                para {CHANNEL_TYPE_LABELS[channel.type]}. Os campos abaixo são os únicos comuns a
                todo canal; o restante é gerenciado no painel do provedor de agentes.
              </p>
            )}
            {!missingVariant && oauthManaged && (
              <p className="rounded-md border border-border bg-surface p-3 text-caption text-muted-foreground">
                Ajustes de conexão deste canal (OAuth, número oficial) são feitos no painel do GPT
                Maker. Aqui você só edita os gatilhos comuns abaixo.
              </p>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="cfg-audio-action">Ação de áudio</Label>
              <Input
                id="cfg-audio-action"
                value={draft.audioAction}
                onChange={(e) => setDraft((d) => ({ ...d, audioAction: e.target.value }))}
                placeholder="Ex.: DISABLED"
              />
              <p className="text-caption text-muted-foreground">
                Campo livre no contrato (sem lista fechada de valores) — exemplo visto: DISABLED.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cfg-start-trigger">Gatilho de início</Label>
              <Input
                id="cfg-start-trigger"
                value={draft.startTrigger}
                onChange={(e) => setDraft((d) => ({ ...d, startTrigger: e.target.value }))}
                placeholder="Ex.: ONLY_WHEN_CALLING_BY_NAME"
              />
              <p className="text-caption text-muted-foreground">
                Campo livre no contrato — exemplo visto: ONLY_WHEN_CALLING_BY_NAME.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cfg-end-trigger">Gatilho de encerramento</Label>
              <Input
                id="cfg-end-trigger"
                value={draft.endTrigger}
                onChange={(e) => setDraft((d) => ({ ...d, endTrigger: e.target.value }))}
                placeholder="Ex.: WHEN_SAY_GOODBYE"
              />
              <p className="text-caption text-muted-foreground">
                Campo livre no contrato — exemplo visto: WHEN_SAY_GOODBYE.
              </p>
            </div>

            {extraFields.length > 0 && (
              <div className="flex flex-col gap-2 rounded-md border border-border p-3">
                <p className="text-caption font-medium text-foreground">
                  Outros campos devolvidos pelo provedor de agentes (somente leitura)
                </p>
                <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
                  {extraFields.map((field) => (
                    <div key={field.key} className="flex items-center justify-between gap-2">
                      <dt className="text-caption text-muted-foreground">{field.label}</dt>
                      <dd className="text-caption font-medium text-foreground">
                        {formatExtraValue(readExtra(rawConfig, field.key), field.kind)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            onClick={handleSave}
            disabled={updateMut.isPending || configQuery.isLoading || configQuery.isError}
          >
            {updateMut.isPending ? "Salvando…" : "Salvar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatExtraValue(value: unknown, kind: ExtraField["kind"]): string {
  if (value === null || value === undefined) return "—";
  if (kind === "boolean") return value === true ? "Sim" : value === false ? "Não" : "—";
  return typeof value === "string" ? value || "—" : "—";
}
