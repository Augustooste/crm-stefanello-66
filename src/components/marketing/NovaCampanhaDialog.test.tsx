import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UseQueryResult } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { renderWithQueryClient } from "@/test/render";
import { asFromMock, createQueryBuilder, ok } from "@/test/supabase-mock";
import { useCurrentProfile, type CurrentProfile } from "@/lib/api/session";
import { NovaCampanhaDialog } from "./NovaCampanhaDialog";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

vi.mock("@/lib/api/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/session")>();
  return { ...actual, useCurrentProfile: vi.fn() };
});

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const TEMPLATE = {
  id: "tpl-1",
  tenant_id: "t1",
  channel_id: null,
  name: "Reativação",
  language: "pt_BR",
  body: "Sentimos sua falta!",
  variables: [],
  tags: [],
  version: 1,
  parent_id: null,
  is_draft: false,
  status: "approved",
  kind: "freeform",
  provider_template_name: null,
};

function setup(estimate: number, template: Record<string, unknown> = TEMPLATE) {
  vi.mocked(useCurrentProfile).mockReturnValue({
    data: { id: "u1", tenant_id: "t1", name: "Ana", role: "admin" },
    isLoading: false,
  } as UseQueryResult<CurrentProfile | null, Error>);
  vi.mocked(supabase.rpc).mockResolvedValue({ data: estimate, error: null } as never);

  const inserts: unknown[] = [];
  vi.mocked(supabase.from).mockImplementation(
    asFromMock((table: string) => {
      if (table === "messaging_templates") return createQueryBuilder(ok([template]));
      if (table === "channels") {
        return createQueryBuilder(
          ok([
            { id: "ch-1", provider_slug: "evolution", type: "whatsapp" },
            { id: "ch-2", provider_slug: "provedor-inexistente", type: "whatsapp" },
          ]),
        );
      }
      if (table === "tags") return createQueryBuilder(ok([{ id: "tag-1", name: "inativo" }]));
      if (table === "board_stages") return createQueryBuilder(ok([]));
      if (table === "custom_field_definitions") return createQueryBuilder(ok([]));
      if (table === "template_schedules") {
        const builder = createQueryBuilder(ok(null));
        builder.insert = vi.fn((payload: unknown) => {
          inserts.push(payload);
          return builder;
        });
        return builder;
      }
      return createQueryBuilder(ok(null));
    }),
  );
  return inserts;
}

async function goToAudienceStep(user: ReturnType<typeof userEvent.setup>) {
  const dialog = await screen.findByRole("dialog");
  await user.type(within(dialog).getByLabelText("Nome da campanha *"), "Reativar inativos");
  await user.click(within(dialog).getByRole("combobox", { name: "Canal *" }));
  await user.click(await screen.findByRole("option", { name: "WhatsApp (Evolution)" }));
  await user.click(within(dialog).getByRole("button", { name: "Avançar" }));
  return dialog;
}

describe("NovaCampanhaDialog", () => {
  beforeEach(() => {
    vi.mocked(toast.success).mockReset();
    vi.mocked(supabase.rpc).mockReset();
  });

  it("só lista canal com provedor suportado pelo backend", async () => {
    setup(3);
    const user = userEvent.setup();
    renderWithQueryClient(<NovaCampanhaDialog open onOpenChange={() => {}} />);

    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: "Canal *" }));
    expect(await screen.findByRole("option", { name: "WhatsApp (Evolution)" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(2); // "Escolher canal" + Evolution
  });

  it("público vazio não avança nem consulta estimativa (nunca envia para todos)", async () => {
    setup(3);
    const user = userEvent.setup();
    renderWithQueryClient(<NovaCampanhaDialog open onOpenChange={() => {}} />);

    const dialog = await goToAudienceStep(user);
    expect(within(dialog).getByText(/Sem critério ninguém recebe/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Avançar" })).toBeDisabled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("estimativa zero bloqueia o avanço", async () => {
    setup(0);
    const user = userEvent.setup();
    renderWithQueryClient(<NovaCampanhaDialog open onOpenChange={() => {}} />);

    const dialog = await goToAudienceStep(user);
    await user.click(within(dialog).getByRole("checkbox", { name: "inativo" }));
    expect(await within(dialog).findByText(/Público estimado: 0 contato/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Avançar" })).toBeDisabled();
  });

  it("fluxo completo: estima, resume, exige confirmação e grava a campanha", async () => {
    const inserts = setup(3);
    const user = userEvent.setup();
    renderWithQueryClient(<NovaCampanhaDialog open onOpenChange={() => {}} />);

    const dialog = await goToAudienceStep(user);
    await user.click(within(dialog).getByRole("checkbox", { name: "inativo" }));
    expect(await within(dialog).findByText(/Público estimado: 3 contato/)).toBeInTheDocument();
    expect(supabase.rpc).toHaveBeenCalledWith("estimate_campaign_audience", {
      p_filter: { tags: ["inativo"] },
    });
    await user.click(within(dialog).getByRole("button", { name: "Avançar" }));

    await user.click(within(dialog).getByRole("combobox", { name: "Modelo aprovado *" }));
    await user.click(await screen.findByRole("option", { name: "Reativação (v1)" }));
    await user.click(within(dialog).getByRole("button", { name: "Avançar" }));

    await user.click(
      within(dialog).getByRole("checkbox", { name: "Enviar agora (sai em até 5 minutos)" }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Avançar" }));

    expect(within(dialog).getByText("Reativar inativos")).toBeInTheDocument();
    expect(within(dialog).getByText("WhatsApp (Evolution)")).toBeInTheDocument();
    const submit = within(dialog).getByRole("button", { name: "Confirmar e enviar" });
    expect(submit).toBeDisabled();

    await user.click(
      within(dialog).getByRole("checkbox", { name: /Confirmo o envio desta campanha para 3/ }),
    );
    await user.click(submit);

    await waitFor(() =>
      expect(inserts[0]).toMatchObject({
        tenant_id: "t1",
        template_id: "tpl-1",
        channel_id: "ch-1",
        name: "Reativar inativos",
        audience_filter: { tags: ["inativo"] },
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Campanha na fila de envio");
  });

  it("bloqueia modelo aprovado pela Meta num canal que não é a Meta", async () => {
    setup(3, {
      ...TEMPLATE,
      kind: "provider_approved",
      provider_template_name: "reativacao_cliente",
    });
    const user = userEvent.setup();
    renderWithQueryClient(<NovaCampanhaDialog open onOpenChange={() => {}} />);

    const dialog = await goToAudienceStep(user); // canal Evolution
    await user.click(within(dialog).getByRole("checkbox", { name: "inativo" }));
    await within(dialog).findByText(/Público estimado: 3 contato/);
    await user.click(within(dialog).getByRole("button", { name: "Avançar" }));

    await user.click(within(dialog).getByRole("combobox", { name: "Modelo aprovado *" }));
    await user.click(await screen.findByRole("option", { name: "Reativação (v1)" }));
    expect(within(dialog).getByText(/só é enviado pelo WhatsApp oficial/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Avançar" })).toBeDisabled();
  });

  it("pré-seleciona o modelo vindo da aba Modelos", async () => {
    setup(3);
    const user = userEvent.setup();
    renderWithQueryClient(
      <NovaCampanhaDialog open onOpenChange={() => {}} initialTemplateId="tpl-1" />,
    );

    const dialog = await goToAudienceStep(user);
    await user.click(within(dialog).getByRole("checkbox", { name: "inativo" }));
    await within(dialog).findByText(/Público estimado: 3 contato/);
    await user.click(within(dialog).getByRole("button", { name: "Avançar" }));
    expect(await within(dialog).findByText("Sentimos sua falta!")).toBeInTheDocument();
  });
});
