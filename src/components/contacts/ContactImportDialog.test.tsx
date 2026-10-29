import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { ContactImportDialog } from "./ContactImportDialog";
import type { ContactImportPreview } from "@/hooks/use-contact-import";
import type { ContactImportReport } from "@/lib/contact-import";

const runImportMock = vi.fn();
const useContactImportMock = vi.fn();
const parseContactImportFileMock = vi.fn();

vi.mock("@/hooks/use-contact-import", () => ({
  useContactImport: () => useContactImportMock(),
  parseContactImportFile: (file: File) => parseContactImportFileMock(file),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

function buildPreview(overrides: Partial<ContactImportPreview> = {}): ContactImportPreview {
  return {
    delimiter: ",",
    headers: ["nome", "telefone"],
    mapping: { name: 0, phone: 1 },
    ignoredHeaders: [],
    stageHeaderDetected: false,
    rows: [["Ana", "11999990000"]],
    totalRows: 1,
    ...overrides,
  };
}

function buildReport(overrides: Partial<ContactImportReport> = {}): ContactImportReport {
  return { criados: 1, atualizados: 0, ignorados: 0, erros: [], ...overrides };
}

function renderDialog(onOpenChange = vi.fn()) {
  const utils = render(<ContactImportDialog open={true} onOpenChange={onOpenChange} />);
  return { ...utils, onOpenChange };
}

function csvFile(): File {
  return new File(["nome,telefone\nAna,11999990000\n"], "contatos.csv", { type: "text/csv" });
}

function fileInput(): HTMLInputElement {
  return document.getElementById("contact-import-file") as HTMLInputElement;
}

describe("ContactImportDialog", () => {
  beforeEach(() => {
    runImportMock.mockReset();
    useContactImportMock.mockReset();
    parseContactImportFileMock.mockReset();
    vi.mocked(toast.error).mockReset();
    vi.mocked(toast.success).mockReset();

    useContactImportMock.mockReturnValue({ runImport: runImportMock, isImporting: false });
  });

  it("step inicial: mostra a dropzone e cancelar chama onOpenChange(false)", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();

    expect(
      screen.getByText("Selecione um arquivo CSV com sua base de contatos."),
    ).toBeInTheDocument();
    expect(screen.getByText("Clique para escolher um arquivo .csv")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("seleciona um CSV válido: avança para o preview mostrando campos mapeados e headers ignorados", async () => {
    const preview = buildPreview({
      headers: ["nome", "telefone", "coluna_x"],
      mapping: { name: 0, phone: 1 },
      ignoredHeaders: ["coluna_x"],
      totalRows: 2,
    });
    parseContactImportFileMock.mockResolvedValue(preview);
    renderDialog();

    fireEvent.change(fileInput(), { target: { files: [csvFile()] } });

    expect(
      await screen.findByText(
        "Confira o mapeamento de colunas e escolha o que fazer com duplicados.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("2 linha(s) de dados encontradas")).toBeInTheDocument();
    expect(screen.getByText("Nome")).toBeInTheDocument();
    expect(screen.getByText("Telefone")).toBeInTheDocument();
    expect(screen.getByText("coluna_x")).toBeInTheDocument();
    expect(screen.getByText("Importar 2 contato(s)")).toBeInTheDocument();
  });

  it("preview com stageHeaderDetected mostra o aviso de coluna de etapa não importada", async () => {
    parseContactImportFileMock.mockResolvedValue(buildPreview({ stageHeaderDetected: true }));
    renderDialog();

    fireEvent.change(fileInput(), { target: { files: [csvFile()] } });

    expect(await screen.findByText(/Coluna de estágio\/etapa detectada/)).toBeInTheDocument();
  });

  it("CSV com totalRows 0: mostra toast de erro e permanece no step de seleção", async () => {
    parseContactImportFileMock.mockResolvedValue(buildPreview({ totalRows: 0, rows: [] }));
    renderDialog();

    fireEvent.change(fileInput(), { target: { files: [csvFile()] } });

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("CSV sem linhas de dados para importar."),
    );
    expect(screen.getByText("Clique para escolher um arquivo .csv")).toBeInTheDocument();
  });

  it("erro ao parsear o arquivo: mostra a mensagem do erro via toast e permanece no step de seleção", async () => {
    parseContactImportFileMock.mockRejectedValue(new Error("Arquivo corrompido"));
    renderDialog();

    fireEvent.change(fileInput(), { target: { files: [csvFile()] } });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Arquivo corrompido"));
    expect(screen.getByText("Clique para escolher um arquivo .csv")).toBeInTheDocument();
  });

  it("erro sem mensagem ao parsear cai na mensagem padrão", async () => {
    parseContactImportFileMock.mockRejectedValue({});
    renderDialog();

    fireEvent.change(fileInput(), { target: { files: [csvFile()] } });

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Não foi possível ler o arquivo CSV."),
    );
  });

  it("mostra 'Lendo arquivo…' enquanto o parse está pendente e some quando resolve", async () => {
    let resolveParse: (value: ContactImportPreview) => void = () => {};
    parseContactImportFileMock.mockReturnValue(
      new Promise((resolve) => {
        resolveParse = resolve;
      }),
    );
    renderDialog();

    fireEvent.change(fileInput(), { target: { files: [csvFile()] } });

    expect(await screen.findByText("Lendo arquivo…")).toBeInTheDocument();

    resolveParse(buildPreview());

    await waitFor(() => expect(screen.queryByText("Lendo arquivo…")).not.toBeInTheDocument());
  });

  it("nenhum arquivo selecionado (files vazio) não dispara parse", async () => {
    renderDialog();

    fireEvent.change(fileInput(), { target: { files: [] } });

    await Promise.resolve();
    expect(parseContactImportFileMock).not.toHaveBeenCalled();
  });

  it("modo de duplicados: seleciona 'Criar apenas' e importa com o modo escolhido", async () => {
    const user = userEvent.setup();
    parseContactImportFileMock.mockResolvedValue(buildPreview());
    runImportMock.mockResolvedValue(buildReport());
    renderDialog();

    fireEvent.change(fileInput(), { target: { files: [csvFile()] } });
    await screen.findByText("Importar 1 contato(s)");

    await user.click(screen.getByRole("radio", { name: /Criar apenas/ }));
    await user.click(screen.getByRole("button", { name: "Importar 1 contato(s)" }));

    await waitFor(() =>
      expect(runImportMock).toHaveBeenCalledWith({
        preview: expect.objectContaining({ totalRows: 1 }),
        mode: "criar_apenas",
      }),
    );
  });

  it("importação concluída: avança para o step de relatório com criados/atualizados/ignorados", async () => {
    parseContactImportFileMock.mockResolvedValue(buildPreview());
    runImportMock.mockResolvedValue(
      buildReport({ criados: 3, atualizados: 2, ignorados: 1, erros: [] }),
    );
    const user = userEvent.setup();
    renderDialog();

    fireEvent.change(fileInput(), { target: { files: [csvFile()] } });
    await user.click(await screen.findByRole("button", { name: /Importar 1 contato/ }));

    expect(await screen.findByText("Import concluído.")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("Criados")).toBeInTheDocument();
    expect(screen.getByText("Atualizados")).toBeInTheDocument();
    expect(screen.getByText("Ignorados")).toBeInTheDocument();
  });

  it("relatório com erros lista o número da linha e o motivo de cada erro", async () => {
    parseContactImportFileMock.mockResolvedValue(buildPreview());
    runImportMock.mockResolvedValue(
      buildReport({ erros: [{ linha: 5, motivo: "telefone inválido" }] }),
    );
    const user = userEvent.setup();
    renderDialog();

    fireEvent.change(fileInput(), { target: { files: [csvFile()] } });
    await user.click(await screen.findByRole("button", { name: /Importar 1 contato/ }));

    expect(await screen.findByText("1 linha(s) com erro")).toBeInTheDocument();
    expect(screen.getByText("Linha 5: telefone inválido")).toBeInTheDocument();
  });

  it("relatório sem erros não renderiza a seção de erros", async () => {
    parseContactImportFileMock.mockResolvedValue(buildPreview());
    runImportMock.mockResolvedValue(buildReport({ erros: [] }));
    const user = userEvent.setup();
    renderDialog();

    fireEvent.change(fileInput(), { target: { files: [csvFile()] } });
    await user.click(await screen.findByRole("button", { name: /Importar 1 contato/ }));

    await screen.findByText("Import concluído.");
    expect(screen.queryByText(/linha\(s\) com erro/)).not.toBeInTheDocument();
  });

  it("erro ao rodar o import: mostra toast e permanece no step de preview (sem avançar pro relatório)", async () => {
    parseContactImportFileMock.mockResolvedValue(buildPreview());
    runImportMock.mockRejectedValue(new Error("Erro de conexão"));
    const user = userEvent.setup();
    renderDialog();

    fireEvent.change(fileInput(), { target: { files: [csvFile()] } });
    await user.click(await screen.findByRole("button", { name: /Importar 1 contato/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Erro de conexão"));
    expect(screen.queryByText("Import concluído.")).not.toBeInTheDocument();
    expect(screen.getByText("Importar 1 contato(s)")).toBeInTheDocument();
  });

  it("erro ao rodar o import sem mensagem cai na mensagem padrão", async () => {
    parseContactImportFileMock.mockResolvedValue(buildPreview());
    runImportMock.mockRejectedValue({});
    const user = userEvent.setup();
    renderDialog();

    fireEvent.change(fileInput(), { target: { files: [csvFile()] } });
    await user.click(await screen.findByRole("button", { name: /Importar 1 contato/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Erro ao importar contatos."));
  });

  it("isImporting=true desabilita o botão de importar e mostra o spinner", async () => {
    parseContactImportFileMock.mockResolvedValue(buildPreview());
    useContactImportMock.mockReturnValue({ runImport: runImportMock, isImporting: true });
    renderDialog();

    fireEvent.change(fileInput(), { target: { files: [csvFile()] } });

    expect(await screen.findByRole("button", { name: /Importar 1 contato/ })).toBeDisabled();
  });

  it("botão Voltar no preview retorna ao step de seleção sem perder o estado de reset", async () => {
    const user = userEvent.setup();
    parseContactImportFileMock.mockResolvedValue(buildPreview());
    renderDialog();

    fireEvent.change(fileInput(), { target: { files: [csvFile()] } });
    await screen.findByText("Importar 1 contato(s)");

    await user.click(screen.getByRole("button", { name: "Voltar" }));

    expect(screen.getByText("Clique para escolher um arquivo .csv")).toBeInTheDocument();
  });

  it("Concluir no step de relatório fecha o diálogo (onOpenChange(false))", async () => {
    parseContactImportFileMock.mockResolvedValue(buildPreview());
    runImportMock.mockResolvedValue(buildReport());
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();

    fireEvent.change(fileInput(), { target: { files: [csvFile()] } });
    await user.click(await screen.findByRole("button", { name: /Importar 1 contato/ }));
    await screen.findByText("Import concluído.");

    await user.click(screen.getByRole("button", { name: "Concluir" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
