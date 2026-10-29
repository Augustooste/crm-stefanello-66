import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UseQueryResult } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { renderWithQueryClient } from "@/test/render";
import { createFromByTable, ok, fail, type QueryResult } from "@/test/supabase-mock";
import { useCurrentProfile, type CurrentProfile } from "@/lib/api/session";
import type { MessagingTemplateRow } from "@/hooks/use-messaging-templates";
import { TemplatesTab } from "./TemplatesTab";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

vi.mock("@/lib/api/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/session")>();
  return { ...actual, useCurrentProfile: vi.fn() };
});

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// O fluxo de criação em si é testado em NovaCampanhaDialog.test.tsx; aqui só a
// ligação "Criar campanha" -> diálogo com o modelo pré-selecionado.
vi.mock("./NovaCampanhaDialog", () => ({
  NovaCampanhaDialog: ({
    open,
    initialTemplateId,
  }: {
    open: boolean;
    initialTemplateId?: string | null;
  }) => (open ? <div data-testid="nova-campanha">{initialTemplateId}</div> : null),
}));

const TemplatesPage = TemplatesTab;

function mockProfile(profile: CurrentProfile) {
  vi.mocked(useCurrentProfile).mockReturnValue({
    data: profile,
    isLoading: false,
  } as UseQueryResult<CurrentProfile | null, Error>);
}

function mockTemplates(overrides: Partial<Record<string, QueryResult>> = {}) {
  vi.mocked(supabase.from).mockImplementation(
    createFromByTable({
      messaging_templates: ok([]),
      ...overrides,
    }),
  );
}

const APPROVED_ROW: MessagingTemplateRow = {
  id: "tpl-approved-1",
  tenant_id: "t1",
  channel_id: null,
  name: "Boas-vindas",
  language: "pt_BR",
  body: "Olá {{nome}}, bem-vindo!",
  variables: ["nome"],
  tags: ["frio"],
  version: 1,
  parent_id: null,
  is_draft: false,
  status: "approved",
  kind: "freeform",
  provider_template_name: null,
  created_by: "u1",
  approved_by: "u-admin",
  approved_at: "2026-07-01T00:00:00.000Z",
  created_at: "2026-06-01T00:00:00.000Z",
  updated_at: "2026-06-01T00:00:00.000Z",
};

const DRAFT_ROW: MessagingTemplateRow = {
  id: "tpl-draft-1",
  tenant_id: "t1",
  channel_id: null,
  name: "Boas-vindas",
  language: "pt_BR",
  body: "Olá {{nome}}, seja bem-vindo(a)!",
  variables: ["nome"],
  tags: ["frio"],
  version: 2,
  parent_id: "tpl-approved-1",
  is_draft: true,
  status: "pending",
  kind: "freeform",
  provider_template_name: null,
  created_by: "u1",
  approved_by: null,
  approved_at: null,
  created_at: "2026-07-05T00:00:00.000Z",
  updated_at: "2026-07-05T00:00:00.000Z",
};

// head()/SEO não se aplica mais -- TemplatesTab é uma das 2 abas da rota
// combinada /templates (ver _app.templates.test.tsx pra composição/hash).

describe("TemplatesTab (aba 'Modelos' em /templates)", () => {
  beforeEach(() => {
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
    vi.mocked(supabase.rpc).mockReset();
  });

  it("mostra estado de erro com opção de tentar novamente quando a query falha", async () => {
    mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
    mockTemplates({ messaging_templates: fail("timeout ao buscar templates") });
    renderWithQueryClient(<TemplatesPage />);

    expect(await screen.findByText("Erro ao carregar")).toBeInTheDocument();
    expect(screen.getByText("timeout ao buscar templates")).toBeInTheDocument();
  });

  describe("listagem separa aprovados de rascunhos", () => {
    it("por padrão mostra só templates aprovados (is_draft=false)", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockTemplates({ messaging_templates: ok([APPROVED_ROW, DRAFT_ROW]) });
      renderWithQueryClient(<TemplatesPage />);

      expect(await screen.findByText("Olá {{nome}}, bem-vindo!")).toBeInTheDocument();
      expect(screen.queryByText("Olá {{nome}}, seja bem-vindo(a)!")).not.toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Pendentes de aprovação (1)" })).toBeInTheDocument();
    });

    it("ao trocar para a aba de pendentes, mostra só rascunhos (is_draft=true)", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockTemplates({ messaging_templates: ok([APPROVED_ROW, DRAFT_ROW]) });
      const user = userEvent.setup();
      renderWithQueryClient(<TemplatesPage />);

      await screen.findByText("Olá {{nome}}, bem-vindo!");
      await user.click(screen.getByRole("tab", { name: "Pendentes de aprovação (1)" }));

      expect(await screen.findByText("Olá {{nome}}, seja bem-vindo(a)!")).toBeInTheDocument();
      expect(screen.queryByText("Olá {{nome}}, bem-vindo!")).not.toBeInTheDocument();
      // Histórico de versão: rascunho v2 mostra que é baseado na aprovada v1.
      expect(screen.getByText("Baseado na v1")).toBeInTheDocument();
    });

    it("quando não há rascunhos, mostra estado vazio na aba de pendentes", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockTemplates({ messaging_templates: ok([APPROVED_ROW]) });
      const user = userEvent.setup();
      renderWithQueryClient(<TemplatesPage />);

      await screen.findByText("Olá {{nome}}, bem-vindo!");
      await user.click(screen.getByRole("tab", { name: "Pendentes de aprovação (0)" }));

      expect(await screen.findByText("Nenhum rascunho pendente")).toBeInTheDocument();
    });
  });

  describe("aprovar draft — RPC certa e ação escondida de não-admin", () => {
    it("admin: clicar em Aprovar chama approve_template_version com o id certo", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockTemplates({ messaging_templates: ok([APPROVED_ROW, DRAFT_ROW]) });
      vi.mocked(supabase.rpc).mockResolvedValue({ data: { success: true }, error: null } as never);
      const user = userEvent.setup();
      renderWithQueryClient(<TemplatesPage />);

      await screen.findByText("Olá {{nome}}, bem-vindo!");
      await user.click(screen.getByRole("tab", { name: "Pendentes de aprovação (1)" }));
      await screen.findByText("Olá {{nome}}, seja bem-vindo(a)!");

      await user.click(screen.getByRole("button", { name: "Aprovar" }));

      expect(supabase.rpc).toHaveBeenCalledWith("approve_template_version", {
        p_template_id: "tpl-draft-1",
      });
      expect(toast.success).toHaveBeenCalledWith("Modelo aprovado");
    });

    it("não-admin: não vê o botão Aprovar nem o botão Novo template", async () => {
      mockProfile({ id: "u2", tenant_id: "t1", name: "Bia", role: "agent" });
      mockTemplates({ messaging_templates: ok([APPROVED_ROW, DRAFT_ROW]) });
      const user = userEvent.setup();
      renderWithQueryClient(<TemplatesPage />);

      await screen.findByText("Olá {{nome}}, bem-vindo!");
      expect(screen.queryByRole("button", { name: "Novo modelo" })).not.toBeInTheDocument();

      await user.click(screen.getByRole("tab", { name: "Pendentes de aprovação (1)" }));
      await screen.findByText("Olá {{nome}}, seja bem-vindo(a)!");

      expect(screen.queryByRole("button", { name: "Aprovar" })).not.toBeInTheDocument();
    });
  });

  describe("criar rascunho — chama create_template_draft com os parâmetros certos", () => {
    it("preenche o formulário e cria um template novo (sem parent)", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockTemplates({ messaging_templates: ok([APPROVED_ROW]) });
      vi.mocked(supabase.rpc).mockResolvedValue({ data: { success: true }, error: null } as never);
      const user = userEvent.setup();
      renderWithQueryClient(<TemplatesPage />);

      await screen.findByText("Olá {{nome}}, bem-vindo!");
      await user.click(screen.getByRole("button", { name: "Novo modelo" }));

      const dialog = await screen.findByRole("dialog");
      // Idioma já vem preenchido com o default pt_BR.
      expect(within(dialog).getByLabelText("Idioma *")).toHaveValue("pt_BR");

      await user.type(within(dialog).getByLabelText("Nome *"), "Confirmação de pedido");
      await user.type(
        within(dialog).getByLabelText("Corpo *"),
        "Seu pedido numero foi confirmado.",
      );
      await user.type(within(dialog).getByLabelText("Variáveis (separadas por vírgula)"), "numero");
      await user.type(
        within(dialog).getByLabelText("Tags (livres, separadas por vírgula)"),
        "confirmado, pos-venda",
      );
      await user.click(within(dialog).getByRole("button", { name: "Criar rascunho" }));

      expect(supabase.rpc).toHaveBeenCalledWith("create_template_draft", {
        p_parent_id: null,
        p_name: "Confirmação de pedido",
        p_body: "Seu pedido numero foi confirmado.",
        p_variables: ["numero"],
        p_tags: ["confirmado", "pos-venda"],
        p_language: "pt_BR",
        p_kind: "freeform",
        p_provider_template_name: undefined,
      });
      expect(toast.success).toHaveBeenCalledWith("Rascunho criado");
    });

    it("nova versão de um template aprovado envia o parent_id certo", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockTemplates({ messaging_templates: ok([APPROVED_ROW]) });
      vi.mocked(supabase.rpc).mockResolvedValue({ data: { success: true }, error: null } as never);
      const user = userEvent.setup();
      renderWithQueryClient(<TemplatesPage />);

      await screen.findByText("Olá {{nome}}, bem-vindo!");
      await user.click(screen.getByRole("button", { name: "Nova versão" }));

      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByLabelText("Nome *")).toHaveValue("Boas-vindas");
      await user.click(within(dialog).getByRole("button", { name: "Criar rascunho" }));

      expect(supabase.rpc).toHaveBeenCalledWith(
        "create_template_draft",
        expect.objectContaining({ p_parent_id: "tpl-approved-1", p_name: "Boas-vindas" }),
      );
    });
  });

  describe("criar campanha a partir de um modelo", () => {
    it("abre o diálogo de Nova campanha com o modelo aprovado pré-selecionado", async () => {
      mockProfile({ id: "u1", tenant_id: "t1", name: "Ana", role: "admin" });
      mockTemplates({ messaging_templates: ok([APPROVED_ROW]) });

      const user = userEvent.setup();
      renderWithQueryClient(<TemplatesPage />);

      await screen.findByText("Olá {{nome}}, bem-vindo!");
      await user.click(screen.getByRole("button", { name: "Criar campanha" }));

      expect(await screen.findByTestId("nova-campanha")).toHaveTextContent("tpl-approved-1");
    });
  });
});
