import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { asFromMock, createQueryBuilder, ok } from "@/test/supabase-mock";
import { ContactFormDialog, type ContactRow } from "./ContactFormDialog";

const useCurrentProfileMock = vi.fn();
const updateEqMock = vi.fn();
const updateMock = vi.fn();
const insertMock = vi.fn();
const fromMock = vi.fn();
const usePluginActiveMock = vi.fn();

vi.mock("@/lib/api/session", () => ({
  useCurrentProfile: () => useCurrentProfileMock(),
}));

// Componente gateia o combobox de Empresa atrás do plugin "companies" --
// mock default true pra não quebrar os testes existentes que não têm relação
// com plugin nenhum; testes específicos de gating sobrescrevem.
vi.mock("@/lib/api/plugins", () => ({
  usePluginActive: (slug: string) => usePluginActiveMock(slug),
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

function buildContact(overrides: Partial<ContactRow> = {}): ContactRow {
  return {
    id: "contact-1",
    tenant_id: "tenant-1",
    name: "Maria Silva",
    phone: "(11) 98888-7777",
    email: "maria@example.com",
    source: "Indicação",
    tags: ["Quente"],
    notes: "Cliente antiga",
    ai_paused: false,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const COMPANIES = [
  { id: "company-1", name: "Acme Ltda" },
  { id: "company-2", name: "Beta S.A." },
];

function renderDialog(props: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  contact?: ContactRow;
}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
  const utils = render(
    <QueryClientProvider client={qc}>
      <ContactFormDialog {...props} />
    </QueryClientProvider>,
  );
  return { ...utils, qc, invalidateSpy };
}

async function selectOrigin(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole("combobox", { name: "Origem" }));
  await user.click(await screen.findByRole("option", { name: label }));
}

describe("ContactFormDialog", () => {
  beforeEach(() => {
    useCurrentProfileMock.mockReset();
    updateEqMock.mockReset();
    updateMock.mockReset();
    insertMock.mockReset();
    fromMock.mockReset();
    usePluginActiveMock.mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();

    useCurrentProfileMock.mockReturnValue({ data: { tenant_id: "tenant-1" } });
    usePluginActiveMock.mockReturnValue(true);
    updateEqMock.mockResolvedValue({ error: null });
    updateMock.mockReturnValue({ eq: updateEqMock });
    // O insert do componente encadeia `.select("id").single()` para recuperar o
    // id do contato criado (usado no upload de avatar) — por isso o mock precisa
    // devolver um query-builder encadeável, não uma Promise crua.
    insertMock.mockReturnValue(createQueryBuilder(ok({ id: "contact-novo" })));
    // "contacts" mantém os mocks simples (update/insert) que os testes já
    // afirmam diretamente; "crm_companies" (combobox de empresas, sempre
    // disparado quando há profile) usa o query-builder encadeável genérico.
    fromMock.mockImplementation(
      asFromMock((table: string) => {
        if (table === "contacts") return { update: updateMock, insert: insertMock };
        if (table === "crm_companies") return createQueryBuilder(ok(COMPANIES));
        return createQueryBuilder(ok(null));
      }),
    );
  });

  describe("modo criação", () => {
    it("renderiza título, campos vazios e botão de criação", () => {
      renderDialog({ open: true, onOpenChange: vi.fn() });

      expect(screen.getByText("Novo contato")).toBeInTheDocument();
      expect(screen.getByLabelText("Nome *")).toHaveValue("");
      expect(screen.getByLabelText("Telefone")).toHaveValue("");
      expect(screen.getByLabelText("E-mail")).toHaveValue("");
      expect(screen.getByRole("combobox", { name: "Origem" })).toHaveTextContent("Site");
      expect(screen.getByRole("combobox", { name: "Empresa" })).toHaveTextContent("Sem empresa");
      expect(screen.getByRole("button", { name: "Criar contato" })).toBeInTheDocument();
    });

    it("envia insert com tenant_id e campos vazios convertidos para null", async () => {
      const user = userEvent.setup();
      const onOpenChange = vi.fn();
      renderDialog({ open: true, onOpenChange });

      await user.type(screen.getByLabelText("Nome *"), "Novo Contato");
      await user.click(screen.getByRole("button", { name: "Criar contato" }));

      await waitFor(() =>
        expect(insertMock).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "Novo Contato",
            phone: null,
            email: null,
            source: "Site",
            notes: null,
            tags: [],
            company_id: null,
            tenant_id: "tenant-1",
          }),
        ),
      );
      expect(toast.success).toHaveBeenCalledWith("Contato criado");
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it("envia insert com todos os campos preenchidos", async () => {
      const user = userEvent.setup();
      renderDialog({ open: true, onOpenChange: vi.fn() });

      await user.type(screen.getByLabelText("Nome *"), "Novo Contato");
      await user.type(screen.getByLabelText("Telefone"), "(11) 90000-0000");
      await user.type(screen.getByLabelText("E-mail"), "novo@example.com");
      await user.type(screen.getByLabelText("Notas"), "Observações");
      await user.click(screen.getByRole("button", { name: "Criar contato" }));

      await waitFor(() =>
        expect(insertMock).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "Novo Contato",
            phone: "(11) 90000-0000",
            email: "novo@example.com",
            source: "Site",
            notes: "Observações",
            tags: [],
            company_id: null,
            tenant_id: "tenant-1",
          }),
        ),
      );
    });
  });

  describe("modo edição", () => {
    it("renderiza título, campos preenchidos e botão de salvar", () => {
      const contact = buildContact();
      renderDialog({ open: true, onOpenChange: vi.fn(), contact });

      expect(screen.getByText("Editar contato")).toBeInTheDocument();
      expect(screen.getByLabelText("Nome *")).toHaveValue("Maria Silva");
      expect(screen.getByLabelText("Telefone")).toHaveValue("(11) 98888-7777");
      expect(screen.getByLabelText("E-mail")).toHaveValue("maria@example.com");
      expect(screen.getByLabelText("Notas")).toHaveValue("Cliente antiga");
      expect(screen.getByRole("combobox", { name: "Origem" })).toHaveTextContent("Indicação");
      expect(screen.getByRole("button", { name: "Salvar" })).toBeInTheDocument();

      const checkbox = screen.getByRole("checkbox", { name: "Quente" });
      expect(checkbox).toHaveAttribute("data-state", "checked");
    });

    it("envia update com o payload correto sem tenant_id", async () => {
      const user = userEvent.setup();
      const onOpenChange = vi.fn();
      const contact = buildContact();
      renderDialog({ open: true, onOpenChange, contact });

      await user.click(screen.getByRole("button", { name: "Salvar" }));

      await waitFor(() =>
        expect(updateMock).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "Maria Silva",
            phone: "(11) 98888-7777",
            email: "maria@example.com",
            source: "Indicação",
            notes: "Cliente antiga",
            tags: ["Quente"],
            company_id: null,
          }),
        ),
      );
      expect(updateEqMock).toHaveBeenCalledWith("id", "contact-1");
      expect(toast.success).toHaveBeenCalledWith("Contato atualizado");
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("reseta o formulário quando reabre com um contact diferente", () => {
    const contactA = buildContact({ id: "a", name: "Contato A" });
    const contactB = buildContact({ id: "b", name: "Contato B", tags: ["Frio"] });

    const { rerender } = render(
      <QueryClientProvider client={new QueryClient()}>
        <ContactFormDialog open={true} onOpenChange={vi.fn()} contact={contactA} />
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText("Nome *")).toHaveValue("Contato A");

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <ContactFormDialog open={true} onOpenChange={vi.fn()} contact={contactB} />
      </QueryClientProvider>,
    );

    expect(screen.getByLabelText("Nome *")).toHaveValue("Contato B");
    expect(screen.getByRole("checkbox", { name: "Frio" })).toHaveAttribute("data-state", "checked");
  });

  it("não reseta o formulário quando open é false", () => {
    const contactA = buildContact({ id: "a", name: "Contato A" });
    const contactB = buildContact({ id: "b", name: "Contato B" });

    const { rerender } = render(
      <QueryClientProvider client={new QueryClient()}>
        <ContactFormDialog open={false} onOpenChange={vi.fn()} contact={contactA} />
      </QueryClientProvider>,
    );

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <ContactFormDialog open={false} onOpenChange={vi.fn()} contact={contactB} />
      </QueryClientProvider>,
    );

    // Dialog fechado: Radix não renderiza o conteúdo, então não há como consultar os campos.
    expect(screen.queryByLabelText("Nome *")).not.toBeInTheDocument();
  });

  describe("validação", () => {
    it("mostra erro quando o nome está vazio e não chama a mutation", async () => {
      const user = userEvent.setup();
      renderDialog({ open: true, onOpenChange: vi.fn() });

      await user.click(screen.getByRole("button", { name: "Criar contato" }));

      expect(await screen.findByText("Nome é obrigatório")).toBeInTheDocument();
      expect(insertMock).not.toHaveBeenCalled();
    });

    it("mostra erro quando o e-mail é inválido", async () => {
      const user = userEvent.setup();
      renderDialog({ open: true, onOpenChange: vi.fn() });

      await user.type(screen.getByLabelText("Nome *"), "Fulano");
      // "abc@abc" satisfaz a validação nativa do input type=email do jsdom
      // (permitindo o evento submit disparar) mas falha no regex mais estrito do zod.
      await user.type(screen.getByLabelText("E-mail"), "abc@abc");
      await user.click(screen.getByRole("button", { name: "Criar contato" }));

      expect(await screen.findByText("E-mail inválido")).toBeInTheDocument();
      expect(insertMock).not.toHaveBeenCalled();
    });

    it("aceita e-mail vazio como válido", async () => {
      const user = userEvent.setup();
      renderDialog({ open: true, onOpenChange: vi.fn() });

      await user.type(screen.getByLabelText("Nome *"), "Fulano");
      await user.click(screen.getByRole("button", { name: "Criar contato" }));

      await waitFor(() => expect(insertMock).toHaveBeenCalled());
      expect(screen.queryByText("E-mail inválido")).not.toBeInTheDocument();
    });
  });

  describe("etiquetas", () => {
    it("marca uma etiqueta sugerida e envia no payload", async () => {
      const user = userEvent.setup();
      renderDialog({ open: true, onOpenChange: vi.fn() });

      await user.type(screen.getByLabelText("Nome *"), "Fulano");
      await user.click(screen.getByRole("checkbox", { name: "VIP" }));
      await user.click(screen.getByRole("button", { name: "Criar contato" }));

      await waitFor(() =>
        expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({ tags: ["VIP"] })),
      );
    });

    it("desmarca uma etiqueta previamente marcada", async () => {
      const user = userEvent.setup();
      const contact = buildContact({ tags: ["Quente", "Frio"] });
      renderDialog({ open: true, onOpenChange: vi.fn(), contact });

      await user.click(screen.getByRole("checkbox", { name: "Quente" }));
      await user.click(screen.getByRole("button", { name: "Salvar" }));

      await waitFor(() =>
        expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ tags: ["Frio"] })),
      );
    });

    it("adiciona etiqueta customizada pelo botão Adicionar", async () => {
      const user = userEvent.setup();
      renderDialog({ open: true, onOpenChange: vi.fn() });

      await user.type(screen.getByLabelText("Nome *"), "Fulano");
      await user.type(screen.getByPlaceholderText("Adicionar etiqueta…"), "Urgente");
      await user.click(screen.getByRole("button", { name: "Adicionar" }));

      expect(screen.getByRole("checkbox", { name: "Urgente" })).toHaveAttribute(
        "data-state",
        "checked",
      );
      expect(screen.getByPlaceholderText("Adicionar etiqueta…")).toHaveValue("");

      await user.click(screen.getByRole("button", { name: "Criar contato" }));

      await waitFor(() =>
        expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({ tags: ["Urgente"] })),
      );
    });

    it("adiciona etiqueta customizada pela tecla Enter sem submeter o formulário", async () => {
      const user = userEvent.setup();
      renderDialog({ open: true, onOpenChange: vi.fn() });

      await user.type(screen.getByLabelText("Nome *"), "Fulano");
      const input = screen.getByPlaceholderText("Adicionar etiqueta…");
      await user.type(input, "Retorno{Enter}");

      expect(screen.getByRole("checkbox", { name: "Retorno" })).toHaveAttribute(
        "data-state",
        "checked",
      );
      expect(insertMock).not.toHaveBeenCalled();
    });

    it("não duplica etiqueta customizada já existente", async () => {
      const user = userEvent.setup();
      renderDialog({ open: true, onOpenChange: vi.fn() });

      await user.type(screen.getByPlaceholderText("Adicionar etiqueta…"), "Quente");
      await user.click(screen.getByRole("button", { name: "Adicionar" }));

      expect(screen.getAllByRole("checkbox", { name: "Quente" })).toHaveLength(1);
    });

    it("não adiciona etiqueta customizada vazia ou só com espaços", async () => {
      const user = userEvent.setup();
      renderDialog({ open: true, onOpenChange: vi.fn() });

      const checkboxesBefore = screen.getAllByRole("checkbox").length;

      await user.type(screen.getByPlaceholderText("Adicionar etiqueta…"), "   ");
      await user.click(screen.getByRole("button", { name: "Adicionar" }));

      expect(screen.getAllByRole("checkbox")).toHaveLength(checkboxesBefore);
    });
  });

  it("altera a origem via select e envia o novo valor no payload", async () => {
    const user = userEvent.setup();
    renderDialog({ open: true, onOpenChange: vi.fn() });

    await user.type(screen.getByLabelText("Nome *"), "Fulano");
    await selectOrigin(user, "WhatsApp");
    await user.click(screen.getByRole("button", { name: "Criar contato" }));

    await waitFor(() =>
      expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({ source: "WhatsApp" })),
    );
  });

  describe("erros", () => {
    it("mostra toast de erro com a mensagem da exceção quando o insert falha", async () => {
      const user = userEvent.setup();
      insertMock.mockReturnValue(
        createQueryBuilder({ data: null, error: new Error("Falha no banco") }),
      );
      renderDialog({ open: true, onOpenChange: vi.fn() });

      await user.type(screen.getByLabelText("Nome *"), "Fulano");
      await user.click(screen.getByRole("button", { name: "Criar contato" }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Falha no banco"));
    });

    it('usa a mensagem padrão "Erro ao salvar" quando o erro não tem mensagem', async () => {
      const user = userEvent.setup();
      // Sem a chave "message": e.message fica undefined e o "??" cai no fallback
      // (uma string vazia não ativaria o fallback, pois "??" só reage a null/undefined).
      // Erro sem `message` de propósito: o componente usa `e.message ?? "Erro ao salvar"`,
      // então só a ausência da propriedade (não string vazia) exercita o default.
      const errorSemMensagem = { code: "23505" } as unknown as { message: string };
      insertMock.mockReturnValue(createQueryBuilder({ data: null, error: errorSemMensagem }));
      renderDialog({ open: true, onOpenChange: vi.fn() });

      await user.type(screen.getByLabelText("Nome *"), "Fulano");
      await user.click(screen.getByRole("button", { name: "Criar contato" }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Erro ao salvar"));
    });

    it("mostra toast de erro com a mensagem da exceção quando o update falha", async () => {
      const user = userEvent.setup();
      updateEqMock.mockResolvedValue({ error: new Error("Falha ao atualizar") });
      const contact = buildContact();
      renderDialog({ open: true, onOpenChange: vi.fn(), contact });

      await user.click(screen.getByRole("button", { name: "Salvar" }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Falha ao atualizar"));
    });

    it('mostra "Sessão inválida" quando não há profile', async () => {
      const user = userEvent.setup();
      useCurrentProfileMock.mockReturnValue({ data: undefined });
      renderDialog({ open: true, onOpenChange: vi.fn() });

      await user.type(screen.getByLabelText("Nome *"), "Fulano");
      await user.click(screen.getByRole("button", { name: "Criar contato" }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Sessão inválida"));
      expect(insertMock).not.toHaveBeenCalled();
    });
  });

  it('chama onOpenChange(false) ao clicar em "Cancelar" sem submeter', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderDialog({ open: true, onOpenChange });

    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('mostra "Salvando…" e desabilita o botão enquanto a mutation está pendente', async () => {
    const user = userEvent.setup();
    // Segura o `.single()` do insert pendente para exercitar o estado de loading.
    let resolveInsert: (value: { data: { id: string }; error: null }) => void = () => {};
    const pendingBuilder = createQueryBuilder<{ id: string }>({ data: null, error: null });
    pendingBuilder.single = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveInsert = resolve;
        }),
    );
    insertMock.mockReturnValue(pendingBuilder);
    renderDialog({ open: true, onOpenChange: vi.fn() });

    await user.type(screen.getByLabelText("Nome *"), "Fulano");
    await user.click(screen.getByRole("button", { name: "Criar contato" }));

    const pendingButton = await screen.findByRole("button", { name: "Salvando…" });
    expect(pendingButton).toBeDisabled();

    resolveInsert({ data: { id: "contact-novo" }, error: null });
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it("invalida as queries de contacts, contact e dashboard ao salvar com sucesso", async () => {
    const user = userEvent.setup();
    const contact = buildContact();
    const { invalidateSpy } = renderDialog({ open: true, onOpenChange: vi.fn(), contact });

    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["contacts"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["contact", "contact-1"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["dashboard"] });
  });

  describe("vínculo com empresa", () => {
    it("esconde o campo Empresa quando o plugin companies não está ativo pro tenant", () => {
      usePluginActiveMock.mockImplementation((slug: string) => slug !== "companies");
      const contact = buildContact({ company_id: "company-2" });
      renderDialog({ open: true, onOpenChange: vi.fn(), contact });

      expect(screen.queryByRole("combobox", { name: "Empresa" })).not.toBeInTheDocument();
    });

    it("mostra 'Sem empresa' quando o contato não tem company_id", () => {
      const contact = buildContact({ company_id: null });
      renderDialog({ open: true, onOpenChange: vi.fn(), contact });

      expect(screen.getByRole("combobox", { name: "Empresa" })).toHaveTextContent("Sem empresa");
    });

    it("pré-seleciona a empresa do contato em modo edição", async () => {
      const contact = buildContact({ company_id: "company-2" });
      renderDialog({ open: true, onOpenChange: vi.fn(), contact });

      await waitFor(() =>
        expect(screen.getByRole("combobox", { name: "Empresa" })).toHaveTextContent("Beta S.A."),
      );
    });

    it("seleciona uma empresa existente pelo combobox e envia company_id no payload", async () => {
      const user = userEvent.setup();
      renderDialog({ open: true, onOpenChange: vi.fn() });

      await user.type(screen.getByLabelText("Nome *"), "Fulano");
      await user.click(screen.getByRole("combobox", { name: "Empresa" }));
      await user.click(await screen.findByText("Acme Ltda"));

      expect(screen.getByRole("combobox", { name: "Empresa" })).toHaveTextContent("Acme Ltda");

      await user.click(screen.getByRole("button", { name: "Criar contato" }));

      await waitFor(() =>
        expect(insertMock).toHaveBeenCalledWith(
          expect.objectContaining({ company_id: "company-1" }),
        ),
      );
    });

    it("permite voltar para 'Sem empresa' após selecionar uma", async () => {
      const user = userEvent.setup();
      const contact = buildContact({ company_id: "company-2" });
      renderDialog({ open: true, onOpenChange: vi.fn(), contact });

      await waitFor(() =>
        expect(screen.getByRole("combobox", { name: "Empresa" })).toHaveTextContent("Beta S.A."),
      );

      await user.click(screen.getByRole("combobox", { name: "Empresa" }));
      await user.click(await screen.findByText("Sem empresa"));

      expect(screen.getByRole("combobox", { name: "Empresa" })).toHaveTextContent("Sem empresa");

      await user.click(screen.getByRole("button", { name: "Salvar" }));

      await waitFor(() =>
        expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ company_id: null })),
      );
    });

    it('oferece "Criar empresa" quando a busca não bate com nenhuma existente e abre o CompanyFormDialog', async () => {
      const user = userEvent.setup();
      renderDialog({ open: true, onOpenChange: vi.fn() });

      await user.click(screen.getByRole("combobox", { name: "Empresa" }));
      await user.type(screen.getByPlaceholderText("Buscar empresa…"), "Nova Indústria");

      await user.click(await screen.findByText('Criar empresa "Nova Indústria"'));

      const companyDialog = within(await screen.findByRole("dialog", { name: "Nova empresa" }));
      expect(companyDialog.getByLabelText("Nome *")).toHaveValue("Nova Indústria");
    });

    it("invalida company-contacts (empresa antiga e nova) e company-deals ao trocar de empresa", async () => {
      const user = userEvent.setup();
      const contact = buildContact({ company_id: "company-1" });
      const { invalidateSpy } = renderDialog({ open: true, onOpenChange: vi.fn(), contact });

      await waitFor(() =>
        expect(screen.getByRole("combobox", { name: "Empresa" })).toHaveTextContent("Acme Ltda"),
      );

      await user.click(screen.getByRole("combobox", { name: "Empresa" }));
      await user.click(await screen.findByText("Beta S.A."));
      await user.click(screen.getByRole("button", { name: "Salvar" }));

      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["company-contacts", "company-1"] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["company-contacts", "company-2"] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["company-deals"] });
    });

    it("não invalida company-contacts quando a empresa do contato não muda", async () => {
      const user = userEvent.setup();
      const contact = buildContact({ company_id: "company-1" });
      const { invalidateSpy } = renderDialog({ open: true, onOpenChange: vi.fn(), contact });

      await waitFor(() =>
        expect(screen.getByRole("combobox", { name: "Empresa" })).toHaveTextContent("Acme Ltda"),
      );
      await user.click(screen.getByRole("button", { name: "Salvar" }));

      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      expect(invalidateSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: expect.arrayContaining(["company-contacts"]) }),
      );
      expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ["company-deals"] });
    });

    it("seleciona automaticamente a empresa recém-criada inline e invalida companies-lite", async () => {
      const user = userEvent.setup();
      // Lista "viva": o insert acrescenta a empresa nova, e o select (refeito
      // pelo invalidateQueries de companies-lite) passa a enxergá-la -- exercita
      // o fluxo real de invalidação, não só o payload do insert.
      let currentCompanies = [...COMPANIES];
      const dialogSingleMock = vi.fn().mockImplementation(async () => {
        const created = {
          id: "company-3",
          tenant_id: "tenant-1",
          name: "Nova Indústria",
          industry: null,
          website: null,
          created_at: "2026-01-01T00:00:00Z",
        };
        currentCompanies = [...currentCompanies, created];
        return ok(created);
      });
      fromMock.mockImplementation(
        asFromMock((table: string) => {
          if (table === "crm_companies") {
            return {
              select: () => ({ is: () => ({ order: () => ok(currentCompanies) }) }),
              insert: () => ({ select: () => ({ single: dialogSingleMock }) }),
            };
          }
          return { update: updateMock, insert: insertMock };
        }),
      );

      const { invalidateSpy } = renderDialog({ open: true, onOpenChange: vi.fn() });

      await user.click(screen.getByRole("combobox", { name: "Empresa" }));
      await user.type(screen.getByPlaceholderText("Buscar empresa…"), "Nova Indústria");
      await user.click(await screen.findByText('Criar empresa "Nova Indústria"'));

      const companyDialog = within(await screen.findByRole("dialog", { name: "Nova empresa" }));
      expect(companyDialog.getByLabelText("Nome *")).toHaveValue("Nova Indústria");
      await user.click(companyDialog.getByRole("button", { name: "Criar empresa" }));

      await waitFor(() =>
        expect(screen.getByRole("combobox", { name: "Empresa" })).toHaveTextContent(
          "Nova Indústria",
        ),
      );
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["companies-lite"] });
    });
  });
});
