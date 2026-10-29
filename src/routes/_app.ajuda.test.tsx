import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithQueryClient } from "@/test/render";
import { Route } from "./_app.ajuda";

const AjudaPage = Route.options.component!;

describe("head() da rota de ajuda", () => {
  it("define título e descrição de SEO", async () => {
    const head = await Route.options.head?.({} as never);
    const titleMeta = head?.meta?.find((m) => m && "title" in m);
    expect(titleMeta).toMatchObject({ title: "Ajuda" });
    expect(head?.links?.some((l) => l && "rel" in l && l.rel === "canonical")).toBe(true);
  });
});

describe("página de ajuda (/_app/ajuda)", () => {
  it("renderiza sem quebrar e mostra o título e a descrição", () => {
    renderWithQueryClient(<AjudaPage />);

    expect(screen.getByRole("heading", { name: "Ajuda" })).toBeInTheDocument();
    expect(screen.getByText("Guia rápido de uso do CRM IA")).toBeInTheDocument();
  });

  it("lista as seções principais do app", () => {
    renderWithQueryClient(<AjudaPage />);

    expect(screen.getByRole("button", { name: "Funil" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Conversas" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Contatos" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Atividades" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Agenda" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Configurações" })).toBeInTheDocument();
  });

  it("expande uma seção ao clicar e mostra suas dicas", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<AjudaPage />);

    expect(
      screen.queryByText("Arraste um cartão entre colunas para mudar o estágio do negócio."),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Funil" }));

    expect(
      await screen.findByText("Arraste um cartão entre colunas para mudar o estágio do negócio."),
    ).toBeInTheDocument();
  });
});
