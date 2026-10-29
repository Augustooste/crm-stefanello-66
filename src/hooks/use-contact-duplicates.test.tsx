import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { createTestQueryClient } from "@/test/render";
import { createFromByTable, ok } from "@/test/supabase-mock";
import { friendlyMergeErrorMessage, useDuplicateGroups } from "./use-contact-duplicates";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = createTestQueryClient();
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

type ContactLookupRow = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  created_at: string;
};

function rpcGroup(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    match_type: "phone",
    match_value: "11999990000",
    contact_ids: ["c1", "c2"],
    contact_names: ["Ana", "Ana S."],
    group_size: 2,
    ...overrides,
  };
}

const CONTACTS: ContactLookupRow[] = [
  {
    id: "c1",
    name: "Ana",
    phone: "11999990000",
    email: null,
    created_at: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "c2",
    name: "Ana S.",
    phone: "11999990000",
    email: null,
    created_at: "2026-01-02T00:00:00.000Z",
  },
];

describe("useDuplicateGroups", () => {
  it("monta o grupo com os candidatos retornados pelo lookup em contacts", async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: [rpcGroup()], error: null } as never);
    vi.mocked(supabase.from).mockImplementation(createFromByTable({ contacts: ok(CONTACTS) }));

    const { result } = renderHook(() => useDuplicateGroups(), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([
      {
        key: "phone:11999990000",
        matchType: "phone",
        matchValue: "11999990000",
        groupSize: 2,
        contacts: CONTACTS,
      },
    ]);
  });

  it("race de merge concorrente: grupo que caiu para <2 candidatos apos o RPC e antes do lookup e descartado", async () => {
    // O RPC find_duplicate_contacts respondeu com um par (c1, c2), mas entre
    // essa resposta e o lookup em contacts alguem fundiu c2 em outro contato
    // (outra sessao) -- c2 some do resultado de contacts (deleted_at deixou
    // de ser null). O grupo residual de 1 candidato deve ser descartado, nao
    // aparecer na tela como se ainda fosse um par valido para revisao.
    vi.mocked(supabase.rpc).mockResolvedValue({ data: [rpcGroup()], error: null } as never);
    vi.mocked(supabase.from).mockImplementation(
      createFromByTable({ contacts: ok([CONTACTS[0]]) }), // só c1 sobrevive ao lookup
    );

    const { result } = renderHook(() => useDuplicateGroups(), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });

  it("multiplos grupos: só os com >=2 candidatos sobrevivem, grupos residuais de 1 são filtrados individualmente", async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: [
        rpcGroup(), // phone:11999990000 -- ambos sobrevivem
        rpcGroup({
          match_type: "email",
          match_value: "bruno@a.com",
          contact_ids: ["c3"],
          group_size: 2,
        }),
      ],
      error: null,
    } as never);
    vi.mocked(supabase.from).mockImplementation(
      createFromByTable({ contacts: ok(CONTACTS) }), // c3 não existe no lookup -- grupo email fica com 0
    );

    const { result } = renderHook(() => useDuplicateGroups(), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0].key).toBe("phone:11999990000");
  });

  it("nenhum grupo retornado pelo RPC: não chama o lookup em contacts", async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: [], error: null } as never);
    const fromMock = vi.fn();
    vi.mocked(supabase.from).mockImplementation(fromMock);

    const { result } = renderHook(() => useDuplicateGroups(), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("propaga erro do RPC (não engole)", async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: null,
      error: { message: "conexão falhou" },
    } as never);

    const { result } = renderHook(() => useDuplicateGroups(), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("friendlyMergeErrorMessage", () => {
  it("traduz o erro de 'ja fundido' pra mensagem PT-BR clara", () => {
    expect(friendlyMergeErrorMessage(new Error("Contact already merged"))).toBe(
      "Este contato já foi fundido por outra ação. Atualize a lista de duplicados.",
    );
  });

  it("aceita erro como objeto plano { message } (formato real do supabase-js)", () => {
    expect(friendlyMergeErrorMessage({ message: "Contact already merged" })).toBe(
      "Este contato já foi fundido por outra ação. Atualize a lista de duplicados.",
    );
  });

  it("outros erros passam a mensagem original", () => {
    expect(friendlyMergeErrorMessage(new Error("Unauthorized"))).toBe("Unauthorized");
  });

  it("erro com mensagem vazia cai no fallback genérico", () => {
    expect(friendlyMergeErrorMessage({ message: "" })).toBe("Erro ao fundir contatos.");
  });
});
