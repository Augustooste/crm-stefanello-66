import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { renderWithQueryClient } from "@/test/render";
import { asFromMock, createQueryBuilder, ok, fail } from "@/test/supabase-mock";
import { CompanyFormDialog, type CompanyRow } from "./CompanyFormDialog";

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

const COMPANY: CompanyRow = {
  id: "company-1",
  tenant_id: "tenant-1",
  name: "Acme Ltda",
  industry: "Tecnologia",
  website: "https://acme.com",
  created_at: "2026-01-01T00:00:00.000Z",
};

describe("CompanyFormDialog", () => {
  const insertMock = vi.fn();
  const updateMock = vi.fn();
  const onOpenChange = vi.fn();
  const onCreated = vi.fn();

  beforeEach(() => {
    useCurrentProfileMock.mockReset();
    useCurrentProfileMock.mockReturnValue({ data: { tenant_id: "tenant-1" } });
    onOpenChange.mockReset();
    onCreated.mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();

    insertMock.mockReset();
    insertMock.mockReturnValue({
      select: () => ({
        single: () =>
          Promise.resolve(ok({ ...COMPANY, id: "company-new", name: "Nova Indústria" })),
      }),
    });
    updateMock.mockReset();
    updateMock.mockReturnValue(createQueryBuilder(ok(null)));

    vi.mocked(supabase.from).mockImplementation(
      asFromMock(() => ({ insert: insertMock, update: updateMock })),
    );
  });

  it("cria uma empresa nova com nome obrigatório", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(
      <CompanyFormDialog open onOpenChange={onOpenChange} onCreated={onCreated} />,
    );

    await user.click(screen.getByRole("button", { name: "Criar empresa" }));
    expect(await screen.findByText("Nome é obrigatório")).toBeInTheDocument();
    expect(insertMock).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Nome *"), "Nova Indústria");
    await user.click(screen.getByRole("button", { name: "Criar empresa" }));

    await waitFor(() => {
      expect(insertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Nova Indústria",
          industry: null,
          website: null,
          tenant_id: "tenant-1",
        }),
      );
    });
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith(
        expect.objectContaining({ id: "company-new", name: "Nova Indústria" }),
      ),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toast.success).toHaveBeenCalledWith("Empresa criada");
  });

  it("preenche defaultName ao abrir em modo criação", () => {
    renderWithQueryClient(
      <CompanyFormDialog open onOpenChange={onOpenChange} defaultName="Beta S.A." />,
    );
    expect((screen.getByLabelText("Nome *") as HTMLInputElement).value).toBe("Beta S.A.");
  });

  it("edita uma empresa existente e envia só os campos do formulário", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<CompanyFormDialog open onOpenChange={onOpenChange} company={COMPANY} />);

    expect((screen.getByLabelText("Nome *") as HTMLInputElement).value).toBe("Acme Ltda");

    await user.clear(screen.getByLabelText("Setor"));
    await user.type(screen.getByLabelText("Setor"), "Indústria");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => {
      expect(updateMock).toHaveBeenCalledWith({
        name: "Acme Ltda",
        industry: "Indústria",
        website: "https://acme.com",
      });
    });
    expect(toast.success).toHaveBeenCalledWith("Empresa atualizada");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("mostra erro do toast quando a criação falha", async () => {
    insertMock.mockReturnValue({
      select: () => ({
        single: () => Promise.resolve(fail("Erro ao criar")),
      }),
    });
    const user = userEvent.setup();
    renderWithQueryClient(<CompanyFormDialog open onOpenChange={onOpenChange} />);

    await user.type(screen.getByLabelText("Nome *"), "Falha Ltda");
    await user.click(screen.getByRole("button", { name: "Criar empresa" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Erro ao criar"));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
