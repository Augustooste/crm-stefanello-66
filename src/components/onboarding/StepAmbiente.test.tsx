import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const configureMutate = vi.fn();
const statusMock = vi.fn();

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/api/onboarding", () => ({
  useBootstrapStatus: () => statusMock(),
  useConfigureEnvironment: () => ({ mutate: configureMutate, isPending: false }),
}));

import { StepAmbiente } from "./StepAmbiente";

const items = [
  {
    key: "vault",
    label: "Acesso interno do backend",
    status: "pendente" as const,
    detail: "Falta gravar.",
  },
  { key: "niches", label: "Modelos de nicho", status: "ok" as const, detail: "12 modelos." },
];

beforeEach(() => {
  configureMutate.mockReset();
  statusMock.mockReset();
});

describe("StepAmbiente", () => {
  it("dispara a configuração automática quando o cofre interno está incompleto", async () => {
    statusMock.mockReturnValue({
      data: { vault_missing: ["aceleraflow_project_url"], items, ok: false },
      isLoading: false,
      isError: false,
    });

    render(<StepAmbiente />);

    await waitFor(() => expect(configureMutate).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Acesso interno do backend")).toBeInTheDocument();
  });

  it("não auto-configura quando o ambiente já está pronto", async () => {
    statusMock.mockReturnValue({
      data: { vault_missing: [], items: [items[1]], ok: true },
      isLoading: false,
      isError: false,
    });

    render(<StepAmbiente />);

    expect(await screen.findByText("Ambiente pronto.")).toBeInTheDocument();
    expect(configureMutate).not.toHaveBeenCalled();
  });

  it("com auto desligado, só reconfigura por clique explícito", async () => {
    const user = userEvent.setup();
    statusMock.mockReturnValue({
      data: { vault_missing: ["aceleraflow_service_role_key"], items, ok: false },
      isLoading: false,
      isError: false,
    });

    render(<StepAmbiente auto={false} />);
    expect(configureMutate).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /Tentar de novo/i }));
    expect(configureMutate).toHaveBeenCalledTimes(1);
  });

  it("explica a falta de permissão em vez de erro cru", () => {
    statusMock.mockReturnValue({ data: null, isLoading: false, isError: true });

    render(<StepAmbiente />);

    expect(screen.getByText(/Apenas administradores/i)).toBeInTheDocument();
  });
});
