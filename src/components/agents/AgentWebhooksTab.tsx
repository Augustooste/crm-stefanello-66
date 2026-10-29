// Aba "Webhooks" do agente provedor de agentes — GET/PUT /v2/agent/{agentId}/webhooks
// (ver contracts/agent-platform/CONTRACT_MATRIX.md §1.9). Todo campo é opcional no
// contrato; nenhum é obrigatório para salvar.
//
// Limitação de contrato (visível na UI, não só aqui): o schema declara todos
// os 8 campos como `string`, mas não documenta o efeito de enviar `""` — não
// há confirmação de que isso remove um webhook já salvo. Por isso o formulário
// NUNCA envia campo vazio: só os campos com valor preenchido vão no PUT. Para
// remover um webhook configurado, o usuário precisa do painel do provedor de agentes.
import { useEffect, useState } from "react";
import { AlertTriangle, Webhook } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useAgentPlatformMutation, useAgentPlatformQuery } from "@/lib/api/agent-platform";
import type {
  AgentPlatformRequestBody,
  AgentPlatformWebhooks,
} from "@/lib/api/agent-platform-contract";

type WebhookKey = keyof AgentPlatformWebhooks;
type WebhooksFormState = Record<WebhookKey, string>;
type WebhooksUpdateBody = AgentPlatformRequestBody<"agent.webhooks.update">;

interface WebhookFieldMeta {
  key: WebhookKey;
  label: string;
  description: string;
}

// Ordem e descrições espelham exatamente `/v2/agent/{agentId}/webhooks` no
// contrato (contracts/agent-platform/openapi.json). Grafia de `onLackKnowLedge`
// preservada como está no contrato remoto.
const WEBHOOK_FIELDS: WebhookFieldMeta[] = [
  {
    key: "onNewMessage",
    label: "Nova mensagem",
    description: "Disparado automaticamente sempre que uma nova mensagem chega em um chat.",
  },
  {
    key: "onLackKnowLedge",
    label: "IA sem resposta",
    description: "Disparado quando o agente não sabe responder a uma pergunta.",
  },
  {
    key: "onTransfer",
    label: "Transferência para humano",
    description: "Disparado quando o agente transfere o atendimento para um humano.",
  },
  {
    key: "onFirstInteraction",
    label: "Primeiro atendimento",
    description:
      "Disparado automaticamente assim que o primeiro atendimento com o cliente é iniciado.",
  },
  {
    key: "onStartInteraction",
    label: "Início de atendimento",
    description: "Disparado automaticamente sempre que um atendimento com o cliente é iniciado.",
  },
  {
    key: "onFinishInteraction",
    label: "Fim de atendimento",
    description: "Disparado automaticamente sempre que um atendimento é finalizado.",
  },
  {
    key: "onCreateEvent",
    label: "Agendamento criado",
    description: "Disparado automaticamente sempre que um agendamento é realizado.",
  },
  {
    key: "onCancelEvent",
    label: "Agendamento cancelado",
    description: "Disparado automaticamente sempre que um agendamento é cancelado.",
  },
];

const EMPTY_FORM: WebhooksFormState = {
  onNewMessage: "",
  onLackKnowLedge: "",
  onTransfer: "",
  onFirstInteraction: "",
  onStartInteraction: "",
  onFinishInteraction: "",
  onCreateEvent: "",
  onCancelEvent: "",
};

/** Vazio é sempre válido aqui — decide se ENVIAR, não se o texto é uma URL. */
function isValidHttpsUrl(value: string): boolean {
  if (!value) return true;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function buildUpdateBody(form: WebhooksFormState): WebhooksUpdateBody {
  const body: WebhooksUpdateBody = {};
  for (const field of WEBHOOK_FIELDS) {
    const value = form[field.key].trim();
    if (value) body[field.key] = value;
  }
  return body;
}

export function AgentWebhooksTab({ agentId }: { agentId: string }) {
  const webhooksQ = useAgentPlatformQuery("agent.webhooks.get", { params: { agentId } });
  const updateWebhooks = useAgentPlatformMutation("agent.webhooks.update");

  const [form, setForm] = useState<WebhooksFormState>(EMPTY_FORM);
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<WebhookKey, string>>>({});

  useEffect(() => {
    if (!webhooksQ.data || dirty) return;
    const next: WebhooksFormState = { ...EMPTY_FORM };
    for (const field of WEBHOOK_FIELDS) {
      next[field.key] = webhooksQ.data[field.key] ?? "";
    }
    setForm(next);
  }, [webhooksQ.data, dirty]);

  function updateField(key: WebhookKey, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
    setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
  }

  function handleSave() {
    const nextErrors: Partial<Record<WebhookKey, string>> = {};
    for (const field of WEBHOOK_FIELDS) {
      const value = form[field.key].trim();
      if (value && !isValidHttpsUrl(value)) {
        nextErrors[field.key] = "URL inválida. Use um endereço completo iniciado por https://.";
      }
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    updateWebhooks.mutate(
      { params: { agentId }, body: buildUpdateBody(form) },
      {
        onSuccess: () => {
          setDirty(false);
          toast.success("Webhooks do agente salvos.");
        },
        onError: (error) => toast.error(error.message),
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-card-title">
          <Webhook className="h-4 w-4" aria-hidden />
          Webhooks do agente
        </CardTitle>
        <CardDescription>
          Endereços HTTPS que o provedor de agentes chama automaticamente em cada evento do agente.
          Deixe em branco o que não quiser configurar — o contrato do provedor de agentes não
          documenta como limpar um webhook já salvo por aqui, então este formulário nunca envia
          campo vazio. Para remover um endereço já configurado, use o painel do provedor de agentes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {webhooksQ.isPending ? (
          <div className="space-y-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : webhooksQ.isError ? (
          <EmptyState
            icon={AlertTriangle}
            title="Não foi possível carregar os webhooks"
            description={webhooksQ.error.message}
            actionLabel="Tentar de novo"
            onAction={() => webhooksQ.refetch()}
          />
        ) : (
          <>
            {WEBHOOK_FIELDS.map((field) => (
              <div key={field.key} className="space-y-1.5">
                <Label htmlFor={`webhook-${field.key}`}>{field.label}</Label>
                <p className="text-caption text-muted-foreground">{field.description}</p>
                <Input
                  id={`webhook-${field.key}`}
                  type="url"
                  placeholder="https://"
                  value={form[field.key]}
                  onChange={(event) => updateField(field.key, event.target.value)}
                  aria-invalid={!!errors[field.key]}
                />
                {errors[field.key] && (
                  <p className="text-caption text-destructive">{errors[field.key]}</p>
                )}
              </div>
            ))}
            <div className="flex justify-end">
              <Button onClick={handleSave} disabled={!dirty || updateWebhooks.isPending}>
                {updateWebhooks.isPending ? "Salvando..." : "Salvar webhooks"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
