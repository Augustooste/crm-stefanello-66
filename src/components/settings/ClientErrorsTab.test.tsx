import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithQueryClient } from "@/test/render";
import { useClientErrors, type ClientErrorEvent } from "@/lib/api/client-errors";
import { ClientErrorsTab } from "./ClientErrorsTab";

// Só o hook de dados é mockado — CLIENT_ERROR_WINDOW_DAYS e
// groupClientErrorsByRoute continuam vindo do módulo real, senão o teste
// validaria a própria cópia da regra de agrupamento.
vi.mock("@/lib/api/client-errors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client-errors")>();
  return { ...actual, useClientErrors: vi.fn() };
});

type UseClientErrorsReturn = ReturnType<typeof useClientErrors>;

function mockErrors(
  overrides: Partial<{
    data: ClientErrorEvent[];
    isLoading: boolean;
    isError: boolean;
    error: unknown;
    refetch: () => void;
  }> = {},
) {
  const {
    data = [],
    isLoading = false,
    isError = false,
    error = null,
    refetch = vi.fn(),
  } = overrides;
  vi.mocked(useClientErrors).mockReturnValue({
    data,
    isLoading,
    isError,
    error,
    refetch,
  } as unknown as UseClientErrorsReturn);
  return refetch;
}

describe("ClientErrorsTab", () => {
  beforeEach(() => {
    vi.mocked(useClientErrors).mockReset();
  });

  it("mostra o estado vazio quando a query volta sem erros registrados", () => {
    mockErrors({ data: [] });
    renderWithQueryClient(<ClientErrorsTab />);

    expect(screen.getByText("Nenhum erro registrado")).toBeInTheDocument();
  });

  it("não diz 'Nenhum erro registrado' quando a própria query falha", async () => {
    // Antes, a falha caía no `?? []` e a tela afirmava exatamente o oposto do
    // que estava acontecendo — sem nenhuma forma de tentar de novo.
    const refetch = mockErrors({
      isError: true,
      error: { message: "permission denied for table system_events", code: "42501" },
    });
    const user = userEvent.setup();
    renderWithQueryClient(<ClientErrorsTab />);

    expect(screen.queryByText("Nenhum erro registrado")).not.toBeInTheDocument();
    expect(screen.getByText("Não foi possível carregar")).toBeInTheDocument();
    expect(
      screen.getByText("Você não tem permissão para fazer isso. Peça a um administrador."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/permission denied/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("não conta '0 erros em 0 páginas' no título quando a query falha", () => {
    mockErrors({ isError: true, error: { message: "Failed to fetch" } });
    renderWithQueryClient(<ClientErrorsTab />);

    expect(screen.getByText("Erros do app")).toBeInTheDocument();
    expect(screen.queryByText(/0 erros em/)).not.toBeInTheDocument();
  });
});
