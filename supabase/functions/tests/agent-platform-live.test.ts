// Smoke test SOMENTE-LEITURA contra a API real do provedor de agentes.
//
// Ignorado por padrão: só roda com AGENT_PLATFORM_LIVE_TESTS="true" (a suíte inteira
// do repo é offline/mock — ver os demais arquivos deste diretório). Nada aqui
// escreve, cria ou apaga recurso no provedor: o escopo proíbe teste destrutivo
// em produção, então o único endpoint usado é `GET /v2/workspaces`.
//
// Para rodar:
//   AGENT_PLATFORM_LIVE_TESTS=true AGENT_PLATFORM_API_TOKEN=... AGENT_PLATFORM_WORKSPACE_ID=... \
//     deno test --allow-env --allow-net --allow-import \
//     supabase/functions/tests/agent-platform-live.test.ts
import { createAgentPlatformClient, normalizeBaseUrl } from "../_shared/agent-platform/client.ts";

// O código não tem mais base URL padrão (config ausente = erro explícito),
// então o ambiente de teste precisa declarar a dele.
Deno.env.set("AGENT_PLATFORM_API_BASE_URL", "https://provider.test");

const live = Deno.env.get("AGENT_PLATFORM_LIVE_TESTS") === "true";

interface Workspace {
  id?: string;
  name?: string;
}

Deno.test({
  name: "agent-platform (live): token válido lista workspaces e contém o configurado",
  ignore: !live,
  fn: async () => {
    const token = Deno.env.get("AGENT_PLATFORM_API_TOKEN")?.trim();
    const workspaceId = Deno.env.get("AGENT_PLATFORM_WORKSPACE_ID")?.trim();
    if (!token) {
      throw new Error("AGENT_PLATFORM_API_TOKEN é obrigatório com AGENT_PLATFORM_LIVE_TESTS=true");
    }

    const client = createAgentPlatformClient({
      baseUrl: Deno.env.get("AGENT_PLATFORM_API_BASE_URL"),
      token,
    });
    const workspaces = await client.request<Workspace[]>({
      method: "get",
      path: "/v2/workspaces",
      retryable: true,
    });

    if (!Array.isArray(workspaces) || workspaces.length === 0) {
      throw new Error("nenhum workspace retornado pela conta");
    }
    if (workspaceId && !workspaces.some((w) => w.id === workspaceId)) {
      throw new Error(
        `AGENT_PLATFORM_WORKSPACE_ID=${workspaceId} não está na conta (ids: ${
          workspaces.map((w) => w.id).join(", ")
        })`,
      );
    }
  },
});

Deno.test("agent-platform (live desabilitado): base URL nunca duplica /v2", () => {
  // Roda sempre — é a checagem que impede o modo live de bater em /v2/v2/...
  const normalized = normalizeBaseUrl(Deno.env.get("AGENT_PLATFORM_API_BASE_URL") ?? null);
  if (normalized.endsWith("/v2")) throw new Error(`base URL normalizada errada: ${normalized}`);
});
