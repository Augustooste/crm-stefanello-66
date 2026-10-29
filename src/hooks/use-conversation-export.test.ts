import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import { supabase } from "@/integrations/supabase/client";
import { createTestQueryClient } from "@/test/render";
import { createFromQueue, ok, type QueryBuilderMock } from "@/test/supabase-mock";
import { parseCsv } from "@/lib/csv";
import { useConversationExport } from "./use-conversation-export";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));

// Espelha `EXPORT_PAGE_SIZE` (privado) em `use-conversation-export.ts` — se o
// valor lá mudar, este teste precisa acompanhar.
const PAGE_SIZE = 1000;

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = createTestQueryClient();
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

type RawConversation = {
  id: string;
  status: string;
  awaiting_human: boolean;
  last_message_at: string | null;
  created_at: string;
  contact: { name: string; phone: string | null; deleted_at: string | null } | null;
  channel: { type: string } | null;
};

function makeConversation(overrides: Partial<RawConversation> = {}): RawConversation {
  return {
    id: "c-1",
    status: "open",
    awaiting_human: false,
    last_message_at: "2026-01-01T10:00:00.000Z",
    created_at: "2026-01-01T00:00:00.000Z",
    contact: { name: "Ana", phone: "11999990000", deleted_at: null },
    channel: { type: "whatsapp" },
    ...overrides,
  };
}

function fromResultsAsBuilders(): QueryBuilderMock[] {
  return vi.mocked(supabase.from).mock.results.map((r) => r.value as QueryBuilderMock);
}

describe("useConversationExport", () => {
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
    const page1 = Array.from({ length: PAGE_SIZE }, (_, i) => makeConversation({ id: `c-${i}` }));
    const page2 = [
      makeConversation({
        id: "c-last",
        contact: { name: "Último", phone: null, deleted_at: null },
      }),
    ];
    vi.mocked(supabase.from).mockImplementation(createFromQueue([ok(page1), ok(page2)]));

    const { result } = renderHook(() => useConversationExport(), { wrapper });
    const exportResult = await result.current.exportConversations({});

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
      makeConversation({ id: `c-${i}`, created_at: sameCreatedAt }),
    );
    const page2 = [makeConversation({ id: "c-tie", created_at: sameCreatedAt })];
    vi.mocked(supabase.from).mockImplementation(createFromQueue([ok(page1), ok(page2)]));

    const { result } = renderHook(() => useConversationExport(), { wrapper });
    const exportResult = await result.current.exportConversations({});

    expect(exportResult.recordsCount).toBe(PAGE_SIZE + 1);

    for (const builder of fromResultsAsBuilders()) {
      expect(builder.order).toHaveBeenNthCalledWith(1, "created_at", { ascending: false });
      expect(builder.order).toHaveBeenNthCalledWith(2, "id", { ascending: true });
    }
  });

  it("contato com deleted_at setado sai vazio no export (mesma regra do inbox em _app.inbox.tsx)", async () => {
    const conv = makeConversation({
      contact: { name: "Ana Antiga", phone: "119999", deleted_at: "2026-01-05T00:00:00.000Z" },
    });
    vi.mocked(supabase.from).mockImplementation(createFromQueue([ok([conv])]));

    const { result } = renderHook(() => useConversationExport(), { wrapper });
    await result.current.exportConversations({});

    const { headers, rows } = await exportedCsv();
    const contatoIdx = headers.indexOf("contato");
    const telefoneIdx = headers.indexOf("telefone");
    expect(rows).toHaveLength(1);
    expect(rows[0][contatoIdx]).toBe("");
    expect(rows[0][telefoneIdx]).toBe("");
  });

  it("filtro channelType aplica .eq('channel.type', valor)", async () => {
    vi.mocked(supabase.from).mockImplementation(createFromQueue([ok([makeConversation()])]));

    const { result } = renderHook(() => useConversationExport(), { wrapper });
    await result.current.exportConversations({ channelType: "email" });

    const [builder] = fromResultsAsBuilders();
    expect(builder.eq).toHaveBeenCalledWith("channel.type", "email");
  });

  it("filtro aiActive aplica .eq('ai_active', valor)", async () => {
    vi.mocked(supabase.from).mockImplementation(createFromQueue([ok([makeConversation()])]));

    const { result } = renderHook(() => useConversationExport(), { wrapper });
    await result.current.exportConversations({ aiActive: false });

    const [builder] = fromResultsAsBuilders();
    expect(builder.eq).toHaveBeenCalledWith("ai_active", false);
  });

  it("filtro search é aplicado client-side, DEPOIS de toda a paginação concluída, reduzindo o resultado final", async () => {
    const page1 = Array.from({ length: PAGE_SIZE }, (_, i) =>
      makeConversation({
        id: `c-${i}`,
        contact: { name: `Contato ${i}`, phone: "11900000000", deleted_at: null },
      }),
    );
    const page2 = [
      makeConversation({
        id: "c-last",
        contact: { name: "Bruno Lima", phone: "11988887777", deleted_at: null },
      }),
    ];
    vi.mocked(supabase.from).mockImplementation(createFromQueue([ok(page1), ok(page2)]));

    const { result } = renderHook(() => useConversationExport(), { wrapper });
    const exportResult = await result.current.exportConversations({ search: "bruno" });

    // As 2 páginas foram buscadas por completo — o filtro de busca não corta a paginação.
    expect(vi.mocked(supabase.from)).toHaveBeenCalledTimes(2);
    expect(exportResult.recordsCount).toBe(1);

    const { headers, rows } = await exportedCsv();
    const contatoIdx = headers.indexOf("contato");
    expect(rows).toHaveLength(1);
    expect(rows[0][contatoIdx]).toBe("Bruno Lima");
  });

  it("filtro search também casa por telefone, case-insensitive", async () => {
    const conv = makeConversation({
      contact: { name: "Carla", phone: "11 98888-7777", deleted_at: null },
    });
    vi.mocked(supabase.from).mockImplementation(createFromQueue([ok([conv])]));

    const { result } = renderHook(() => useConversationExport(), { wrapper });
    const exportResult = await result.current.exportConversations({ search: "8888" });

    expect(exportResult.recordsCount).toBe(1);
  });

  it("traduz status 'open'/'closed' para pt-BR e aguardando_humano para Sim/Não", async () => {
    const convOpen = makeConversation({ id: "c-open", status: "open", awaiting_human: true });
    const convClosed = makeConversation({
      id: "c-closed",
      status: "closed",
      awaiting_human: false,
    });
    vi.mocked(supabase.from).mockImplementation(createFromQueue([ok([convOpen, convClosed])]));

    const { result } = renderHook(() => useConversationExport(), { wrapper });
    await result.current.exportConversations({});

    const { headers, rows } = await exportedCsv();
    const statusIdx = headers.indexOf("status");
    const awaitingIdx = headers.indexOf("aguardando_humano");
    expect(rows[0][statusIdx]).toBe("Aberta");
    expect(rows[0][awaitingIdx]).toBe("Sim");
    expect(rows[1][statusIdx]).toBe("Fechada");
    expect(rows[1][awaitingIdx]).toBe("Não");
  });

  it("traduz canal whatsapp/email para rótulo em pt-BR", async () => {
    const convWhats = makeConversation({ id: "c-w", channel: { type: "whatsapp" } });
    const convEmail = makeConversation({ id: "c-e", channel: { type: "email" } });
    vi.mocked(supabase.from).mockImplementation(createFromQueue([ok([convWhats, convEmail])]));

    const { result } = renderHook(() => useConversationExport(), { wrapper });
    await result.current.exportConversations({});

    const { headers, rows } = await exportedCsv();
    const canalIdx = headers.indexOf("canal");
    expect(rows[0][canalIdx]).toBe("WhatsApp");
    expect(rows[1][canalIdx]).toBe("E-mail");
  });

  it("last_message_at nulo exporta célula vazia", async () => {
    const conv = makeConversation({ last_message_at: null });
    vi.mocked(supabase.from).mockImplementation(createFromQueue([ok([conv])]));

    const { result } = renderHook(() => useConversationExport(), { wrapper });
    await result.current.exportConversations({});

    const { headers, rows } = await exportedCsv();
    const idx = headers.indexOf("ultimo_contato_em");
    expect(rows[0][idx]).toBe("");
  });
});
