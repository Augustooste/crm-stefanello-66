import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import { supabase } from "@/integrations/supabase/client";
import { createTestQueryClient } from "@/test/render";
import { createFromQueue, ok, type QueryBuilderMock } from "@/test/supabase-mock";
import { parseCsv } from "@/lib/csv";
import { useDealExport } from "./use-deal-export";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));

// Espelha `EXPORT_PAGE_SIZE` (privado) em `use-deal-export.ts` — se o valor lá
// mudar, este teste precisa acompanhar.
const PAGE_SIZE = 1000;

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = createTestQueryClient();
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

type RawDeal = {
  id: string;
  title: string;
  value: number | null;
  created_at: string;
  contact: { name: string; tags: string[] | null; deleted_at: string | null } | null;
  stage: { name: string } | null;
};

function makeDeal(overrides: Partial<RawDeal> = {}): RawDeal {
  return {
    id: "d-1",
    title: "Negócio",
    value: 1000,
    created_at: "2026-01-01T00:00:00.000Z",
    contact: { name: "Ana", tags: [], deleted_at: null },
    stage: { name: "Novo" },
    ...overrides,
  };
}

function fromResultsAsBuilders(): QueryBuilderMock[] {
  return vi.mocked(supabase.from).mock.results.map((r) => r.value as QueryBuilderMock);
}

describe("useDealExport", () => {
  let capturedBlob: Blob | null;

  beforeEach(() => {
    capturedBlob = null;
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

  it("pagina múltiplas páginas (1ª cheia + 2ª com o resto) e concatena o total, chamando .range() com os offsets certos em sequência", async () => {
    const page1 = Array.from({ length: PAGE_SIZE }, (_, i) => makeDeal({ id: `d-${i}` }));
    const page2 = [makeDeal({ id: "d-last", title: "Último" })];
    vi.mocked(supabase.from).mockImplementation(createFromQueue([ok(page1), ok(page2)]));

    const { result } = renderHook(() => useDealExport(), { wrapper });
    const exportResult = await result.current.exportDeals({ boardId: "b1" });

    expect(exportResult.recordsCount).toBe(PAGE_SIZE + 1);
    expect(vi.mocked(supabase.from)).toHaveBeenCalledTimes(2);

    const [builder1, builder2] = fromResultsAsBuilders();
    expect(builder1.range).toHaveBeenCalledWith(0, PAGE_SIZE - 1);
    expect(builder2.range).toHaveBeenCalledWith(PAGE_SIZE, PAGE_SIZE * 2 - 1);

    const { rows } = await exportedCsv();
    expect(rows).toHaveLength(PAGE_SIZE + 1);
    expect(rows[rows.length - 1][0]).toBe("Último");
  });

  it("tiebreaker de paginação: .order() aplica created_at desc + id asc, e linhas com created_at idêntico divididas entre páginas não se perdem nem duplicam", async () => {
    const sameCreatedAt = "2026-02-01T10:00:00.000Z";
    const page1 = Array.from({ length: PAGE_SIZE }, (_, i) =>
      makeDeal({ id: `d-${i}`, created_at: sameCreatedAt }),
    );
    const page2 = [makeDeal({ id: "d-tie", created_at: sameCreatedAt })];
    vi.mocked(supabase.from).mockImplementation(createFromQueue([ok(page1), ok(page2)]));

    const { result } = renderHook(() => useDealExport(), { wrapper });
    const exportResult = await result.current.exportDeals({ boardId: "b1" });

    // Nenhuma linha perdida nem duplicada apesar do `created_at` idêntico na fronteira.
    expect(exportResult.recordsCount).toBe(PAGE_SIZE + 1);

    for (const builder of fromResultsAsBuilders()) {
      expect(builder.order).toHaveBeenNthCalledWith(1, "created_at", { ascending: false });
      expect(builder.order).toHaveBeenNthCalledWith(2, "id", { ascending: true });
    }
  });

  it("contato com deleted_at setado sai vazio no export (mesma regra do Kanban em _app.pipeline.tsx)", async () => {
    const deal = makeDeal({
      contact: { name: "Ana Antiga", tags: [], deleted_at: "2026-01-05T00:00:00.000Z" },
    });
    vi.mocked(supabase.from).mockImplementation(createFromQueue([ok([deal])]));

    const { result } = renderHook(() => useDealExport(), { wrapper });
    await result.current.exportDeals({ boardId: "b1" });

    const { headers, rows } = await exportedCsv();
    const contatoIdx = headers.indexOf("contato");
    expect(rows).toHaveLength(1);
    expect(rows[0][contatoIdx]).toBe("");
  });

  it("filtro ownerId aplica .eq('owner_id', valor)", async () => {
    vi.mocked(supabase.from).mockImplementation(createFromQueue([ok([makeDeal()])]));

    const { result } = renderHook(() => useDealExport(), { wrapper });
    await result.current.exportDeals({ boardId: "b1", ownerId: "owner-9" });

    const [builder] = fromResultsAsBuilders();
    expect(builder.eq).toHaveBeenNthCalledWith(1, "board_id", "b1");
    expect(builder.eq).toHaveBeenNthCalledWith(2, "owner_id", "owner-9");
  });

  it("filtro tagName é aplicado client-side, DEPOIS de toda a paginação concluída, reduzindo o resultado final", async () => {
    const page1 = Array.from({ length: PAGE_SIZE }, (_, i) =>
      makeDeal({
        id: `d-${i}`,
        contact: { name: `Contato ${i}`, tags: i === 0 ? ["VIP"] : ["Frio"], deleted_at: null },
      }),
    );
    const page2 = [
      makeDeal({
        id: "d-last",
        contact: { name: "Último VIP", tags: ["VIP"], deleted_at: null },
      }),
    ];
    vi.mocked(supabase.from).mockImplementation(createFromQueue([ok(page1), ok(page2)]));

    const { result } = renderHook(() => useDealExport(), { wrapper });
    const exportResult = await result.current.exportDeals({ boardId: "b1", tagName: "VIP" });

    // As 2 páginas foram buscadas por completo — o filtro de etiqueta não corta a paginação.
    expect(vi.mocked(supabase.from)).toHaveBeenCalledTimes(2);
    // Resultado final reduzido só aos deals com a etiqueta "VIP" (1 da página 1 + o da página 2).
    expect(exportResult.recordsCount).toBe(2);

    const { headers, rows } = await exportedCsv();
    const contatoIdx = headers.indexOf("contato");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r[contatoIdx])).toEqual(["Contato 0", "Último VIP"]);
  });

  it("formata 'valor' em pt-BR com vírgula decimal (compat Excel pt-BR)", async () => {
    const deal = makeDeal({ value: 1234.5 });
    vi.mocked(supabase.from).mockImplementation(createFromQueue([ok([deal])]));

    const { result } = renderHook(() => useDealExport(), { wrapper });
    await result.current.exportDeals({ boardId: "b1" });

    const { headers, rows } = await exportedCsv();
    const valorIdx = headers.indexOf("valor");
    expect(rows[0][valorIdx]).toBe("1.234,50");
  });

  it("valor nulo exporta célula vazia", async () => {
    const deal = makeDeal({ value: null });
    vi.mocked(supabase.from).mockImplementation(createFromQueue([ok([deal])]));

    const { result } = renderHook(() => useDealExport(), { wrapper });
    await result.current.exportDeals({ boardId: "b1" });

    const { headers, rows } = await exportedCsv();
    const valorIdx = headers.indexOf("valor");
    expect(rows[0][valorIdx]).toBe("");
  });
});
