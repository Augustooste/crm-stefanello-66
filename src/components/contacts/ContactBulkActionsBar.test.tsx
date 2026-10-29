import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContactBulkActionsBar } from "./ContactBulkActionsBar";

function renderBar(overrides: Partial<React.ComponentProps<typeof ContactBulkActionsBar>> = {}) {
  const props: React.ComponentProps<typeof ContactBulkActionsBar> = {
    selectedCount: 2,
    allTags: ["VIP", "Frio"],
    onApplyTag: vi.fn(),
    onDelete: vi.fn(),
    onClearSelection: vi.fn(),
    isApplyingTag: false,
    isDeleting: false,
    ...overrides,
  };
  const utils = render(<ContactBulkActionsBar {...props} />);
  return { ...utils, props };
}

describe("ContactBulkActionsBar", () => {
  it("selectedCount 0 não renderiza nada", () => {
    const { container } = renderBar({ selectedCount: 0 });
    expect(container).toBeEmptyDOMElement();
  });

  it("mostra a contagem de selecionados", () => {
    renderBar({ selectedCount: 5 });
    expect(screen.getByText("5 contato(s) selecionado(s)")).toBeInTheDocument();
  });

  it("abre o popover de etiquetas e aplica uma etiqueta já existente da lista", async () => {
    const user = userEvent.setup();
    const { props } = renderBar({ allTags: ["VIP", "Frio"] });

    await user.click(screen.getByRole("button", { name: /Aplicar etiqueta/ }));
    await user.click(await screen.findByRole("button", { name: "VIP" }));

    expect(props.onApplyTag).toHaveBeenCalledWith("VIP");
  });

  it("aplica uma etiqueta nova digitada no input via clique no botão Aplicar", async () => {
    const user = userEvent.setup();
    const { props } = renderBar();

    await user.click(screen.getByRole("button", { name: /Aplicar etiqueta/ }));
    const input = await screen.findByPlaceholderText("Nova etiqueta");
    await user.type(input, "Quente");
    await user.click(screen.getByRole("button", { name: "Aplicar" }));

    expect(props.onApplyTag).toHaveBeenCalledWith("Quente");
  });

  it("aplica etiqueta nova ao pressionar Enter no input", async () => {
    const user = userEvent.setup();
    const { props } = renderBar();

    await user.click(screen.getByRole("button", { name: /Aplicar etiqueta/ }));
    const input = await screen.findByPlaceholderText("Nova etiqueta");
    await user.type(input, "Quente{Enter}");

    expect(props.onApplyTag).toHaveBeenCalledWith("Quente");
  });

  it("etiqueta em branco (só espaços) não dispara onApplyTag e o botão Aplicar fica desabilitado", async () => {
    const user = userEvent.setup();
    const { props } = renderBar();

    await user.click(screen.getByRole("button", { name: /Aplicar etiqueta/ }));
    const input = await screen.findByPlaceholderText("Nova etiqueta");
    await user.type(input, "   ");

    expect(screen.getByRole("button", { name: "Aplicar" })).toBeDisabled();
    expect(props.onApplyTag).not.toHaveBeenCalled();
  });

  it("lista de etiquetas vazia não renderiza a seção de sugestões no popover", async () => {
    const user = userEvent.setup();
    renderBar({ allTags: [] });

    await user.click(screen.getByRole("button", { name: /Aplicar etiqueta/ }));
    await screen.findByPlaceholderText("Nova etiqueta");

    expect(screen.queryByRole("button", { name: "VIP" })).not.toBeInTheDocument();
  });

  it("isApplyingTag=true desabilita o botão de aplicar etiqueta", () => {
    renderBar({ isApplyingTag: true });
    expect(screen.getByRole("button", { name: /Aplicar etiqueta/ })).toBeDisabled();
  });

  it("isDeleting=true desabilita o botão de excluir selecionados", () => {
    renderBar({ isDeleting: true });
    expect(screen.getByRole("button", { name: /Excluir selecionados/ })).toBeDisabled();
  });

  it("clicar em Limpar seleção chama onClearSelection", async () => {
    const user = userEvent.setup();
    const { props } = renderBar();

    await user.click(screen.getByRole("button", { name: "Limpar seleção" }));

    expect(props.onClearSelection).toHaveBeenCalledTimes(1);
  });

  it("fluxo de exclusão: abre confirmação, Cancelar não chama onDelete", async () => {
    const user = userEvent.setup();
    const { props } = renderBar({ selectedCount: 3 });

    await user.click(screen.getByRole("button", { name: /Excluir selecionados/ }));
    expect(await screen.findByText("Excluir 3 contato(s)")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(props.onDelete).not.toHaveBeenCalled();
    expect(screen.queryByText("Excluir 3 contato(s)")).not.toBeInTheDocument();
  });

  it("fluxo de exclusão: confirmar no AlertDialog chama onDelete e fecha o diálogo", async () => {
    const user = userEvent.setup();
    const { props } = renderBar({ selectedCount: 3 });

    await user.click(screen.getByRole("button", { name: /Excluir selecionados/ }));
    await screen.findByText("Excluir 3 contato(s)");
    await user.click(screen.getByRole("button", { name: "Excluir" }));

    expect(props.onDelete).toHaveBeenCalledTimes(1);
  });
});
