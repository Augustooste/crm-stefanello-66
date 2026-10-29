import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import {
  fetchDefaultBoardInfo,
  useApplyNicheTemplate,
  useCompleteOnboarding,
  useNicheTemplates,
  useTenantOnboarding,
  type NicheTemplate,
  type TenantOnboardingRow,
} from "./onboarding";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile, type CurrentProfile } from "@/lib/api/session";
import { useAuth } from "@/lib/auth/AuthProvider";
import {
  createChain,
  createQueryWrapper,
  type ChainMock,
  type PostgrestLikeResult,
} from "@/test/query-mocks";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));
vi.mock("@/lib/api/session", () => ({ useCurrentProfile: vi.fn() }));
vi.mock("@/lib/auth/AuthProvider", () => ({ useAuth: vi.fn() }));

function mockProfile(tenantId: string | null) {
  const profile: CurrentProfile | null = tenantId
    ? { id: "u1", tenant_id: tenantId, name: "Ana", role: "admin" }
    : null;
  vi.mocked(useCurrentProfile).mockReturnValue({
    data: profile,
  } as unknown as ReturnType<typeof useCurrentProfile>);
}

describe("useNicheTemplates", () => {
  afterEach(() => vi.clearAllMocks());

  function mockAuthenticated() {
    vi.mocked(useAuth).mockReturnValue({ user: { id: "u1" }, isReady: true } as ReturnType<
      typeof useAuth
    >);
  }

  it("lista os templates de nicho ordenados por nome", async () => {
    mockAuthenticated();
    const templates: NicheTemplate[] = [
      {
        slug: "clinica",
        name: "Clínica",
        description: null,
        base_prompt: "prompt",
        stages: [],
        stage_prompts: [],
        plugins: [],
      },
    ];
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: templates, error: null }) as unknown as ReturnType<typeof supabase.from>,
    );
    const { result } = renderHook(() => useNicheTemplates(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.data).toEqual(templates));
    expect(supabase.from).toHaveBeenCalledWith("niche_templates");
  });

  it("retorna array vazio quando data é null", async () => {
    mockAuthenticated();
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: null, error: null }) as unknown as ReturnType<typeof supabase.from>,
    );
    const { result } = renderHook(() => useNicheTemplates(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });

  it("propaga erro", async () => {
    mockAuthenticated();
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: null, error: new Error("boom") }) as unknown as ReturnType<
        typeof supabase.from
      >,
    );
    const { result } = renderHook(() => useNicheTemplates(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it("não consulta templates depois que a sessão é encerrada", () => {
    vi.mocked(useAuth).mockReturnValue({ user: null, isReady: true });

    const { result } = renderHook(() => useNicheTemplates(), { wrapper: createQueryWrapper() });

    expect(result.current.fetchStatus).toBe("idle");
    expect(supabase.from).not.toHaveBeenCalled();
  });
});

describe("useTenantOnboarding", () => {
  afterEach(() => vi.clearAllMocks());

  it("fica desabilitado sem tenant", () => {
    mockProfile(null);
    const { result } = renderHook(() => useTenantOnboarding(), { wrapper: createQueryWrapper() });
    expect(result.current.data).toBeUndefined();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("retorna a linha do tenant", async () => {
    mockProfile("t1");
    const row: TenantOnboardingRow = {
      id: "t1",
      name: "Empresa X",
      logo_url: null,
      niche: "clinica",
      onboarded_at: null,
      business_profile: null,
    };
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: row, error: null }) as unknown as ReturnType<typeof supabase.from>,
    );
    const { result } = renderHook(() => useTenantOnboarding(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.data).toEqual(row));
  });

  it("retorna null quando não há linha", async () => {
    mockProfile("t1");
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: null, error: null }) as unknown as ReturnType<typeof supabase.from>,
    );
    const { result } = renderHook(() => useTenantOnboarding(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it("propaga erro", async () => {
    mockProfile("t1");
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: null, error: new Error("boom") }) as unknown as ReturnType<
        typeof supabase.from
      >,
    );
    const { result } = renderHook(() => useTenantOnboarding(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

function mockActivateScheduledJobs(overrides: { vault_missing: string[]; can_manage?: boolean }) {
  // A conclusão só ativa para o operador e com as credenciais presentes.
  vi.mocked(supabase.rpc).mockImplementation((async (name: string) => {
    if (name === "scheduled_jobs_status") {
      return {
        data: {
          can_manage: true,
          ...overrides,
          jobs: [],
          total: 12,
          active: 0,
        },
        error: null,
      };
    }
    return {
      data: {
        created: 0,
        replaced: 0,
        unchanged: 12,
        active: 11,
        inactive: 1,
        paused_all: false,
        ...overrides,
      },
      error: null,
    };
  }) as unknown as typeof supabase.rpc);
}

describe("useCompleteOnboarding", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("rejeita sem tenant", async () => {
    mockProfile(null);
    const { result } = renderHook(() => useCompleteOnboarding(), {
      wrapper: createQueryWrapper(),
    });
    await expect(result.current.mutateAsync()).rejects.toThrow("Tenant inválido");
  });

  it("atualiza onboarded_at com a data atual e invalida o cache", async () => {
    mockProfile("t1");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 0, 15, 10, 0, 0));
    const chain = createChain({ data: null, error: null });
    vi.mocked(supabase.from).mockReturnValue(chain as unknown as ReturnType<typeof supabase.from>);
    mockActivateScheduledJobs({ vault_missing: [] });

    const { result } = renderHook(() => useCompleteOnboarding(), {
      wrapper: createQueryWrapper(),
    });
    await result.current.mutateAsync();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(chain.update).toHaveBeenCalledWith({
      onboarded_at: new Date(2026, 0, 15, 10, 0, 0).toISOString(),
    });
    expect(chain.eq).toHaveBeenCalledWith("id", "t1");
    expect(supabase.rpc).toHaveBeenCalledWith("activate_scheduled_jobs");
  });

  it("conclui para admin comum sem tentar ativar rotinas globais", async () => {
    mockProfile("t1");
    const chain = createChain({ data: null, error: null });
    vi.mocked(supabase.from).mockReturnValue(chain as never);
    mockActivateScheduledJobs({ vault_missing: [], can_manage: false });

    const { result } = renderHook(() => useCompleteOnboarding(), {
      wrapper: createQueryWrapper(),
    });
    const outcome = await result.current.mutateAsync();

    expect(chain.eq).toHaveBeenCalledWith("id", "t1");
    expect(outcome).toEqual({ vaultMissing: [], scheduledJobsActivated: false });
    expect(supabase.rpc).not.toHaveBeenCalledWith("activate_scheduled_jobs");
  });

  it("devolve os segredos que faltam no Vault", async () => {
    mockProfile("t1");
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: null, error: null }) as unknown as ReturnType<typeof supabase.from>,
    );
    mockActivateScheduledJobs({ vault_missing: ["aceleraflow_service_role_key"] });

    const { result } = renderHook(() => useCompleteOnboarding(), {
      wrapper: createQueryWrapper(),
    });
    const outcome = await result.current.mutateAsync();

    expect(outcome).toEqual({
      vaultMissing: ["aceleraflow_service_role_key"],
      scheduledJobsActivated: false,
    });
  });

  it("conclui mesmo quando a ativação das rotinas falha", async () => {
    mockProfile("t1");
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: null, error: null }) as unknown as ReturnType<typeof supabase.from>,
    );
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: null,
      error: new Error("sem permissão"),
    } as unknown as Awaited<ReturnType<typeof supabase.rpc>>);

    const { result } = renderHook(() => useCompleteOnboarding(), {
      wrapper: createQueryWrapper(),
    });
    const outcome = await result.current.mutateAsync();

    expect(outcome).toEqual({ vaultMissing: [], scheduledJobsActivated: false });
    expect(supabase.rpc).not.toHaveBeenCalledWith("activate_scheduled_jobs");
  });

  it("propaga erro do update", async () => {
    mockProfile("t1");
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: null, error: new Error("falhou") }) as unknown as ReturnType<
        typeof supabase.from
      >,
    );
    const { result } = renderHook(() => useCompleteOnboarding(), {
      wrapper: createQueryWrapper(),
    });
    await expect(result.current.mutateAsync()).rejects.toThrow("falhou");
  });
});

function mockDefaultBoardTables(options: {
  board: { id: string } | null;
  boardError?: unknown;
  stageCount?: number | null;
  dealCount?: number | null;
}) {
  vi.mocked(supabase.from).mockImplementation((table: string) => {
    if (table === "boards") {
      return createChain({
        data: options.board,
        error: options.boardError ?? null,
      }) as unknown as ReturnType<typeof supabase.from>;
    }
    if (table === "board_stages") {
      return createChain({
        data: null,
        error: null,
        count: options.stageCount === undefined ? 0 : options.stageCount,
      }) as unknown as ReturnType<typeof supabase.from>;
    }
    if (table === "deals") {
      return createChain({
        data: null,
        error: null,
        count: options.dealCount === undefined ? 0 : options.dealCount,
      }) as unknown as ReturnType<typeof supabase.from>;
    }
    throw new Error(`tabela inesperada: ${table}`);
  });
}

describe("fetchDefaultBoardInfo", () => {
  afterEach(() => vi.clearAllMocks());

  it("retorna zeros e não consulta contagens quando não há board padrão", async () => {
    mockDefaultBoardTables({ board: null });
    const info = await fetchDefaultBoardInfo("t1");
    expect(info).toEqual({ boardId: null, stageCount: 0, dealCount: 0 });
    expect(supabase.from).toHaveBeenCalledTimes(1);
    expect(supabase.from).toHaveBeenCalledWith("boards");
  });

  it("retorna as contagens de estágios e negócios do board padrão", async () => {
    mockDefaultBoardTables({ board: { id: "b1" }, stageCount: 5, dealCount: 12 });
    const info = await fetchDefaultBoardInfo("t1");
    expect(info).toEqual({ boardId: "b1", stageCount: 5, dealCount: 12 });
  });

  it("usa 0 quando as contagens vêm null", async () => {
    mockDefaultBoardTables({ board: { id: "b1" }, stageCount: null, dealCount: null });
    const info = await fetchDefaultBoardInfo("t1");
    expect(info).toEqual({ boardId: "b1", stageCount: 0, dealCount: 0 });
  });

  it("propaga erro da consulta do board", async () => {
    mockDefaultBoardTables({ board: null, boardError: new Error("boom") });
    await expect(fetchDefaultBoardInfo("t1")).rejects.toThrow("boom");
  });
});

function createBoardsChain(
  existing: PostgrestLikeResult<{ id: string } | null>,
  inserted?: PostgrestLikeResult<{ id: string } | null>,
): ChainMock<unknown> {
  const chain: ChainMock<unknown> = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    in: vi.fn(() => chain),
    is: vi.fn(() => chain),
    not: vi.fn(() => chain),
    gte: vi.fn(() => chain),
    lte: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    update: vi.fn(() => chain),
    insert: vi.fn(() => chain),
    upsert: vi.fn(() => chain),
    maybeSingle: vi.fn(() => Promise.resolve(existing)),
    single: vi.fn(() => Promise.resolve(inserted ?? { data: null, error: null })),
    then: (onFulfilled, onRejected) =>
      Promise.resolve(existing).then(onFulfilled ?? undefined, onRejected ?? undefined),
  };
  return chain;
}

const baseTemplate: NicheTemplate = {
  slug: "clinica",
  name: "Clínica",
  description: null,
  base_prompt: "prompt base",
  stages: [
    { name: "Perdido", position: 2, is_won: false, is_lost: true },
    { name: "Novo", position: 1, is_won: false, is_lost: false },
  ],
  stage_prompts: [
    {
      position: 1,
      goal: "Meta",
      system_prompt: "Prompt",
      advancement_criteria: ["a"],
      handoff_keywords: ["b"],
    },
  ],
  plugins: [],
};

describe("useApplyNicheTemplate", () => {
  afterEach(() => vi.clearAllMocks());

  it("rejeita sem tenant", async () => {
    mockProfile(null);
    const { result } = renderHook(() => useApplyNicheTemplate(), {
      wrapper: createQueryWrapper(),
    });
    await expect(result.current.mutateAsync(baseTemplate)).rejects.toThrow("Tenant inválido");
  });

  it("usa o board padrão existente e envia o payload ordenado por posição ao RPC", async () => {
    mockProfile("t1");
    const boardsChain = createBoardsChain({ data: { id: "board-existente" }, error: null });
    vi.mocked(supabase.from).mockReturnValue(
      boardsChain as unknown as ReturnType<typeof supabase.from>,
    );
    vi.mocked(supabase.rpc).mockResolvedValue({ data: { ok: true }, error: null } as never);

    const { result } = renderHook(() => useApplyNicheTemplate(), {
      wrapper: createQueryWrapper(),
    });
    const outcome = await result.current.mutateAsync(baseTemplate);

    expect(outcome).toEqual({ boardId: "board-existente", result: { ok: true } });
    expect(boardsChain.insert).not.toHaveBeenCalled();
    expect(supabase.rpc).toHaveBeenCalledWith("apply_niche_template", {
      p_board_id: "board-existente",
      p_niche_slug: "clinica",
      p_base_prompt: "prompt base",
      p_stages: [
        { name: "Novo", position: 1, is_won: false, is_lost: false },
        { name: "Perdido", position: 2, is_won: false, is_lost: true },
      ],
      p_stage_prompts: [
        {
          position: 1,
          goal: "Meta",
          system_prompt: "Prompt",
          advancement_criteria: ["a"],
          handoff_keywords: ["b"],
        },
      ],
    });
  });

  it("cria o board padrão quando não existe um", async () => {
    mockProfile("t1");
    const boardsChain = createBoardsChain(
      { data: null, error: null },
      { data: { id: "board-novo" }, error: null },
    );
    vi.mocked(supabase.from).mockReturnValue(
      boardsChain as unknown as ReturnType<typeof supabase.from>,
    );
    vi.mocked(supabase.rpc).mockResolvedValue({ data: { ok: true }, error: null } as never);

    const { result } = renderHook(() => useApplyNicheTemplate(), {
      wrapper: createQueryWrapper(),
    });
    const outcome = await result.current.mutateAsync(baseTemplate);

    expect(outcome).toEqual({ boardId: "board-novo", result: { ok: true } });
    expect(boardsChain.insert).toHaveBeenCalledWith({
      tenant_id: "t1",
      name: "Funil de vendas",
      is_default: true,
    });
  });

  it("aplica defaults no stage_prompts quando campos opcionais faltam", async () => {
    mockProfile("t1");
    const boardsChain = createBoardsChain({ data: { id: "board-existente" }, error: null });
    vi.mocked(supabase.from).mockReturnValue(
      boardsChain as unknown as ReturnType<typeof supabase.from>,
    );
    vi.mocked(supabase.rpc).mockResolvedValue({ data: { ok: true }, error: null } as never);

    const template: NicheTemplate = {
      ...baseTemplate,
      stage_prompts: [{ position: 1 }],
    };
    const { result } = renderHook(() => useApplyNicheTemplate(), {
      wrapper: createQueryWrapper(),
    });
    await result.current.mutateAsync(template);

    expect(supabase.rpc).toHaveBeenCalledWith(
      "apply_niche_template",
      expect.objectContaining({
        p_stage_prompts: [
          {
            position: 1,
            goal: null,
            system_prompt: null,
            advancement_criteria: [],
            handoff_keywords: [],
          },
        ],
      }),
    );
  });

  it("usa lista vazia quando o template não tem stage_prompts", async () => {
    mockProfile("t1");
    const boardsChain = createBoardsChain({ data: { id: "board-existente" }, error: null });
    vi.mocked(supabase.from).mockReturnValue(
      boardsChain as unknown as ReturnType<typeof supabase.from>,
    );
    vi.mocked(supabase.rpc).mockResolvedValue({ data: { ok: true }, error: null } as never);

    const template = {
      ...baseTemplate,
      stage_prompts: undefined,
    } as unknown as NicheTemplate;
    const { result } = renderHook(() => useApplyNicheTemplate(), {
      wrapper: createQueryWrapper(),
    });
    await result.current.mutateAsync(template);

    expect(supabase.rpc).toHaveBeenCalledWith(
      "apply_niche_template",
      expect.objectContaining({ p_stage_prompts: [] }),
    );
  });

  it("propaga erro ao consultar o board existente", async () => {
    mockProfile("t1");
    const boardsChain = createBoardsChain({ data: null, error: new Error("board falhou") });
    vi.mocked(supabase.from).mockReturnValue(
      boardsChain as unknown as ReturnType<typeof supabase.from>,
    );
    const { result } = renderHook(() => useApplyNicheTemplate(), {
      wrapper: createQueryWrapper(),
    });
    await expect(result.current.mutateAsync(baseTemplate)).rejects.toThrow("board falhou");
  });

  it("propaga erro ao criar o board novo", async () => {
    mockProfile("t1");
    const boardsChain = createBoardsChain(
      { data: null, error: null },
      { data: null, error: new Error("insert falhou") },
    );
    vi.mocked(supabase.from).mockReturnValue(
      boardsChain as unknown as ReturnType<typeof supabase.from>,
    );
    const { result } = renderHook(() => useApplyNicheTemplate(), {
      wrapper: createQueryWrapper(),
    });
    await expect(result.current.mutateAsync(baseTemplate)).rejects.toThrow("insert falhou");
  });

  it("lança mensagem amigável quando o RPC falha", async () => {
    mockProfile("t1");
    const boardsChain = createBoardsChain({ data: { id: "board-existente" }, error: null });
    vi.mocked(supabase.from).mockReturnValue(
      boardsChain as unknown as ReturnType<typeof supabase.from>,
    );
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: null,
      error: new Error("violação de constraint xyz"),
    } as never);
    const { result } = renderHook(() => useApplyNicheTemplate(), {
      wrapper: createQueryWrapper(),
    });
    await expect(result.current.mutateAsync(baseTemplate)).rejects.toThrow(
      "Não foi possível aplicar o modelo",
    );
  });
});
