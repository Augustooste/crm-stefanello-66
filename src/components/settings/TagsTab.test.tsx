import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { TagsTab } from "./TagsTab";

const useCurrentProfileMock = vi.fn();
const tagsSelectOrderMock = vi.fn();
const containsSelectMock = vi.fn();
const tagsUpdateEqMock = vi.fn();
const tagsUpdateMock = vi.fn();
const tagsInsertMock = vi.fn();
const tagsDeleteEqMock = vi.fn();
const tagsDeleteMock = vi.fn();
const contactsUpdateEqMock = vi.fn();
const contactsUpdateMock = vi.fn();
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

function tagsTable() {
  return {
    select: () => ({ order: () => tagsSelectOrderMock() }),
    update: tagsUpdateMock,
    insert: tagsInsertMock,
    delete: tagsDeleteMock,
  };
}

function contactsTable() {
  return {
    select: () => ({ is: () => ({ contains: () => containsSelectMock() }) }),
    update: contactsUpdateMock,
  };
}

function renderTab() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
  const utils = render(
    <QueryClientProvider client={qc}>
      <TagsTab />
    </QueryClientProvider>,
  );
  return { ...utils, invalidateSpy };
}

describe("TagsTab", () => {
  beforeEach(() => {
    useCurrentProfileMock.mockReset();
    tagsSelectOrderMock.mockReset();
    containsSelectMock.mockReset();
    tagsUpdateEqMock.mockReset();
    tagsUpdateMock.mockReset();
    tagsInsertMock.mockReset();
    tagsDeleteEqMock.mockReset();
    tagsDeleteMock.mockReset();
    contactsUpdateEqMock.mockReset();
    contactsUpdateMock.mockReset();
    fromMock.mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();

    useCurrentProfileMock.mockReturnValue({ data: { tenant_id: "tenant-1" } });
    tagsSelectOrderMock.mockResolvedValue({ data: [], error: null });
    containsSelectMock.mockResolvedValue({ data: [], error: null });
    tagsUpdateEqMock.mockResolvedValue({ error: null });
    tagsUpdateMock.mockReturnValue({ eq: tagsUpdateEqMock });
    tagsInsertMock.mockResolvedValue({ error: null });
    tagsDeleteEqMock.mockResolvedValue({ error: null });
    tagsDeleteMock.mockReturnValue({ eq: tagsDeleteEqMock });
    contactsUpdateEqMock.mockResolvedValue({ error: null });
    contactsUpdateMock.mockReturnValue({ eq: contactsUpdateEqMock });

    fromMock.mockImplementation((table: string) =>
      table === "tags" ? tagsTable() : contactsTable(),
    );
  });

  it("mostra o skeleton enquanto a query de etiquetas carrega", () => {
    tagsSelectOrderMock.mockImplementation(() => new Promise(() => {}));

    renderTab();

    expect(screen.getByText("Etiquetas")).toBeInTheDocument();
    expect(screen.queryByText("Sem etiquetas")).not.toBeInTheDocument();
  });

  it("mostra o EmptyState quando não há etiquetas", async () => {
    renderTab();

    expect(await screen.findByText("Sem etiquetas")).toBeInTheDocument();
  });

  it("trata data nulo da query de etiquetas como lista vazia", async () => {
    tagsSelectOrderMock.mockResolvedValue({ data: null, error: null });

    renderTab();

    expect(await screen.findByText("Sem etiquetas")).toBeInTheDocument();
  });

  it("não quebra quando a query de etiquetas falha — mostra o EmptyState", async () => {
    tagsSelectOrderMock.mockResolvedValue({ data: null, error: new Error("Falha ao buscar") });

    renderTab();

    expect(await screen.findByText("Sem etiquetas")).toBeInTheDocument();
  });

  it("lista as etiquetas retornadas pela query", async () => {
    tagsSelectOrderMock.mockResolvedValue({
      data: [
        { id: "1", name: "Quente", color: "#ef4444" },
        { id: "2", name: "Frio", color: "#3b82f6" },
      ],
      error: null,
    });

    renderTab();

    expect(await screen.findByText("Quente")).toBeInTheDocument();
    expect(screen.getByText("Frio")).toBeInTheDocument();
  });

  it("abre o dialog de nova etiqueta e cria com nome e cor selecionados", async () => {
    const user = userEvent.setup();
    const { invalidateSpy } = renderTab();

    await screen.findByText("Sem etiquetas");
    await user.click(screen.getByRole("button", { name: "Nova etiqueta" }));

    expect(await screen.findByText("Nova etiqueta", { selector: "h2" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Nome *"), "VIP");
    await user.click(screen.getByRole("button", { name: /Selecionar cor #22c55e/ }));
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() =>
      expect(tagsInsertMock).toHaveBeenCalledWith({
        name: "VIP",
        color: "#22c55e",
        tenant_id: "tenant-1",
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Etiqueta criada");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["tags"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["contacts"] });
  });

  it("botão salvar do dialog de etiqueta fica desabilitado sem nome", async () => {
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Sem etiquetas");
    await user.click(screen.getByRole("button", { name: "Nova etiqueta" }));

    expect(screen.getByRole("button", { name: "Salvar" })).toBeDisabled();
  });

  it("permite escolher uma cor customizada via input de cor", async () => {
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Sem etiquetas");
    await user.click(screen.getByRole("button", { name: "Nova etiqueta" }));
    await user.type(screen.getByLabelText("Nome *"), "Personalizada");

    const colorInput = screen.getByLabelText("Cor personalizada");
    fireEvent.change(colorInput, { target: { value: "#123456" } });
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() =>
      expect(tagsInsertMock).toHaveBeenCalledWith(expect.objectContaining({ color: "#123456" })),
    );
  });

  it("abre o dialog em modo edição com nome e cor pré-preenchidos e salva a alteração", async () => {
    tagsSelectOrderMock.mockResolvedValue({
      data: [{ id: "1", name: "Quente", color: "#ef4444" }],
      error: null,
    });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Quente");
    await user.click(screen.getByRole("button", { name: "Editar Quente" }));

    expect(await screen.findByText("Editar etiqueta")).toBeInTheDocument();
    expect(screen.getByLabelText("Nome *")).toHaveValue("Quente");

    await user.clear(screen.getByLabelText("Nome *"));
    await user.type(screen.getByLabelText("Nome *"), "Muito quente");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() =>
      expect(tagsUpdateMock).toHaveBeenCalledWith({ name: "Muito quente", color: "#ef4444" }),
    );
    expect(tagsUpdateEqMock).toHaveBeenCalledWith("id", "1");
    expect(toast.success).toHaveBeenCalledWith("Etiqueta atualizada");
  });

  it("ao renomear uma etiqueta, propaga o novo nome para os contatos que a usam", async () => {
    tagsSelectOrderMock.mockResolvedValue({
      data: [{ id: "1", name: "Quente", color: "#ef4444" }],
      error: null,
    });
    containsSelectMock.mockResolvedValue({
      data: [{ id: "c1", tags: ["Quente", "VIP"] }],
      error: null,
    });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Quente");
    await user.click(screen.getByRole("button", { name: "Editar Quente" }));
    await user.clear(screen.getByLabelText("Nome *"));
    await user.type(screen.getByLabelText("Nome *"), "Requente");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() =>
      expect(contactsUpdateMock).toHaveBeenCalledWith({ tags: ["Requente", "VIP"] }),
    );
    expect(contactsUpdateEqMock).toHaveBeenCalledWith("id", "c1");
  });

  it("não propaga nomes para contatos quando a edição mantém o mesmo nome", async () => {
    tagsSelectOrderMock.mockResolvedValue({
      data: [{ id: "1", name: "Quente", color: "#ef4444" }],
      error: null,
    });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Quente");
    await user.click(screen.getByRole("button", { name: "Editar Quente" }));
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(tagsUpdateMock).toHaveBeenCalled());
    expect(containsSelectMock).not.toHaveBeenCalled();
  });

  it("trata data nulo de contatos afetados como lista vazia ao renomear", async () => {
    tagsSelectOrderMock.mockResolvedValue({
      data: [{ id: "1", name: "Quente", color: "#ef4444" }],
      error: null,
    });
    containsSelectMock.mockResolvedValue({ data: null, error: null });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Quente");
    await user.click(screen.getByRole("button", { name: "Editar Quente" }));
    await user.clear(screen.getByLabelText("Nome *"));
    await user.type(screen.getByLabelText("Nome *"), "Requente");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(tagsUpdateMock).toHaveBeenCalled());
    expect(contactsUpdateMock).not.toHaveBeenCalled();
  });

  it("trata contato sem array de tags como lista vazia ao renomear", async () => {
    tagsSelectOrderMock.mockResolvedValue({
      data: [{ id: "1", name: "Quente", color: "#ef4444" }],
      error: null,
    });
    containsSelectMock.mockResolvedValue({
      data: [{ id: "c1", tags: null as unknown as string[] }],
      error: null,
    });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Quente");
    await user.click(screen.getByRole("button", { name: "Editar Quente" }));
    await user.clear(screen.getByLabelText("Nome *"));
    await user.type(screen.getByLabelText("Nome *"), "Requente");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(contactsUpdateMock).toHaveBeenCalledWith({ tags: [] }));
  });

  it("mostra erro quando a busca de contatos afetados falha ao renomear", async () => {
    tagsSelectOrderMock.mockResolvedValue({
      data: [{ id: "1", name: "Quente", color: "#ef4444" }],
      error: null,
    });
    containsSelectMock.mockResolvedValue({ data: null, error: new Error("Falha na busca") });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Quente");
    await user.click(screen.getByRole("button", { name: "Editar Quente" }));
    await user.clear(screen.getByLabelText("Nome *"));
    await user.type(screen.getByLabelText("Nome *"), "Requente");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Falha na busca"));
    expect(tagsUpdateMock).not.toHaveBeenCalled();
  });

  it("mostra erro quando atualizar um contato afetado falha ao renomear", async () => {
    tagsSelectOrderMock.mockResolvedValue({
      data: [{ id: "1", name: "Quente", color: "#ef4444" }],
      error: null,
    });
    containsSelectMock.mockResolvedValue({
      data: [{ id: "c1", tags: ["Quente"] }],
      error: null,
    });
    contactsUpdateEqMock.mockResolvedValue({ error: new Error("Falha ao atualizar contato") });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Quente");
    await user.click(screen.getByRole("button", { name: "Editar Quente" }));
    await user.clear(screen.getByLabelText("Nome *"));
    await user.type(screen.getByLabelText("Nome *"), "Requente");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Falha ao atualizar contato"));
    expect(tagsUpdateMock).not.toHaveBeenCalled();
  });

  it("cancela o dialog de etiqueta sem salvar", async () => {
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Sem etiquetas");
    await user.click(screen.getByRole("button", { name: "Nova etiqueta" }));
    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    await waitFor(() =>
      expect(screen.queryByText("Nova etiqueta", { selector: "h2" })).not.toBeInTheDocument(),
    );
    expect(tagsInsertMock).not.toHaveBeenCalled();
  });

  it("mostra toast de erro com a mensagem quando salvar a etiqueta falha", async () => {
    tagsInsertMock.mockResolvedValue({ error: new Error("Nome duplicado") });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Sem etiquetas");
    await user.click(screen.getByRole("button", { name: "Nova etiqueta" }));
    await user.type(screen.getByLabelText("Nome *"), "Repetida");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Nome duplicado"));
  });

  it("mostra toast de erro quando editar (sem renomear) uma etiqueta falha ao atualizar", async () => {
    tagsSelectOrderMock.mockResolvedValue({
      data: [{ id: "1", name: "Quente", color: "#ef4444" }],
      error: null,
    });
    tagsUpdateEqMock.mockResolvedValue({ error: new Error("Falha ao atualizar etiqueta") });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Quente");
    await user.click(screen.getByRole("button", { name: "Editar Quente" }));
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Falha ao atualizar etiqueta"));
  });

  it("traduz a violação de unicidade do Postgres em vez de mandar o índice para o toast", async () => {
    tagsInsertMock.mockResolvedValue({
      error: {
        message: 'duplicate key value violates unique constraint "tags_tenant_id_name_key"',
        code: "23505",
      },
    });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Sem etiquetas");
    await user.click(screen.getByRole("button", { name: "Nova etiqueta" }));
    await user.type(screen.getByLabelText("Nome *"), "Repetida");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Já existe um registro com esse valor."),
    );
  });

  it('usa a mensagem padrão "Erro ao salvar" quando o erro não tem mensagem', async () => {
    tagsInsertMock.mockResolvedValue({ error: {} });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Sem etiquetas");
    await user.click(screen.getByRole("button", { name: "Nova etiqueta" }));
    await user.type(screen.getByLabelText("Nome *"), "Repetida");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Erro ao salvar"));
  });

  it('mostra "Salvando…" enquanto a mutation de salvar está pendente', async () => {
    let resolveInsert: (value: { error: null }) => void = () => {};
    tagsInsertMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInsert = resolve;
        }),
    );
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Sem etiquetas");
    await user.click(screen.getByRole("button", { name: "Nova etiqueta" }));
    await user.type(screen.getByLabelText("Nome *"), "Pendente");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    expect(await screen.findByRole("button", { name: "Salvando…" })).toBeInTheDocument();
    resolveInsert({ error: null });
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it("abre a confirmação de exclusão e exclui a etiqueta, removendo-a dos contatos", async () => {
    tagsSelectOrderMock.mockResolvedValue({
      data: [{ id: "1", name: "Quente", color: "#ef4444" }],
      error: null,
    });
    containsSelectMock.mockResolvedValue({
      data: [{ id: "c1", tags: ["Quente", "VIP"] }],
      error: null,
    });
    const user = userEvent.setup();
    const { invalidateSpy } = renderTab();

    await screen.findByText("Quente");
    await user.click(screen.getByRole("button", { name: "Excluir Quente" }));

    expect(await screen.findByText("Excluir etiqueta")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Excluir" }));

    await waitFor(() => expect(contactsUpdateMock).toHaveBeenCalledWith({ tags: ["VIP"] }));
    expect(tagsDeleteEqMock).toHaveBeenCalledWith("id", "1");
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Etiqueta removida"));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["tags"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["contacts"] });
  });

  it("trata data nulo de contatos afetados como lista vazia ao excluir", async () => {
    tagsSelectOrderMock.mockResolvedValue({
      data: [{ id: "1", name: "Quente", color: "#ef4444" }],
      error: null,
    });
    containsSelectMock.mockResolvedValue({ data: null, error: null });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Quente");
    await user.click(screen.getByRole("button", { name: "Excluir Quente" }));
    await screen.findByText("Excluir etiqueta");
    await user.click(screen.getByRole("button", { name: "Excluir" }));

    await waitFor(() => expect(tagsDeleteEqMock).toHaveBeenCalledWith("id", "1"));
    expect(contactsUpdateMock).not.toHaveBeenCalled();
  });

  it("trata contato sem array de tags como lista vazia ao remover a etiqueta", async () => {
    tagsSelectOrderMock.mockResolvedValue({
      data: [{ id: "1", name: "Quente", color: "#ef4444" }],
      error: null,
    });
    containsSelectMock.mockResolvedValue({
      data: [{ id: "c1", tags: null as unknown as string[] }],
      error: null,
    });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Quente");
    await user.click(screen.getByRole("button", { name: "Excluir Quente" }));
    await screen.findByText("Excluir etiqueta");
    await user.click(screen.getByRole("button", { name: "Excluir" }));

    await waitFor(() => expect(contactsUpdateMock).toHaveBeenCalledWith({ tags: [] }));
  });

  it("mostra erro quando a busca de contatos afetados falha ao excluir a etiqueta", async () => {
    tagsSelectOrderMock.mockResolvedValue({
      data: [{ id: "1", name: "Quente", color: "#ef4444" }],
      error: null,
    });
    containsSelectMock.mockResolvedValue({ data: null, error: new Error("Falha na busca") });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Quente");
    await user.click(screen.getByRole("button", { name: "Excluir Quente" }));
    await screen.findByText("Excluir etiqueta");
    await user.click(screen.getByRole("button", { name: "Excluir" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Falha na busca"));
    expect(tagsDeleteMock).not.toHaveBeenCalled();
  });

  it("mostra erro quando atualizar um contato afetado falha ao excluir a etiqueta", async () => {
    tagsSelectOrderMock.mockResolvedValue({
      data: [{ id: "1", name: "Quente", color: "#ef4444" }],
      error: null,
    });
    containsSelectMock.mockResolvedValue({
      data: [{ id: "c1", tags: ["Quente"] }],
      error: null,
    });
    contactsUpdateEqMock.mockResolvedValue({ error: new Error("Falha ao atualizar contato") });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Quente");
    await user.click(screen.getByRole("button", { name: "Excluir Quente" }));
    await screen.findByText("Excluir etiqueta");
    await user.click(screen.getByRole("button", { name: "Excluir" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Falha ao atualizar contato"));
    expect(tagsDeleteMock).not.toHaveBeenCalled();
  });

  it("cancela a exclusão sem remover a etiqueta", async () => {
    tagsSelectOrderMock.mockResolvedValue({
      data: [{ id: "1", name: "Quente", color: "#ef4444" }],
      error: null,
    });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Quente");
    await user.click(screen.getByRole("button", { name: "Excluir Quente" }));
    await screen.findByText("Excluir etiqueta");
    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    await waitFor(() => expect(screen.queryByText("Excluir etiqueta")).not.toBeInTheDocument());
    expect(tagsDeleteMock).not.toHaveBeenCalled();
  });

  it("mostra toast de erro quando a exclusão falha", async () => {
    tagsSelectOrderMock.mockResolvedValue({
      data: [{ id: "1", name: "Quente", color: "#ef4444" }],
      error: null,
    });
    tagsDeleteEqMock.mockResolvedValue({ error: new Error("Falha ao excluir") });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Quente");
    await user.click(screen.getByRole("button", { name: "Excluir Quente" }));
    await screen.findByText("Excluir etiqueta");
    await user.click(screen.getByRole("button", { name: "Excluir" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Falha ao excluir"));
  });

  it('usa a mensagem padrão "Erro ao remover" quando o erro de exclusão não tem mensagem', async () => {
    tagsSelectOrderMock.mockResolvedValue({
      data: [{ id: "1", name: "Quente", color: "#ef4444" }],
      error: null,
    });
    tagsDeleteEqMock.mockResolvedValue({ error: {} });
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Quente");
    await user.click(screen.getByRole("button", { name: "Excluir Quente" }));
    await screen.findByText("Excluir etiqueta");
    await user.click(screen.getByRole("button", { name: "Excluir" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Erro ao remover"));
  });

  it("dispara a mutation de exclusão mesmo com a resolução assíncrona atrasada", async () => {
    // Nota: AlertDialogAction fecha o diálogo do Radix assim que é clicado, então o texto
    // "Removendo…" nunca chega a ser visível — a mutation continua em segundo plano.
    tagsSelectOrderMock.mockResolvedValue({
      data: [{ id: "1", name: "Quente", color: "#ef4444" }],
      error: null,
    });
    let resolveDelete: (value: { error: null }) => void = () => {};
    tagsDeleteEqMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDelete = resolve;
        }),
    );
    const user = userEvent.setup();
    renderTab();

    await screen.findByText("Quente");
    await user.click(screen.getByRole("button", { name: "Excluir Quente" }));
    await screen.findByText("Excluir etiqueta");
    await user.click(screen.getByRole("button", { name: "Excluir" }));

    expect(tagsDeleteEqMock).toHaveBeenCalled();
    resolveDelete({ error: null });
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });
});
