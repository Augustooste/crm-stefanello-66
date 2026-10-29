import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { createTestQueryClient } from "@/test/render";
import {
  createQueryBuilder,
  ok,
  type QueryBuilderMock,
  type QueryResult,
} from "@/test/supabase-mock";
import { parseCsv } from "@/lib/csv";
import { useContactExport } from "./use-contact-export";

const useCurrentProfileMock = vi.fn();

vi.mock("@/lib/api/session", () => ({
  useCurrentProfile: () => useCurrentProfileMock(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));

const PAGE_SIZE = 1000;

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = createTestQueryClient();
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

type RawContact = {
  name: string | null;
  phone: string | null;
  email: string | null;
  tags: string[] | null;
  notes: string | null;
  source: string | null;
  created_at: string;
};

function makeContact(overrides: Partial<RawContact> = {}): RawContact {
  return {
    name: "Ana",
    phone: "11999990000",
    email: "ana@x.com",
    tags: ["VIP"],
    notes: "obs",
    source: "site",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Builder de export estendido com `.overlaps()` -- método real do Supabase
 * usado por `use-contact-export.ts`, mas ausente de `CHAIN_METHODS` do mock
 * compartilhado (nenhum outro teste hoje precisava dele). Estendido aqui,
 * localmente, em vez de tocar o helper compartilhado. */
type ExportQueryBuilderMock = QueryBuilderMock<RawContact[]> & {
  overlaps: ReturnType<typeof vi.fn>;
};

/**
 * Mock de `supabase.from` que resolve `contacts` por uma fila de páginas (na
 * ordem em que `.range()` é chamado) e `contact_export_log` por um insert
 * dedicado -- as duas tabelas usadas pelo hook, cada uma com contrato distinto
 * (select encadeável x insert direto).
 */
function mockFrom(contactPages: QueryResult<RawContact[]>[], logResult: QueryResult = ok(null)) {
  const contactBuilders: ExportQueryBuilderMock[] = [];
  let pageIndex = 0;
  const logInsertMock = vi.fn().mockResolvedValue(logResult);

  vi.mocked(supabase.from).mockImplementation((table: string) => {
    if (table === "contacts") {
      const result = contactPages[Math.min(pageIndex, contactPages.length - 1)] ?? {
        data: [],
        error: null,
      };
      pageIndex += 1;
      const builder = createQueryBuilder(result) as ExportQueryBuilderMock;
      builder.overlaps = vi.fn(() => builder);
      contactBuilders.push(builder);
      return builder as never;
    }
    if (table === "contact_export_log") {
      return { insert: logInsertMock } as never;
    }
    throw new Error(`from(): tabela inesperada nos testes: ${table}`);
  });

  return { contactBuilders, logInsertMock };
}

describe("useContactExport", () => {
  let capturedBlob: Blob | null;

  beforeEach(() => {
    capturedBlob = null;
    useCurrentProfileMock.mockReset();
    vi.mocked(supabase.from).mockReset();
    useCurrentProfileMock.mockReturnValue({ data: { tenant_id: "tenant-1", id: "user-1" } });
    URL.createObjectURL = vi.fn((blob: Blob) => {
      capturedBlob = blob;
      return "blob:mock-url";
    });
    URL.revokeObjectURL = vi.fn();
  });

  async function exportedCsv(): Promise<{ headers: string[]; rows: string[][] }> {
    expect(capturedBlob).not.toBeNull();
    const text = await capturedBlob!.text();
    return parseCsv(text, ";");
  }

  it("lança erro quando o perfil ainda não carregou (sem tenant_id) e não chama o Supabase", async () => {
    useCurrentProfileMock.mockReturnValue({ data: undefined });
    const { result } = renderHook(() => useContactExport(), { wrapper });

    await expect(result.current.exportContacts({})).rejects.toThrow(
      "Perfil do usuário não carregado.",
    );
    expect(vi.mocked(supabase.from)).not.toHaveBeenCalled();
  });

  it("lança erro quando falta o id do usuário (exportedBy) mesmo com tenant_id presente", async () => {
    useCurrentProfileMock.mockReturnValue({ data: { tenant_id: "tenant-1", id: undefined } });
    const { result } = renderHook(() => useContactExport(), { wrapper });

    await expect(result.current.exportContacts({})).rejects.toThrow(
      "Perfil do usuário não carregado.",
    );
  });

  it("pagina múltiplas páginas de contatos e concatena o total, aplicando deleted_at is null em cada página", async () => {
    const page1 = Array.from({ length: PAGE_SIZE }, (_, i) => makeContact({ name: `C${i}` }));
    const page2 = [makeContact({ name: "Último" })];
    const { contactBuilders } = mockFrom([ok(page1), ok(page2)]);

    const { result } = renderHook(() => useContactExport(), { wrapper });
    const exportResult = await result.current.exportContacts({});

    expect(exportResult.recordsCount).toBe(PAGE_SIZE + 1);
    expect(contactBuilders).toHaveLength(2);
    expect(contactBuilders[0].range).toHaveBeenCalledWith(0, PAGE_SIZE - 1);
    expect(contactBuilders[1].range).toHaveBeenCalledWith(PAGE_SIZE, PAGE_SIZE * 2 - 1);
    for (const builder of contactBuilders) {
      expect(builder.is).toHaveBeenCalledWith("deleted_at", null);
    }
  });

  it("sanitiza o filtro de busca (remove %, vírgula e parênteses) e aplica .or() nos 3 campos", async () => {
    const { contactBuilders } = mockFrom([ok([makeContact()])]);
    const { result } = renderHook(() => useContactExport(), { wrapper });

    await result.current.exportContacts({ search: "Ana%,test(x)" });

    expect(contactBuilders[0].or).toHaveBeenCalledWith(
      "name.ilike.%Anatestx%,phone.ilike.%Anatestx%,email.ilike.%Anatestx%",
    );
  });

  it("busca vazia (só espaços) não aplica filtro .or()", async () => {
    const { contactBuilders } = mockFrom([ok([makeContact()])]);
    const { result } = renderHook(() => useContactExport(), { wrapper });

    await result.current.exportContacts({ search: "   " });

    expect(contactBuilders[0].or).not.toHaveBeenCalled();
  });

  it("filtro de tags aplica .overlaps('tags', tags) quando presente", async () => {
    const { contactBuilders } = mockFrom([ok([makeContact()])]);
    const { result } = renderHook(() => useContactExport(), { wrapper });

    await result.current.exportContacts({ tags: ["VIP", "Frio"] });

    expect(contactBuilders[0].overlaps).toHaveBeenCalledWith("tags", ["VIP", "Frio"]);
  });

  it("sem tags no filtro não aplica .overlaps()", async () => {
    const { contactBuilders } = mockFrom([ok([makeContact()])]);
    const { result } = renderHook(() => useContactExport(), { wrapper });

    await result.current.exportContacts({});

    expect(contactBuilders[0].overlaps).not.toHaveBeenCalled();
  });

  it("monta o CSV com o header fixo, BOM UTF-8 e delimitador ';', com campos nulos virando célula vazia", async () => {
    const contact = makeContact({ tags: null, notes: null, email: null });
    mockFrom([ok([contact])]);
    const { result } = renderHook(() => useContactExport(), { wrapper });

    await result.current.exportContacts({});

    // Blob.text() decodifica como UTF-8 e remove o BOM (comportamento padrão
    // do TextDecoder, WHATWG "UTF-8 decode") -- o BOM em si é responsabilidade
    // de `withUtf8Bom` (lib/csv.ts), já coberto em csv.test.ts. Aqui validamos
    // o efeito observável: parseCsv (que também descarta um BOM residual)
    // ainda enxerga headers/linhas corretos mesmo com campos nulos.
    const { headers, rows } = await exportedCsv();
    expect(headers).toEqual([
      "nome",
      "telefone",
      "email",
      "etiquetas",
      "notas",
      "origem",
      "criado_em",
    ]);
    expect(rows).toEqual([["Ana", "11999990000", "", "", "", "site", "2026-01-01T00:00:00.000Z"]]);
  });

  it("junta múltiplas etiquetas com '; ' na célula de etiquetas", async () => {
    mockFrom([ok([makeContact({ tags: ["VIP", "Quente"] })])]);
    const { result } = renderHook(() => useContactExport(), { wrapper });

    await result.current.exportContacts({});

    const { headers, rows } = await exportedCsv();
    const idx = headers.indexOf("etiquetas");
    expect(rows[0][idx]).toBe("VIP; Quente");
  });

  it("dispara o download com o nome contatos-AAAA-MM-DD.csv (data de hoje)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T12:00:00.000Z"));
    mockFrom([ok([makeContact()])]);
    const createElementSpy = vi.spyOn(document, "createElement");

    const { result } = renderHook(() => useContactExport(), { wrapper });
    await result.current.exportContacts({});

    const anchorCall = createElementSpy.mock.results.find(
      (r) => (r.value as HTMLElement).tagName === "A",
    );
    expect((anchorCall!.value as HTMLAnchorElement).download).toBe("contatos-2026-03-15.csv");
    vi.useRealTimers();
  });

  it("registra a exportação em contact_export_log com filtros, contagem e autor", async () => {
    const { logInsertMock } = mockFrom([ok([makeContact(), makeContact()])]);
    const { result } = renderHook(() => useContactExport(), { wrapper });

    await result.current.exportContacts({ search: "Ana", tags: ["VIP"] });

    expect(logInsertMock).toHaveBeenCalledWith({
      tenant_id: "tenant-1",
      filters: { search: "Ana", tags: ["VIP"] },
      records_count: 2,
      exported_by: "user-1",
    });
  });

  it("falha ao registrar contact_export_log não interrompe o export nem lança erro (best-effort)", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFrom([ok([makeContact()])], { data: null, error: { message: "log indisponível" } });
    const { result } = renderHook(() => useContactExport(), { wrapper });

    const exportResult = await result.current.exportContacts({});

    expect(exportResult.recordsCount).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[contact-export] falha ao registrar contact_export_log (non-fatal):",
      "log indisponível",
    );
  });

  it("retorna recordsCount 0 e ainda assim gera o CSV (só com header) quando não há contatos", async () => {
    mockFrom([ok([])]);
    const { result } = renderHook(() => useContactExport(), { wrapper });

    const exportResult = await result.current.exportContacts({});

    expect(exportResult.recordsCount).toBe(0);
    const { rows } = await exportedCsv();
    expect(rows).toEqual([]);
  });
});
