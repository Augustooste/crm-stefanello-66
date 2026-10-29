// AUTO-GERADO por scripts/gen-agent-platform-contract.mjs — não edite à mão.
// Fonte: contracts/agent-platform/openapi.json (info.version 1.0.0).
// Regenere com: pnpm gen:agent-platform

export const PREFFER_MODELS = [
  "GPT_5",
  "GPT_5_MINI",
  "GPT_5_1",
  "GPT_5_2",
  "GPT_5_MINI_V2",
  "GPT_4_TURBO",
  "OPEN_AI_04",
  "OPEN_AI_03_MINI_BETA",
  "GPT_4_1",
  "GPT_4_1_MINI",
  "GPT_4_O_MINI",
  "GPT_4_O",
  "OPEN_AI_O3_MINI",
  "OPEN_AI_O4_MINI",
  "OPEN_AI_O3",
  "OPEN_AI_O1",
  "GPT_4",
  "CLAUDE_4_5_SONNET",
  "CLAUDE_3_5_SONNET",
  "CLAUDE_3_7_SONNET",
  "CLAUDE_3_5_HAIKU",
  "DEEPINFRA_LLAMA3_3",
  "QWEN_2_5_MAX",
  "DEEPSEEK_CHAT",
  "SABIA_3",
  "SABIA_3_1",
] as const;
export type PrefferModel = (typeof PREFFER_MODELS)[number];

export const MESSAGE_GROUPING_TIMES = [
  "NO_GROUP",
  "FIVE_SEC",
  "TEN_SEC",
  "THIRD_SEC",
  "ONE_MINUTE",
] as const;
export type MessageGroupingTime = (typeof MESSAGE_GROUPING_TIMES)[number];

export const MAX_DAILY_MESSAGES_LIMIT_ACTIONS = [
  "TEMP_BLOCK_30S",
  "TEMP_BLOCK_5M",
  "TEMP_BLOCK_10M",
  "TEMP_BLOCK_30M",
  "TEMP_BLOCK_1H",
  "BLOCK",
  "TRANSFER",
] as const;
export type MaxDailyMessagesLimitAction = (typeof MAX_DAILY_MESSAGES_LIMIT_ACTIONS)[number];

export const COMMUNICATION_TYPES = [
  "FORMAL",
  "NORMAL",
  "RELAXED",
] as const;
export type CommunicationType = (typeof COMMUNICATION_TYPES)[number];

export const AGENT_TYPES = [
  "SUPPORT",
  "SALE",
  "PERSONAL",
] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export const TRAINING_TYPES = [
  "TEXT",
  "WEBSITE",
  "VIDEO",
  "DOCUMENT",
] as const;
export type TrainingType = (typeof TRAINING_TYPES)[number];

export const TRAINING_SUB_PAGES = [
  "DISABLED",
  "ACTIVE",
] as const;
export type TrainingSubPages = (typeof TRAINING_SUB_PAGES)[number];

export const TRAINING_INTERVALS = [
  "THIRTY_SECONDS",
  "NEVER",
  "ONE_HOUR",
  "FOUR_HOUR",
  "EIGHT_HOUR",
  "TWELVE_HOUR",
  "ONE_DAY",
  "ONE_WEEK",
  "ONE_MONTH",
] as const;
export type TrainingInterval = (typeof TRAINING_INTERVALS)[number];

export const INTENTION_TYPES = [
  "WEBHOOK",
  "INSTRUCTIONS",
] as const;
export type IntentionType = (typeof INTENTION_TYPES)[number];

export const INTENTION_FIELD_TYPES = [
  "STRING",
  "URL",
  "DATE_TIME",
  "DATE",
  "NUMBER",
  "BOOLEAN",
] as const;
export type IntentionFieldType = (typeof INTENTION_FIELD_TYPES)[number];

export const INTENTION_HTTP_METHODS = [
  "GET",
  "POST",
] as const;
export type IntentionHttpMethod = (typeof INTENTION_HTTP_METHODS)[number];

export const CHANNEL_TYPES = [
  "Z_API",
  "WHATSAPP",
  "INSTAGRAM",
  "CLOUD_API",
  "TELEGRAM",
  "WIDGET",
  "MESSENGER",
  "MERCADO_LIVRE",
  "TWILIO_SMS",
] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const CUSTOM_FIELD_TYPES = [
  "STRING",
  "DATE",
  "DATE_TIME",
  "NUMBER",
  "BOOLEAN",
  "MONEY",
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const TRANSFER_RULE_TYPES = [
  "HUMAN",
  "AGENT",
] as const;
export type TransferRuleType = (typeof TRANSFER_RULE_TYPES)[number];

export const MCP_URL_TYPES = [
  "SSE",
  "STREAMABLEHTTP",
] as const;
export type McpUrlType = (typeof MCP_URL_TYPES)[number];

export const MCP_AUTH_TYPES = [
  "NO_OAUTH",
  "OAUTH",
  "HEADERS",
] as const;
export type McpAuthType = (typeof MCP_AUTH_TYPES)[number];

export const WORKSPACE_STATUSES = [
  "TRIAL",
  "ACTIVE",
  "PAST_DUE",
  "CANCELED",
] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

export const IDLE_ACTION_TYPES = [
  "SEND_MESSAGE",
  "FINISH_INTERACTION",
] as const;
export type IdleActionType = (typeof IDLE_ACTION_TYPES)[number];
