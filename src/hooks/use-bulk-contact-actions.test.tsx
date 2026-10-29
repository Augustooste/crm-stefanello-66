import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { createTestQueryClient } from "@/test/render";
import { createFromQueue, fail, ok } from "@/test/supabase-mock";
import { useBulkContactActions } from "./use-bulk-contact-actions";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = createTestQueryClient();
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useBulkContactActions", () => {
  it("bulkSoftDelete: roda em lotes de 3, reporta sucesso/falha por item quando 1 falha no meio", async () => {
    const ids = ["c1", "c2", "c3", "c4", "c5"];
    // batches: [c1,c2,c3] [c4,c5] — força falha em c3 (meio do 1º lote).
    vi.mocked(supabase.from).mockImplementation(
      createFromQueue([
        ok(null),
        ok(null),
        fail("linha bloqueada por outro processo"),
        ok(null),
        ok(null),
      ]),
    );

    const { result } = renderHook(() => useBulkContactActions(), { wrapper });

    const report = await result.current.bulkSoftDelete(ids);

    expect(report.sucesso).toBe(4);
    expect(report.falhas).toBe(1);
    expect(report.erros).toEqual([{ id: "c3", motivo: "linha bloqueada por outro processo" }]);
    expect(vi.mocked(supabase.from)).toHaveBeenCalledTimes(5);
    // não mascara o erro: o item que falhou não conta como sucesso nem some do relatório
    expect(report.erros.map((e) => e.id)).not.toContain("c1");
  });

  it("bulkSoftDelete: não interrompe os lotes seguintes após uma falha", async () => {
    const ids = ["c1", "c2", "c3", "c4"];
    vi.mocked(supabase.from).mockImplementation(
      createFromQueue([fail("erro"), ok(null), ok(null), ok(null)]),
    );

    const { result } = renderHook(() => useBulkContactActions(), { wrapper });
    const report = await result.current.bulkSoftDelete(ids);

    expect(report.sucesso).toBe(3);
    expect(report.falhas).toBe(1);
    expect(vi.mocked(supabase.from)).toHaveBeenCalledTimes(4);
  });

  it("applyTag: busca tags atuais do servidor (nao do cache) e aplica so em quem ainda nao a possui", async () => {
    const ids = ["c1", "c2"];
    // c1: select devolve tags=["VIP"] -> ja tem, no update. c2: select devolve
    // tags=[] -> update adiciona a tag.
    vi.mocked(supabase.from).mockImplementation(
      createFromQueue([ok({ tags: ["VIP"] }), ok({ tags: [] }), ok(null)]),
    );

    const { result } = renderHook(() => useBulkContactActions(), { wrapper });
    const report = await result.current.applyTag({ contactIds: ids, tag: "VIP" });

    expect(report.sucesso).toBe(2);
    expect(report.falhas).toBe(0);
    // 2 selects (c1, c2) + 1 update (só c2, que não tinha a tag).
    expect(vi.mocked(supabase.from)).toHaveBeenCalledTimes(3);
  });

  it("applyTag: relatório reporta falha com motivo quando o update falha", async () => {
    vi.mocked(supabase.from).mockImplementation(
      createFromQueue([ok({ tags: [] }), fail("tenant inválido")]),
    );

    const { result } = renderHook(() => useBulkContactActions(), { wrapper });
    const report = await result.current.applyTag({ contactIds: ["c9"], tag: "Frio" });

    expect(report.sucesso).toBe(0);
    expect(report.falhas).toBe(1);
    expect(report.erros).toEqual([{ id: "c9", motivo: "tenant inválido" }]);
  });

  it("applyTag: falha na leitura das tags atuais propaga como falha do item (nunca grava tags erradas)", async () => {
    vi.mocked(supabase.from).mockImplementation(createFromQueue([fail("contato não encontrado")]));

    const { result } = renderHook(() => useBulkContactActions(), { wrapper });
    const report = await result.current.applyTag({ contactIds: ["c9"], tag: "Frio" });

    expect(report.sucesso).toBe(0);
    expect(report.falhas).toBe(1);
    expect(report.erros).toEqual([{ id: "c9", motivo: "contato não encontrado" }]);
    // leitura falhou -> nenhuma tentativa de update.
    expect(vi.mocked(supabase.from)).toHaveBeenCalledTimes(1);
  });

  it("invalida a query de contatos após rodar (sucesso ou falha parcial)", async () => {
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    vi.mocked(supabase.from).mockImplementation(createFromQueue([fail("erro"), ok(null)]));

    const { result } = renderHook(() => useBulkContactActions(), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    });

    await result.current.bulkSoftDelete(["c1", "c2"]);

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["contacts"] }));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["dashboard"] });
  });
});
