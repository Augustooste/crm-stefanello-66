// Superfície tipada do contrato provedor de agentes para o frontend.
//
// Uma única tabela (`AGENT_PLATFORM_ACTION_ROUTES`) amarra o nome interno da ação à
// operação do contrato; os tipos de request/response são DERIVADOS dela sobre
// `schema.gen.ts` (gerado por `pnpm gen:agent-platform`). Nenhum DTO escrito à mão —
// campo que não existe no contrato não compila.
//
// A tabela espelha `supabase/functions/_shared/agent-platform/actions.ts`; a paridade
// entre as duas é testada em agent-platform-contract.test.ts (drift quebra o teste).
import type { paths } from "@/integrations/agent-platform/schema.gen";

type JsonOf<T> = T extends { content: { "application/json": infer J } } ? J : never;

type ResponseOf<T> = T extends { responses: infer R }
  ? R extends { 200: infer Ok }
    ? JsonOf<Ok>
    : R extends { 204: infer NoContent }
      ? JsonOf<NoContent>
      : unknown
  : unknown;

type RequestOf<T> = T extends { requestBody?: infer B } ? JsonOf<NonNullable<B>> : never;

export const AGENT_PLATFORM_ACTION_ROUTES = {
  "workspaces.list": { method: "get", path: "/v2/workspaces" },
  "workspace.credits": { method: "get", path: "/v2/workspace/{workspaceId}/credits" },

  "agents.list": { method: "get", path: "/v2/workspace/{workspaceId}/agents" },
  "agents.create": { method: "post", path: "/v2/workspace/{workspaceId}/agents" },
  "agent.get": { method: "get", path: "/v2/agent/{agentId}" },
  "agent.update": { method: "put", path: "/v2/agent/{agentId}" },
  "agent.delete": { method: "delete", path: "/v2/agent/{agentId}" },
  "agent.activate": { method: "put", path: "/v2/agent/{agentId}/active" },
  "agent.deactivate": { method: "put", path: "/v2/agent/{agentId}/inactive" },
  "agent.settings.get": { method: "get", path: "/v2/agent/{agentId}/settings" },
  "agent.settings.update": { method: "put", path: "/v2/agent/{agentId}/settings" },
  "agent.webhooks.get": { method: "get", path: "/v2/agent/{agentId}/webhooks" },
  "agent.webhooks.update": { method: "put", path: "/v2/agent/{agentId}/webhooks" },
  "agent.behaviorHistory.list": { method: "get", path: "/v2/agent/{id}/list-behavior-history" },
  "agent.creditsSpent": { method: "get", path: "/v2/agent/{agentId}/credits-spent" },

  "trainings.list": { method: "get", path: "/v2/agent/{agentId}/trainings" },
  "trainings.create": { method: "post", path: "/v2/agent/{agentId}/trainings" },
  "training.update": { method: "put", path: "/v2/training/{trainingId}" },
  "training.delete": { method: "delete", path: "/v2/training/{trainingId}" },

  "intentions.list": { method: "get", path: "/v2/agent/{agentId}/intentions" },
  "intentions.create": { method: "post", path: "/v2/agent/{agentId}/intentions" },
  "intention.update": { method: "put", path: "/v2/intention/{intentionId}" },
  "intention.delete": { method: "delete", path: "/v2/intention/{intentionId}" },

  "channels.list": { method: "get", path: "/v2/workspace/{workspaceId}/channels" },
  "channels.create": { method: "post", path: "/v2/workspace/{workspaceId}/create-channel" },
  "channels.createForAgent": {
    method: "post",
    path: "/v2/assistant/{assistantId}/create-channel/{type}",
  },
  "channel.update": { method: "put", path: "/v2/channel/{channelId}" },
  "channel.delete": { method: "delete", path: "/v2/channel/{channelId}" },
  "channel.config.get": { method: "get", path: "/v2/channel/{channelId}/config" },
  "channel.config.update": { method: "put", path: "/v2/channel/{id}/config" },
  "channel.qrCode": { method: "get", path: "/v2/channel/{channelId}/qr-code" },
  "channel.widgetSettings.update": {
    method: "put",
    path: "/v2/channel/{channelId}/widget-settings",
  },
  "channel.widgetLinks": { method: "get", path: "/v2/channel/{channelId}/widget-links" },

  "customFields.list": { method: "get", path: "/v2/custom-field/workspace/{workspaceId}" },
  "customFields.create": { method: "post", path: "/v2/custom-field/workspace/{workspaceId}" },
  "customField.update": { method: "put", path: "/v2/custom-field/{customfieldId}" },
  "customField.toggleArchive": {
    method: "put",
    path: "/v2/custom-field/toggle-archive/{customfieldId}",
  },

  "transferRules.list": { method: "get", path: "/v2/agent/{id}/transfer-rules" },
  "transferRules.create": { method: "post", path: "/v2/agent/{agentId}/transfer-rules" },
  "transferRule.update": {
    method: "put",
    path: "/v2/agent/{agentId}/transfer-rules/{transfer-rule-id}",
  },
  "transferRule.delete": {
    method: "delete",
    path: "/v2/agent/{agentId}/transfer-rules/{transfer-rule-id}",
  },

  "idleActions.get": { method: "get", path: "/v2/agent/{agentId}/idle-actions" },
  "idleActions.create": { method: "post", path: "/v2/agent/{agentId}/idle-actions" },
  "idleActions.update": { method: "put", path: "/v2/agent/{agentId}/idle-actions" },
  "idleActions.delete": { method: "delete", path: "/v2/agent/{agentId}/idle-actions" },

  "mcp.add": { method: "post", path: "/v2/agent/{agentId}/mcp/add" },
  "mcp.connect": { method: "post", path: "/v2/mcp/connect" },
  "mcp.delete": { method: "delete", path: "/v2/mcp/{mcpId}" },
  "mcp.tools.list": { method: "get", path: "/v2/mcp/{mcpId}/tools" },
  "mcp.tools.sync": { method: "get", path: "/v2/mcp/{mcpId}/sync-tools" },
  "mcp.tool.activate": { method: "get", path: "/v2/mcp/{mcpId}/tool/{toolId}/active" },
  "mcp.tool.deactivate": { method: "get", path: "/v2/mcp/{mcpId}/tool/{toolId}/inactive" },

  "playground.conversation": { method: "post", path: "/v2/agent/{agentId}/conversation" },
  "playground.addMessage": { method: "post", path: "/v2/agent/{agentId}/add-message" },
} as const satisfies Record<string, { method: string; path: keyof paths }>;

export type AgentPlatformAction = keyof typeof AGENT_PLATFORM_ACTION_ROUTES;

type OperationOf<A extends AgentPlatformAction> = (typeof AGENT_PLATFORM_ACTION_ROUTES)[A] extends {
  path: infer P extends keyof paths;
  method: infer M;
}
  ? M extends keyof paths[P]
    ? paths[P][M]
    : never
  : never;

/** Payload de sucesso (200, ou 204 quando é o único declarado no contrato). */
export type AgentPlatformResponse<A extends AgentPlatformAction> = ResponseOf<OperationOf<A>>;

/** Corpo JSON aceito pela operação. `never` quando o contrato não declara corpo. */
export type AgentPlatformRequestBody<A extends AgentPlatformAction> = RequestOf<OperationOf<A>>;

/** `true` só quando o contrato declara `requestBody` SEM `?` (22 operações).
 *
 * `RequestOf` casa com `requestBody?:` e por isso apaga a distinção; aqui a
 * propriedade opcional não satisfaz `{ requestBody: unknown }`, então GET
 * (`requestBody?: never`) e escrita de corpo opcional (`mcp.connect`) dão `false`. */
export type AgentPlatformBodyRequired<A extends AgentPlatformAction> =
  OperationOf<A> extends { requestBody: unknown } ? true : false;

// --- atalhos usados pelas telas ------------------------------------------------
export type AgentPlatformWorkspace = AgentPlatformResponse<"workspaces.list">[number];
export type AgentPlatformAgent = AgentPlatformResponse<"agent.get">;
export type AgentPlatformAgentSettings = AgentPlatformResponse<"agent.settings.get">;
export type AgentPlatformAgentSettingsUpdate = AgentPlatformRequestBody<"agent.settings.update">;
export type AgentPlatformAgentCreate = AgentPlatformRequestBody<"agents.create">;
export type AgentPlatformWebhooks = AgentPlatformResponse<"agent.webhooks.get">;
export type AgentPlatformTrainingList = AgentPlatformResponse<"trainings.list">;
export type AgentPlatformTrainingCreate = AgentPlatformRequestBody<"trainings.create">;
export type AgentPlatformIntention = AgentPlatformResponse<"intentions.list">[number];
export type AgentPlatformIntentionCreate = AgentPlatformRequestBody<"intentions.create">;
export type AgentPlatformChannelList = AgentPlatformResponse<"channels.list">;
export type AgentPlatformChannel = NonNullable<AgentPlatformChannelList["data"]>[number];
export type AgentPlatformChannelConfig = AgentPlatformResponse<"channel.config.get">;
export type AgentPlatformQrCode = AgentPlatformResponse<"channel.qrCode">;
export type AgentPlatformWidgetSettings = AgentPlatformRequestBody<"channel.widgetSettings.update">;
export type AgentPlatformConversation = AgentPlatformResponse<"playground.conversation">;
export type AgentPlatformConversationInput = AgentPlatformRequestBody<"playground.conversation">;
export type AgentPlatformCustomField = AgentPlatformResponse<"customFields.list">;
export type AgentPlatformTransferRule = AgentPlatformResponse<"transferRules.list">;
export type AgentPlatformIdleActions = AgentPlatformResponse<"idleActions.get">;
export type AgentPlatformMcpTool = AgentPlatformResponse<"mcp.tools.list">[number];
export type AgentPlatformBehaviorHistory = AgentPlatformResponse<"agent.behaviorHistory.list">;
