import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { createTestQueryClient } from "@/test/render";
import { createFromQueue, fail, ok, type QueryBuilderMock } from "@/test/supabase-mock";
import {
  parseContactImportFile,
  useContactImport,
  type ContactImportPreview,
} from "./use-contact-import";

const useCurrentProfileMock = vi.fn();

vi.mock("@/lib/api/session", () => ({
  useCurrentProfile: () => useCurrentProfileMock(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = createTestQueryClient();
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function csvFile(text: string): File {
  return new File([text], "contatos.csv", { type: "text/csv" });
}

function fromResultsAsBuilders(): QueryBuilderMock[] {
  return vi.mocked(supabase.from).mock.results.map((r) => r.value as QueryBuilderMock);
}

describe("parseContactImportFile", () => {
  it("detecta delimitador ';' e mapeia headers reconhecidos em PT-BR, reportando os não reconhecidos", async () => {
    const file = csvFile("nome;telefone;coluna_esquisita\nAna;11999990000;x\n");

    const preview = await parseContactImportFile(file);

    expect(preview.delimiter).toBe(";");
    expect(preview.headers).toEqual(["nome", "telefone", "coluna_esquisita"]);
    expect(preview.mapping).toEqual({ name: 0, phone: 1 });
    expect(preview.ignoredHeaders).toEqual(["coluna_esquisita"]);
    expect(preview.stageHeaderDetected).toBe(false);
    expect(preview.totalRows).toBe(1);
    expect(preview.rows).toEqual([["Ana", "11999990000", "x"]]);
  });

  it("reconhece coluna stage/etapa mas não a mapeia para nenhum campo de destino (stageHeaderDetected=true)", async () => {
    const file = csvFile("nome,telefone,etapa\nAna,11999990000,Qualificacao\n");

    const preview = await parseContactImportFile(file);

    expect(preview.delimiter).toBe(",");
    expect(preview.stageHeaderDetected).toBe(true);
    expect(preview.mapping.stage).toBe(2);
    expect(preview.mapping.name).toBe(0);
  });

  it("CSV só com header (sem linhas de dados) retorna totalRows 0", async () => {
    const file = csvFile("nome,telefone\n");

    const preview = await parseContactImportFile(file);

    expect(preview.totalRows).toBe(0);
    expect(preview.rows).toEqual([]);
  });
});

describe("useContactImport", () => {
  beforeEach(() => {
    useCurrentProfileMock.mockReset();
    vi.mocked(supabase.from).mockReset();
    useCurrentProfileMock.mockReturnValue({ data: { tenant_id: "tenant-1" } });
  });

  async function buildPreview(csvText: string): Promise<ContactImportPreview> {
    return parseContactImportFile(csvFile(csvText));
  }

  it("lança erro quando o perfil ainda não carregou (sem tenant_id) e não chama o Supabase", async () => {
    useCurrentProfileMock.mockReturnValue({ data: undefined });
    const { result } = renderHook(() => useContactImport(), { wrapper });
    const preview = await buildPreview("nome,telefone\nAna,11999990000\n");

    await expect(result.current.runImport({ preview, mode: "criar_apenas" })).rejects.toThrow(
      "Perfil do usuário não carregado.",
    );
    expect(vi.mocked(supabase.from)).not.toHaveBeenCalled();
  });

  it("modo criar_apenas: cria contatos novos usando somente as colunas mapeadas pelo CSV", async () => {
    const preview = await buildPreview("nome,telefone\nAna,11999990000\nBruno,11888880000\n");
    vi.mocked(supabase.from).mockImplementation(createFromQueue([ok([]), ok(null)]));

    const { result } = renderHook(() => useContactImport(), { wrapper });
    const report = await result.current.runImport({ preview, mode: "criar_apenas" });

    expect(report).toEqual({ criados: 2, atualizados: 0, ignorados: 0, erros: [] });
    const [, insertBuilder] = fromResultsAsBuilders();
    expect(insertBuilder.insert).toHaveBeenCalledWith([
      { tenant_id: "tenant-1", name: "Ana", updated_at: expect.any(String), phone: "11999990000" },
      {
        tenant_id: "tenant-1",
        name: "Bruno",
        updated_at: expect.any(String),
        phone: "11888880000",
      },
    ]);
    // colunas não mapeadas (email/tags/notes) nunca aparecem no payload
    const [firstPayload] = vi.mocked(insertBuilder.insert).mock.calls[0][0] as Array<
      Record<string, unknown>
    >;
    expect(Object.keys(firstPayload).sort()).toEqual(
      ["name", "phone", "tenant_id", "updated_at"].sort(),
    );
  });

  it("modo upsert_por_telefone: atualiza contato existente e preserva o nome já cadastrado quando o CSV não mapeia coluna nome", async () => {
    const preview = await buildPreview("telefone,email\n11999990000,ana@x.com\n");
    vi.mocked(supabase.from).mockImplementation(
      createFromQueue([
        ok([{ id: "contact-9", phone: "11999990000", name: "Ana Existente" }]),
        ok(null),
      ]),
    );

    const { result } = renderHook(() => useContactImport(), { wrapper });
    const report = await result.current.runImport({ preview, mode: "upsert_por_telefone" });

    expect(report).toEqual({ criados: 0, atualizados: 1, ignorados: 0, erros: [] });
    const [, upsertBuilder] = fromResultsAsBuilders();
    expect(upsertBuilder.upsert).toHaveBeenCalledWith([
      {
        id: "contact-9",
        tenant_id: "tenant-1",
        name: "Ana Existente",
        updated_at: expect.any(String),
        phone: "11999990000",
        email: "ana@x.com",
      },
    ]);
  });

  it("modo pular_duplicados: ignora telefone já existente na base (não grava nada, só incrementa ignorados)", async () => {
    const preview = await buildPreview("nome,telefone\nAna,11999990000\n");
    vi.mocked(supabase.from).mockImplementation(
      createFromQueue([ok([{ id: "contact-9", phone: "11999990000", name: "Ana Existente" }])]),
    );

    const { result } = renderHook(() => useContactImport(), { wrapper });
    const report = await result.current.runImport({ preview, mode: "pular_duplicados" });

    expect(report).toEqual({ criados: 0, atualizados: 0, ignorados: 1, erros: [] });
    // só a leitura do índice de existentes -- nenhum insert/upsert disparado
    expect(vi.mocked(supabase.from)).toHaveBeenCalledTimes(1);
  });

  it("linha sem nome e sem telefone vira erro reportado, sem interromper as linhas válidas do mesmo arquivo", async () => {
    const preview = await buildPreview(
      "nome,telefone,notas\nAna,11999990000,Nota A\n,,Nota vazia\n",
    );
    vi.mocked(supabase.from).mockImplementation(createFromQueue([ok([]), ok(null)]));

    const { result } = renderHook(() => useContactImport(), { wrapper });
    const report = await result.current.runImport({ preview, mode: "criar_apenas" });

    expect(report.criados).toBe(1);
    expect(report.erros).toEqual([
      { linha: 3, motivo: "Linha sem nome e sem telefone (não é possível criar contato)." },
    ]);
  });

  it("erro no insert do lote reporta o motivo para cada linha do lote, sem lançar exceção", async () => {
    const preview = await buildPreview("nome,telefone\nAna,11999990000\nBruno,11888880000\n");
    vi.mocked(supabase.from).mockImplementation(createFromQueue([ok([]), fail("tenant inválido")]));

    const { result } = renderHook(() => useContactImport(), { wrapper });
    const report = await result.current.runImport({ preview, mode: "criar_apenas" });

    expect(report.criados).toBe(0);
    expect(report.erros).toEqual([
      { linha: 2, motivo: "tenant inválido" },
      { linha: 3, motivo: "tenant inválido" },
    ]);
  });

  it("pagina a leitura de contatos existentes até a página vir menor que o tamanho da página", async () => {
    const preview = await buildPreview("nome,telefone\nAna,11999990000\n");
    const page1 = Array.from({ length: 1000 }, (_, i) => ({
      id: `e${i}`,
      phone: `550000000${i}`,
      name: `Existente ${i}`,
    }));
    const page2 = [{ id: "e-last", phone: "11999990000", name: "Existente Last" }];
    vi.mocked(supabase.from).mockImplementation(createFromQueue([ok(page1), ok(page2), ok(null)]));

    const { result } = renderHook(() => useContactImport(), { wrapper });
    const report = await result.current.runImport({ preview, mode: "upsert_por_telefone" });

    expect(vi.mocked(supabase.from)).toHaveBeenCalledTimes(3);
    const [page1Builder, page2Builder] = fromResultsAsBuilders();
    expect(page1Builder.range).toHaveBeenCalledWith(0, 999);
    expect(page2Builder.range).toHaveBeenCalledWith(1000, 1999);
    expect(report).toEqual({ criados: 0, atualizados: 1, ignorados: 0, erros: [] });
  });

  it("invalida as queries de contacts e dashboard após rodar, mesmo quando há erros de linha", async () => {
    const preview = await buildPreview("nome,telefone\nAna,11999990000\n");
    vi.mocked(supabase.from).mockImplementation(
      createFromQueue([ok([]), fail("erro de gravação")]),
    );
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useContactImport(), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    });

    await result.current.runImport({ preview, mode: "criar_apenas" });

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["contacts"] }));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["dashboard"] });
  });
});
