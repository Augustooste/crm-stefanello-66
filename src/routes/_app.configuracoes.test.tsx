import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { useCurrentProfile } from "@/lib/api/session";
import { useCanManageDeveloper } from "@/lib/api/developer";
import { renderWithQueryClient } from "@/test/render";
import { Route } from "./_app.configuracoes";

vi.mock("@/lib/api/session", () => ({
  useCurrentProfile: vi.fn(),
}));
vi.mock("@/lib/api/developer", () => ({
  useCanManageDeveloper: vi.fn(),
}));
vi.mock("@/components/settings/developer/DeveloperTab", () => ({
  DeveloperTab: () => <div data-testid="tab-desenvolvedores" />,
}));

// useRouterState real exige RouterProvider (este arquivo renderiza
// <ConfiguracoesPage /> isolado) -- mockado pra ler `window.location.hash`,
// mesmo padrão usado em AppSidebar.test.tsx. Não usamos o evento nativo
// `hashchange` (o componente não escuta mais isso, ver comentário na rota).
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useRouterState: (opts: { select: (s: { location: { hash: string } }) => unknown }) =>
      opts.select({ location: { hash: window.location.hash } }),
  };
});

vi.mock("@/components/settings/AppearanceTab", () => ({
  AppearanceTab: () => <div data-testid="tab-aparencia" />,
}));
// Stub com input de verdade: o achado é sobre perder a digitação ao trocar de
// aba. Um input não-controlado perde o valor no remount exatamente como o
// `useState` do CompanyTab real, então este stub reproduz o bug sem arrastar
// Supabase para o teste da rota.
vi.mock("@/components/settings/CompanyTab", () => ({
  CompanyTab: () => (
    <div data-testid="tab-empresa">
      <input aria-label="Nome da empresa" defaultValue="" />
    </div>
  ),
}));
vi.mock("@/components/settings/BusinessProfileTab", () => ({
  BusinessProfileTab: () => (
    <div data-testid="tab-perfil">
      <input aria-label="Segmento" defaultValue="" />
    </div>
  ),
}));
vi.mock("@/components/settings/StagesTab", () => ({
  StagesTab: () => <div data-testid="tab-funil" />,
}));
vi.mock("@/components/settings/TagsTab", () => ({
  TagsTab: () => <div data-testid="tab-tags" />,
}));
vi.mock("@/components/settings/TeamTab", () => ({
  TeamTab: () => <div data-testid="tab-equipe" />,
}));
vi.mock("@/components/settings/PhoneSuppressionsTab", () => ({
  PhoneSuppressionsTab: () => <div data-testid="tab-supressoes" />,
}));
vi.mock("@/components/settings/PluginsTab", () => ({
  PluginsTab: () => <div data-testid="tab-plugins" />,
}));
vi.mock("@/components/settings/NotificationsTab", () => ({
  NotificationsTab: () => <div data-testid="tab-notificacoes" />,
}));
vi.mock("@/components/settings/AiSettingsTab", () => ({
  AiSettingsTab: () => <div data-testid="tab-ia" />,
}));

const ConfiguracoesPage = Route.options.component!;

function mockDeveloper(allowed: boolean, isLoading = false) {
  vi.mocked(useCanManageDeveloper).mockReturnValue({ allowed, isLoading });
}

beforeEach(() => {
  mockDeveloper(false);
});

function mockProfile(profile: { role: "admin" | "agent" } | null, isLoading = false) {
  vi.mocked(useCurrentProfile).mockReturnValue({
    data: profile,
    isLoading,
  } as ReturnType<typeof useCurrentProfile>);
}

describe("head() da rota de configurações", () => {
  it("define título e descrição de SEO", async () => {
    const head = await Route.options.head?.({} as never);
    const titleMeta = head?.meta?.find((m) => m && "title" in m);
    expect(titleMeta).toMatchObject({ title: "Configurações" });
    const descriptionMeta = head?.meta?.find((m) => m && "name" in m && m.name === "description");
    expect(descriptionMeta).toMatchObject({
      content: "Preferências da conta, da empresa e do time no CRM IA.",
    });
    expect(head?.links?.some((l) => l && "rel" in l && l.rel === "canonical")).toBe(true);
  });
});

describe("página de configurações (/_app/configuracoes)", () => {
  it("mostra skeleton enquanto o perfil carrega", () => {
    mockProfile(null, true);
    renderWithQueryClient(<ConfiguracoesPage />);
    expect(screen.getByText("Configurações")).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("para quem não é admin, mostra Aparência e Notificações (sem abas de workspace)", () => {
    mockProfile({ role: "agent" });
    renderWithQueryClient(<ConfiguracoesPage />);
    expect(screen.getByRole("tab", { name: "Aparência" })).toBeInTheDocument();
    expect(screen.getByTestId("tab-aparencia")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Notificações" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Empresa" })).not.toBeInTheDocument();
  });

  it("para quem não é admin, mostra o conteúdo da aba Notificações ao clicar", async () => {
    mockProfile({ role: "agent" });
    const user = userEvent.setup();
    renderWithQueryClient(<ConfiguracoesPage />);

    await user.click(screen.getByRole("tab", { name: "Notificações" }));
    expect(await screen.findByTestId("tab-notificacoes")).toBeInTheDocument();
  });

  it("mostra Aparência + as abas de workspace e o conteúdo padrão para administradores", async () => {
    mockProfile({ role: "admin" });
    const user = userEvent.setup();
    renderWithQueryClient(<ConfiguracoesPage />);

    expect(screen.getByRole("tab", { name: "Aparência" })).toBeInTheDocument();
    expect(screen.getByTestId("tab-aparencia")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Empresa" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Notificações" }));
    expect(await screen.findByTestId("tab-notificacoes")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Equipe" }));
    expect(await screen.findByTestId("tab-equipe")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "IA" }));
    expect(await screen.findByTestId("tab-ia")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Integrações e Plugins" }));
    expect(await screen.findByTestId("tab-plugins")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Supressões" }));
    expect(await screen.findByTestId("tab-supressoes")).toBeInTheDocument();
  });

  it("mantém o texto digitado na aba Empresa ao sair para outra aba e voltar", async () => {
    mockProfile({ role: "admin" });
    const user = userEvent.setup();
    renderWithQueryClient(<ConfiguracoesPage />);

    await user.click(screen.getByRole("tab", { name: "Empresa" }));
    await user.type(screen.getByLabelText("Nome da empresa"), "Acme Ltda");
    expect(screen.getByLabelText("Nome da empresa")).toHaveValue("Acme Ltda");

    await user.click(screen.getByRole("tab", { name: "Aparência" }));
    await user.click(screen.getByRole("tab", { name: "Empresa" }));

    expect(screen.getByLabelText("Nome da empresa")).toHaveValue("Acme Ltda");
  });

  it("mantém o texto digitado na aba Perfil do negócio ao sair para outra aba e voltar", async () => {
    mockProfile({ role: "admin" });
    const user = userEvent.setup();
    renderWithQueryClient(<ConfiguracoesPage />);

    await user.click(screen.getByRole("tab", { name: "Perfil do negócio" }));
    await user.type(screen.getByLabelText("Segmento"), "Clínica odontológica");

    await user.click(screen.getByRole("tab", { name: "Aparência" }));
    await user.click(screen.getByRole("tab", { name: "Perfil do negócio" }));

    expect(screen.getByLabelText("Segmento")).toHaveValue("Clínica odontológica");
  });

  it("esconde por display:none o painel montado à força quando a aba não está ativa", () => {
    mockProfile({ role: "admin" });
    renderWithQueryClient(<ConfiguracoesPage />);

    // Com `forceMount` o Radix passa `hidden={false}` (ele só usa o atributo
    // quando o conteúdo NÃO está montado), então esconder é responsabilidade
    // da classe. Sem ela o formulário de Empresa aparece embaixo de Aparência
    // e ainda entra na ordem de tabulação (o Content tem tabIndex={0}).
    for (const testId of ["tab-empresa", "tab-perfil"]) {
      const painel = screen.getByTestId(testId).closest('[role="tabpanel"]');
      expect(painel).toHaveAttribute("data-state", "inactive");
      expect(painel).toHaveClass("data-[state=inactive]:hidden");
    }
  });

  it("para quem não é admin, não mostra a aba IA (Assistente, Features e Falhas consolidados)", () => {
    mockProfile({ role: "agent" });
    renderWithQueryClient(<ConfiguracoesPage />);
    expect(screen.queryByRole("tab", { name: "IA" })).not.toBeInTheDocument();
  });

  it("para quem não é admin, não mostra a aba Integrações e Plugins", () => {
    mockProfile({ role: "agent" });
    renderWithQueryClient(<ConfiguracoesPage />);
    expect(screen.queryByRole("tab", { name: "Integrações e Plugins" })).not.toBeInTheDocument();
  });

  it("para quem não é admin, não mostra a aba Supressões", () => {
    mockProfile({ role: "agent" });
    renderWithQueryClient(<ConfiguracoesPage />);
    expect(screen.queryByRole("tab", { name: "Supressões" })).not.toBeInTheDocument();
  });
});

describe("deep-link de aba via hash da URL (ex.: atalho 'Editar persona' em /assistente)", () => {
  afterEach(() => {
    window.location.hash = "";
  });

  it("abre direto na aba IA quando o hash é #ia e o usuário é admin", async () => {
    window.location.hash = "#ia";
    mockProfile({ role: "admin" });
    renderWithQueryClient(<ConfiguracoesPage />);

    expect(await screen.findByTestId("tab-ia")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "IA" })).toHaveAttribute("aria-selected", "true");
  });

  it("abre a aba IA para hashes legados #assistente / #falhas-ia", async () => {
    for (const legacy of ["#assistente", "#falhas-ia"]) {
      window.location.hash = legacy;
      mockProfile({ role: "admin" });
      const { unmount } = renderWithQueryClient(<ConfiguracoesPage />);

      expect(await screen.findByTestId("tab-ia")).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "IA" })).toHaveAttribute("aria-selected", "true");
      unmount();
    }
  });

  it("abre a aba IA para sub-hash #ia/falhas (deep-link para sub-aba)", async () => {
    window.location.hash = "#ia/falhas";
    mockProfile({ role: "admin" });
    renderWithQueryClient(<ConfiguracoesPage />);

    expect(await screen.findByTestId("tab-ia")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "IA" })).toHaveAttribute("aria-selected", "true");
  });

  it("ignora hash de aba admin quando o usuário não é admin (mantém Aparência)", async () => {
    window.location.hash = "#ia";
    mockProfile({ role: "agent" });
    renderWithQueryClient(<ConfiguracoesPage />);

    expect(screen.getByTestId("tab-aparencia")).toBeInTheDocument();
    expect(screen.queryByTestId("tab-ia")).not.toBeInTheDocument();
  });

  it("ignora hash inválido/desconhecido e mantém Aparência como padrão", async () => {
    window.location.hash = "#nao-existe";
    mockProfile({ role: "admin" });
    renderWithQueryClient(<ConfiguracoesPage />);

    expect(screen.getByTestId("tab-aparencia")).toBeInTheDocument();
    expect(screen.queryByTestId("tab-ia")).not.toBeInTheDocument();
  });

  it("sem hash, mantém Aparência como padrão", () => {
    mockProfile({ role: "admin" });
    renderWithQueryClient(<ConfiguracoesPage />);

    expect(screen.getByTestId("tab-aparencia")).toBeInTheDocument();
  });

  it("troca de aba quando o hash muda DEPOIS do mount (link entre abas irmãs, ex.: 'falhas recentes' no Assistente IA apontando pra #ia/falhas)", async () => {
    mockProfile({ role: "admin" });
    const { rerender } = renderWithQueryClient(<ConfiguracoesPage />);

    expect(screen.getByTestId("tab-aparencia")).toBeInTheDocument();

    // Simula a navegação via <Link>/router (não dispara `hashchange` nativo
    // -- por isso o componente usa `useRouterState`, não o evento de
    // browser). Um rerender aqui equivale ao router propagar o novo estado
    // de location pra quem usa `useRouterState`.
    window.location.hash = "#ia/falhas";
    rerender(<ConfiguracoesPage />);

    expect(await screen.findByTestId("tab-ia")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "IA" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("aba Desenvolvedores (permissão developer.manage)", () => {
  afterEach(() => {
    window.location.hash = "";
  });

  it("aparece ao lado de Integrações e Plugins para quem tem a permissão", async () => {
    mockProfile({ role: "admin" });
    mockDeveloper(true);
    const user = userEvent.setup();
    renderWithQueryClient(<ConfiguracoesPage />);

    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs.indexOf("Desenvolvedores")).toBe(tabs.indexOf("Integrações e Plugins") + 1);
    await user.click(screen.getByRole("tab", { name: "Desenvolvedores" }));
    expect(await screen.findByTestId("tab-desenvolvedores")).toBeInTheDocument();
  });

  it("some para quem não tem a permissão, mesmo sendo admin", () => {
    mockProfile({ role: "admin" });
    mockDeveloper(false);
    renderWithQueryClient(<ConfiguracoesPage />);
    expect(screen.queryByRole("tab", { name: "Desenvolvedores" })).not.toBeInTheDocument();
  });

  it("aparece para quem tem a permissão sem ser admin", () => {
    mockProfile({ role: "agent" });
    mockDeveloper(true);
    renderWithQueryClient(<ConfiguracoesPage />);
    expect(screen.getByRole("tab", { name: "Desenvolvedores" })).toBeInTheDocument();
  });

  it("não aparece nem leva o hash enquanto a permissão carrega", () => {
    window.location.hash = "#desenvolvedores";
    mockProfile({ role: "admin" });
    mockDeveloper(false, true);
    renderWithQueryClient(<ConfiguracoesPage />);
    expect(screen.queryByRole("tab", { name: "Desenvolvedores" })).not.toBeInTheDocument();
    expect(screen.getByTestId("tab-aparencia")).toBeInTheDocument();
  });

  it("#desenvolvedores abre a aba para quem tem a permissão", async () => {
    window.location.hash = "#desenvolvedores";
    mockProfile({ role: "admin" });
    mockDeveloper(true);
    renderWithQueryClient(<ConfiguracoesPage />);

    expect(await screen.findByTestId("tab-desenvolvedores")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Desenvolvedores" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("#desenvolvedores cai na aba padrão para quem não tem a permissão", () => {
    window.location.hash = "#desenvolvedores";
    mockProfile({ role: "admin" });
    mockDeveloper(false);
    renderWithQueryClient(<ConfiguracoesPage />);
    expect(screen.getByTestId("tab-aparencia")).toBeInTheDocument();
    expect(screen.queryByTestId("tab-desenvolvedores")).not.toBeInTheDocument();
  });
});
