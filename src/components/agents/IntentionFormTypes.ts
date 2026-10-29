// Tipos, valores padrão e conversões puras do formulário de intenção do agente
// provedor de agentes — ver contracts/agent-platform/CONTRACT_MATRIX.md §1.5. Nenhum campo
// aqui é inventado: tudo vem do contrato gerado (schema.gen.ts / enums.gen.ts).
// Sem React — reaproveitado pelo diálogo e pelos subeditores de fields/headers/
// params/variables.
import type {
  CustomFieldType,
  IntentionFieldType,
  IntentionHttpMethod,
  IntentionType,
} from "@/integrations/agent-platform/enums.gen";
import type {
  AgentPlatformIntention,
  AgentPlatformIntentionCreate,
  AgentPlatformRequestBody,
} from "@/lib/api/agent-platform-contract";

export interface IntentionFieldDraft {
  name: string;
  jsonName: string;
  description: string;
  type: IntentionFieldType;
  required: boolean;
}

/** Par nome/valor usado tanto por `headers[]` quanto por `params[]`.
 * `masked` só é relevante para headers carregados de uma intenção existente —
 * indica que o valor real já está em memória mas não deve ser exibido cru. */
export interface IntentionKeyValueDraft {
  name: string;
  value: string;
  masked?: boolean;
}

export interface IntentionCustomFieldDraft {
  id: string;
  name: string;
  description: string;
  jsonName: string;
  type: CustomFieldType;
}

export interface IntentionVariableDraft {
  valueExpression: string;
  defaultFieldKey: string;
  useCustomField: boolean;
  customField: IntentionCustomFieldDraft;
}

export interface IntentionFormValues {
  description: string;
  type: IntentionType;
  httpMethod: IntentionHttpMethod;
  url: string;
  autoGenerateParams: boolean;
  autoGenerateBody: boolean;
  details: string;
  instructions: string;
  requestBody: string;
  fields: IntentionFieldDraft[];
  headers: IntentionKeyValueDraft[];
  params: IntentionKeyValueDraft[];
  variables: IntentionVariableDraft[];
}

/** Nomes de campo padrão aceitos em `variables[].defaultFieldKey`, exatamente
 * como documentado na descrição do campo no contrato. Não é um enum do
 * OpenAPI (o schema tipa a chave como `string` livre) — por isso a UI usa um
 * texto livre com esta lista só como legenda, sem travar outros valores que a
 * API venha a aceitar no futuro. */
export const DEFAULT_FIELD_KEYS = [
  "chat_id",
  "contact_name",
  "contact_phone",
  "contact_email",
  "contact_gender",
  "contact_birthday",
  "contact_job_title",
  "contact_org_name",
  "contact_org_state",
  "contact_org_city",
] as const;

export function emptyIntentionField(): IntentionFieldDraft {
  return { name: "", jsonName: "", description: "", type: "STRING", required: false };
}

export function emptyIntentionKeyValue(): IntentionKeyValueDraft {
  return { name: "", value: "" };
}

export function emptyIntentionVariable(): IntentionVariableDraft {
  return {
    valueExpression: "",
    defaultFieldKey: "",
    useCustomField: false,
    customField: { id: "", name: "", description: "", jsonName: "", type: "STRING" },
  };
}

export function emptyIntentionFormValues(): IntentionFormValues {
  return {
    description: "",
    type: "WEBHOOK",
    httpMethod: "POST",
    url: "",
    autoGenerateParams: true,
    autoGenerateBody: true,
    details: "",
    instructions: "",
    requestBody: "",
    fields: [],
    headers: [],
    params: [],
    variables: [],
  };
}

/** Converte uma intenção vinda de `intentions.list`/`intentions.create` em
 * valores editáveis do formulário. Headers com valor preenchido nascem
 * mascarados — o usuário precisa clicar em "Substituir" para trocar o valor. */
export function intentionToFormValues(intention: AgentPlatformIntention): IntentionFormValues {
  return {
    description: intention.description ?? "",
    // D7 (CONTRACT_MATRIX): o schema da listagem só declara o literal
    // "WEBHOOK" porque reaproveita o shape de resposta; o POST de criação do
    // mesmo recurso aceita WEBHOOK|INSTRUCTIONS. O valor remoto real pode ser
    // "INSTRUCTIONS" mesmo com o tipo gerado mais estreito — isto só alarga a
    // leitura para o union completo, sem inventar nenhum valor.
    type: (intention.type as IntentionType | undefined) ?? "WEBHOOK",
    httpMethod: intention.httpMethod ?? "POST",
    url: intention.url ?? "",
    autoGenerateParams: intention.autoGenerateParams ?? false,
    autoGenerateBody: intention.autoGenerateBody ?? false,
    details: intention.details ?? "",
    instructions: intention.instructions ?? "",
    requestBody: intention.requestBody ?? "",
    fields: (intention.fields ?? []).map((field) => ({
      name: field.name ?? "",
      jsonName: field.jsonName ?? "",
      description: field.description ?? "",
      type: field.type ?? "STRING",
      required: field.required ?? false,
    })),
    headers: (intention.headers ?? []).map((header) => ({
      name: header.name ?? "",
      value: header.value ?? "",
      masked: !!header.value,
    })),
    params: (intention.params ?? []).map((param) => ({
      name: param.name ?? "",
      value: param.value ?? "",
    })),
    variables: (intention.variables ?? []).map((variable) => ({
      valueExpression: variable.valueExpression ?? "",
      defaultFieldKey: variable.defaultFieldKey ?? "",
      useCustomField: !!variable.customField,
      customField: {
        id: variable.customField?.id ?? "",
        name: variable.customField?.name ?? "",
        description: variable.customField?.description ?? "",
        jsonName: variable.customField?.jsonName ?? "",
        type: variable.customField?.type ?? "STRING",
      },
    })),
  };
}

/** Mostra só os últimos caracteres de um valor sensível (ex.: header de
 * autenticação). Nunca usado para decidir o que é enviado — só exibição. */
export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 4) return "••••";
  return `${"•".repeat(Math.min(value.length - 4, 12))}${value.slice(-4)}`;
}

/** Valida o formulário antes de enviar. Devolve a primeira mensagem de erro
 * em PT-BR, ou `null` quando está tudo certo para enviar. Bloqueia linha em
 * branco (campo/cabeçalho/parâmetro/variável adicionado e não preenchido) —
 * sem isso o contrato recebe subcampos obrigatórios vazios, ou um clique em
 * "Substituir" sem digitar nada apaga um header salvo. */
export function validateIntentionForm(values: IntentionFormValues): string | null {
  if (!values.description.trim()) {
    return "Descreva a intenção antes de salvar.";
  }

  for (const field of values.fields) {
    if (!field.name.trim() || !field.jsonName.trim() || !field.description.trim()) {
      return "Preencha nome, nome JSON e descrição de todo campo adicionado (ou remova a linha).";
    }
  }

  // headers[]/params[]/variables[] só são enviados quando type === "WEBHOOK"
  // (ver buildIntentionCreateBody) — validar essas linhas fora desse modo
  // bloquearia o usuário por algo que nem chega a ser enviado.
  if (values.type === "WEBHOOK") {
    if (!values.url.trim()) {
      return "Informe a URL do webhook.";
    }
    for (const header of values.headers) {
      if (!header.name.trim() || !header.value.trim()) {
        return "Preencha nome e valor de todo cabeçalho adicionado (ou remova a linha).";
      }
    }
    for (const param of values.params) {
      if (!param.name.trim() || !param.value.trim()) {
        return "Preencha nome e valor de todo parâmetro adicionado (ou remova a linha).";
      }
    }
    for (const variable of values.variables) {
      if (!variable.valueExpression.trim()) {
        return "Toda variável precisa de uma expressão de valor preenchida.";
      }
    }
  }

  if (values.requestBody.trim()) {
    try {
      JSON.parse(values.requestBody);
    } catch {
      return "O corpo da requisição (JSON) está inválido. Corrija o texto antes de salvar.";
    }
  }
  return null;
}

/** Corpo de criação (`POST /v2/agent/{agentId}/intentions`). Campos que só
 * fazem sentido para WEBHOOK (URL, método, headers, params, variáveis,
 * geração automática) são zerados quando o tipo é INSTRUCTIONS — o contrato
 * ainda os marca como obrigatórios no POST mesmo assim (D7), então preenchemos
 * valores neutros em vez de bloquear o usuário. `fields[]` continua valendo
 * para os dois tipos: o schema é um objeto único, sem `oneOf` por `type`. */
export function buildIntentionCreateBody(
  values: IntentionFormValues,
): AgentPlatformIntentionCreate {
  const isWebhook = values.type === "WEBHOOK";
  return {
    description: values.description.trim(),
    type: values.type,
    httpMethod: isWebhook ? values.httpMethod : "POST",
    url: isWebhook ? values.url.trim() : "",
    autoGenerateParams: isWebhook ? values.autoGenerateParams : false,
    autoGenerateBody: isWebhook ? values.autoGenerateBody : false,
    details: values.details.trim() || undefined,
    instructions: values.instructions.trim() || undefined,
    fields: values.fields.length
      ? values.fields.map((field) => ({
          name: field.name.trim(),
          jsonName: field.jsonName.trim(),
          description: field.description.trim(),
          type: field.type,
          required: field.required,
        }))
      : undefined,
    headers:
      isWebhook && values.headers.length
        ? values.headers.map((header) => ({ name: header.name.trim(), value: header.value }))
        : undefined,
    params:
      isWebhook && values.params.length
        ? values.params.map((param) => ({ name: param.name.trim(), value: param.value }))
        : undefined,
    variables:
      isWebhook && values.variables.length
        ? values.variables.map((variable) => ({
            valueExpression: variable.valueExpression.trim(),
            defaultFieldKey: variable.useCustomField
              ? undefined
              : variable.defaultFieldKey.trim() || undefined,
            customField: variable.useCustomField
              ? {
                  id: variable.customField.id.trim() || undefined,
                  name: variable.customField.name.trim() || undefined,
                  description: variable.customField.description.trim() || undefined,
                  jsonName: variable.customField.jsonName.trim() || undefined,
                  type: variable.customField.type,
                }
              : undefined,
          }))
        : undefined,
    requestBody: isWebhook ? values.requestBody.trim() || undefined : undefined,
  };
}

/** Corpo de atualização (`PUT /v2/intention/{intentionId}`). Mesmo shape do
 * POST de criação — só a assinatura estática de `type` é mais estreita no
 * contrato gerado (D7, ver `intentionToFormValues` acima). Enviamos o valor
 * real escolhido pelo usuário; a asserção só corrige o tipo estático, não o
 * dado enviado. */
export function buildIntentionUpdateBody(
  values: IntentionFormValues,
): AgentPlatformRequestBody<"intention.update"> {
  const createBody = buildIntentionCreateBody(values);
  return {
    ...createBody,
    type: createBody.type as "WEBHOOK",
  };
}
