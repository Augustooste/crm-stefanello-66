import { describe, it, expect, vi, beforeEach } from "vitest";
import { useSyncExternalStore } from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CompleteOnboardingResult, NicheTemplate } from "@/lib/api/onboarding";
import { ONBOARDING_STEP_NICHO, OnboardingWizard } from "./OnboardingWizard";

/* ================================================================== */
/* Mocks                                                               */
/* ================================================================== */

const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
const toastWarningMock = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
    warning: (...args: unknown[]) => toastWarningMock(...args),
  },
}));

const useCurrentProfileMock = vi.fn();
vi.mock("@/lib/api/session", () => ({
  useCurrentProfile: () => useCurrentProfileMock(),
}));

const useAuthMock = vi.fn();
vi.mock("@/lib/auth/AuthProvider", () => ({
  useAuth: () => useAuthMock(),
}));

const useTenantIntegrationsMock = vi.fn();
vi.mock("@/lib/api/integrations", () => ({
  useTenantIntegrations: () => useTenantIntegrationsMock(),
}));

const useIntegrationsCatalogMock = vi.fn();
vi.mock("@/components/integrations/IntegrationCard", () => ({
  IntegrationCard: ({ catalog }: { catalog: { slug: string } }) => (
    <div data-testid="integration-card" data-slug={catalog.slug} />
  ),
  useIntegrationsCatalog: () => useIntegrationsCatalogMock(),
  useVisibleIntegrationsCatalog: () => useIntegrationsCatalogMock(),
}));

const useNicheTemplatesMock = vi.fn();
const useTenantOnboardingMock = vi.fn();
const useApplyNicheTemplateMock = vi.fn();
const useCompleteOnboardingMock = vi.fn();
const fetchDefaultBoardInfoMock = vi.fn();
vi.mock("@/lib/api/onboarding", () => ({
  useNicheTemplates: () => useNicheTemplatesMock(),
  useTenantOnboarding: () => useTenantOnboardingMock(),
  useApplyNicheTemplate: () => useApplyNicheTemplateMock(),
  useCompleteOnboarding: () => useCompleteOnboardingMock(),
  useBootstrapStatus: () => ({
    data: { vault_missing: [], items: [], ok: true },
    isLoading: false,
    isError: false,
  }),
  useConfigureEnvironment: () => ({ mutate: vi.fn(), isPending: false }),
  useScheduledJobsStatus: () => ({
    data: { can_manage: false, vault_missing: [], jobs: [], total: 0, active: 0 },
    isLoading: false,
    isError: false,
  }),
  useActivateScheduledJobs: () => ({ mutate: vi.fn(), isPending: false }),
  usePauseScheduledJobs: () => ({ mutate: vi.fn(), isPending: false }),
  fetchDefaultBoardInfo: (...args: unknown[]) => fetchDefaultBoardInfoMock(...args),
}));

/** Fake query builder mimicking the chainable + thenable Supabase client surface. */
type MockResult = { data: unknown; error: unknown };
type Op = "select" | "update" | "insert" | "delete" | "upsert";
type TableOpResults = Partial<Record<Op, MockResult>>;

const tableResults: Record<string, TableOpResults> = {};

function setTableResult(table: string, op: Op, result: MockResult) {
  tableResults[table] = { ...tableResults[table], [op]: result };
}

function resetTableResults() {
  for (const key of Object.keys(tableResults)) delete tableResults[key];
}

interface FakeQueryBuilder {
  select: (...args: unknown[]) => FakeQueryBuilder;
  update: (...args: unknown[]) => FakeQueryBuilder;
  insert: (...args: unknown[]) => FakeQueryBuilder;
  delete: (...args: unknown[]) => FakeQueryBuilder;
  upsert: (...args: unknown[]) => FakeQueryBuilder;
  eq: (...args: unknown[]) => FakeQueryBuilder;
  is: (...args: unknown[]) => FakeQueryBuilder;
  in: (...args: unknown[]) => FakeQueryBuilder;
  order: (...args: unknown[]) => FakeQueryBuilder;
  limit: (...args: unknown[]) => FakeQueryBuilder;
  maybeSingle: () => Promise<MockResult>;
  single: () => Promise<MockResult>;
  then: <TResult1 = MockResult, TResult2 = never>(
    onFulfilled?: (value: MockResult) => TResult1 | PromiseLike<TResult1>,
    onRejected?: (reason: unknown) => TResult2 | PromiseLike<TResult2>,
  ) => Promise<TResult1 | TResult2>;
}

// Registra os args de `.update(payload)` por tabela, para asserções de payload.
const updateSpy = vi.fn();
// Registra os args de `.in(coluna, valores)` — usado no dedupe de convites.
const inSpy = vi.fn();

function makeQueryBuilder(table: string): FakeQueryBuilder {
  let op: Op = "select";
  let opSet = false;
  const setOp = (o: Op): FakeQueryBuilder => {
    if (!opSet) {
      op = o;
      opSet = true;
    }
    return builder;
  };
  const resolveResult = (): MockResult => tableResults[table]?.[op] ?? { data: null, error: null };
  const builder: FakeQueryBuilder = {
    select: () => setOp("select"),
    update: (...args: unknown[]) => {
      updateSpy(table, ...args);
      return setOp("update");
    },
    insert: () => setOp("insert"),
    delete: () => setOp("delete"),
    upsert: () => setOp("upsert"),
    eq: () => builder,
    is: () => builder,
    in: (...args: unknown[]) => {
      inSpy(table, ...args);
      return builder;
    },
    order: () => builder,
    limit: () => builder,
    maybeSingle: () => Promise.resolve(resolveResult()),
    single: () => Promise.resolve(resolveResult()),
    then: (onFulfilled, onRejected) =>
      Promise.resolve(resolveResult()).then(onFulfilled, onRejected),
  };
  return builder;
}

/** Builder cujo resultado fica "pendurado" até `resolve` ser chamado — usado para testar estados isPending. */
function makeStalledBuilder(promise: Promise<MockResult>): FakeQueryBuilder {
  const builder: FakeQueryBuilder = {
    select: () => builder,
    update: () => builder,
    insert: () => builder,
    delete: () => builder,
    upsert: () => builder,
    eq: () => builder,
    is: () => builder,
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: () => promise,
    single: () => promise,
    then: (onFulfilled, onRejected) => promise.then(onFulfilled, onRejected),
  };
  return builder;
}

function stallTable(table: string) {
  let resolve: (value: MockResult) => void = () => {};
  const promise = new Promise<MockResult>((r) => {
    resolve = r;
  });
  fromMock.mockImplementation((t: string) =>
    t === table ? makeStalledBuilder(promise) : makeQueryBuilder(t),
  );
  return { resolve };
}

const fromMock = vi.fn((table: string) => makeQueryBuilder(table));
const createSignedUrlMock = vi.fn();
const uploadMock = vi.fn();
const functionsInvokeMock = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => fromMock(table),
    storage: {
      from: () => ({
        createSignedUrl: (...args: unknown[]) => createSignedUrlMock(...args),
        upload: (...args: unknown[]) => uploadMock(...args),
      }),
    },
    functions: {
      invoke: (...args: unknown[]) => functionsInvokeMock(...args),
    },
  },
}));

/* ================================================================== */
/* Helpers                                                             */
/* ================================================================== */

const STEP_TITLES = [
  "Empresa",
  "Nicho",
  "Canais",
  "Perfil do negócio",
  "Equipe",
  "Contatos",
  "Rotinas automáticas",
];

function renderWizard(onOpenChange: (v: boolean) => void = vi.fn(), initialStep?: number) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      {/* O passo 0 é "Preparar o ambiente" (configuração automática do
          remix); os cenários abaixo tratam do fluxo de negócio, então o
          padrão aqui é abrir já no passo Empresa. */}
      <OnboardingWizard open onOpenChange={onOpenChange} initialStep={initialStep ?? 1} />
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

// targetIndex é o índice dentro de STEP_TITLES (fluxo de negócio), deslocado
// em 1 em relação ao passo real do wizard por causa do passo "Preparar o
// ambiente".
async function advanceToStep(user: ReturnType<typeof userEvent.setup>, targetIndex: number) {
  for (let i = 0; i < targetIndex; i++) {
    // O passo do Nicho só libera "Avançar" com um modelo aplicado; aqui a
    // intenção é apenas chegar ao passo alvo, então saímos dele por "Pular".
    const label = i === ONBOARDING_STEP_NICHO - 1 ? /^Pular$/ : /Avançar/i;
    await user.click(screen.getByRole("button", { name: label }));
  }
  await screen.findByText(`Configuração inicial — ${STEP_TITLES[targetIndex]}`);
}

const templateA: NicheTemplate = {
  slug: "vendas",
  name: "Vendas B2B",
  description: "Modelo genérico de vendas",
  base_prompt: "prompt base vendas",
  stages: [{ name: "Novo", position: 0, is_won: false, is_lost: false }],
  stage_prompts: [{ position: 0 }],
  plugins: [],
};

const templateB: NicheTemplate = {
  slug: "servicos",
  name: "Serviços",
  description: "Modelo de serviços",
  base_prompt: "prompt base serviços",
  stages: [
    { name: "Novo", position: 0, is_won: false, is_lost: false },
    { name: "Fechado", position: 1, is_won: true, is_lost: false },
  ],
  stage_prompts: [],
  plugins: [],
};

/* ================================================================== */
/* Setup                                                               */
/* ================================================================== */

beforeEach(() => {
  resetTableResults();
  updateSpy.mockReset();
  inSpy.mockReset();
  fromMock.mockReset();
  fromMock.mockImplementation((table: string) => makeQueryBuilder(table));
  createSignedUrlMock.mockReset();
  uploadMock.mockReset();
  functionsInvokeMock.mockReset();
  toastSuccessMock.mockReset();
  toastWarningMock.mockReset();
  toastErrorMock.mockReset();
  useCurrentProfileMock.mockReset();
  useAuthMock.mockReset();
  useTenantIntegrationsMock.mockReset();
  useIntegrationsCatalogMock.mockReset();
  useNicheTemplatesMock.mockReset();
  useTenantOnboardingMock.mockReset();
  useApplyNicheTemplateMock.mockReset();
  useCompleteOnboardingMock.mockReset();
  fetchDefaultBoardInfoMock.mockReset();

  useCurrentProfileMock.mockReturnValue({
    data: { id: "u1", tenant_id: "t1", name: "Ana", role: "admin" },
  });
  useAuthMock.mockReturnValue({ user: { id: "u1" }, isReady: true });
  useTenantIntegrationsMock.mockReturnValue({ data: [], isLoading: false });
  useIntegrationsCatalogMock.mockReturnValue({ data: [], isLoading: false });
  useNicheTemplatesMock.mockReturnValue({ data: [], isLoading: false });
  useTenantOnboardingMock.mockReturnValue({ data: { niche: null } });
  useApplyNicheTemplateMock.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
    variables: undefined,
  });
  useCompleteOnboardingMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
  fetchDefaultBoardInfoMock.mockResolvedValue({ boardId: null, stageCount: 0, dealCount: 0 });

  createSignedUrlMock.mockResolvedValue({ data: { signedUrl: null } });
  uploadMock.mockResolvedValue({ error: null });
  functionsInvokeMock.mockResolvedValue({ data: null, error: null });

  setTableResult("tenants", "select", {
    data: { id: "t1", name: "Empresa X", logo_url: null, business_profile: {} },
    error: null,
  });
  setTableResult("tenants", "update", { data: null, error: null });
  setTableResult("invites", "select", { data: [], error: null });
  setTableResult("invites", "insert", { data: { token: "tok123" }, error: null });
  setTableResult("invites", "delete", { data: null, error: null });

  setClipboard(vi.fn().mockResolvedValue(undefined));
});

function setClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  });
}

/* ================================================================== */
/* Shell / navegação                                                   */
/* ================================================================== */

describe("OnboardingWizard - shell e navegação", () => {
  it("renderiza título, subtítulo e contagem do passo atual", () => {
    renderWizard();

    expect(screen.getByText("Configuração inicial — Empresa")).toBeInTheDocument();
    expect(screen.getByText("Como o seu negócio se apresenta.")).toBeInTheDocument();
    expect(screen.getByText("Passo 2 de 8")).toBeInTheDocument();
  });

  it("botão Voltar fica desabilitado no passo 0 e habilita após avançar", async () => {
    const user = userEvent.setup();
    renderWizard(vi.fn(), 0);

    expect(screen.getByRole("button", { name: /Voltar/i })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /Avançar/i }));
    await screen.findByText("Passo 2 de 8");

    expect(screen.getByRole("button", { name: /Voltar/i })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: /Voltar/i }));

    expect(await screen.findByText("Passo 1 de 8")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Voltar/i })).toBeDisabled();
  });

  it("Pular avança um passo sem chamar complete.mutate", async () => {
    const user = userEvent.setup();
    const mutateMock = vi.fn();
    useCompleteOnboardingMock.mockReturnValue({ mutate: mutateMock, isPending: false });
    renderWizard();

    await user.click(screen.getByRole("button", { name: /Pular/i }));

    expect(await screen.findByText("Passo 3 de 8")).toBeInTheDocument();
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it("Avançar nos passos 0 a 4 apenas incrementa o passo, sem chamar complete.mutate", async () => {
    const user = userEvent.setup();
    const mutateMock = vi.fn();
    useCompleteOnboardingMock.mockReturnValue({ mutate: mutateMock, isPending: false });
    // Com um nicho já aplicado, "Avançar" passa direto pelo passo 2.
    useTenantOnboardingMock.mockReturnValue({ data: { niche: "vendas" } });
    renderWizard();

    for (let i = 1; i <= 5; i++) {
      await user.click(screen.getByRole("button", { name: /Avançar/i }));
      expect(await screen.findByText(`Passo ${i + 2} de 8`)).toBeInTheDocument();
    }

    expect(mutateMock).not.toHaveBeenCalled();
  });

  it("abre no passo indicado por initialStep", async () => {
    renderWizard(vi.fn(), ONBOARDING_STEP_NICHO);

    expect(await screen.findByText("Configuração inicial — Nicho")).toBeInTheDocument();
    expect(screen.getByText("Passo 3 de 8")).toBeInTheDocument();
  });

  it("no último passo, 'Pular por enquanto' fecha sem gravar a conclusão", async () => {
    const user = userEvent.setup();
    const mutateMock = vi.fn();
    useCompleteOnboardingMock.mockReturnValue({ mutate: mutateMock, isPending: false });
    const onOpenChange = vi.fn();
    renderWizard(onOpenChange);

    await advanceToStep(user, 6);
    await user.click(screen.getByRole("button", { name: "Pular por enquanto" }));

    // Sem complete.mutate, `onboarded_at` continua nulo e o gate volta a abrir.
    expect(mutateMock).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // E nada de "Configuração inicial concluída." para quem não concluiu.
    expect(toastSuccessMock).not.toHaveBeenCalledWith("Configuração inicial concluída.");
  });

  it("nos passos intermediários o botão continua sendo só 'Pular'", async () => {
    renderWizard();

    expect(screen.getByRole("button", { name: /^Pular$/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pular por enquanto" })).not.toBeInTheDocument();
  });

  it("no último passo o botão mostra 'Concluir' e chama complete.mutate ao clicar", async () => {
    const user = userEvent.setup();
    const mutateMock = vi.fn();
    useCompleteOnboardingMock.mockReturnValue({ mutate: mutateMock, isPending: false });
    renderWizard();

    await advanceToStep(user, 6);

    const finishButton = await screen.findByRole("button", { name: "Concluir" });
    await user.click(finishButton);

    expect(mutateMock).toHaveBeenCalledTimes(1);
    expect(mutateMock.mock.calls[0][0]).toBeUndefined();
  });

  it("onSuccess do complete mostra toast de sucesso e fecha o dialog", async () => {
    const user = userEvent.setup();
    const mutateMock = vi.fn();
    useCompleteOnboardingMock.mockReturnValue({ mutate: mutateMock, isPending: false });
    const onOpenChange = vi.fn();
    renderWizard(onOpenChange);

    await advanceToStep(user, 6);
    await user.click(await screen.findByRole("button", { name: "Concluir" }));

    const opts = mutateMock.mock.calls[0][1] as {
      onSuccess: (result: CompleteOnboardingResult) => void;
      onError: (e: Error) => void;
    };
    opts.onSuccess({ vaultMissing: [], scheduledJobsActivated: true });

    expect(toastSuccessMock).toHaveBeenCalledWith("Configuração inicial concluída.");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toastWarningMock).not.toHaveBeenCalled();
  });

  it("avisa quando o Vault ainda não tem as credenciais das rotinas", async () => {
    const user = userEvent.setup();
    const mutateMock = vi.fn();
    useCompleteOnboardingMock.mockReturnValue({ mutate: mutateMock, isPending: false });
    renderWizard(vi.fn());

    await advanceToStep(user, 6);
    await user.click(await screen.findByRole("button", { name: "Concluir" }));

    const opts = mutateMock.mock.calls[0][1] as {
      onSuccess: (result: CompleteOnboardingResult) => void;
    };
    opts.onSuccess({
      vaultMissing: ["aceleraflow_service_role_key"],
      scheduledJobsActivated: true,
    });

    expect(toastWarningMock).toHaveBeenCalledWith(
      expect.stringContaining("aceleraflow_service_role_key"),
    );
  });

  it("avisa quando as rotinas não puderam ser ligadas", async () => {
    const user = userEvent.setup();
    const mutateMock = vi.fn();
    useCompleteOnboardingMock.mockReturnValue({ mutate: mutateMock, isPending: false });
    renderWizard(vi.fn());

    await advanceToStep(user, 6);
    await user.click(await screen.findByRole("button", { name: "Concluir" }));

    const opts = mutateMock.mock.calls[0][1] as {
      onSuccess: (result: CompleteOnboardingResult) => void;
    };
    opts.onSuccess({ vaultMissing: [], scheduledJobsActivated: false });

    expect(toastWarningMock).toHaveBeenCalledWith(expect.stringContaining("rotinas automáticas"));
  });

  it("conclui o wizard em modo somente leitura das rotinas globais", async () => {
    const user = userEvent.setup();
    const mutateMock = vi.fn();
    const onOpenChange = vi.fn();
    useCompleteOnboardingMock.mockReturnValue({ mutate: mutateMock, isPending: false });
    renderWizard(onOpenChange, 7);

    expect(
      screen.getByText("Rotinas da plataforma são gerenciadas pelo operador."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ativar rotinas" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Concluir" }));
    const opts = mutateMock.mock.calls[0][1] as {
      onSuccess: (result: CompleteOnboardingResult) => void;
    };
    opts.onSuccess({ vaultMissing: [], scheduledJobsActivated: false });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toastSuccessMock).toHaveBeenCalledWith("Configuração inicial concluída.");
    expect(toastWarningMock).toHaveBeenCalledWith(
      expect.stringContaining("gerenciadas pelo operador"),
    );
  });

  it("onError do complete mostra toast de erro com a mensagem", async () => {
    const user = userEvent.setup();
    const mutateMock = vi.fn();
    useCompleteOnboardingMock.mockReturnValue({ mutate: mutateMock, isPending: false });
    renderWizard();

    await advanceToStep(user, 6);
    await user.click(await screen.findByRole("button", { name: "Concluir" }));

    const opts = mutateMock.mock.calls[0][1] as {
      onSuccess: () => void;
      onError: (e: Error) => void;
    };
    opts.onError(new Error("falha ao concluir"));

    expect(toastErrorMock).toHaveBeenCalledWith("falha ao concluir");
  });

  it("onError do complete usa mensagem padrão quando não há mensagem", async () => {
    const user = userEvent.setup();
    const mutateMock = vi.fn();
    useCompleteOnboardingMock.mockReturnValue({ mutate: mutateMock, isPending: false });
    renderWizard();

    await advanceToStep(user, 6);
    await user.click(await screen.findByRole("button", { name: "Concluir" }));

    const opts = mutateMock.mock.calls[0][1] as {
      onSuccess: () => void;
      onError: (e: Error) => void;
    };
    opts.onError({} as Error);

    expect(toastErrorMock).toHaveBeenCalledWith("Não foi possível concluir.");
  });

  it("complete.isPending desabilita os botões e mostra o loader", async () => {
    useCompleteOnboardingMock.mockReturnValue({ mutate: vi.fn(), isPending: true });
    renderWizard();

    expect(screen.getByRole("button", { name: /Voltar/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Pular/i })).toBeDisabled();
    const advanceButton = screen.getByRole("button", { name: /Avançar/i });
    expect(advanceButton).toBeDisabled();
    expect(advanceButton.querySelector(".animate-spin")).toBeInTheDocument();
  });

  it("Escape não fecha o dialog (onEscapeKeyDown previne o fechamento)", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWizard(onOpenChange);

    await user.keyboard("{Escape}");

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByText("Configuração inicial — Empresa")).toBeInTheDocument();
  });

  it("clicar fora do dialog não fecha (onInteractOutside previne o fechamento)", async () => {
    const onOpenChange = vi.fn();
    renderWizard(onOpenChange);

    // Radix marca `pointer-events: none` no body enquanto o Dialog está aberto,
    // então disparamos o evento de ponteiro diretamente em vez de usar userEvent.click.
    fireEvent.pointerDown(document.body);
    fireEvent.mouseDown(document.body);

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByText("Configuração inicial — Empresa")).toBeInTheDocument();
  });
});

/* ================================================================== */
/* StepEmpresa                                                         */
/* ================================================================== */

describe("StepEmpresa", () => {
  it("mostra skeleton enquanto os dados do tenant carregam", () => {
    renderWizard();

    expect(document.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  it("preenche nome e segmento quando os dados do tenant carregam", async () => {
    setTableResult("tenants", "select", {
      data: {
        id: "t1",
        name: "Clínica Bela",
        logo_url: null,
        business_profile: { segment: "odontologia" },
      },
      error: null,
    });
    renderWizard();

    expect(await screen.findByDisplayValue("Clínica Bela")).toBeInTheDocument();
    expect(screen.getByDisplayValue("odontologia")).toBeInTheDocument();
  });

  it("mostra a logo quando logo_url está presente e o signed URL resolve", async () => {
    setTableResult("tenants", "select", {
      data: { id: "t1", name: "Empresa X", logo_url: "t1/logo.png", business_profile: {} },
      error: null,
    });
    createSignedUrlMock.mockResolvedValue({ data: { signedUrl: "https://cdn.example/logo.png" } });
    renderWizard();

    const img = await screen.findByAltText("Logo");
    expect(img).toHaveAttribute("src", "https://cdn.example/logo.png");
    expect(createSignedUrlMock).toHaveBeenCalledWith("t1/logo.png", 3600);
  });

  it("faz upload de logo e mostra toast de sucesso", async () => {
    const user = userEvent.setup();
    renderWizard();
    await screen.findByDisplayValue("Empresa X");

    const file = new File(["conteudo"], "logo.png", { type: "image/png" });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, file);

    await waitFor(() => expect(uploadMock).toHaveBeenCalled());
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("Logo atualizado"));
  });

  it("mostra 'Enviando…' enquanto o upload da logo está pendente", async () => {
    const user = userEvent.setup();
    let resolveUpload: (value: { error: null }) => void = () => {};
    uploadMock.mockImplementation(
      () =>
        new Promise<{ error: null }>((resolve) => {
          resolveUpload = resolve;
        }),
    );
    renderWizard();
    await screen.findByDisplayValue("Empresa X");

    const file = new File(["conteudo"], "logo.png", { type: "image/png" });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, file);

    expect(await screen.findByText("Enviando…")).toBeInTheDocument();
    resolveUpload({ error: null });

    await waitFor(() => expect(screen.queryByText("Enviando…")).not.toBeInTheDocument());
  });

  it("clique em 'Enviar logo' aciona o input de arquivo oculto", async () => {
    const user = userEvent.setup();
    renderWizard();
    await screen.findByDisplayValue("Empresa X");

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, "click");
    await user.click(screen.getByRole("button", { name: /Enviar logo/i }));

    expect(clickSpy).toHaveBeenCalled();
  });

  it("mostra toast de erro quando o upload da logo falha", async () => {
    const user = userEvent.setup();
    uploadMock.mockResolvedValue({ error: new Error("falha no upload") });
    renderWizard();
    await screen.findByDisplayValue("Empresa X");

    const file = new File(["x"], "logo.png", { type: "image/png" });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, file);

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("falha no upload"));
  });

  it("não mostra mais botões 'Salvar' ao lado de nome e segmento", async () => {
    renderWizard();
    await screen.findByLabelText("Nome da empresa / marca");

    expect(screen.queryByRole("button", { name: "Salvar" })).not.toBeInTheDocument();
  });

  it("persiste nome e segmento ao clicar em Avançar e vai para o passo 2", async () => {
    const user = userEvent.setup();
    renderWizard();
    const nameInput = await screen.findByLabelText("Nome da empresa / marca");
    const segmentInput = screen.getByLabelText("Segmento");

    await user.clear(nameInput);
    await user.type(nameInput, "Nome Novo");
    await user.type(segmentInput, "clínica odontológica");
    await user.click(screen.getByRole("button", { name: /Avançar/i }));

    expect(await screen.findByText("Passo 3 de 8")).toBeInTheDocument();
  });

  it("no passo 1, não grava name quando vazio — só business_profile (nunca regride)", async () => {
    setTableResult("tenants", "select", {
      data: { id: "t1", name: "", logo_url: null, business_profile: {} },
      error: null,
    });
    const user = userEvent.setup();
    renderWizard();
    const nameInput = (await screen.findByLabelText("Nome da empresa / marca")) as HTMLInputElement;
    await waitFor(() => expect(nameInput.value).toBe(""));

    await user.click(screen.getByRole("button", { name: /Avançar/i }));
    await screen.findByText("Passo 3 de 8");

    const call = updateSpy.mock.calls.find((c) => c[0] === "tenants");
    expect(call?.[1]).not.toHaveProperty("name");
    expect(call?.[1]).toHaveProperty("business_profile");
  });

  it("no passo 1, grava name quando preenchido", async () => {
    const user = userEvent.setup();
    renderWizard();
    const nameInput = await screen.findByLabelText("Nome da empresa / marca");
    await user.clear(nameInput);
    await user.type(nameInput, "Empresa Nova");
    await user.click(screen.getByRole("button", { name: /Avançar/i }));
    await screen.findByText("Passo 3 de 8");

    const call = updateSpy.mock.calls.find((c) => c[0] === "tenants");
    expect(call?.[1]).toMatchObject({ name: "Empresa Nova" });
  });

  it("mostra toast de erro e permanece no passo 1 quando o save do passo falha", async () => {
    setTableResult("tenants", "update", { data: null, error: new Error("erro ao salvar") });
    const user = userEvent.setup();
    renderWizard();
    const nameInput = await screen.findByLabelText("Nome da empresa / marca");

    await user.clear(nameInput);
    await user.type(nameInput, "Nome Novo");
    await user.click(screen.getByRole("button", { name: /Avançar/i }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("erro ao salvar"));
    expect(screen.getByText("Passo 2 de 8")).toBeInTheDocument();
  });

  it("usa mensagem padrão quando o save do passo 1 falha sem mensagem", async () => {
    setTableResult("tenants", "update", { data: null, error: {} });
    const user = userEvent.setup();
    renderWizard();
    const nameInput = await screen.findByLabelText("Nome da empresa / marca");

    await user.clear(nameInput);
    await user.type(nameInput, "Nome Novo");
    await user.click(screen.getByRole("button", { name: /Avançar/i }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("Erro ao salvar"));
    expect(screen.getByText("Passo 2 de 8")).toBeInTheDocument();
  });

  it("extrai a marca ao clicar em Analisar site e mostra preview de cores", async () => {
    const user = userEvent.setup();
    functionsInvokeMock.mockResolvedValue({
      data: {
        primary: "#112233",
        primary_foreground: "#ffffff",
        accent_foreground: "#445566",
        source_hex: "#112233",
        site_title: "Minha Empresa",
        site_description: null,
        suggested_segment: "clínica odontológica",
      },
      error: null,
    });
    renderWizard();
    await screen.findByDisplayValue("Empresa X");

    const siteInput = screen.getByPlaceholderText("https://seudominio.com.br");
    await user.type(siteInput, "https://empresa.com.br");
    await user.click(screen.getByRole("button", { name: "Analisar site" }));

    expect(await screen.findByText("Minha Empresa")).toBeInTheDocument();
    expect(functionsInvokeMock).toHaveBeenCalledWith("brand-extract", {
      body: { url: "https://empresa.com.br" },
    });
    expect(screen.getByDisplayValue("clínica odontológica")).toBeInTheDocument();
  });

  it("pressionar Enter no campo de site com valor preenchido dispara a extração", async () => {
    const user = userEvent.setup();
    functionsInvokeMock.mockResolvedValue({
      data: {
        primary: "#112233",
        primary_foreground: "#ffffff",
        accent_foreground: "#445566",
        source_hex: "#112233",
        site_title: null,
        site_description: null,
        suggested_segment: null,
      },
      error: null,
    });
    renderWizard();
    await screen.findByDisplayValue("Empresa X");

    const siteInput = screen.getByPlaceholderText("https://seudominio.com.br");
    await user.type(siteInput, "https://empresa.com.br{Enter}");

    await waitFor(() => expect(functionsInvokeMock).toHaveBeenCalled());
  });

  it("Enter no campo de site vazio não dispara a extração", async () => {
    const user = userEvent.setup();
    renderWizard();
    await screen.findByDisplayValue("Empresa X");

    const siteInput = screen.getByPlaceholderText("https://seudominio.com.br");
    await user.click(siteInput);
    await user.keyboard("{Enter}");

    expect(functionsInvokeMock).not.toHaveBeenCalled();
  });

  it("mostra toast de erro quando a extração de marca falha", async () => {
    const user = userEvent.setup();
    functionsInvokeMock.mockResolvedValue({ data: null, error: new Error("boom") });
    renderWizard();
    await screen.findByDisplayValue("Empresa X");

    await user.type(screen.getByPlaceholderText("https://seudominio.com.br"), "https://x.com.br");
    await user.click(screen.getByRole("button", { name: "Analisar site" }));

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        "Não conseguimos analisar o site — confira a URL.",
      ),
    );
  });

  it("mostra a referência devolvida pela função quando a extração falha", async () => {
    const user = userEvent.setup();
    const context = new Response(
      JSON.stringify({
        error: "Não conseguimos ler o site.",
        contract_version: 1,
        revision: "brand-extract-2026-08-10-r7",
        request_id: "abc12345",
      }),
      { status: 422, headers: { "content-type": "application/json" } },
    );
    functionsInvokeMock.mockResolvedValue({ data: null, error: { context } });
    renderWizard();
    await screen.findByDisplayValue("Empresa X");

    await user.type(screen.getByPlaceholderText("https://seudominio.com.br"), "https://x.com.br");
    await user.click(screen.getByRole("button", { name: "Analisar site" }));

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith("Não conseguimos ler o site. (ref. abc12345)"),
    );
  });

  it("mostra o painel de diagnóstico com assets e etapa que falhou", async () => {
    const user = userEvent.setup();
    const context = new Response(
      JSON.stringify({
        error: "Não conseguimos ler o site.",
        contract_version: 1,
        revision: "brand-extract-2026-08-10-r7",
        request_id: "abc12345",
        diagnostics: {
          steps: [
            { id: "acesso", label: "Acesso ao site", status: "ok", detail: null },
            { id: "html", label: "Leitura do HTML", status: "falhou", detail: "timeout" },
          ],
          assets: [
            {
              role: "favicon",
              kind: "icon",
              url: "https://x.com.br/favicon.ico",
              status: "lido",
              reason: null,
            },
            { role: "og:image", kind: null, url: null, status: "nao_encontrado", reason: null },
          ],
        },
      }),
      { status: 422, headers: { "content-type": "application/json" } },
    );
    functionsInvokeMock.mockResolvedValue({ data: null, error: { context } });
    renderWizard();
    await screen.findByDisplayValue("Empresa X");

    await user.type(screen.getByPlaceholderText("https://seudominio.com.br"), "https://x.com.br");
    await user.click(screen.getByRole("button", { name: "Analisar site" }));

    expect(await screen.findByText("Favicon")).toBeInTheDocument();
    expect(screen.getByText("og:image")).toBeInTheDocument();
    expect(screen.getByText("Leitura do HTML")).toBeInTheDocument();
    expect(screen.getByText("Falhou")).toBeInTheDocument();
    expect(screen.getByText(/abc12345/)).toBeInTheDocument();
  });

  it("avisa backend desatualizado quando a resposta não traz contrato nem revisão", async () => {
    const user = userEvent.setup();
    const context = new Response(
      JSON.stringify({ error: "Não conseguimos ler o site: relative URL without a base" }),
      {
        status: 422,
        headers: { "content-type": "application/json", "sb-project-ref": "outroprojeto123" },
      },
    );
    functionsInvokeMock.mockResolvedValue({ data: null, error: { context } });
    renderWizard();
    await screen.findByDisplayValue("Empresa X");

    await user.type(screen.getByPlaceholderText("https://seudominio.com.br"), "https://x.com.br");
    await user.click(screen.getByRole("button", { name: "Analisar site" }));

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        "O backend deste ambiente está desatualizado. Reimplante o serviço de extração e publique novamente.",
      ),
    );
    expect(toastErrorMock).not.toHaveBeenCalledWith(
      expect.stringContaining("relative URL without a base"),
    );
    // O painel identifica a instância que respondeu.
    const referencia = await screen.findByText(/Referência:/);
    expect(referencia.textContent).toContain("outroprojeto123");
  });

  it("trata falha de rede como indisponibilidade, não como backend desatualizado", async () => {
    const user = userEvent.setup();
    functionsInvokeMock.mockResolvedValue({
      data: null,
      error: {
        name: "FunctionsFetchError",
        message: "Failed to send a request to the Edge Function",
        context: {},
      },
    });
    renderWizard();
    await screen.findByDisplayValue("Empresa X");

    await user.type(screen.getByPlaceholderText("https://seudominio.com.br"), "https://x.com.br");
    await user.click(screen.getByRole("button", { name: "Analisar site" }));

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        "Não foi possível conectar ao serviço de extração. Tente novamente.",
      ),
    );
    expect(toastErrorMock).not.toHaveBeenCalledWith(expect.stringContaining("desatualizado"));
  });

  it("preserva o erro real quando a resposta declara o contrato atual", async () => {
    const user = userEvent.setup();
    const context = new Response(
      JSON.stringify({
        error: "Não conseguimos ler o site: Site respondeu 403.",
        contract_version: 1,
        revision: "brand-extract-2026-08-10-r7",
      }),
      { status: 422, headers: { "content-type": "application/json" } },
    );
    functionsInvokeMock.mockResolvedValue({ data: null, error: { context } });
    renderWizard();
    await screen.findByDisplayValue("Empresa X");

    await user.type(screen.getByPlaceholderText("https://seudominio.com.br"), "https://x.com.br");
    await user.click(screen.getByRole("button", { name: "Analisar site" }));

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        "Não conseguimos ler o site: Site respondeu 403.",
      ),
    );
  });

  it("aceita resposta compatível mesmo quando a revisão de implantação é diferente", async () => {
    const user = userEvent.setup();
    functionsInvokeMock.mockResolvedValue({
      data: {
        primary: "#112233",
        primary_foreground: "#ffffff",
        accent_foreground: "#445566",
        source_hex: "#112233",
        site_title: "Site antigo",
        site_description: null,
        suggested_segment: null,
        contract_version: 1,
        revision: "brand-extract-2026-08-10-r3",
      },
      error: null,
    });
    renderWizard();
    await screen.findByDisplayValue("Empresa X");

    await user.type(screen.getByPlaceholderText("https://seudominio.com.br"), "https://x.com.br");
    await user.click(screen.getByRole("button", { name: "Analisar site" }));

    expect(await screen.findByText("Site antigo")).toBeInTheDocument();
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("rejeita somente contrato explicitamente incompatível", async () => {
    const user = userEvent.setup();
    functionsInvokeMock.mockResolvedValue({
      data: {
        primary: "#112233",
        primary_foreground: "#ffffff",
        accent_foreground: "#445566",
        source_hex: "#112233",
        site_title: null,
        site_description: null,
        suggested_segment: null,
        contract_version: 2,
      },
      error: null,
    });
    renderWizard();
    await screen.findByDisplayValue("Empresa X");

    await user.type(screen.getByPlaceholderText("https://seudominio.com.br"), "https://x.com.br");
    await user.click(screen.getByRole("button", { name: "Analisar site" }));

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        "O serviço de extração retornou um formato incompatível. Tente novamente em alguns instantes.",
      ),
    );
  });

  it("aplica as cores extraídas com sucesso e some o preview", async () => {
    const user = userEvent.setup();
    functionsInvokeMock.mockResolvedValue({
      data: {
        primary: "#112233",
        primary_foreground: "#ffffff",
        accent_foreground: "#445566",
        source_hex: "#112233",
        site_title: "Site Extraído",
        site_description: null,
        suggested_segment: null,
      },
      error: null,
    });
    renderWizard();
    await screen.findByDisplayValue("Empresa X");

    await user.type(screen.getByPlaceholderText("https://seudominio.com.br"), "https://x.com.br");
    await user.click(screen.getByRole("button", { name: "Analisar site" }));
    await screen.findByText("Site Extraído");

    await user.click(screen.getByRole("button", { name: "Aplicar" }));

    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("Cores da marca aplicadas."));
    await waitFor(() => expect(screen.queryByText("Site Extraído")).not.toBeInTheDocument());
  });

  it("mostra toast de erro ao falhar aplicar as cores extraídas", async () => {
    const user = userEvent.setup();
    functionsInvokeMock.mockResolvedValue({
      data: {
        primary: "#112233",
        primary_foreground: "#ffffff",
        accent_foreground: "#445566",
        source_hex: "#112233",
        site_title: "Site Extraído",
        site_description: null,
        suggested_segment: null,
      },
      error: null,
    });
    renderWizard();
    await screen.findByDisplayValue("Empresa X");

    await user.type(screen.getByPlaceholderText("https://seudominio.com.br"), "https://x.com.br");
    await user.click(screen.getByRole("button", { name: "Analisar site" }));
    await screen.findByText("Site Extraído");

    setTableResult("tenants", "update", { data: null, error: new Error("falha ao salvar cores") });
    await user.click(screen.getByRole("button", { name: "Aplicar" }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("falha ao salvar cores"));
  });

  it("descarta a prévia de cores extraídas", async () => {
    const user = userEvent.setup();
    functionsInvokeMock.mockResolvedValue({
      data: {
        primary: "#112233",
        primary_foreground: "#ffffff",
        accent_foreground: "#445566",
        source_hex: "#112233",
        site_title: "Site Extraído",
        site_description: null,
        suggested_segment: null,
      },
      error: null,
    });
    renderWizard();
    await screen.findByDisplayValue("Empresa X");

    await user.type(screen.getByPlaceholderText("https://seudominio.com.br"), "https://x.com.br");
    await user.click(screen.getByRole("button", { name: "Analisar site" }));
    await screen.findByText("Site Extraído");

    await user.click(screen.getByRole("button", { name: "Descartar" }));

    expect(screen.queryByText("Site Extraído")).not.toBeInTheDocument();
  });

  it("trata nome e segmento nulos do tenant como campos vazios", async () => {
    setTableResult("tenants", "select", {
      data: { id: "t1", name: null, logo_url: null, business_profile: { segment: null } },
      error: null,
    });
    renderWizard();

    const nameInput = (await screen.findByLabelText("Nome da empresa / marca")) as HTMLInputElement;
    const segmentInput = screen.getByLabelText("Segmento") as HTMLInputElement;

    expect(nameInput.value).toBe("");
    expect(segmentInput.value).toBe("");
  });

  it("não quebra quando a consulta do tenant retorna erro (Empresa e Perfil do negócio)", async () => {
    setTableResult("tenants", "select", { data: null, error: new Error("db down") });
    const user = userEvent.setup();
    renderWizard();

    expect(await screen.findByText("Sem logo")).toBeInTheDocument();

    await advanceToStep(user, 3);
    expect(await screen.findByText("Time de atendimento")).toBeInTheDocument();
  });

  it("mantém o preview de logo vazio quando o signed URL retorna nulo", async () => {
    setTableResult("tenants", "select", {
      data: { id: "t1", name: "Empresa X", logo_url: "t1/logo.png", business_profile: {} },
      error: null,
    });
    createSignedUrlMock.mockResolvedValue({ data: { signedUrl: null } });
    renderWizard();

    await screen.findByDisplayValue("Empresa X");
    await waitFor(() => expect(createSignedUrlMock).toHaveBeenCalled());
    expect(screen.getByText("Sem logo")).toBeInTheDocument();
  });

  it("mostra toast de erro com mensagem padrão quando o upload da logo falha sem mensagem", async () => {
    uploadMock.mockResolvedValue({ error: {} });
    const user = userEvent.setup();
    renderWizard();
    await screen.findByDisplayValue("Empresa X");

    const file = new File(["x"], "logo.png", { type: "image/png" });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, file);

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("Erro no upload"));
  });

  it("mostra toast de erro com mensagem padrão quando a extração falha sem mensagem", async () => {
    functionsInvokeMock.mockRejectedValue({});
    const user = userEvent.setup();
    renderWizard();
    await screen.findByDisplayValue("Empresa X");

    await user.type(screen.getByPlaceholderText("https://seudominio.com.br"), "https://x.com.br");
    await user.click(screen.getByRole("button", { name: "Analisar site" }));

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        "Não foi possível conectar ao serviço de extração. Tente novamente.",
      ),
    );
  });

  it("mostra 'Analisando…' enquanto a extração de marca está pendente", async () => {
    let resolveInvoke: (value: { data: unknown; error: unknown }) => void = () => {};
    functionsInvokeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInvoke = resolve;
        }),
    );
    const user = userEvent.setup();
    renderWizard();
    await screen.findByDisplayValue("Empresa X");

    await user.type(screen.getByPlaceholderText("https://seudominio.com.br"), "https://x.com.br");
    await user.click(screen.getByRole("button", { name: "Analisar site" }));

    expect(await screen.findByText("Analisando…")).toBeInTheDocument();
    resolveInvoke({ data: null, error: null });

    await waitFor(() => expect(screen.queryByText("Analisando…")).not.toBeInTheDocument());
  });

  it("mostra 'Aplicando…' enquanto aplica as cores extraídas", async () => {
    functionsInvokeMock.mockResolvedValue({
      data: {
        primary: "#112233",
        primary_foreground: "#ffffff",
        accent_foreground: "#445566",
        source_hex: "#112233",
        site_title: "Site Extraído",
        site_description: null,
        suggested_segment: null,
      },
      error: null,
    });
    const user = userEvent.setup();
    renderWizard();
    await screen.findByDisplayValue("Empresa X");

    await user.type(screen.getByPlaceholderText("https://seudominio.com.br"), "https://x.com.br");
    await user.click(screen.getByRole("button", { name: "Analisar site" }));
    await screen.findByText("Site Extraído");

    const { resolve } = stallTable("tenants");
    await user.click(screen.getByRole("button", { name: "Aplicar" }));

    expect(await screen.findByText("Aplicando…")).toBeInTheDocument();
    resolve({ data: null, error: null });
    fromMock.mockImplementation((t: string) => makeQueryBuilder(t));

    await waitFor(() => expect(screen.queryByText("Aplicando…")).not.toBeInTheDocument());
  });

  it("mostra toast de erro com mensagem padrão ao falhar aplicar cores sem mensagem", async () => {
    functionsInvokeMock.mockResolvedValue({
      data: {
        primary: "#112233",
        primary_foreground: "#ffffff",
        accent_foreground: "#445566",
        source_hex: "#112233",
        site_title: "Site Extraído",
        site_description: null,
        suggested_segment: null,
      },
      error: null,
    });
    const user = userEvent.setup();
    renderWizard();
    await screen.findByDisplayValue("Empresa X");

    await user.type(screen.getByPlaceholderText("https://seudominio.com.br"), "https://x.com.br");
    await user.click(screen.getByRole("button", { name: "Analisar site" }));
    await screen.findByText("Site Extraído");

    setTableResult("tenants", "update", { data: null, error: {} });
    await user.click(screen.getByRole("button", { name: "Aplicar" }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("Erro ao aplicar"));
  });

  it("mostra 'Nada para aplicar' ao tentar aplicar cores sem tenant_id no perfil", async () => {
    useCurrentProfileMock.mockReturnValue({
      data: { id: "u1", tenant_id: undefined, name: "Ana", role: "admin" },
    });
    functionsInvokeMock.mockResolvedValue({
      data: {
        primary: "#112233",
        primary_foreground: "#ffffff",
        accent_foreground: "#445566",
        source_hex: "#112233",
        site_title: "Site Extraído",
        site_description: null,
        suggested_segment: null,
      },
      error: null,
    });
    const user = userEvent.setup();
    renderWizard();
    await screen.findByLabelText("Nome da empresa / marca");

    await user.type(screen.getByPlaceholderText("https://seudominio.com.br"), "https://x.com.br");
    await user.click(screen.getByRole("button", { name: "Analisar site" }));
    await screen.findByText("Site Extraído");

    await user.click(screen.getByRole("button", { name: "Aplicar" }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("Nada para aplicar"));
  });

  it("mostra 'Tenant inválido' ao enviar logo sem tenant_id no perfil", async () => {
    useCurrentProfileMock.mockReturnValue({
      data: { id: "u1", tenant_id: undefined, name: "Ana", role: "admin" },
    });
    const user = userEvent.setup();
    renderWizard();
    await screen.findByLabelText("Nome da empresa / marca");

    const file = new File(["x"], "logo.png", { type: "image/png" });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, file);
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("Tenant inválido"));
  });
});

/* ================================================================== */
/* StepNicho                                                           */
/* ================================================================== */

describe("StepNicho", () => {
  it("'Avançar' sem modelo escolhido não sai do passo e avisa o usuário", async () => {
    const user = userEvent.setup();
    useNicheTemplatesMock.mockReturnValue({ data: [templateA], isLoading: false });
    useTenantOnboardingMock.mockReturnValue({ data: { niche: null } });
    renderWizard(vi.fn(), ONBOARDING_STEP_NICHO);

    await user.click(screen.getByRole("button", { name: /Avançar/i }));

    expect(await screen.findByText("Configuração inicial — Nicho")).toBeInTheDocument();
    expect(toastErrorMock).toHaveBeenCalledWith(
      'Escolha um modelo de funil para continuar — ou use "Pular" para configurar depois.',
    );
  });

  it("'Avançar' com modelo já aplicado segue para o próximo passo", async () => {
    const user = userEvent.setup();
    useNicheTemplatesMock.mockReturnValue({ data: [templateA], isLoading: false });
    useTenantOnboardingMock.mockReturnValue({ data: { niche: templateA.slug } });
    renderWizard(vi.fn(), ONBOARDING_STEP_NICHO);

    await user.click(screen.getByRole("button", { name: /Avançar/i }));

    expect(await screen.findByText("Configuração inicial — Canais")).toBeInTheDocument();
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("'Pular' continua saindo do passo sem escolher nicho", async () => {
    const user = userEvent.setup();
    useNicheTemplatesMock.mockReturnValue({ data: [templateA], isLoading: false });
    useTenantOnboardingMock.mockReturnValue({ data: { niche: null } });
    renderWizard(vi.fn(), ONBOARDING_STEP_NICHO);

    await user.click(screen.getByRole("button", { name: /^Pular$/ }));

    expect(await screen.findByText("Configuração inicial — Canais")).toBeInTheDocument();
  });

  it("mostra skeleton enquanto os templates carregam", async () => {
    useNicheTemplatesMock.mockReturnValue({ data: undefined, isLoading: true });
    const user = userEvent.setup();
    renderWizard();

    await advanceToStep(user, 1);

    expect(document.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  it("trata data indefinido dos templates como lista vazia", async () => {
    useNicheTemplatesMock.mockReturnValue({ data: undefined, isLoading: false });
    const user = userEvent.setup();
    renderWizard();

    await advanceToStep(user, 1);

    expect(screen.queryByRole("button", { name: "Escolher este modelo" })).not.toBeInTheDocument();
  });

  it("lista os templates e marca o nicho atual como 'Aplicado'", async () => {
    useNicheTemplatesMock.mockReturnValue({ data: [templateA, templateB], isLoading: false });
    useTenantOnboardingMock.mockReturnValue({ data: { niche: "servicos" } });
    const user = userEvent.setup();
    renderWizard();

    await advanceToStep(user, 1);

    expect(screen.getByText("Vendas B2B")).toBeInTheDocument();
    expect(screen.getByText("Serviços")).toBeInTheDocument();
    expect(screen.getByText("Aplicado")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reaplicar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Escolher este modelo" })).toBeInTheDocument();
  });

  it("não faz nada ao escolher modelo quando não há tenant_id no perfil", async () => {
    useCurrentProfileMock.mockReturnValue({ data: undefined });
    useNicheTemplatesMock.mockReturnValue({ data: [templateA], isLoading: false });
    const user = userEvent.setup();
    renderWizard();

    await advanceToStep(user, 1);
    await user.click(screen.getByRole("button", { name: "Escolher este modelo" }));

    expect(fetchDefaultBoardInfoMock).not.toHaveBeenCalled();
  });

  it("aplica direto quando o board padrão não tem estágios customizados", async () => {
    useNicheTemplatesMock.mockReturnValue({ data: [templateA], isLoading: false });
    const applyMutate = vi.fn();
    useApplyNicheTemplateMock.mockReturnValue({
      mutate: applyMutate,
      isPending: false,
      variables: undefined,
    });
    fetchDefaultBoardInfoMock.mockResolvedValue({ boardId: "b1", stageCount: 0, dealCount: 0 });
    const user = userEvent.setup();
    renderWizard();

    await advanceToStep(user, 1);
    await user.click(screen.getByRole("button", { name: "Escolher este modelo" }));

    await waitFor(() => expect(fetchDefaultBoardInfoMock).toHaveBeenCalledWith("t1"));
    await waitFor(() => expect(applyMutate).toHaveBeenCalledWith(templateA, expect.any(Object)));
    expect(screen.queryByText("Substituir funil existente?")).not.toBeInTheDocument();
  });

  it("abre diálogo de confirmação quando já existem estágios e negócios, e cancelar fecha", async () => {
    useNicheTemplatesMock.mockReturnValue({ data: [templateA], isLoading: false });
    fetchDefaultBoardInfoMock.mockResolvedValue({ boardId: "b1", stageCount: 3, dealCount: 5 });
    const user = userEvent.setup();
    renderWizard();

    await advanceToStep(user, 1);
    await user.click(screen.getByRole("button", { name: "Escolher este modelo" }));

    expect(await screen.findByText("Substituir funil existente?")).toBeInTheDocument();
    expect(screen.getByText(/3 estágios personalizados/)).toBeInTheDocument();
    expect(screen.getByText(/5 negócios cadastrados/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(screen.queryByText("Substituir funil existente?")).not.toBeInTheDocument();
  });

  it("não menciona negócios cadastrados quando dealCount é 0", async () => {
    useNicheTemplatesMock.mockReturnValue({ data: [templateA], isLoading: false });
    fetchDefaultBoardInfoMock.mockResolvedValue({ boardId: "b1", stageCount: 2, dealCount: 0 });
    const user = userEvent.setup();
    renderWizard();

    await advanceToStep(user, 1);
    await user.click(screen.getByRole("button", { name: "Escolher este modelo" }));

    expect(await screen.findByText("Substituir funil existente?")).toBeInTheDocument();
    expect(screen.queryByText(/negócios cadastrados/)).not.toBeInTheDocument();
  });

  it("confirmar substituição chama apply.mutate com o template pendente", async () => {
    useNicheTemplatesMock.mockReturnValue({ data: [templateA], isLoading: false });
    const applyMutate = vi.fn();
    useApplyNicheTemplateMock.mockReturnValue({
      mutate: applyMutate,
      isPending: false,
      variables: undefined,
    });
    fetchDefaultBoardInfoMock.mockResolvedValue({ boardId: "b1", stageCount: 3, dealCount: 0 });
    const user = userEvent.setup();
    renderWizard();

    await advanceToStep(user, 1);
    await user.click(screen.getByRole("button", { name: "Escolher este modelo" }));
    await user.click(await screen.findByRole("button", { name: "Substituir mesmo assim" }));

    expect(applyMutate).toHaveBeenCalledWith(templateA, expect.any(Object));
  });

  it("onSuccess do apply mostra toast e fecha o diálogo", async () => {
    useNicheTemplatesMock.mockReturnValue({ data: [templateA], isLoading: false });
    const applyMutate = vi.fn();
    useApplyNicheTemplateMock.mockReturnValue({
      mutate: applyMutate,
      isPending: false,
      variables: undefined,
    });
    fetchDefaultBoardInfoMock.mockResolvedValue({ boardId: "b1", stageCount: 3, dealCount: 0 });
    const user = userEvent.setup();
    renderWizard();

    await advanceToStep(user, 1);
    await user.click(screen.getByRole("button", { name: "Escolher este modelo" }));
    await user.click(await screen.findByRole("button", { name: "Substituir mesmo assim" }));

    const opts = applyMutate.mock.calls[0][1] as {
      onSuccess: () => void;
      onError: (e: Error) => void;
    };
    opts.onSuccess();

    expect(toastSuccessMock).toHaveBeenCalledWith('Modelo "Vendas B2B" aplicado.');
  });

  it("onError do apply mostra toast de erro com fallback quando sem mensagem", async () => {
    useNicheTemplatesMock.mockReturnValue({ data: [templateA], isLoading: false });
    const applyMutate = vi.fn();
    useApplyNicheTemplateMock.mockReturnValue({
      mutate: applyMutate,
      isPending: false,
      variables: undefined,
    });
    fetchDefaultBoardInfoMock.mockResolvedValue({ boardId: "b1", stageCount: 0, dealCount: 0 });
    const user = userEvent.setup();
    renderWizard();

    await advanceToStep(user, 1);
    await user.click(screen.getByRole("button", { name: "Escolher este modelo" }));

    await waitFor(() => expect(applyMutate).toHaveBeenCalled());
    const opts = applyMutate.mock.calls[0][1] as {
      onSuccess: () => void;
      onError: (e: Error) => void;
    };
    opts.onError({} as Error);

    expect(toastErrorMock).toHaveBeenCalledWith("Falha ao aplicar.");
  });

  it("mostra 'Aplicando…' apenas no card correspondente ao template pendente", async () => {
    useNicheTemplatesMock.mockReturnValue({ data: [templateA, templateB], isLoading: false });
    useApplyNicheTemplateMock.mockReturnValue({
      mutate: vi.fn(),
      isPending: true,
      variables: templateA,
    });
    const user = userEvent.setup();
    renderWizard();

    await advanceToStep(user, 1);

    expect(screen.getAllByText("Aplicando…")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Escolher este modelo" })).toBeInTheDocument();
  });
});

/* ================================================================== */
/* StepCanais                                                          */
/* ================================================================== */

const catalogAll = ["zapi", "meta-cloud", "twilio", "resend", "elevenlabs", "zappaz"].map(
  (slug) => ({
    slug,
    name: slug,
    description: "",
    icon: null,
    available: true,
    required_secrets: null,
    setup_steps: null,
  }),
);

describe("StepCanais", () => {
  it("mostra skeleton enquanto catálogo ou integrações do tenant carregam", async () => {
    useIntegrationsCatalogMock.mockReturnValue({ data: undefined, isLoading: true });
    const user = userEvent.setup();
    renderWizard();

    await advanceToStep(user, 2);

    expect(document.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  it("trata data indefinido das integrações do tenant como lista vazia", async () => {
    useIntegrationsCatalogMock.mockReturnValue({ data: catalogAll, isLoading: false });
    useTenantIntegrationsMock.mockReturnValue({ data: undefined, isLoading: false });
    const user = userEvent.setup();
    renderWizard();

    await advanceToStep(user, 2);

    expect(screen.getAllByTestId("integration-card")).toHaveLength(5);
  });

  it("mostra todos os canais com o Zappaz primeiro e sem link escondido", async () => {
    useIntegrationsCatalogMock.mockReturnValue({ data: catalogAll, isLoading: false });
    useTenantIntegrationsMock.mockReturnValue({ data: [], isLoading: false });
    const user = userEvent.setup();
    renderWizard();

    await advanceToStep(user, 2);

    const cards = screen.getAllByTestId("integration-card");
    expect(cards.map((c) => c.getAttribute("data-slug"))).toEqual([
      "zappaz",
      "meta-cloud",
      "twilio",
      "zapi",
      "elevenlabs",
    ]);
    expect(screen.queryByText(/Prefere a API oficial do WhatsApp/)).not.toBeInTheDocument();
  });

  // O Zappaz sumia do passo Canais porque a lista fixa de slugs não o incluía,
  // ainda que o catálogo do banco o traga como `available`. Guarda a PRESENÇA
  // (o teste de ordem acima guarda a posição, mas some junto se a lista mudar).
  it("oferece o Zappaz para conectar, mesmo com o catálogo em outra ordem", async () => {
    useIntegrationsCatalogMock.mockReturnValue({
      data: [...catalogAll].reverse(),
      isLoading: false,
    });
    useTenantIntegrationsMock.mockReturnValue({ data: [], isLoading: false });
    const user = userEvent.setup();
    renderWizard();

    await advanceToStep(user, 2);

    const slugs = screen.getAllByTestId("integration-card").map((c) => c.getAttribute("data-slug"));
    expect(slugs).toContain("zappaz");
    expect(slugs[0]).toBe("zappaz");
  });
});

/* ================================================================== */
/* StepPerfilNegocio                                                   */
/* ================================================================== */

describe("StepPerfilNegocio", () => {
  it("mostra skeleton enquanto o perfil do negócio carrega", async () => {
    const user = userEvent.setup();
    renderWizard();
    // deixa a query da StepEmpresa (passo 0) resolver antes de travar a próxima consulta a "tenants"
    await screen.findByDisplayValue("Empresa X");

    let resolvePending: (value: MockResult) => void = () => {};
    const pending = new Promise<MockResult>((resolve) => {
      resolvePending = resolve;
    });
    fromMock.mockImplementation((table: string) => {
      if (table === "tenants") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: () => pending }) }),
          // O save consolidado do passo 1 (Avançar) grava via update().eq() — resolve na hora
          // para que o wizard avance; só a leitura do perfil (select) fica pendente → skeleton.
          update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
        } as unknown as FakeQueryBuilder;
      }
      return makeQueryBuilder(table);
    });

    await user.click(screen.getByRole("button", { name: /Avançar/i }));
    // Passo do Nicho: sem modelo aplicado só "Pular" sai daqui.
    await user.click(screen.getByRole("button", { name: /^Pular$/ }));
    await user.click(screen.getByRole("button", { name: /Avançar/i }));
    await screen.findByText("Configuração inicial — Perfil do negócio");

    expect(document.querySelector(".animate-pulse")).toBeInTheDocument();

    resolvePending({ data: { business_profile: {} }, error: null });
    await screen.findByText("Time de atendimento");
  });

  it("salva o perfil ao clicar em Avançar e conclui o passo", async () => {
    const user = userEvent.setup();
    renderWizard();

    await advanceToStep(user, 3);
    await screen.findByText("Time de atendimento");
    await user.click(screen.getByRole("button", { name: /Avançar/i }));

    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("Perfil do negócio salvo"));
    expect(await screen.findByText("Passo 6 de 8")).toBeInTheDocument();
  });

  it("mostra toast de erro e permanece no passo quando falha salvar o perfil", async () => {
    const user = userEvent.setup();
    renderWizard();

    await advanceToStep(user, 3);
    await screen.findByText("Time de atendimento");
    // erro só a partir daqui — o save do passo 1 (Avançar) precisou ter sucesso para chegar até aqui
    setTableResult("tenants", "update", { data: null, error: new Error("falha perfil") });
    await user.click(screen.getByRole("button", { name: /Avançar/i }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("falha perfil"));
    expect(screen.getByText("Passo 5 de 8")).toBeInTheDocument();
  });

  it("usa mensagem padrão ao falhar salvar o perfil sem mensagem", async () => {
    const user = userEvent.setup();
    renderWizard();

    await advanceToStep(user, 3);
    await screen.findByText("Time de atendimento");
    setTableResult("tenants", "update", { data: null, error: {} });
    await user.click(screen.getByRole("button", { name: /Avançar/i }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("Erro ao salvar"));
    expect(screen.getByText("Passo 5 de 8")).toBeInTheDocument();
  });
});

/* ================================================================== */
/* StepEquipe                                                          */
/* ================================================================== */

describe("StepEquipe", () => {
  it("mostra 'Nenhum convite pendente' quando a lista está vazia", async () => {
    const user = userEvent.setup();
    renderWizard();

    await advanceToStep(user, 4);

    expect(await screen.findByText("Nenhum convite pendente.")).toBeInTheDocument();
  });

  it("trata data nulo da lista de convites como lista vazia", async () => {
    setTableResult("invites", "select", { data: null, error: null });
    const user = userEvent.setup();
    renderWizard();

    await advanceToStep(user, 4);

    expect(await screen.findByText("Nenhum convite pendente.")).toBeInTheDocument();
  });

  it("não quebra quando a lista de convites retorna erro", async () => {
    setTableResult("invites", "select", { data: null, error: new Error("erro convites") });
    const user = userEvent.setup();
    renderWizard();

    await advanceToStep(user, 4);

    expect(await screen.findByText("Nenhum convite pendente.")).toBeInTheDocument();
  });

  it("lista convites pendentes retornados", async () => {
    setTableResult("invites", "select", {
      data: [
        {
          id: "i1",
          email: "convidado@exemplo.com",
          role: "agent",
          token: "tok",
          expires_at: null,
          accepted_at: null,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      error: null,
    });
    const user = userEvent.setup();
    renderWizard();

    await advanceToStep(user, 4);

    expect(await screen.findByText("convidado@exemplo.com")).toBeInTheDocument();
    expect(screen.getByText("Papel: Atendente")).toBeInTheDocument();
  });

  it("lista convite pendente com papel admin", async () => {
    setTableResult("invites", "select", {
      data: [
        {
          id: "i2",
          email: "admin@exemplo.com",
          role: "admin",
          token: "tok2",
          expires_at: null,
          accepted_at: null,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      error: null,
    });
    const user = userEvent.setup();
    renderWizard();

    await advanceToStep(user, 4);

    expect(await screen.findByText("Papel: Administrador")).toBeInTheDocument();
  });

  it("desabilita 'Convidar' quando o email está vazio", async () => {
    const user = userEvent.setup();
    renderWizard();

    await advanceToStep(user, 4);

    expect(await screen.findByRole("button", { name: /Convidar/i })).toBeDisabled();
  });

  it("cria convite, copia o link e mostra mensagem de sucesso", async () => {
    setTableResult("invites", "insert", { data: { token: "abc123" }, error: null });
    const user = userEvent.setup();
    // userEvent.setup() reatribui navigator.clipboard ao seu próprio stub — precisa
    // sobrescrever DEPOIS de chamá-lo, senão o mock é descartado.
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeTextMock);
    renderWizard();

    await advanceToStep(user, 4);
    await user.type(screen.getByPlaceholderText("email@exemplo.com"), "novo@exemplo.com");
    await user.click(screen.getByRole("button", { name: /Convidar/i }));

    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("Convite criado"));
    await waitFor(() =>
      expect(writeTextMock).toHaveBeenCalledWith(expect.stringContaining("/auth?invite=abc123")),
    );
    expect(await screen.findByText(/link copiado/i)).toBeInTheDocument();
  });

  it("apaga o convite aberto do mesmo e-mail antes de criar o novo, ignorando maiúsculas", async () => {
    // Mesmo defeito do TeamTab: sem UNIQUE em (tenant_id, lower(email)), o papel
    // do convidado passaria a depender de qual link ele ainda tem em mãos.
    setTableResult("invites", "select", {
      data: [
        {
          id: "i-antigo",
          email: "Dup@Exemplo.com",
          role: "admin",
          token: "tok-antigo",
          expires_at: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
          accepted_at: null,
          created_at: new Date().toISOString(),
        },
      ],
      error: null,
    });
    const user = userEvent.setup({ delay: null });
    renderWizard();

    await advanceToStep(user, 4);
    await user.type(screen.getByPlaceholderText("email@exemplo.com"), "dup@exemplo.com");
    await user.click(screen.getByRole("button", { name: /Convidar/i }));

    await waitFor(() => expect(inSpy).toHaveBeenCalledWith("invites", "id", ["i-antigo"]));
    await waitFor(() =>
      expect(toastSuccessMock).toHaveBeenCalledWith(
        "Convite criado. O convite anterior para este e-mail deixou de valer.",
      ),
    );
  });

  it("não apaga nada e não cria convite quando a limpeza do duplicado falha", async () => {
    setTableResult("invites", "select", {
      data: [
        {
          id: "i-antigo",
          email: "dup2@exemplo.com",
          role: "admin",
          token: "tok-antigo",
          expires_at: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
          accepted_at: null,
          created_at: new Date().toISOString(),
        },
      ],
      error: null,
    });
    // Falha fechada: inserir mesmo assim recriaria a duplicidade em silêncio.
    setTableResult("invites", "delete", { data: null, error: new Error("Sem permissão") });
    const user = userEvent.setup({ delay: null });
    renderWizard();

    await advanceToStep(user, 4);
    await user.type(screen.getByPlaceholderText("email@exemplo.com"), "dup2@exemplo.com");
    await user.click(screen.getByRole("button", { name: /Convidar/i }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("Sem permissão"));
    expect(screen.queryByText(/link copiado/i)).not.toBeInTheDocument();
  });

  it("não quebra quando o clipboard falha ao copiar o link", async () => {
    const user = userEvent.setup();
    const writeTextMock = vi.fn().mockRejectedValue(new Error("sem permissão"));
    setClipboard(writeTextMock);
    renderWizard();

    await advanceToStep(user, 4);
    await user.type(screen.getByPlaceholderText("email@exemplo.com"), "novo2@exemplo.com");
    await user.click(screen.getByRole("button", { name: /Convidar/i }));

    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("Convite criado"));
  });

  it("mostra toast de erro ao falhar criar convite", async () => {
    setTableResult("invites", "insert", { data: null, error: new Error("email inválido") });
    const user = userEvent.setup();
    renderWizard();

    await advanceToStep(user, 4);
    await user.type(screen.getByPlaceholderText("email@exemplo.com"), "x@x.com");
    await user.click(screen.getByRole("button", { name: /Convidar/i }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("email inválido"));
  });

  it("mostra toast de erro com mensagem padrão ao falhar criar convite sem mensagem", async () => {
    setTableResult("invites", "insert", { data: null, error: {} });
    const user = userEvent.setup();
    renderWizard();

    await advanceToStep(user, 4);
    await user.type(screen.getByPlaceholderText("email@exemplo.com"), "x@x.com");
    await user.click(screen.getByRole("button", { name: /Convidar/i }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("Erro ao criar convite"));
  });

  it("cancela convite e invalida a lista de convites", async () => {
    setTableResult("invites", "select", {
      data: [
        {
          id: "i1",
          email: "a@b.com",
          role: "agent",
          token: "t",
          expires_at: null,
          accepted_at: null,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      error: null,
    });
    const user = userEvent.setup();
    renderWizard();

    await advanceToStep(user, 4);
    await screen.findByText("a@b.com");
    const callsBefore = fromMock.mock.calls.filter(([t]) => t === "invites").length;

    await user.click(screen.getByRole("button", { name: /Cancelar/i }));

    await waitFor(() => {
      const callsAfter = fromMock.mock.calls.filter(([t]) => t === "invites").length;
      expect(callsAfter).toBeGreaterThan(callsBefore);
    });
  });

  it("troca o papel do convite via select", async () => {
    const user = userEvent.setup();
    renderWizard();

    await advanceToStep(user, 4);
    const trigger = await screen.findByRole("combobox");
    expect(trigger).toHaveTextContent("Atendente");

    await user.click(trigger);
    const adminOption = await screen.findByRole("option", { name: "Administrador" });
    await user.click(adminOption);

    expect(trigger).toHaveTextContent("Administrador");
  });

  it("mostra 'Criando…' enquanto o convite está sendo criado", async () => {
    const user = userEvent.setup();
    renderWizard();

    await advanceToStep(user, 4);
    await user.type(screen.getByPlaceholderText("email@exemplo.com"), "pendente@exemplo.com");

    const { resolve } = stallTable("invites");
    await user.click(screen.getByRole("button", { name: /Convidar/i }));

    expect(await screen.findByText("Criando…")).toBeInTheDocument();
    resolve({ data: { token: "tok" }, error: null });
    // restaura o comportamento normal por tabela/operação antes do refetch disparado pelo invalidateQueries
    fromMock.mockImplementation((t: string) => makeQueryBuilder(t));

    await waitFor(() => expect(screen.queryByText("Criando…")).not.toBeInTheDocument());
  });

  it("mostra 'Tenant inválido' ao criar convite sem tenant_id no perfil", async () => {
    useCurrentProfileMock.mockReturnValue({
      data: { id: "u1", tenant_id: undefined, name: "Ana", role: "admin" },
    });
    const user = userEvent.setup();
    renderWizard();

    await advanceToStep(user, 4);
    expect(await screen.findByText("Nenhum convite pendente.")).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("email@exemplo.com"), "x@x.com");
    await user.click(screen.getByRole("button", { name: /Convidar/i }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("Tenant inválido"));
  });
});

/* ================================================================== */
/* StepImportarContatos                                               */
/* ================================================================== */

describe("StepImportarContatos", () => {
  it("é o penúltimo passo (6 de 7) e mostra o botão de importar", async () => {
    const user = userEvent.setup();
    renderWizard();

    await advanceToStep(user, 5);

    expect(screen.getByText("Passo 7 de 8")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Importar contatos via CSV" })).toBeInTheDocument();
  });

  it("'Pular por enquanto' sai do assistente sem concluir a configuração", async () => {
    const user = userEvent.setup();
    const mutateMock = vi.fn();
    useCompleteOnboardingMock.mockReturnValue({ mutate: mutateMock, isPending: false });
    const onOpenChange = vi.fn();
    renderWizard(onOpenChange);

    await advanceToStep(user, 6);
    await user.click(screen.getByRole("button", { name: "Pular por enquanto" }));

    expect(mutateMock).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("'Concluir' finaliza o onboarding sem exigir import", async () => {
    const user = userEvent.setup();
    const mutateMock = vi.fn();
    useCompleteOnboardingMock.mockReturnValue({ mutate: mutateMock, isPending: false });
    renderWizard();

    await advanceToStep(user, 6);
    await user.click(screen.getByRole("button", { name: "Concluir" }));

    expect(mutateMock).toHaveBeenCalledTimes(1);
  });

  it("clicar em 'Importar contatos via CSV' abre o ContactImportDialog (reaproveita o mesmo hook/lógica de import, sem duplicar parsing)", async () => {
    const user = userEvent.setup();
    renderWizard();

    await advanceToStep(user, 5);
    await user.click(screen.getByRole("button", { name: "Importar contatos via CSV" }));

    // Texto vindo de dentro do ContactImportDialog real (não duplicado aqui) —
    // confirma que é o mesmo componente/hook usado pelo import standalone de Contatos.
    expect(
      await screen.findByText("Selecione um arquivo CSV com sua base de contatos."),
    ).toBeInTheDocument();
  });
});

/* ================================================================== */
/* Fluxo completo — passos 1 a 4 + submit                              */
/* ================================================================== */

describe("OnboardingWizard - fluxo completo do passo 1 ao 4", () => {
  /** Catálogo mínimo de canais de conversa e voz usado no passo "Canais". */
  const conversationCatalog = [
    { slug: "zappaz", name: "Zappaz" },
    { slug: "meta-cloud", name: "Meta Cloud" },
    { slug: "zapi", name: "Z-API" },
    { slug: "elevenlabs", name: "ElevenLabs" },
  ];

  /**
   * Simula a escolha real de um modelo de nicho: `useApplyNicheTemplate` é
   * mockado, então o "nicho aplicado" vive aqui e `useTenantOnboarding` passa
   * a devolvê-lo depois do clique — é isso que libera o "Avançar" do passo 2.
   */
  function setupNicheFlow() {
    // Store externo mínimo: o hook mockado precisa ser reativo, senão aplicar
    // o modelo não re-renderiza o passo e o "Avançar" continuaria bloqueado.
    let niche: string | null = null;
    const listeners = new Set<() => void>();
    const subscribe = (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    };
    const getSnapshot = () => niche;
    useNicheTemplatesMock.mockReturnValue({ data: [templateA, templateB], isLoading: false });
    useTenantOnboardingMock.mockImplementation(() => ({
      data: { niche: useSyncExternalStore(subscribe, getSnapshot, getSnapshot) },
    }));
    const applyMutate = vi.fn(
      (t: NicheTemplate, opts?: { onSuccess?: () => void; onError?: (e: Error) => void }) => {
        niche = t.slug;
        for (const fn of listeners) fn();
        opts?.onSuccess?.();
      },
    );
    useApplyNicheTemplateMock.mockReturnValue({
      mutate: applyMutate,
      isPending: false,
      variables: undefined,
    });
    return { applyMutate };
  }

  it("navega do passo 1 ao 4, mostra WhatsApp e Voz nos canais e conclui o assistente", async () => {
    const user = userEvent.setup();
    const completeMutate = vi.fn();
    const onOpenChange = vi.fn();
    useCompleteOnboardingMock.mockReturnValue({ mutate: completeMutate, isPending: false });
    useIntegrationsCatalogMock.mockReturnValue({ data: conversationCatalog, isLoading: false });
    const { applyMutate } = setupNicheFlow();

    renderWizard(onOpenChange);

    /* ---- Passo 1 — Empresa ---- */
    expect(await screen.findByText("Configuração inicial — Empresa")).toBeInTheDocument();
    expect(screen.getByText("Passo 2 de 8")).toBeInTheDocument();

    const nameInput = await screen.findByLabelText("Nome da empresa / marca");
    await user.clear(nameInput);
    await user.type(nameInput, "Clínica Aurora");
    await user.type(screen.getByLabelText("Segmento"), "clínica médica");
    await user.click(screen.getByRole("button", { name: /Avançar/i }));

    // O passo 1 persiste antes de navegar.
    await waitFor(() =>
      expect(updateSpy).toHaveBeenCalledWith(
        "tenants",
        expect.objectContaining({ name: "Clínica Aurora" }),
      ),
    );

    /* ---- Passo 2 — Nicho ---- */
    expect(await screen.findByText("Configuração inicial — Nicho")).toBeInTheDocument();
    expect(screen.getByText("Passo 3 de 8")).toBeInTheDocument();

    // Sem modelo escolhido, "Avançar" segura o usuário no passo.
    await user.click(screen.getByRole("button", { name: /Avançar/i }));
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    expect(screen.getByText("Passo 3 de 8")).toBeInTheDocument();

    const pickButtons = screen.getAllByRole("button", { name: "Escolher este modelo" });
    await user.click(pickButtons[0]);
    await waitFor(() => expect(applyMutate).toHaveBeenCalledTimes(1));
    expect(applyMutate.mock.calls[0][0].slug).toBe(templateA.slug);
    await screen.findByText("Aplicado");

    await user.click(screen.getByRole("button", { name: /Avançar/i }));

    /* ---- Passo 3 — Canais (WhatsApp e Voz) ---- */
    expect(await screen.findByText("Configuração inicial — Canais")).toBeInTheDocument();
    expect(screen.getByText("Passo 4 de 8")).toBeInTheDocument();
    const chips = screen.getByText(/Voz \(IA\)/);
    expect(chips).toHaveTextContent("WhatsApp");
    expect(chips).toHaveTextContent("Voz (IA)");
    // E-mail saiu deste passo — não pode voltar por acidente.
    expect(screen.queryByText(/E-mail/i)).not.toBeInTheDocument();

    const cards = screen.getAllByTestId("integration-card");
    expect(cards.map((c) => c.getAttribute("data-slug"))).toEqual([
      "zappaz",
      "meta-cloud",
      "zapi",
      "elevenlabs",
    ]);

    await user.click(screen.getByRole("button", { name: /Avançar/i }));

    /* ---- Passo 4 — Perfil do negócio ---- */
    expect(await screen.findByText("Configuração inicial — Perfil do negócio")).toBeInTheDocument();
    expect(screen.getByText("Passo 5 de 8")).toBeInTheDocument();

    updateSpy.mockClear();
    await user.type(await screen.findByLabelText("Cidade"), "São Paulo");
    await user.click(screen.getByRole("button", { name: /Avançar/i }));

    await waitFor(() =>
      expect(updateSpy).toHaveBeenCalledWith(
        "tenants",
        expect.objectContaining({
          business_profile: expect.objectContaining({ city: "São Paulo" }),
        }),
      ),
    );

    /* ---- Passos 5 a 7 até o submit ---- */
    expect(await screen.findByText("Passo 6 de 8")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Pular$/ }));
    expect(await screen.findByText("Passo 7 de 8")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Pular$/ }));
    expect(await screen.findByText("Passo 8 de 8")).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "Concluir" }));

    expect(completeMutate).toHaveBeenCalledTimes(1);
    const opts = completeMutate.mock.calls[0][1] as {
      onSuccess: (r: CompleteOnboardingResult) => void;
    };
    opts.onSuccess({
      scheduledJobsActivated: true,
      vaultMissing: [],
    } as CompleteOnboardingResult);

    expect(toastSuccessMock).toHaveBeenCalledWith("Configuração inicial concluída.");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
