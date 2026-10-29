import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { supabase } from "@/integrations/supabase/client";
import { renderWithQueryClient } from "@/test/render";
import { asFromMock, createFromByTable, fail, ok, type QueryResult } from "@/test/supabase-mock";
import { Route } from "./_app.empresas.index";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { routerOverrides } = await import("@/test/router-mocks");
  return { ...actual, ...routerOverrides() };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const CompaniesPage = Route.options.component!;

const COMPANIES = [
  {
    id: "company-1",
    tenant_id: "tenant-1",
    name: "Acme Ltda",
    industry: "Tecnologia",
    website: "https://acme.com",
    created_at: "2026-01-02T00:00:00.000Z",
  },
  {
    id: "company-2",
    tenant_id: "tenant-1",
    name: "Beta S.A.",
    industry: "Varejo",
    website: null,
    created_at: "2026-01-01T00:00:00.000Z",
  },
];

function mockFrom(overrides: Record<string, QueryResult> = {}) {
  vi.mocked(supabase.from).mockImplementation(
    createFromByTable({
      crm_companies: ok(COMPANIES),
      ...overrides,
    }),
  );
}

describe("página de empresas (/_app/empresas)", () => {
  beforeEach(() => {
    vi.mocked(supabase.from).mockReset();
  });

  it("renderiza a lista de empresas", async () => {
    mockFrom();
    renderWithQueryClient(<CompaniesPage />);

    expect(await screen.findByText("Acme Ltda")).toBeInTheDocument();
    expect(screen.getByText("Beta S.A.")).toBeInTheDocument();
    expect(screen.getByText("2 empresas na base")).toBeInTheDocument();
  });

  describe("busca/filtro", () => {
    it("filtra por nome, setor ou website conforme o termo digitado", async () => {
      mockFrom();
      const user = userEvent.setup();
      renderWithQueryClient(<CompaniesPage />);

      await screen.findByText("Acme Ltda");
      await user.type(screen.getByLabelText("Buscar empresas"), "varejo");

      expect(screen.queryByText("Acme Ltda")).not.toBeInTheDocument();
      expect(screen.getByText("Beta S.A.")).toBeInTheDocument();
    });

    it("mostra estado vazio de busca sem resultado e permite limpar", async () => {
      mockFrom();
      const user = userEvent.setup();
      renderWithQueryClient(<CompaniesPage />);

      await screen.findByText("Acme Ltda");
      await user.type(screen.getByLabelText("Buscar empresas"), "empresa-inexistente");

      expect(await screen.findByText("Nenhuma empresa encontrada")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Limpar busca" }));
      expect(await screen.findByText("Acme Ltda")).toBeInTheDocument();
    });
  });

  describe("erro + retry", () => {
    it("mostra estado de erro e permite tentar novamente", async () => {
      let attempt = 0;
      vi.mocked(supabase.from).mockImplementation(
        asFromMock((table: string) => {
          if (table === "crm_companies") {
            attempt += 1;
            return attempt === 1
              ? createFromByTable({ crm_companies: fail("Erro ao buscar empresas") })(table)
              : createFromByTable({ crm_companies: ok(COMPANIES) })(table);
          }
          return createFromByTable({})(table);
        }),
      );
      const user = userEvent.setup();
      renderWithQueryClient(<CompaniesPage />);

      expect(await screen.findByText("Erro ao carregar empresas")).toBeInTheDocument();
      expect(screen.getByText("Erro ao buscar empresas")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Tentar novamente" }));

      expect(await screen.findByText("Acme Ltda")).toBeInTheDocument();
    });
  });

  describe("exclusão (soft delete)", () => {
    it("desvincula os contatos da empresa ao excluir (soft delete)", async () => {
      const contactsUpdateEqMock = vi.fn().mockResolvedValue({ error: null });
      const contactsUpdateMock = vi.fn(() => ({ eq: contactsUpdateEqMock }));
      const companiesUpdateEqMock = vi.fn().mockResolvedValue({ error: null });
      const companiesUpdateMock = vi.fn(() => ({ eq: companiesUpdateEqMock }));

      vi.mocked(supabase.from).mockImplementation(
        asFromMock((table: string) => {
          if (table === "crm_companies") {
            return {
              ...createFromByTable({ crm_companies: ok(COMPANIES) })(table),
              update: companiesUpdateMock,
            };
          }
          if (table === "contacts") {
            return { update: contactsUpdateMock };
          }
          return createFromByTable({})(table);
        }),
      );

      const user = userEvent.setup();
      renderWithQueryClient(<CompaniesPage />);

      await screen.findByText("Acme Ltda");
      await user.click(screen.getByRole("button", { name: "Excluir Acme Ltda" }));

      expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Excluir" }));

      await vi.waitFor(() => {
        expect(companiesUpdateMock).toHaveBeenCalledWith(
          expect.objectContaining({ deleted_at: expect.any(String) }),
        );
      });
      expect(companiesUpdateEqMock).toHaveBeenCalledWith("id", "company-1");

      // O ponto central do fix: o soft delete de crm_companies não dispara a
      // FK (que só roda em DELETE físico) -- por isso o código precisa limpar
      // contacts.company_id explicitamente, senão o aviso do diálogo
      // ("só perdem o vínculo") seria falso.
      await vi.waitFor(() => {
        expect(contactsUpdateMock).toHaveBeenCalledWith({ company_id: null });
      });
      expect(contactsUpdateEqMock).toHaveBeenCalledWith("company_id", "company-1");
    });
  });

  it("gera título e descrição no head da rota", async () => {
    const head = await Route.options.head?.({} as never);

    expect(head?.meta?.some((m) => m && "title" in m && m.title === "Empresas")).toBe(true);
  });
});
