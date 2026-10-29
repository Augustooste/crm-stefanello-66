import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { GlobalSearchCommand } from "./GlobalSearchCommand";
import { useGlobalSearch } from "@/hooks/use-global-search";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { routerOverrides } = await import("@/test/router-mocks");
  return { ...actual, ...routerOverrides() };
});

vi.mock("@/hooks/use-global-search", () => ({
  useGlobalSearch: vi.fn(),
}));

const EMPTY_RESULTS = { contacts: [], conversations: [], deals: [] };

function mockSearch(overrides: Partial<ReturnType<typeof useGlobalSearch>> = {}) {
  vi.mocked(useGlobalSearch).mockReturnValue({
    results: EMPTY_RESULTS,
    isSearching: false,
    hasError: false,
    ...overrides,
  });
}

describe("GlobalSearchCommand", () => {
  it("abre com Cmd+K e fecha com Escape", async () => {
    mockSearch();
    render(<GlobalSearchCommand />);

    expect(screen.queryByPlaceholderText(/Buscar contatos/)).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(await screen.findByPlaceholderText(/Buscar contatos/)).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByPlaceholderText(/Buscar contatos/)).not.toBeInTheDocument();
  });

  it("abre com Ctrl+K também (não só Cmd)", async () => {
    mockSearch();
    render(<GlobalSearchCommand />);

    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    expect(await screen.findByPlaceholderText(/Buscar contatos/)).toBeInTheDocument();
  });

  it("mostra estado vazio antes de digitar e mensagem de nenhum resultado depois", async () => {
    mockSearch();
    const user = userEvent.setup();
    render(<GlobalSearchCommand />);

    fireEvent.keyDown(document, { key: "k", metaKey: true });
    const input = await screen.findByPlaceholderText(/Buscar contatos/);
    expect(screen.getByText(/Digite para buscar/)).toBeInTheDocument();

    await user.type(input, "zzz-sem-resultado");
    expect(screen.getByText("Nenhum resultado encontrado.")).toBeInTheDocument();
  });

  it("lista contatos, conversas e negócios encontrados e navega ao selecionar um contato", async () => {
    mockSearch({
      results: {
        contacts: [{ id: "ct1", name: "Ana Souza", phone: "11999990000", email: null }],
        conversations: [{ id: "c1", contactId: "ct2", contactName: "Bruno Lima" }],
        deals: [{ id: "d1", title: "Negócio Ana", contactId: "ct1" }],
      },
    });
    const user = userEvent.setup();
    render(<GlobalSearchCommand />);

    fireEvent.keyDown(document, { key: "k", metaKey: true });
    await screen.findByPlaceholderText(/Buscar contatos/);

    expect(screen.getByText("Contatos")).toBeInTheDocument();
    expect(screen.getByText("Conversas")).toBeInTheDocument();
    expect(screen.getByText("Negócios")).toBeInTheDocument();
    expect(screen.getByText("Bruno Lima")).toBeInTheDocument();
    expect(screen.getByText("Negócio Ana")).toBeInTheDocument();

    await user.click(screen.getByText("Ana Souza"));

    // Fecha e reseta o termo ao navegar.
    expect(screen.queryByPlaceholderText(/Buscar contatos/)).not.toBeInTheDocument();
  });

  // Achado 05 · H4 (code review 10/08): com erro de query o usuário via
  // "Nenhum resultado encontrado" e concluía que o dado tinha sumido.
  it("com erro de busca mostra aviso e NÃO diz 'nenhum resultado'", async () => {
    mockSearch({ hasError: true });
    const user = userEvent.setup();
    render(<GlobalSearchCommand />);

    fireEvent.keyDown(document, { key: "k", metaKey: true });
    const input = await screen.findByPlaceholderText(/Buscar contatos/);
    await user.type(input, "ana");

    expect(screen.getByRole("alert")).toHaveTextContent(/Não foi possível concluir a busca/);
    expect(screen.queryByText("Nenhum resultado encontrado.")).not.toBeInTheDocument();
  });

  it("erro parcial ainda mostra os resultados que chegaram, junto do aviso", async () => {
    mockSearch({
      hasError: true,
      results: {
        contacts: [{ id: "ct1", name: "Ana Souza", phone: null, email: null }],
        conversations: [],
        deals: [],
      },
    });
    const user = userEvent.setup();
    render(<GlobalSearchCommand />);

    fireEvent.keyDown(document, { key: "k", metaKey: true });
    const input = await screen.findByPlaceholderText(/Buscar contatos/);
    await user.type(input, "ana");

    expect(screen.getByText("Ana Souza")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
