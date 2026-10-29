import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { renderWithQueryClient } from "@/test/render";
import { asFromMock, createQueryBuilder, ok, fail } from "@/test/supabase-mock";
import { ProductFormDialog, type ProductRow } from "./ProductFormDialog";

const useCurrentProfileMock = vi.fn();
vi.mock("@/lib/api/session", () => ({
  useCurrentProfile: () => useCurrentProfileMock(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const PRODUCT: ProductRow = {
  id: "product-1",
  tenant_id: "tenant-1",
  name: "Consulta avulsa",
  description: "Sessão única de 1h",
  price: 150,
  duration_minutes: 60,
  sku: "SKU-1",
  active: true,
  created_at: "2026-01-01T00:00:00.000Z",
};

describe("ProductFormDialog", () => {
  const insertMock = vi.fn();
  const updateMock = vi.fn();
  const onOpenChange = vi.fn();

  beforeEach(() => {
    useCurrentProfileMock.mockReset();
    useCurrentProfileMock.mockReturnValue({ data: { tenant_id: "tenant-1" } });
    onOpenChange.mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();

    insertMock.mockReset();
    insertMock.mockReturnValue({
      select: () => ({
        single: () => Promise.resolve(ok({ ...PRODUCT, id: "product-new", name: "Novo serviço" })),
      }),
    });
    updateMock.mockReset();
    updateMock.mockReturnValue(createQueryBuilder(ok(null)));

    vi.mocked(supabase.from).mockImplementation(
      asFromMock(() => ({ insert: insertMock, update: updateMock })),
    );
  });

  it("cria um produto novo com nome obrigatório e converte preço/duração pra número", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<ProductFormDialog open onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole("button", { name: "Criar produto" }));
    expect(await screen.findByText("Nome é obrigatório")).toBeInTheDocument();
    expect(insertMock).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Nome *"), "Novo serviço");
    await user.type(screen.getByLabelText("Preço (R$)"), "150,00");
    await user.type(screen.getByLabelText("Duração (min)"), "60");
    await user.type(screen.getByLabelText("SKU"), "SKU-NOVO");
    await user.click(screen.getByRole("button", { name: "Criar produto" }));

    await waitFor(() => {
      expect(insertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Novo serviço",
          description: null,
          price: 150,
          duration_minutes: 60,
          sku: "SKU-NOVO",
          tenant_id: "tenant-1",
        }),
      );
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toast.success).toHaveBeenCalledWith("Produto criado");
  });

  it("trata preço e duração em branco como null", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<ProductFormDialog open onOpenChange={onOpenChange} />);

    await user.type(screen.getByLabelText("Nome *"), "Produto sem preço");
    await user.click(screen.getByRole("button", { name: "Criar produto" }));

    await waitFor(() => {
      expect(insertMock).toHaveBeenCalledWith(
        expect.objectContaining({ price: null, duration_minutes: null, sku: null }),
      );
    });
  });

  it("edita um produto existente e envia só os campos do formulário", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<ProductFormDialog open onOpenChange={onOpenChange} product={PRODUCT} />);

    expect((screen.getByLabelText("Nome *") as HTMLInputElement).value).toBe("Consulta avulsa");
    expect((screen.getByLabelText("Preço (R$)") as HTMLInputElement).value).toBe("150");
    expect((screen.getByLabelText("Duração (min)") as HTMLInputElement).value).toBe("60");

    await user.clear(screen.getByLabelText("Preço (R$)"));
    await user.type(screen.getByLabelText("Preço (R$)"), "199,90");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => {
      expect(updateMock).toHaveBeenCalledWith({
        name: "Consulta avulsa",
        description: "Sessão única de 1h",
        price: 199.9,
        duration_minutes: 60,
        sku: "SKU-1",
      });
    });
    expect(toast.success).toHaveBeenCalledWith("Produto atualizado");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("converte preço com separador de milhar (BRL) sem perder nem inflar o valor", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<ProductFormDialog open onOpenChange={onOpenChange} />);

    await user.type(screen.getByLabelText("Nome *"), "Produto caro");
    await user.type(screen.getByLabelText("Preço (R$)"), "1.500,00");
    await user.type(screen.getByLabelText("Duração (min)"), "60,00");
    await user.click(screen.getByRole("button", { name: "Criar produto" }));

    await waitFor(() => {
      expect(insertMock).toHaveBeenCalledWith(
        expect.objectContaining({ price: 1500, duration_minutes: 60 }),
      );
    });
  });

  it("converte preço com milhar sem centavos (sem vírgula) corretamente, sem erro de 1000x", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<ProductFormDialog open onOpenChange={onOpenChange} />);

    await user.type(screen.getByLabelText("Nome *"), "Produto sem centavos");
    await user.type(screen.getByLabelText("Preço (R$)"), "1.500");
    await user.click(screen.getByRole("button", { name: "Criar produto" }));

    await waitFor(() => {
      expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({ price: 1500 }));
    });
  });

  it("rejeita preço não numérico como null em vez de silenciar pra zero", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<ProductFormDialog open onOpenChange={onOpenChange} />);

    await user.type(screen.getByLabelText("Nome *"), "Produto com lixo no preço");
    await user.type(screen.getByLabelText("Preço (R$)"), "abc");
    await user.click(screen.getByRole("button", { name: "Criar produto" }));

    await waitFor(() => {
      expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({ price: null }));
    });
  });

  it("mostra erro do toast quando a criação falha", async () => {
    insertMock.mockReturnValue({
      select: () => ({
        single: () => Promise.resolve(fail("Erro ao criar")),
      }),
    });
    const user = userEvent.setup();
    renderWithQueryClient(<ProductFormDialog open onOpenChange={onOpenChange} />);

    await user.type(screen.getByLabelText("Nome *"), "Falha Ltda");
    await user.click(screen.getByRole("button", { name: "Criar produto" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Erro ao criar"));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
