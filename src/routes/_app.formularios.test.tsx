import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UseQueryResult } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { renderWithQueryClient } from "@/test/render";
import { asFromMock, createFromByTable, createQueryBuilder, fail, ok } from "@/test/supabase-mock";
import { useCurrentProfile, requireAdmin, type CurrentProfile } from "@/lib/api/session";
import { buildPublicFormUrl, type LeadFormRow } from "@/hooks/use-lead-forms";
import { Route } from "./_app.formularios";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));

vi.mock("@/lib/api/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/session")>();
  return { ...actual, useCurrentProfile: vi.fn(), requireAdmin: vi.fn() };
});

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const FormulariosPage = Route.options.component!;

function mockProfile(profile: CurrentProfile) {
  vi.mocked(useCurrentProfile).mockReturnValue({
    data: profile,
    isLoading: false,
  } as UseQueryResult<CurrentProfile | null, Error>);
}

function mockForms(forms: LeadFormRow[]) {
  vi.mocked(supabase.from).mockImplementation(
    createFromByTable({
      lead_forms: ok(forms),
      custom_field_definitions: ok([]),
    }),
  );
}

function mockClipboard() {
  // userEvent.setup() reatribui navigator.clipboard ao próprio polyfill — reaplica o mock depois.
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

const FORM_ROW: LeadFormRow = {
  id: "form-1",
  tenant_id: "t1",
  name: "Contato site",
  slug: "contato-site",
  is_active: true,
  success_message: "Obrigado!",
  fields: [
    {
      key: "nome",
      label: "Nome",
      type: "text",
      required: true,
      maps_to_custom_field_id: null,
    },
  ],
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
};

describe("head() da rota de formulários", () => {
  it("define título e descrição de SEO", async () => {
    const head = await Route.options.head?.({} as never);
    const titleMeta = head?.meta?.find((m) => m && "title" in m);
    expect(titleMeta).toMatchObject({ title: "Formulários de captura" });
    expect(head?.links?.some((l) => l && "rel" in l && l.rel === "canonical")).toBe(true);
  });
});

describe("beforeLoad() da rota de formulários", () => {
  it("delega o guard de admin para requireAdmin", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(undefined);
    const queryClient = { fake: true };

    await Route.options.beforeLoad?.({ context: { queryClient } } as never);

    expect(requireAdmin).toHaveBeenCalledWith(queryClient);
  });
});

describe("página de formulários (/_app/formularios)", () => {
  beforeEach(() => {
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it("mostra estado de erro com opção de tentar novamente quando a query falha", async () => {
    mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
    vi.mocked(supabase.from).mockImplementation(
      createFromByTable({ lead_forms: fail("timeout ao buscar formulários") }),
    );
    renderWithQueryClient(<FormulariosPage />);

    expect(await screen.findByText("Erro ao carregar")).toBeInTheDocument();
    expect(screen.getByText("timeout ao buscar formulários")).toBeInTheDocument();
  });

  it("estado vazio quando o tenant não tem formulários", async () => {
    mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
    mockForms([]);
    renderWithQueryClient(<FormulariosPage />);

    expect(await screen.findByText("Nenhum formulário criado")).toBeInTheDocument();
  });

  it("estado vazio para não-admin não mostra ação de criar formulário", async () => {
    mockProfile({ id: "u2", tenant_id: "t1", name: "Bia", role: "agent" });
    mockForms([]);
    renderWithQueryClient(<FormulariosPage />);

    await screen.findByText("Nenhum formulário criado");
    expect(screen.queryByRole("button", { name: /Novo formulário/ })).not.toBeInTheDocument();
  });

  it("clicar no botão do próprio estado vazio abre o diálogo de criação", async () => {
    mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
    mockForms([]);
    const user = userEvent.setup();
    renderWithQueryClient(<FormulariosPage />);

    await screen.findByText("Nenhum formulário criado");
    // 2 botões "Novo formulário": o do PageHeader (índice 0) e o do EmptyState
    // (índice 1) -- aqui exercitamos especificamente o onAction do EmptyState.
    const buttons = screen.getAllByRole("button", { name: "Novo formulário" });
    await user.click(buttons[buttons.length - 1]!);

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("clicar em 'Tentar novamente' no estado de erro dispara um novo fetch", async () => {
    mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
    vi.mocked(supabase.from).mockImplementation(
      createFromByTable({ lead_forms: fail("timeout ao buscar formulários") }),
    );
    const user = userEvent.setup();
    renderWithQueryClient(<FormulariosPage />);

    await screen.findByText("Erro ao carregar");
    const callsBefore = vi.mocked(supabase.from).mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));

    await waitFor(() =>
      expect(vi.mocked(supabase.from).mock.calls.length).toBeGreaterThan(callsBefore),
    );
  });

  describe("URL pública", () => {
    it("exibe a URL pública com o id do formulário (não o slug) e copia ao clicar", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockForms([FORM_ROW]);
      const user = userEvent.setup();
      const writeText = mockClipboard();
      renderWithQueryClient(<FormulariosPage />);

      await screen.findByText("Contato site");
      const expectedUrl = buildPublicFormUrl("form-1");
      expect(expectedUrl).toContain("/f/form-1");
      expect(screen.getByDisplayValue(expectedUrl)).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Copiar URL pública" }));
      expect(writeText).toHaveBeenCalledWith(expectedUrl);
      expect(toast.success).toHaveBeenCalledWith("URL copiada");
    });
  });

  describe("admin vs não-admin", () => {
    it("admin: vê botão de novo formulário, editar, excluir e o toggle de ativo", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockForms([FORM_ROW]);
      renderWithQueryClient(<FormulariosPage />);

      await screen.findByText("Contato site");
      expect(screen.getByRole("button", { name: "Novo formulário" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Editar" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Excluir" })).toBeInTheDocument();
      expect(
        screen.getByRole("switch", { name: "Ativar ou desativar formulário" }),
      ).toBeInTheDocument();
    });

    it("não-admin: não vê nenhuma ação de escrita", async () => {
      mockProfile({ id: "u2", tenant_id: "t1", name: "Bia", role: "agent" });
      mockForms([FORM_ROW]);
      renderWithQueryClient(<FormulariosPage />);

      await screen.findByText("Contato site");
      expect(screen.queryByRole("button", { name: "Novo formulário" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Editar" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Excluir" })).not.toBeInTheDocument();
      expect(
        screen.queryByRole("switch", { name: "Ativar ou desativar formulário" }),
      ).not.toBeInTheDocument();
    });
  });

  describe("cartão de formulário — variações", () => {
    it("mostra badge 'Inativo' e a contagem no plural para form com 0 campos", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockForms([{ ...FORM_ROW, is_active: false, fields: [] }]);
      renderWithQueryClient(<FormulariosPage />);

      await screen.findByText("Contato site");
      expect(screen.getByText("Inativo")).toBeInTheDocument();
      expect(screen.getByText(/0 campos configurados/)).toBeInTheDocument();
    });
  });

  describe("criar formulário", () => {
    it("gera o slug automaticamente a partir do nome", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockForms([]);
      const user = userEvent.setup();
      renderWithQueryClient(<FormulariosPage />);

      await screen.findByText("Nenhum formulário criado");
      await user.click(screen.getAllByRole("button", { name: "Novo formulário" })[0]!);

      await user.type(screen.getByLabelText("Nome *"), "Formulário de Contação — Ação!");

      expect(screen.getByLabelText("Endereço da página *")).toHaveValue(
        "formulario-de-contacao-acao",
      );
    });

    it("insere com tenant_id do perfil atual e os campos adicionados no builder", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      // Mesmo builder serve a listagem inicial (select -> []) e o insert do
      // submit -- createQueryBuilder resolve qualquer chain com o `ok(null)`
      // configurado, o que importa aqui é inspecionar a chamada a `.insert`.
      const listBuilder = createQueryBuilder<LeadFormRow[]>(ok([]));
      vi.mocked(supabase.from).mockImplementation((table: string) => {
        if (table === "custom_field_definitions") {
          return createQueryBuilder(ok([])) as unknown as ReturnType<typeof supabase.from>;
        }
        return listBuilder as unknown as ReturnType<typeof supabase.from>;
      });

      const user = userEvent.setup();
      renderWithQueryClient(<FormulariosPage />);

      await screen.findByText("Nenhum formulário criado");
      await user.click(screen.getAllByRole("button", { name: "Novo formulário" })[0]!);

      await user.type(screen.getByLabelText("Nome *"), "Contato site");
      await user.click(screen.getByRole("button", { name: "Adicionar campo" }));

      const labelInputs = screen.getAllByLabelText("Rótulo *");
      await user.type(labelInputs[0]!, "Nome completo");
      const keyInputs = screen.getAllByLabelText("Chave *");
      await user.type(keyInputs[0]!, "nome");

      await user.click(screen.getByRole("button", { name: "Criar formulário" }));

      await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Formulário criado"));
      expect(listBuilder.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant_id: "t1",
          name: "Contato site",
          slug: "contato-site",
          is_active: true,
          fields: [
            expect.objectContaining({
              key: "nome",
              label: "Nome completo",
              type: "text",
              required: false,
              maps_to_custom_field_id: null,
            }),
          ],
        }),
      );
    });

    it("bloqueia o envio quando um campo do builder ficou sem chave ou rótulo", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      const listBuilder = createQueryBuilder<LeadFormRow[]>(ok([]));
      vi.mocked(supabase.from).mockImplementation((table: string) => {
        if (table === "custom_field_definitions") {
          return createQueryBuilder(ok([])) as unknown as ReturnType<typeof supabase.from>;
        }
        return listBuilder as unknown as ReturnType<typeof supabase.from>;
      });
      const user = userEvent.setup();
      renderWithQueryClient(<FormulariosPage />);

      await screen.findByText("Nenhum formulário criado");
      await user.click(screen.getAllByRole("button", { name: "Novo formulário" })[0]!);

      await user.type(screen.getByLabelText("Nome *"), "Contato site");
      await user.click(screen.getByRole("button", { name: "Adicionar campo" }));
      // Não preenche rótulo/chave do campo adicionado.
      await user.click(screen.getByRole("button", { name: "Criar formulário" }));

      expect(toast.error).toHaveBeenCalledWith("Todo campo precisa de chave e rótulo preenchidos");
      expect(listBuilder.insert).not.toHaveBeenCalled();
    });
  });

  describe("builder de campos — adicionar/remover/reordenar", () => {
    it("adiciona, reordena (mover para baixo) e remove um campo", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockForms([]);
      const user = userEvent.setup();
      renderWithQueryClient(<FormulariosPage />);

      await screen.findByText("Nenhum formulário criado");
      await user.click(screen.getAllByRole("button", { name: "Novo formulário" })[0]!);

      await user.click(screen.getByRole("button", { name: "Adicionar campo" }));
      await user.type(screen.getAllByLabelText("Rótulo *")[0]!, "Nome");
      await user.click(screen.getByRole("button", { name: "Adicionar campo" }));
      await user.type(screen.getAllByLabelText("Rótulo *")[1]!, "Telefone");

      let labelInputs = screen.getAllByLabelText("Rótulo *") as HTMLInputElement[];
      expect(labelInputs.map((i) => i.value)).toEqual(["Nome", "Telefone"]);

      // Move o primeiro campo ("Nome") para baixo -> ordem inverte.
      await user.click(screen.getByRole("button", { name: "Mover campo 1 para baixo" }));
      labelInputs = screen.getAllByLabelText("Rótulo *") as HTMLInputElement[];
      expect(labelInputs.map((i) => i.value)).toEqual(["Telefone", "Nome"]);

      // Remove o campo agora na posição 1 ("Telefone").
      await user.click(screen.getByRole("button", { name: "Remover campo 1" }));
      labelInputs = screen.getAllByLabelText("Rótulo *") as HTMLInputElement[];
      expect(labelInputs.map((i) => i.value)).toEqual(["Nome"]);
    });

    it("botão de mover para cima fica desabilitado no primeiro campo", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockForms([]);
      const user = userEvent.setup();
      renderWithQueryClient(<FormulariosPage />);

      await screen.findByText("Nenhum formulário criado");
      await user.click(screen.getAllByRole("button", { name: "Novo formulário" })[0]!);
      await user.click(screen.getByRole("button", { name: "Adicionar campo" }));

      expect(screen.getByRole("button", { name: "Mover campo 1 para cima" })).toBeDisabled();
    });
  });

  describe("editar formulário existente", () => {
    it("abre o diálogo pré-preenchido com os dados e campos atuais", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockForms([FORM_ROW]);
      const user = userEvent.setup();
      renderWithQueryClient(<FormulariosPage />);

      await screen.findByText("Contato site");
      await user.click(screen.getByRole("button", { name: "Editar" }));

      expect(screen.getByLabelText("Nome *")).toHaveValue("Contato site");
      expect(screen.getByLabelText("Endereço da página *")).toHaveValue("contato-site");
      expect(screen.getByLabelText("Rótulo *")).toHaveValue("Nome");
    });

    it("salva a edição com sucesso chamando update com o id do formulário", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      const listBuilder = createQueryBuilder(ok([FORM_ROW]));
      vi.mocked(supabase.from).mockImplementation((table: string) => {
        if (table === "custom_field_definitions") {
          return createQueryBuilder(ok([])) as unknown as ReturnType<typeof supabase.from>;
        }
        return listBuilder as unknown as ReturnType<typeof supabase.from>;
      });
      const user = userEvent.setup();
      renderWithQueryClient(<FormulariosPage />);

      await screen.findByText("Contato site");
      await user.click(screen.getByRole("button", { name: "Editar" }));
      await screen.findByRole("dialog");

      await user.click(screen.getByRole("button", { name: "Salvar alterações" }));

      await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Formulário atualizado"));
      expect(listBuilder.update).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Contato site", slug: "contato-site" }),
      );
      expect(listBuilder.eq).toHaveBeenCalledWith("id", "form-1");
    });

    it("mostra toast de erro quando salvar a edição falha no backend", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      let leadFormsCall = 0;
      vi.mocked(supabase.from).mockImplementation(
        asFromMock((table: string) => {
          if (table === "custom_field_definitions") return createQueryBuilder(ok([]));
          if (table === "lead_forms") {
            leadFormsCall += 1;
            return createQueryBuilder(
              leadFormsCall === 1 ? ok([FORM_ROW]) : fail("falha ao salvar formulário"),
            );
          }
          return createQueryBuilder(ok([]));
        }),
      );
      const user = userEvent.setup();
      renderWithQueryClient(<FormulariosPage />);

      await screen.findByText("Contato site");
      await user.click(screen.getByRole("button", { name: "Editar" }));
      await screen.findByRole("dialog");

      await user.click(screen.getByRole("button", { name: "Salvar alterações" }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("falha ao salvar formulário"));
    });
  });

  describe("ativar/desativar", () => {
    it("clicar no switch chama o toggle com o novo valor", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      const builder = createQueryBuilder(ok(null));
      vi.mocked(supabase.from).mockImplementation((table: string) => {
        if (table === "lead_forms") return builder as unknown as ReturnType<typeof supabase.from>;
        return createQueryBuilder(ok([])) as unknown as ReturnType<typeof supabase.from>;
      });
      const listBuilder = createQueryBuilder(ok([FORM_ROW]));
      vi.mocked(supabase.from).mockImplementation((table: string) => {
        if (table === "custom_field_definitions") {
          return createQueryBuilder(ok([])) as unknown as ReturnType<typeof supabase.from>;
        }
        return listBuilder as unknown as ReturnType<typeof supabase.from>;
      });

      const user = userEvent.setup();
      renderWithQueryClient(<FormulariosPage />);

      await screen.findByText("Contato site");
      await user.click(screen.getByRole("switch", { name: "Ativar ou desativar formulário" }));

      await waitFor(() => expect(listBuilder.update).toHaveBeenCalledWith({ is_active: false }));
      expect(toast.success).toHaveBeenCalledWith("Formulário desativado");
    });

    it("ativar um formulário inativo mostra o toast de ativação", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      const listBuilder = createQueryBuilder(ok([{ ...FORM_ROW, is_active: false }]));
      vi.mocked(supabase.from).mockImplementation((table: string) => {
        if (table === "custom_field_definitions") {
          return createQueryBuilder(ok([])) as unknown as ReturnType<typeof supabase.from>;
        }
        return listBuilder as unknown as ReturnType<typeof supabase.from>;
      });

      const user = userEvent.setup();
      renderWithQueryClient(<FormulariosPage />);

      await screen.findByText("Contato site");
      await user.click(screen.getByRole("switch", { name: "Ativar ou desativar formulário" }));

      await waitFor(() => expect(listBuilder.update).toHaveBeenCalledWith({ is_active: true }));
      expect(toast.success).toHaveBeenCalledWith("Formulário ativado");
    });

    it("mostra toast de erro quando o toggle falha no backend", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      let leadFormsCall = 0;
      vi.mocked(supabase.from).mockImplementation(
        asFromMock((table: string) => {
          if (table === "custom_field_definitions") return createQueryBuilder(ok([]));
          if (table === "lead_forms") {
            leadFormsCall += 1;
            return createQueryBuilder(
              leadFormsCall === 1 ? ok([FORM_ROW]) : fail("falha ao alternar formulário"),
            );
          }
          return createQueryBuilder(ok([]));
        }),
      );
      const user = userEvent.setup();
      renderWithQueryClient(<FormulariosPage />);

      await screen.findByText("Contato site");
      await user.click(screen.getByRole("switch", { name: "Ativar ou desativar formulário" }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("falha ao alternar formulário"));
    });
  });

  describe("excluir formulário", () => {
    it("pede confirmação e só exclui após confirmar", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      const listBuilder = createQueryBuilder(ok([FORM_ROW]));
      vi.mocked(supabase.from).mockImplementation((table: string) => {
        if (table === "custom_field_definitions") {
          return createQueryBuilder(ok([])) as unknown as ReturnType<typeof supabase.from>;
        }
        return listBuilder as unknown as ReturnType<typeof supabase.from>;
      });

      const user = userEvent.setup();
      renderWithQueryClient(<FormulariosPage />);

      await screen.findByText("Contato site");
      await user.click(screen.getByRole("button", { name: "Excluir" }));

      const dialog = await screen.findByRole("alertdialog");
      await user.click(within(dialog).getByRole("button", { name: "Excluir" }));

      await waitFor(() => expect(listBuilder.delete).toHaveBeenCalled());
      expect(toast.success).toHaveBeenCalledWith("Formulário excluído");
    });

    it("mostra toast de erro quando a exclusão falha no backend", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      let leadFormsCall = 0;
      vi.mocked(supabase.from).mockImplementation(
        asFromMock((table: string) => {
          if (table === "custom_field_definitions") return createQueryBuilder(ok([]));
          if (table === "lead_forms") {
            leadFormsCall += 1;
            return createQueryBuilder(
              leadFormsCall === 1 ? ok([FORM_ROW]) : fail("falha ao excluir formulário"),
            );
          }
          return createQueryBuilder(ok([]));
        }),
      );
      const user = userEvent.setup();
      renderWithQueryClient(<FormulariosPage />);

      await screen.findByText("Contato site");
      await user.click(screen.getByRole("button", { name: "Excluir" }));

      const dialog = await screen.findByRole("alertdialog");
      await user.click(within(dialog).getByRole("button", { name: "Excluir" }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("falha ao excluir formulário"));
    });

    it("fecha o alerta de confirmação ao pressionar Escape, sem excluir", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockForms([FORM_ROW]);
      const user = userEvent.setup();
      renderWithQueryClient(<FormulariosPage />);

      await screen.findByText("Contato site");
      await user.click(screen.getByRole("button", { name: "Excluir" }));
      await screen.findByRole("alertdialog");

      await user.keyboard("{Escape}");

      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
      expect(toast.success).not.toHaveBeenCalled();
    });
  });

  describe("diálogo de criação/edição — validação e fechamento", () => {
    it("mostra erro de validação quando o nome está vazio e não envia", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockForms([]);
      const user = userEvent.setup();
      renderWithQueryClient(<FormulariosPage />);

      await screen.findByText("Nenhum formulário criado");
      await user.click(screen.getAllByRole("button", { name: "Novo formulário" })[0]!);
      await screen.findByRole("dialog");

      await user.click(screen.getByRole("button", { name: "Criar formulário" }));

      expect(await screen.findByText("Nome é obrigatório")).toBeInTheDocument();
      expect(toast.success).not.toHaveBeenCalled();
    });

    it("mostra erro de validação quando o slug editado manualmente tem caracteres inválidos", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockForms([]);
      const user = userEvent.setup();
      renderWithQueryClient(<FormulariosPage />);

      await screen.findByText("Nenhum formulário criado");
      await user.click(screen.getAllByRole("button", { name: "Novo formulário" })[0]!);
      await screen.findByRole("dialog");

      await user.type(screen.getByLabelText("Nome *"), "Contato site");
      // Edita o slug manualmente (marca slugTouched) com espaço e maiúsculas,
      // caracteres não aceitos pela regex do schema.
      await user.clear(screen.getByLabelText("Endereço da página *"));
      await user.type(screen.getByLabelText("Endereço da página *"), "Slug Inválido");
      await user.click(screen.getByRole("button", { name: "Criar formulário" }));

      expect(
        await screen.findByText("Use só letras minúsculas, números e hífen"),
      ).toBeInTheDocument();
      expect(toast.success).not.toHaveBeenCalled();
    });

    it("mostra toast de erro quando cria sem tenant_id disponível (perfil ainda carregando)", async () => {
      mockProfile({
        id: "u1",
        tenant_id: undefined as unknown as string,
        name: "Ana",
        role: "admin",
      });
      mockForms([]);
      const user = userEvent.setup();
      renderWithQueryClient(<FormulariosPage />);

      await screen.findByText("Nenhum formulário criado");
      await user.click(screen.getAllByRole("button", { name: "Novo formulário" })[0]!);
      await screen.findByRole("dialog");

      await user.type(screen.getByLabelText("Nome *"), "Contato site");
      await user.click(screen.getByRole("button", { name: "Criar formulário" }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          "Perfil ainda carregando, tente novamente em instantes",
        ),
      );
    });

    it("mostra toast de erro quando criar o formulário falha no backend", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      let leadFormsCall = 0;
      vi.mocked(supabase.from).mockImplementation(
        asFromMock((table: string) => {
          if (table === "custom_field_definitions") return createQueryBuilder(ok([]));
          if (table === "lead_forms") {
            leadFormsCall += 1;
            return createQueryBuilder(
              leadFormsCall === 1 ? ok([]) : fail("falha ao criar formulário"),
            );
          }
          return createQueryBuilder(ok([]));
        }),
      );
      const user = userEvent.setup();
      renderWithQueryClient(<FormulariosPage />);

      await screen.findByText("Nenhum formulário criado");
      await user.click(screen.getAllByRole("button", { name: "Novo formulário" })[0]!);
      await screen.findByRole("dialog");

      await user.type(screen.getByLabelText("Nome *"), "Contato site");
      await user.click(screen.getByRole("button", { name: "Criar formulário" }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("falha ao criar formulário"));
    });

    it("fecha ao clicar em 'Cancelar' sem enviar", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockForms([]);
      const user = userEvent.setup();
      renderWithQueryClient(<FormulariosPage />);

      await screen.findByText("Nenhum formulário criado");
      await user.click(screen.getAllByRole("button", { name: "Novo formulário" })[0]!);
      await screen.findByRole("dialog");

      await user.click(screen.getByRole("button", { name: "Cancelar" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(toast.success).not.toHaveBeenCalled();
    });

    it("fecha ao pressionar Escape", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockForms([]);
      const user = userEvent.setup();
      renderWithQueryClient(<FormulariosPage />);

      await screen.findByText("Nenhum formulário criado");
      await user.click(screen.getAllByRole("button", { name: "Novo formulário" })[0]!);
      await screen.findByRole("dialog");

      await user.keyboard("{Escape}");

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });
  });

  describe("builder de campos — interações adicionais do FieldRow", () => {
    it("move o segundo campo para cima", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockForms([]);
      const user = userEvent.setup();
      renderWithQueryClient(<FormulariosPage />);

      await screen.findByText("Nenhum formulário criado");
      await user.click(screen.getAllByRole("button", { name: "Novo formulário" })[0]!);

      await user.click(screen.getByRole("button", { name: "Adicionar campo" }));
      await user.type(screen.getAllByLabelText("Rótulo *")[0]!, "Nome");
      await user.click(screen.getByRole("button", { name: "Adicionar campo" }));
      await user.type(screen.getAllByLabelText("Rótulo *")[1]!, "Telefone");

      await user.click(screen.getByRole("button", { name: "Mover campo 2 para cima" }));

      const labelInputs = screen.getAllByLabelText("Rótulo *") as HTMLInputElement[];
      expect(labelInputs.map((i) => i.value)).toEqual(["Telefone", "Nome"]);
    });

    it("troca o tipo do campo pelo select 'Tipo'", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      const listBuilder = createQueryBuilder<LeadFormRow[]>(ok([]));
      vi.mocked(supabase.from).mockImplementation((table: string) => {
        if (table === "custom_field_definitions") {
          return createQueryBuilder(ok([])) as unknown as ReturnType<typeof supabase.from>;
        }
        return listBuilder as unknown as ReturnType<typeof supabase.from>;
      });
      const user = userEvent.setup();
      renderWithQueryClient(<FormulariosPage />);

      await screen.findByText("Nenhum formulário criado");
      await user.click(screen.getAllByRole("button", { name: "Novo formulário" })[0]!);

      await user.type(screen.getByLabelText("Nome *"), "Contato site");
      await user.click(screen.getByRole("button", { name: "Adicionar campo" }));
      await user.type(screen.getAllByLabelText("Rótulo *")[0]!, "Idade");
      await user.type(screen.getAllByLabelText("Chave *")[0]!, "idade");

      // Ordem no DOM da linha do campo: Tipo (0), Mapear p/ contato (1).
      await user.click(screen.getAllByRole("combobox")[0]!);
      await user.click(await screen.findByRole("option", { name: "Número" }));

      await user.click(screen.getByRole("button", { name: "Criar formulário" }));

      await waitFor(() =>
        expect(listBuilder.insert).toHaveBeenCalledWith(
          expect.objectContaining({
            fields: [expect.objectContaining({ key: "idade", type: "number" })],
          }),
        ),
      );
    });

    it("mapeia o campo para uma definição de campo customizado existente", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      const listBuilder = createQueryBuilder<LeadFormRow[]>(ok([]));
      vi.mocked(supabase.from).mockImplementation((table: string) => {
        if (table === "custom_field_definitions") {
          return createQueryBuilder(
            ok([{ id: "cf-1", key: "profissao", label: "Profissão" }]),
          ) as unknown as ReturnType<typeof supabase.from>;
        }
        return listBuilder as unknown as ReturnType<typeof supabase.from>;
      });
      const user = userEvent.setup();
      renderWithQueryClient(<FormulariosPage />);

      await screen.findByText("Nenhum formulário criado");
      await user.click(screen.getAllByRole("button", { name: "Novo formulário" })[0]!);

      await user.type(screen.getByLabelText("Nome *"), "Contato site");
      await user.click(screen.getByRole("button", { name: "Adicionar campo" }));
      await user.type(screen.getAllByLabelText("Rótulo *")[0]!, "Profissão");
      await user.type(screen.getAllByLabelText("Chave *")[0]!, "profissao");

      // Ordem no DOM: Tipo (0), Mapear p/ contato (1).
      await user.click(screen.getAllByRole("combobox")[1]!);
      await user.click(await screen.findByRole("option", { name: "Profissão" }));

      await user.click(screen.getByRole("button", { name: "Criar formulário" }));

      await waitFor(() =>
        expect(listBuilder.insert).toHaveBeenCalledWith(
          expect.objectContaining({
            fields: [expect.objectContaining({ maps_to_custom_field_id: "cf-1" })],
          }),
        ),
      );
    });

    it("marca o campo como obrigatório pelo checkbox", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      const listBuilder = createQueryBuilder<LeadFormRow[]>(ok([]));
      vi.mocked(supabase.from).mockImplementation((table: string) => {
        if (table === "custom_field_definitions") {
          return createQueryBuilder(ok([])) as unknown as ReturnType<typeof supabase.from>;
        }
        return listBuilder as unknown as ReturnType<typeof supabase.from>;
      });
      const user = userEvent.setup();
      renderWithQueryClient(<FormulariosPage />);

      await screen.findByText("Nenhum formulário criado");
      await user.click(screen.getAllByRole("button", { name: "Novo formulário" })[0]!);

      await user.type(screen.getByLabelText("Nome *"), "Contato site");
      await user.click(screen.getByRole("button", { name: "Adicionar campo" }));
      await user.type(screen.getAllByLabelText("Rótulo *")[0]!, "Nome");
      await user.type(screen.getAllByLabelText("Chave *")[0]!, "nome");
      await user.click(screen.getByRole("checkbox", { name: "Obrigatório" }));

      await user.click(screen.getByRole("button", { name: "Criar formulário" }));

      await waitFor(() =>
        expect(listBuilder.insert).toHaveBeenCalledWith(
          expect.objectContaining({
            fields: [expect.objectContaining({ required: true })],
          }),
        ),
      );
    });
  });
});
