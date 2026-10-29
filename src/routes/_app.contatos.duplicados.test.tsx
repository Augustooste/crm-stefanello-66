import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { renderWithQueryClient } from "@/test/render";
import { createFromByTable, ok, type QueryResult } from "@/test/supabase-mock";
import { Route } from "./_app.contatos.duplicados";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { routerOverrides } = await import("@/test/router-mocks");
  return { ...actual, ...routerOverrides() };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const DuplicatesPage = Route.options.component!;

type ContactLookupRow = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  created_at: string;
};

const TWO_WAY_CONTACTS: ContactLookupRow[] = [
  {
    id: "c1",
    name: "Ana Souza",
    phone: "11999990000",
    email: "ana@old.com",
    created_at: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "c2",
    name: "Ana S.",
    phone: "11999990000",
    email: "ana@new.com",
    created_at: "2026-01-05T00:00:00.000Z",
  },
];

const THREE_WAY_CONTACTS: ContactLookupRow[] = [
  {
    id: "c1",
    name: "Bruno Lima",
    phone: null,
    email: "bruno@a.com",
    created_at: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "c2",
    name: "Bruno L.",
    phone: null,
    email: "bruno@a.com",
    created_at: "2026-01-02T00:00:00.000Z",
  },
  {
    id: "c3",
    name: "B. Lima",
    phone: null,
    email: "bruno@a.com",
    created_at: "2026-01-03T00:00:00.000Z",
  },
];

function mockContactsLookup(result: QueryResult<ContactLookupRow[]>) {
  vi.mocked(supabase.from).mockImplementation(createFromByTable({ contacts: result }));
}

function phoneGroupPayload() {
  return [
    {
      match_type: "phone",
      match_value: "11999990000",
      contact_ids: ["c1", "c2"],
      contact_names: ["Ana Souza", "Ana S."],
      group_size: 2,
    },
  ];
}

function emailGroupOfThreePayload() {
  return [
    {
      match_type: "email",
      match_value: "bruno@a.com",
      contact_ids: ["c1", "c2", "c3"],
      contact_names: ["Bruno Lima", "Bruno L.", "B. Lima"],
      group_size: 3,
    },
  ];
}

describe("página de contatos duplicados (/_app/contatos/duplicados)", () => {
  beforeEach(() => {
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    // `mockClear` só zera o histórico de chamadas -- preserva a fila de
    // `mockResolvedValueOnce` que cada teste empilha para si mesmo, então não
    // há vazamento de call-count entre testes nem perda das respostas enfileiradas.
    vi.mocked(supabase.rpc).mockClear();
    vi.mocked(supabase.from).mockClear();
  });

  it("mostra estado vazio quando não há grupos duplicados", async () => {
    vi.mocked(supabase.rpc).mockResolvedValueOnce({ data: [], error: null } as never);
    mockContactsLookup(ok([]));

    renderWithQueryClient(<DuplicatesPage />);

    expect(await screen.findByText("Nenhum contato duplicado")).toBeInTheDocument();
  });

  it("lista um grupo por telefone e funde com sucesso no contato escolhido", async () => {
    vi.mocked(supabase.rpc)
      .mockResolvedValueOnce({ data: phoneGroupPayload(), error: null } as never)
      .mockResolvedValueOnce({ data: { success: true }, error: null } as never)
      // Merge invalida `["contact-duplicates"]` -- query ativa refaz o fetch
      // automaticamente (é o próprio comportamento exigido pelo escopo, item 4).
      .mockResolvedValueOnce({ data: [], error: null } as never);
    mockContactsLookup(ok(TWO_WAY_CONTACTS));

    const user = userEvent.setup();
    renderWithQueryClient(<DuplicatesPage />);

    expect(await screen.findByText("Ana Souza")).toBeInTheDocument();
    expect(screen.getByText("Ana S.")).toBeInTheDocument();
    expect(screen.getByText("Mesmo telefone")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Fundir grupo/ }));

    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith("merge_contacts", {
        p_source_id: "c2",
        p_target_id: "c1",
      }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Grupo fundido em "Ana Souza"'));
    expect(toast.error).not.toHaveBeenCalled();
    // Lista refeita após o merge mostra que o grupo já não existe mais.
    await waitFor(() => expect(screen.getByText("Nenhum contato duplicado")).toBeInTheDocument());
  });

  it("propaga o erro de 'contato já fundido' como toast, sem engolir silenciosamente", async () => {
    vi.mocked(supabase.rpc)
      .mockResolvedValueOnce({ data: phoneGroupPayload(), error: null } as never)
      .mockResolvedValueOnce({
        data: null,
        error: { message: "Contact already merged" },
      } as never)
      // Merge falhou mas `onSettled` invalida mesmo assim -- refetch traz o
      // mesmo grupo de volta (contato não foi de fato fundido).
      .mockResolvedValueOnce({ data: phoneGroupPayload(), error: null } as never);
    mockContactsLookup(ok(TWO_WAY_CONTACTS));

    const user = userEvent.setup();
    renderWithQueryClient(<DuplicatesPage />);

    await screen.findByText("Ana Souza");
    await user.click(screen.getByRole("button", { name: /Fundir grupo/ }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Este contato já foi fundido por outra ação. Atualize a lista de duplicados.",
      ),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("funde um grupo com 3+ contatos chamando merge_contacts para cada contato restante no principal escolhido", async () => {
    vi.mocked(supabase.rpc)
      .mockResolvedValueOnce({ data: emailGroupOfThreePayload(), error: null } as never)
      .mockResolvedValueOnce({ data: { success: true }, error: null } as never)
      .mockResolvedValueOnce({ data: { success: true }, error: null } as never)
      // Refetch pós-merge disparado pela invalidação.
      .mockResolvedValueOnce({ data: [], error: null } as never);
    mockContactsLookup(ok(THREE_WAY_CONTACTS));

    const user = userEvent.setup();
    renderWithQueryClient(<DuplicatesPage />);

    await screen.findByText("Bruno Lima");

    const card = screen.getByText("Mesmo e-mail").closest("div.rounded-xl") as HTMLElement;
    // Escolhe "B. Lima" (terceiro contato do grupo) como principal, em vez do default (mais antigo).
    await user.click(within(card).getByRole("radio", { name: /B\. Lima/ }));
    await user.click(within(card).getByRole("button", { name: /Fundir grupo/ }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Grupo fundido em "B. Lima"'));
    expect(supabase.rpc).toHaveBeenNthCalledWith(2, "merge_contacts", {
      p_source_id: "c1",
      p_target_id: "c3",
    });
    expect(supabase.rpc).toHaveBeenNthCalledWith(3, "merge_contacts", {
      p_source_id: "c2",
      p_target_id: "c3",
    });
  });
});
