import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import {
  dealChat,
  playgroundChat,
  useAiSettings,
  useSetTenantAiEnabled,
  useStagesWithConfig,
  useTenantAiEnabled,
  useUpdateAiSettings,
  useUpsertStageConfig,
} from "./ai-config";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile, type CurrentProfile } from "@/lib/api/session";
import { createChain, createQueryWrapper, type ChainMock } from "@/test/query-mocks";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), functions: { invoke: vi.fn() } },
}));
vi.mock("@/lib/api/session", () => ({ useCurrentProfile: vi.fn() }));

function mockProfile(tenantId: string | null) {
  const profile: CurrentProfile | null = tenantId
    ? { id: "u1", tenant_id: tenantId, name: "Ana", role: "admin" }
    : null;
  vi.mocked(useCurrentProfile).mockReturnValue({
    data: profile,
  } as unknown as ReturnType<typeof useCurrentProfile>);
}

describe("useTenantAiEnabled", () => {
  afterEach(() => vi.clearAllMocks());

  it("fica desabilitado sem tenant", () => {
    mockProfile(null);
    const { result } = renderHook(() => useTenantAiEnabled(), { wrapper: createQueryWrapper() });
    expect(result.current.data).toBeUndefined();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("retorna true quando ai_enabled é true", async () => {
    mockProfile("t1");
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: { ai_enabled: true }, error: null }) as unknown as ReturnType<
        typeof supabase.from
      >,
    );
    const { result } = renderHook(() => useTenantAiEnabled(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.data).toBe(true));
  });

  it("retorna false quando não há linha (data null)", async () => {
    mockProfile("t1");
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: null, error: null }) as unknown as ReturnType<typeof supabase.from>,
    );
    const { result } = renderHook(() => useTenantAiEnabled(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBe(false);
  });

  it("propaga erro", async () => {
    mockProfile("t1");
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: null, error: new Error("boom") }) as unknown as ReturnType<
        typeof supabase.from
      >,
    );
    const { result } = renderHook(() => useTenantAiEnabled(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("useSetTenantAiEnabled", () => {
  afterEach(() => vi.clearAllMocks());

  it("rejeita sem tenant", async () => {
    mockProfile(null);
    const { result } = renderHook(() => useSetTenantAiEnabled(), {
      wrapper: createQueryWrapper(),
    });
    await expect(result.current.mutateAsync(true)).rejects.toThrow("Sem tenant.");
  });

  it("atualiza o flag ai_enabled do tenant", async () => {
    mockProfile("t1");
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: null, error: null }) as unknown as ReturnType<typeof supabase.from>,
    );
    const { result } = renderHook(() => useSetTenantAiEnabled(), {
      wrapper: createQueryWrapper(),
    });
    await expect(result.current.mutateAsync(true)).resolves.toBe(true);
    expect(supabase.from).toHaveBeenCalledWith("tenants");
  });

  it("propaga erro do update", async () => {
    mockProfile("t1");
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: null, error: new Error("falhou") }) as unknown as ReturnType<
        typeof supabase.from
      >,
    );
    const { result } = renderHook(() => useSetTenantAiEnabled(), {
      wrapper: createQueryWrapper(),
    });
    await expect(result.current.mutateAsync(false)).rejects.toThrow("falhou");
  });
});

describe("useAiSettings", () => {
  afterEach(() => vi.clearAllMocks());

  it("fica desabilitado sem tenant", () => {
    mockProfile(null);
    const { result } = renderHook(() => useAiSettings(), { wrapper: createQueryWrapper() });
    expect(result.current.data).toBeUndefined();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("retorna configuração existente com valores customizados", async () => {
    mockProfile("t1");
    vi.mocked(supabase.from).mockReturnValue(
      createChain({
        data: {
          tenant_id: "t1",
          base_system_prompt: "prompt customizado",
          handoff_default_keywords: ["ajuda"],
        },
        error: null,
      }) as unknown as ReturnType<typeof supabase.from>,
    );
    const { result } = renderHook(() => useAiSettings(), { wrapper: createQueryWrapper() });
    await waitFor(() =>
      expect(result.current.data).toEqual({
        tenant_id: "t1",
        base_system_prompt: "prompt customizado",
        handoff_default_keywords: ["ajuda"],
      }),
    );
  });

  it("aplica defaults quando os campos existentes vêm null", async () => {
    mockProfile("t1");
    vi.mocked(supabase.from).mockReturnValue(
      createChain({
        data: { tenant_id: "t1", base_system_prompt: null, handoff_default_keywords: null },
        error: null,
      }) as unknown as ReturnType<typeof supabase.from>,
    );
    const { result } = renderHook(() => useAiSettings(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.base_system_prompt).toMatch(/assistente virtual/);
    expect(result.current.data?.handoff_default_keywords).toContain("falar com humano");
  });

  it("cria uma linha padrão quando não existe registro e retorna os valores criados", async () => {
    mockProfile("t1");
    const chain = createChain({ data: null, error: null }) as unknown as ChainMock<unknown>;
    const insertChain = createChain({
      data: {
        tenant_id: "t1",
        base_system_prompt: "prompt inserido",
        handoff_default_keywords: ["a"],
      },
      error: null,
    });
    vi.mocked(supabase.from).mockImplementation(
      () =>
        ({
          ...chain,
          insert: vi.fn(() => insertChain),
        }) as unknown as ReturnType<typeof supabase.from>,
    );
    const { result } = renderHook(() => useAiSettings(), { wrapper: createQueryWrapper() });
    await waitFor(() =>
      expect(result.current.data).toEqual({
        tenant_id: "t1",
        base_system_prompt: "prompt inserido",
        handoff_default_keywords: ["a"],
      }),
    );
  });

  it("aplica defaults na linha recém-criada quando os campos retornam null", async () => {
    mockProfile("t1");
    const chain = createChain({ data: null, error: null }) as unknown as ChainMock<unknown>;
    const insertChain = createChain({
      data: { tenant_id: "t1", base_system_prompt: null, handoff_default_keywords: null },
      error: null,
    });
    vi.mocked(supabase.from).mockImplementation(
      () =>
        ({
          ...chain,
          insert: vi.fn(() => insertChain),
        }) as unknown as ReturnType<typeof supabase.from>,
    );
    const { result } = renderHook(() => useAiSettings(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.base_system_prompt).toMatch(/assistente virtual/);
    expect(result.current.data?.handoff_default_keywords).toContain("falar com humano");
  });

  it("propaga erro da consulta inicial", async () => {
    mockProfile("t1");
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: null, error: new Error("select falhou") }) as unknown as ReturnType<
        typeof supabase.from
      >,
    );
    const { result } = renderHook(() => useAiSettings(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it("propaga erro ao criar a linha padrão", async () => {
    mockProfile("t1");
    const chain = createChain({ data: null, error: null }) as unknown as ChainMock<unknown>;
    const insertChain = createChain({ data: null, error: new Error("insert falhou") });
    vi.mocked(supabase.from).mockImplementation(
      () =>
        ({
          ...chain,
          insert: vi.fn(() => insertChain),
        }) as unknown as ReturnType<typeof supabase.from>,
    );
    const { result } = renderHook(() => useAiSettings(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("useUpdateAiSettings", () => {
  afterEach(() => vi.clearAllMocks());

  it("rejeita sem tenant", async () => {
    mockProfile(null);
    const { result } = renderHook(() => useUpdateAiSettings(), {
      wrapper: createQueryWrapper(),
    });
    await expect(result.current.mutateAsync({ base_system_prompt: "novo" })).rejects.toThrow(
      "Sem tenant.",
    );
  });

  it("faz upsert do patch com o tenant_id", async () => {
    mockProfile("t1");
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: null, error: null }) as unknown as ReturnType<typeof supabase.from>,
    );
    const { result } = renderHook(() => useUpdateAiSettings(), {
      wrapper: createQueryWrapper(),
    });
    await result.current.mutateAsync({ base_system_prompt: "novo prompt" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(supabase.from).toHaveBeenCalledWith("ai_settings");
  });

  it("propaga erro do upsert", async () => {
    mockProfile("t1");
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: null, error: new Error("upsert falhou") }) as unknown as ReturnType<
        typeof supabase.from
      >,
    );
    const { result } = renderHook(() => useUpdateAiSettings(), {
      wrapper: createQueryWrapper(),
    });
    await expect(result.current.mutateAsync({ base_system_prompt: "x" })).rejects.toThrow(
      "upsert falhou",
    );
  });
});

type FromMock = ReturnType<typeof vi.fn<(table: string) => unknown>>;

function mockStagesTables(options: {
  board: { id: string } | null;
  // `undefined` = campo não informado pelo teste (helper aplica default []).
  // `null` explícito = simula a API retornando `data: null` sem erro.
  stages?: Array<{
    id: string;
    name: string;
    position: number;
    is_won: boolean;
    is_lost: boolean;
  }> | null;
  cfgs?: Array<Record<string, unknown>> | null;
  boardError?: unknown;
  stagesError?: unknown;
  cfgsError?: unknown;
}): FromMock {
  const stagesData = options.stages === undefined ? [] : options.stages;
  const cfgsData = options.cfgs === undefined ? [] : options.cfgs;
  const fromMock = vi.fn((table: string) => {
    if (table === "boards") {
      return createChain({ data: options.board, error: options.boardError ?? null });
    }
    if (table === "board_stages") {
      return createChain({ data: stagesData, error: options.stagesError ?? null });
    }
    if (table === "stage_ai_config") {
      return createChain({ data: cfgsData, error: options.cfgsError ?? null });
    }
    throw new Error(`tabela inesperada: ${table}`);
  });
  vi.mocked(supabase.from).mockImplementation(fromMock as unknown as typeof supabase.from);
  return fromMock as unknown as FromMock;
}

describe("useStagesWithConfig", () => {
  afterEach(() => vi.clearAllMocks());

  it("fica desabilitado sem tenant", () => {
    mockProfile(null);
    const { result } = renderHook(() => useStagesWithConfig(), { wrapper: createQueryWrapper() });
    expect(result.current.data).toBeUndefined();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("retorna lista vazia quando não há board padrão", async () => {
    mockProfile("t1");
    mockStagesTables({ board: null });
    const { result } = renderHook(() => useStagesWithConfig(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });

  it("monta estágios com config aplicada e usa defaults quando não há cfg", async () => {
    mockProfile("t1");
    mockStagesTables({
      board: { id: "b1" },
      stages: [
        { id: "s1", name: "Novo", position: 1, is_won: true, is_lost: false },
        { id: "s2", name: "Perdido", position: 2, is_won: false, is_lost: true },
      ],
      cfgs: [
        {
          stage_id: "s1",
          enabled: true,
          stage_goal: "Meta",
          system_prompt: "Prompt",
          advancement_criteria: ["Confirmou interesse", "  "],
          handoff_keywords: ["humano"],
        },
      ],
    });
    const { result } = renderHook(() => useStagesWithConfig(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.data).toHaveLength(2));
    const [s1, s2] = result.current.data ?? [];
    expect(s1).toEqual({
      stage_id: "s1",
      stage_name: "Novo",
      position: 1,
      is_won: true,
      is_lost: false,
      enabled: true,
      stage_goal: "Meta",
      system_prompt: "Prompt",
      advancement_criteria: ["Confirmou interesse"],
      handoff_keywords: ["humano"],
    });
    expect(s2).toEqual({
      stage_id: "s2",
      stage_name: "Perdido",
      position: 2,
      is_won: false,
      is_lost: true,
      enabled: false,
      stage_goal: "",
      system_prompt: "",
      advancement_criteria: [],
      handoff_keywords: [],
    });
  });

  it("normaliza advancement_criteria vindo como objetos com criterion/text/description", async () => {
    mockProfile("t1");
    mockStagesTables({
      board: { id: "b1" },
      stages: [{ id: "s1", name: "Novo", position: 1, is_won: false, is_lost: false }],
      cfgs: [
        {
          stage_id: "s1",
          enabled: true,
          stage_goal: "",
          system_prompt: "",
          advancement_criteria: [
            { criterion: "tem criterio" },
            { text: "tem texto" },
            { description: "tem descricao" },
            {},
            "  string direta  ",
          ],
          handoff_keywords: [],
        },
      ],
    });
    const { result } = renderHook(() => useStagesWithConfig(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(result.current.data?.[0].advancement_criteria).toEqual([
      "tem criterio",
      "tem texto",
      "tem descricao",
      "string direta",
    ]);
  });

  it("usa lista vazia quando advancement_criteria é null (?? [])", async () => {
    mockProfile("t1");
    mockStagesTables({
      board: { id: "b1" },
      stages: [{ id: "s1", name: "Novo", position: 1, is_won: false, is_lost: false }],
      cfgs: [{ stage_id: "s1", enabled: true, advancement_criteria: null, handoff_keywords: null }],
    });
    const { result } = renderHook(() => useStagesWithConfig(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(result.current.data?.[0].advancement_criteria).toEqual([]);
  });

  it("usa lista vazia quando advancement_criteria não é um array (valor truthy não-array)", async () => {
    mockProfile("t1");
    mockStagesTables({
      board: { id: "b1" },
      stages: [{ id: "s1", name: "Novo", position: 1, is_won: false, is_lost: false }],
      cfgs: [
        {
          stage_id: "s1",
          enabled: true,
          advancement_criteria: "não é um array",
          handoff_keywords: [],
        },
      ],
    });
    const { result } = renderHook(() => useStagesWithConfig(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(result.current.data?.[0].advancement_criteria).toEqual([]);
  });

  it("usa o id placeholder quando não há estágios (evita .in vazio)", async () => {
    mockProfile("t1");
    const fromMock = mockStagesTables({ board: { id: "b1" }, stages: [] });
    const { result } = renderHook(() => useStagesWithConfig(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
    const cfgChainCalls = fromMock.mock.results.filter(
      (_r, idx) => fromMock.mock.calls[idx]?.[0] === "stage_ai_config",
    );
    expect(cfgChainCalls).toHaveLength(1);
  });

  it("trata stages e cfgs retornando data null (sem erro) como listas vazias", async () => {
    mockProfile("t1");
    mockStagesTables({ board: { id: "b1" }, stages: null, cfgs: null });
    const { result } = renderHook(() => useStagesWithConfig(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });

  it("propaga erro da consulta do board", async () => {
    mockProfile("t1");
    mockStagesTables({ board: null, boardError: new Error("board falhou") });
    const { result } = renderHook(() => useStagesWithConfig(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it("propaga erro da consulta dos estágios", async () => {
    mockProfile("t1");
    mockStagesTables({ board: { id: "b1" }, stagesError: new Error("estagios falhou") });
    const { result } = renderHook(() => useStagesWithConfig(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it("propaga erro da consulta das configs de IA", async () => {
    mockProfile("t1");
    mockStagesTables({
      board: { id: "b1" },
      stages: [{ id: "s1", name: "Novo", position: 1, is_won: false, is_lost: false }],
      cfgsError: new Error("cfg falhou"),
    });
    const { result } = renderHook(() => useStagesWithConfig(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("useUpsertStageConfig", () => {
  afterEach(() => vi.clearAllMocks());

  const input = {
    stage_id: "s1",
    enabled: true,
    stage_goal: "meta",
    system_prompt: "prompt",
    advancement_criteria: ["a"],
    handoff_keywords: ["b"],
  };

  it("rejeita sem tenant", async () => {
    mockProfile(null);
    const { result } = renderHook(() => useUpsertStageConfig(), {
      wrapper: createQueryWrapper(),
    });
    await expect(result.current.mutateAsync(input)).rejects.toThrow("Sem tenant.");
  });

  it("faz upsert da config do estágio", async () => {
    mockProfile("t1");
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: null, error: null }) as unknown as ReturnType<typeof supabase.from>,
    );
    const { result } = renderHook(() => useUpsertStageConfig(), {
      wrapper: createQueryWrapper(),
    });
    await result.current.mutateAsync(input);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(supabase.from).toHaveBeenCalledWith("stage_ai_config");
  });

  it("propaga erro do upsert", async () => {
    mockProfile("t1");
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: null, error: new Error("falhou") }) as unknown as ReturnType<
        typeof supabase.from
      >,
    );
    const { result } = renderHook(() => useUpsertStageConfig(), {
      wrapper: createQueryWrapper(),
    });
    await expect(result.current.mutateAsync(input)).rejects.toThrow("falhou");
  });
});

describe("playgroundChat", () => {
  afterEach(() => vi.clearAllMocks());

  const input = { stage_id: "s1", messages: [{ role: "user" as const, content: "oi" }] };

  it("retorna a resposta da IA em caso de sucesso", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: { reply: "olá!" },
      error: null,
    });
    await expect(playgroundChat(input)).resolves.toEqual({ reply: "olá!" });
  });

  // O supabase-js DESCARTA o corpo em não-2xx e lança uma string fixa em inglês:
  // a mensagem em PT-BR que a function montou nunca chega. Por isso o que vale
  // é o `status`, e o teste assere a tradução dele — antes ele fixava o
  // comportamento quebrado (repassar a mensagem crua do SDK).
  it("traduz o status da falha em mensagem de tela, ignorando o texto do SDK", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: null,
      error: { message: "Edge Function returned a non-2xx status code" },
      response: { status: 429 },
    } as never);
    await expect(playgroundChat(input)).rejects.toThrow("Limite de requisições de IA atingido");
  });

  it("mapeia 402 para falta de créditos", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: null,
      error: { message: "Edge Function returned a non-2xx status code" },
      response: { status: 402 },
    } as never);
    await expect(playgroundChat(input)).rejects.toThrow("Créditos de IA esgotados");
  });

  it("usa mensagem padrão quando não há status conhecido", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: null, error: {} } as never);
    await expect(playgroundChat(input)).rejects.toThrow("Não foi possível gerar a resposta.");
  });

  it("lança o erro vindo do payload de resposta", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: { error: "prompt inválido" },
      error: null,
    });
    await expect(playgroundChat(input)).rejects.toThrow("prompt inválido");
  });

  it("lança erro quando o payload não tem reply", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: {}, error: null });
    await expect(playgroundChat(input)).rejects.toThrow("A IA não retornou resposta.");
  });
});

describe("dealChat", () => {
  afterEach(() => vi.clearAllMocks());

  const input = { deal_id: "deal-1", message: "oi, quero saber mais" };

  it("retorna a resposta da IA em caso de sucesso", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: { reply: "olá!" },
      error: null,
    });
    await expect(dealChat(input)).resolves.toEqual({ reply: "olá!" });
    expect(supabase.functions.invoke).toHaveBeenCalledWith("ai-deal-chat", { body: input });
  });

  it("lança a mensagem de erro retornada pela invocação", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: null,
      error: { message: "função indisponível" },
    });
    await expect(dealChat(input)).rejects.toThrow("função indisponível");
  });

  it("usa mensagem padrão quando o erro não tem message", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: null, error: {} });
    await expect(dealChat(input)).rejects.toThrow("Não foi possível gerar a resposta.");
  });

  it("lança o erro vindo do payload de resposta", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: { error: "negócio não encontrado" },
      error: null,
    });
    await expect(dealChat(input)).rejects.toThrow("negócio não encontrado");
  });

  it("lança erro quando o payload não tem reply", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: {}, error: null });
    await expect(dealChat(input)).rejects.toThrow("A IA não retornou resposta.");
  });
});
