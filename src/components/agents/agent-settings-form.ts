// Lógica pura (sem JSX) da aba "Modelo e configurações" do agente provedor de agentes.
// Separado de AgentSettingsTab.tsx só para manter o componente ≤400 linhas —
// ver contracts/agent-platform/CONTRACT_MATRIX.md §1.2 e divergências D3/D4.
import type {
  AgentPlatformAgentSettings,
  AgentPlatformAgentSettingsUpdate,
} from "@/lib/api/agent-platform-contract";
import type {
  MaxDailyMessagesLimitAction,
  MessageGroupingTime,
  PrefferModel,
} from "@/integrations/agent-platform/enums.gen";

// Sentinela de "nada selecionado" nos Selects opcionais — os valores reais do
// contrato são sempre UPPER_SNAKE_CASE, então "none" nunca colide.
export const NONE = "none";

// Rótulos PT-BR para os dois enums pequenos e estáveis do contrato (não
// crescem como a lista de modelos, então mapear à mão aqui não viola a regra
// de "não escrever lista manual de modelos" — essa regra é só sobre
// PREFFER_MODELS).
export const MESSAGE_GROUPING_LABELS: Record<MessageGroupingTime, string> = {
  NO_GROUP: "Sem agrupamento",
  FIVE_SEC: "5 segundos",
  TEN_SEC: "10 segundos",
  // THIRD_SEC é a grafia do contrato (provável "thirty seconds" = 30s) — não corrigimos o enum.
  THIRD_SEC: "30 segundos",
  ONE_MINUTE: "1 minuto",
};

export const MAX_DAILY_LIMIT_ACTION_LABELS: Record<MaxDailyMessagesLimitAction, string> = {
  TEMP_BLOCK_30S: "Bloquear a conversa por 30 segundos",
  TEMP_BLOCK_5M: "Bloquear a conversa por 5 minutos",
  TEMP_BLOCK_10M: "Bloquear a conversa por 10 minutos",
  TEMP_BLOCK_30M: "Bloquear a conversa por 30 minutos",
  TEMP_BLOCK_1H: "Bloquear a conversa por 1 hora",
  BLOCK: "Bloquear a conversa",
  TRANSFER: "Transferir para um humano",
};

/** Modelo -> rótulo legível sem tabela manual (o contrato não descreve nomes de exibição). */
export function formatModelLabel(model: string): string {
  return model.replace(/_/g, " ");
}

/** Mantém visível/selecionado um valor remoto fora do enum conhecido (ex.: modelo novo). */
export function withCurrentValue(known: readonly string[], current: string): string[] {
  if (current && !known.includes(current)) return [current, ...known];
  return [...known];
}

/** Valida `onLackKnowLedge` como URL de webhook (contrato só tipa como `string`,
 * mas a descrição diz que é chamada de webhook — exigimos http/https). */
export function isValidUrl(value: string): boolean {
  if (!value) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export interface FormState {
  prefferModel: string;
  timezone: string;
  enabledHumanTransfer: boolean;
  enabledReminder: boolean;
  splitMessages: boolean;
  enabledEmoji: boolean;
  limitSubjects: boolean;
  knowledgeByFunction: boolean;
  messageGroupingTime: string;
  onLackKnowLedge: string;
  /** String do campo numérico; "" = sem limite (vira `null` no payload — ver D4). */
  maxDailyMessages: string;
  maxDailyMessagesLimitAction: string;
  /** D3: nunca vem do GET — começa desmarcado, só é enviado se o usuário tocar. */
  signMessages: boolean;
}

export function toFormState(remote: AgentPlatformAgentSettings): FormState {
  return {
    prefferModel: remote.prefferModel ?? "",
    timezone: remote.timezone ?? "",
    enabledHumanTransfer: remote.enabledHumanTransfer ?? false,
    enabledReminder: remote.enabledReminder ?? false,
    splitMessages: remote.splitMessages ?? false,
    enabledEmoji: remote.enabledEmoji ?? false,
    limitSubjects: remote.limitSubjects ?? false,
    knowledgeByFunction: remote.knowledgeByFunction ?? false,
    messageGroupingTime: remote.messageGroupingTime ?? "",
    onLackKnowLedge: remote.onLackKnowLedge ?? "",
    maxDailyMessages:
      remote.maxDailyMessages === null || remote.maxDailyMessages === undefined
        ? ""
        : String(remote.maxDailyMessages),
    maxDailyMessagesLimitAction: remote.maxDailyMessagesLimitAction ?? "",
    signMessages: false,
  };
}

/**
 * Monta o corpo do PUT. Nunca inclui chave com valor `undefined` — campo
 * vazio/não tocado simplesmente não entra no objeto (spread condicional).
 *
 * D4: o tipo gerado do PUT tipa `maxDailyMessages` como `number` (sem
 * `null`), mas a própria descrição do contrato diz que `null` limpa o
 * limite. Por isso o retorno é ampliado localmente e o cast para
 * `AgentPlatformAgentSettingsUpdate` acontece só na borda de envio (em
 * `AgentSettingsTab.handleSave`), nunca com `any`.
 */
export function buildUpdatePayload(
  form: FormState,
  signMessagesTouched: boolean,
): Omit<AgentPlatformAgentSettingsUpdate, "maxDailyMessages"> & {
  maxDailyMessages: number | null;
} {
  const trimmedTimezone = form.timezone.trim();
  const trimmedWebhook = form.onLackKnowLedge.trim();
  const maxDailyMessages =
    form.maxDailyMessages.trim() === "" ? null : Number(form.maxDailyMessages);

  return {
    ...(form.prefferModel ? { prefferModel: form.prefferModel as PrefferModel } : {}),
    ...(trimmedTimezone ? { timezone: trimmedTimezone } : {}),
    enabledHumanTransfer: form.enabledHumanTransfer,
    enabledReminder: form.enabledReminder,
    splitMessages: form.splitMessages,
    enabledEmoji: form.enabledEmoji,
    limitSubjects: form.limitSubjects,
    knowledgeByFunction: form.knowledgeByFunction,
    ...(form.messageGroupingTime
      ? { messageGroupingTime: form.messageGroupingTime as MessageGroupingTime }
      : {}),
    ...(trimmedWebhook ? { onLackKnowLedge: trimmedWebhook } : {}),
    maxDailyMessages,
    ...(maxDailyMessages !== null && form.maxDailyMessagesLimitAction
      ? {
          maxDailyMessagesLimitAction:
            form.maxDailyMessagesLimitAction as MaxDailyMessagesLimitAction,
        }
      : {}),
    ...(signMessagesTouched ? { signMessages: form.signMessages } : {}),
  };
}
