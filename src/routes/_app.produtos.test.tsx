import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { renderWithQueryClient } from "@/test/render";
import { asFromMock, createFromByTable, fail, ok, type QueryResult } from "@/test/supabase-mock";
import { Route } from "./_app.produtos.index";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { routerOverrides } = await import("@/test/router-mocks");
  return { ...actual, ...routerOverrides() };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const ProductsPage = Route.options.component!;

const PRODUCTS = [
  {
    id: "product-1",
    tenant_id: "tenant-1",
    name: "Consulta avulsa",
    description: "Sessão única",
    price: 150,
    duration_minutes: 60,
    sku: "SKU-A",
    active: true,
    created_at: "2026-01-02T00:00:00.000Z",
  },
  {
    id: "product-2",
    tenant_id: "tenant-1",
    name: "Camiseta básica",
    description: null,
    price: 49.9,
    duration_minutes: null,
    sku: "SKU-B",
    active: false,
    created_at: "2026-01-01T00:00:00.000Z",
  },
];

function mockFrom(overrides: Record<string, QueryResult> = {}) {
  vi.mocked(supabase.from).mockImplementation(
    createFromByTable({
      crm_products: ok(PRODUCTS),
      ...overrides,
    }),
  );
}

describe("página de produtos (/_app/produtos)", () => {
  beforeEach(() => {
    vi.mocked(supabase.from).mockReset();
  });

  it("renderiza a lista de produtos", async () => {
    mockFrom();
    renderWithQueryClient(<ProductsPage />);

    expect(await screen.findByText("Consulta avulsa")).toBeInTheDocument();
    expect(screen.getByText("Camiseta básica")).toBeInTheDocument();
    expect(screen.getByText("2 produtos no catálogo")).toBeInTheDocument();
  });

  it("formata preço e duração, e mostra — quando ausentes", async () => {
    mockFrom();
    renderWithQueryClient(<ProductsPage />);

    await screen.findByText("Consulta avulsa");
    expect(screen.getByText("60 min")).toBeInTheDocument();
    // Camiseta básica não tem duração -- célula mostra "—".
    const rows = screen.getAllByRole("row");
    expect(
      rows.some((r) => r.textContent?.includes("Camiseta básica") && r.textContent.includes("—")),
    ).toBe(true);
  });

  describe("busca/filtro", () => {
    it("filtra por nome, sku ou descrição conforme o termo digitado", async () => {
      mockFrom();
      const user = userEvent.setup();
      renderWithQueryClient(<ProductsPage />);

      await screen.findByText("Consulta avulsa");
      await user.type(screen.getByLabelText("Buscar produtos"), "camiseta");

      expect(screen.queryByText("Consulta avulsa")).not.toBeInTheDocument();
      expect(screen.getByText("Camiseta básica")).toBeInTheDocument();
    });

    it("mostra estado vazio de busca sem resultado e permite limpar", async () => {
      mockFrom();
      const user = userEvent.setup();
      renderWithQueryClient(<ProductsPage />);

      await screen.findByText("Consulta avulsa");
      await user.type(screen.getByLabelText("Buscar produtos"), "produto-inexistente");

      expect(await screen.findByText("Nenhum produto encontrado")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Limpar busca" }));
      expect(await screen.findByText("Consulta avulsa")).toBeInTheDocument();
    });
  });

  describe("erro + retry", () => {
    it("mostra estado de erro e permite tentar novamente", async () => {
      let attempt = 0;
      vi.mocked(supabase.from).mockImplementation(
        asFromMock((table: string) => {
          if (table === "crm_products") {
            attempt += 1;
            return attempt === 1
              ? createFromByTable({ crm_products: fail("Erro ao buscar produtos") })(table)
              : createFromByTable({ crm_products: ok(PRODUCTS) })(table);
          }
          return createFromByTable({})(table);
        }),
      );
      const user = userEvent.setup();
      renderWithQueryClient(<ProductsPage />);

      expect(await screen.findByText("Erro ao carregar produtos")).toBeInTheDocument();
      expect(screen.getByText("Erro ao buscar produtos")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Tentar novamente" }));

      expect(await screen.findByText("Consulta avulsa")).toBeInTheDocument();
    });
  });

  describe("ativar/desativar", () => {
    it("reativa direto pelo switch, sem pedir confirmação", async () => {
      const updateEqMock = vi.fn().mockResolvedValue({ error: null });
      const updateMock = vi.fn(() => ({ eq: updateEqMock }));

      vi.mocked(supabase.from).mockImplementation(
        asFromMock((table: string) => {
          if (table === "crm_products") {
            return {
              ...createFromByTable({ crm_products: ok(PRODUCTS) })(table),
              update: updateMock,
            };
          }
          return createFromByTable({})(table);
        }),
      );

      const user = userEvent.setup();
      renderWithQueryClient(<ProductsPage />);

      await screen.findByText("Camiseta básica");
      // Camiseta básica é o fixture inativo (active: false).
      await user.click(screen.getByRole("switch", { name: "Ativar Camiseta básica" }));

      await vi.waitFor(() => {
        expect(updateMock).toHaveBeenCalledWith({ active: true });
      });
      expect(updateEqMock).toHaveBeenCalledWith("id", "product-2");
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    it("pede confirmação antes de desativar, e só chama a mutation ao confirmar", async () => {
      const updateEqMock = vi.fn().mockResolvedValue({ error: null });
      const updateMock = vi.fn(() => ({ eq: updateEqMock }));

      vi.mocked(supabase.from).mockImplementation(
        asFromMock((table: string) => {
          if (table === "crm_products") {
            return {
              ...createFromByTable({ crm_products: ok(PRODUCTS) })(table),
              update: updateMock,
            };
          }
          return createFromByTable({})(table);
        }),
      );

      const user = userEvent.setup();
      renderWithQueryClient(<ProductsPage />);

      await screen.findByText("Consulta avulsa");
      await user.click(screen.getByRole("switch", { name: "Desativar Consulta avulsa" }));

      expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
      expect(screen.getByText("Desativar produto")).toBeInTheDocument();
      // Ainda não deve ter chamado o update -- só ao confirmar.
      expect(updateMock).not.toHaveBeenCalled();

      await user.click(screen.getByRole("button", { name: "Desativar" }));

      await vi.waitFor(() => {
        expect(updateMock).toHaveBeenCalledWith({ active: false });
      });
      expect(updateEqMock).toHaveBeenCalledWith("id", "product-1");
    });

    it("fecha o diálogo de confirmação mesmo quando a mutation falha (nunca fica preso aberto)", async () => {
      const updateEqMock = vi.fn().mockResolvedValue({ error: { message: "Erro de rede" } });
      const updateMock = vi.fn(() => ({ eq: updateEqMock }));

      vi.mocked(supabase.from).mockImplementation(
        asFromMock((table: string) => {
          if (table === "crm_products") {
            return {
              ...createFromByTable({ crm_products: ok(PRODUCTS) })(table),
              update: updateMock,
            };
          }
          return createFromByTable({})(table);
        }),
      );

      const user = userEvent.setup();
      renderWithQueryClient(<ProductsPage />);

      await screen.findByText("Consulta avulsa");
      await user.click(screen.getByRole("switch", { name: "Desativar Consulta avulsa" }));
      await screen.findByRole("alertdialog");
      await user.click(screen.getByRole("button", { name: "Desativar" }));

      await vi.waitFor(() => {
        expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      });
    });

    it("cancela a desativação sem chamar a mutation", async () => {
      const updateEqMock = vi.fn().mockResolvedValue({ error: null });
      const updateMock = vi.fn(() => ({ eq: updateEqMock }));

      vi.mocked(supabase.from).mockImplementation(
        asFromMock((table: string) => {
          if (table === "crm_products") {
            return {
              ...createFromByTable({ crm_products: ok(PRODUCTS) })(table),
              update: updateMock,
            };
          }
          return createFromByTable({})(table);
        }),
      );

      const user = userEvent.setup();
      renderWithQueryClient(<ProductsPage />);

      await screen.findByText("Consulta avulsa");
      await user.click(screen.getByRole("switch", { name: "Desativar Consulta avulsa" }));

      expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Cancelar" }));

      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(updateMock).not.toHaveBeenCalled();
    });
  });

  describe("excluir produto", () => {
    it("pede confirmação e exclui de fato ao confirmar", async () => {
      const deleteEqMock = vi.fn().mockResolvedValue({ error: null });
      const deleteMock = vi.fn(() => ({ eq: deleteEqMock }));

      vi.mocked(supabase.from).mockImplementation(
        asFromMock((table: string) => {
          if (table === "crm_products") {
            return {
              ...createFromByTable({ crm_products: ok(PRODUCTS) })(table),
              delete: deleteMock,
            };
          }
          return createFromByTable({})(table);
        }),
      );

      const user = userEvent.setup();
      renderWithQueryClient(<ProductsPage />);

      await screen.findByText("Consulta avulsa");
      await user.click(screen.getByRole("button", { name: "Excluir Consulta avulsa" }));

      expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
      expect(screen.getByText("Excluir produto")).toBeInTheDocument();
      expect(deleteMock).not.toHaveBeenCalled();

      await user.click(screen.getByRole("button", { name: "Excluir" }));

      await vi.waitFor(() => {
        expect(deleteMock).toHaveBeenCalled();
      });
      expect(deleteEqMock).toHaveBeenCalledWith("id", "product-1");
      expect(toast.success).toHaveBeenCalledWith("Produto excluído");
    });

    it("cancela a exclusão sem chamar delete", async () => {
      mockFrom();
      const user = userEvent.setup();
      renderWithQueryClient(<ProductsPage />);

      await screen.findByText("Consulta avulsa");
      await user.click(screen.getByRole("button", { name: "Excluir Consulta avulsa" }));

      expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Cancelar" }));

      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });
  });

  it("gera título e descrição no head da rota", async () => {
    const head = await Route.options.head?.({} as never);

    expect(head?.meta?.some((m) => m && "title" in m && m.title === "Produtos")).toBe(true);
  });
});
