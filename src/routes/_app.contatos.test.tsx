import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { renderWithQueryClient } from "@/test/render";
import {
  asFromMock,
  createFromByTable,
  createQueryBuilder,
  fail,
  ok,
  type QueryResult,
} from "@/test/supabase-mock";
import type { ContactRow } from "@/components/contacts/ContactFormDialog";
import { useCurrentProfile, useTenantProfiles, type CurrentProfile } from "@/lib/api/session";
import { Route } from "./_app.contatos.index";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { routerOverrides } = await import("@/test/router-mocks");
  return { ...actual, ...routerOverrides() };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/api/session", () => ({
  useCurrentProfile: vi.fn(),
  useTenantProfiles: vi.fn(),
}));

const ContactsPage = Route.options.component!;

// Fase 4 PR-B (user story J) -- ContactRow (ContactFormDialog) ainda não inclui
// status/owner_id; mesma extensão local usada em _app.contatos.tsx.
type ContactListRow = ContactRow & { status: "lead" | "contact"; owner_id: string | null };

const CONTACTS: ContactListRow[] = [
  {
    id: "c1",
    tenant_id: "t1",
    name: "Ana Souza",
    phone: "11999990000",
    email: "ana@exemplo.com",
    source: "Site",
    tags: ["Quente"],
    notes: null,
    ai_paused: false,
    status: "lead",
    owner_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "c2",
    tenant_id: "t1",
    name: "Bruno Lima",
    phone: null,
    email: "bruno@exemplo.com",
    source: "Indicação",
    tags: [],
    notes: null,
    ai_paused: false,
    status: "contact",
    owner_id: "u1",
    created_at: "2026-01-02T00:00:00.000Z",
  },
];

function mockContacts(result: QueryResult<ContactListRow[]>) {
  vi.mocked(supabase.from).mockImplementation(createFromByTable({ contacts: result }));
}

const PROFILE: CurrentProfile = { id: "u1", tenant_id: "t1", name: "Ana Admin", role: "admin" };
const TENANT_PROFILES = [{ id: "u1", name: "Ana Admin", role: "admin" }];

function mockProfile(profile: CurrentProfile | null = PROFILE, tenantProfiles = TENANT_PROFILES) {
  vi.mocked(useCurrentProfile).mockReturnValue({
    data: profile,
  } as ReturnType<typeof useCurrentProfile>);
  vi.mocked(useTenantProfiles).mockReturnValue({
    data: tenantProfiles,
  } as ReturnType<typeof useTenantProfiles>);
}

describe("página de contatos (/_app/contatos)", () => {
  beforeEach(() => {
    mockProfile();
  });

  it("mostra estado vazio quando não há contatos", async () => {
    mockContacts(ok([]));
    renderWithQueryClient(<ContactsPage />);

    expect(await screen.findByText("Nenhum contato ainda")).toBeInTheDocument();
  });

  it("mostra estado de erro com opção de tentar novamente", async () => {
    mockContacts(fail("timeout ao buscar contatos"));
    renderWithQueryClient(<ContactsPage />);

    expect(await screen.findByText("Erro ao carregar contatos")).toBeInTheDocument();
    expect(screen.getByText("timeout ao buscar contatos")).toBeInTheDocument();
  });

  it("lista contatos e filtra pela busca", async () => {
    mockContacts(ok(CONTACTS));
    const user = userEvent.setup();
    renderWithQueryClient(<ContactsPage />);

    expect(await screen.findByText("Ana Souza")).toBeInTheDocument();
    expect(screen.getByText("Bruno Lima")).toBeInTheDocument();
    expect(screen.getByText("2 contatos na base")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Buscar contatos"), "ana");

    expect(screen.getByText("Ana Souza")).toBeInTheDocument();
    expect(screen.queryByText("Bruno Lima")).not.toBeInTheDocument();
  });

  it("exclui um contato após confirmação no alerta", async () => {
    mockContacts(ok(CONTACTS));
    const user = userEvent.setup();
    renderWithQueryClient(<ContactsPage />);

    await screen.findByText("Ana Souza");
    await user.click(screen.getByLabelText("Excluir Ana Souza"));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Excluir contato")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Excluir" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Contato excluído"));
  });

  it("botão 'Criar negócio' navega para o Pipeline com o contato pré-selecionado", async () => {
    mockContacts(ok(CONTACTS));
    const { navigateMock } = await import("@/test/router-mocks");
    navigateMock.mockClear();
    const user = userEvent.setup();
    renderWithQueryClient(<ContactsPage />);

    await screen.findByText("Ana Souza");
    await user.click(screen.getByLabelText("Criar negócio para Ana Souza"));

    expect(navigateMock).toHaveBeenCalledWith({
      to: "/pipeline",
      search: { contactId: "c1", contactName: "Ana Souza" },
    });
  });

  it("abre o formulário de novo contato ao clicar em 'Novo contato'", async () => {
    mockContacts(ok([]));
    const user = userEvent.setup();
    renderWithQueryClient(<ContactsPage />);

    await screen.findByText("Nenhum contato ainda");
    await user.click(screen.getAllByRole("button", { name: /Novo contato/ })[0]);

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("filtra por status (lead/contato/todos)", async () => {
    mockContacts(ok(CONTACTS));
    const user = userEvent.setup();
    renderWithQueryClient(<ContactsPage />);

    await screen.findByText("Ana Souza");
    expect(screen.getByText("Bruno Lima")).toBeInTheDocument();

    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Lead" }));

    expect(screen.getByText("Ana Souza")).toBeInTheDocument();
    expect(screen.queryByText("Bruno Lima")).not.toBeInTheDocument();
  });

  it("filtra por 'Meus contatos' (owner_id do usuário atual)", async () => {
    mockContacts(ok(CONTACTS));
    const user = userEvent.setup();
    renderWithQueryClient(<ContactsPage />);

    // Ana (c1) está sem dono; Bruno (c2) tem owner_id "u1" == profile atual.
    await screen.findByText("Ana Souza");
    expect(screen.getByText("Bruno Lima")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Mostrar apenas meus contatos"));

    expect(screen.queryByText("Ana Souza")).not.toBeInTheDocument();
    expect(screen.getByText("Bruno Lima")).toBeInTheDocument();
  });

  it("assume um contato sem dono atualizando somente owner_id (mantém status)", async () => {
    mockContacts(ok(CONTACTS));
    const user = userEvent.setup();
    renderWithQueryClient(<ContactsPage />);

    await screen.findByText("Ana Souza");
    // Ana (c1) está sem dono -- única linha com botão "Assumir" visível.
    await user.click(screen.getByRole("button", { name: /Assumir/ }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Contato assumido"));

    const updateBuilder = vi
      .mocked(supabase.from)
      .mock.results.map((r) => r.value)
      .find(
        (v): v is ReturnType<typeof createQueryBuilder> =>
          !!v && typeof v === "object" && "update" in v && v.update.mock.calls.length > 0,
      );
    expect(updateBuilder).toBeDefined();
    // Critério de aceite: o UPDATE toca SÓ owner_id -- nunca status.
    expect(updateBuilder!.update).toHaveBeenCalledWith({ owner_id: "u1" });
    expect(updateBuilder!.eq).toHaveBeenCalledWith("id", "c1");
    expect(updateBuilder!.is).toHaveBeenCalledWith("owner_id", null);
  });

  it("não mostra o botão 'Assumir' para contato que já tem dono", async () => {
    mockContacts(ok(CONTACTS));
    renderWithQueryClient(<ContactsPage />);

    await screen.findByText("Bruno Lima");
    const brunoRow = screen.getByText("Bruno Lima").closest("tr");
    expect(brunoRow).not.toBeNull();
    expect(within(brunoRow!).queryByRole("button", { name: /Assumir/ })).not.toBeInTheDocument();
    expect(within(brunoRow!).getByText("Ana Admin")).toBeInTheDocument();

    const anaRow = screen.getByText("Ana Souza").closest("tr");
    expect(anaRow).not.toBeNull();
    expect(within(anaRow!).getByRole("button", { name: /Assumir/ })).toBeInTheDocument();
  });

  it("mostra 'Dono desconhecido' quando o owner_id não está entre os perfis do tenant", async () => {
    const orfao: ContactListRow = {
      ...CONTACTS[1],
      id: "c3",
      name: "Carla Dias",
      owner_id: "usuario-removido",
    };
    mockContacts(ok([...CONTACTS, orfao]));
    renderWithQueryClient(<ContactsPage />);

    await screen.findByText("Carla Dias");
    const row = screen.getByText("Carla Dias").closest("tr");
    expect(row).not.toBeNull();
    expect(within(row!).getByText("Dono desconhecido")).toBeInTheDocument();
  });

  it("mostra toast de erro quando assumir contato falha no backend", async () => {
    let contactsCall = 0;
    vi.mocked(supabase.from).mockImplementation(
      asFromMock((table: string) => {
        if (table === "contacts") {
          contactsCall += 1;
          return createQueryBuilder(
            contactsCall === 1 ? ok(CONTACTS) : fail("erro ao assumir contato"),
          );
        }
        return createFromByTable({})(table);
      }),
    );
    const user = userEvent.setup();
    renderWithQueryClient(<ContactsPage />);

    await screen.findByText("Ana Souza");
    await user.click(screen.getByRole("button", { name: /Assumir/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("erro ao assumir contato"));
    expect(toast.success).not.toHaveBeenCalledWith("Contato assumido");
  });
});
