import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { renderWithQueryClient } from "@/test/render";
import {
  asFromMock,
  createFromByTable,
  createQueryBuilder,
  fail,
  ok,
  type QueryResult,
} from "@/test/supabase-mock";
import type { ContactRow } from "@/components/contacts/ContactFormDialog";
import { useContactExport } from "@/hooks/use-contact-export";
import { useBulkContactActions } from "@/hooks/use-bulk-contact-actions";
import { Route } from "./_app.contatos.index";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { routerOverrides } = await import("@/test/router-mocks");
  return { ...actual, ...routerOverrides() };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/hooks/use-contact-export", () => ({
  useContactExport: vi.fn(),
}));

vi.mock("@/hooks/use-bulk-contact-actions", () => ({
  useBulkContactActions: vi.fn(),
}));

const ContactsPage = Route.options.component!;

const CONTACTS: ContactRow[] = [
  {
    id: "c1",
    tenant_id: "t1",
    name: "Ana Souza",
    phone: "11999990000",
    email: "ana@exemplo.com",
    source: "Site",
    tags: ["Quente"],
    notes: null,
    ai_paused: false,
    created_at: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "c2",
    tenant_id: "t1",
    name: "Bruno Lima",
    phone: null,
    email: "bruno@exemplo.com",
    source: "Indicação",
    tags: [],
    notes: null,
    ai_paused: false,
    created_at: "2026-01-02T00:00:00.000Z",
  },
];

function manyContacts(count: number): ContactRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `id-${i + 1}`,
    tenant_id: "t1",
    name: `Contato ${String(i + 1).padStart(2, "0")}`,
    phone: "11999990000",
    email: `contato${i + 1}@exemplo.com`,
    source: "Site",
    tags: [],
    notes: null,
    ai_paused: false,
    created_at: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
  }));
}

function mockContacts(result: QueryResult<ContactRow[]>) {
  vi.mocked(supabase.from).mockImplementation(createFromByTable({ contacts: result }));
}

describe("página de contatos — lacunas de cobertura (/_app/contatos)", () => {
  beforeEach(() => {
    vi.mocked(useContactExport).mockReturnValue({
      exportContacts: vi.fn().mockResolvedValue({ recordsCount: 0 }),
      isExporting: false,
    });
    vi.mocked(useBulkContactActions).mockReturnValue({
      applyTag: vi.fn().mockResolvedValue({ sucesso: 0, falhas: 0, erros: [] }),
      isApplyingTag: false,
      bulkSoftDelete: vi.fn().mockResolvedValue({ sucesso: 0, falhas: 0, erros: [] }),
      isBulkDeleting: false,
    });
  });

  it("expõe metadados de head da rota", async () => {
    const head = await Route.options.head?.({} as never);
    if (!head) throw new Error("head indefinido");

    expect(head.meta?.[0]).toEqual({ title: "Contatos" });
    expect(head.links?.[0]).toEqual({
      rel: "canonical",
      href: "https://aceleraflow.lovable.app/contatos",
    });
  });

  it("filtra contatos por etiqueta selecionada no popover e depois remove o filtro", async () => {
    mockContacts(ok(CONTACTS));
    const user = userEvent.setup();
    renderWithQueryClient(<ContactsPage />);

    await screen.findByText("Ana Souza");
    expect(screen.getByText("Bruno Lima")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Todas" }));
    const quenteCheckbox = await screen.findByRole("checkbox", { name: "Quente" });
    await user.click(quenteCheckbox);

    expect(screen.getByText("Ana Souza")).toBeInTheDocument();
    expect(screen.queryByText("Bruno Lima")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1 selecionada(s)" })).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Quente" }));

    expect(await screen.findByText("Bruno Lima")).toBeInTheDocument();
  });

  it("mostra estado vazio quando a busca não encontra ninguém e limpa pelo botão do estado vazio", async () => {
    mockContacts(ok(CONTACTS));
    const user = userEvent.setup();
    renderWithQueryClient(<ContactsPage />);

    await screen.findByText("Ana Souza");
    await user.type(screen.getByLabelText("Buscar contatos"), "inexistente-xyz");

    expect(await screen.findByText("Nenhum contato encontrado")).toBeInTheDocument();
    expect(
      screen.getByText("Ajuste a busca ou os filtros para tentar de novo."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Limpar busca" }));

    expect(await screen.findByText("Ana Souza")).toBeInTheDocument();
    expect(screen.getByText("Bruno Lima")).toBeInTheDocument();
    expect(screen.getByLabelText("Buscar contatos")).toHaveValue("");
  });

  it("limpa a busca e as etiquetas pelo link 'Limpar filtros'", async () => {
    mockContacts(ok(CONTACTS));
    const user = userEvent.setup();
    renderWithQueryClient(<ContactsPage />);

    await screen.findByText("Ana Souza");
    await user.type(screen.getByLabelText("Buscar contatos"), "ana");

    expect(await screen.findByText("Limpar filtros")).toBeInTheDocument();
    await user.click(screen.getByText("Limpar filtros"));

    expect(screen.getByLabelText("Buscar contatos")).toHaveValue("");
    expect(await screen.findByText("Bruno Lima")).toBeInTheDocument();
    expect(screen.queryByText("Limpar filtros")).not.toBeInTheDocument();
  });

  it("mostra toast de erro quando a exclusão falha", async () => {
    // Dispatch por tabela (não por ordem de chamada): ContactFormDialog
    // renderiza sempre no fundo da página e dispara queries próprias
    // (crm_companies, niche-templates, tenant-onboarding via usePluginActive)
    // que não têm relação com o fluxo de exclusão testado aqui -- um mock
    // baseado em ordem de chamada (createFromQueue) quebra assim que essas
    // queries extras entram na mistura.
    let contactsCall = 0;
    vi.mocked(supabase.from).mockImplementation(
      asFromMock((table: string) => {
        if (table === "contacts") {
          contactsCall += 1;
          return createQueryBuilder(contactsCall === 1 ? ok(CONTACTS) : fail("erro ao excluir"));
        }
        return createFromByTable({})(table);
      }),
    );
    const user = userEvent.setup();
    renderWithQueryClient(<ContactsPage />);

    await screen.findByText("Ana Souza");
    await user.click(screen.getByLabelText("Excluir Ana Souza"));

    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Excluir" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("erro ao excluir"));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("tenta novamente ao clicar em 'Tentar novamente' no estado de erro", async () => {
    mockContacts(fail("timeout ao buscar contatos"));
    const user = userEvent.setup();
    renderWithQueryClient(<ContactsPage />);

    await screen.findByText("Erro ao carregar contatos");
    const callsBefore = vi.mocked(supabase.from).mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));

    await waitFor(() =>
      expect(vi.mocked(supabase.from).mock.calls.length).toBeGreaterThan(callsBefore),
    );
  });

  it("mostra travessão para e-mail e origem ausentes e busca contato pelo e-mail nulo sem quebrar", async () => {
    const carla: ContactRow = {
      id: "c3",
      tenant_id: "t1",
      name: "Carla Dias",
      phone: "11888887777",
      email: null,
      source: null,
      tags: [],
      notes: null,
      ai_paused: false,
      created_at: "2026-01-03T00:00:00.000Z",
    };
    mockContacts(ok([...CONTACTS, carla]));
    const user = userEvent.setup();
    renderWithQueryClient(<ContactsPage />);

    await screen.findByText("Ana Souza");
    await user.type(screen.getByLabelText("Buscar contatos"), "carla");

    expect(await screen.findByText("Carla Dias")).toBeInTheDocument();
    const row = screen.getByText("Carla Dias").closest("tr")!;
    const cells = within(row).getAllByRole("cell");
    // índice 0 = checkbox de seleção em lote (bulk ops)
    expect(cells[3]).toHaveTextContent("—");
    expect(cells[5]).toHaveTextContent("—");
  });

  it("abre o formulário de novo contato pelo botão do estado vazio (sem nenhum contato)", async () => {
    mockContacts(ok([]));
    const user = userEvent.setup();
    renderWithQueryClient(<ContactsPage />);

    await screen.findByText("Nenhum contato ainda");
    const novoContatoButtons = screen.getAllByRole("button", { name: /Novo contato/ });
    await user.click(novoContatoButtons[novoContatoButtons.length - 1]);

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("pagina a lista quando há mais de uma página de contatos", async () => {
    mockContacts(ok(manyContacts(15)));
    const user = userEvent.setup();
    renderWithQueryClient(<ContactsPage />);

    await screen.findByText("Contato 01");
    expect(screen.getByText("Página 1 de 2")).toBeInTheDocument();

    const anterior = screen.getByRole("button", { name: "Anterior" });
    const proxima = screen.getByRole("button", { name: "Próxima" });
    expect(anterior).toBeDisabled();
    expect(proxima).not.toBeDisabled();

    await user.click(proxima);

    expect(await screen.findByText("Página 2 de 2")).toBeInTheDocument();
    expect(screen.getByText("Contato 11")).toBeInTheDocument();
    expect(screen.queryByText("Contato 01")).not.toBeInTheDocument();
    expect(proxima).toBeDisabled();
    expect(anterior).not.toBeDisabled();

    await user.click(anterior);

    expect(await screen.findByText("Página 1 de 2")).toBeInTheDocument();
    expect(screen.getByText("Contato 01")).toBeInTheDocument();
  });

  it("abre o diálogo de importação de CSV ao clicar em 'Importar CSV'", async () => {
    mockContacts(ok(CONTACTS));
    const user = userEvent.setup();
    renderWithQueryClient(<ContactsPage />);

    await screen.findByText("Ana Souza");
    await user.click(screen.getByRole("button", { name: /Importar CSV/ }));

    expect(await screen.findByText("Importar contatos via CSV")).toBeInTheDocument();
  });

  it("exporta contatos com sucesso mostrando a contagem no toast", async () => {
    mockContacts(ok(CONTACTS));
    const exportContacts = vi.fn().mockResolvedValue({ recordsCount: 2 });
    vi.mocked(useContactExport).mockReturnValue({ exportContacts, isExporting: false });
    const user = userEvent.setup();
    renderWithQueryClient(<ContactsPage />);

    await screen.findByText("Ana Souza");
    await user.type(screen.getByLabelText("Buscar contatos"), "ana");
    await user.click(screen.getByRole("button", { name: /Exportar CSV/ }));

    await waitFor(() => expect(exportContacts).toHaveBeenCalledWith({ search: "ana", tags: [] }));
    expect(toast.success).toHaveBeenCalledWith("2 contato(s) exportado(s)");
  });

  it("mostra toast de erro quando a exportação de contatos falha", async () => {
    mockContacts(ok(CONTACTS));
    vi.mocked(useContactExport).mockReturnValue({
      exportContacts: vi.fn().mockRejectedValue(new Error("falha ao gerar CSV")),
      isExporting: false,
    });
    const user = userEvent.setup();
    renderWithQueryClient(<ContactsPage />);

    await screen.findByText("Ana Souza");
    await user.click(screen.getByRole("button", { name: /Exportar CSV/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("falha ao gerar CSV"));
  });

  it("seleciona um contato pelo checkbox da linha e mostra a barra de ações em lote", async () => {
    mockContacts(ok(CONTACTS));
    const user = userEvent.setup();
    renderWithQueryClient(<ContactsPage />);

    await screen.findByText("Ana Souza");
    await user.click(screen.getByLabelText("Selecionar Ana Souza"));

    expect(screen.getByText("1 contato(s) selecionado(s)")).toBeInTheDocument();
  });

  it("alterna o checkbox 'selecionar todos' entre vazio, indeterminado e todo selecionado", async () => {
    mockContacts(ok(CONTACTS));
    const user = userEvent.setup();
    renderWithQueryClient(<ContactsPage />);

    await screen.findByText("Ana Souza");
    const selectAll = screen.getByLabelText("Selecionar todos os contatos filtrados");
    expect(selectAll).toHaveAttribute("data-state", "unchecked");

    await user.click(screen.getByLabelText("Selecionar Ana Souza"));
    expect(selectAll).toHaveAttribute("data-state", "indeterminate");

    await user.click(selectAll);
    expect(screen.getByText("2 contato(s) selecionado(s)")).toBeInTheDocument();
    expect(selectAll).toHaveAttribute("data-state", "checked");

    await user.click(selectAll);
    expect(screen.queryByText(/contato\(s\) selecionado\(s\)/)).not.toBeInTheDocument();
  });

  it("limpa a seleção em lote pelo botão 'Limpar seleção'", async () => {
    mockContacts(ok(CONTACTS));
    const user = userEvent.setup();
    renderWithQueryClient(<ContactsPage />);

    await screen.findByText("Ana Souza");
    await user.click(screen.getByLabelText("Selecionar Ana Souza"));
    expect(screen.getByText("1 contato(s) selecionado(s)")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Limpar seleção"));

    expect(screen.queryByText(/contato\(s\) selecionado\(s\)/)).not.toBeInTheDocument();
  });

  it("aplica etiqueta em lote com sucesso total e limpa a seleção", async () => {
    mockContacts(ok(CONTACTS));
    const applyTag = vi.fn().mockResolvedValue({ sucesso: 1, falhas: 0, erros: [] });
    vi.mocked(useBulkContactActions).mockReturnValue({
      applyTag,
      isApplyingTag: false,
      bulkSoftDelete: vi.fn(),
      isBulkDeleting: false,
    });
    const user = userEvent.setup();
    renderWithQueryClient(<ContactsPage />);

    await screen.findByText("Ana Souza");
    await user.click(screen.getByLabelText("Selecionar Ana Souza"));
    await user.click(screen.getByRole("button", { name: /Aplicar etiqueta/ }));
    await user.click(await screen.findByRole("button", { name: "Quente" }));

    await waitFor(() =>
      expect(applyTag).toHaveBeenCalledWith({ contactIds: ["c1"], tag: "Quente" }),
    );
    expect(toast.success).toHaveBeenCalledWith('Etiqueta "Quente" aplicada em 1 contato(s)');
    expect(screen.queryByText(/contato\(s\) selecionado\(s\)/)).not.toBeInTheDocument();
  });

  it("mostra diálogo de resultado quando aplicar etiqueta em lote tem falhas parciais", async () => {
    mockContacts(ok(CONTACTS));
    const applyTag = vi.fn().mockResolvedValue({
      sucesso: 1,
      falhas: 1,
      erros: [{ id: "c2", motivo: "contato bloqueado" }],
    });
    vi.mocked(useBulkContactActions).mockReturnValue({
      applyTag,
      isApplyingTag: false,
      bulkSoftDelete: vi.fn(),
      isBulkDeleting: false,
    });
    const user = userEvent.setup();
    renderWithQueryClient(<ContactsPage />);

    await screen.findByText("Ana Souza");
    await user.click(screen.getByLabelText("Selecionar todos os contatos filtrados"));
    await user.click(screen.getByRole("button", { name: /Aplicar etiqueta/ }));
    await user.click(await screen.findByRole("button", { name: "Quente" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("1 sucesso(s), 1 falha(s) — ver detalhes"),
    );
    expect(await screen.findByText('Resultado — aplicar etiqueta "Quente"')).toBeInTheDocument();
    expect(screen.getByText("Bruno Lima: contato bloqueado")).toBeInTheDocument();

    // Fecha o diálogo de resultado — cobre o onOpenChange encadeado no route.
    await user.click(screen.getByRole("button", { name: "Fechar" }));
    expect(screen.queryByText('Resultado — aplicar etiqueta "Quente"')).not.toBeInTheDocument();
  });

  it("mostra toast de erro quando aplicar etiqueta em lote lança exceção", async () => {
    mockContacts(ok(CONTACTS));
    const applyTag = vi.fn().mockRejectedValue(new Error("falha de rede ao aplicar etiqueta"));
    vi.mocked(useBulkContactActions).mockReturnValue({
      applyTag,
      isApplyingTag: false,
      bulkSoftDelete: vi.fn(),
      isBulkDeleting: false,
    });
    const user = userEvent.setup();
    renderWithQueryClient(<ContactsPage />);

    await screen.findByText("Ana Souza");
    await user.click(screen.getByLabelText("Selecionar Ana Souza"));
    await user.click(screen.getByRole("button", { name: /Aplicar etiqueta/ }));
    await user.click(await screen.findByRole("button", { name: "Quente" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("falha de rede ao aplicar etiqueta"),
    );
  });

  it("exclui contatos em lote com sucesso total", async () => {
    mockContacts(ok(CONTACTS));
    const bulkSoftDelete = vi.fn().mockResolvedValue({ sucesso: 2, falhas: 0, erros: [] });
    vi.mocked(useBulkContactActions).mockReturnValue({
      applyTag: vi.fn(),
      isApplyingTag: false,
      bulkSoftDelete,
      isBulkDeleting: false,
    });
    const user = userEvent.setup();
    renderWithQueryClient(<ContactsPage />);

    await screen.findByText("Ana Souza");
    await user.click(screen.getByLabelText("Selecionar todos os contatos filtrados"));
    await user.click(screen.getByRole("button", { name: "Excluir selecionados" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Excluir" }));

    await waitFor(() => expect(bulkSoftDelete).toHaveBeenCalledWith(["c1", "c2"]));
    expect(toast.success).toHaveBeenCalledWith("2 contato(s) excluído(s)");
  });

  it("mostra diálogo de resultado quando excluir em lote tem falhas parciais", async () => {
    mockContacts(ok(CONTACTS));
    const bulkSoftDelete = vi.fn().mockResolvedValue({
      sucesso: 1,
      falhas: 1,
      erros: [{ id: "c2", motivo: "contato com conversas ativas" }],
    });
    vi.mocked(useBulkContactActions).mockReturnValue({
      applyTag: vi.fn(),
      isApplyingTag: false,
      bulkSoftDelete,
      isBulkDeleting: false,
    });
    const user = userEvent.setup();
    renderWithQueryClient(<ContactsPage />);

    await screen.findByText("Ana Souza");
    await user.click(screen.getByLabelText("Selecionar todos os contatos filtrados"));
    await user.click(screen.getByRole("button", { name: "Excluir selecionados" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Excluir" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("1 sucesso(s), 1 falha(s) — ver detalhes"),
    );
    expect(await screen.findByText("Resultado — excluir contatos")).toBeInTheDocument();
  });

  it("mostra toast de erro quando excluir em lote lança exceção", async () => {
    mockContacts(ok(CONTACTS));
    const bulkSoftDelete = vi.fn().mockRejectedValue(new Error("falha de rede ao excluir"));
    vi.mocked(useBulkContactActions).mockReturnValue({
      applyTag: vi.fn(),
      isApplyingTag: false,
      bulkSoftDelete,
      isBulkDeleting: false,
    });
    const user = userEvent.setup();
    renderWithQueryClient(<ContactsPage />);

    await screen.findByText("Ana Souza");
    await user.click(screen.getByLabelText("Selecionar Ana Souza"));
    await user.click(screen.getByRole("button", { name: "Excluir selecionados" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Excluir" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("falha de rede ao excluir"));
  });

  it("remove o contato excluído individualmente da seleção em lote ativa", async () => {
    mockContacts(ok(CONTACTS));
    const user = userEvent.setup();
    renderWithQueryClient(<ContactsPage />);

    await screen.findByText("Ana Souza");
    await user.click(screen.getByLabelText("Selecionar Ana Souza"));
    expect(screen.getByText("1 contato(s) selecionado(s)")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Excluir Ana Souza"));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Excluir" }));

    await waitFor(() =>
      expect(screen.queryByText(/contato\(s\) selecionado\(s\)/)).not.toBeInTheDocument(),
    );
  });
});
