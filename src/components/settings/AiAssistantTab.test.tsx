import { describe, expect, it, vi, beforeEach } from "vitest";
import type * as AiConfigApi from "@/lib/api/ai-config";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { useCurrentProfile, type CurrentProfile } from "@/lib/api/session";
import {
  useTenantAiEnabled,
  useSetTenantAiEnabled,
  useAiSettings,
  useUpdateAiSettings,
  useStagesWithConfig,
  useUpsertStageConfig,
  playgroundChat,
  type AiSettings,
  type StageWithConfig,
} from "@/lib/api/ai-config";
import { useRecentAiFailureCount } from "@/lib/api/ai-failure-logs";
import { useTenantChannels, type ChannelRow } from "@/lib/api/integrations";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { renderWithQueryClient } from "@/test/render";
import {
  asFromMock,
  createFromByTable,
  createFromQueue,
  createPendingQueryBuilder,
  ok,
  fail,
  type QueryResult,
} from "@/test/supabase-mock";
import { AiAssistantTab } from "./AiAssistantTab";

vi.mock("@/lib/api/session", () => ({
  useCurrentProfile: vi.fn(),
}));

vi.mock("@/lib/api/ai-config", async (importOriginal) => ({
  ...(await importOriginal<typeof AiConfigApi>()),
  useTenantAiEnabled: vi.fn(),
  useSetTenantAiEnabled: vi.fn(),
  useAiSettings: vi.fn(),
  useUpdateAiSettings: vi.fn(),
  useStagesWithConfig: vi.fn(),
  useUpsertStageConfig: vi.fn(),
  playgroundChat: vi.fn(),
}));

// Hook isolado (mesmo motivo de @/lib/api/ai-config acima): a página não deve
// depender da query real de contagem de falhas para os testes das outras
// cards, e o link "N falhas recentes" ganha seus próprios testes abaixo.
vi.mock("@/lib/api/ai-failure-logs", () => ({
  useRecentAiFailureCount: vi.fn(),
}));

// Mock PARCIAL: só useTenantChannels precisa ser controlado (ele chama
// supabase.rpc, que não existe no mock de client abaixo). useIntegration
// continua real porque os testes de VoiceReplyCard o alimentam por
// tenant_integrations no createFromByTable.
vi.mock("@/lib/api/integrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/integrations")>()),
  useTenantChannels: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Evita que a persona real (useAiPersona) consuma slots do createFromQueue
// FIFO usado nos testes de mutação abaixo — mesmo padrão de isolar hooks
// cross-cutting já usado para @/lib/api/ai-config.
vi.mock("@/components/ai/ai-persona-badge", () => ({
  AiPersonaBadge: () => <span>IA</span>,
}));

// <Link> do TanStack Router precisa de RouterProvider real (useLinkProps
// acessa contexto do router) — este arquivo renderiza <AssistentePage />
// isolado, então trocamos por uma <a> simples (mesmo helper compartilhado
// usado em _app.contatos.test.tsx e outras rotas com Link).
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { routerOverrides } = await import("@/test/router-mocks");
  return { ...actual, ...routerOverrides() };
});

const AssistentePage = AiAssistantTab;

interface MutateOpts {
  onSuccess?: (data?: unknown) => void;
  onError?: (e: Error) => void;
}

function mockProfile(profile: Partial<CurrentProfile> | null, isLoading = false) {
  vi.mocked(useCurrentProfile).mockReturnValue({
    data: profile ? { id: "u1", tenant_id: "t1", name: "Ana", role: "admin", ...profile } : null,
    isLoading,
  } as ReturnType<typeof useCurrentProfile>);
}

function mockMutation(
  overrides: { isPending?: boolean; behavior?: "success" | "error"; errorMessage?: string } = {},
) {
  const { isPending = false, behavior = "success", errorMessage = "Falha." } = overrides;
  const mutate = vi.fn((_vars: unknown, opts?: MutateOpts) => {
    if (behavior === "success") opts?.onSuccess?.();
    else opts?.onError?.(new Error(errorMessage));
  });
  return { mutate, isPending };
}

const DEFAULT_SETTINGS: AiSettings = {
  tenant_id: "t1",
  base_system_prompt: "Você é a assistente de {{empresa}}.",
  handoff_default_keywords: ["atendente"],
};

function mockAiSettings(data: AiSettings | undefined = DEFAULT_SETTINGS, isLoading = false) {
  vi.mocked(useAiSettings).mockReturnValue({
    data,
    isLoading,
  } as ReturnType<typeof useAiSettings>);
}

function mockStages(data: StageWithConfig[] = [], isLoading = false) {
  vi.mocked(useStagesWithConfig).mockReturnValue({
    data,
    isLoading,
  } as ReturnType<typeof useStagesWithConfig>);
}

function mockSendMode(result: QueryResult<{ send_mode: string | null }>) {
  vi.mocked(supabase.from).mockImplementation(createFromByTable({ ai_settings: result }));
}

const STAGE_1: StageWithConfig = {
  stage_id: "s1",
  stage_name: "Qualificação",
  position: 1,
  is_won: false,
  is_lost: false,
  enabled: true,
  stage_goal: "Entender a necessidade do lead.",
  system_prompt: "Pergunte sobre o orçamento disponível.",
  advancement_criteria: ["Lead informou orçamento"],
  handoff_keywords: ["gerente"],
};

beforeEach(() => {
  mockProfile({ role: "admin" });
  vi.mocked(useTenantAiEnabled).mockReturnValue({
    data: false,
    isLoading: false,
  } as ReturnType<typeof useTenantAiEnabled>);
  vi.mocked(useSetTenantAiEnabled).mockReturnValue(
    mockMutation() as unknown as ReturnType<typeof useSetTenantAiEnabled>,
  );
  mockAiSettings();
  vi.mocked(useUpdateAiSettings).mockReturnValue(
    mockMutation() as unknown as ReturnType<typeof useUpdateAiSettings>,
  );
  mockStages([]);
  vi.mocked(useUpsertStageConfig).mockReturnValue(
    mockMutation() as unknown as ReturnType<typeof useUpsertStageConfig>,
  );
  vi.mocked(playgroundChat).mockResolvedValue({ reply: "Resposta padrão da IA." });
  mockSendMode(ok({ send_mode: "auto" }));
  vi.mocked(useRecentAiFailureCount).mockReturnValue(0);
  mockChannels([]);
});

function mockChannels(data: Partial<ChannelRow>[]) {
  vi.mocked(useTenantChannels).mockReturnValue({
    data: data as ChannelRow[],
    isLoading: false,
  } as ReturnType<typeof useTenantChannels>);
}

/** Abre o diálogo de confirmação clicando no switch de ativação. */
async function pedirParaLigar(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByLabelText("Ativar assistente de IA"));
  return screen.findByRole("alertdialog");
}

// head()/gate de admin não são mais responsabilidade deste componente --
// AiAssistantTab é uma aba dentro de /configuracoes, que já cuida de SEO e
// do gate de admin (ver _app.configuracoes.test.tsx). Redirect da antiga
// rota /assistente tem teste próprio em _app.assistente.test.tsx.

describe("AiAssistantTab (aba 'Assistente IA' em Configurações)", () => {
  it("mostra as abas de configuração e playground", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<AssistentePage />);

    expect(screen.getByText("IA")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Configuração" })).toBeInTheDocument();
    expect(screen.getByText("Prompt base")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Área de teste" }));
    expect(await screen.findByText("Ambiente de teste")).toBeInTheDocument();
  });
});

describe("GeneralToggle", () => {
  it("mostra o switch desabilitado enquanto carrega", () => {
    vi.mocked(useTenantAiEnabled).mockReturnValue({
      data: undefined,
      isLoading: true,
    } as ReturnType<typeof useTenantAiEnabled>);
    renderWithQueryClient(<AssistentePage />);
    expect(screen.getByLabelText("Ativar assistente de IA")).toBeDisabled();
  });

  // Este é o teste do achado: antes, um clique já colocava a IA para
  // responder lead de verdade. Sem a confirmação ele falha na primeira
  // asserção.
  it("não liga a IA no clique — só depois de confirmar", async () => {
    const setEnabled = mockMutation();
    vi.mocked(useSetTenantAiEnabled).mockReturnValue(
      setEnabled as unknown as ReturnType<typeof useSetTenantAiEnabled>,
    );
    const user = userEvent.setup();
    renderWithQueryClient(<AssistentePage />);

    await pedirParaLigar(user);
    expect(setEnabled.mutate).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Ligar a IA" }));
    expect(setEnabled.mutate).toHaveBeenCalledWith(true, expect.anything());
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("IA ativada."));
  });

  it("desiste da ativação sem tocar na configuração", async () => {
    const setEnabled = mockMutation();
    vi.mocked(useSetTenantAiEnabled).mockReturnValue(
      setEnabled as unknown as ReturnType<typeof useSetTenantAiEnabled>,
    );
    const user = userEvent.setup();
    renderWithQueryClient(<AssistentePage />);

    await pedirParaLigar(user);
    await user.click(screen.getByRole("button", { name: "Agora não" }));

    expect(setEnabled.mutate).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Ativar assistente de IA")).not.toBeChecked();
  });

  it("avisa que não há canal conectado e que o envio é automático", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<AssistentePage />);

    const dialog = await pedirParaLigar(user);
    expect(dialog).toHaveTextContent(/Nenhum canal conectado ainda/);
    expect(dialog).toHaveTextContent(/vai direto para o cliente, sem ninguém revisar/);
  });

  it("reconhece canal conectado e modo rascunho", async () => {
    mockChannels([{ id: "c1", provider_slug: "evolution", status: "connected" }]);
    mockSendMode(ok({ send_mode: "draft" }));
    const user = userEvent.setup();
    renderWithQueryClient(<AssistentePage />);

    const dialog = await pedirParaLigar(user);
    await waitFor(() => expect(dialog).toHaveTextContent(/Você tem um canal conectado/));
    await waitFor(() => expect(dialog).toHaveTextContent(/esperando alguém do time aprovar/));
  });

  it("leva para a área de teste sem ligar a IA", async () => {
    const setEnabled = mockMutation();
    vi.mocked(useSetTenantAiEnabled).mockReturnValue(
      setEnabled as unknown as ReturnType<typeof useSetTenantAiEnabled>,
    );
    const user = userEvent.setup();
    renderWithQueryClient(<AssistentePage />);

    await pedirParaLigar(user);
    await user.click(screen.getByRole("button", { name: "Testar antes" }));

    expect(setEnabled.mutate).not.toHaveBeenCalled();
    expect(await screen.findByText("Ambiente de teste")).toBeInTheDocument();
  });

  it("desligar continua imediato, sem confirmação", async () => {
    vi.mocked(useTenantAiEnabled).mockReturnValue({
      data: true,
      isLoading: false,
    } as ReturnType<typeof useTenantAiEnabled>);
    const setEnabled = mockMutation();
    vi.mocked(useSetTenantAiEnabled).mockReturnValue(
      setEnabled as unknown as ReturnType<typeof useSetTenantAiEnabled>,
    );
    const user = userEvent.setup();
    renderWithQueryClient(<AssistentePage />);

    await user.click(screen.getByLabelText("Ativar assistente de IA"));

    expect(setEnabled.mutate).toHaveBeenCalledWith(false, expect.anything());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("IA desativada."));
  });

  it("mostra toast de erro quando falha ao atualizar", async () => {
    const setEnabled = mockMutation({ behavior: "error", errorMessage: "Falha ao alternar." });
    vi.mocked(useSetTenantAiEnabled).mockReturnValue(
      setEnabled as unknown as ReturnType<typeof useSetTenantAiEnabled>,
    );
    const user = userEvent.setup();
    renderWithQueryClient(<AssistentePage />);

    await pedirParaLigar(user);
    await user.click(screen.getByRole("button", { name: "Ligar a IA" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Falha ao alternar."));
  });
});

describe("PromptCard", () => {
  it("mostra skeleton enquanto carrega o prompt", () => {
    mockAiSettings(undefined, true);
    renderWithQueryClient(<AssistentePage />);
    expect(screen.queryByLabelText("Prompt base do assistente")).not.toBeInTheDocument();
  });

  it("carrega o prompt salvo e mostra a contagem de caracteres", () => {
    renderWithQueryClient(<AssistentePage />);
    const textarea = screen.getByLabelText("Prompt base do assistente");
    expect(textarea).toHaveValue(DEFAULT_SETTINGS.base_system_prompt);
    expect(
      screen.getByText(`${DEFAULT_SETTINGS.base_system_prompt.length} / 8000 caracteres`),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Salvar prompt/ })).toBeDisabled();
  });

  it("habilita salvar após editar e envia o novo texto", async () => {
    const updatePrompt = mockMutation();
    vi.mocked(useUpdateAiSettings).mockReturnValue(
      updatePrompt as unknown as ReturnType<typeof useUpdateAiSettings>,
    );
    const user = userEvent.setup();
    renderWithQueryClient(<AssistentePage />);

    const textarea = screen.getByLabelText("Prompt base do assistente");
    await user.clear(textarea);
    await user.type(textarea, "Novo prompt de teste.");

    const saveButton = screen.getByRole("button", { name: /Salvar prompt/ });
    expect(saveButton).not.toBeDisabled();
    await user.click(saveButton);

    expect(updatePrompt.mutate).toHaveBeenCalledWith(
      { base_system_prompt: "Novo prompt de teste." },
      expect.anything(),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Prompt base salvo."));
    expect(screen.getByText("Salvo")).toBeInTheDocument();
  });

  // Antes este teste travava o TRUNCAMENTO. Truncar apagava conteúdo já salvo:
  // os 5 tenants de produção têm prompt acima do teto antigo de 4000 (até 6091),
  // e a primeira
  // tecla digitada cortava o excedente para sempre. Agora o passar do limite é
  // avisado, não executado.
  it("passa do tamanho recomendado sem apagar nada, e avisa", async () => {
    renderWithQueryClient(<AssistentePage />);
    const textarea = screen.getByLabelText("Prompt base do assistente");
    const longText = "a".repeat(8005);

    await userEvent.setup().type(textarea, "x");
    // Simula colar um texto muito longo diretamente.
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    nativeInputValueSetter?.call(textarea, longText);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));

    await waitFor(() =>
      expect(
        screen.getByText(/8005 \/ 8000 caracteres — prompt longo encarece cada mensagem/),
      ).toBeInTheDocument(),
    );
    expect(textarea).toHaveValue(longText);
    // E continua salvável: o teto é recomendação, não trava.
    expect(screen.getByRole("button", { name: /Salvar prompt/ })).toBeEnabled();
  });

  it("mostra toast de erro ao falhar o salvamento do prompt", async () => {
    const updatePrompt = mockMutation({ behavior: "error", errorMessage: "Falha ao salvar." });
    vi.mocked(useUpdateAiSettings).mockReturnValue(
      updatePrompt as unknown as ReturnType<typeof useUpdateAiSettings>,
    );
    const user = userEvent.setup();
    renderWithQueryClient(<AssistentePage />);

    const textarea = screen.getByLabelText("Prompt base do assistente");
    await user.type(textarea, " extra");
    await user.click(screen.getByRole("button", { name: /Salvar prompt/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Falha ao salvar."));
  });
});

describe("SendModeCard", () => {
  it("mostra skeleton enquanto carrega o modo de envio", () => {
    vi.mocked(supabase.from).mockImplementation(asFromMock(() => createPendingQueryBuilder()));
    renderWithQueryClient(<AssistentePage />);
    expect(screen.queryByRole("radio", { name: "Automático" })).not.toBeInTheDocument();
  });

  it("seleciona automático por padrão", async () => {
    renderWithQueryClient(<AssistentePage />);
    const auto = await screen.findByRole("radio", { name: "Automático" });
    expect(auto).toBeChecked();
  });

  it("muda para modo rascunho e mostra toast de sucesso", async () => {
    mockSendMode(ok({ send_mode: "auto" }));
    vi.mocked(supabase.from).mockImplementation(
      createFromQueue([ok({ send_mode: "auto" }), ok({ send_mode: "draft" })]),
    );
    const user = userEvent.setup();
    renderWithQueryClient(<AssistentePage />);

    await screen.findByRole("radio", { name: "Automático" });
    await user.click(screen.getByRole("radio", { name: "Rascunho para aprovação" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Modo rascunho ativado."));
  });

  it("mostra toast de erro ao falhar a atualização do modo de envio", async () => {
    vi.mocked(supabase.from).mockImplementation(
      createFromQueue([ok({ send_mode: "auto" }), fail("Falha ao salvar modo.")]),
    );
    const user = userEvent.setup();
    renderWithQueryClient(<AssistentePage />);

    await screen.findByRole("radio", { name: "Automático" });
    await user.click(screen.getByRole("radio", { name: "Rascunho para aprovação" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Falha ao salvar modo."));
  });

  it("mantém automático como padrão quando a busca do modo de envio falha", async () => {
    mockSendMode(fail("Erro ao buscar modo."));
    renderWithQueryClient(<AssistentePage />);

    expect(await screen.findByRole("radio", { name: "Automático" })).toBeChecked();
  });

  it("mostra toast de erro ao trocar o modo sem tenant carregado", async () => {
    mockProfile({ tenant_id: undefined });
    const user = userEvent.setup();
    renderWithQueryClient(<AssistentePage />);

    await user.click(screen.getByRole("radio", { name: "Rascunho para aprovação" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Sem tenant."));
  });
});

describe("HandoffDefaultsCard", () => {
  it("mostra as palavras já configuradas", () => {
    renderWithQueryClient(<AssistentePage />);
    expect(screen.getByText("atendente")).toBeInTheDocument();
    expect(screen.getByLabelText("Remover atendente")).toBeInTheDocument();
  });

  it("mostra mensagem quando não há palavras configuradas", () => {
    mockAiSettings({ ...DEFAULT_SETTINGS, handoff_default_keywords: [] });
    renderWithQueryClient(<AssistentePage />);
    expect(screen.getByText("Nenhuma palavra configurada.")).toBeInTheDocument();
  });

  it("adiciona uma nova palavra e salva", async () => {
    const updateKeywords = mockMutation();
    vi.mocked(useUpdateAiSettings).mockReturnValue(
      updateKeywords as unknown as ReturnType<typeof useUpdateAiSettings>,
    );
    const user = userEvent.setup();
    renderWithQueryClient(<AssistentePage />);

    const input = screen.getByPlaceholderText("Digite uma palavra e pressione Enter");
    await user.type(input, "gerente{Enter}");

    expect(screen.getByText("gerente")).toBeInTheDocument();

    const saveButtons = screen.getAllByRole("button", { name: "Salvar" });
    await user.click(saveButtons[0]);

    expect(updateKeywords.mutate).toHaveBeenCalledWith(
      { handoff_default_keywords: ["atendente", "gerente"] },
      expect.anything(),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Palavras de transferência atualizadas."),
    );
  });

  it("ignora palavra duplicada (case-insensitive) e não habilita salvar", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<AssistentePage />);

    const input = screen.getByPlaceholderText("Digite uma palavra e pressione Enter");
    await user.type(input, "ATENDENTE{Enter}");

    expect(screen.getAllByText("atendente")).toHaveLength(1);
    const saveButtons = screen.getAllByRole("button", { name: "Salvar" });
    expect(saveButtons[0]).toBeDisabled();
  });

  it("ignora clique em Adicionar quando o campo está vazio", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<AssistentePage />);

    const addButtons = screen.getAllByRole("button", { name: "Adicionar" });
    await user.click(addButtons[0]);

    expect(screen.getAllByText("atendente")).toHaveLength(1);
    const saveButtons = screen.getAllByRole("button", { name: "Salvar" });
    expect(saveButtons[0]).toBeDisabled();
  });

  it("remove uma palavra existente", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<AssistentePage />);

    await user.click(screen.getByLabelText("Remover atendente"));
    expect(screen.getByText("Nenhuma palavra configurada.")).toBeInTheDocument();
  });

  it("mostra toast de erro ao falhar salvar as palavras", async () => {
    const updateKeywords = mockMutation({
      behavior: "error",
      errorMessage: "Falha ao salvar palavras.",
    });
    vi.mocked(useUpdateAiSettings).mockReturnValue(
      updateKeywords as unknown as ReturnType<typeof useUpdateAiSettings>,
    );
    const user = userEvent.setup();
    renderWithQueryClient(<AssistentePage />);

    await user.click(screen.getByLabelText("Remover atendente"));
    const saveButtons = screen.getAllByRole("button", { name: "Salvar" });
    await user.click(saveButtons[0]);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Falha ao salvar palavras."));
  });
});

describe("StagesCard e StageEditor", () => {
  it("mostra skeleton enquanto carrega os estágios", () => {
    mockStages([], true);
    renderWithQueryClient(<AssistentePage />);
    expect(screen.queryByText("Nenhum estágio no funil")).not.toBeInTheDocument();
  });

  it("mostra estado vazio quando não há estágios no funil", () => {
    renderWithQueryClient(<AssistentePage />);
    expect(screen.getByText("Nenhum estágio no funil")).toBeInTheDocument();
  });

  it("lista os estágios com objetivo, critérios e palavras", () => {
    mockStages([STAGE_1]);
    renderWithQueryClient(<AssistentePage />);

    expect(screen.getByText("Qualificação")).toBeInTheDocument();
    expect(screen.getByText("Entender a necessidade do lead.")).toBeInTheDocument();
    expect(screen.getByText("Lead informou orçamento")).toBeInTheDocument();
    expect(screen.getByText("gerente")).toBeInTheDocument();
    expect(screen.getByLabelText("Ativar IA no estágio Qualificação")).toBeChecked();
  });

  it("expande o estágio e mostra o editor com os valores atuais", async () => {
    mockStages([STAGE_1]);
    const user = userEvent.setup();
    renderWithQueryClient(<AssistentePage />);

    await user.click(screen.getByRole("button", { name: /Qualificação/ }));

    expect(await screen.findByLabelText("Objetivo do estágio")).toHaveValue(STAGE_1.stage_goal);
    expect(screen.getByLabelText("Prompt do estágio")).toHaveValue(STAGE_1.system_prompt);
  });

  it("adiciona e remove um critério de avanço no editor", async () => {
    mockStages([STAGE_1]);
    const user = userEvent.setup();
    renderWithQueryClient(<AssistentePage />);
    await user.click(screen.getByRole("button", { name: /Qualificação/ }));
    await screen.findByLabelText("Objetivo do estágio");

    const criterionInput = screen.getByPlaceholderText("Ex.: Lead confirmou orçamento e prazo");
    await user.type(criterionInput, "Lead confirmou prazo{Enter}");
    expect(screen.getByText("Lead confirmou prazo")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Remover critério Lead informou orçamento"));
    // A linha resumida do estágio (fora do editor) mantém o valor antigo até salvar;
    // só a lista de critérios dentro do editor deve perder o item removido.
    expect(
      screen.queryByLabelText("Remover critério Lead informou orçamento"),
    ).not.toBeInTheDocument();
  });

  it("salva o estágio editado", async () => {
    mockStages([STAGE_1]);
    const upsert = mockMutation();
    vi.mocked(useUpsertStageConfig).mockReturnValue(
      upsert as unknown as ReturnType<typeof useUpsertStageConfig>,
    );
    const user = userEvent.setup();
    renderWithQueryClient(<AssistentePage />);
    await user.click(screen.getByRole("button", { name: /Qualificação/ }));

    const goalTextarea = await screen.findByLabelText("Objetivo do estágio");
    await user.clear(goalTextarea);
    await user.type(goalTextarea, "Novo objetivo.");

    await user.click(screen.getByRole("button", { name: /Salvar estágio/ }));

    expect(upsert.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ stage_id: "s1", stage_goal: "Novo objetivo." }),
      expect.anything(),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Estágio salvo."));
  });

  it("mostra toast de erro ao falhar salvar o estágio", async () => {
    mockStages([STAGE_1]);
    const upsert = mockMutation({ behavior: "error", errorMessage: "Falha ao salvar estágio." });
    vi.mocked(useUpsertStageConfig).mockReturnValue(
      upsert as unknown as ReturnType<typeof useUpsertStageConfig>,
    );
    const user = userEvent.setup();
    renderWithQueryClient(<AssistentePage />);
    await user.click(screen.getByRole("button", { name: /Qualificação/ }));
    await screen.findByLabelText("Objetivo do estágio");

    await user.click(screen.getByRole("button", { name: /Salvar estágio/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Falha ao salvar estágio."));
  });

  it("edita o prompt do estágio e adiciona/remove uma palavra de transferência", async () => {
    mockStages([STAGE_1]);
    const upsert = mockMutation();
    vi.mocked(useUpsertStageConfig).mockReturnValue(
      upsert as unknown as ReturnType<typeof useUpsertStageConfig>,
    );
    const user = userEvent.setup();
    renderWithQueryClient(<AssistentePage />);
    await user.click(screen.getByRole("button", { name: /Qualificação/ }));

    const promptTextarea = await screen.findByLabelText("Prompt do estágio");
    await user.clear(promptTextarea);
    await user.type(promptTextarea, "Novo prompt do estágio.");

    // O mesmo placeholder é usado pelo campo de palavras-padrão (HandoffDefaultsCard);
    // o segundo campo na ordem do DOM é o do editor de estágio, já expandido.
    const keywordInputs = screen.getAllByPlaceholderText("Digite uma palavra e pressione Enter");
    const keywordInput = keywordInputs[keywordInputs.length - 1];
    await user.type(keywordInput, "financeiro{Enter}");
    expect(screen.getByText("financeiro")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Remover gerente"));
    expect(screen.queryByLabelText("Remover gerente")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Salvar estágio/ }));

    expect(upsert.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        stage_id: "s1",
        system_prompt: "Novo prompt do estágio.",
        handoff_keywords: ["financeiro"],
      }),
      expect.anything(),
    );
  });

  it("expande o estágio pelo teclado (Enter)", async () => {
    mockStages([STAGE_1]);
    renderWithQueryClient(<AssistentePage />);

    const trigger = screen.getByRole("button", { name: /Qualificação/ });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });

    expect(await screen.findByLabelText("Objetivo do estágio")).toBeInTheDocument();
  });

  it("ativa e desativa a IA de um estágio pelo switch da linha", async () => {
    mockStages([STAGE_1]);
    const upsert = mockMutation();
    vi.mocked(useUpsertStageConfig).mockReturnValue(
      upsert as unknown as ReturnType<typeof useUpsertStageConfig>,
    );
    const user = userEvent.setup();
    renderWithQueryClient(<AssistentePage />);

    await user.click(screen.getByLabelText("Ativar IA no estágio Qualificação"));

    expect(upsert.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ stage_id: "s1", enabled: false }),
      expect.anything(),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('IA pausada em "Qualificação".'),
    );
  });

  it("mostra toast de erro ao falhar alternar a IA de um estágio pelo switch da linha", async () => {
    mockStages([STAGE_1]);
    const upsert = mockMutation({
      behavior: "error",
      errorMessage: "Falha ao alternar estágio.",
    });
    vi.mocked(useUpsertStageConfig).mockReturnValue(
      upsert as unknown as ReturnType<typeof useUpsertStageConfig>,
    );
    const user = userEvent.setup();
    renderWithQueryClient(<AssistentePage />);

    await user.click(screen.getByLabelText("Ativar IA no estágio Qualificação"));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Falha ao alternar estágio."));
  });
});

describe("PlaygroundCard", () => {
  async function openPlayground(user: ReturnType<typeof userEvent.setup>) {
    renderWithQueryClient(<AssistentePage />);
    await user.click(screen.getByRole("tab", { name: "Área de teste" }));
    await screen.findByText("Ambiente de teste");
  }

  it("mostra o aviso de ambiente de teste e desabilita enviar sem texto", async () => {
    const user = userEvent.setup();
    await openPlayground(user);

    expect(
      screen.getByText(
        "Nada aqui é enviado por WhatsApp ou e-mail. A conversa não vira negócio, não cria atividades e some ao limpar.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Enviar/ })).toBeDisabled();
    expect(
      screen.getByText("Envie a primeira mensagem como se você fosse o lead."),
    ).toBeInTheDocument();
  });

  it("envia uma mensagem e mostra a resposta da IA", async () => {
    vi.mocked(playgroundChat).mockResolvedValue({ reply: "Olá! Como posso ajudar?" });
    const user = userEvent.setup();
    await openPlayground(user);

    const textarea = screen.getByLabelText("Mensagem de teste");
    await user.type(textarea, "Quero saber o preço");
    await user.click(screen.getByRole("button", { name: /Enviar/ }));

    expect(await screen.findByText("Olá! Como posso ajudar?")).toBeInTheDocument();
    expect(screen.getByText("Quero saber o preço")).toBeInTheDocument();
    expect(playgroundChat).toHaveBeenCalledWith({
      stage_id: null,
      messages: [{ role: "user", content: "Quero saber o preço" }],
    });
  });

  it("traduz [TRANSFERIR_HUMANO] em vez de mostrar o token cru", async () => {
    vi.mocked(playgroundChat).mockResolvedValue({ reply: "[TRANSFERIR_HUMANO]" });
    const user = userEvent.setup();
    await openPlayground(user);

    const textarea = screen.getByLabelText("Mensagem de teste");
    await user.type(textarea, "pergunta fora do escopo");
    await user.click(screen.getByRole("button", { name: /Enviar/ }));

    expect(await screen.findByText(/transferiria para um humano/i)).toBeInTheDocument();
    expect(screen.queryByText(/TRANSFERIR_HUMANO/)).not.toBeInTheDocument();
  });

  it("envia a mensagem com Enter (sem shift)", async () => {
    vi.mocked(playgroundChat).mockResolvedValue({ reply: "Resposta rápida." });
    const user = userEvent.setup();
    await openPlayground(user);

    const textarea = screen.getByLabelText("Mensagem de teste");
    await user.type(textarea, "Oi{Enter}");

    expect(await screen.findByText("Resposta rápida.")).toBeInTheDocument();
  });

  it("mostra toast de erro quando a IA falha ao responder", async () => {
    vi.mocked(playgroundChat).mockRejectedValue(new Error("Falha ao gerar resposta."));
    const user = userEvent.setup();
    await openPlayground(user);

    const textarea = screen.getByLabelText("Mensagem de teste");
    await user.type(textarea, "Teste de erro");
    await user.click(screen.getByRole("button", { name: /Enviar/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Falha ao gerar resposta."));
    expect(screen.getByText("Teste de erro")).toBeInTheDocument();
  });

  it("envia o estágio selecionado no payload", async () => {
    mockStages([STAGE_1]);
    vi.mocked(playgroundChat).mockResolvedValue({ reply: "Ok." });
    const user = userEvent.setup();
    await openPlayground(user);

    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Qualificação" }));

    const textarea = screen.getByLabelText("Mensagem de teste");
    await user.type(textarea, "Mensagem com estágio");
    await user.click(screen.getByRole("button", { name: /Enviar/ }));

    await waitFor(() =>
      expect(playgroundChat).toHaveBeenCalledWith({
        stage_id: "s1",
        messages: [{ role: "user", content: "Mensagem com estágio" }],
      }),
    );
  });

  it("limpa a conversa", async () => {
    vi.mocked(playgroundChat).mockResolvedValue({ reply: "Resposta." });
    const user = userEvent.setup();
    await openPlayground(user);

    const textarea = screen.getByLabelText("Mensagem de teste");
    await user.type(textarea, "Mensagem para limpar");
    await user.click(screen.getByRole("button", { name: /Enviar/ }));
    await screen.findByText("Resposta.");

    const clearButton = screen.getByRole("button", { name: "Limpar conversa" });
    expect(clearButton).not.toBeDisabled();
    await user.click(clearButton);

    expect(
      screen.getByText("Envie a primeira mensagem como se você fosse o lead."),
    ).toBeInTheDocument();
    expect(clearButton).toBeDisabled();
  });
});

describe("EditPersonaLink", () => {
  // Este teste travava o bug: "#ia" é resolvido por AiSettingsTab para a
  // sub-aba "assistente", que é esta mesma — o card "Persona da IA" vive em
  // "ia/features".
  it("mostra o atalho 'Editar persona' apontando para a sub-aba de features", () => {
    renderWithQueryClient(<AssistentePage />);

    const link = screen.getByRole("link", { name: /Editar persona/ });
    expect(link).toHaveAttribute("href", "/configuracoes#ia/features");
  });
});

describe("RecentAiFailuresLink", () => {
  it("não mostra nada quando não há falhas recentes", () => {
    vi.mocked(useRecentAiFailureCount).mockReturnValue(0);
    renderWithQueryClient(<AssistentePage />);

    expect(screen.queryByRole("link", { name: /falha/ })).not.toBeInTheDocument();
  });

  it("mostra o link no singular apontando para a aba de falhas em Configurações", () => {
    vi.mocked(useRecentAiFailureCount).mockReturnValue(1);
    renderWithQueryClient(<AssistentePage />);

    const link = screen.getByRole("link", { name: "1 falha recente" });
    expect(link).toHaveAttribute("href", "/configuracoes#ia/falhas");
  });

  it("mostra o link no plural apontando para a aba de falhas quando há mais de 1 falha recente", () => {
    vi.mocked(useRecentAiFailureCount).mockReturnValue(5);
    renderWithQueryClient(<AssistentePage />);

    const link = screen.getByRole("link", { name: "5 falhas recentes" });
    expect(link).toHaveAttribute("href", "/configuracoes#ia/falhas");
  });
});

describe("VoiceReplyCard", () => {
  // Ambos os cards de ai_settings leem a MESMA tabela, então createFromByTable
  // (resolve por nome, não por ordem de chamada) evita que o card de voz
  // "roube" a resposta do card de modo de envio.
  const voiceRow = (over: Record<string, unknown> = {}) =>
    createFromByTable({
      ai_settings: ok({ send_mode: "auto", voice_reply_mode: "off", voice_id: null, ...over }),
      tenant_integrations: ok([{ slug: "elevenlabs", status: "active", config: null }]),
    });

  it("começa em 'Sempre em texto' e não pede voz", async () => {
    vi.mocked(supabase.from).mockImplementation(voiceRow());
    renderWithQueryClient(<AssistentePage />);

    const texto = await screen.findByRole("radio", { name: "Sempre em texto" });
    expect(texto).toBeChecked();
    // Sem áudio ligado, pedir ID de voz seria ruído — e o custo por caractere
    // só existe quando o modo sai de "off".
    expect(screen.queryByLabelText("Voz da ElevenLabs")).not.toBeInTheDocument();
  });

  // Regressão: o card só tratava `isLoading`. Em `isError` renderizava com
  // `voice === undefined`, e `?? "off"` marcava "Sempre em texto" como se fosse
  // o valor salvo — inclusive no cenário que a própria queryFn prevê (migration
  // versionada e ainda não aplicada). A mutation tem toast de erro; a leitura
  // não tinha nada, e não existe QueryCache.onError global.
  it("falha ao LER avisa e não deixa 'Sempre em texto' passar por valor salvo", async () => {
    vi.mocked(supabase.from).mockImplementation(
      createFromByTable({
        ai_settings: {
          data: null,
          error: { message: "permission denied for table ai_settings", code: "42501" } as never,
        },
        tenant_integrations: ok([{ slug: "elevenlabs", status: "active", config: null }]),
      }),
    );
    renderWithQueryClient(<AssistentePage />);

    expect(
      await screen.findByText("Não foi possível ler o comportamento da IA"),
    ).toBeInTheDocument();
    // E o controle fica travado: mudar de opção agora gravaria por cima de um
    // estado que nunca foi lido.
    expect(await screen.findByRole("radio", { name: "Sempre em texto" })).toBeDisabled();
  });

  it("ao ligar áudio, pede o ID da voz", async () => {
    vi.mocked(supabase.from).mockImplementation(voiceRow({ voice_reply_mode: "always" }));
    renderWithQueryClient(<AssistentePage />);

    expect(await screen.findByRole("radio", { name: "Sempre em áudio" })).toBeChecked();
    expect(await screen.findByLabelText("Voz da ElevenLabs")).toBeInTheDocument();
  });

  it("troca o modo e confirma com toast", async () => {
    vi.mocked(supabase.from).mockImplementation(voiceRow());
    const user = userEvent.setup();
    renderWithQueryClient(<AssistentePage />);

    await screen.findByRole("radio", { name: "Sempre em texto" });
    await user.click(screen.getByRole("radio", { name: "Espelhar o cliente" }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Preferência de voz atualizada."),
    );
  });

  it("avisa quando a ElevenLabs não está conectada", async () => {
    vi.mocked(supabase.from).mockImplementation(
      createFromByTable({
        ai_settings: ok({ send_mode: "auto", voice_reply_mode: "always", voice_id: "v1" }),
        tenant_integrations: ok([]),
      }),
    );
    renderWithQueryClient(<AssistentePage />);

    // Sem esse aviso o usuário marca "sempre em áudio", não recebe áudio
    // nenhum e não tem como saber por quê.
    expect(await screen.findByText("ElevenLabs não conectada")).toBeInTheDocument();
  });
});

describe("Comportamento das respostas", () => {
  it("mostra defaults atuais sem configuração do tenant", async () => {
    renderWithQueryClient(<AssistentePage />);

    expect(await screen.findByText("Comportamento das respostas")).toBeInTheDocument();
    expect(await screen.findByLabelText("Máximo de blocos por resposta")).toHaveValue(1);
    expect(screen.getByLabelText("Intervalo entre blocos (ms)")).toHaveValue(1200);
    expect(screen.getByLabelText("Janela de agrupamento (ms)")).toHaveValue(3000);
  });

  it("salva os limites no tenant atual sem sobrescrever o prompt", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const readFrom = createFromByTable({
      ai_settings: ok({
        send_mode: "auto",
        max_response_blocks: 2,
        response_block_delay_ms: 800,
        message_coalesce_window_ms: 5000,
        voice_reply_mode: "off",
      }),
      tenant_integrations: ok([]),
    });
    vi.mocked(supabase.from).mockImplementation(
      asFromMock((table) => {
        const chain = readFrom(table);
        return { ...chain, upsert };
      }),
    );
    const user = userEvent.setup();
    renderWithQueryClient(<AssistentePage />);
    const blocks = await screen.findByLabelText("Máximo de blocos por resposta");
    await user.clear(blocks);
    await user.type(blocks, "3");
    await user.click(screen.getByRole("button", { name: "Salvar comportamento" }));

    await waitFor(() =>
      expect(upsert).toHaveBeenCalledWith(
        {
          tenant_id: "t1",
          max_response_blocks: 3,
          response_block_delay_ms: 800,
          message_coalesce_window_ms: 5000,
        },
        { onConflict: "tenant_id" },
      ),
    );
  });

  it("bloqueia o orçamento combinado acima de 90000 ms e aceita a fronteira", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<AssistentePage />);
    const blocks = await screen.findByLabelText("Máximo de blocos por resposta");
    const delay = screen.getByLabelText("Intervalo entre blocos (ms)");
    const window = screen.getByLabelText("Janela de agrupamento (ms)");
    await user.clear(blocks);
    await user.type(blocks, "5");
    await user.clear(delay);
    await user.type(delay, "10000");
    await user.clear(window);
    await user.type(window, "50001");

    expect(screen.getByRole("button", { name: "Salvar comportamento" })).toBeDisabled();
    expect(screen.getByRole("alert", { name: "Tempo de espera excedido" })).toHaveTextContent(
      "90.000 ms",
    );
    await user.clear(window);
    await user.type(window, "50000");
    expect(screen.getByRole("button", { name: "Salvar comportamento" })).toBeEnabled();
    expect(
      screen.queryByRole("alert", { name: "Tempo de espera excedido" }),
    ).not.toBeInTheDocument();
  });

  it.each([
    ["Máximo de blocos por resposta", "6"],
    ["Máximo de blocos por resposta", "1.5"],
    ["Intervalo entre blocos (ms)", "-1"],
    ["Intervalo entre blocos (ms)", "10001"],
    ["Janela de agrupamento (ms)", "120001"],
    ["Janela de agrupamento (ms)", ""],
  ])("impede salvar %s fora da faixa: %s", async (label, value) => {
    const user = userEvent.setup();
    renderWithQueryClient(<AssistentePage />);
    const input = await screen.findByLabelText(label);
    await user.clear(input);
    if (value) await user.type(input, value);

    expect(screen.getByRole("button", { name: "Salvar comportamento" })).toBeDisabled();
    expect(input).toHaveAttribute("aria-invalid", "true");
  });
});
