#!/usr/bin/env node
// Gera, a partir de contracts/agent-platform/openapi.json (contrato versionado):
//   1. src/integrations/agent-platform/schema.gen.ts — tipos (openapi-typescript)
//   2. src/integrations/agent-platform/enums.gen.ts  — enums em runtime
//
// Os dois saem em `src/` porque quem consome tipo do contrato é o app (o proxy
// repassa o payload remoto sem renomear campo, então o tipo vale ponta a ponta).
// A edge function não importa daqui: `supabase/functions` é bundle Deno separado
// e um import cruzando as duas árvores quebraria o deploy.
//
// Enums em runtime existem porque `openapi-typescript` emite só tipos e a UI
// precisa iterar valores em <Select>. Cada enum aponta para a operação e o campo
// exatos do contrato: se o contrato mudar de forma, o script FALHA em vez de
// emitir uma lista velha em silêncio (era o risco de manter lista manual).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const specPath = resolve(root, "contracts/agent-platform/openapi.json");
const schemaOut = resolve(root, "src/integrations/agent-platform/schema.gen.ts");
const enumsOut = resolve(root, "src/integrations/agent-platform/enums.gen.ts");

const spec = JSON.parse(readFileSync(specPath, "utf8"));

/** Resolve `#/components/...` e devolve o nó. */
function deref(node) {
  if (!node || !node.$ref) return node;
  return node.$ref
    .replace(/^#\//, "")
    .split("/")
    .reduce((cur, key) => cur[key], spec);
}

/**
 * Caminha um schema com a sintaxe usada nos locators abaixo:
 *   `prop`      → properties.prop
 *   `prop[]`    → properties.prop.items
 *   `#2`        → oneOf[2]
 */
function walk(schema, path, where) {
  let node = deref(schema);
  for (const raw of path.split(".").filter(Boolean)) {
    if (!node) throw new Error(`${where}: caminho "${path}" quebrou antes de "${raw}"`);
    const oneOf = raw.match(/^#(\d+)$/);
    if (oneOf) {
      node = deref(node.oneOf?.[Number(oneOf[1])]);
      continue;
    }
    const name = raw.replace(/\[\]$/, "");
    node = deref(node.properties?.[name]);
    if (raw.endsWith("[]")) node = deref(node?.items);
  }
  if (!node?.enum) throw new Error(`${where}: "${path}" não tem enum no contrato`);
  return node.enum;
}

function operation(method, path) {
  const op = spec.paths?.[path]?.[method];
  if (!op) throw new Error(`operação inexistente no contrato: ${method.toUpperCase()} ${path}`);
  return op;
}

function fromBody(method, path, field) {
  const op = operation(method, path);
  const schema = op.requestBody?.content?.["application/json"]?.schema;
  return walk(schema, field, `${method.toUpperCase()} ${path} body`);
}

function fromResponse(method, path, status, field) {
  const op = operation(method, path);
  const schema = op.responses?.[status]?.content?.["application/json"]?.schema;
  const arrayAware = deref(schema)?.type === "array" ? deref(schema).items : schema;
  return walk(arrayAware, field, `${method.toUpperCase()} ${path} resp ${status}`);
}

function fromParam(method, path, name) {
  const op = operation(method, path);
  const param = (op.parameters ?? []).find((p) => p.name === name);
  if (!param?.schema?.enum) {
    throw new Error(`${method.toUpperCase()} ${path}: param "${name}" sem enum`);
  }
  return param.schema.enum;
}

const enums = {
  PREFFER_MODELS: fromBody("put", "/v2/agent/{agentId}/settings", "prefferModel"),
  MESSAGE_GROUPING_TIMES: fromBody("put", "/v2/agent/{agentId}/settings", "messageGroupingTime"),
  MAX_DAILY_MESSAGES_LIMIT_ACTIONS: fromBody(
    "put",
    "/v2/agent/{agentId}/settings",
    "maxDailyMessagesLimitAction",
  ),
  COMMUNICATION_TYPES: fromBody("put", "/v2/agent/{agentId}", "communicationType"),
  AGENT_TYPES: fromBody("put", "/v2/agent/{agentId}", "type"),
  TRAINING_TYPES: fromParam("get", "/v2/agent/{agentId}/trainings", "type"),
  TRAINING_SUB_PAGES: fromBody("post", "/v2/agent/{agentId}/trainings", "#1.trainingSubPages"),
  TRAINING_INTERVALS: fromBody("post", "/v2/agent/{agentId}/trainings", "#1.trainingInterval"),
  INTENTION_TYPES: fromBody("post", "/v2/agent/{agentId}/intentions", "type"),
  INTENTION_FIELD_TYPES: fromBody("post", "/v2/agent/{agentId}/intentions", "fields[].type"),
  INTENTION_HTTP_METHODS: fromBody("post", "/v2/agent/{agentId}/intentions", "httpMethod"),
  CHANNEL_TYPES: fromResponse("get", "/v2/workspace/{workspaceId}/channels", "200", "data[].type"),
  CUSTOM_FIELD_TYPES: fromBody("post", "/v2/custom-field/workspace/{workspaceId}", "type"),
  TRANSFER_RULE_TYPES: fromBody("post", "/v2/agent/{agentId}/transfer-rules", "type"),
  MCP_URL_TYPES: fromBody("post", "/v2/agent/{agentId}/mcp/add", "urlType"),
  MCP_AUTH_TYPES: fromBody("post", "/v2/agent/{agentId}/mcp/add", "authType"),
  WORKSPACE_STATUSES: fromResponse("get", "/v2/workspace/{workspaceId}/credits", "200", "status"),
  IDLE_ACTION_TYPES: fromResponse(
    "get",
    "/v2/agent/{agentId}/idle-actions",
    "200",
    "actions[].type",
  ),
};

const typeNameOf = {
  PREFFER_MODELS: "PrefferModel",
  MESSAGE_GROUPING_TIMES: "MessageGroupingTime",
  MAX_DAILY_MESSAGES_LIMIT_ACTIONS: "MaxDailyMessagesLimitAction",
  COMMUNICATION_TYPES: "CommunicationType",
  AGENT_TYPES: "AgentType",
  TRAINING_TYPES: "TrainingType",
  TRAINING_SUB_PAGES: "TrainingSubPages",
  TRAINING_INTERVALS: "TrainingInterval",
  INTENTION_TYPES: "IntentionType",
  INTENTION_FIELD_TYPES: "IntentionFieldType",
  INTENTION_HTTP_METHODS: "IntentionHttpMethod",
  CHANNEL_TYPES: "ChannelType",
  CUSTOM_FIELD_TYPES: "CustomFieldType",
  TRANSFER_RULE_TYPES: "TransferRuleType",
  MCP_URL_TYPES: "McpUrlType",
  MCP_AUTH_TYPES: "McpAuthType",
  WORKSPACE_STATUSES: "WorkspaceStatus",
  IDLE_ACTION_TYPES: "IdleActionType",
};

const header = `// AUTO-GERADO por scripts/gen-agent-platform-contract.mjs — não edite à mão.
// Fonte: contracts/agent-platform/openapi.json (info.version ${spec.info.version}).
// Regenere com: pnpm gen:agent-platform
`;

const body = Object.entries(enums)
  .map(([constName, values]) => {
    const typeName = typeNameOf[constName];
    return `export const ${constName} = [\n${values.map((v) => `  "${v}",`).join("\n")}\n] as const;\nexport type ${typeName} = (typeof ${constName})[number];\n`;
  })
  .join("\n");

mkdirSync(dirname(enumsOut), { recursive: true });
writeFileSync(enumsOut, `${header}\n${body}`);

mkdirSync(dirname(schemaOut), { recursive: true });
execFileSync(
  "node",
  [resolve(root, "node_modules/openapi-typescript/bin/cli.js"), specPath, "-o", schemaOut],
  { stdio: "inherit", cwd: root },
);

const generated = readFileSync(schemaOut, "utf8");
writeFileSync(
  schemaOut,
  `// AUTO-GERADO por scripts/gen-agent-platform-contract.mjs (openapi-typescript) — não edite à mão.\n// Fonte: contracts/agent-platform/openapi.json. Regenere com: pnpm gen:agent-platform\n${generated}`,
);

console.log(
  `ok: ${Object.keys(enums).length} enums em src/integrations/agent-platform/enums.gen.ts + tipos em src/integrations/agent-platform/schema.gen.ts`,
);
