import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { BusinessProfileTab } from "./BusinessProfileTab";
import type { BusinessProfile } from "./BusinessProfileForm";

const useCurrentProfileMock = vi.fn();
const maybeSingleMock = vi.fn();
const updateEqMock = vi.fn();
const updateMock = vi.fn();
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

vi.mock("./BusinessProfileForm", async () => {
  const actual =
    await vi.importActual<typeof import("./BusinessProfileForm")>("./BusinessProfileForm");
  return {
    ...actual,
    BusinessProfileForm: ({
      value,
      onChange,
    }: {
      value: BusinessProfile;
      onChange: (v: BusinessProfile) => void;
    }) => (
      <input
        aria-label="segmento-stub"
        value={value.segment}
        onChange={(e) => onChange({ ...value, segment: e.target.value })}
      />
    ),
  };
});

function renderTab() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
  const utils = render(
    <QueryClientProvider client={qc}>
      <BusinessProfileTab />
    </QueryClientProvider>,
  );
  return { ...utils, invalidateSpy };
}

function eqMaybeSingleChain() {
  return { eq: () => ({ maybeSingle: () => maybeSingleMock() }) };
}

describe("BusinessProfileTab", () => {
  beforeEach(() => {
    useCurrentProfileMock.mockReset();
    maybeSingleMock.mockReset();
    updateEqMock.mockReset();
    updateMock.mockReset();
    fromMock.mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();

    useCurrentProfileMock.mockReturnValue({ data: { tenant_id: "tenant-1" } });
    maybeSingleMock.mockResolvedValue({ data: { business_profile: null }, error: null });
    updateEqMock.mockResolvedValue({ error: null });
    updateMock.mockReturnValue({ eq: updateEqMock });
    fromMock.mockReturnValue({ select: () => eqMaybeSingleChain(), update: updateMock });
  });

  it("mostra o skeleton enquanto a query do tenant carrega", () => {
    maybeSingleMock.mockImplementation(() => new Promise(() => {}));

    renderTab();

    expect(screen.queryByText("Perfil do negócio")).not.toBeInTheDocument();
  });

  it("renderiza o card com título e botão Salvar após carregar", async () => {
    renderTab();

    expect(await screen.findByText("Perfil do negócio")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Salvar perfil" })).toBeInTheDocument();
  });

  it("popula o formulário com o business_profile normalizado vindo do tenant", async () => {
    maybeSingleMock.mockResolvedValue({
      data: { business_profile: { segment: "Clínica odontológica" } },
      error: null,
    });

    renderTab();

    await waitFor(() =>
      expect(screen.getByLabelText("segmento-stub")).toHaveValue("Clínica odontológica"),
    );
  });

  it("não busca quando o perfil não tem tenant_id", () => {
    useCurrentProfileMock.mockReturnValue({ data: undefined });

    renderTab();

    expect(fromMock).not.toHaveBeenCalled();
  });

  it("salva o perfil e mostra toast de sucesso, invalidando a query", async () => {
    const user = userEvent.setup();
    const { invalidateSpy } = renderTab();

    await screen.findByText("Perfil do negócio");
    await user.click(screen.getByRole("button", { name: "Salvar perfil" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Perfil do negócio salvo"));
    expect(updateEqMock).toHaveBeenCalledWith("id", "tenant-1");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["tenant-business-profile"] });
  });

  it("envia o value atual (editado) como business_profile serializado", async () => {
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Perfil do negócio");
    await user.type(screen.getByLabelText("segmento-stub"), "Barbearia");
    await user.click(screen.getByRole("button", { name: "Salvar perfil" }));

    await waitFor(() => expect(updateMock).toHaveBeenCalled());
    const payload = updateMock.mock.calls[0][0] as { business_profile: { segment: string } };
    expect(payload.business_profile.segment).toBe("Barbearia");
  });

  it("mostra toast de erro com a mensagem da exceção quando o update falha", async () => {
    const user = userEvent.setup();
    updateEqMock.mockResolvedValue({ error: new Error("Falha ao salvar perfil") });
    renderTab();

    await screen.findByText("Perfil do negócio");
    await user.click(screen.getByRole("button", { name: "Salvar perfil" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Falha ao salvar perfil"));
  });

  it('usa a mensagem padrão "Erro ao salvar" quando o erro do update não tem mensagem', async () => {
    const user = userEvent.setup();
    updateEqMock.mockResolvedValue({ error: {} });
    renderTab();

    await screen.findByText("Perfil do negócio");
    await user.click(screen.getByRole("button", { name: "Salvar perfil" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Erro ao salvar"));
  });

  it("não quebra quando a query do tenant falha — renderiza o card com valor padrão", async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: new Error("Falha ao buscar") });
    renderTab();

    expect(await screen.findByText("Perfil do negócio")).toBeInTheDocument();
    expect(screen.getByLabelText("segmento-stub")).toHaveValue("");
  });

  it('mostra "Salvando…" e desabilita o botão enquanto a mutation está pendente', async () => {
    const user = userEvent.setup();
    let resolveUpdate: (value: { error: null }) => void = () => {};
    updateEqMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpdate = resolve;
        }),
    );
    renderTab();

    await screen.findByText("Perfil do negócio");
    await user.click(screen.getByRole("button", { name: "Salvar perfil" }));

    const pendingButton = await screen.findByRole("button", { name: "Salvando…" });
    expect(pendingButton).toBeDisabled();

    resolveUpdate({ error: null });
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it("lança erro quando não há tenantId ao tentar salvar (mutação chamada sem tenant)", async () => {
    // O botão de salvar só aparece após a query resolver; sem tenantId a query fica desabilitada
    // mas o card ainda renderiza (isLoading é false quando a query está desabilitada).
    useCurrentProfileMock.mockReturnValue({ data: undefined });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Perfil do negócio");
    await user.click(screen.getByRole("button", { name: "Salvar perfil" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Tenant inválido"));
    expect(updateMock).not.toHaveBeenCalled();
  });
});
