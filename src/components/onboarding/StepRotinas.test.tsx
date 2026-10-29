import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { supabase } from "@/integrations/supabase/client";
import { createQueryWrapper } from "@/test/query-mocks";
import { StepRotinas } from "./StepRotinas";

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: vi.fn() },
}));
vi.mock("@/lib/auth/AuthProvider", () => ({ useAuth: authMock }));
vi.mock("@/lib/onboarding/bootstrap.functions", () => ({ configureEnvironment: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function mockUser(id: string | null) {
  authMock.mockReturnValue({ user: id ? { id } : null, isReady: true });
}

function mockStatus(canManage: boolean | undefined, vaultMissing: string[] = []) {
  vi.mocked(supabase.rpc).mockImplementation((async (name: string) => {
    if (name === "scheduled_jobs_status") {
      return {
        data: {
          can_manage: canManage,
          vault_missing: vaultMissing,
          total: 2,
          active: 1,
          jobs: [
            {
              jobname: "ai-response-worker-every-minute",
              schedule: "* * * * *",
              note: "Fila de respostas da IA",
              default_active: true,
              scheduled: true,
              active: true,
            },
            {
              jobname: "pipeline-agent",
              schedule: "* * * * *",
              note: "Funil automático",
              default_active: false,
              scheduled: true,
              active: false,
            },
          ],
        },
        error: null,
      };
    }
    return {
      data: { active: name === "activate_scheduled_jobs" ? 1 : 0, vault_missing: [] },
      error: null,
    };
  }) as unknown as typeof supabase.rpc);
}

beforeEach(() => {
  vi.mocked(supabase.rpc).mockReset();
  mockUser("admin-tenant");
});

describe("StepRotinas", () => {
  it("mostra estado sem controles para admin comum e permite continuar o wizard", async () => {
    mockStatus(false);
    render(<StepRotinas />, { wrapper: createQueryWrapper() });

    expect(await screen.findByText("1 de 2 rotinas em operação")).toBeInTheDocument();
    expect(screen.getByText("Ligada")).toBeInTheDocument();
    expect(screen.getByText("Desligada")).toBeInTheDocument();
    expect(
      screen.getByText("Rotinas da plataforma são gerenciadas pelo operador."),
    ).toBeInTheDocument();
    expect(screen.getByText(/Você pode concluir a configuração do seu tenant/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ativar rotinas" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pausar" })).not.toBeInTheDocument();
    expect(supabase.rpc).not.toHaveBeenCalledWith("activate_scheduled_jobs");
    expect(supabase.rpc).not.toHaveBeenCalledWith("pause_scheduled_jobs");
  });

  it("não oferece escrita quando o backend não informa autoridade", async () => {
    mockStatus(undefined);
    render(<StepRotinas />, { wrapper: createQueryWrapper() });

    await screen.findByText("1 de 2 rotinas em operação");
    expect(screen.queryByRole("button", { name: "Ativar rotinas" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pausar" })).not.toBeInTheDocument();
  });

  it("operador pode ativar e pausar pelas RPCs existentes", async () => {
    const user = userEvent.setup();
    mockStatus(true);
    render(<StepRotinas />, { wrapper: createQueryWrapper() });

    await user.click(await screen.findByRole("button", { name: "Ativar rotinas" }));
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalledWith("activate_scheduled_jobs"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Pausar" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Pausar" }));
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalledWith("pause_scheduled_jobs"));
  });

  it("mantém o bloqueio de ativação sem Vault mesmo para operador", async () => {
    mockStatus(true, ["aceleraflow_service_role_key"]);
    render(<StepRotinas />, { wrapper: createQueryWrapper() });

    expect(await screen.findByRole("button", { name: "Ativar rotinas" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Pausar" })).toBeEnabled();
  });

  it("não reaproveita a autoridade do operador ao trocar de usuário", async () => {
    mockUser("operador");
    mockStatus(true);
    const { rerender } = render(<StepRotinas />, { wrapper: createQueryWrapper() });
    await screen.findByRole("button", { name: "Ativar rotinas" });

    mockUser("outro-admin");
    mockStatus(false);
    rerender(<StepRotinas />);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Ativar rotinas" })).not.toBeInTheDocument();
    });
    expect(
      await screen.findByText("Rotinas da plataforma são gerenciadas pelo operador."),
    ).toBeInTheDocument();
  });

  it("retira os controles e não consulta como anônimo após logout", async () => {
    mockUser("operador");
    mockStatus(true);
    const { rerender } = render(<StepRotinas />, { wrapper: createQueryWrapper() });
    await screen.findByRole("button", { name: "Ativar rotinas" });
    vi.mocked(supabase.rpc).mockClear();

    mockUser(null);
    rerender(<StepRotinas />);

    expect(screen.queryByRole("button", { name: "Ativar rotinas" })).not.toBeInTheDocument();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("falha de leitura não oferece mutações nem impede pular a etapa", async () => {
    vi.mocked(supabase.rpc).mockRejectedValue(new Error("indisponível"));
    render(<StepRotinas />, { wrapper: createQueryWrapper() });

    expect(
      await screen.findByText(/Não foi possível consultar o estado das rotinas/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ativar rotinas" })).not.toBeInTheDocument();
  });
});
