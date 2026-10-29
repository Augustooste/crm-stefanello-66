import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { renderWithQueryClient } from "@/test/render";
import type { LeadFormField } from "@/hooks/use-lead-forms";
import { Route } from "./f.$formId";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { routerOverrides } = await import("@/test/router-mocks");
  return { ...actual, ...routerOverrides() };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
    functions: { invoke: vi.fn() },
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const PublicLeadFormPage = Route.options.component!;

const FIELDS: LeadFormField[] = [
  { key: "name", label: "Nome", type: "text", required: true, maps_to_custom_field_id: null },
  {
    key: "quantidade",
    label: "Quantidade",
    type: "number",
    required: false,
    maps_to_custom_field_id: null,
  },
  {
    key: "nascimento",
    label: "Nascimento",
    type: "date",
    required: false,
    maps_to_custom_field_id: null,
  },
  {
    key: "aceita_termos",
    label: "Aceita os termos",
    type: "boolean",
    required: true,
    maps_to_custom_field_id: null,
  },
];

const FORM_ROW = {
  id: "form1",
  name: "Fale conosco",
  success_message: "Valeu, já te respondemos!",
  fields: FIELDS,
};

function mockFormRow(row: unknown) {
  vi.mocked(supabase.rpc).mockReturnValue({
    maybeSingle: () => Promise.resolve({ data: row, error: null }),
  } as never);
}

beforeEach(() => {
  vi.spyOn(Route, "useParams").mockReturnValue({ formId: "form1" });
  vi.mocked(toast.error).mockClear();
});

describe("página pública de submissão de formulário (/f/$formId)", () => {
  it("mostra mensagem de indisponível quando o formulário não existe ou está inativo", async () => {
    mockFormRow(null);

    renderWithQueryClient(<PublicLeadFormPage />);

    expect(await screen.findByText("Formulário indisponível")).toBeInTheDocument();
    expect(
      screen.getByText("Este formulário não existe ou não está mais recebendo submissões."),
    ).toBeInTheDocument();
  });

  it("mostra erro real (com Tentar novamente) quando a query falha, sem confundir com formulário indisponível", async () => {
    vi.mocked(supabase.rpc).mockReturnValue({
      maybeSingle: () => Promise.resolve({ data: null, error: { message: "network error" } }),
    } as never);

    renderWithQueryClient(<PublicLeadFormPage />);

    expect(await screen.findByText("Erro ao carregar")).toBeInTheDocument();
    expect(screen.queryByText("Formulário indisponível")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tentar novamente" })).toBeInTheDocument();
  });

  it("mostra 'indisponível' (não crash) quando o formId é malformado (22P02 uuid inválido)", async () => {
    // Ex.: visitante cola /f/meu-slug em vez do UUID -> Postgres 22P02. Deve
    // cair no estado gracioso, não subir pro errorComponent global.
    vi.mocked(supabase.rpc).mockReturnValue({
      maybeSingle: () =>
        Promise.resolve({
          data: null,
          error: { code: "22P02", message: "invalid input syntax for type uuid" },
        }),
    } as never);

    renderWithQueryClient(<PublicLeadFormPage />);

    expect(await screen.findByText("Formulário indisponível")).toBeInTheDocument();
    expect(screen.queryByText("Erro ao carregar")).not.toBeInTheDocument();
  });

  it("renderiza os campos dinamicamente a partir de fields", async () => {
    mockFormRow(FORM_ROW);

    renderWithQueryClient(<PublicLeadFormPage />);

    expect(await screen.findByLabelText("Nome *")).toBeInTheDocument();
    expect(screen.getByLabelText("Quantidade")).toBeInTheDocument();
    expect(screen.getByLabelText("Nascimento")).toBeInTheDocument();
    expect(screen.getByLabelText("Aceita os termos *")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enviar" })).toBeInTheDocument();
  });

  it("bloqueia o submit e mostra erro quando falta campo obrigatório", async () => {
    mockFormRow(FORM_ROW);
    const user = userEvent.setup();

    renderWithQueryClient(<PublicLeadFormPage />);
    await screen.findByLabelText("Nome *");
    await user.click(screen.getByRole("button", { name: "Enviar" }));

    await waitFor(() => expect(screen.getAllByText("Campo obrigatório").length).toBeGreaterThan(0));
    expect(supabase.functions.invoke).not.toHaveBeenCalled();
  });

  it("chama lead-form-submit com o payload certo ao submeter", async () => {
    mockFormRow(FORM_ROW);
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: { ok: true, message: "Valeu, já te respondemos!" },
      error: null,
    } as unknown as Awaited<ReturnType<typeof supabase.functions.invoke>>);
    const user = userEvent.setup();

    renderWithQueryClient(<PublicLeadFormPage />);
    await user.type(await screen.findByLabelText("Nome *"), "Ana Souza");
    await user.type(screen.getByLabelText("Quantidade"), "3");
    await user.click(screen.getByLabelText("Aceita os termos *"));
    await user.click(screen.getByRole("button", { name: "Enviar" }));

    await waitFor(() =>
      expect(supabase.functions.invoke).toHaveBeenCalledWith("lead-form-submit", {
        body: {
          form_id: "form1",
          data: { name: "Ana Souza", quantidade: 3, aceita_termos: true },
        },
      }),
    );
  });

  it("mostra mensagem clara quando o backend responde 429 (rate limit)", async () => {
    mockFormRow(FORM_ROW);
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: null,
      error: {
        context: {
          status: 429,
          json: async () => ({
            error: "Muitas submissões recebidas. Tente novamente em alguns minutos.",
          }),
        },
      },
    } as unknown as Awaited<ReturnType<typeof supabase.functions.invoke>>);
    const user = userEvent.setup();

    renderWithQueryClient(<PublicLeadFormPage />);
    await user.type(await screen.findByLabelText("Nome *"), "Ana Souza");
    await user.click(screen.getByLabelText("Aceita os termos *"));
    await user.click(screen.getByRole("button", { name: "Enviar" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Muitas submissões recebidas. Tente novamente em alguns minutos.",
      ),
    );
  });

  it("mostra a success_message do formulário após o envio", async () => {
    mockFormRow(FORM_ROW);
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: { ok: true, message: "Valeu, já te respondemos!" },
      error: null,
    } as unknown as Awaited<ReturnType<typeof supabase.functions.invoke>>);
    const user = userEvent.setup();

    renderWithQueryClient(<PublicLeadFormPage />);
    await user.type(await screen.findByLabelText("Nome *"), "Ana Souza");
    await user.click(screen.getByLabelText("Aceita os termos *"));
    await user.click(screen.getByRole("button", { name: "Enviar" }));

    expect(await screen.findByText("Valeu, já te respondemos!")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enviar" })).not.toBeInTheDocument();
  });
});
