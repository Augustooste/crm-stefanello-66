import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "./StatusBadge";

describe("StatusBadge", () => {
  it("renderiza os children", () => {
    render(<StatusBadge>Ativo</StatusBadge>);

    expect(screen.getByText("Ativo")).toBeInTheDocument();
  });

  it("usa a variante neutral por padrão", () => {
    render(<StatusBadge>Neutro</StatusBadge>);

    expect(screen.getByText("Neutro")).toHaveClass("bg-muted", "text-muted-foreground");
  });

  it("aplica classes da variante success", () => {
    render(<StatusBadge variant="success">Sucesso</StatusBadge>);

    expect(screen.getByText("Sucesso")).toHaveClass("bg-success/12", "text-success");
  });

  it("aplica classes da variante warning", () => {
    render(<StatusBadge variant="warning">Alerta</StatusBadge>);

    // O par claro/escuro é o fix de contraste: sozinho, `text-warning-foreground`
    // fica ilegível nos visuais escuros (medido em prod: 1.01 a 1.10).
    expect(screen.getByText("Alerta")).toHaveClass(
      "bg-warning/15",
      "text-warning-foreground",
      "dark:text-warning",
    );
  });

  it("aplica classes da variante destructive", () => {
    render(<StatusBadge variant="destructive">Erro</StatusBadge>);

    expect(screen.getByText("Erro")).toHaveClass("bg-destructive/12", "text-destructive");
  });

  it("aceita className extra combinado com as classes da variante", () => {
    render(
      <StatusBadge variant="success" className="ml-2">
        Combo
      </StatusBadge>,
    );

    expect(screen.getByText("Combo")).toHaveClass("ml-2", "bg-success/12");
  });
});
