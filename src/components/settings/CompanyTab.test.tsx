import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { CompanyTab } from "./CompanyTab";

const useCurrentProfileMock = vi.fn();
const maybeSingleMock = vi.fn();
const updateEqMock = vi.fn();
const updateSelectMock = vi.fn();
const updateMock = vi.fn();
const fromMock = vi.fn();
const storageUploadMock = vi.fn();
const createSignedUrlMock = vi.fn();

vi.mock("@/lib/api/session", () => ({
  useCurrentProfile: () => useCurrentProfileMock(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (...args: unknown[]) => fromMock(...args),
    storage: {
      from: () => ({
        upload: (...args: unknown[]) => storageUploadMock(...args),
        createSignedUrl: (...args: unknown[]) => createSignedUrlMock(...args),
      }),
    },
  },
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function renderTab() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
  const utils = render(
    <QueryClientProvider client={qc}>
      <CompanyTab />
    </QueryClientProvider>,
  );
  return { ...utils, invalidateSpy };
}

function selectEqMaybeSingleChain() {
  return { eq: () => ({ maybeSingle: () => maybeSingleMock() }) };
}

describe("CompanyTab", () => {
  beforeEach(() => {
    useCurrentProfileMock.mockReset();
    maybeSingleMock.mockReset();
    updateEqMock.mockReset();
    updateSelectMock.mockReset();
    updateMock.mockReset();
    fromMock.mockReset();
    storageUploadMock.mockReset();
    createSignedUrlMock.mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();

    useCurrentProfileMock.mockReturnValue({ data: { tenant_id: "tenant-1" } });
    maybeSingleMock.mockResolvedValue({
      data: { id: "tenant-1", name: "Clínica Vida", logo_url: null, onboarded_at: null },
      error: null,
    });
    // Salvar nome/logo: `.update().eq()` é aguardado direto → thenable resolve {error}.
    // Reset onboarding: `.update().eq().eq().select()` → chainável via updateSelectMock.
    updateEqMock.mockReturnValue({
      then: (onF: (v: { error: unknown }) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve({ error: null }).then(onF, onR),
      eq: () => ({ select: () => updateSelectMock() }),
    });
    updateSelectMock.mockResolvedValue({ data: [{ id: "tenant-1" }], error: null });
    updateMock.mockReturnValue({ eq: updateEqMock });
    fromMock.mockReturnValue({ select: () => selectEqMaybeSingleChain(), update: updateMock });
    storageUploadMock.mockResolvedValue({ error: null });
    createSignedUrlMock.mockResolvedValue({ data: { signedUrl: "https://logo.example/x.png" } });
  });

  it("mostra o skeleton enquanto a query do tenant carrega", () => {
    maybeSingleMock.mockImplementation(() => new Promise(() => {}));

    renderTab();

    expect(screen.queryByText("Empresa")).not.toBeInTheDocument();
  });

  it("renderiza o nome do tenant carregado no input", async () => {
    renderTab();

    expect(await screen.findByLabelText("Nome da empresa")).toHaveValue("Clínica Vida");
  });

  it('mostra "Sem logo" quando não há logo_url', async () => {
    renderTab();

    expect(await screen.findByText("Sem logo")).toBeInTheDocument();
  });

  it("mostra a logo assinada quando logo_url está presente", async () => {
    maybeSingleMock.mockResolvedValue({
      data: { id: "tenant-1", name: "Clínica Vida", logo_url: "t1/logo.png", onboarded_at: null },
      error: null,
    });

    renderTab();

    await waitFor(() => expect(createSignedUrlMock).toHaveBeenCalledWith("t1/logo.png", 3600));
    expect(await screen.findByAltText("Logo da empresa")).toHaveAttribute(
      "src",
      "https://logo.example/x.png",
    );
  });

  it("botão salvar nome fica desabilitado quando o valor não muda", async () => {
    renderTab();

    await screen.findByLabelText("Nome da empresa");
    expect(screen.getByRole("button", { name: "Salvar nome" })).toBeDisabled();
  });

  it("botão salvar nome fica desabilitado quando o campo fica vazio", async () => {
    const user = userEvent.setup();
    renderTab();

    const input = await screen.findByLabelText("Nome da empresa");
    await user.clear(input);

    expect(screen.getByRole("button", { name: "Salvar nome" })).toBeDisabled();
  });

  it("edita e salva o nome da empresa", async () => {
    const user = userEvent.setup();
    const { invalidateSpy } = renderTab();

    const input = await screen.findByLabelText("Nome da empresa");
    await user.clear(input);
    await user.type(input, "Nova Clínica");
    await user.click(screen.getByRole("button", { name: "Salvar nome" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Nome atualizado"));
    expect(updateMock).toHaveBeenCalledWith({ name: "Nova Clínica" });
    expect(updateEqMock).toHaveBeenCalledWith("id", "tenant-1");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["tenant"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["topbar-tenant"] });
  });

  it("traduz a policy de RLS do Postgres em vez de mandá-la para o toast", async () => {
    const user = userEvent.setup();
    // PostgrestError é objeto simples, não Error — o toast recebia a policy crua.
    updateEqMock.mockResolvedValue({
      error: { message: 'new row violates row-level security policy for table "tenants"' },
    });
    renderTab();

    const input = await screen.findByLabelText("Nome da empresa");
    await user.clear(input);
    await user.type(input, "X");
    await user.click(screen.getByRole("button", { name: "Salvar nome" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Você não tem permissão para fazer isso. Peça a um administrador.",
      ),
    );
  });

  it("mostra toast de erro quando salvar o nome falha", async () => {
    const user = userEvent.setup();
    updateEqMock.mockResolvedValue({ error: new Error("Nome inválido") });
    renderTab();

    const input = await screen.findByLabelText("Nome da empresa");
    await user.clear(input);
    await user.type(input, "X");
    await user.click(screen.getByRole("button", { name: "Salvar nome" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Nome inválido"));
  });

  it('usa a mensagem padrão "Erro ao salvar" quando o erro ao salvar nome não tem mensagem', async () => {
    const user = userEvent.setup();
    updateEqMock.mockResolvedValue({ error: {} });
    renderTab();

    const input = await screen.findByLabelText("Nome da empresa");
    await user.clear(input);
    await user.type(input, "X");
    await user.click(screen.getByRole("button", { name: "Salvar nome" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Erro ao salvar"));
  });

  it("faz upload de um novo logo ao selecionar um arquivo", async () => {
    const user = userEvent.setup();
    const { invalidateSpy } = renderTab();

    await screen.findByLabelText("Nome da empresa");
    const file = new File(["conteudo"], "logo.png", { type: "image/png" });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, file);

    await waitFor(() => expect(storageUploadMock).toHaveBeenCalled());
    const [path, uploadedFile, opts] = storageUploadMock.mock.calls[0];
    expect(path).toMatch(/^tenant-1\/logo-\d+\.png$/);
    expect(uploadedFile).toBe(file);
    expect(opts).toEqual({ upsert: false, contentType: "image/png" });

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Logo atualizado"));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["tenant"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["topbar-tenant"] });
  });

  it("não sobrescreve o nome em edição quando outra mutation invalida a query do tenant", async () => {
    // Regressão: uploadLogo/resetOnboarding invalidam ["tenant"]; o refetch
    // disparava o resync do useEffect e apagava o texto ainda não salvo.
    const user = userEvent.setup();
    renderTab();

    const nameInput = await screen.findByLabelText("Nome da empresa");
    expect(nameInput).toHaveValue("Clínica Vida");

    await user.clear(nameInput);
    await user.type(nameInput, "Nome Em Edição");

    const file = new File(["conteudo"], "logo.png", { type: "image/png" });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, file);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Logo atualizado"));

    // O refetch pós-invalidate devolve "Clínica Vida" de novo — o input do
    // usuário não pode ser descartado.
    expect(nameInput).toHaveValue("Nome Em Edição");
  });

  it('clicar em "Enviar logo" aciona o input de arquivo escondido', async () => {
    const user = userEvent.setup();
    renderTab();

    await screen.findByLabelText("Nome da empresa");
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const clickSpy = vi.spyOn(fileInput, "click");

    await user.click(screen.getByRole("button", { name: "Enviar logo" }));

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('mostra "Enviando…" e desabilita o botão enquanto o upload está pendente', async () => {
    const user = userEvent.setup();
    let resolveUpload: (value: { error: null }) => void = () => {};
    storageUploadMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpload = resolve;
        }),
    );
    renderTab();

    await screen.findByLabelText("Nome da empresa");
    const file = new File(["conteudo"], "logo.png", { type: "image/png" });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, file);

    const pendingButton = await screen.findByRole("button", { name: "Enviando…" });
    expect(pendingButton).toBeDisabled();

    resolveUpload({ error: null });
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it("normaliza a extensão do arquivo para minúsculo no caminho de upload", async () => {
    const user = userEvent.setup();
    renderTab();

    await screen.findByLabelText("Nome da empresa");
    const file = new File(["conteudo"], "LOGO.PNG", { type: "image/png" });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, file);

    await waitFor(() => expect(storageUploadMock).toHaveBeenCalled());
    const [path] = storageUploadMock.mock.calls[0];
    expect(path).toMatch(/\.png$/);
  });

  it("mostra toast de erro quando o upload do logo falha", async () => {
    const user = userEvent.setup();
    storageUploadMock.mockResolvedValue({ error: new Error("Falha no upload") });
    renderTab();

    await screen.findByLabelText("Nome da empresa");
    const file = new File(["conteudo"], "logo.png", { type: "image/png" });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, file);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Falha no upload"));
  });

  it('usa a mensagem padrão "Erro no upload" quando o erro do upload não tem mensagem', async () => {
    const user = userEvent.setup();
    storageUploadMock.mockResolvedValue({ error: {} });
    renderTab();

    await screen.findByLabelText("Nome da empresa");
    const file = new File(["conteudo"], "logo.png", { type: "image/png" });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, file);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Erro no upload"));
  });

  it("abre o dialog de confirmação ao clicar em Refazer e cancela sem alterar nada", async () => {
    const user = userEvent.setup();
    renderTab();

    await screen.findByLabelText("Nome da empresa");
    await user.click(screen.getByRole("button", { name: "Refazer" }));

    expect(await screen.findByText("Refazer configuração inicial?")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    await waitFor(() =>
      expect(screen.queryByText("Refazer configuração inicial?")).not.toBeInTheDocument(),
    );
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("confirma o reset do onboarding e mostra toast de sucesso", async () => {
    const user = userEvent.setup();
    const { invalidateSpy } = renderTab();

    await screen.findByLabelText("Nome da empresa");
    await user.click(screen.getByRole("button", { name: "Refazer" }));
    await screen.findByText("Refazer configuração inicial?");
    await user.click(screen.getByRole("button", { name: "Confirmar" }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Configuração inicial reaberta. As cores voltaram ao padrão.",
      ),
    );
    expect(updateMock).toHaveBeenCalledWith({ onboarded_at: null, business_profile: {} });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["tenant"] });
    await waitFor(() =>
      expect(screen.queryByText("Refazer configuração inicial?")).not.toBeInTheDocument(),
    );
  });

  it("mostra toast de erro quando o reset do onboarding falha", async () => {
    const user = userEvent.setup();
    updateSelectMock.mockResolvedValue({ data: null, error: new Error("Falha ao resetar") });
    renderTab();

    await screen.findByLabelText("Nome da empresa");
    await user.click(screen.getByRole("button", { name: "Refazer" }));
    await screen.findByText("Refazer configuração inicial?");
    await user.click(screen.getByRole("button", { name: "Confirmar" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Falha ao resetar"));
  });

  it('usa a mensagem padrão "Erro" quando o erro do reset não tem mensagem', async () => {
    const user = userEvent.setup();
    updateSelectMock.mockResolvedValue({ data: null, error: {} });
    renderTab();

    await screen.findByLabelText("Nome da empresa");
    await user.click(screen.getByRole("button", { name: "Refazer" }));
    await screen.findByText("Refazer configuração inicial?");
    await user.click(screen.getByRole("button", { name: "Confirmar" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Erro"));
  });

  it("não quebra quando a query do tenant falha — renderiza o card mesmo assim", async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: new Error("Falha ao buscar tenant") });

    renderTab();

    expect(await screen.findByText("Empresa")).toBeInTheDocument();
  });

  it("lança 'Tenant inválido' ao salvar o nome sem tenantId", async () => {
    useCurrentProfileMock.mockReturnValue({ data: undefined });
    const user = userEvent.setup();
    renderTab();

    const input = await screen.findByLabelText("Nome da empresa");
    await user.type(input, "X");
    await user.click(screen.getByRole("button", { name: "Salvar nome" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Tenant inválido"));
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("lança 'Tenant inválido' ao enviar logo sem tenantId", async () => {
    useCurrentProfileMock.mockReturnValue({ data: undefined });
    const user = userEvent.setup();
    renderTab();

    await screen.findByLabelText("Nome da empresa");
    const file = new File(["conteudo"], "logo.png", { type: "image/png" });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, file);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Tenant inválido"));
    expect(storageUploadMock).not.toHaveBeenCalled();
  });

  it("lança 'Tenant inválido' ao confirmar reset sem tenantId", async () => {
    useCurrentProfileMock.mockReturnValue({ data: undefined });
    const user = userEvent.setup();
    renderTab();

    await screen.findByLabelText("Nome da empresa");
    await user.click(screen.getByRole("button", { name: "Refazer" }));
    await screen.findByText("Refazer configuração inicial?");
    await user.click(screen.getByRole("button", { name: "Confirmar" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Tenant inválido"));
  });

  it("propaga erro quando o upload do arquivo funciona mas a atualização do tenant falha", async () => {
    const user = userEvent.setup();
    updateEqMock.mockResolvedValue({ error: new Error("Falha ao salvar logo_url") });
    renderTab();

    await screen.findByLabelText("Nome da empresa");
    const file = new File(["conteudo"], "logo.png", { type: "image/png" });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, file);

    await waitFor(() => expect(storageUploadMock).toHaveBeenCalled());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Falha ao salvar logo_url"));
  });

  it("não chama a mutation de upload quando o input de arquivo dispara change sem arquivo selecionado", async () => {
    renderTab();

    await screen.findByLabelText("Nome da empresa");
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [] } });

    expect(storageUploadMock).not.toHaveBeenCalled();
  });

  it('mostra "Salvando…" e desabilita o botão de nome enquanto a mutation está pendente', async () => {
    const user = userEvent.setup();
    let resolveSave: (value: { error: null }) => void = () => {};
    updateEqMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    renderTab();

    const input = await screen.findByLabelText("Nome da empresa");
    await user.clear(input);
    await user.type(input, "Novo Nome");
    await user.click(screen.getByRole("button", { name: "Salvar nome" }));

    const pendingButton = await screen.findByRole("button", { name: "Salvando…" });
    expect(pendingButton).toBeDisabled();

    resolveSave({ error: null });
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it("não atualiza o preview da logo se o componente for desmontado antes da URL assinada resolver", async () => {
    maybeSingleMock.mockResolvedValue({
      data: { id: "tenant-1", name: "Clínica Vida", logo_url: "t1/logo.png", onboarded_at: null },
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

    const { unmount } = renderTab();
    await waitFor(() => expect(createSignedUrlMock).toHaveBeenCalled());
    unmount();
    resolveSignedUrl({ data: { signedUrl: "https://logo.example/x.png" } });
    await Promise.resolve();

    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Can't perform a React state update"),
    );
    errorSpy.mockRestore();
  });

  it('mantém "Sem logo" quando createSignedUrl não retorna signedUrl', async () => {
    maybeSingleMock.mockResolvedValue({
      data: { id: "tenant-1", name: "Clínica Vida", logo_url: "t1/logo.png", onboarded_at: null },
      error: null,
    });
    createSignedUrlMock.mockResolvedValue({ data: null });

    renderTab();

    await waitFor(() => expect(createSignedUrlMock).toHaveBeenCalled());
    expect(await screen.findByText("Sem logo")).toBeInTheDocument();
  });
});
