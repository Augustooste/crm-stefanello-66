import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SidebarProvider } from "@/components/ui/sidebar";
import { __resetAppearanceStoreForTests } from "@/lib/useAppearance";
import { AppTopbar } from "./AppTopbar";
import { useApplyTenantTheme, useTenantBrand } from "@/lib/api/tenant-brand";

const navigateMock = vi.fn();
const useCurrentProfileMock = vi.fn();
const maybeSingleMock = vi.fn();
const createSignedUrlMock = vi.fn();
const signOutMock = vi.fn();
const useDecisionQueueMock = vi.fn();
const useHumanAttentionCountMock = vi.fn();
const useRecentAiFailureCountMock = vi.fn();
const useWorkspacesMock = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/lib/api/session", () => ({
  useCurrentProfile: () => useCurrentProfileMock(),
}));

vi.mock("@/lib/api/workspaces", () => ({
  useWorkspaces: () => useWorkspacesMock(),
  useSwitchWorkspace: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/use-decision-queue", () => ({
  useDecisionQueue: () => useDecisionQueueMock(),
}));

vi.mock("@/lib/api/human-attention", () => ({
  useHumanAttentionCount: (...args: unknown[]) => useHumanAttentionCountMock(...args),
}));

vi.mock("@/lib/api/ai-failure-logs", () => ({
  useRecentAiFailureCount: () => useRecentAiFailureCountMock(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      // Repassa as colunas pedidas: o teste de cache compartilhado responde só
      // com o que a consulta realmente selecionou, como o PostgREST.
      select: (columns: string) => ({
        eq: () => ({
          maybeSingle: () => maybeSingleMock(columns),
        }),
      }),
    }),
    storage: {
      from: () => ({
        createSignedUrl: (...args: unknown[]) => createSignedUrlMock(...args),
      }),
    },
    auth: {
      signOut: (...args: unknown[]) => signOutMock(...args),
    },
  },
}));

function renderTopbar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rendered = render(
    <QueryClientProvider client={qc}>
      <SidebarProvider>
        <AppTopbar />
      </SidebarProvider>
    </QueryClientProvider>,
  );
  return { ...rendered, queryClient: qc };
}

describe("AppTopbar", () => {
  beforeEach(() => {
    navigateMock.mockReset();
    useCurrentProfileMock.mockReset();
    maybeSingleMock.mockReset();
    createSignedUrlMock.mockReset();
    signOutMock.mockReset();
    useDecisionQueueMock.mockReset();
    useHumanAttentionCountMock.mockReset();
    useRecentAiFailureCountMock.mockReset();
    useWorkspacesMock.mockReset();
    // Padrão: sessão pronta e consulta de workspaces concluída sem membership
    // ativa — o nome vem da consulta do tenant.
    useWorkspacesMock.mockReturnValue({ data: [], isPending: false, isLoading: false });

    maybeSingleMock.mockResolvedValue({
      data: { name: "Clínica Vida", logo_url: null },
      error: null,
    });
    createSignedUrlMock.mockResolvedValue({
      data: { signedUrl: "https://logo.example/signed.png" },
    });
    signOutMock.mockResolvedValue({ error: null });
    useDecisionQueueMock.mockReturnValue({ items: [] });
    useHumanAttentionCountMock.mockReturnValue(0);
    useRecentAiFailureCountMock.mockReturnValue(0);
    document.documentElement.classList.remove("dark");
    document.documentElement.removeAttribute("data-skin");
    localStorage.clear();
    __resetAppearanceStoreForTests();
  });

  it("enquanto perfil e workspaces carregam, mostra placeholder neutro e nunca a marca genérica", () => {
    useCurrentProfileMock.mockReturnValue({ data: undefined, isPending: true });
    useWorkspacesMock.mockReturnValue({ data: undefined, isPending: true, isLoading: false });

    renderTopbar();

    expect(screen.queryAllByText("Stefanello")).toHaveLength(0);
    expect(screen.getAllByText("Carregando…").length).toBeGreaterThan(0);
  });

  it("em tela estreita o cabeçalho compacta: período só com ícone, nome truncável, gaps menores", () => {
    useCurrentProfileMock.mockReturnValue({ data: { tenant_id: "t1", name: "Ana" } });
    useWorkspacesMock.mockReturnValue({
      data: [{ tenant_id: "t1", tenant_name: "Empresa X", role_key: "admin", is_active: true }],
      isPending: false,
      isLoading: false,
    });

    const { container } = renderTopbar();

    // Overflow real não mede em jsdom: aqui só a estrutura que faz caber em 390 px.
    const header = container.querySelector("header");
    expect(header).toHaveClass("gap-2", "px-2", "sm:gap-3", "sm:px-4");
    const period = screen.getByRole("combobox", { name: "Selecionar período do filtro global" });
    expect(period).toHaveClass("w-auto", "sm:w-[170px]");
    expect(period).toHaveAttribute("title", "Últimos 30 dias");
    expect(period.querySelector('[data-testid="period-picker-compact-icon"]')).toHaveClass(
      "sm:hidden",
    );
    expect(period.querySelector("span.max-sm\\:sr-only")).toHaveTextContent("Últimos 30 dias");
    expect(screen.getByTitle("Empresa X")).toHaveClass("truncate");
    expect(screen.getByTitle("Empresa X").parentElement).toHaveClass("min-w-0");
    // Sino e menu do usuário continuam no cabeçalho.
    expect(screen.getByRole("button", { name: "Notificações" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Menu de Ana" })).toBeInTheDocument();
  });

  it("com o workspace ativo carregado, mostra o nome dele e não a marca genérica", async () => {
    useCurrentProfileMock.mockReturnValue({ data: { tenant_id: "t1", name: "Ana" } });
    useWorkspacesMock.mockReturnValue({
      data: [{ tenant_id: "t1", tenant_name: "Empresa X", role_key: "admin", is_active: true }],
      isPending: false,
      isLoading: false,
    });

    renderTopbar();

    expect((await screen.findAllByText("Empresa X")).length).toBeGreaterThan(0);
    expect(screen.queryAllByText("Stefanello")).toHaveLength(0);
  });

  it("renderiza o nome do tenant retornado pela query quando o perfil tem tenant_id", async () => {
    useCurrentProfileMock.mockReturnValue({ data: { tenant_id: "t1", name: "Ana" } });

    renderTopbar();

    expect(await screen.findByText("Clínica Vida")).toBeInTheDocument();
  });

  it("mostra a logo do tenant quando logo_url é retornado", async () => {
    useCurrentProfileMock.mockReturnValue({ data: { tenant_id: "t1", name: "Ana" } });
    maybeSingleMock.mockResolvedValue({
      data: { name: "Clínica Vida", logo_url: "logos/t1/logo.png" },
      error: null,
    });

    renderTopbar();

    await waitFor(() =>
      expect(createSignedUrlMock).toHaveBeenCalledWith("logos/t1/logo.png", 3600),
    );
    const img = await screen.findByAltText("");
    expect(img).toHaveAttribute("src", "https://logo.example/signed.png");
  });

  it("exibe as iniciais do nome do usuário no avatar", () => {
    useCurrentProfileMock.mockReturnValue({ data: { tenant_id: "t1", name: "Maria Silva" } });

    renderTopbar();

    expect(screen.getByText("MS")).toBeInTheDocument();
  });

  // A topbar usava "??" e as listas devolviam string vazia para o mesmo caso.
  // O InitialsAvatar unificou em "?" — um símbolo só, do tamanho de uma inicial.
  it('exibe "?" no avatar quando não há nome de usuário', () => {
    useCurrentProfileMock.mockReturnValue({ data: { tenant_id: "t1", name: null } });

    renderTopbar();

    expect(screen.getByText("?")).toBeInTheDocument();
  });

  it('mostra "Minha conta" quando o nome de exibição está vazio', () => {
    useCurrentProfileMock.mockReturnValue({ data: { tenant_id: "t1", name: "" } });

    renderTopbar();

    expect(screen.getAllByText("Minha conta").length).toBeGreaterThan(0);
  });

  it("abre o menu do usuário e mostra o papel administrador", async () => {
    const user = userEvent.setup();
    useCurrentProfileMock.mockReturnValue({
      data: { tenant_id: "t1", name: "Maria Silva", role: "admin" },
    });

    renderTopbar();

    await user.click(screen.getByRole("button", { name: /Maria Silva/i }));

    expect(await screen.findByText("Administrador")).toBeInTheDocument();
  });

  it("abre o menu do usuário e mostra o papel atendente", async () => {
    const user = userEvent.setup();
    useCurrentProfileMock.mockReturnValue({
      data: { tenant_id: "t1", name: "Maria Silva", role: "agent" },
    });

    renderTopbar();

    await user.click(screen.getByRole("button", { name: /Maria Silva/i }));

    expect(await screen.findByText("Atendente")).toBeInTheDocument();
  });

  it("chama signOut e navega para /auth ao clicar em Sair", async () => {
    const user = userEvent.setup();
    useCurrentProfileMock.mockReturnValue({
      data: { tenant_id: "t1", name: "Maria Silva", role: "admin" },
    });

    const { queryClient } = renderTopbar();
    const cancelQueries = vi.spyOn(queryClient, "cancelQueries");
    const clear = vi.spyOn(queryClient, "clear");

    await user.click(screen.getByRole("button", { name: /Maria Silva/i }));
    await user.click(await screen.findByText("Sair"));

    await waitFor(() => expect(signOutMock).toHaveBeenCalledTimes(1));
    expect(cancelQueries).toHaveBeenCalledBefore(signOutMock);
    expect(clear).toHaveBeenCalledAfter(signOutMock);
    expect(navigateMock).toHaveBeenCalledWith({ to: "/auth", replace: true });
  });

  it("mantém a sessão e informa quando o logout falha", async () => {
    const user = userEvent.setup();
    useCurrentProfileMock.mockReturnValue({
      data: { tenant_id: "t1", name: "Maria Silva", role: "admin" },
    });
    signOutMock.mockResolvedValue({ error: new Error("rede indisponível") });

    const { queryClient } = renderTopbar();
    const clear = vi.spyOn(queryClient, "clear");

    await user.click(screen.getByRole("button", { name: /Maria Silva/i }));
    await user.click(await screen.findByText("Sair"));

    await waitFor(() => expect(signOutMock).toHaveBeenCalledTimes(1));
    expect(clear).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("alterna o tema ao clicar no botão de tema e persiste no localStorage", async () => {
    const user = userEvent.setup();
    useCurrentProfileMock.mockReturnValue({ data: { tenant_id: "t1", name: "Ana" } });

    renderTopbar();

    const toggleButton = screen.getByRole("button", { name: /Mudar para tema escuro/i });
    await user.click(toggleButton);

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("theme")).toBe("dark");
    expect(screen.getByRole("button", { name: /Mudar para tema claro/i })).toBeInTheDocument();
  });

  it.each(["profundo", "power"])(
    "desabilita o botão de tema quando a skin %s fixa o campo escuro",
    (skin) => {
      useCurrentProfileMock.mockReturnValue({ data: { tenant_id: "t1", name: "Ana" } });
      // Estado deixado pelo script pré-paint de quem já usa a skin.
      document.documentElement.setAttribute("data-skin", skin);

      renderTopbar();

      // Sob skin de campo escuro o clique só trocaria o ícone: a tela seguiria
      // escura. Botão morto é pior que botão desabilitado.
      expect(screen.getByRole("button", { name: /Mudar para tema claro/i })).toBeDisabled();
    },
  );

  it("não quebra quando localStorage lança erro ao salvar o tema", async () => {
    const user = userEvent.setup();
    useCurrentProfileMock.mockReturnValue({ data: { tenant_id: "t1", name: "Ana" } });
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("modo privado");
    });

    renderTopbar();

    const toggleButton = screen.getByRole("button", { name: /Mudar para tema escuro/i });
    await user.click(toggleButton);

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    setItemSpy.mockRestore();
  });

  it("alterna de volta para o tema claro ao clicar novamente e persiste light", async () => {
    const user = userEvent.setup();
    useCurrentProfileMock.mockReturnValue({ data: { tenant_id: "t1", name: "Ana" } });

    renderTopbar();

    const toggleButton = screen.getByRole("button", { name: /Mudar para tema escuro/i });
    await user.click(toggleButton);
    await user.click(screen.getByRole("button", { name: /Mudar para tema claro/i }));

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("theme")).toBe("light");
    expect(screen.getByRole("button", { name: /Mudar para tema escuro/i })).toBeInTheDocument();
  });

  it("mostra as iniciais corretas para um nome só com espaços em branco", () => {
    useCurrentProfileMock.mockReturnValue({ data: { tenant_id: "t1", name: "   " } });

    renderTopbar();

    expect(screen.getByText("?")).toBeInTheDocument();
  });

  it("não quebra quando a query do tenant (nome/logo) falha", async () => {
    useCurrentProfileMock.mockReturnValue({ data: { tenant_id: "t1", name: "Ana" } });
    maybeSingleMock.mockResolvedValue({ data: null, error: new Error("Falha ao buscar tenant") });

    renderTopbar();

    expect((await screen.findAllByText("Stefanello")).length).toBeGreaterThan(0);
  });

  it("mantém logoUrl nulo quando createSignedUrl não retorna signedUrl", async () => {
    useCurrentProfileMock.mockReturnValue({ data: { tenant_id: "t1", name: "Ana" } });
    maybeSingleMock.mockResolvedValue({
      data: { name: "Clínica Vida", logo_url: "logos/t1/logo.png" },
      error: null,
    });
    createSignedUrlMock.mockResolvedValue({ data: null });

    renderTopbar();

    await screen.findByText("Clínica Vida");
    expect(screen.queryByAltText("")).not.toBeInTheDocument();
  });

  it("não atualiza o logoUrl se o componente for desmontado antes da URL assinada resolver", async () => {
    useCurrentProfileMock.mockReturnValue({ data: { tenant_id: "t1", name: "Ana" } });
    maybeSingleMock.mockResolvedValue({
      data: { name: "Clínica Vida", logo_url: "logos/t1/logo.png" },
      error: null,
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let resolveSignedUrl: (value: { data: { signedUrl: string } }) => void = () => {};
    createSignedUrlMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSignedUrl = resolve;
        }),
    );

    const { unmount } = renderTopbar();
    await waitFor(() => expect(createSignedUrlMock).toHaveBeenCalled());
    unmount();
    resolveSignedUrl({ data: { signedUrl: "https://logo.example/x.png" } });
    await Promise.resolve();

    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Can't perform a React state update"),
    );
    errorSpy.mockRestore();
  });

  it("não mostra badge de notificações quando não há nada pendente", () => {
    useCurrentProfileMock.mockReturnValue({ data: { tenant_id: "t1", name: "Ana" } });

    renderTopbar();

    expect(screen.getByRole("button", { name: "Notificações" })).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("mostra a contagem total no badge do sino quando há notificações pendentes", () => {
    useCurrentProfileMock.mockReturnValue({ data: { tenant_id: "t1", name: "Ana" } });
    useDecisionQueueMock.mockReturnValue({ items: [{ id: "d1" }, { id: "d2" }] });
    useHumanAttentionCountMock.mockReturnValue(3);
    useRecentAiFailureCountMock.mockReturnValue(1);

    renderTopbar();

    expect(screen.getByRole("button", { name: "Notificações (6 pendentes)" })).toBeInTheDocument();
    expect(screen.getByText("6")).toBeInTheDocument();
  });

  it('mostra "Nenhuma notificação pendente" quando a fila está vazia', async () => {
    const user = userEvent.setup();
    useCurrentProfileMock.mockReturnValue({ data: { tenant_id: "t1", name: "Ana" } });

    renderTopbar();

    await user.click(screen.getByRole("button", { name: "Notificações" }));

    expect(await screen.findByText("Nenhuma notificação pendente")).toBeInTheDocument();
  });

  it("lista decisões pendentes, atenção da inbox e falhas de IA no popover com os links corretos", async () => {
    const user = userEvent.setup();
    useCurrentProfileMock.mockReturnValue({ data: { tenant_id: "t1", name: "Ana" } });
    useDecisionQueueMock.mockReturnValue({ items: [{ id: "d1" }] });
    useHumanAttentionCountMock.mockReturnValue(2);
    useRecentAiFailureCountMock.mockReturnValue(1);

    renderTopbar();

    await user.click(screen.getByRole("button", { name: "Notificações (4 pendentes)" }));

    const decisionsLink = (await screen.findByText("Decisões aguardando revisão")).closest("a");
    expect(decisionsLink).toHaveAttribute("href", "/decisions");

    const inboxLink = screen.getByText("Conversas aguardando humano").closest("a");
    expect(inboxLink).toHaveAttribute("href", "/inbox");

    const aiFailuresLink = screen.getByText("Falhas recentes de IA").closest("a");
    expect(aiFailuresLink).toHaveAttribute("href", "/configuracoes");
    expect(aiFailuresLink).toHaveAttribute("hash", "ia/falhas");
  });

  describe("cache do tenant compartilhado com a marca", () => {
    const linhaTenant = {
      name: "Clínica Vida",
      logo_url: null,
      business_profile: {
        brand: { primary: "#0a7f5a", primary_foreground: "#ffffff", accent_foreground: "#0a7f5a" },
      },
    };

    function MarcaProbe() {
      useApplyTenantTheme();
      const { name } = useTenantBrand();
      return <span data-testid="marca">{name ?? "sem-nome"}</span>;
    }

    afterEach(() => {
      document.getElementById("brand-theme")?.remove();
    });

    it("aplica as cores do business_profile mesmo quando o topbar busca o tenant primeiro", async () => {
      useCurrentProfileMock.mockReturnValue({ data: { tenant_id: "t1", name: "Ana" } });
      maybeSingleMock.mockImplementation(async (columns: string) => {
        const pedidas = columns.split(",").map((c) => c.trim());
        const data = Object.fromEntries(
          Object.entries(linhaTenant).filter(([coluna]) => pedidas.includes(coluna)),
        );
        return { data, error: null };
      });

      const { queryClient } = renderTopbar();
      expect(await screen.findByText("Clínica Vida")).toBeInTheDocument();

      render(
        <QueryClientProvider client={queryClient}>
          <MarcaProbe />
        </QueryClientProvider>,
      );

      expect(await screen.findByTestId("marca")).toHaveTextContent("Clínica Vida");
      await waitFor(() =>
        expect(document.getElementById("brand-theme")?.textContent ?? "").toContain("--primary:"),
      );
    });
  });
});
