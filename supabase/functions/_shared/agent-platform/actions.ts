// Registro de ações do proxy provedor de agentes: nome interno → operação do contrato.
//
// Fonte de verdade única do mapeamento (o frontend só conhece o nome da ação e
// nunca monta URL do provedor). Cada entrada declara path do contrato VERBATIM,
// params aceitos, query em allowlist, escopo de posse e idempotência.
//
// `retryable` é por OPERAÇÃO, nunca por verbo: `mcp.tools.sync`,
// `mcp.tool.activate` e `mcp.tool.deactivate` são GETs que mudam estado no
// provedor (ver divergência D12 em contracts/agent-platform/CONTRACT_MATRIX.md).

export type ActionOwnership = "agent" | "channel" | "none";

export interface ActionSpec {
  method: "get" | "post" | "put" | "delete";
  /** Template do contrato, com os placeholders originais. */
  path: string;
  /** Placeholder → nome do param enviado pelo frontend (quando diferem). */
  aliases?: Readonly<Record<string, string>>;
  /** Query params permitidos. Nada fora desta lista chega ao provedor. */
  query?: readonly string[];
  /** Params (path, query ou de escopo) sem os quais a ação é rejeitada. */
  required?: readonly string[];
  /** Recurso cuja posse pelo tenant é verificada antes de chamar o provedor. */
  ownership: ActionOwnership;
  /** `true` quando o corpo JSON é repassado ao provedor. */
  hasBody?: boolean;
  /** Somente leituras puras. */
  retryable?: boolean;
  /**
   * `true` quando o id de posse NÃO chega ao provedor nesta rota. Dois formatos:
   * (a) `required` exige `agentId`/`channelId`, mas esse id não é placeholder do
   * path (nem via `aliases`) nem entra na allowlist `query` — o provedor recebe
   * só o id do sub-recurso (ex.: `PUT /v2/training/{trainingId}`);
   * (b) `ownership: "none"` em rota mutante sem `{workspaceId}` no path — nenhuma
   * fronteira, nem local nem remota.
   * Em ambos, `assertResourceOwnership` valida um id que o provedor nunca vê: a
   * única fronteira real é o token do próprio tenant. Por isso o proxy nega
   * estas ações quando cai no token global de fallback (`credentials.source ===
   * "env"`). A verdade é recalculada das próprias specs em
   * `tests/agent-platform-scope-gap.test.ts` — ação nova com o mesmo buraco
   * quebra o teste.
   */
  scopeGap?: true;
}

export const AGENT_PLATFORM_ACTIONS: Readonly<Record<string, ActionSpec>> = {
  // --- workspace -----------------------------------------------------------
  "workspaces.list": { method: "get", path: "/v2/workspaces", ownership: "none", retryable: true },
  "workspace.credits": {
    method: "get",
    path: "/v2/workspace/{workspaceId}/credits",
    ownership: "none",
    retryable: true,
  },

  // --- agentes -------------------------------------------------------------
  "agents.list": {
    method: "get",
    path: "/v2/workspace/{workspaceId}/agents",
    query: ["page", "pageSize", "query"],
    ownership: "none",
    retryable: true,
  },
  "agents.create": {
    method: "post",
    path: "/v2/workspace/{workspaceId}/agents",
    ownership: "none",
    hasBody: true,
  },
  "agent.get": {
    method: "get",
    path: "/v2/agent/{agentId}",
    required: ["agentId"],
    ownership: "agent",
    retryable: true,
  },
  "agent.update": {
    method: "put",
    path: "/v2/agent/{agentId}",
    required: ["agentId"],
    ownership: "agent",
    hasBody: true,
  },
  "agent.delete": {
    method: "delete",
    path: "/v2/agent/{agentId}",
    required: ["agentId"],
    ownership: "agent",
  },
  "agent.activate": {
    method: "put",
    path: "/v2/agent/{agentId}/active",
    required: ["agentId"],
    ownership: "agent",
  },
  "agent.deactivate": {
    method: "put",
    path: "/v2/agent/{agentId}/inactive",
    required: ["agentId"],
    ownership: "agent",
  },
  "agent.settings.get": {
    method: "get",
    path: "/v2/agent/{agentId}/settings",
    required: ["agentId"],
    ownership: "agent",
    retryable: true,
  },
  "agent.settings.update": {
    method: "put",
    path: "/v2/agent/{agentId}/settings",
    required: ["agentId"],
    ownership: "agent",
    hasBody: true,
  },
  "agent.webhooks.get": {
    method: "get",
    path: "/v2/agent/{agentId}/webhooks",
    required: ["agentId"],
    ownership: "agent",
    retryable: true,
  },
  "agent.webhooks.update": {
    method: "put",
    path: "/v2/agent/{agentId}/webhooks",
    required: ["agentId"],
    ownership: "agent",
    hasBody: true,
  },
  // `page` e `pageSize` são REQUIRED no contrato (divergência D5).
  "agent.behaviorHistory.list": {
    method: "get",
    path: "/v2/agent/{id}/list-behavior-history",
    aliases: { id: "agentId" },
    query: ["page", "pageSize"],
    required: ["agentId", "page", "pageSize"],
    ownership: "agent",
    retryable: true,
  },
  "agent.creditsSpent": {
    method: "get",
    path: "/v2/agent/{agentId}/credits-spent",
    query: ["year", "month", "day"],
    required: ["agentId"],
    ownership: "agent",
    retryable: true,
  },

  // --- treinamentos --------------------------------------------------------
  // `type` é obrigatório no contrato: não existe listagem de todos os tipos
  // numa chamada (divergência D2).
  "trainings.list": {
    method: "get",
    path: "/v2/agent/{agentId}/trainings",
    query: ["page", "pageSize", "type", "query"],
    required: ["agentId", "type"],
    ownership: "agent",
    retryable: true,
  },
  "trainings.create": {
    method: "post",
    path: "/v2/agent/{agentId}/trainings",
    required: ["agentId"],
    ownership: "agent",
    hasBody: true,
  },
  // O path não tem agentId (divergência D1); `agentId` continua obrigatório
  // como âncora de posse do tenant.
  "training.update": {
    method: "put",
    path: "/v2/training/{trainingId}",
    required: ["agentId", "trainingId"],
    ownership: "agent",
    hasBody: true,
    scopeGap: true,
  },
  "training.delete": {
    method: "delete",
    path: "/v2/training/{trainingId}",
    required: ["agentId", "trainingId"],
    ownership: "agent",
    scopeGap: true,
  },

  // --- intenções -----------------------------------------------------------
  "intentions.list": {
    method: "get",
    path: "/v2/agent/{agentId}/intentions",
    query: ["page", "pageSize", "query"],
    required: ["agentId"],
    ownership: "agent",
    retryable: true,
  },
  "intentions.create": {
    method: "post",
    path: "/v2/agent/{agentId}/intentions",
    required: ["agentId"],
    ownership: "agent",
    hasBody: true,
  },
  "intention.update": {
    method: "put",
    path: "/v2/intention/{intentionId}",
    required: ["agentId", "intentionId"],
    ownership: "agent",
    hasBody: true,
    scopeGap: true,
  },
  "intention.delete": {
    method: "delete",
    path: "/v2/intention/{intentionId}",
    required: ["agentId", "intentionId"],
    ownership: "agent",
    scopeGap: true,
  },

  // --- canais --------------------------------------------------------------
  "channels.list": {
    method: "get",
    path: "/v2/workspace/{workspaceId}/channels",
    query: ["page", "pageSize", "query", "agentId"],
    ownership: "none",
    retryable: true,
  },
  "channels.create": {
    method: "post",
    path: "/v2/workspace/{workspaceId}/create-channel",
    ownership: "none",
    hasBody: true,
  },
  "channels.createForAgent": {
    method: "post",
    path: "/v2/assistant/{assistantId}/create-channel/{type}",
    aliases: { assistantId: "agentId" },
    required: ["agentId", "type"],
    ownership: "agent",
    hasBody: true,
  },
  "channel.update": {
    method: "put",
    path: "/v2/channel/{channelId}",
    required: ["channelId"],
    ownership: "channel",
    hasBody: true,
  },
  "channel.delete": {
    method: "delete",
    path: "/v2/channel/{channelId}",
    required: ["channelId"],
    ownership: "channel",
  },
  "channel.config.get": {
    method: "get",
    path: "/v2/channel/{channelId}/config",
    required: ["channelId"],
    ownership: "channel",
    retryable: true,
  },
  "channel.config.update": {
    method: "put",
    path: "/v2/channel/{id}/config",
    aliases: { id: "channelId" },
    required: ["channelId"],
    ownership: "channel",
    hasBody: true,
  },
  "channel.qrCode": {
    method: "get",
    path: "/v2/channel/{channelId}/qr-code",
    required: ["channelId"],
    ownership: "channel",
    retryable: true,
  },
  "channel.widgetSettings.update": {
    method: "put",
    path: "/v2/channel/{channelId}/widget-settings",
    required: ["channelId"],
    ownership: "channel",
    hasBody: true,
  },
  "channel.widgetLinks": {
    method: "get",
    path: "/v2/channel/{channelId}/widget-links",
    required: ["channelId"],
    ownership: "channel",
    retryable: true,
  },

  // --- campos customizados -------------------------------------------------
  "customFields.list": {
    method: "get",
    path: "/v2/custom-field/workspace/{workspaceId}",
    query: ["page", "pageSize", "query"],
    ownership: "none",
    retryable: true,
  },
  "customFields.create": {
    method: "post",
    path: "/v2/custom-field/workspace/{workspaceId}",
    ownership: "none",
    hasBody: true,
  },
  "customField.update": {
    method: "put",
    path: "/v2/custom-field/{customfieldId}",
    required: ["customfieldId"],
    ownership: "none",
    hasBody: true,
    scopeGap: true,
  },
  "customField.toggleArchive": {
    method: "put",
    path: "/v2/custom-field/toggle-archive/{customfieldId}",
    query: ["archived"],
    required: ["customfieldId", "archived"],
    ownership: "none",
    scopeGap: true,
  },

  // --- regras de transferência ---------------------------------------------
  "transferRules.list": {
    method: "get",
    path: "/v2/agent/{id}/transfer-rules",
    aliases: { id: "agentId" },
    required: ["agentId"],
    ownership: "agent",
    retryable: true,
  },
  "transferRules.create": {
    method: "post",
    path: "/v2/agent/{agentId}/transfer-rules",
    required: ["agentId"],
    ownership: "agent",
    hasBody: true,
  },
  "transferRule.update": {
    method: "put",
    path: "/v2/agent/{agentId}/transfer-rules/{transfer-rule-id}",
    aliases: { "transfer-rule-id": "transferRuleId" },
    required: ["agentId", "transferRuleId"],
    ownership: "agent",
    hasBody: true,
  },
  "transferRule.delete": {
    method: "delete",
    path: "/v2/agent/{agentId}/transfer-rules/{transfer-rule-id}",
    aliases: { "transfer-rule-id": "transferRuleId" },
    required: ["agentId", "transferRuleId"],
    ownership: "agent",
  },

  // --- ações de inatividade ------------------------------------------------
  "idleActions.get": {
    method: "get",
    path: "/v2/agent/{agentId}/idle-actions",
    required: ["agentId"],
    ownership: "agent",
    retryable: true,
  },
  "idleActions.create": {
    method: "post",
    path: "/v2/agent/{agentId}/idle-actions",
    required: ["agentId"],
    ownership: "agent",
    hasBody: true,
  },
  "idleActions.update": {
    method: "put",
    path: "/v2/agent/{agentId}/idle-actions",
    required: ["agentId"],
    ownership: "agent",
    hasBody: true,
  },
  // Exclusão é do CONJUNTO: o contrato não recebe id de ação (divergência D10).
  "idleActions.delete": {
    method: "delete",
    path: "/v2/agent/{agentId}/idle-actions",
    required: ["agentId"],
    ownership: "agent",
  },

  // --- MCP -----------------------------------------------------------------
  "mcp.add": {
    method: "post",
    path: "/v2/agent/{agentId}/mcp/add",
    required: ["agentId"],
    ownership: "agent",
    hasBody: true,
  },
  "mcp.connect": {
    method: "post",
    path: "/v2/mcp/connect",
    ownership: "none",
    hasBody: true,
    scopeGap: true,
  },
  "mcp.delete": {
    method: "delete",
    path: "/v2/mcp/{mcpId}",
    required: ["agentId", "mcpId"],
    ownership: "agent",
    scopeGap: true,
  },
  "mcp.tools.list": {
    method: "get",
    path: "/v2/mcp/{mcpId}/tools",
    required: ["agentId", "mcpId"],
    ownership: "agent",
    retryable: true,
    scopeGap: true,
  },
  // GET que muda estado no provedor → nunca retentado.
  "mcp.tools.sync": {
    method: "get",
    path: "/v2/mcp/{mcpId}/sync-tools",
    required: ["agentId", "mcpId"],
    ownership: "agent",
    scopeGap: true,
  },
  "mcp.tool.activate": {
    method: "get",
    path: "/v2/mcp/{mcpId}/tool/{toolId}/active",
    required: ["agentId", "mcpId", "toolId"],
    ownership: "agent",
    scopeGap: true,
  },
  "mcp.tool.deactivate": {
    method: "get",
    path: "/v2/mcp/{mcpId}/tool/{toolId}/inactive",
    required: ["agentId", "mcpId", "toolId"],
    ownership: "agent",
    scopeGap: true,
  },

  // --- playground ----------------------------------------------------------
  "playground.conversation": {
    method: "post",
    path: "/v2/agent/{agentId}/conversation",
    required: ["agentId"],
    ownership: "agent",
    hasBody: true,
  },
  "playground.addMessage": {
    method: "post",
    path: "/v2/agent/{agentId}/add-message",
    required: ["agentId"],
    ownership: "agent",
    hasBody: true,
  },
};

export type AgentPlatformActionName = keyof typeof AGENT_PLATFORM_ACTIONS;

export function isKnownAction(name: string): boolean {
  return Object.hasOwn(AGENT_PLATFORM_ACTIONS, name);
}

export type ActionParams = Record<string, string | number | boolean | null | undefined>;

export interface ResolvedRequest {
  path: string;
  query: Record<string, string | number | boolean | null | undefined>;
}

export class ActionResolveError extends Error {}

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * Monta path e query da chamada remota a partir dos params do frontend.
 *
 * `workspaceId` **nunca** vem do cliente: chega por argumento, resolvido no
 * servidor a partir da conexão do tenant. Placeholders são preenchidos só com
 * params declarados no spec e validados contra `SAFE_ID` — nada de path
 * traversal ou query smuggling via id.
 */
export function resolveAction(
  spec: ActionSpec,
  params: ActionParams,
  workspaceId: string | null,
): ResolvedRequest {
  for (const key of spec.required ?? []) {
    const value = params[key];
    if (value === undefined || value === null || value === "") {
      throw new ActionResolveError(`Parâmetro obrigatório ausente: ${key}`);
    }
  }

  const path = spec.path.replace(/\{([^}]+)\}/g, (_match, placeholder: string) => {
    if (placeholder === "workspaceId") {
      if (!workspaceId) {
        throw new ActionResolveError("Workspace do provedor de agentes não configurado.");
      }
      return encodeURIComponent(workspaceId);
    }
    const paramName = spec.aliases?.[placeholder] ?? placeholder;
    const raw = params[paramName];
    if (raw === undefined || raw === null || raw === "") {
      throw new ActionResolveError(`Parâmetro obrigatório ausente: ${paramName}`);
    }
    const value = String(raw);
    if (!SAFE_ID.test(value)) {
      throw new ActionResolveError(`Parâmetro inválido: ${paramName}`);
    }
    return encodeURIComponent(value);
  });

  const query: ResolvedRequest["query"] = {};
  for (const key of spec.query ?? []) {
    if (params[key] !== undefined) query[key] = params[key];
  }

  return { path, query };
}
