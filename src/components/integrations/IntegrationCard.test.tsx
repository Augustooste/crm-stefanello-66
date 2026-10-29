import { useState, type ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  ConnectDialog,
  IntegrationCard,
  iconFor,
  statusLabel,
  statusVariant,
  normalizeSetupSteps,
  useIntegrationsCatalog,
  useVisibleIntegrationsCatalog,
  type CatalogRow,
} from "./IntegrationCard";
import { friendlyIntegrationError } from "@/lib/integrations/friendly-errors";
import type { ChannelRow, IntegrationStatus, TenantIntegrationRow } from "@/lib/api/integrations";
import type { WizardDef } from "@/lib/integrations/wizards/registry";

const fromMock = vi.fn();
const invokeMock = vi.fn();
const useTenantIntegrationsMock = vi.fn();
const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
const writeTextMock = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (...args: unknown[]) => fromMock(...args),
    functions: {
      invoke: (...args: unknown[]) => invokeMock(...args),
    },
  },
}));

// Estes testes cobrem o formulário plano (legado / modo edit). O wizard
// passo-a-passo tem cobertura dedicada em IntegrationWizardDialog.test.tsx.
// O default é "sem wizard"; testes que precisam do contrário sobrescrevem o
// mock (o SetupView consulta o registry para decidir se repete os setup_steps).
const getWizardMock = vi.fn<(slug: string) => WizardDef | null>(() => null);
vi.mock("@/lib/integrations/wizards/registry", () => ({
  getWizard: (slug: string) => getWizardMock(slug),
}));

// useCurrentProfile é usado só para limpar rascunho após sucesso — no legado
// não há rascunho para limpar, então basta um mock inerte.
vi.mock("@/lib/api/session", () => ({
  useCurrentProfile: () => ({ data: null }),
}));

vi.mock("@/lib/api/integrations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/integrations")>();
  return {
    ...actual,
    useTenantIntegrations: () => useTenantIntegrationsMock(),
  };
});

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

type CatalogQueryResult = { data: unknown; error: unknown };

type CatalogBuilder = {
  select: (...args: unknown[]) => CatalogBuilder;
  order: (...args: unknown[]) => CatalogBuilder;
  then: <TResult1 = CatalogQueryResult, TResult2 = never>(
    onfulfilled?: ((value: CatalogQueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) => Promise<TResult1 | TResult2>;
};

function createCatalogBuilder(result: CatalogQueryResult): CatalogBuilder {
  const builder: CatalogBuilder = {
    select: vi.fn(() => builder),
    order: vi.fn(() => builder),
    then: (onfulfilled, onrejected) => Promise.resolve(result).then(onfulfilled, onrejected),
  };
  return builder;
}

function renderWithClient(ui: ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // `qc` volta junto para os testes que precisam espionar as invalidações de cache.
  return {
    queryClient: qc,
    ...render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>),
  };
}

const baseCatalog: CatalogRow = {
  slug: "resend",
  name: "Resend",
  description: "Envio de e-mails transacionais",
  icon: null,
  available: true,
  required_secrets: [
    { key: "api_key", label: "API Key", help: "Encontre no painel Resend", type: "password" },
  ],
  setup_steps: [
    { title: "Passo 1", body: "Configure o DNS" },
    { title: "Passo 2", body: "Valide o domínio" },
  ],
};

const baseTenant: TenantIntegrationRow = {
  slug: "resend",
  status: "disabled",
  config: null,
  connected_at: null,
  last_check_at: null,
  last_error: null,
  webhook_token: null,
};

const baseChannel: ChannelRow = {
  id: "ch-1",
  provider_slug: "resend",
  status: "connected",
  config: null,
  webhook_token: null,
  qr_code: null,
  webhook_health: "unknown",
  last_connected_at: null,
  status_message: null,
};

function findIconButton(container: HTMLElement, iconClass: string): HTMLButtonElement {
  const svg = container.querySelector(`svg.${iconClass}`);
  if (!svg) throw new Error(`ícone ${iconClass} não encontrado`);
  const button = svg.closest("button");
  if (!button) throw new Error("botão não encontrado para o ícone");
  return button as HTMLButtonElement;
}

beforeEach(() => {
  fromMock.mockReset();
  invokeMock.mockReset();
  useTenantIntegrationsMock.mockReset();
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();
  writeTextMock.mockReset();
  getWizardMock.mockReset();
  getWizardMock.mockReturnValue(null);

  useTenantIntegrationsMock.mockReturnValue({ data: [] });
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: writeTextMock },
    configurable: true,
  });
});

describe("iconFor", () => {
  it("usa o ícone mapeado quando `icon` é uma chave válida", () => {
    const { container } = render(<>{iconFor("qualquer-slug", "whatsapp")}</>);
    expect(container.querySelector("svg.lucide-message-circle")).toBeInTheDocument();
  });

  it("mapeia icon=mail", () => {
    const { container } = render(<>{iconFor("qualquer-slug", "mail")}</>);
    expect(container.querySelector("svg.lucide-mail")).toBeInTheDocument();
  });

  it("mapeia icon=phone", () => {
    const { container } = render(<>{iconFor("qualquer-slug", "phone")}</>);
    expect(container.querySelector("svg.lucide-phone")).toBeInTheDocument();
  });

  it("mapeia icon=megaphone", () => {
    const { container } = render(<>{iconFor("qualquer-slug", "megaphone")}</>);
    expect(container.querySelector("svg.lucide-megaphone")).toBeInTheDocument();
  });

  it("mapeia icon=voice", () => {
    const { container } = render(<>{iconFor("qualquer-slug", "voice")}</>);
    expect(container.querySelector("svg.lucide-audio-lines")).toBeInTheDocument();
  });

  it("mapeia icon=sparkles", () => {
    const { container } = render(<>{iconFor("qualquer-slug", "sparkles")}</>);
    expect(container.querySelector("svg.lucide-sparkles")).toBeInTheDocument();
  });

  it("cai no fallback por slug=resend quando icon é inválido", () => {
    const { container } = render(<>{iconFor("resend", "invalido")}</>);
    expect(container.querySelector("svg.lucide-mail")).toBeInTheDocument();
  });

  it("cai no fallback por slug=twilio quando icon é null", () => {
    const { container } = render(<>{iconFor("twilio", null)}</>);
    expect(container.querySelector("svg.lucide-phone")).toBeInTheDocument();
  });

  it("cai no fallback por slug=zapi quando icon é null", () => {
    const { container } = render(<>{iconFor("zapi", null)}</>);
    expect(container.querySelector("svg.lucide-message-circle")).toBeInTheDocument();
  });

  it("cai no fallback por slug=meta-ads quando icon é null", () => {
    const { container } = render(<>{iconFor("meta-ads", null)}</>);
    expect(container.querySelector("svg.lucide-megaphone")).toBeInTheDocument();
  });

  it("cai no fallback por slug=elevenlabs quando icon é null", () => {
    const { container } = render(<>{iconFor("elevenlabs", null)}</>);
    expect(container.querySelector("svg.lucide-audio-lines")).toBeInTheDocument();
  });

  it("usa o ícone padrão MessageCircle quando slug é desconhecido e icon é null", () => {
    const { container } = render(<>{iconFor("slug-desconhecido", null)}</>);
    expect(container.querySelector("svg.lucide-message-circle")).toBeInTheDocument();
  });
});

describe("statusVariant", () => {
  it.each<[IntegrationStatus, string]>([
    ["active", "success"],
    ["error", "destructive"],
    ["pending", "warning"],
    ["disabled", "neutral"],
  ])("retorna %s -> %s", (status, expected) => {
    expect(statusVariant(status)).toBe(expected);
  });
});

describe("statusLabel", () => {
  it.each<[IntegrationStatus, string]>([
    ["active", "Ativo"],
    ["error", "Erro"],
    ["pending", "Pendente"],
    ["disabled", "Desconectado"],
  ])("retorna %s -> %s", (status, expected) => {
    expect(statusLabel(status)).toBe(expected);
  });
});

describe("useIntegrationsCatalog", () => {
  it("busca e retorna o catálogo de integrações", async () => {
    // slug visível de propósito: `baseCatalog` usa `resend`, que está em
    // HIDDEN_CATALOG_SLUGS — some no hook de descoberta, não neste.
    const rows = [{ ...baseCatalog, slug: "zapi" }];
    fromMock.mockReturnValue(createCatalogBuilder({ data: rows, error: null }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useIntegrationsCatalog(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(rows);
    expect(fromMock).toHaveBeenCalledWith("integrations");
  });

  it("oculta os slugs escondidos mesmo vindo do banco, e preserva os visíveis", async () => {
    // `zapi` é o controle positivo: se o filtro passasse a derrubar tudo, este
    // teste falharia junto — sem ele, a asserção sobreviveria a um filtro quebrado.
    const rows = [
      { ...baseCatalog, slug: "zapi" },
      { ...baseCatalog, slug: "feegow" },
      { ...baseCatalog, slug: "doutore" },
      { ...baseCatalog, slug: "meta-ads" },
      { ...baseCatalog, slug: "twilio" },
      { ...baseCatalog, slug: "resend" },
      // `evolution` é o 2º controle positivo: voltou a ser oferecido no
      // catálogo (WhatsApp via Evolution Go) e não pode ser filtrado.
      { ...baseCatalog, slug: "evolution" },
    ];
    fromMock.mockReturnValue(createCatalogBuilder({ data: rows, error: null }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useVisibleIntegrationsCatalog(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((r) => r.slug)).toEqual(["zapi", "evolution"]);
  });

  // Regressão: o filtro morava dentro do queryFn, então TODO consumidor recebia o
  // catálogo podado — inclusive IntegrationStatusTable, única superfície que mostra
  // `tenant_integrations.status`, `last_error` e "Testar conexão". Com `resend`
  // conectado e ativo em produção, ocultá-lo apagou a tela de diagnóstico dele: o
  // canal seguia rodando e podia quebrar sem deixar rastro na UI. Este teste falha
  // se alguém devolver o filtro para o hook de monitoramento.
  it("NÃO filtra os slugs ocultos — monitoramento precisa enxergar canal já conectado", async () => {
    const rows = [
      { ...baseCatalog, slug: "zapi" },
      { ...baseCatalog, slug: "resend" },
      { ...baseCatalog, slug: "evolution" },
    ];
    fromMock.mockReturnValue(createCatalogBuilder({ data: rows, error: null }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useIntegrationsCatalog(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((r) => r.slug)).toEqual(["zapi", "resend", "evolution"]);
  });

  it("retorna array vazio quando data é null", async () => {
    fromMock.mockReturnValue(createCatalogBuilder({ data: null, error: null }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useIntegrationsCatalog(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });

  it("propaga o erro quando a query falha", async () => {
    fromMock.mockReturnValue(createCatalogBuilder({ data: null, error: new Error("boom") }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useIntegrationsCatalog(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("IntegrationCard", () => {
  it("renderiza nome e descrição do catálogo", () => {
    renderWithClient(<IntegrationCard catalog={baseCatalog} tenant={null} />);

    expect(screen.getByText("Resend")).toBeInTheDocument();
    expect(screen.getByText("Envio de e-mails transacionais")).toBeInTheDocument();
  });

  it('mostra badge "Em breve" e botão desabilitado quando a integração não está disponível', () => {
    renderWithClient(
      <IntegrationCard catalog={{ ...baseCatalog, available: false }} tenant={null} />,
    );

    expect(screen.getByText("Em breve")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Conectar" })).toBeDisabled();
  });

  it('mostra badge "Desconectado" quando não há tenant conectado', () => {
    renderWithClient(<IntegrationCard catalog={baseCatalog} tenant={null} />);

    expect(screen.getByText("Desconectado")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Conectar" })).toBeEnabled();
  });

  it('mostra badge "Ativo" e botão "Gerenciar" quando o status é active', () => {
    renderWithClient(
      <IntegrationCard catalog={baseCatalog} tenant={{ ...baseTenant, status: "active" }} />,
    );

    expect(screen.getByText("Ativo")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gerenciar" })).toBeInTheDocument();
  });

  it('mostra badge "Pendente" quando o status é pending', () => {
    renderWithClient(
      <IntegrationCard catalog={baseCatalog} tenant={{ ...baseTenant, status: "pending" }} />,
    );

    expect(screen.getByText("Pendente")).toBeInTheDocument();
  });

  it('mostra badge "Erro" e a mensagem de last_error quando o status é error', () => {
    renderWithClient(
      <IntegrationCard
        catalog={baseCatalog}
        tenant={{ ...baseTenant, status: "error", last_error: "Falha de autenticação" }}
      />,
    );

    expect(screen.getByText("Erro")).toBeInTheDocument();
    expect(screen.getByText("Falha de autenticação")).toBeInTheDocument();
  });

  it("não mostra mensagem de erro quando status é error mas não há last_error", () => {
    renderWithClient(
      <IntegrationCard
        catalog={baseCatalog}
        tenant={{ ...baseTenant, status: "error", last_error: null }}
      />,
    );

    expect(screen.getByText("Erro")).toBeInTheDocument();
    expect(screen.queryByText("Falha de autenticação")).not.toBeInTheDocument();
  });

  it("abre o ConnectDialog ao clicar no botão (status não-ativo)", async () => {
    const user = userEvent.setup();
    renderWithClient(<IntegrationCard catalog={baseCatalog} tenant={null} />);

    await user.click(screen.getByRole("button", { name: "Conectar" }));

    expect(await screen.findByText("Conectar Resend")).toBeInTheDocument();
  });

  it("abre o ConnectDialog em modo Gerenciar ao clicar no botão (status ativo)", async () => {
    const user = userEvent.setup();
    renderWithClient(
      <IntegrationCard catalog={baseCatalog} tenant={{ ...baseTenant, status: "active" }} />,
    );

    await user.click(screen.getByRole("button", { name: "Gerenciar" }));

    expect(await screen.findByText("Gerenciar Resend")).toBeInTheDocument();
  });

  it("abre o ConnectDialog quando recebe solicitação externa de abertura", async () => {
    const onOpenRequestHandled = vi.fn();
    renderWithClient(
      <IntegrationCard
        catalog={baseCatalog}
        tenant={null}
        openRequested
        onOpenRequestHandled={onOpenRequestHandled}
      />,
    );

    expect(await screen.findByText("Conectar Resend")).toBeInTheDocument();
    expect(onOpenRequestHandled).toHaveBeenCalledTimes(1);
  });

  describe("saúde do webhook por canal (Fase 5)", () => {
    it("não mostra o bloco de saúde quando não há canal", () => {
      renderWithClient(<IntegrationCard catalog={baseCatalog} tenant={null} channel={null} />);

      expect(screen.queryByTestId("webhook-health-badge")).not.toBeInTheDocument();
    });

    it.each<[ChannelRow["webhook_health"], string]>([
      ["ok", "Webhook ok"],
      // `broken` = "recebia e parou dentro da janela (72h)". Rótulo neutro de
      // propósito: em conta de baixo volume isso é silêncio, não falha — os
      // canais de produção nesse estado tinham 0 falhas consecutivas.
      ["broken", "Sem mensagens recentes"],
      ["silent", "Nunca recebeu mensagem"],
      ["unknown", "Aguardando 1ª mensagem"],
    ])("mostra o badge correto para webhook_health=%s", (health, label) => {
      renderWithClient(
        <IntegrationCard
          catalog={baseCatalog}
          tenant={null}
          channel={{ ...baseChannel, webhook_health: health }}
        />,
      );

      expect(screen.getByTestId("webhook-health-badge")).toHaveTextContent(label);
    });

    it("mostra 'Webhook falhou' em vermelho quando o canal está em erro", () => {
      renderWithClient(
        <IntegrationCard
          catalog={baseCatalog}
          tenant={null}
          channel={{ ...baseChannel, status: "error", webhook_health: "ok" }}
        />,
      );

      const badge = screen.getByTestId("webhook-health-badge");
      expect(badge).toHaveTextContent("Webhook falhou");
      expect(badge.getAttribute("data-channel-state")).toBe("failed");
      expect(screen.getByTestId("webhook-health-hint")).toHaveClass("text-destructive");
    });

    it("mostra 'Pausado manualmente' quando o canal está desabilitado", () => {
      renderWithClient(
        <IntegrationCard
          catalog={baseCatalog}
          tenant={null}
          channel={{ ...baseChannel, status: "disabled", webhook_health: "broken" }}
        />,
      );

      const badge = screen.getByTestId("webhook-health-badge");
      expect(badge).toHaveTextContent("Pausado manualmente");
      expect(badge.getAttribute("data-channel-state")).toBe("paused");
    });

    it("explica o silêncio de 72h sem tratar como falha", () => {
      renderWithClient(
        <IntegrationCard
          catalog={baseCatalog}
          tenant={null}
          channel={{ ...baseChannel, status: "connected", webhook_health: "broken" }}
        />,
      );

      expect(screen.getByTestId("webhook-health-badge")).toHaveTextContent(
        "Sem mensagens recentes",
      );
      expect(screen.getByTestId("webhook-health-hint")).toHaveTextContent(/72 horas/);
      expect(screen.getByTestId("webhook-health-hint")).not.toHaveClass("text-destructive");
    });

    it("mostra o tempo relativo de conexão quando last_connected_at existe", () => {
      renderWithClient(
        <IntegrationCard
          catalog={baseCatalog}
          tenant={null}
          channel={{ ...baseChannel, last_connected_at: new Date().toISOString() }}
        />,
      );

      expect(screen.getByTestId("webhook-health-badge").textContent).toMatch(/última conexão há/i);
    });

    it("mostra status_message quando presente", () => {
      renderWithClient(
        <IntegrationCard
          catalog={baseCatalog}
          tenant={null}
          channel={{ ...baseChannel, status_message: "Reconexão pendente" }}
        />,
      );

      expect(screen.getByText(/Reconexão pendente/)).toBeInTheDocument();
    });

    it("traduz status_message em inglês em vez de jogar na tela", () => {
      renderWithClient(
        <IntegrationCard
          catalog={baseCatalog}
          tenant={null}
          channel={{
            ...baseChannel,
            // String real do Deno quando o deadline do fetch estoura.
            status_message: "The operation was aborted due to timeout",
          }}
        />,
      );

      expect(screen.queryByText(/aborted due to timeout/i)).not.toBeInTheDocument();
      expect(
        screen.getByText(friendlyIntegrationError(baseCatalog.slug, "timeout").message),
      ).toBeInTheDocument();
    });
  });
});

describe("ConnectDialog", () => {
  function renderDialog(props: {
    catalog?: CatalogRow;
    tenant?: TenantIntegrationRow | null;
    channel?: ChannelRow | null;
    onOpenChange?: (v: boolean) => void;
  }) {
    const onOpenChange = props.onOpenChange ?? vi.fn();
    const utils = renderWithClient(
      <ConnectDialog
        open
        onOpenChange={onOpenChange}
        catalog={props.catalog ?? baseCatalog}
        tenant={props.tenant ?? null}
        channel={props.channel ?? null}
      />,
    );
    return { onOpenChange, ...utils };
  }

  describe("passo form", () => {
    it("renderiza um input por campo obrigatório com label, tipo e texto de ajuda", () => {
      renderDialog({});

      const input = screen.getByLabelText("API Key");
      expect(input).toHaveAttribute("type", "password");
      expect(screen.getByText("Encontre no painel Resend")).toBeInTheDocument();
    });

    it("renderiza input tipo text quando o campo não especifica password", () => {
      const catalog: CatalogRow = {
        ...baseCatalog,
        required_secrets: [{ key: "from_email", label: "E-mail remetente", help: "ajuda" }],
      };
      renderDialog({ catalog });

      expect(screen.getByLabelText("E-mail remetente")).toHaveAttribute("type", "text");
    });

    it("não renderiza nenhum campo quando required_secrets é null", async () => {
      const catalog: CatalogRow = { ...baseCatalog, required_secrets: null };
      renderDialog({ catalog });

      await screen.findByText("Conectar Resend");
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      expect(
        screen.getByText(
          "Suas chaves ficam guardadas com segurança e nunca aparecem no navegador.",
        ),
      ).toBeInTheDocument();
    });

    it("submete e chama supabase.functions.invoke com action connect e os valores preenchidos", async () => {
      invokeMock.mockResolvedValue({ data: { ok: true }, error: null });
      const user = userEvent.setup();
      renderDialog({});

      await user.type(screen.getByLabelText("API Key"), "segredo-123");
      await user.click(screen.getByRole("button", { name: "Testar e conectar" }));

      await waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith("integration-connect", {
          body: { action: "connect", slug: "resend", values: { api_key: "segredo-123" } },
        }),
      );
    });

    it("sucesso: mostra toast e muda a descrição para o passo setup", async () => {
      invokeMock.mockResolvedValue({ data: { ok: true }, error: null });
      const user = userEvent.setup();
      renderDialog({});

      await user.type(screen.getByLabelText("API Key"), "segredo-123");
      await user.click(screen.getByRole("button", { name: "Testar e conectar" }));

      await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("Resend conectado."));
      expect(
        await screen.findByText(
          "Integração ativa. Copie a URL de webhook e siga os passos abaixo no painel do provedor.",
        ),
      ).toBeInTheDocument();
    });

    it("sucesso: invalida também o cache dos canais, não só o das integrações", async () => {
      // Regressão: invalidar só ["tenant-integrations"] deixava `useTenantChannels`
      // (["tenant-channels", tenantId]) servindo o canal velho pelo staleTime de 60s
      // do router — o checklist acusava "Instância desconectada" e o painel de
      // diagnóstico sumia no exato instante em que a conexão deu certo.
      invokeMock.mockResolvedValue({ data: { ok: true }, error: null });
      const user = userEvent.setup();
      const { queryClient } = renderDialog({});
      const invalidate = vi.spyOn(queryClient, "invalidateQueries");

      await user.type(screen.getByLabelText("API Key"), "segredo-123");
      await user.click(screen.getByRole("button", { name: "Testar e conectar" }));

      await waitFor(() =>
        expect(invalidate).toHaveBeenCalledWith({ queryKey: ["tenant-channels"] }),
      );
      // Controle positivo: a chave original continua sendo invalidada.
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["tenant-integrations"] });
    });

    it("erro (invoke retorna error): mostra a mensagem de erro no form", async () => {
      invokeMock.mockResolvedValue({ data: null, error: new Error("falha de conexão") });
      const user = userEvent.setup();
      renderDialog({});

      await user.type(screen.getByLabelText("API Key"), "segredo-123");
      await user.click(screen.getByRole("button", { name: "Testar e conectar" }));

      expect(await screen.findByText("falha de conexão")).toBeInTheDocument();
    });

    it("erro (data.ok false): mostra data.error como mensagem", async () => {
      invokeMock.mockResolvedValue({
        data: { ok: false, error: "Credenciais inválidas" },
        error: null,
      });
      const user = userEvent.setup();
      renderDialog({});

      await user.type(screen.getByLabelText("API Key"), "segredo-123");
      await user.click(screen.getByRole("button", { name: "Testar e conectar" }));

      expect(await screen.findByText("Credenciais inválidas")).toBeInTheDocument();
    });

    it("erro (data.ok false sem mensagem): usa mensagem padrão", async () => {
      invokeMock.mockResolvedValue({ data: { ok: false }, error: null });
      const user = userEvent.setup();
      renderDialog({});

      await user.type(screen.getByLabelText("API Key"), "segredo-123");
      await user.click(screen.getByRole("button", { name: "Testar e conectar" }));

      expect(await screen.findByText("Não foi possível conectar.")).toBeInTheDocument();
    });

    it("mostra o spinner de carregamento enquanto o connect está pendente", async () => {
      let resolveInvoke: (value: { data: { ok: boolean }; error: null }) => void = () => {};
      invokeMock.mockReturnValue(
        new Promise((resolve) => {
          resolveInvoke = resolve;
        }),
      );
      const user = userEvent.setup();
      renderDialog({});

      await user.type(screen.getByLabelText("API Key"), "segredo-123");
      await user.click(screen.getByRole("button", { name: "Testar e conectar" }));

      expect(document.body.querySelector("svg.lucide-loader-circle")).toBeInTheDocument();

      resolveInvoke({ data: { ok: true }, error: null });
      await waitFor(() => expect(toastSuccessMock).toHaveBeenCalled());
    });

    it("placeholder de senha mostra 'configurado' quando isActive e o campo está vazio, e some ao digitar", async () => {
      const user = userEvent.setup();
      renderDialog({ tenant: { ...baseTenant, status: "active" } });

      // isActive => abre direto no passo setup; volta para form via "Atualizar credenciais"
      await user.click(screen.getByRole("button", { name: "Atualizar credenciais" }));

      const input = await screen.findByLabelText("API Key");
      expect(input).toHaveAttribute("placeholder", "•••• configurado");

      await user.type(input, "x");
      expect(input).not.toHaveAttribute("placeholder");
    });

    it('botão "Cancelar" só existe quando isActive e volta para o passo setup sem submeter', async () => {
      const user = userEvent.setup();
      renderDialog({ tenant: { ...baseTenant, status: "active" } });

      await user.click(screen.getByRole("button", { name: "Atualizar credenciais" }));
      expect(screen.getByRole("button", { name: "Cancelar" })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Cancelar" }));

      expect(invokeMock).not.toHaveBeenCalled();
      expect(await screen.findByText("Gerenciar Resend")).toBeInTheDocument();
      expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
    });

    it('botão "Cancelar" não aparece quando não é isActive', () => {
      renderDialog({});

      expect(screen.queryByRole("button", { name: "Cancelar" })).not.toBeInTheDocument();
    });
  });

  describe("múltiplos provedores de WhatsApp", () => {
    const zapiCatalog: CatalogRow = {
      ...baseCatalog,
      slug: "zapi",
      name: "Z-API",
      required_secrets: [],
    };

    it("não mostra mais aviso de exclusividade quando outro provedor de WhatsApp está ativo (coexistem)", () => {
      useTenantIntegrationsMock.mockReturnValue({
        data: [{ ...baseTenant, slug: "twilio", status: "active" }],
      });

      renderDialog({ catalog: zapiCatalog });

      expect(screen.queryByText(/vai desativar/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/apenas um provedor/i)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Testar e conectar" })).toBeInTheDocument();
    });

    it("submit dispara connect direto, sem passo de confirmação extra", async () => {
      useTenantIntegrationsMock.mockReturnValue({
        data: [{ ...baseTenant, slug: "twilio", status: "active" }],
      });
      invokeMock.mockResolvedValue({ data: { ok: true }, error: null });
      const user = userEvent.setup();
      renderDialog({ catalog: zapiCatalog });

      await user.click(screen.getByRole("button", { name: "Testar e conectar" }));

      await waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith("integration-connect", {
          body: { action: "connect", slug: "zapi", values: {} },
        }),
      );
    });
  });

  describe("passo setup", () => {
    it('mostra "Gerenciar {name}" no título quando isActive', async () => {
      renderDialog({ tenant: { ...baseTenant, status: "active" } });

      expect(await screen.findByText("Gerenciar Resend")).toBeInTheDocument();
    });

    it("mostra descrição específica e sem bloco de webhook para elevenlabs", async () => {
      const catalog: CatalogRow = { ...baseCatalog, slug: "elevenlabs", name: "ElevenLabs" };
      renderDialog({ catalog, tenant: { ...baseTenant, slug: "elevenlabs", status: "active" } });

      expect(
        await screen.findByText(
          "Integração ativa. O assistente já pode gerar áudios com a sua conta ElevenLabs. Use os botões abaixo para atualizar a chave ou desativar.",
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText("URL do webhook")).not.toBeInTheDocument();
    });

    it("mostra descrição genérica sem bloco de webhook para apify", async () => {
      const catalog: CatalogRow = {
        ...baseCatalog,
        slug: "apify",
        name: "Apify — Enriquecimento de Leads",
        icon: "sparkles",
      };
      renderDialog({ catalog, tenant: { ...baseTenant, slug: "apify", status: "active" } });

      expect(
        await screen.findByText(
          "Integração ativa. Use os botões abaixo para atualizar a chave ou desativar.",
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText("URL do webhook")).not.toBeInTheDocument();
    });

    it("mostra bloco de webhook com token quando webhook_token existe", async () => {
      renderDialog({
        tenant: { ...baseTenant, status: "active", webhook_token: "tok-123" },
      });

      expect(await screen.findByText("URL do webhook")).toBeInTheDocument();
      const code = screen.getByText(/messaging-webhook\/resend/);
      expect(code.textContent).toContain("?token=tok-123");
    });

    it("mostra bloco de webhook sem query string quando não há webhook_token", async () => {
      renderDialog({
        tenant: { ...baseTenant, status: "active", webhook_token: null },
      });

      const code = await screen.findByText(/messaging-webhook\/resend/);
      expect(code.textContent).not.toContain("?token=");
    });

    it("usa channel.id + channel.webhook_token na URL quando o canal tem token novo", async () => {
      renderDialog({
        tenant: { ...baseTenant, status: "active", webhook_token: "tok-legado" },
        channel: { ...baseChannel, id: "ch-99", webhook_token: "tok-canal-99" },
      });

      const code = await screen.findByText(/messaging-webhook\/resend/);
      expect(code.textContent).toContain("/resend/ch-99?token=tok-canal-99");
    });

    it("mostra o banner de migração quando token antigo E novo coexistem", async () => {
      renderDialog({
        tenant: { ...baseTenant, status: "active", webhook_token: "tok-legado" },
        channel: { ...baseChannel, webhook_token: "tok-canal" },
      });

      expect(await screen.findByText(/A URL de webhook mudou/i)).toBeInTheDocument();
    });

    it("não mostra o banner de migração quando o canal ainda não tem token novo", () => {
      renderDialog({
        tenant: { ...baseTenant, status: "active", webhook_token: "tok-legado" },
        channel: { ...baseChannel, webhook_token: null },
      });

      expect(screen.queryByText(/A URL de webhook mudou/i)).not.toBeInTheDocument();
    });

    it("não mostra o banner de migração quando só existe o token novo (sem legado)", () => {
      renderDialog({
        tenant: { ...baseTenant, status: "active", webhook_token: null },
        channel: { ...baseChannel, webhook_token: "tok-canal" },
      });

      expect(screen.queryByText(/A URL de webhook mudou/i)).not.toBeInTheDocument();
    });

    it("mostra o QR code quando slug=evolution e channel.status=waiting_qr", async () => {
      const evolutionCatalog: CatalogRow = { ...baseCatalog, slug: "evolution", name: "Evolution" };
      renderDialog({
        catalog: evolutionCatalog,
        tenant: { ...baseTenant, slug: "evolution", status: "active" },
        channel: {
          ...baseChannel,
          provider_slug: "evolution",
          status: "waiting_qr",
          qr_code: "data:image/png;base64,ABC123",
        },
      });

      const img = await screen.findByAltText(/QR code/i);
      expect(img).toHaveAttribute("src", "data:image/png;base64,ABC123");
    });

    it("mostra o QR code mesmo quando tenant_integrations ainda não está active (só o canal existe)", async () => {
      const evolutionCatalog: CatalogRow = { ...baseCatalog, slug: "evolution", name: "Evolution" };
      renderDialog({
        catalog: evolutionCatalog,
        tenant: null,
        channel: {
          ...baseChannel,
          provider_slug: "evolution",
          status: "waiting_qr",
          qr_code: "data:image/png;base64,SEMTENANT",
        },
      });

      const img = await screen.findByAltText(/QR code/i);
      expect(img).toHaveAttribute("src", "data:image/png;base64,SEMTENANT");
    });

    it("normaliza o QR code com prefixo data: quando a API Evolution devolve base64 puro (sem prefixo)", async () => {
      const evolutionCatalog: CatalogRow = { ...baseCatalog, slug: "evolution", name: "Evolution" };
      renderDialog({
        catalog: evolutionCatalog,
        tenant: { ...baseTenant, slug: "evolution", status: "active" },
        channel: {
          ...baseChannel,
          provider_slug: "evolution",
          status: "waiting_qr",
          qr_code: "SEMPREFIXO123",
        },
      });

      const img = await screen.findByAltText(/QR code/i);
      expect(img).toHaveAttribute("src", "data:image/png;base64,SEMPREFIXO123");
    });

    it("não mostra o QR code quando o status não é waiting_qr", () => {
      const evolutionCatalog: CatalogRow = { ...baseCatalog, slug: "evolution", name: "Evolution" };
      renderDialog({
        catalog: evolutionCatalog,
        tenant: { ...baseTenant, slug: "evolution", status: "active" },
        channel: {
          ...baseChannel,
          provider_slug: "evolution",
          status: "connected",
          qr_code: "data:image/png;base64,ABC123",
        },
      });

      expect(screen.queryByAltText(/QR code/i)).not.toBeInTheDocument();
    });

    it("renderiza os setup_steps em ordem com título e corpo", async () => {
      renderDialog({ tenant: { ...baseTenant, status: "active" } });

      const list = await screen.findByTestId("setup-steps");
      const items = within(list).getAllByRole("listitem");
      expect(items).toHaveLength(2);
      expect(within(items[0]).getByText("Passo 1")).toBeInTheDocument();
      expect(within(items[0]).getByText("Configure o DNS")).toBeInTheDocument();
      expect(within(items[1]).getByText("Passo 2")).toBeInTheDocument();
      expect(within(items[1]).getByText("Valide o domínio")).toBeInTheDocument();
    });

    it("normaliza setup_steps legados em texto sem renderizar etapas vazias", async () => {
      const catalog: CatalogRow = {
        ...baseCatalog,
        setup_steps: ["Publique o servidor com HTTPS.", "Confirme o recebimento de mensagens."],
      };
      renderDialog({ catalog, tenant: { ...baseTenant, status: "active" } });

      const list = await screen.findByTestId("setup-steps");
      const items = within(list).getAllByRole("listitem");
      expect(within(items[0]).getByText("Passo 1")).toBeInTheDocument();
      expect(within(items[0]).getByText("Publique o servidor com HTTPS.")).toBeInTheDocument();
      expect(within(items[1]).getByText("Passo 2")).toBeInTheDocument();
      expect(
        within(items[1]).getByText("Confirme o recebimento de mensagens."),
      ).toBeInTheDocument();
    });

    it("descarta etapas totalmente vazias e completa o título quando só há descrição", () => {
      expect(
        normalizeSetupSteps([
          { title: " ", body: " " },
          { title: "", body: "Descrição preservada" },
          "  ",
        ]),
      ).toEqual([{ title: "Passo 2", body: "Descrição preservada" }]);
    });

    it("renderiza os setup_steps do LlamaCloud, que não tem webhook nem wizard", async () => {
      // Regressão: `steps` era podado por `hasWebhook`, e o LlamaCloud está em
      // NO_WEBHOOK_SLUGS. Sem wizard na entrada e sem passos na saída, a tela
      // de gerenciamento ficava vazia — era a única integração visível assim.
      const catalog: CatalogRow = {
        ...baseCatalog,
        slug: "llamacloud",
        name: "Base de conhecimento (LlamaCloud)",
        icon: "knowledge",
      };
      renderDialog({ catalog, tenant: { ...baseTenant, slug: "llamacloud", status: "active" } });

      const list = await screen.findByTestId("setup-steps");
      expect(within(list).getAllByRole("listitem")).toHaveLength(2);
      expect(screen.queryByText("URL do webhook")).not.toBeInTheDocument();
    });

    it("continua escondendo os passos de quem tem wizard e não tem webhook", async () => {
      // Controle positivo do teste acima: se alguém remover a poda por completo,
      // o ElevenLabs volta a repetir "crie a conta, gere a chave" já conectado.
      getWizardMock.mockReturnValue({ slug: "elevenlabs", steps: [] });
      const catalog: CatalogRow = { ...baseCatalog, slug: "elevenlabs", name: "ElevenLabs" };
      renderDialog({ catalog, tenant: { ...baseTenant, slug: "elevenlabs", status: "active" } });

      await screen.findByText("Gerenciar ElevenLabs");
      expect(screen.queryByTestId("setup-steps")).not.toBeInTheDocument();
    });

    it("não renderiza lista de passos quando setup_steps está vazio", async () => {
      const catalog: CatalogRow = { ...baseCatalog, setup_steps: [] };
      renderDialog({ catalog, tenant: { ...baseTenant, status: "active" } });

      await screen.findByText("Gerenciar Resend");
      expect(screen.queryByTestId("setup-steps")).not.toBeInTheDocument();
    });

    it("não renderiza lista de passos quando setup_steps é null", async () => {
      const catalog: CatalogRow = { ...baseCatalog, setup_steps: null };
      renderDialog({ catalog, tenant: { ...baseTenant, status: "active" } });

      await screen.findByText("Gerenciar Resend");
      expect(screen.queryByTestId("setup-steps")).not.toBeInTheDocument();
    });

    it("copia a URL do webhook, mostra toast e alterna o ícone Copy/Check por 2s", async () => {
      vi.useFakeTimers();
      try {
        renderDialog({
          tenant: { ...baseTenant, status: "active", webhook_token: "tok-123" },
        });
        // DialogContent é renderizado num Portal em document.body, fora do container local.
        const copyButton = findIconButton(document.body, "lucide-copy");
        fireEvent.click(copyButton);

        expect(writeTextMock).toHaveBeenCalledWith(
          expect.stringContaining("messaging-webhook/resend?token=tok-123"),
        );
        expect(toastSuccessMock).toHaveBeenCalledWith("URL copiada.");
        expect(document.body.querySelector("svg.lucide-check")).toBeInTheDocument();

        act(() => {
          vi.advanceTimersByTime(2000);
        });

        expect(document.body.querySelector("svg.lucide-copy")).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('botão "Esquecer credenciais" chama invoke com action forget, fecha o dialog e mostra toast no sucesso', async () => {
      invokeMock.mockResolvedValue({ data: { ok: true }, error: null });
      const onOpenChange = vi.fn();
      const user = userEvent.setup();
      const { queryClient } = renderDialog({
        tenant: { ...baseTenant, status: "active" },
        onOpenChange,
      });
      const invalidate = vi.spyOn(queryClient, "invalidateQueries");

      await user.click(screen.getByRole("button", { name: /Esquecer credenciais/i }));
      await user.click(
        await screen
          .findByRole("alertdialog")
          .then((d) => within(d).getByRole("button", { name: /Esquecer credenciais/i })),
      );

      await waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith("integration-connect", {
          body: { action: "forget", slug: "resend" },
        }),
      );
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
      expect(toastSuccessMock).toHaveBeenCalledWith("Credenciais apagadas.");
      // Mesmo esquecimento do connect: apagar credenciais também derruba o canal.
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["tenant-channels"] });
    });

    it('botão "Desativar" chama invoke com action disconnect, fecha o dialog e mostra toast no sucesso', async () => {
      invokeMock.mockResolvedValue({ data: { ok: true }, error: null });
      const onOpenChange = vi.fn();
      const user = userEvent.setup();
      const { queryClient } = renderDialog({
        tenant: { ...baseTenant, status: "active" },
        onOpenChange,
      });
      const invalidate = vi.spyOn(queryClient, "invalidateQueries");

      await user.click(screen.getByRole("button", { name: "Desativar" }));

      await waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith("integration-connect", {
          body: { action: "disconnect", slug: "resend" },
        }),
      );
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
      expect(toastSuccessMock).toHaveBeenCalledWith("Resend desativado.");
      // Mesmo esquecimento do connect: desativar também muda o estado do canal.
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["tenant-channels"] });
    });

    it('botão "Desativar" mostra mensagem de erro padrão quando o erro (retornado no invoke) não tem message', async () => {
      invokeMock.mockResolvedValue({ data: null, error: {} });
      const user = userEvent.setup();
      renderDialog({ tenant: { ...baseTenant, status: "active" } });

      await user.click(screen.getByRole("button", { name: "Desativar" }));

      await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("Erro ao desativar."));
    });

    it('botão "Esquecer credenciais" mostra mensagem de erro padrão quando o erro (retornado no invoke) não tem message', async () => {
      invokeMock.mockResolvedValue({ data: null, error: {} });
      const user = userEvent.setup();
      renderDialog({ tenant: { ...baseTenant, status: "active" } });

      await user.click(screen.getByRole("button", { name: /Esquecer credenciais/i }));
      await user.click(
        await screen
          .findByRole("alertdialog")
          .then((d) => within(d).getByRole("button", { name: /Esquecer credenciais/i })),
      );

      await waitFor(() =>
        expect(toastErrorMock).toHaveBeenCalledWith("Erro ao apagar credenciais."),
      );
    });

    it('botão "Atualizar credenciais" volta para o passo form', async () => {
      const user = userEvent.setup();
      renderDialog({ tenant: { ...baseTenant, status: "active" } });

      await user.click(screen.getByRole("button", { name: "Atualizar credenciais" }));

      expect(await screen.findByLabelText("API Key")).toBeInTheDocument();
    });

    it("desabilita os botões de ação enquanto disconnect/forget está pendente", async () => {
      let resolveInvoke: (value: { data: { ok: boolean }; error: null }) => void = () => {};
      invokeMock.mockReturnValue(
        new Promise((resolve) => {
          resolveInvoke = resolve;
        }),
      );
      const user = userEvent.setup();
      renderDialog({ tenant: { ...baseTenant, status: "active" } });

      await user.click(screen.getByRole("button", { name: "Desativar" }));

      expect(screen.getByRole("button", { name: "Desativar" })).toBeDisabled();
      expect(screen.getByRole("button", { name: /Esquecer credenciais/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Atualizar credenciais" })).toBeDisabled();

      resolveInvoke({ data: { ok: true }, error: null });
      await waitFor(() => expect(toastSuccessMock).toHaveBeenCalled());
    });
  });

  describe("fechar e reabrir o dialog", () => {
    function ControlledDialog({
      catalog,
      tenant,
    }: {
      catalog: CatalogRow;
      tenant: TenantIntegrationRow | null;
    }) {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Reabrir
          </button>
          <ConnectDialog open={open} onOpenChange={setOpen} catalog={catalog} tenant={tenant} />
        </>
      );
    }

    it("reseta os valores digitados e volta ao passo correto ao fechar (Escape) e reabrir", async () => {
      const user = userEvent.setup();
      renderWithClient(<ControlledDialog catalog={baseCatalog} tenant={null} />);

      const input = screen.getByLabelText("API Key");
      await user.type(input, "segredo");
      expect(input).toHaveValue("segredo");

      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument());

      await user.click(screen.getByText("Reabrir"));

      expect(await screen.findByLabelText("API Key")).toHaveValue("");
    });

    it("ao fechar com isActive, reabre de volta no passo setup (não no form)", async () => {
      const user = userEvent.setup();
      renderWithClient(
        <ControlledDialog catalog={baseCatalog} tenant={{ ...baseTenant, status: "active" }} />,
      );

      // Abre direto em "setup"; navega pra "form" antes de fechar.
      await user.click(screen.getByRole("button", { name: "Atualizar credenciais" }));
      expect(await screen.findByLabelText("API Key")).toBeInTheDocument();

      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument());

      await user.click(screen.getByText("Reabrir"));

      expect(await screen.findByText("Gerenciar Resend")).toBeInTheDocument();
      expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
    });
  });
});
