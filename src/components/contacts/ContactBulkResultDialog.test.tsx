import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContactBulkResultDialog } from "./ContactBulkResultDialog";
import type { ContactBulkActionReport } from "@/hooks/use-bulk-contact-actions";

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof ContactBulkResultDialog>> = {},
) {
  const props: React.ComponentProps<typeof ContactBulkResultDialog> = {
    open: true,
    onOpenChange: vi.fn(),
    actionLabel: "aplicar etiqueta",
    report: { sucesso: 3, falhas: 1, erros: [{ id: "c1", motivo: "erro genérico" }] },
    namesById: { c1: "Ana" },
    ...overrides,
  };
  const utils = render(<ContactBulkResultDialog {...props} />);
  return { ...utils, props };
}

describe("ContactBulkResultDialog", () => {
  it("report null não renderiza nada", () => {
    const { container } = renderDialog({ report: null });
    expect(container).toBeEmptyDOMElement();
  });

  it("mostra o actionLabel no título e as contagens de sucesso/falha", () => {
    renderDialog({
      actionLabel: "excluir",
      report: { sucesso: 4, falhas: 2, erros: [] },
    });

    expect(screen.getByText("Resultado — excluir")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("Sucesso")).toBeInTheDocument();
    expect(screen.getByText("Falha")).toBeInTheDocument();
  });

  it("sem erros (erros=[]) não renderiza a seção de contatos com erro", () => {
    renderDialog({ report: { sucesso: 2, falhas: 0, erros: [] } });

    expect(screen.queryByText(/contato\(s\) com erro/)).not.toBeInTheDocument();
  });

  it("com erros, mostra o nome do contato (via namesById) e o motivo de cada falha", () => {
    const report: ContactBulkActionReport = {
      sucesso: 1,
      falhas: 2,
      erros: [
        { id: "c1", motivo: "telefone inválido" },
        { id: "c2", motivo: "tenant divergente" },
      ],
    };
    renderDialog({ report, namesById: { c1: "Ana" } });

    expect(screen.getByText("2 contato(s) com erro")).toBeInTheDocument();
    expect(screen.getByText("Ana: telefone inválido")).toBeInTheDocument();
    // c2 não está em namesById -- cai pro id bruto, nunca esconde o erro
    expect(screen.getByText("c2: tenant divergente")).toBeInTheDocument();
  });

  it("clicar em Fechar chama onOpenChange(false)", async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();

    await user.click(screen.getByRole("button", { name: "Fechar" }));

    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });
});
