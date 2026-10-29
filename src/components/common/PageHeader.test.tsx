import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PageHeader } from "./PageHeader";

describe("PageHeader", () => {
  it("renderiza o título como heading nível 1", () => {
    render(<PageHeader title="Contatos" />);

    expect(screen.getByRole("heading", { level: 1, name: "Contatos" })).toBeInTheDocument();
  });

  it("não renderiza descrição quando ausente", () => {
    render(<PageHeader title="Contatos" />);

    expect(screen.queryByText(/descrição/i)).not.toBeInTheDocument();
  });

  it("renderiza descrição quando fornecida", () => {
    render(<PageHeader title="Contatos" description="Gerencie seus contatos" />);

    expect(screen.getByText("Gerencie seus contatos")).toBeInTheDocument();
  });

  it("não renderiza container de ações quando actions ausente", () => {
    const { container } = render(<PageHeader title="Contatos" />);

    expect(container.querySelector(".gap-2")).not.toBeInTheDocument();
  });

  it("renderiza actions quando fornecido", () => {
    render(<PageHeader title="Contatos" actions={<button type="button">Novo</button>} />);

    expect(screen.getByRole("button", { name: "Novo" })).toBeInTheDocument();
  });
});
