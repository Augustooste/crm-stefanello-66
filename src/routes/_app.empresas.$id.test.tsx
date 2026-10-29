import { Component, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { supabase } from "@/integrations/supabase/client";
import { renderWithQueryClient } from "@/test/render";
import { createFromByTable, fail, ok, type QueryResult } from "@/test/supabase-mock";
import type { CompanyRow } from "@/components/companies/CompanyFormDialog";
import { Route } from "./_app.empresas.$id";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { routerOverrides } = await import("@/test/router-mocks");
  return { ...actual, ...routerOverrides() };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));

const CompanyDetail = Route.options.component!;

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

const COMPANY: CompanyRow = {
  id: "company-1",
  tenant_id: "tenant-1",
  name: "Acme Ltda",
  industry: "Tecnologia",
  website: "https://acme.com",
  created_at: "2026-01-01T00:00:00.000Z",
};

const CONTACTS = [
  { id: "c1", name: "Ana Souza", phone: "11999990000", email: "ana@exemplo.com" },
  { id: "c2", name: "Bruno Lima", phone: null, email: null },
];

function mockFrom(overrides: Record<string, QueryResult> = {}) {
  vi.mocked(supabase.from).mockImplementation(
    createFromByTable({
      crm_companies: ok(COMPANY),
      contacts: ok(CONTACTS),
      deals: ok([]),
      ...overrides,
    }),
  );
}

describe("página de detalhe da empresa (/_app/empresas/$id)", () => {
  beforeEach(() => {
    vi.spyOn(Route, "useParams").mockReturnValue({ id: "company-1" });
  });

  it("lança notFound quando a empresa não existe", async () => {
    mockFrom({ crm_companies: ok(null) });

    renderWithQueryClient(
      <TestBoundary>
        <CompanyDetail />
      </TestBoundary>,
    );

    expect(await screen.findByTestId("boundary-caught")).toBeInTheDocument();
  });

  it("lança notFound quando a busca da empresa falha com erro", async () => {
    mockFrom({ crm_companies: fail("Erro ao buscar empresa") });

    renderWithQueryClient(
      <TestBoundary>
        <CompanyDetail />
      </TestBoundary>,
    );

    expect(await screen.findByTestId("boundary-caught")).toBeInTheDocument();
  });

  it("renderiza dados da empresa, contatos vinculados e link de website", async () => {
    mockFrom();
    renderWithQueryClient(<CompanyDetail />);

    expect(await screen.findByRole("heading", { name: /Acme Ltda/ })).toBeInTheDocument();
    expect(screen.getByText("Tecnologia")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /https:\/\/acme.com/ })).toHaveAttribute(
      "href",
      "https://acme.com",
    );

    expect(await screen.findByText("Ana Souza")).toBeInTheDocument();
    expect(screen.getByText("Bruno Lima")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("mostra estado vazio quando não há contatos vinculados", async () => {
    mockFrom({ contacts: ok([]) });
    renderWithQueryClient(<CompanyDetail />);

    await screen.findByRole("heading", { name: /Acme Ltda/ });
    expect(await screen.findByText("Nenhum contato vinculado")).toBeInTheDocument();
  });

  it("agrega estatísticas de negócios em aberto e ganhos via contatos vinculados", async () => {
    mockFrom({
      deals: ok([
        { id: "d1", contact_id: "c1", status: "open" },
        { id: "d2", contact_id: "c2", status: "won" },
        { id: "d3", contact_id: "c1", status: "lost" },
      ]),
    });
    renderWithQueryClient(<CompanyDetail />);

    await screen.findByRole("heading", { name: /Acme Ltda/ });
    expect(await screen.findByText("Contatos")).toBeInTheDocument();
    // 2 contatos, 1 negócio em aberto, 1 ganho (o "lost" não conta em nenhum dos dois).
    const contactsCard = screen.getByText("Contatos").closest("div")?.parentElement;
    expect(contactsCard).toHaveTextContent("2");
    expect(screen.getByText("Negócios em aberto").parentElement?.parentElement).toHaveTextContent(
      "1",
    );
    expect(screen.getByText("Negócios ganhos").parentElement?.parentElement).toHaveTextContent("1");
  });

  it("abre o diálogo de edição ao clicar em Editar", async () => {
    mockFrom();
    const user = userEvent.setup();
    renderWithQueryClient(<CompanyDetail />);

    await screen.findByRole("heading", { name: /Acme Ltda/ });
    await user.click(screen.getByRole("button", { name: "Editar" }));

    expect(await screen.findByRole("dialog", { name: "Editar empresa" })).toBeInTheDocument();
    expect((screen.getByLabelText("Nome *") as HTMLInputElement).value).toBe("Acme Ltda");
  });

  it("gera título e descrição no head da rota", async () => {
    const head = await Route.options.head?.({ params: { id: "company-1" } } as never);

    expect(head?.meta?.some((m) => m && "title" in m && m.title === "Empresa")).toBe(true);
    expect(
      head?.meta?.some(
        (m) => m && "content" in m && m.content === "Contatos e negócios agrupados por empresa.",
      ),
    ).toBe(true);
  });

  it("renderiza o notFoundComponent da rota com a mensagem de empresa inexistente", () => {
    const NotFoundComponent = Route.options.notFoundComponent! as () => ReactElement;
    render(<NotFoundComponent />);

    expect(screen.getByText("Empresa não encontrada")).toBeInTheDocument();
    expect(screen.getByText("Esta empresa não existe mais.")).toBeInTheDocument();
  });
});
