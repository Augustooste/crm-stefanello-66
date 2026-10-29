import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import { supabase } from "@/integrations/supabase/client";
import { logClientError } from "@/lib/client-error-telemetry";
import { GLOBAL_SEARCH_DEBOUNCE_MS, useGlobalSearch } from "./use-global-search";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));

// Telemetria mockada: o módulo real tem rate limit + dedupe por (rota,
// mensagem) com janela de 60s — o 2º teste do mesmo erro seria descartado em
// silêncio e a asserção falharia por um motivo que não é o do teste.
vi.mock("@/lib/client-error-telemetry", () => ({
  logClientError: vi.fn(() => Promise.resolve(true)),
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  /** Rejeição (não `{error}`): exercita o caminho de exceção do hook. */
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Call = { method: string; args: unknown[] };
type FromCall = { table: string; chain: Call[] };
/** `error` precisa aceitar payload de erro: é o caminho do achado 05 · H4. */
type QueryResponse = { data: unknown; error: { message: string; code?: string } | null };

/**
 * Mock de `supabase.from` cuja resposta é controlada externamente por chamada
 * (na ordem em que `.from()` é invocado) — permite resolver a 2ª leva de
 * queries (busca mais recente) antes da 1ª (busca obsoleta) para testar o
 * descarte de resultado obsoleto.
 */
function mockSupabaseFrom(): {
  calls: FromCall[];
  deferreds: Deferred<QueryResponse>[];
} {
  const calls: FromCall[] = [];
  const deferreds: Deferred<QueryResponse>[] = [];

  vi.mocked(supabase.from).mockImplementation((table: string) => {
    const chain: Call[] = [];
    calls.push({ table, chain });
    const d = deferred<QueryResponse>();
    deferreds.push(d);

    const builder: Record<string, unknown> = {};
    for (const method of ["select", "ilike", "is", "limit"]) {
      builder[method] = vi.fn((...args: unknown[]) => {
        chain.push({ method, args });
        return builder;
      });
    }
    builder.then = (
      onFulfilled?: ((value: QueryResponse) => unknown) | null,
      onRejected?: ((reason: unknown) => unknown) | null,
    ) => d.promise.then(onFulfilled ?? undefined, onRejected ?? undefined);
    return builder as unknown as ReturnType<typeof supabase.from>;
  });

  return { calls, deferreds };
}

describe("useGlobalSearch", () => {
  it("não busca nada para termo vazio", () => {
    const { calls } = mockSupabaseFrom();
    const { result } = renderHook(() => useGlobalSearch(""));

    expect(result.current.results).toEqual({ contacts: [], conversations: [], deals: [] });
    expect(result.current.isSearching).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("espera o debounce (250ms) antes de disparar as 3 queries paralelas, cada uma com .limit(5)", () => {
    vi.useFakeTimers();
    try {
      const { calls } = mockSupabaseFrom();
      const { rerender } = renderHook(({ term }) => useGlobalSearch(term), {
        initialProps: { term: "" },
      });

      rerender({ term: "ana" });
      // Antes do debounce vencer, nenhuma query deve ter sido disparada.
      act(() => {
        vi.advanceTimersByTime(GLOBAL_SEARCH_DEBOUNCE_MS - 1);
      });
      expect(calls).toHaveLength(0);

      act(() => {
        vi.advanceTimersByTime(1);
      });

      expect(calls).toHaveLength(3);
      const tables = calls.map((c) => c.table).sort();
      expect(tables).toEqual(["contacts", "conversations", "deals"]);
      for (const call of calls) {
        const limitCall = call.chain.find((c) => c.method === "limit");
        expect(limitCall?.args).toEqual([5]);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("filtra contacts por name (ilike) e exclui soft-deletados (deleted_at is null)", () => {
    vi.useFakeTimers();
    try {
      const { calls } = mockSupabaseFrom();
      const { rerender } = renderHook(({ term }) => useGlobalSearch(term), {
        initialProps: { term: "" },
      });
      rerender({ term: "ana" });
      act(() => {
        vi.advanceTimersByTime(GLOBAL_SEARCH_DEBOUNCE_MS);
      });

      const contactsCall = calls.find((c) => c.table === "contacts")!;
      const ilikeCall = contactsCall.chain.find((c) => c.method === "ilike");
      expect(ilikeCall?.args).toEqual(["name", "%ana%"]);
      const isCall = contactsCall.chain.find((c) => c.method === "is");
      expect(isCall?.args).toEqual(["deleted_at", null]);

      const dealsCall = calls.find((c) => c.table === "deals")!;
      const dealsIlike = dealsCall.chain.find((c) => c.method === "ilike");
      expect(dealsIlike?.args).toEqual(["title", "%ana%"]);

      const conversationsCall = calls.find((c) => c.table === "conversations")!;
      const conversationsIlike = conversationsCall.chain.find((c) => c.method === "ilike");
      expect(conversationsIlike?.args).toEqual(["contact.name", "%ana%"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("descarta o resultado de uma busca anterior que resolve depois de uma mais nova", async () => {
    vi.useFakeTimers();
    try {
      const { calls, deferreds } = mockSupabaseFrom();
      const { result, rerender } = renderHook(({ term }) => useGlobalSearch(term), {
        initialProps: { term: "" },
      });

      // 1ª busca: "an" — dispara e fica pendente (não resolve ainda).
      rerender({ term: "an" });
      act(() => {
        vi.advanceTimersByTime(GLOBAL_SEARCH_DEBOUNCE_MS);
      });
      expect(calls).toHaveLength(3);

      // 2ª busca: "ana" — o usuário digitou mais rápido que a 1ª resposta chegou.
      rerender({ term: "ana" });
      act(() => {
        vi.advanceTimersByTime(GLOBAL_SEARCH_DEBOUNCE_MS);
      });
      expect(calls).toHaveLength(6);

      // A partir daqui só resolvemos promises — sem mais timers de debounce
      // envolvidos — volta a timers reais para não travar o `waitFor`.
      vi.useRealTimers();

      // 2ª busca resolve primeiro (mais rápida na rede).
      const [, , , contactsB, conversationsB, dealsB] = deferreds;
      contactsB.resolve({
        data: [{ id: "c-ana", name: "Ana", phone: null, email: null }],
        error: null,
      });
      conversationsB.resolve({ data: [], error: null });
      dealsB.resolve({ data: [], error: null });
      await waitFor(() => expect(result.current.isSearching).toBe(false));
      expect(result.current.results.contacts).toEqual([
        { id: "c-ana", name: "Ana", phone: null, email: null },
      ]);

      // 1ª busca ("an") resolve por último — resultado obsoleto não pode sobrescrever.
      const [contactsA, conversationsA, dealsA] = deferreds;
      contactsA.resolve({
        data: [{ id: "c-antigo", name: "Antigo", phone: null, email: null }],
        error: null,
      });
      conversationsA.resolve({ data: [], error: null });
      dealsA.resolve({ data: [], error: null });
      await new Promise((r) => setTimeout(r, 0));

      expect(result.current.results.contacts).toEqual([
        { id: "c-ana", name: "Ana", phone: null, email: null },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("limpar o campo enquanto uma busca ainda esta pendente descarta o resultado quando ele chega depois", async () => {
    vi.useFakeTimers();
    try {
      const { calls, deferreds } = mockSupabaseFrom();
      const { result, rerender } = renderHook(({ term }) => useGlobalSearch(term), {
        initialProps: { term: "" },
      });

      // Busca "ana" dispara e fica pendente (rede lenta) -- nao resolve ainda.
      rerender({ term: "ana" });
      act(() => {
        vi.advanceTimersByTime(GLOBAL_SEARCH_DEBOUNCE_MS);
      });
      expect(calls).toHaveLength(3);

      // Usuario limpa o campo antes da resposta chegar.
      rerender({ term: "" });
      expect(result.current.results).toEqual({ contacts: [], conversations: [], deals: [] });
      expect(result.current.isSearching).toBe(false);

      vi.useRealTimers();

      // A busca "ana", ja obsoleta, finalmente resolve.
      const [contacts, conversations, deals] = deferreds;
      contacts.resolve({
        data: [{ id: "c-ana", name: "Ana", phone: null, email: null }],
        error: null,
      });
      conversations.resolve({ data: [], error: null });
      deals.resolve({ data: [], error: null });
      // Espera as 3 promises resolverem de verdade (Promise.all interno do
      // runSearch) E mais alguns ticks pro .then() encadeado processar o
      // resultado e o React commitar -- um unico `setTimeout(0)` nao e
      // suficiente aqui (a asserção passaria mesmo sem o código correto,
      // simplesmente por não ter esperado o bastante para o estado mudar).
      await Promise.all([contacts.promise, conversations.promise, deals.promise]);
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      // Resultado obsoleto nao deve reaparecer depois do campo ter sido limpo.
      expect(result.current.results).toEqual({ contacts: [], conversations: [], deals: [] });
      expect(result.current.isSearching).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("digitar de novo dentro da janela do debounce cancela a busca anterior (só dispara 1 leva)", () => {
    vi.useFakeTimers();
    try {
      const { calls } = mockSupabaseFrom();
      const { rerender } = renderHook(({ term }) => useGlobalSearch(term), {
        initialProps: { term: "" },
      });

      rerender({ term: "a" });
      act(() => {
        vi.advanceTimersByTime(100);
      });
      rerender({ term: "an" });
      act(() => {
        vi.advanceTimersByTime(100);
      });
      rerender({ term: "ana" });
      act(() => {
        vi.advanceTimersByTime(GLOBAL_SEARCH_DEBOUNCE_MS);
      });

      // Só a última leva (termo "ana") deve ter disparado queries.
      expect(calls).toHaveLength(3);
      const contactsCall = calls.find((c) => c.table === "contacts")!;
      const ilikeCall = contactsCall.chain.find((c) => c.method === "ilike");
      expect(ilikeCall?.args).toEqual(["name", "%ana%"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("mapeia conversations com contactId e contactName a partir do join com contacts", async () => {
    vi.useFakeTimers();
    try {
      const { calls, deferreds } = mockSupabaseFrom();
      const { result, rerender } = renderHook(({ term }) => useGlobalSearch(term), {
        initialProps: { term: "" },
      });
      rerender({ term: "bruno" });
      act(() => {
        vi.advanceTimersByTime(GLOBAL_SEARCH_DEBOUNCE_MS);
      });

      vi.useRealTimers();
      const conversationsIndex = calls.findIndex((c) => c.table === "conversations");
      deferreds[conversationsIndex].resolve({
        data: [{ id: "conv-1", contact_id: "ct-1", contact: { name: "Bruno Lima" } }],
        error: null,
      });
      deferreds.forEach((d, i) => {
        if (i !== conversationsIndex) d.resolve({ data: [], error: null });
      });

      await waitFor(() => expect(result.current.isSearching).toBe(false));
      expect(result.current.results.conversations).toEqual([
        { id: "conv-1", contactId: "ct-1", contactName: "Bruno Lima" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  // ---------------------------------------------------------------------------
  // Achado 05 · H4 do code review de 10/08: erro de query virava lista vazia,
  // sem log e sem aviso -- o usuário lia "nenhum resultado" e concluía que o
  // contato tinha sumido.
  // ---------------------------------------------------------------------------
  describe("erro de query não pode virar 'nenhum resultado'", () => {
    beforeEach(() => vi.mocked(logClientError).mockClear());

    async function searchWith(
      responses: (index: number) => QueryResponse | "reject",
    ): Promise<ReturnType<typeof renderHook<ReturnType<typeof useGlobalSearch>, unknown>>> {
      vi.useFakeTimers();
      const { deferreds } = mockSupabaseFrom();
      const rendered = renderHook(({ term }: { term: string }) => useGlobalSearch(term), {
        initialProps: { term: "" },
      });
      rendered.rerender({ term: "ana" });
      act(() => {
        vi.advanceTimersByTime(GLOBAL_SEARCH_DEBOUNCE_MS);
      });
      vi.useRealTimers();
      deferreds.forEach((d, i) => {
        const response = responses(i);
        if (response === "reject") d.reject(new Error("network down"));
        else d.resolve(response);
      });
      await waitFor(() => expect(rendered.result.current.isSearching).toBe(false));
      return rendered as never;
    }

    it("expõe hasError e registra telemetria quando a query de contatos falha (RLS/rede)", async () => {
      const { result } = await searchWith((i) =>
        i === 0
          ? {
              data: null,
              error: { message: "permission denied for table contacts", code: "42501" },
            }
          : { data: [], error: null },
      );

      expect(result.current.hasError).toBe(true);
      expect(result.current.results.contacts).toEqual([]);
      expect(logClientError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "42501" }),
        expect.objectContaining({ origin: "query", operation: "global-search:contacts" }),
      );
    });

    it("falha parcial mantém o resultado da entidade que respondeu e ainda sinaliza o erro", async () => {
      const { result } = await searchWith((i) => {
        if (i === 0)
          return { data: [{ id: "c1", name: "Ana", phone: null, email: null }], error: null };
        if (i === 2) return { data: null, error: { message: "timeout", code: "PGRST504" } };
        return { data: [], error: null };
      });

      expect(result.current.results.contacts).toEqual([
        { id: "c1", name: "Ana", phone: null, email: null },
      ]);
      expect(result.current.hasError).toBe(true);
      expect(logClientError).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ operation: "global-search:deals" }),
      );
    });

    it("promise rejeitada não deixa isSearching preso e é registrada", async () => {
      const { result } = await searchWith((i) => (i === 1 ? "reject" : { data: [], error: null }));

      expect(result.current.isSearching).toBe(false);
      expect(result.current.hasError).toBe(true);
      expect(logClientError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ origin: "query", operation: "global-search" }),
      );
    });
  });
});
