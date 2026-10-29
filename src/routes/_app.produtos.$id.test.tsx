import { Component, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { supabase } from "@/integrations/supabase/client";
import { renderWithQueryClient } from "@/test/render";
import { createFromByTable, fail, ok, type QueryResult } from "@/test/supabase-mock";
import type { ProductRow } from "@/components/products/ProductFormDialog";
import { Route } from "./_app.produtos.$id";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { routerOverrides } = await import("@/test/router-mocks");
  return { ...actual, ...routerOverrides() };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const ProductDetail = Route.options.component!;

/** Captura o `throw notFound()` que o TanStack Router espera de uma rota real. */
class TestBoundary extends Component<{ children: ReactNode }, { caught: boolean }> {
  state = { caught: false };
  static getDerivedStateFromError() {
    return { caught: true };
  }
  render() {
    return this.state.caught ? <div data-testid="boundary-caught" /> : this.props.children;
  }
}

const PRODUCT: ProductRow = {
  id: "product-1",
  tenant_id: "tenant-1",
  name: "Consulta avulsa",
  description: "Sessão única de 1h",
  price: 150,
  duration_minutes: 60,
  sku: "SKU-1",
  active: true,
  created_at: "2026-01-01T00:00:00.000Z",
};

function mockFrom(overrides: Record<string, QueryResult> = {}) {
  vi.mocked(supabase.from).mockImplementation(
    createFromByTable({
      crm_products: ok(PRODUCT),
      ...overrides,
    }),
  );
}

describe("página de detalhe do produto (/_app/produtos/$id)", () => {
  beforeEach(() => {
    vi.spyOn(Route, "useParams").mockReturnValue({ id: "product-1" });
  });

  it("lança notFound quando o produto não existe", async () => {
    mockFrom({ crm_products: ok(null) });

    renderWithQueryClient(
      <TestBoundary>
        <ProductDetail />
      </TestBoundary>,
    );

    expect(await screen.findByTestId("boundary-caught")).toBeInTheDocument();
  });

  it("lança notFound quando a busca do produto falha com erro", async () => {
    mockFrom({ crm_products: fail("Erro ao buscar produto") });

    renderWithQueryClient(
      <TestBoundary>
        <ProductDetail />
      </TestBoundary>,
    );

    expect(await screen.findByTestId("boundary-caught")).toBeInTheDocument();
  });

  it("renderiza dados do produto: preço, duração, SKU e descrição", async () => {
    mockFrom();
    renderWithQueryClient(<ProductDetail />);

    expect(await screen.findByRole("heading", { name: /Consulta avulsa/ })).toBeInTheDocument();
    expect(screen.getByText("SKU: SKU-1")).toBeInTheDocument();
    expect(screen.getByText("R$ 150")).toBeInTheDocument();
    expect(screen.getByText("60 min")).toBeInTheDocument();
    expect(screen.getByText("Sessão única de 1h")).toBeInTheDocument();
    expect(screen.getByText("Ativo")).toBeInTheDocument();
  });

  it("mostra — pra preço e duração ausentes, e texto padrão sem descrição", async () => {
    mockFrom({
      crm_products: ok({ ...PRODUCT, price: null, duration_minutes: null, description: null }),
    });
    renderWithQueryClient(<ProductDetail />);

    await screen.findByRole("heading", { name: /Consulta avulsa/ });
    expect(screen.getByText("Sem descrição.")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("pede confirmação antes de desativar pelo switch do cabeçalho, e só chama a mutation ao confirmar", async () => {
    const updateEqMock = vi.fn().mockResolvedValue({ error: null });
    const updateMock = vi.fn(() => ({ eq: updateEqMock }));

    vi.mocked(supabase.from).mockImplementation((table: string) => {
      if (table === "crm_products") {
        return { ...createFromByTable({ crm_products: ok(PRODUCT) })(table), update: updateMock };
      }
      return createFromByTable({})(table);
    });

    const user = userEvent.setup();
    renderWithQueryClient(<ProductDetail />);

    await screen.findByRole("heading", { name: /Consulta avulsa/ });
    await user.click(screen.getByRole("switch", { name: "Desativar produto" }));

    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(updateMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Desativar" }));

    await vi.waitFor(() => {
      expect(updateMock).toHaveBeenCalledWith({ active: false });
    });
    expect(updateEqMock).toHaveBeenCalledWith("id", "product-1");
  });

  it("cancela a desativação pelo switch do cabeçalho sem chamar a mutation", async () => {
    const updateEqMock = vi.fn().mockResolvedValue({ error: null });
    const updateMock = vi.fn(() => ({ eq: updateEqMock }));

    vi.mocked(supabase.from).mockImplementation((table: string) => {
      if (table === "crm_products") {
        return { ...createFromByTable({ crm_products: ok(PRODUCT) })(table), update: updateMock };
      }
      return createFromByTable({})(table);
    });

    const user = userEvent.setup();
    renderWithQueryClient(<ProductDetail />);

    await screen.findByRole("heading", { name: /Consulta avulsa/ });
    await user.click(screen.getByRole("switch", { name: "Desativar produto" }));

    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("reativa direto pelo switch do cabeçalho, sem pedir confirmação", async () => {
    const updateEqMock = vi.fn().mockResolvedValue({ error: null });
    const updateMock = vi.fn(() => ({ eq: updateEqMock }));
    const inactiveProduct: ProductRow = { ...PRODUCT, active: false };

    vi.mocked(supabase.from).mockImplementation((table: string) => {
      if (table === "crm_products") {
        return {
          ...createFromByTable({ crm_products: ok(inactiveProduct) })(table),
          update: updateMock,
        };
      }
      return createFromByTable({})(table);
    });

    const user = userEvent.setup();
    renderWithQueryClient(<ProductDetail />);

    await screen.findByRole("heading", { name: /Consulta avulsa/ });
    await user.click(screen.getByRole("switch", { name: "Ativar produto" }));

    await vi.waitFor(() => {
      expect(updateMock).toHaveBeenCalledWith({ active: true });
    });
    expect(updateEqMock).toHaveBeenCalledWith("id", "product-1");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("abre o diálogo de edição ao clicar em Editar", async () => {
    mockFrom();
    const user = userEvent.setup();
    renderWithQueryClient(<ProductDetail />);

    await screen.findByRole("heading", { name: /Consulta avulsa/ });
    await user.click(screen.getByRole("button", { name: "Editar" }));

    expect(await screen.findByRole("dialog", { name: "Editar produto" })).toBeInTheDocument();
    expect((screen.getByLabelText("Nome *") as HTMLInputElement).value).toBe("Consulta avulsa");
  });

  it("gera título e descrição no head da rota", async () => {
    const head = await Route.options.head?.({ params: { id: "product-1" } } as never);

    expect(head?.meta?.some((m) => m && "title" in m && m.title === "Produto")).toBe(true);
    expect(
      head?.meta?.some(
        (m) => m && "content" in m && m.content === "Detalhes do produto ou serviço do catálogo.",
      ),
    ).toBe(true);
  });

  it("renderiza o notFoundComponent da rota com a mensagem de produto inexistente", () => {
    const NotFoundComponent = Route.options.notFoundComponent! as () => ReactElement;
    render(<NotFoundComponent />);

    expect(screen.getByText("Produto não encontrado")).toBeInTheDocument();
    expect(screen.getByText("Este produto não existe mais.")).toBeInTheDocument();
  });
});
