import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { AiFeaturesTab } from "./AiFeaturesTab";

const useCurrentProfileMock = vi.fn();
const catalogSelectOrderMock = vi.fn();
const toggleUpsertMock = vi.fn();
const personaMaybeSingleMock = vi.fn();
const personaUpsertMock = vi.fn();
const fromMock = vi.fn();

vi.mock("@/lib/api/session", () => ({
  useCurrentProfile: () => useCurrentProfileMock(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (...args: unknown[]) => fromMock(...args),
  },
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function tableImpl(table: string) {
  if (table === "ai_settings") {
    return {
      select: () => ({ eq: () => ({ maybeSingle: () => personaMaybeSingleMock() }) }),
      upsert: personaUpsertMock,
    };
  }
  if (table === "ai_feature_catalog") {
    return { select: () => ({ order: () => catalogSelectOrderMock() }) };
  }
  if (table === "tenant_ai_features") {
    return { upsert: toggleUpsertMock };
  }
  throw new Error(`tabela inesperada nesta suíte: ${table}`);
}

function renderTab() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
  const utils = render(
    <QueryClientProvider client={qc}>
      <AiFeaturesTab />
    </QueryClientProvider>,
  );
  return { ...utils, invalidateSpy };
}

describe("AiFeaturesTab", () => {
  beforeEach(() => {
    useCurrentProfileMock.mockReset();
    catalogSelectOrderMock.mockReset();
    toggleUpsertMock.mockReset();
    personaMaybeSingleMock.mockReset();
    personaUpsertMock.mockReset();
    fromMock.mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();

    useCurrentProfileMock.mockReturnValue({
      data: { id: "profile-1", tenant_id: "tenant-1", role: "admin" },
    });
    toggleUpsertMock.mockResolvedValue({ error: null });
    personaMaybeSingleMock.mockResolvedValue({ data: null, error: null });
    personaUpsertMock.mockResolvedValue({ error: null });
    catalogSelectOrderMock.mockResolvedValue({ data: [], error: null });
    fromMock.mockImplementation(tableImpl);
  });

  it("renderiza um switch interativo para feature com toggle_authority='tenant_admin'", async () => {
    catalogSelectOrderMock.mockResolvedValue({
      data: [
        {
          feature_key: "hitl_stage_advance_banding",
          label: "Aprovação humana para avanço de estágio",
          description: "Descrição da feature",
          default_enabled: false,
          toggle_authority: "tenant_admin",
          tenant_ai_features: [{ enabled: true }],
        },
      ],
      error: null,
    });

    renderTab();

    const toggle = await screen.findByRole("switch", {
      name: "Aprovação humana para avanço de estágio",
    });
    expect(toggle).toBeInTheDocument();
    expect(toggle).toBeEnabled();
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Descrição da feature")).toBeInTheDocument();
  });

  it("renderiza estado read-only (sem switch) para feature com toggle_authority='operator'", async () => {
    catalogSelectOrderMock.mockResolvedValue({
      data: [
        {
          feature_key: "some_operator_feature",
          label: "Feature gerida pelo operador",
          description: null,
          default_enabled: true,
          toggle_authority: "operator",
          tenant_ai_features: [],
        },
      ],
      error: null,
    });

    renderTab();

    expect(await screen.findByText("Feature gerida pelo operador")).toBeInTheDocument();
    expect(screen.getByText(/Ligada.*Gerenciada pela Acelera IA/)).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("ao togglar uma feature tenant_admin, chama upsert com tenant_id/feature_key/enabled corretos", async () => {
    catalogSelectOrderMock.mockResolvedValue({
      data: [
        {
          feature_key: "hitl_stage_advance_banding",
          label: "Aprovação humana para avanço de estágio",
          description: null,
          default_enabled: false,
          toggle_authority: "tenant_admin",
          tenant_ai_features: [{ enabled: false }],
        },
      ],
      error: null,
    });

    const user = userEvent.setup();
    renderTab();

    const toggle = await screen.findByRole("switch", {
      name: "Aprovação humana para avanço de estágio",
    });
    await user.click(toggle);

    await waitFor(() => expect(toggleUpsertMock).toHaveBeenCalledTimes(1));
    expect(toggleUpsertMock).toHaveBeenCalledWith(
      {
        tenant_id: "tenant-1",
        feature_key: "hitl_stage_advance_banding",
        enabled: true,
        updated_by: "profile-1",
      },
      { onConflict: "tenant_id,feature_key" },
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it("mostra toast de erro quando falha ao alternar uma feature", async () => {
    catalogSelectOrderMock.mockResolvedValue({
      data: [
        {
          feature_key: "hitl_stage_advance_banding",
          label: "Aprovação humana para avanço de estágio",
          description: null,
          default_enabled: false,
          toggle_authority: "tenant_admin",
          tenant_ai_features: [{ enabled: false }],
        },
      ],
      error: null,
    });
    toggleUpsertMock.mockResolvedValue({ error: new Error("falha ao atualizar feature") });

    const user = userEvent.setup();
    renderTab();

    const toggle = await screen.findByRole("switch", {
      name: "Aprovação humana para avanço de estágio",
    });
    await user.click(toggle);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("falha ao atualizar feature"));
  });

  it("trata toggle_authority desconhecido como somente-leitura (fallback null)", async () => {
    catalogSelectOrderMock.mockResolvedValue({
      data: [
        {
          feature_key: "feature_legado",
          label: "Feature de configuração legada",
          description: null,
          default_enabled: true,
          toggle_authority: "algo_desconhecido",
          tenant_ai_features: [],
        },
      ],
      error: null,
    });

    renderTab();

    expect(await screen.findByText("Feature de configuração legada")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.getByText(/Ligada.*Gerenciada pela Acelera IA/)).toBeInTheDocument();
  });

  it("mostra o skeleton do catálogo enquanto a lista de features carrega", () => {
    catalogSelectOrderMock.mockImplementation(() => new Promise(() => {}));

    renderTab();

    expect(screen.queryByText("Sem features de IA")).not.toBeInTheDocument();
    expect(screen.getByText("Features de IA")).toBeInTheDocument();
  });

  it("mostra estado vazio quando o catálogo não tem nenhuma feature", async () => {
    catalogSelectOrderMock.mockResolvedValue({ data: [], error: null });

    renderTab();

    expect(await screen.findByText("Sem features de IA")).toBeInTheDocument();
    expect(
      screen.getByText("Nenhuma feature de IA disponível no catálogo ainda."),
    ).toBeInTheDocument();
  });
});

describe("AiFeaturesTab -- Persona da IA", () => {
  beforeEach(() => {
    useCurrentProfileMock.mockReset();
    catalogSelectOrderMock.mockReset();
    toggleUpsertMock.mockReset();
    personaMaybeSingleMock.mockReset();
    personaUpsertMock.mockReset();
    fromMock.mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();

    useCurrentProfileMock.mockReturnValue({
      data: { id: "profile-1", tenant_id: "tenant-1", role: "admin" },
    });
    toggleUpsertMock.mockResolvedValue({ error: null });
    personaMaybeSingleMock.mockResolvedValue({ data: null, error: null });
    personaUpsertMock.mockResolvedValue({ error: null });
    catalogSelectOrderMock.mockResolvedValue({ data: [], error: null });
    fromMock.mockImplementation(tableImpl);
  });

  it("mostra o skeleton enquanto a persona carrega, sem os campos", () => {
    personaMaybeSingleMock.mockImplementation(() => new Promise(() => {}));

    renderTab();

    expect(screen.getByText("Persona da IA")).toBeInTheDocument();
    expect(screen.queryByLabelText("Nome da IA")).not.toBeInTheDocument();
  });

  it("preenche nome e emoji com os dados existentes da persona", async () => {
    personaMaybeSingleMock.mockResolvedValue({
      data: { ai_name: "Sofia", ai_avatar_emoji: "🤖" },
      error: null,
    });

    renderTab();

    await waitFor(() => expect(screen.getByLabelText("Nome da IA")).toHaveValue("Sofia"));
    expect(screen.getByLabelText("Avatar (emoji)")).toHaveValue("🤖");
  });

  it("usa campos vazios quando a persona ainda não tem nome/emoji definidos", async () => {
    personaMaybeSingleMock.mockResolvedValue({
      data: { ai_name: null, ai_avatar_emoji: null },
      error: null,
    });

    renderTab();

    await waitFor(() => expect(screen.getByLabelText("Nome da IA")).toBeInTheDocument());
    expect(screen.getByLabelText("Nome da IA")).toHaveValue("");
    expect(screen.getByLabelText("Avatar (emoji)")).toHaveValue("");
  });

  it("botão Salvar persona começa desabilitado e habilita após editar um campo", async () => {
    const user = userEvent.setup();
    renderTab();

    const saveButton = await screen.findByRole("button", { name: "Salvar persona" });
    expect(saveButton).toBeDisabled();

    await user.type(screen.getByLabelText("Nome da IA"), "Sofia");
    expect(saveButton).toBeEnabled();
  });

  it("salva a persona com trim, envia null quando o emoji fica vazio, e reseta dirty após sucesso", async () => {
    const user = userEvent.setup();
    renderTab();

    const nameInput = await screen.findByLabelText("Nome da IA");
    await user.type(nameInput, "  Sofia  ");
    const saveButton = screen.getByRole("button", { name: "Salvar persona" });
    await user.click(saveButton);

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Persona da IA salva."));
    expect(personaUpsertMock).toHaveBeenCalledWith(
      { tenant_id: "tenant-1", ai_name: "Sofia", ai_avatar_emoji: null },
      { onConflict: "tenant_id" },
    );
    await waitFor(() => expect(saveButton).toBeDisabled());
  });

  it("mostra toast de erro quando falha ao salvar a persona", async () => {
    personaUpsertMock.mockResolvedValue({ error: new Error("falha ao salvar") });
    const user = userEvent.setup();
    renderTab();

    const nameInput = await screen.findByLabelText("Nome da IA");
    await user.type(nameInput, "Sofia");
    await user.click(screen.getByRole("button", { name: "Salvar persona" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("falha ao salvar"));
  });

  it("sem tenant_id (perfil ainda carregando), não consulta nem envia nada ao Supabase", () => {
    useCurrentProfileMock.mockReturnValue({ data: undefined });

    renderTab();

    expect(fromMock).not.toHaveBeenCalled();
  });
});
