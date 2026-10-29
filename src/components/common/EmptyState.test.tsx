import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Inbox, Plug } from "lucide-react";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("renderiza título e ícone padrão (Inbox)", () => {
    render(<EmptyState title="Sem itens" />);

    expect(screen.getByRole("heading", { name: "Sem itens" })).toBeInTheDocument();
    expect(document.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("não renderiza descrição quando ausente", () => {
    render(<EmptyState title="Sem itens" />);

    expect(screen.queryByText(/descrição/i)).not.toBeInTheDocument();
  });

  it("renderiza descrição quando fornecida", () => {
    render(<EmptyState title="Sem itens" description="Adicione o primeiro item" />);

    expect(screen.getByText("Adicione o primeiro item")).toBeInTheDocument();
  });

  it("não renderiza botão de ação quando actionLabel ausente", () => {
    render(<EmptyState title="Sem itens" />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renderiza botão de ação e dispara onAction ao clicar", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<EmptyState title="Sem itens" actionLabel="Criar item" onAction={onAction} />);

    const button = screen.getByRole("button", { name: "Criar item" });
    await user.click(button);

    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("aceita um ícone customizado", () => {
    render(<EmptyState title="Sem integrações" icon={Plug} />);

    const svg = document.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });

  it("usa o ícone Inbox como fallback quando icon não é passado explicitamente", () => {
    const { container } = render(<EmptyState title="Padrão" />);
    const defaultSvg = container.querySelector("svg");

    const { container: withInbox } = render(<EmptyState title="Padrão" icon={Inbox} />);
    const explicitSvg = withInbox.querySelector("svg");

    expect(defaultSvg?.innerHTML).toBe(explicitSvg?.innerHTML);
  });
});
