import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { createTestQueryClient } from "@/test/render";
import { createFromByTable, createQueryBuilder, fail, ok } from "@/test/supabase-mock";
import {
  addLeadFormField,
  moveLeadFormField,
  removeLeadFormField,
  slugify,
  updateLeadFormField,
  useContactCustomFieldDefinitions,
  useCreateLeadForm,
  useDeleteLeadForm,
  useLeadForms,
  useToggleLeadFormActive,
  useUpdateLeadForm,
  type LeadFormField,
} from "./use-lead-forms";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = createTestQueryClient();
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const FIELD_A: LeadFormField = {
  key: "nome",
  label: "Nome",
  type: "text",
  required: true,
  maps_to_custom_field_id: null,
};
const FIELD_B: LeadFormField = {
  key: "telefone",
  label: "Telefone",
  type: "text",
  required: false,
  maps_to_custom_field_id: "cfd-1",
};
const FIELD_C: LeadFormField = {
  key: "convenio",
  label: "Convênio",
  type: "select",
  required: false,
  maps_to_custom_field_id: null,
};

const FORM_ROW = {
  id: "form-1",
  tenant_id: "t1",
  name: "Contato site",
  slug: "contato-site",
  is_active: true,
  success_message: "Obrigado!",
  fields: [FIELD_A, FIELD_B],
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
};

describe("slugify", () => {
  it("normaliza acentos, minúsculas e símbolos para hífen", () => {
    expect(slugify("Formulário de Captação — Ação Rápida!")).toBe(
      "formulario-de-captacao-acao-rapida",
    );
  });

  it("remove hífens nas pontas e colapsa espaços múltiplos", () => {
    expect(slugify("  --Contato   Comercial--  ")).toBe("contato-comercial");
  });

  it("string vazia produz slug vazio", () => {
    expect(slugify("   ")).toBe("");
  });
});

describe("field builder (funções puras)", () => {
  it("addLeadFormField adiciona ao final sem mutar o array original", () => {
    const original = [FIELD_A];
    const next = addLeadFormField(original, FIELD_B);
    expect(next).toEqual([FIELD_A, FIELD_B]);
    expect(original).toEqual([FIELD_A]);
  });

  it("removeLeadFormField remove pelo índice sem mutar o array original", () => {
    const original = [FIELD_A, FIELD_B, FIELD_C];
    const next = removeLeadFormField(original, 1);
    expect(next).toEqual([FIELD_A, FIELD_C]);
    expect(original).toEqual([FIELD_A, FIELD_B, FIELD_C]);
  });

  it("moveLeadFormField troca com o vizinho na direção pedida", () => {
    const original = [FIELD_A, FIELD_B, FIELD_C];
    expect(moveLeadFormField(original, 0, 1)).toEqual([FIELD_B, FIELD_A, FIELD_C]);
    expect(moveLeadFormField(original, 2, -1)).toEqual([FIELD_A, FIELD_C, FIELD_B]);
    expect(original).toEqual([FIELD_A, FIELD_B, FIELD_C]);
  });

  it("moveLeadFormField é no-op nas bordas (primeiro pra cima, último pra baixo)", () => {
    const original = [FIELD_A, FIELD_B];
    expect(moveLeadFormField(original, 0, -1)).toEqual(original);
    expect(moveLeadFormField(original, 1, 1)).toEqual(original);
  });

  it("updateLeadFormField faz merge parcial no índice certo sem mutar o original", () => {
    const original = [FIELD_A, FIELD_B];
    const next = updateLeadFormField(original, 0, { required: false, label: "Nome completo" });
    expect(next[0]).toEqual({ ...FIELD_A, required: false, label: "Nome completo" });
    expect(next[1]).toEqual(FIELD_B);
    expect(original[0]).toEqual(FIELD_A);
  });
});

describe("useLeadForms", () => {
  it("busca e normaliza fields (jsonb) como array tipado", async () => {
    vi.mocked(supabase.from).mockImplementation(createFromByTable({ lead_forms: ok([FORM_ROW]) }));

    const { result } = renderHook(() => useLeadForms(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([FORM_ROW]);
  });

  it("fields ausente/malformado no banco vira array vazio, nunca lança", async () => {
    vi.mocked(supabase.from).mockImplementation(
      createFromByTable({ lead_forms: ok([{ ...FORM_ROW, fields: null }]) }),
    );

    const { result } = renderHook(() => useLeadForms(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0]?.fields).toEqual([]);
  });

  it("propaga erro do Supabase", async () => {
    vi.mocked(supabase.from).mockImplementation(
      createFromByTable({ lead_forms: fail("permission denied") }),
    );

    const { result } = renderHook(() => useLeadForms(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("useCreateLeadForm", () => {
  it("insere com tenant_id explícito e fields no shape documentado", async () => {
    const builder = createQueryBuilder(ok(null));
    vi.mocked(supabase.from).mockImplementation(
      () => builder as unknown as ReturnType<typeof supabase.from>,
    );

    const { result } = renderHook(() => useCreateLeadForm(), { wrapper });

    result.current.mutate({
      tenantId: "t1",
      name: "Contato site",
      slug: "contato-site",
      isActive: true,
      successMessage: "Obrigado!",
      fields: [FIELD_A],
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(supabase.from).toHaveBeenCalledWith("lead_forms");
    expect(builder.insert).toHaveBeenCalledWith({
      tenant_id: "t1",
      name: "Contato site",
      slug: "contato-site",
      is_active: true,
      success_message: "Obrigado!",
      fields: [FIELD_A],
    });
  });

  it("propaga erro de colisão de slug (unique tenant_id+slug)", async () => {
    vi.mocked(supabase.from).mockImplementation(
      createFromByTable({
        lead_forms: fail("duplicate key value violates unique constraint"),
      }),
    );

    const { result } = renderHook(() => useCreateLeadForm(), { wrapper });
    result.current.mutate({
      tenantId: "t1",
      name: "Dup",
      slug: "contato-site",
      isActive: true,
      successMessage: null,
      fields: [],
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("useUpdateLeadForm", () => {
  it("atualiza por id sem reenviar tenant_id (RLS já escopeia)", async () => {
    const builder = createQueryBuilder(ok(null));
    vi.mocked(supabase.from).mockImplementation(
      () => builder as unknown as ReturnType<typeof supabase.from>,
    );

    const { result } = renderHook(() => useUpdateLeadForm(), { wrapper });
    result.current.mutate({
      id: "form-1",
      name: "Contato site v2",
      slug: "contato-site",
      isActive: false,
      successMessage: null,
      fields: [FIELD_A, FIELD_B],
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(builder.update).toHaveBeenCalledWith({
      name: "Contato site v2",
      slug: "contato-site",
      is_active: false,
      success_message: null,
      fields: [FIELD_A, FIELD_B],
    });
    expect(builder.eq).toHaveBeenCalledWith("id", "form-1");
  });
});

describe("useToggleLeadFormActive", () => {
  it("atualiza somente is_active", async () => {
    const builder = createQueryBuilder(ok(null));
    vi.mocked(supabase.from).mockImplementation(
      () => builder as unknown as ReturnType<typeof supabase.from>,
    );

    const { result } = renderHook(() => useToggleLeadFormActive(), { wrapper });
    result.current.mutate({ id: "form-1", isActive: false });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(builder.update).toHaveBeenCalledWith({ is_active: false });
    expect(builder.eq).toHaveBeenCalledWith("id", "form-1");
  });
});

describe("useDeleteLeadForm", () => {
  it("exclui pelo id", async () => {
    const builder = createQueryBuilder(ok(null));
    vi.mocked(supabase.from).mockImplementation(
      () => builder as unknown as ReturnType<typeof supabase.from>,
    );

    const { result } = renderHook(() => useDeleteLeadForm(), { wrapper });
    result.current.mutate("form-1");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(builder.delete).toHaveBeenCalled();
    expect(builder.eq).toHaveBeenCalledWith("id", "form-1");
  });
});

describe("useContactCustomFieldDefinitions", () => {
  it("filtra por entity=contact e ordena por position", async () => {
    const builder = createQueryBuilder(
      ok([
        { id: "cfd-1", key: "convenio", label: "Convênio" },
        { id: "cfd-2", key: "cpf", label: "CPF" },
      ]),
    );
    vi.mocked(supabase.from).mockImplementation(
      () => builder as unknown as ReturnType<typeof supabase.from>,
    );

    const { result } = renderHook(() => useContactCustomFieldDefinitions(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([
      { id: "cfd-1", key: "convenio", label: "Convênio" },
      { id: "cfd-2", key: "cpf", label: "CPF" },
    ]);
    expect(supabase.from).toHaveBeenCalledWith("custom_field_definitions");
    expect(builder.eq).toHaveBeenCalledWith("entity", "contact");
  });
});
