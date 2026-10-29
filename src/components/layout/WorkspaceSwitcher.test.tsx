import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { useSwitchWorkspace, useWorkspaces } from "@/lib/api/workspaces";

vi.mock("@/lib/api/workspaces", () => ({
  useWorkspaces: vi.fn(),
  useSwitchWorkspace: vi.fn(),
}));

describe("WorkspaceSwitcher", () => {
  const mutate = vi.fn();
  beforeEach(() => {
    mutate.mockReset();
    vi.mocked(useSwitchWorkspace).mockReturnValue({ mutate, isPending: false } as never);
  });

  it("mostra diretamente o único workspace", () => {
    vi.mocked(useWorkspaces).mockReturnValue({
      data: [{ tenant_id: "t1", tenant_name: "Workspace A", role_key: "admin", is_active: true }],
      isLoading: false,
    } as never);
    render(<WorkspaceSwitcher />);
    expect(screen.getByText("Workspace A")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Trocar empresa" })).not.toBeInTheDocument();
  });

  it("troca somente para uma membership listada", async () => {
    vi.mocked(useWorkspaces).mockReturnValue({
      data: [
        { tenant_id: "t1", tenant_name: "Workspace A", role_key: "admin", is_active: true },
        { tenant_id: "t2", tenant_name: "Workspace B", role_key: "agent", is_active: false },
      ],
      isLoading: false,
    } as never);
    render(<WorkspaceSwitcher />);
    await userEvent.click(screen.getByRole("button", { name: "Trocar empresa" }));
    await userEvent.click(await screen.findByText("Workspace B"));
    expect(mutate).toHaveBeenCalledWith("t2");
  });

  it("antes de a sessão ficar pronta (consulta pendente e parada), não mostra a marca genérica", () => {
    vi.mocked(useWorkspaces).mockReturnValue({
      data: undefined,
      isPending: true,
      isLoading: false,
    } as never);
    render(<WorkspaceSwitcher />);
    expect(screen.queryByText("CRM IA")).not.toBeInTheDocument();
    expect(screen.getByText("Carregando…")).toHaveAttribute("aria-busy", "true");
  });

  it("mantém a marca padrão quando a consulta terminou sem workspace", () => {
    vi.mocked(useWorkspaces).mockReturnValue({
      data: [],
      isPending: false,
      isLoading: false,
    } as never);
    render(<WorkspaceSwitcher />);
    expect(screen.getByText("CRM IA")).toBeInTheDocument();
    expect(screen.getByText("CRM IA")).not.toHaveAttribute("aria-busy");
  });
});
