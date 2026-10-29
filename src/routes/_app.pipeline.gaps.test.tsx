import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useCurrentProfile, useTenantProfiles, type CurrentProfile } from "@/lib/api/session";
import { clickCardAction } from "@/test/pipeline-card";
import { renderWithQueryClient } from "@/test/render";
import {
  asFromMock,
  createQueryBuilder,
  fail,
  ok,
  type QueryBuilderMock,
} from "@/test/supabase-mock";
import { Route } from "./_app.pipeline";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/api/session", () => ({
  useCurrentProfile: vi.fn(),
  useTenantProfiles: vi.fn(),
}));

const PipelinePage = Route.options.component!;

type Stage = { id: string; name: string; position: number; is_won: boolean; is_lost: boolean };
type DealRow = {
  id: string;
  title: string;
  value: number | null;
  stage_id: string;
  owner_id: string | null;
  status: string | null;
  contact_id: string | null;
  contact: { id: string; name: string; tags: string[] | null } | null;
};

const BOARD = { id: "b1", name: "Funil padrão", is_default: true, position: 0 };

const STAGES: Stage[] = [
  { id: "s1", name: "Novos", position: 1, is_won: false, is_lost: false },
  { id: "s2", name: "Qualificados", position: 2, is_won: false, is_lost: false },
  { id: "s3", name: "Ganhos", position: 3, is_won: true, is_lost: false },
  { id: "s4", name: "Perdidos", position: 4, is_won: false, is_lost: true },
];

const DEALS: DealRow[] = [
  {
    id: "d1",
    title: "Negócio A",
    value: 1000,
    stage_id: "s1",
    owner_id: "u1",
    status: "open",
    contact_id: "c1",
    contact: { id: "c1", name: "Ana Souza", tags: ["Quente"] },
  },
  {
    id: "d2",
    title: "Negócio B",
    value: 2000,
    stage_id: "s2",
    owner_id: "u2",
    status: "open",
    contact_id: null,
    contact: null,
  },
];

const TAGS = [{ id: "tg1", name: "Quente", color: "#ff0000" }];

const CONTACTS_MIN = [
  { id: "c1", name: "Ana Souza" },
  { id: "c2", name: "Bruno Lima" },
];

const PROFILE: CurrentProfile = { id: "u1", tenant_id: "tenant-1", name: "Ana", role: "admin" };
const TENANT_PROFILES = [
  { id: "u1", name: "Ana", role: "admin" },
  { id: "u2", name: "Bruno", role: "agent" },
];

function mockProfile(profile: CurrentProfile | null = PROFILE, tenantProfiles = TENANT_PROFILES) {
  vi.mocked(useCurrentProfile).mockReturnValue({
    data: profile,
  } as ReturnType<typeof useCurrentProfile>);
  vi.mocked(useTenantProfiles).mockReturnValue({
    data: tenantProfiles,
  } as ReturnType<typeof useTenantProfiles>);
}

/** Mock padrão de `supabase.from`, roteado por tabela — usado nos testes que não
 * precisam forçar erro nem diferenciar chamadas repetidas na mesma tabela. */
function mockSupabaseFrom() {
  vi.mocked(supabase.from).mockImplementation(
    asFromMock((table: string) => {
      switch (table) {
        case "boards":
          return createQueryBuilder(ok([BOARD]));
        case "board_stages":
          return createQueryBuilder(ok(STAGES));
        case "deals":
          return createQueryBuilder(ok(DEALS));
        case "tags":
          return createQueryBuilder(ok(TAGS));
        case "contacts":
          return createQueryBuilder(ok(CONTACTS_MIN));
        default:
          return createQueryBuilder(ok(null));
      }
    }),
  );
}

describe("página de pipeline — lacunas de cobertura (/_app/pipeline)", () => {
  beforeEach(() => {
    mockProfile();
    vi.mocked(supabase.rpc).mockReset();
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: { success: true, status: "accepted" },
      error: null,
    } as never);
    vi.spyOn(Route, "useSearch").mockReturnValue({});
  });

  it("expõe metadados de head da rota", async () => {
    const head = await Route.options.head?.({} as never);
    if (!head) throw new Error("head indefinido");

    expect(head.meta?.[0]).toEqual({ title: "Funil de vendas" });
    expect(head.links?.[0]).toEqual({
      rel: "canonical",
      href: "https://aceleraflow.lovable.app/pipeline",
    });
  });

  it("mostra toast de erro quando falha ao marcar negócio como ganho", async () => {
    mockSupabaseFrom();
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: null,
      error: { message: "Erro de rede" },
    } as never);
    renderWithQueryClient(<PipelinePage />);

    await screen.findByText("Negócio A");
    await clickCardAction("Negócio A", "Ganhar");

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Erro de rede"));
  });

  it("fecha o dialog de perda ao clicar em Cancelar, sem enviar mutação", async () => {
    const dealsUpdateSpy = vi.fn();
    vi.mocked(supabase.from).mockImplementation(
      asFromMock((table: string) => {
        switch (table) {
          case "boards":
            return createQueryBuilder(ok([BOARD]));
          case "board_stages":
            return createQueryBuilder(ok(STAGES));
          case "deals": {
            const builder = createQueryBuilder(ok(DEALS));
            builder.update = dealsUpdateSpy.mockReturnValue(builder);
            return builder;
          }
          case "tags":
            return createQueryBuilder(ok(TAGS));
          case "contacts":
            return createQueryBuilder(ok(CONTACTS_MIN));
          default:
            return createQueryBuilder(ok(null));
        }
      }),
    );
    renderWithQueryClient(<PipelinePage />);

    await screen.findByText("Negócio A");
    const user = await clickCardAction("Negócio A", "Perder");

    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(dealsUpdateSpy).not.toHaveBeenCalled();
  });

  it("fecha o dialog de perda ao pressionar Escape (onOpenChange do Dialog)", async () => {
    mockSupabaseFrom();
    renderWithQueryClient(<PipelinePage />);

    await screen.findByText("Negócio A");
    const user = await clickCardAction("Negócio A", "Perder");

    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("cria um novo negócio criando um contato novo ao mesmo tempo", async () => {
    const dealsInsertSpy = vi.fn();
    const contactsInsertSpy = vi.fn();
    const contactsBuilder: QueryBuilderMock = createQueryBuilder(ok(CONTACTS_MIN));
    contactsBuilder.single = vi.fn(() => Promise.resolve(ok({ id: "c-nova" })));
    contactsBuilder.insert = contactsInsertSpy.mockReturnValue(contactsBuilder);

    vi.mocked(supabase.from).mockImplementation(
      asFromMock((table: string) => {
        switch (table) {
          case "boards":
            return createQueryBuilder(ok([BOARD]));
          case "board_stages":
            return createQueryBuilder(ok(STAGES));
          case "deals": {
            const builder = createQueryBuilder(ok(DEALS));
            builder.insert = dealsInsertSpy.mockReturnValue(builder);
            return builder;
          }
          case "tags":
            return createQueryBuilder(ok(TAGS));
          case "contacts":
            return contactsBuilder;
          default:
            return createQueryBuilder(ok(null));
        }
      }),
    );

    const user = userEvent.setup();
    renderWithQueryClient(<PipelinePage />);

    await user.click(await screen.findByRole("button", { name: /Novo negócio/ }));
    const dialog = await screen.findByRole("dialog");

    await user.click(within(dialog).getByRole("radio", { name: "Criar contato novo" }));

    const textboxes = within(dialog).getAllByRole("textbox");
    await user.type(textboxes[0], "Carla Dias");
    await user.type(textboxes[1], "11988887777");
    await user.type(within(dialog).getByPlaceholderText("Ex.: Plano anual"), "Plano mensal");
    await user.click(within(dialog).getByRole("button", { name: "Criar negócio" }));

    await waitFor(() =>
      expect(contactsInsertSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant_id: "tenant-1",
          name: "Carla Dias",
          phone: "11988887777",
        }),
      ),
    );
    await waitFor(() =>
      expect(dealsInsertSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant_id: "tenant-1",
          board_id: "b1",
          stage_id: "s1",
          contact_id: "c-nova",
          title: "Plano mensal",
        }),
      ),
    );
    expect(toast.success).toHaveBeenCalledWith("Negócio criado");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("mostra toast de erro quando falha ao criar negócio", async () => {
    let dealsCall = 0;
    vi.mocked(supabase.from).mockImplementation(
      asFromMock((table: string) => {
        switch (table) {
          case "boards":
            return createQueryBuilder(ok([BOARD]));
          case "board_stages":
            return createQueryBuilder(ok(STAGES));
          case "deals":
            dealsCall += 1;
            return dealsCall === 1
              ? createQueryBuilder(ok(DEALS))
              : createQueryBuilder(fail("Erro ao salvar negócio"));
          case "tags":
            return createQueryBuilder(ok(TAGS));
          case "contacts":
            return createQueryBuilder(ok(CONTACTS_MIN));
          default:
            return createQueryBuilder(ok(null));
        }
      }),
    );

    const user = userEvent.setup();
    renderWithQueryClient(<PipelinePage />);

    await user.click(await screen.findByRole("button", { name: /Novo negócio/ }));
    const dialog = await screen.findByRole("dialog");

    await user.click(within(dialog).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Ana Souza" }));
    await user.type(within(dialog).getByPlaceholderText("Ex.: Plano anual"), "Plano anual");
    await user.click(within(dialog).getByRole("button", { name: "Criar negócio" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Erro ao salvar negócio"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("fecha o dialog de novo negócio ao clicar em Cancelar, sem enviar mutação", async () => {
    mockSupabaseFrom();
    const user = userEvent.setup();
    renderWithQueryClient(<PipelinePage />);

    await user.click(await screen.findByRole("button", { name: /Novo negócio/ }));
    const dialog = await screen.findByRole("dialog");

    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  // Lacuna conhecida: o submenu "Mover para…" (Radix DropdownMenuSub) depende de
  // pointer events (hover/pointermove) que o jsdom não simula de forma confiável,
  // e o drag-and-drop do @dnd-kit também depende de eventos de ponteiro reais —
  // por isso `handleMoveToStage`, `onDragStart` e `onDragEnd` não têm teste direto
  // aqui (mesma limitação já documentada em `_app.pipeline.test.tsx`). A mutation
  // que ambos disparam (`moveMut`) já está coberta pelos testes de "Ganhar"/"Perder".
});
