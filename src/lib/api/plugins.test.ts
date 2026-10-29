import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import {
  resolveActivePlugins,
  requirePluginActive,
  useActivePlugins,
  usePluginActive,
  useTogglePlugin,
} from "./plugins";
import { supabase } from "@/integrations/supabase/client";
import { logClientError } from "@/lib/client-error-telemetry";
import {
  useNicheTemplates,
  useTenantOnboarding,
  type NicheTemplate,
  type TenantOnboardingRow,
} from "@/lib/api/onboarding";
import { useCurrentProfile, type CurrentProfile } from "@/lib/api/session";
import { useMyCapabilities } from "@/lib/api/entitlements";
import { createChain, createQueryWrapper } from "@/test/query-mocks";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: vi.fn() }, from: vi.fn(), rpc: vi.fn() },
}));

// O módulo real tem rate limit + dedupe (mesma mensagem na mesma rota só volta
// depois de 60s) e chamaria a RPC log_client_error de verdade.
vi.mock("@/lib/client-error-telemetry", () => ({
  logClientError: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("@/lib/api/entitlements", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/entitlements")>();
  return { ...actual, useMyCapabilities: vi.fn() };
});

// useActivePlugins/usePluginActive delegam 100% dos dados para estes dois
// hooks -- mockar o módulo inteiro evita duplicar aqui os testes de
// useNicheTemplates/useTenantOnboarding (já cobertos em onboarding.test.tsx).
vi.mock("@/lib/api/onboarding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/onboarding")>();
  return { ...actual, useNicheTemplates: vi.fn(), useTenantOnboarding: vi.fn() };
});

vi.mock("@/lib/api/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/session")>();
  return { ...actual, useCurrentProfile: vi.fn() };
});

describe("resolveActivePlugins", () => {
  it("mantém o default do nicho quando não há override", () => {
    expect(resolveActivePlugins(["agenda", "meta-ads"], null)).toEqual(
      expect.arrayContaining(["agenda", "meta-ads"]),
    );
    expect(resolveActivePlugins(["agenda", "meta-ads"], null)).toHaveLength(2);
  });

  it("override desativa um plugin que é default do nicho", () => {
    const result = resolveActivePlugins(["agenda", "meta-ads"], {
      plugin_overrides: { agenda: false },
    });
    expect(result).not.toContain("agenda");
    expect(result).toContain("meta-ads");
  });

  it("override ativa um plugin que o nicho não inclui por padrão", () => {
    const result = resolveActivePlugins(["agenda"], {
      plugin_overrides: { "meta-ads": true },
    });
    expect(result).toEqual(expect.arrayContaining(["agenda", "meta-ads"]));
    expect(result).toHaveLength(2);
  });

  it("suporta desativar um default E ativar um não-default ao mesmo tempo", () => {
    const result = resolveActivePlugins(["agenda", "feegow"], {
      plugin_overrides: { agenda: false, "meta-ads": true },
    });
    expect(result.sort()).toEqual(["feegow", "meta-ads"]);
  });

  it("tolera business_profile nulo", () => {
    expect(resolveActivePlugins(["agenda"], null)).toEqual(["agenda"]);
  });

  it("tolera business_profile sem plugin_overrides", () => {
    expect(resolveActivePlugins(["agenda"], { segment: "clínica" })).toEqual(["agenda"]);
  });

  it("tolera plugin_overrides malformado (não é objeto)", () => {
    expect(
      resolveActivePlugins(["agenda"], { plugin_overrides: "nao-e-objeto" as unknown }),
    ).toEqual(["agenda"]);
  });

  it("tolera plugin_overrides como array (não deve ser tratado como map)", () => {
    expect(resolveActivePlugins(["agenda"], { plugin_overrides: ["agenda"] })).toEqual(["agenda"]);
  });

  it("ignora valores não-booleanos dentro de plugin_overrides", () => {
    const result = resolveActivePlugins(["agenda"], {
      plugin_overrides: { agenda: "sim" as unknown, "meta-ads": null as unknown },
    });
    // "agenda" cai pro default (override inválido é ignorado); "meta-ads"
    // nunca entra pois não é default e o override não é booleano válido.
    expect(result).toEqual(["agenda"]);
  });

  it("nenhum plugin ativo quando nicho não tem defaults e não há overrides", () => {
    expect(resolveActivePlugins([], null)).toEqual([]);
  });
});

const TEMPLATE_WITH_AGENDA: NicheTemplate = {
  slug: "buffet-eventos",
  name: "Buffet de eventos",
  description: null,
  base_prompt: "prompt",
  stages: [],
  stage_prompts: [],
  plugins: ["agenda"],
};

const TEMPLATE_WITHOUT_AGENDA: NicheTemplate = {
  ...TEMPLATE_WITH_AGENDA,
  slug: "varejo-loja",
  plugins: ["meta-ads"],
};

function tenantRow(overrides: Partial<TenantOnboardingRow> = {}): TenantOnboardingRow {
  return {
    id: "t1",
    name: "Empresa X",
    logo_url: null,
    niche: "buffet-eventos",
    onboarded_at: null,
    business_profile: null,
    ...overrides,
  };
}

describe("requirePluginActive", () => {
  afterEach(() => vi.clearAllMocks());

  function mockSession(userId: string | null) {
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: { session: userId ? { user: { id: userId } } : null },
    } as never);
  }

  function fakeClient(data: {
    profile?: CurrentProfile | null;
    tenant?: TenantOnboardingRow | null;
    templates?: NicheTemplate[];
  }): QueryClient {
    return {
      ensureQueryData: vi.fn((options: { queryKey: readonly unknown[] }) => {
        const key = options.queryKey[0];
        if (key === "current-profile") return Promise.resolve(data.profile ?? null);
        if (key === "tenant-onboarding") return Promise.resolve(data.tenant ?? null);
        if (key === "niche-templates") return Promise.resolve(data.templates ?? []);
        throw new Error(`queryKey inesperada: ${String(key)}`);
      }),
    } as unknown as QueryClient;
  }

  it("deixa passar quando o plugin é default do nicho do tenant", async () => {
    mockSession("u1");
    const client = fakeClient({
      profile: { id: "u1", tenant_id: "t1", name: "Ana", role: "agent" },
      tenant: tenantRow(),
      templates: [TEMPLATE_WITH_AGENDA],
    });
    await expect(requirePluginActive(client, "agenda")).resolves.toBeUndefined();
  });

  it("redireciona (lança) quando o plugin não está entre os defaults nem overrides", async () => {
    mockSession("u1");
    const client = fakeClient({
      profile: { id: "u1", tenant_id: "t1", name: "Ana", role: "agent" },
      tenant: tenantRow({ niche: "varejo-loja" }),
      templates: [TEMPLATE_WITHOUT_AGENDA],
    });
    await expect(requirePluginActive(client, "agenda")).rejects.toBeDefined();
  });

  it("redireciona quando não há perfil", async () => {
    mockSession(null);
    const client = fakeClient({ profile: null });
    await expect(requirePluginActive(client, "agenda")).rejects.toBeDefined();
  });

  it("redireciona quando o tenant não tem niche definido", async () => {
    mockSession("u1");
    const client = fakeClient({
      profile: { id: "u1", tenant_id: "t1", name: "Ana", role: "agent" },
      tenant: tenantRow({ niche: null }),
      templates: [TEMPLATE_WITH_AGENDA],
    });
    await expect(requirePluginActive(client, "agenda")).rejects.toBeDefined();
  });

  it("override do tenant ativa um plugin que o nicho não inclui por padrão", async () => {
    mockSession("u1");
    const client = fakeClient({
      profile: { id: "u1", tenant_id: "t1", name: "Ana", role: "agent" },
      tenant: tenantRow({
        niche: "varejo-loja",
        business_profile: { plugin_overrides: { agenda: true } } as never,
      }),
      templates: [TEMPLATE_WITHOUT_AGENDA],
    });
    await expect(requirePluginActive(client, "agenda")).resolves.toBeUndefined();
  });

  it("override do tenant desativa um plugin que é default do nicho", async () => {
    mockSession("u1");
    const client = fakeClient({
      profile: { id: "u1", tenant_id: "t1", name: "Ana", role: "agent" },
      tenant: tenantRow({
        business_profile: { plugin_overrides: { agenda: false } } as never,
      }),
      templates: [TEMPLATE_WITH_AGENDA],
    });
    await expect(requirePluginActive(client, "agenda")).rejects.toBeDefined();
  });

  // O gate autoritativo é o RPC evaluate_capability (slug "agenda" mapeia para
  // a capability "calendar.agenda"). Estes dois testes configuram o retorno do
  // RPC e montam o cenário legado com o resultado OPOSTO, provando que a
  // decisão vem do gate e não cai no fallback legado. Prova de robustez:
  // inverter `runtimeAllowed === false` para `=== true` em plugins.ts quebra o
  // teste "gate nega".
  it("gate autoritativo libera (allowed:true) mesmo se o legado redirecionaria", async () => {
    mockSession("u1");
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: { allowed: true },
      error: null,
    } as never);
    // Cenário legado NEGARIA (nicho varejo-loja não inclui "agenda"): se caísse
    // no fallback, isto rejeitaria. O gate allowed:true tem de prevalecer.
    const client = fakeClient({
      profile: { id: "u1", tenant_id: "t1", name: "Ana", role: "agent" },
      tenant: tenantRow({ niche: "varejo-loja" }),
      templates: [TEMPLATE_WITHOUT_AGENDA],
    });
    await expect(requirePluginActive(client, "agenda")).resolves.toBeUndefined();
    expect(supabase.rpc).toHaveBeenCalledWith("evaluate_capability", {
      p_capability_key: "calendar.agenda",
      p_operation: "route:agenda",
    });
  });

  it("gate autoritativo nega (allowed:false) mesmo se o legado liberaria", async () => {
    mockSession("u1");
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: { allowed: false },
      error: null,
    } as never);
    // Cenário legado LIBERARIA ("agenda" é default do nicho buffet-eventos): se
    // caísse no fallback, isto resolveria. O gate allowed:false tem de negar.
    const client = fakeClient({
      profile: { id: "u1", tenant_id: "t1", name: "Ana", role: "agent" },
      tenant: tenantRow(),
      templates: [TEMPLATE_WITH_AGENDA],
    });
    await expect(requirePluginActive(client, "agenda")).rejects.toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Achado 05 · H5 (code review 10/08): quando a RPC devolve `{error}`,
  // supabase-js NÃO lança — o `catch` (e o console.warn dele) era código morto,
  // `runtimeAllowed` ficava null e a decisão de autorização degradava em
  // silêncio para o resolver legado por nicho, sem ninguém medir a frequência.
  // ---------------------------------------------------------------------------
  describe("RPC quebrada != capability negada", () => {
    it("registra telemetria e cai no resolver legado quando a RPC devolve {error}", async () => {
      mockSession("u1");
      vi.mocked(logClientError).mockClear();
      vi.mocked(supabase.rpc).mockResolvedValue({
        data: null,
        error: { message: "permission denied for function evaluate_capability", code: "42501" },
      } as never);
      const client = fakeClient({
        profile: { id: "u1", tenant_id: "t1", name: "Ana", role: "agent" },
        tenant: tenantRow(),
        templates: [TEMPLATE_WITH_AGENDA],
      });

      // Fail-open preservado de propósito: o legado libera "agenda" (default do
      // nicho) e a rota continua acessível — fechar aqui viraria lockout do app
      // inteiro quando a função não existe no ambiente (PGRST202).
      await expect(requirePluginActive(client, "agenda")).resolves.toBeUndefined();
      expect(logClientError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "42501" }),
        expect.objectContaining({ operation: "evaluate_capability:calendar.agenda:route:agenda" }),
      );
    });

    it("resposta fora do contrato (sem 'allowed') também é registrada como RPC quebrada", async () => {
      mockSession("u1");
      vi.mocked(logClientError).mockClear();
      vi.mocked(supabase.rpc).mockResolvedValue({ data: null, error: null } as never);
      const client = fakeClient({
        profile: { id: "u1", tenant_id: "t1", name: "Ana", role: "agent" },
        tenant: tenantRow(),
        templates: [TEMPLATE_WITH_AGENDA],
      });

      await expect(requirePluginActive(client, "agenda")).resolves.toBeUndefined();
      expect(logClientError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ operation: "evaluate_capability:calendar.agenda:route:agenda" }),
      );
    });

    it("gate que responde allowed:false NÃO gera telemetria de falha (é decisão, não erro)", async () => {
      mockSession("u1");
      vi.mocked(logClientError).mockClear();
      vi.mocked(supabase.rpc).mockResolvedValue({ data: { allowed: false }, error: null } as never);
      const client = fakeClient({
        profile: { id: "u1", tenant_id: "t1", name: "Ana", role: "agent" },
        tenant: tenantRow(),
        templates: [TEMPLATE_WITH_AGENDA],
      });

      await expect(requirePluginActive(client, "agenda")).rejects.toBeDefined();
      expect(logClientError).not.toHaveBeenCalled();
    });
  });
});

function mockOnboarding(opts: {
  nicheLoading?: boolean;
  tenantLoading?: boolean;
  templates?: NicheTemplate[];
  tenant?: TenantOnboardingRow | null;
}) {
  vi.mocked(useMyCapabilities).mockReturnValue({
    data: undefined,
  } as unknown as ReturnType<typeof useMyCapabilities>);
  vi.mocked(useNicheTemplates).mockReturnValue({
    isLoading: opts.nicheLoading ?? false,
    data: opts.templates ?? [],
  } as unknown as ReturnType<typeof useNicheTemplates>);
  vi.mocked(useTenantOnboarding).mockReturnValue({
    isLoading: opts.tenantLoading ?? false,
    data: opts.tenant ?? null,
  } as unknown as ReturnType<typeof useTenantOnboarding>);
}

describe("useActivePlugins", () => {
  afterEach(() => vi.clearAllMocks());

  it("retorna [] enquanto os niche templates ainda carregam", () => {
    mockOnboarding({ nicheLoading: true, tenant: tenantRow() });
    const { result } = renderHook(() => useActivePlugins());
    expect(result.current).toEqual([]);
  });

  it("retorna [] enquanto o onboarding do tenant ainda carrega", () => {
    mockOnboarding({ tenantLoading: true, templates: [TEMPLATE_WITH_AGENDA] });
    const { result } = renderHook(() => useActivePlugins());
    expect(result.current).toEqual([]);
  });

  it("retorna [] quando o tenant ainda não tem niche definido", () => {
    mockOnboarding({ tenant: tenantRow({ niche: null }), templates: [TEMPLATE_WITH_AGENDA] });
    const { result } = renderHook(() => useActivePlugins());
    expect(result.current).toEqual([]);
  });

  it("resolve os defaults do niche_template que bate com o niche do tenant", () => {
    mockOnboarding({
      tenant: tenantRow(),
      templates: [TEMPLATE_WITH_AGENDA, TEMPLATE_WITHOUT_AGENDA],
    });
    const { result } = renderHook(() => useActivePlugins());
    expect(result.current).toEqual(["agenda"]);
  });

  it("niche do tenant não bate com nenhum niche_template -- só os overrides contam, sem defaults", () => {
    mockOnboarding({
      tenant: tenantRow({
        niche: "niche-sem-template-correspondente",
        business_profile: { plugin_overrides: { "meta-ads": true } } as never,
      }),
      templates: [TEMPLATE_WITH_AGENDA],
    });
    const { result } = renderHook(() => useActivePlugins());
    expect(result.current).toEqual(["meta-ads"]);
  });

  it("aplica os overrides do business_profile do tenant sobre os defaults do niche", () => {
    mockOnboarding({
      tenant: tenantRow({ business_profile: { plugin_overrides: { agenda: false } } as never }),
      templates: [TEMPLATE_WITH_AGENDA],
    });
    const { result } = renderHook(() => useActivePlugins());
    expect(result.current).toEqual([]);
  });
});

describe("usePluginActive", () => {
  afterEach(() => vi.clearAllMocks());

  it("retorna true quando o plugin está entre os ativos do tenant", () => {
    mockOnboarding({ tenant: tenantRow(), templates: [TEMPLATE_WITH_AGENDA] });
    const { result } = renderHook(() => usePluginActive("agenda"));
    expect(result.current).toBe(true);
  });

  it("retorna false quando o plugin não está entre os ativos do tenant", () => {
    mockOnboarding({ tenant: tenantRow(), templates: [TEMPLATE_WITH_AGENDA] });
    const { result } = renderHook(() => usePluginActive("meta-ads"));
    expect(result.current).toBe(false);
  });
});

function mockCurrentProfile(tenantId: string | null) {
  vi.mocked(useCurrentProfile).mockReturnValue({
    data: tenantId ? { id: "u1", tenant_id: tenantId, name: "Ana", role: "agent" } : null,
  } as unknown as ReturnType<typeof useCurrentProfile>);
}

describe("useTogglePlugin", () => {
  beforeEach(() => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: null, error: null } as never);
  });

  afterEach(() => vi.clearAllMocks());

  it("rejeita com 'Tenant inválido' quando não há tenant resolvido", async () => {
    mockCurrentProfile(null);
    const { result } = renderHook(() => useTogglePlugin(), { wrapper: createQueryWrapper() });
    await expect(result.current.mutateAsync({ slug: "agenda", active: false })).rejects.toThrow(
      "Tenant inválido",
    );
  });

  it("delega a desativação para a RPC atômica tenant-scoped", async () => {
    mockCurrentProfile("t1");

    const { result } = renderHook(() => useTogglePlugin(), { wrapper: createQueryWrapper() });
    await result.current.mutateAsync({ slug: "agenda", active: false });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(supabase.rpc).toHaveBeenCalledWith("set_tenant_plugin_override", {
      p_slug: "agenda",
      p_active: false,
    });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("delega a ativação para a RPC atômica tenant-scoped", async () => {
    mockCurrentProfile("t1");

    const { result } = renderHook(() => useTogglePlugin(), { wrapper: createQueryWrapper() });
    await result.current.mutateAsync({ slug: "agenda", active: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(supabase.rpc).toHaveBeenCalledWith("set_tenant_plugin_override", {
      p_slug: "agenda",
      p_active: true,
    });
  });

  it("preserva slug com hífen no contrato da RPC", async () => {
    mockCurrentProfile("t1");

    const { result } = renderHook(() => useTogglePlugin(), { wrapper: createQueryWrapper() });
    await result.current.mutateAsync({ slug: "meta-ads", active: true });

    expect(supabase.rpc).toHaveBeenCalledWith("set_tenant_plugin_override", {
      p_slug: "meta-ads",
      p_active: true,
    });
  });

  it("propaga erro da RPC atômica", async () => {
    mockCurrentProfile("t1");
    vi.mocked(supabase.rpc).mockResolvedValueOnce({
      data: null,
      error: new Error("falhou RPC"),
    } as never);

    const { result } = renderHook(() => useTogglePlugin(), { wrapper: createQueryWrapper() });
    await expect(result.current.mutateAsync({ slug: "agenda", active: true })).rejects.toThrow(
      "falhou RPC",
    );
  });

  it("invalida a query tenant-onboarding após alternar com sucesso (é essa invalidação que atualiza o nav)", async () => {
    mockCurrentProfile("t1");
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");

    const { result } = renderHook(() => useTogglePlugin(), { wrapper: createQueryWrapper() });
    await result.current.mutateAsync({ slug: "agenda", active: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["tenant-onboarding"] });
  });
});
