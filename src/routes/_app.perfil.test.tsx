import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { renderWithQueryClient } from "@/test/render";
import { asFromMock } from "@/test/supabase-mock";
import { Route } from "./_app.perfil";

const useCurrentProfileMock = vi.fn();
vi.mock("@/lib/api/session", () => ({
  useCurrentProfile: () => useCurrentProfileMock(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(),
    auth: { updateUser: vi.fn() },
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const PROFILE = {
  id: "user-1",
  tenant_id: "tenant-1",
  name: "Ana Souza",
  role: "admin" as const,
};

const PerfilPage = Route.options.component!;

describe("página de perfil (/_app/perfil)", () => {
  const updateMock = vi.fn();
  const eqMock = vi.fn();

  beforeEach(() => {
    useCurrentProfileMock.mockReset();
    useCurrentProfileMock.mockReturnValue({ data: PROFILE });

    updateMock.mockReset();
    eqMock.mockReset();
    eqMock.mockResolvedValue({ data: null, error: null });
    updateMock.mockReturnValue({ eq: eqMock });
    vi.mocked(supabase.from).mockImplementation(asFromMock(() => ({ update: updateMock })));

    vi.mocked(supabase.auth.updateUser).mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it("gera título e descrição no head da rota", async () => {
    const head = await Route.options.head?.({} as never);

    expect(head?.meta?.some((m) => m && "title" in m && m.title === "Perfil")).toBe(true);
    expect(
      head?.meta?.some(
        (m) => m && "content" in m && m.content === "Edite seu nome e altere sua senha de acesso.",
      ),
    ).toBe(true);
  });

  it("renderiza o nome atual do perfil como valor padrão", () => {
    renderWithQueryClient(<PerfilPage />);

    expect((screen.getByLabelText("Nome") as HTMLInputElement).value).toBe("Ana Souza");
  });

  it("envia a atualização de nome com o novo valor ao salvar", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<PerfilPage />);

    await user.clear(screen.getByLabelText("Nome"));
    await user.type(screen.getByLabelText("Nome"), "Novo Nome");
    await user.click(screen.getAllByRole("button", { name: "Salvar" })[0]);

    await waitFor(() => {
      expect(updateMock).toHaveBeenCalledWith({ name: "Novo Nome" });
      expect(eqMock).toHaveBeenCalledWith("id", "user-1");
    });
    expect(toast.success).toHaveBeenCalledWith("Perfil atualizado");
  });

  it("mostra erro de validação e não atualiza a senha quando a confirmação não coincide", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<PerfilPage />);

    await user.type(screen.getByLabelText("Nova senha"), "senha1234");
    await user.type(screen.getByLabelText("Confirme a nova senha"), "senha9876");
    await user.click(screen.getAllByRole("button", { name: "Salvar" })[1]);

    expect(await screen.findByText("As senhas não coincidem")).toBeInTheDocument();
    expect(supabase.auth.updateUser).not.toHaveBeenCalled();
  });

  it("rejeita senha com menos de 8 caracteres e não chama updateUser", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<PerfilPage />);

    await user.type(screen.getByLabelText("Nova senha"), "123456");
    await user.type(screen.getByLabelText("Confirme a nova senha"), "123456");
    await user.click(screen.getAllByRole("button", { name: "Salvar" })[1]);

    expect(await screen.findByText("A senha deve ter pelo menos 8 caracteres")).toBeInTheDocument();
    expect(supabase.auth.updateUser).not.toHaveBeenCalled();
  });

  it("rejeita senha puramente numérica (12345678) e não chama updateUser", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<PerfilPage />);

    await user.type(screen.getByLabelText("Nova senha"), "12345678");
    await user.type(screen.getByLabelText("Confirme a nova senha"), "12345678");
    await user.click(screen.getAllByRole("button", { name: "Salvar" })[1]);

    expect(await screen.findByText(/Escolha uma senha mais forte/)).toBeInTheDocument();
    expect(supabase.auth.updateUser).not.toHaveBeenCalled();
  });

  it("chama supabase.auth.updateUser quando as senhas coincidem e são fortes", async () => {
    vi.mocked(supabase.auth.updateUser).mockResolvedValue({
      data: { user: null },
      error: null,
    } as never);
    const user = userEvent.setup();
    renderWithQueryClient(<PerfilPage />);

    await user.type(screen.getByLabelText("Nova senha"), "senha1234");
    await user.type(screen.getByLabelText("Confirme a nova senha"), "senha1234");
    await user.click(screen.getAllByRole("button", { name: "Salvar" })[1]);

    await waitFor(() =>
      expect(supabase.auth.updateUser).toHaveBeenCalledWith({ password: "senha1234" }),
    );
    expect(toast.success).toHaveBeenCalledWith("Senha atualizada");
  });
});
