import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

import {
  callAgentPlatform,
  AgentPlatformCallError,
  type AgentPlatformCallInput,
  type AgentPlatformParams,
  useAgentPlatformConnection,
  useAgentPlatformMutation,
  useAgentPlatformQuery,
} from "./agent-platform";
import type {
  AgentPlatformAction,
  AgentPlatformBodyRequired,
} from "@/lib/api/agent-platform-contract";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile, type CurrentProfile } from "@/lib/api/session";
import { createChain, createQueryWrapper } from "@/test/query-mocks";
import { toast } from "sonner";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), functions: { invoke: vi.fn() } },
}));
vi.mock("@/lib/api/session", () => ({ useCurrentProfile: vi.fn() }));
vi.mock("sonner", () => ({ toast: { warning: vi.fn() } }));

function mockProfile(tenantId: string | null) {
  const profile: CurrentProfile | null = tenantId
    ? { id: "u1", tenant_id: tenantId, name: "Ana", role: "admin" }
    : null;
  vi.mocked(useCurrentProfile).mockReturnValue({
    data: profile,
  } as unknown as ReturnType<typeof useCurrentProfile>);
}

function mockInvoke(response: unknown, error: unknown = null) {
  vi.mocked(supabase.functions.invoke).mockResolvedValue({
    data: response,
    error,
  } as Awaited<ReturnType<typeof supabase.functions.invoke>>);
}

/** Não-2xx: o supabase-js devolve o `Response` cru junto do erro (é o mesmo
 * objeto de `FunctionsHttpError.context`) e o corpo do envelope se perde. */
function mockInvokeHttpError(status: number) {
  vi.mocked(supabase.functions.invoke).mockResolvedValue({
    data: null,
    error: new Error("Edge Function returned a non-2xx status code"),
    response: new Response(null, { status }),
  } as Awaited<ReturnType<typeof supabase.functions.invoke>>);
}

describe("callAgentPlatform", () => {
  afterEach(() => vi.clearAllMocks());

  it("mostra o aviso de sincronização parcial que vem ao lado de data", async () => {
    // O envelope traz `syncWarning` como chave IRMÃ de `data`. Devolver só
    // `data.data` descartava o aviso: a gravação de vínculo falhava no proxy, a
    // lista renderizava normal e ninguém via nada. Este teste é o consumidor —
    // sem ele, a asserção do lado Deno valida o produtor contra ele mesmo.
    mockInvoke({
      data: [{ id: "agent-1" }],
      syncWarning: "Dados carregados, mas os vínculos locais não foram atualizados.",
    });
    const agents = await callAgentPlatform("agents.list", {});
    expect(toast.warning).toHaveBeenCalledWith(
      "Dados carregados, mas os vínculos locais não foram atualizados.",
    );
    expect(agents).toEqual([{ id: "agent-1" }]);
  });

  it("não avisa nada quando a sincronização foi completa", async () => {
    mockInvoke({ data: [{ id: "agent-1" }] });
    await callAgentPlatform("agents.list", {});
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("envia action, params e body para o proxy e devolve o payload remoto", async () => {
    mockInvoke({ data: [{ id: "agent-1", name: "Ana" }] });
    const agents = await callAgentPlatform("agents.list", { params: { page: 1 } });
    expect(supabase.functions.invoke).toHaveBeenCalledWith("agent-platform-proxy", {
      body: { action: "agents.list", params: { page: 1 }, body: undefined },
    });
    expect(agents?.[0]?.id).toBe("agent-1");
  });

  it("converte envelope de erro em AgentPlatformCallError preservando código e mensagem", async () => {
    mockInvoke({
      error: {
        code: "INSUFFICIENT_CREDITS",
        message: "Os créditos do workspace no provedor de agentes acabaram.",
        correlationId: "abc",
      },
    });
    await expect(callAgentPlatform("agents.list", {})).rejects.toMatchObject({
      code: "INSUFFICIENT_CREDITS",
      message: "Os créditos do workspace no provedor de agentes acabaram.",
      correlationId: "abc",
    });
  });

  it("código desconhecido cai em UNKNOWN sem quebrar a tela", async () => {
    mockInvoke({ error: { code: "SOMETHING_NEW", message: "algo novo" } });
    await expect(callAgentPlatform("agents.list", {})).rejects.toMatchObject({ code: "UNKNOWN" });
  });

  it("falha de transporte (sem Response) continua NETWORK_ERROR", async () => {
    mockInvoke(null, { message: "Failed to fetch" });
    await expect(callAgentPlatform("agents.list", {})).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
  });

  it("401 do gateway vira AUTHENTICATION_FAILED com mensagem PT-BR", async () => {
    mockInvokeHttpError(401);
    await expect(callAgentPlatform("agents.list", {})).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
      message: "Sua sessão expirou ou a chave do provedor de agentes é inválida.",
    });
  });

  it("5xx da function vira REMOTE_SERVER_ERROR", async () => {
    mockInvokeHttpError(503);
    await expect(callAgentPlatform("agents.list", {})).rejects.toMatchObject({
      code: "REMOTE_SERVER_ERROR",
    });
  });

  it("429 vira RATE_LIMITED e 404 vira NOT_FOUND", async () => {
    mockInvokeHttpError(429);
    await expect(callAgentPlatform("agents.list", {})).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    mockInvokeHttpError(404);
    await expect(callAgentPlatform("agents.list", {})).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

// Controle de tipo: quem valida estas linhas é `tsc --noEmit` — se o contrato
// voltar a colapsar corpo obrigatório em opcional, elas param de compilar.
// O `expect` no fim só existe para que as constantes contem como usadas.
type Rejeita<A extends AgentPlatformAction, T> = T extends AgentPlatformCallInput<A> ? false : true;

describe("AgentPlatformCallInput", () => {
  it("exige corpo exatamente onde o contrato exige", () => {
    const criarAgente: AgentPlatformBodyRequired<"agents.create"> = true;
    const atualizarCanal: AgentPlatformBodyRequired<"channel.update"> = true;
    const listarAgentes: AgentPlatformBodyRequired<"agents.list"> = false;
    const ativarAgente: AgentPlatformBodyRequired<"agent.activate"> = false;
    // corpo declarado com `?` no contrato continua opcional
    const conectarMcp: AgentPlatformBodyRequired<"mcp.connect"> = false;
    // só `{ params }`, sem `body`, não serve para uma ação de corpo obrigatório
    const semCorpoNaoServe: Rejeita<"agents.create", { params: AgentPlatformParams }> = true;
    expect([
      criarAgente,
      atualizarCanal,
      listarAgentes,
      ativarAgente,
      conectarMcp,
      semCorpoNaoServe,
    ]).toEqual([true, true, false, false, false, true]);
  });
});

describe("useAgentPlatformQuery", () => {
  afterEach(() => vi.clearAllMocks());

  it("carrega dados da ação", async () => {
    mockInvoke({ data: { id: "agent-1", name: "Ana" } });
    const { result } = renderHook(
      () => useAgentPlatformQuery("agent.get", { params: { agentId: "agent-1" } }),
      { wrapper: createQueryWrapper() },
    );
    await waitFor(() => expect(result.current.data?.name).toBe("Ana"));
  });

  it("não repete chamada em erro terminal (FORBIDDEN)", async () => {
    mockInvoke({ error: { code: "FORBIDDEN", message: "sem permissão" } });
    const { result } = renderHook(
      () => useAgentPlatformQuery("agent.get", { params: { agentId: "x" } }),
      { wrapper: createQueryWrapper() },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(AgentPlatformCallError);
    expect(supabase.functions.invoke).toHaveBeenCalledTimes(1);
  });

  it("401 do gateway é terminal: não retenta em sessão morta", async () => {
    mockInvokeHttpError(401);
    const { result } = renderHook(
      () => useAgentPlatformQuery("agent.get", { params: { agentId: "x" } }),
      { wrapper: createQueryWrapper() },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.code).toBe("AUTHENTICATION_FAILED");
    expect(supabase.functions.invoke).toHaveBeenCalledTimes(1);
  });

  it("respeita enabled=false", () => {
    mockInvoke({ data: null });
    renderHook(() => useAgentPlatformQuery("agents.list", {}, { enabled: false }), {
      wrapper: createQueryWrapper(),
    });
    expect(supabase.functions.invoke).not.toHaveBeenCalled();
  });
});

describe("useAgentPlatformMutation", () => {
  afterEach(() => vi.clearAllMocks());

  it("executa a escrita e devolve a resposta do provedor", async () => {
    mockInvoke({ data: { success: true } });
    const { result } = renderHook(() => useAgentPlatformMutation("agent.activate"), {
      wrapper: createQueryWrapper(),
    });
    result.current.mutate({ params: { agentId: "agent-1" } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(supabase.functions.invoke).toHaveBeenCalledWith("agent-platform-proxy", {
      body: { action: "agent.activate", params: { agentId: "agent-1" }, body: undefined },
    });
  });

  it("propaga erro do provedor como AgentPlatformCallError", async () => {
    mockInvoke({ error: { code: "VALIDATION_ERROR", message: "nome obrigatório" } });
    const { result } = renderHook(() => useAgentPlatformMutation("agents.create"), {
      wrapper: createQueryWrapper(),
    });
    result.current.mutate({ body: { name: "" } });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.code).toBe("VALIDATION_ERROR");
  });
});

describe("useAgentPlatformConnection", () => {
  afterEach(() => vi.clearAllMocks());

  it("fica desabilitado sem tenant", () => {
    mockProfile(null);
    renderHook(() => useAgentPlatformConnection(), { wrapper: createQueryWrapper() });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("devolve status e detecta workspace configurado", async () => {
    mockProfile("t1");
    vi.mocked(supabase.from).mockReturnValue(
      createChain({
        data: {
          status: "active",
          last_error: null,
          last_check_at: "2026-07-31T00:00:00Z",
          connected_at: "2026-07-31T00:00:00Z",
          config: { workspace_id: "ws-1" },
        },
        error: null,
      }) as unknown as ReturnType<typeof supabase.from>,
    );
    const { result } = renderHook(() => useAgentPlatformConnection(), {
      wrapper: createQueryWrapper(),
    });
    await waitFor(() => expect(result.current.data?.status).toBe("active"));
    expect(result.current.data?.workspaceIdConfigured).toBe(true);
  });

  it("sem linha de integração devolve null (tela pede conexão)", async () => {
    mockProfile("t1");
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: null, error: null }) as unknown as ReturnType<typeof supabase.from>,
    );
    const { result } = renderHook(() => useAgentPlatformConnection(), {
      wrapper: createQueryWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });
});
