import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useApplyTenantTheme, useTenantBrand, useTenantTitle } from "./tenant-brand";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile, type CurrentProfile } from "@/lib/api/session";
import { applyBrandTheme, parseBrandColors, type TenantBrandColors } from "@/lib/brand-theme";
import { useRouterState } from "@tanstack/react-router";
import { createChain, createQueryWrapper } from "@/test/query-mocks";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), storage: { from: vi.fn() } },
}));
vi.mock("@/lib/api/session", () => ({ useCurrentProfile: vi.fn() }));
vi.mock("@/lib/brand-theme", () => ({
  applyBrandTheme: vi.fn(),
  parseBrandColors: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useRouterState: vi.fn() }));

function mockProfile(tenantId: string | null) {
  const profile: CurrentProfile | null = tenantId
    ? { id: "u1", tenant_id: tenantId, name: "Ana", role: "admin" }
    : null;
  vi.mocked(useCurrentProfile).mockReturnValue({
    data: profile,
  } as unknown as ReturnType<typeof useCurrentProfile>);
}

/** Invoca o `select` real recebido, como o TanStack Router faria, em vez de só devolver um valor fixo. */
function mockPathname(pathname: string) {
  vi.mocked(useRouterState).mockImplementation(
    (opts) =>
      (opts as { select: (s: { location: { pathname: string } }) => string }).select({
        location: { pathname },
      }) as never,
  );
}

/** Perfil ainda carregando (auth não pronta ou consulta do perfil em voo). */
function mockProfilePending() {
  vi.mocked(useCurrentProfile).mockReturnValue({ data: undefined, isPending: true } as never);
}

type TenantRow = { name: string; logo_url: string | null; business_profile: null };

/** Consulta do tenant que só resolve quando o teste mandar. */
function mockTenantDeferred() {
  let resolve: (row: TenantRow) => void = () => {};
  const pending = new Promise<{ data: TenantRow; error: null }>((r) => {
    resolve = (row) => r({ data: row, error: null });
  });
  const chain = createChain({ data: null, error: null });
  chain.maybeSingle = vi.fn(() => pending) as never;
  vi.mocked(supabase.from).mockReturnValue(chain as never);
  return { resolve };
}

describe("useTenantBrand", () => {
  afterEach(() => vi.clearAllMocks());

  it("fica desabilitado sem tenant e não busca logo", () => {
    mockProfile(null);
    const { result } = renderHook(() => useTenantBrand(), { wrapper: createQueryWrapper() });
    expect(result.current.name).toBeNull();
    expect(result.current.logoUrl).toBeNull();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("retorna o nome e logoUrl null quando o tenant não tem logo", async () => {
    mockProfile("t1");
    vi.mocked(supabase.from).mockReturnValue(
      createChain({
        data: { name: "Empresa X", logo_url: null, business_profile: null },
        error: null,
      }) as unknown as ReturnType<typeof supabase.from>,
    );
    const { result } = renderHook(() => useTenantBrand(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.name).toBe("Empresa X"));
    expect(result.current.logoUrl).toBeNull();
    expect(supabase.storage.from).not.toHaveBeenCalled();
  });

  it("resolve a signed url do logo quando presente", async () => {
    mockProfile("t1");
    vi.mocked(supabase.from).mockReturnValue(
      createChain({
        data: { name: "Empresa X", logo_url: "logos/x.png", business_profile: null },
        error: null,
      }) as unknown as ReturnType<typeof supabase.from>,
    );
    const createSignedUrl = vi.fn().mockResolvedValue({ data: { signedUrl: "https://x/signed" } });
    vi.mocked(supabase.storage.from).mockReturnValue({
      createSignedUrl,
    } as unknown as ReturnType<typeof supabase.storage.from>);

    const { result } = renderHook(() => useTenantBrand(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.logoUrl).toBe("https://x/signed"));
    expect(supabase.storage.from).toHaveBeenCalledWith("logos");
    expect(createSignedUrl).toHaveBeenCalledWith("logos/x.png", 3600);
  });

  it("usa null quando a signed url não retorna valor", async () => {
    mockProfile("t1");
    vi.mocked(supabase.from).mockReturnValue(
      createChain({
        data: { name: "Empresa X", logo_url: "logos/x.png", business_profile: null },
        error: null,
      }) as unknown as ReturnType<typeof supabase.from>,
    );
    vi.mocked(supabase.storage.from).mockReturnValue({
      createSignedUrl: vi.fn().mockResolvedValue({ data: null }),
    } as unknown as ReturnType<typeof supabase.storage.from>);

    const { result } = renderHook(() => useTenantBrand(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.name).toBe("Empresa X"));
    await waitFor(() => expect(result.current.logoUrl).toBeNull());
  });

  it("propaga erro da consulta do tenant", async () => {
    mockProfile("t1");
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: null, error: new Error("boom") }) as unknown as ReturnType<
        typeof supabase.from
      >,
    );
    const { result } = renderHook(() => useTenantBrand(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.name).toBeNull());
  });

  it("ignora a resolução da signed url quando desmonta antes dela completar", async () => {
    mockProfile("t1");
    vi.mocked(supabase.from).mockReturnValue(
      createChain({
        data: { name: "Empresa X", logo_url: "logos/x.png", business_profile: null },
        error: null,
      }) as unknown as ReturnType<typeof supabase.from>,
    );
    let resolveSignedUrl: (value: { data: { signedUrl: string } }) => void = () => {};
    vi.mocked(supabase.storage.from).mockReturnValue({
      createSignedUrl: vi.fn().mockReturnValue(
        new Promise((resolve) => {
          resolveSignedUrl = resolve;
        }),
      ),
    } as unknown as ReturnType<typeof supabase.storage.from>);

    const { result, unmount } = renderHook(() => useTenantBrand(), {
      wrapper: createQueryWrapper(),
    });
    await waitFor(() => expect(result.current.name).toBe("Empresa X"));

    unmount();
    expect(() => resolveSignedUrl({ data: { signedUrl: "https://late" } })).not.toThrow();
    await Promise.resolve();
  });
});

describe("useTenantBrand — estado de carregamento", () => {
  afterEach(() => vi.clearAllMocks());

  it("sinaliza carregando enquanto o perfil ainda não chegou", () => {
    mockProfilePending();
    const { result } = renderHook(() => useTenantBrand(), { wrapper: createQueryWrapper() });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.name).toBeNull();
  });

  it("sinaliza carregando enquanto o nome do tenant está em voo e libera ao chegar", async () => {
    mockProfile("t1");
    const tenant = mockTenantDeferred();
    const { result } = renderHook(() => useTenantBrand(), { wrapper: createQueryWrapper() });
    expect(result.current.isLoading).toBe(true);

    act(() => tenant.resolve({ name: "Empresa X", logo_url: null, business_profile: null }));
    await waitFor(() => expect(result.current.name).toBe("Empresa X"));
    expect(result.current.isLoading).toBe(false);
  });

  it("não fica carregando quando não há tenant (fallback de marca permitido)", () => {
    mockProfile(null);
    const { result } = renderHook(() => useTenantBrand(), { wrapper: createQueryWrapper() });
    expect(result.current.isLoading).toBe(false);
  });

  it("não fica carregando quando a consulta do tenant falha", async () => {
    mockProfile("t1");
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: null, error: new Error("boom") }) as never,
    );
    const { result } = renderHook(() => useTenantBrand(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.name).toBeNull();
  });
});

function TitleProbe() {
  useTenantTitle();
  const { name } = useTenantBrand();
  return <span data-testid="name">{name ?? "sem-nome"}</span>;
}

/** Wrapper com o nome do workspace já em cache (navegação depois do primeiro carregamento). */
function cachedTenantWrapper(name: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(["topbar-tenant", "t1"], {
    name,
    logo_url: null,
    business_profile: null,
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

// O título que a rota grava (SSR e HeadContent) é só o nome da página; o hook
// acrescenta a marca do workspace no cliente.
describe("useTenantTitle", () => {
  afterEach(() => {
    vi.clearAllMocks();
    document.title = "";
  });

  it("enquanto o nome do workspace carrega, mostra só o título da página e depois acrescenta o nome", async () => {
    mockProfile("t1");
    mockPathname("/agenda");
    const tenant = mockTenantDeferred();
    document.title = "Agenda";

    render(<TitleProbe />, { wrapper: createQueryWrapper() });
    expect(document.title).toBe("Agenda");

    act(() => tenant.resolve({ name: "Empresa X", logo_url: null, business_profile: null }));
    await waitFor(() => expect(document.title).toBe("Agenda — Empresa X"));
  });

  it("com o perfil ainda carregando, não mostra a marca padrão", () => {
    mockProfilePending();
    mockPathname("/agenda");
    document.title = "Agenda";

    render(<TitleProbe />, { wrapper: createQueryWrapper() });
    expect(document.title).toBe("Agenda");
  });

  it("sem workspace, acrescenta a marca padrão do produto", () => {
    mockProfile(null);
    mockPathname("/agenda");
    document.title = "Agenda";

    render(<TitleProbe />, { wrapper: createQueryWrapper() });
    expect(document.title).toBe("Agenda — Stefanello");
  });

  it("com erro na consulta do workspace, acrescenta a marca padrão do produto", async () => {
    mockProfile("t1");
    mockPathname("/agenda");
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: null, error: new Error("boom") }) as never,
    );
    document.title = "Agenda";

    render(<TitleProbe />, { wrapper: createQueryWrapper() });
    await waitFor(() => expect(document.title).toBe("Agenda — Stefanello"));
  });

  it("com o nome já em cache, acrescenta o nome já no primeiro render", () => {
    mockProfile("t1");
    mockPathname("/agenda");
    document.title = "Agenda";

    render(<TitleProbe />, { wrapper: cachedTenantWrapper("Empresa X") });
    expect(document.title).toBe("Agenda — Empresa X");
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("recalcula ao trocar de rota", () => {
    mockProfile("t1");
    mockPathname("/agenda");
    document.title = "Agenda";
    const { rerender } = render(<TitleProbe />, { wrapper: cachedTenantWrapper("Empresa X") });
    expect(document.title).toBe("Agenda — Empresa X");

    document.title = "Contatos";
    mockPathname("/contatos");
    rerender(<TitleProbe />);
    expect(document.title).toBe("Contatos — Empresa X");
  });

  it("não duplica o sufixo ao rodar de novo com o mesmo estado", () => {
    mockProfile("t1");
    mockPathname("/agenda");
    document.title = "Agenda";
    const { rerender } = render(<TitleProbe />, { wrapper: cachedTenantWrapper("Empresa X") });

    rerender(<TitleProbe />);
    mockPathname("/agenda?aba=semana");
    rerender(<TitleProbe />);
    expect(document.title).toBe("Agenda — Empresa X");
  });

  it("trata como base o título que a rota grava depois do efeito (HeadContent)", async () => {
    mockProfile("t1");
    mockPathname("/agenda");
    document.title = "Agenda";
    render(<TitleProbe />, { wrapper: cachedTenantWrapper("Empresa X") });
    expect(document.title).toBe("Agenda — Empresa X");

    document.title = "Contatos";
    await waitFor(() => expect(document.title).toBe("Contatos — Empresa X"));
  });

  it("não repete a marca padrão quando o título herdado já a traz (root/404)", () => {
    mockProfile("t1");
    mockPathname("/rota-inexistente");
    document.title = "Página não encontrada — Stefanello";

    render(<TitleProbe />, { wrapper: cachedTenantWrapper("Empresa X") });
    expect(document.title).toBe("Página não encontrada — Empresa X");
  });
});

describe("useApplyTenantTheme", () => {
  afterEach(() => vi.clearAllMocks());

  it("não aplica tema enquanto não há dados do tenant", () => {
    mockProfile(null);
    vi.mocked(parseBrandColors).mockReturnValue(null);
    renderHook(() => useApplyTenantTheme(), { wrapper: createQueryWrapper() });
    expect(applyBrandTheme).not.toHaveBeenCalled();
  });

  it("aplica null quando o tenant não tem cores de marca", async () => {
    mockProfile("t1");
    vi.mocked(parseBrandColors).mockReturnValue(null);
    vi.mocked(supabase.from).mockReturnValue(
      createChain({
        data: { name: "Empresa X", logo_url: null, business_profile: null },
        error: null,
      }) as unknown as ReturnType<typeof supabase.from>,
    );
    renderHook(() => useApplyTenantTheme(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(applyBrandTheme).toHaveBeenCalledWith(null));
  });

  it("aplica as cores de marca retornadas por parseBrandColors", async () => {
    mockProfile("t1");
    const brand: TenantBrandColors = {
      primary: "#112233",
      primary_foreground: "#ffffff",
      accent_foreground: "#000000",
    };
    vi.mocked(parseBrandColors).mockReturnValue(brand);
    vi.mocked(supabase.from).mockReturnValue(
      createChain({
        data: { name: "Empresa X", logo_url: null, business_profile: { brand } },
        error: null,
      }) as unknown as ReturnType<typeof supabase.from>,
    );
    renderHook(() => useApplyTenantTheme(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(applyBrandTheme).toHaveBeenCalledWith(brand));
  });

  it("propaga erro da consulta do tenant", async () => {
    mockProfile("t1");
    vi.mocked(parseBrandColors).mockReturnValue(null);
    vi.mocked(supabase.from).mockReturnValue(
      createChain({ data: null, error: new Error("boom") }) as unknown as ReturnType<
        typeof supabase.from
      >,
    );
    const { result } = renderHook(() => useApplyTenantTheme(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(supabase.from).toHaveBeenCalled());
    expect(result.current).toBeUndefined();
  });
});
