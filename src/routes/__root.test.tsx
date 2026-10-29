import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithQueryClient } from "@/test/render";
import { reportLovableError } from "@/lib/lovable-error-reporting";
import { Route } from "./__root";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { routerOverrides } = await import("@/test/router-mocks");
  return {
    ...actual,
    ...routerOverrides(),
    useRouter: () => ({ invalidate: vi.fn() }),
  };
});

vi.mock("@/lib/lovable-error-reporting", () => ({
  reportLovableError: vi.fn(),
}));

describe("head() da rota raiz", () => {
  it("define título e metadados de SEO padrão", async () => {
    const head = await Route.options.head?.({} as never);
    const titleMeta = head?.meta?.find((m) => m && "title" in m);
    expect(titleMeta).toMatchObject({ title: "Stefanello — Laticínios e embutidos" });
    expect(head?.links?.some((l) => l && "rel" in l && l.rel === "icon")).toBe(true);
  });
});

describe("NotFoundComponent", () => {
  it("exibe 404 e link para a home", () => {
    const NotFound = Route.options.notFoundComponent as () => ReactElement;
    renderWithQueryClient(<NotFound />);
    expect(screen.getByText("404")).toBeInTheDocument();
    expect(screen.getByText("Página não encontrada")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Voltar para o início" })).toHaveAttribute("href", "/");
  });

  it("troca o título da aba para o título próprio da 404 (não herda o default do root)", () => {
    document.title = "sentinela — não deveria sobreviver ao render";
    const NotFound = Route.options.notFoundComponent as () => ReactElement;
    renderWithQueryClient(<NotFound />);
    expect(document.title).toBe("Página não encontrada — Stefanello");
  });
});

describe("ErrorComponent", () => {
  it("reporta o erro e permite tentar novamente", async () => {
    const user = userEvent.setup();
    const ErrorComponent = Route.options.errorComponent as (props: {
      error: Error;
      reset: () => void;
    }) => ReactElement;
    const reset = vi.fn();
    const error = new Error("falha ao renderizar");

    renderWithQueryClient(<ErrorComponent error={error} reset={reset} />);

    expect(screen.getByText("Algo deu errado")).toBeInTheDocument();
    expect(reportLovableError).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ boundary: "tanstack_root_error_component" }),
    );

    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(reset).toHaveBeenCalled();
  });
});
