// Spec OpenAPI 3.1 da API pública. Estática (sem dados de tenant). O teste de paridade
// (tests/public-api-openapi.test.ts) garante que as rotas do router e esta spec andam juntas.
import { API_VERSION } from "../webhooks/envelope.ts";
import { DEFAULT_TOLERANCE_SECONDS, SIGNATURE_HEADER } from "../webhooks/sign.ts";

type Json = Record<string, unknown>;

export interface OpenApiOperation {
  operationId: string;
  summary: string;
  description?: string;
  tags: string[];
  security: Array<Record<string, string[]>>;
  "x-required-scope": string | null;
  parameters?: Json[];
  requestBody?: Json;
  responses: Record<string, Json>;
  /** Só o receptor de entrada: outra função, fora da base da API pública. */
  servers?: Array<{ url: string; description: string }>;
}

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: Json;
  servers: Array<{ url: string; description: string }>;
  security: Array<Record<string, string[]>>;
  paths: Record<string, Record<string, OpenApiOperation>>;
  webhooks: Record<string, { post: OpenApiOperation }>;
  components: {
    securitySchemes: Record<
      string,
      { type: string; in: string; name: string; description: string }
    >;
    schemas: Record<string, Json>;
    parameters: Record<string, Json>;
    responses: Record<string, Json>;
  };
}

const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });
const errRef = (name: string): Json => ({ $ref: `#/components/responses/${name}` });
const json = (schema: Json): Json => ({ "application/json": { schema } });
const ok = (description: string, schema: Json): Json => ({ description, content: json(schema) });
const uuidParam: Json = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
};
const pageParams: Json[] = [
  { $ref: "#/components/parameters/Cursor" },
  { $ref: "#/components/parameters/Limit" },
];
const KEY = [{ ApiKey: [] }];

// Respostas de erro comuns a toda rota autenticada.
const AUTH_ERRORS: Record<string, Json> = {
  "401": errRef("Unauthorized"),
  "429": errRef("RateLimited"),
  "500": errRef("InternalError"),
  "503": errRef("ServiceUnavailable"),
};

function op(
  operationId: string,
  summary: string,
  scope: string | null,
  responses: Record<string, Json>,
  extra: Partial<OpenApiOperation> = {},
): OpenApiOperation {
  return {
    operationId,
    summary,
    tags: extra.tags ?? ["API"],
    security: KEY,
    "x-required-scope": scope,
    ...extra,
    responses: { ...responses, ...AUTH_ERRORS, ...(scope ? { "403": errRef("Forbidden") } : {}) },
  };
}

// [tipo, operationId, resumo, schema de data]. Schemas espelham os payloads gravados
// em domain_events (20261020100000 para won/lost; 20260811123652 para os demais).
const EVENT_DESCRIPTIONS: Array<[string, string, string, string]> = [
  ["deal.won", "webhookDealWon", "Negócio ganho.", "DealClosedData"],
  ["deal.lost", "webhookDealLost", "Negócio perdido.", "DealClosedData"],
  [
    "deal.stage_changed",
    "webhookDealStageChanged",
    "Negócio mudou de etapa.",
    "DealStageChangedData",
  ],
  ["contact.created", "webhookContactCreated", "Contato criado.", "ContactCreatedData"],
];

/** Enviado só pelo botão "Enviar teste" da tela; data = {"test": true}. */
const TEST_EVENT = "webhook.test";

const uuidOrNull: Json = { type: ["string", "null"], format: "uuid" };

function webhookOp(
  type: string,
  operationId: string,
  summary: string,
  dataSchema: string,
): { post: OpenApiOperation } {
  return {
    post: {
      operationId,
      summary,
      description:
        `Enviado ao endpoint cadastrado quando ocorre ${type}. Headers: ${SIGNATURE_HEADER} ` +
        '(t=<unix>,v1=<hex>[,v1=<hex>]; HMAC-SHA256 em hex minúsculo de "<t>.<corpo cru>"), ' +
        `X-Aceleraflow-Event (${type}) e X-Aceleraflow-Delivery (id da entrega). ` +
        `Rejeite assinaturas com t fora de ${DEFAULT_TOLERANCE_SECONDS} segundos. ` +
        "Responda 2xx para confirmar; falhas são reenviadas com backoff.",
      tags: ["Webhooks"],
      security: [],
      "x-required-scope": null,
      requestBody: {
        required: true,
        content: json({
          allOf: [
            ref("WebhookEnvelope"),
            { properties: { type: { const: type }, data: ref(dataSchema) } },
          ],
        }),
      },
      responses: { "200": { description: "Recebido." } },
    },
  };
}

// Receptor das regras de entrada (inbound-webhook). Corpos de erro próprios ({"error": code}),
// espelho de supabase/functions/inbound-webhook/handler.ts: mudou um, muda o outro.
const REQUEST_ID_HEADER: Json = {
  "X-Request-Id": { schema: { type: "string" }, description: "Id desta requisição, para suporte." },
};
const inboundError = (description: string, codes: string[], extraHeaders: Json = {}): Json => ({
  description,
  headers: { ...REQUEST_ID_HEADER, ...extraHeaders },
  content: json({
    type: "object",
    required: ["error"],
    properties: { error: { type: "string", enum: codes } },
  }),
});

function inboundWebhookOp(): OpenApiOperation {
  return {
    operationId: "receiveInboundWebhook",
    summary: "Receber evento de um sistema externo (regra de entrada)",
    description:
      "URL gerada para cada regra de entrada na aba Desenvolvedores: " +
      "<URL do projeto>/functions/v1/inbound-webhook/<rule_id>. Não usa X-Api-Key: a autenticidade " +
      "vem do modo de verificação da regra. " +
      `aceleraflow_hmac: header ${SIGNATURE_HEADER} (t=<unix>,v1=<hex>), HMAC-SHA256 em hex minúsculo ` +
      `de "<t>.<corpo cru>" com o segredo whin_ da regra; t fora de ${DEFAULT_TOLERANCE_SECONDS} segundos é recusado. ` +
      "stripe_signature: header Stripe-Signature, com o segredo whsec_ do endpoint no Stripe. " +
      "header_token: token fixo num header de nome configurável (Asaas: asaas-access-token; " +
      "Hotmart: X-HOTMART-HOTTOK). " +
      "Corpo: objeto JSON de até 64 KB. Limite de 120 requisições por minuto por regra, contado só " +
      "depois de a assinatura ser aceita. Reenvio do mesmo id de evento não repete a ação. " +
      "A resposta de sucesso é sempre 200, haja ou não negócio correspondente. Depois de a " +
      "assinatura ou o token ser aceito, os modos stripe_signature e header_token respondem 200 com " +
      "ignored para evento sem id, JSON inválido ou corpo que não é objeto (o evento é descartado e " +
      "fica só nos logs, sem reenvio do gateway); aceleraflow_hmac responde 400 nesses casos.",
    tags: ["Regras de entrada"],
    security: [],
    "x-required-scope": null,
    servers: [
      {
        url: "https://SEU-PROJETO.supabase.co/functions/v1",
        description: "Placeholder: troque pelo host do seu projeto",
      },
    ],
    parameters: [
      {
        name: "rule_id",
        in: "path",
        required: true,
        description: "Id da regra de entrada (mostrado junto da URL na tela).",
        schema: { type: "string", format: "uuid" },
      },
    ],
    requestBody: {
      required: true,
      content: json({ type: "object", description: "Evento do sistema externo, no formato dele." }),
    },
    responses: {
      "200": {
        description:
          "Recebido. Mesmo corpo para evento processado, ignorado pelas condições, repetido ou sem " +
          "negócio correspondente. Nos modos stripe_signature e header_token, evento sem id " +
          "(missing_event_id), JSON inválido (invalid_json) ou corpo que não é objeto ou tem " +
          "caractere nulo (invalid_payload) também recebem 200, com o motivo em ignored, e nada é processado.",
        headers: REQUEST_ID_HEADER,
        content: json({
          type: "object",
          required: ["received", "request_id"],
          properties: {
            received: { const: true },
            request_id: { type: "string" },
            ignored: {
              type: "string",
              enum: ["invalid_json", "invalid_payload", "missing_event_id"],
              description:
                "Só nos modos stripe_signature e header_token: por que o evento foi descartado.",
            },
          },
        }),
      },
      "400": inboundError(
        "No modo aceleraflow_hmac: corpo que não é um objeto JSON válido, sem o id do evento no " +
          "caminho configurado (bad_request) ou com caractere nulo (invalid_payload). Em todos os " +
          "modos: corpo que não é UTF-8 válido (bad_request). Não reenvie sem corrigir.",
        ["bad_request", "invalid_payload"],
      ),
      "401": inboundError(
        "Regra inexistente, pausada ou assinatura/token inválido (mesma resposta nos três casos). " +
          "Com a regra pausada, o comportamento de reenvio depende do gateway: reative a regra logo.",
        ["unauthorized"],
      ),
      "413": inboundError("Corpo acima de 64 KB.", ["payload_too_large"]),
      "429": inboundError(
        "Acima de 120 requisições por minuto na regra ou do limite de ações por minuto da regra " +
          "(padrão 30). Reenvie depois do tempo de Retry-After.",
        ["rate_limited"],
        {
          "Retry-After": {
            schema: { type: "integer" },
            description: "Segundos até poder tentar de novo.",
          },
        },
      ),
      "503": inboundError(
        "Erro transitório ou limite diário de ações atingido. No limite diário a regra pausa e as " +
          "próximas requisições recebem 401; o comportamento de reenvio depende do gateway.",
        ["unavailable"],
      ),
    },
  };
}

const errorResponse = (description: string, extraHeaders: Json = {}): Json => ({
  description,
  content: json(ref("Error")),
  ...(Object.keys(extraHeaders).length ? { headers: extraHeaders } : {}),
});

export function buildOpenApiSpec(): OpenApiDocument {
  return {
    openapi: "3.1.0",
    info: {
      title: "Aceleraflow API pública",
      version: API_VERSION,
      description:
        "API REST do CRM. Autentique com o header X-Api-Key. Limite de 120 requisições por 60 segundos " +
        "por chave (429 com Retry-After). Corpo de requisição de até 64 KB (413 acima disso). " +
        "Telefones em formato internacional com sinal de mais, por exemplo +5511999998888. " +
        "O CRM avisa o fechamento de negócios por webhook (deal.won e deal.lost); " +
        "fechar negócio por API não está disponível nesta versão.",
    },
    servers: [
      {
        url: "https://SEU-PROJETO.supabase.co/functions/v1/public-api",
        description: "Placeholder: troque pelo host do seu projeto",
      },
    ],
    security: KEY,
    paths: {
      "/v1/openapi.json": {
        get: {
          operationId: "getOpenApiSpec",
          summary: "Spec OpenAPI desta API",
          description: "Pública: não exige chave e não devolve dados do tenant.",
          tags: ["API"],
          security: [],
          "x-required-scope": null,
          responses: { "200": ok("Documento OpenAPI 3.1.", { type: "object" }) },
        },
      },
      "/v1/me": {
        get: op("getMe", "Identidade da chave", null, {
          "200": ok("Tenant, chave e escopos.", {
            type: "object",
            properties: {
              data: {
                type: "object",
                properties: {
                  tenant_id: { type: "string", format: "uuid" },
                  key_id: { type: "string", format: "uuid" },
                  scopes: { type: "array", items: { type: "string" } },
                },
              },
            },
          }),
          "403": errRef("Forbidden"),
          "405": errRef("MethodNotAllowed"),
        }),
      },
      "/v1/contacts": {
        get: op(
          "listContacts",
          "Listar contatos",
          "contacts:read",
          {
            "200": ok("Página de contatos.", ref("ContactPage")),
            "422": errRef("ValidationError"),
          },
          { parameters: pageParams },
        ),
        post: op(
          "createContact",
          "Criar contato",
          "contacts:write",
          {
            "201": ok("Contato criado.", {
              type: "object",
              properties: { data: ref("Contact") },
              required: ["data"],
            }),
            "413": errRef("PayloadTooLarge"),
            "422": errRef("ValidationError"),
          },
          {
            requestBody: { required: true, content: json(ref("ContactInput")) },
          },
        ),
      },
      "/v1/contacts/{id}": {
        get: op(
          "getContact",
          "Obter contato",
          "contacts:read",
          {
            "200": ok("Contato.", {
              type: "object",
              properties: { data: ref("Contact") },
              required: ["data"],
            }),
            "404": errRef("NotFound"),
            "405": errRef("MethodNotAllowed"),
          },
          { parameters: [uuidParam] },
        ),
      },
      "/v1/deals": {
        get: op(
          "listDeals",
          "Listar negócios",
          "deals:read",
          {
            "200": ok("Página de negócios.", ref("DealPage")),
            "422": errRef("ValidationError"),
          },
          { parameters: pageParams },
        ),
      },
      "/v1/deals/{id}": {
        get: op(
          "getDeal",
          "Obter negócio",
          "deals:read",
          {
            "200": ok("Negócio.", {
              type: "object",
              properties: { data: ref("Deal") },
              required: ["data"],
            }),
            "404": errRef("NotFound"),
            "405": errRef("MethodNotAllowed"),
          },
          { parameters: [uuidParam] },
        ),
      },
      "/inbound-webhook/{rule_id}": { post: inboundWebhookOp() },
    },
    webhooks: Object.fromEntries(
      EVENT_DESCRIPTIONS.map(([type, id, summary, data]) => [
        type,
        webhookOp(type, id, summary, data),
      ]),
    ),
    components: {
      securitySchemes: {
        ApiKey: {
          type: "apiKey",
          in: "header",
          name: "X-Api-Key",
          description:
            "Chave de API do workspace. O escopo exigido por operação está em x-required-scope.",
        },
      },
      parameters: {
        Cursor: {
          name: "cursor",
          in: "query",
          required: false,
          description: "next_cursor da página anterior (uuid opaco).",
          schema: { type: "string", format: "uuid" },
        },
        Limit: {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        },
      },
      responses: {
        Unauthorized: errorResponse("Chave ausente (auth_missing) ou inválida (auth_invalid)."),
        Forbidden: errorResponse(
          "Escopo insuficiente (insufficient_scope) ou conta inativa (tenant_inactive).",
        ),
        NotFound: errorResponse("Recurso ou rota não encontrada (not_found)."),
        MethodNotAllowed: errorResponse(
          "Método não permitido (method_not_allowed); header Allow lista os aceitos.",
          {
            Allow: { schema: { type: "string" } },
          },
        ),
        PayloadTooLarge: errorResponse("Corpo acima de 64 KB (payload_too_large)."),
        ValidationError: errorResponse("Dados inválidos (validation_error)."),
        RateLimited: errorResponse("Limite de 120 requisições por 60 segundos (rate_limited).", {
          "Retry-After": {
            schema: { type: "integer" },
            description: "Segundos até poder tentar de novo.",
          },
        }),
        InternalError: errorResponse("Falha interna (internal_error)."),
        ServiceUnavailable: errorResponse("Serviço indisponível (service_unavailable)."),
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message", "request_id"],
              properties: {
                code: {
                  type: "string",
                  enum: [
                    "auth_missing",
                    "auth_invalid",
                    "insufficient_scope",
                    "tenant_inactive",
                    "not_found",
                    "method_not_allowed",
                    "validation_error",
                    "payload_too_large",
                    "rate_limited",
                    "service_unavailable",
                    "internal_error",
                  ],
                },
                message: { type: "string" },
                request_id: { type: "string" },
              },
            },
          },
        },
        Contact: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" },
            email: { type: ["string", "null"], format: "email" },
            phone: { type: ["string", "null"], description: "Formato internacional, +<dígitos>." },
            source: { type: ["string", "null"] },
            tags: { type: "array", items: { type: "string" } },
            notes: { type: ["string", "null"] },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
          },
        },
        ContactInput: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", maxLength: 200 },
            email: { type: "string", format: "email", maxLength: 500 },
            phone: {
              type: "string",
              pattern: "^\\+",
              description: "Formato internacional com +, 8 a 15 dígitos.",
            },
            source: { type: "string", maxLength: 500 },
            notes: { type: "string", maxLength: 500 },
            tags: {
              type: "array",
              maxItems: 50,
              items: { type: "string", minLength: 1, maxLength: 50 },
            },
          },
        },
        Deal: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            title: { type: "string" },
            value: { type: ["number", "null"] },
            status: { type: "string" },
            contact_id: { type: ["string", "null"], format: "uuid" },
            board_id: { type: "string", format: "uuid" },
            stage_id: { type: "string", format: "uuid" },
            lost_reason: { type: ["string", "null"] },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
          },
        },
        ContactPage: {
          type: "object",
          required: ["data", "next_cursor"],
          properties: {
            data: { type: "array", items: ref("Contact") },
            next_cursor: { type: ["string", "null"], format: "uuid" },
          },
        },
        DealPage: {
          type: "object",
          required: ["data", "next_cursor"],
          properties: {
            data: { type: "array", items: ref("Deal") },
            next_cursor: { type: ["string", "null"], format: "uuid" },
          },
        },
        WebhookEnvelope: {
          type: "object",
          required: ["id", "type", "api_version", "created_at", "tenant_id", "data"],
          properties: {
            id: { type: "string" },
            type: {
              type: "string",
              enum: [...EVENT_DESCRIPTIONS.map(([type]) => type), TEST_EVENT],
              description: `${TEST_EVENT} só chega pelo envio de teste da tela, com data {"test": true}.`,
            },
            api_version: { type: "string", const: API_VERSION },
            created_at: { type: "string", format: "date-time" },
            tenant_id: { type: "string", format: "uuid" },
            data: {
              type: "object",
              description: "Conteúdo do evento; schema por tipo em webhooks.",
            },
          },
        },
        DealClosedData: {
          type: "object",
          required: ["deal", "contact"],
          properties: {
            deal: {
              type: "object",
              required: ["id", "title", "currency", "board_id", "stage_id", "closed_at"],
              properties: {
                id: { type: "string", format: "uuid" },
                title: { type: "string" },
                value: { type: ["number", "null"] },
                currency: { type: "string", const: "BRL" },
                board_id: { type: "string", format: "uuid" },
                board_name: { type: ["string", "null"] },
                stage_id: { type: "string", format: "uuid" },
                stage_name: { type: ["string", "null"] },
                closed_at: { type: "string", format: "date-time" },
              },
            },
            contact: {
              type: ["object", "null"],
              description: "null quando o negócio não tem contato.",
              properties: {
                id: { type: "string", format: "uuid" },
                name: { type: ["string", "null"] },
                email: { type: ["string", "null"] },
                phone: { type: ["string", "null"] },
              },
            },
          },
        },
        DealStageChangedData: {
          type: "object",
          required: ["history_id", "deal_id", "to_stage_id", "changed_by_automation"],
          properties: {
            history_id: { type: "string", format: "uuid" },
            deal_id: { type: "string", format: "uuid" },
            from_stage_id: uuidOrNull,
            to_stage_id: { type: "string", format: "uuid" },
            changed_by_user_id: uuidOrNull,
            changed_by_automation: { type: "boolean" },
          },
        },
        ContactCreatedData: {
          type: "object",
          required: ["contact_id"],
          description: "Só identificadores: busque o contato em GET /v1/contacts/{id}.",
          properties: {
            contact_id: { type: "string", format: "uuid" },
            status: { type: ["string", "null"] },
            owner_id: uuidOrNull,
          },
        },
      },
    },
  };
}
