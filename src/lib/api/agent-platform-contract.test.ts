import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { AGENT_PLATFORM_ACTION_ROUTES } from "./agent-platform-contract";
// Registro do proxy (Deno). É TS puro, sem API de Deno — importável aqui de
// propósito: é o que garante que frontend e servidor falem do MESMO contrato.
import { AGENT_PLATFORM_ACTIONS } from "../../../supabase/functions/_shared/agent-platform/actions";

interface OpenApiSpec {
  paths: Record<string, Record<string, unknown>>;
}

const spec = JSON.parse(
  readFileSync(resolve(process.cwd(), "contracts/agent-platform/openapi.json"), "utf8"),
) as OpenApiSpec;

describe("contrato provedor de agentes", () => {
  it("frontend e proxy expõem exatamente as mesmas ações", () => {
    expect(Object.keys(AGENT_PLATFORM_ACTION_ROUTES).sort()).toEqual(
      Object.keys(AGENT_PLATFORM_ACTIONS).sort(),
    );
  });

  it("cada ação aponta para o mesmo método e path nos dois lados", () => {
    for (const [action, route] of Object.entries(AGENT_PLATFORM_ACTION_ROUTES)) {
      const edge = AGENT_PLATFORM_ACTIONS[action];
      expect(edge, `ação ${action} ausente no proxy`).toBeDefined();
      expect({ action, ...route }).toEqual({ action, method: edge.method, path: edge.path });
    }
  });

  it("todo path/método declarado existe no openapi.json versionado", () => {
    for (const [action, route] of Object.entries(AGENT_PLATFORM_ACTION_ROUTES)) {
      const operation = spec.paths[route.path]?.[route.method];
      expect(operation, `${action} → ${route.method.toUpperCase()} ${route.path}`).toBeDefined();
    }
  });

  it("nenhum path do contrato é reescrito com /v2 duplicado ou faltando", () => {
    for (const route of Object.values(AGENT_PLATFORM_ACTION_ROUTES)) {
      expect(route.path.startsWith("/v2/")).toBe(true);
      expect(route.path.startsWith("/v2/v2/")).toBe(false);
    }
  });

  it("as 7 áreas do escopo têm ação de leitura e de escrita", () => {
    const actions = Object.keys(AGENT_PLATFORM_ACTION_ROUTES);
    const areas = [
      ["agentes", ["agents.list", "agents.create", "agent.update", "agent.delete"]],
      ["modelo de LLM", ["agent.settings.get", "agent.settings.update"]],
      ["perfil", ["agent.get", "agent.update", "agent.behaviorHistory.list"]],
      ["treinamento", ["trainings.list", "trainings.create", "training.delete"]],
      ["intenções", ["intentions.list", "intentions.create", "intention.delete"]],
      ["integrações (MCP)", ["mcp.add", "mcp.tools.list", "mcp.delete"]],
      ["canais", ["channels.list", "channels.create", "channel.update", "channel.delete"]],
    ] as const;
    for (const [area, required] of areas) {
      for (const action of required) {
        expect(actions, `${area}: falta ${action}`).toContain(action);
      }
    }
  });
});
