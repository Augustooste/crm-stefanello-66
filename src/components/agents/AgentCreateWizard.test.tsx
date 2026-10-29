import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";

import { navigateMock, routerOverrides } from "@/test/router-mocks";
import { AgentPlatformCallError } from "@/lib/api/agent-platform";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, ...routerOverrides() };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const useAgentPlatformMutationMock = vi.fn();
vi.mock("@/lib/api/agent-platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/agent-platform")>();
  return {
    ...actual,
    useAgentPlatformMutation: (...args: unknown[]) => useAgentPlatformMutationMock(...args),
  };
});

import { AgentCreateWizard } from "./AgentCreateWizard";

let mutate: ReturnType<typeof vi.fn>;
let onSuccessCallback: ((data: { id?: string }) => void) | undefined;
let onErrorCallback: ((error: AgentPlatformCallError) => void) | undefined;

function mockMutation(overrides: Partial<Record<string, unknown>> = {}) {
  mutate = vi.fn();
  useAgentPlatformMutationMock.mockImplementation(
    (
      _action: string,
      options: {
        onSuccess?: (data: { id?: string }) => void;
        onError?: (error: AgentPlatformCallError) => void;
      },
    ) => {
      onSuccessCallback = options.onSuccess;
      onErrorCallback = options.onError;
      return { mutate, isPending: false, ...overrides };
    },
  );
}

describe("AgentCreateWizard", () => {
  beforeEach(() => {
    useAgentPlatformMutationMock.mockReset();
    navigateMock.mockReset();
    mockMutation();
  });

  it("não envia o formulário sem preencher o nome (obrigatório)", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<AgentCreateWizard open onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole("button", { name: "Criar agente" }));

    expect(await screen.findByText("Nome é obrigatório")).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("envia o payload com os nomes remotos e valores padrão dos enums", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<AgentCreateWizard open onOpenChange={onOpenChange} />);

    await user.type(screen.getByLabelText("Nome *"), "Sofia");
    await user.click(screen.getByRole("button", { name: "Criar agente" }));

    expect(mutate).toHaveBeenCalledWith({
      body: expect.objectContaining({
        name: "Sofia",
        communicationType: "NORMAL",
        type: "SUPPORT",
      }),
    });
  });

  it("omite campos opcionais vazios do payload (nunca envia string vazia)", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<AgentCreateWizard open onOpenChange={onOpenChange} />);

    await user.type(screen.getByLabelText("Nome *"), "Sofia");
    await user.click(screen.getByRole("button", { name: "Criar agente" }));

    const [[call]] = mutate.mock.calls;
    expect(call.body.avatar).toBeUndefined();
    expect(call.body.jobName).toBeUndefined();
    expect(call.body.jobSite).toBeUndefined();
    expect(call.body.jobDescription).toBeUndefined();
    expect(call.body.behavior).toBeUndefined();
  });

  it("ao criar com sucesso, fecha o diálogo e navega para /agentes/$agentId", () => {
    const onOpenChange = vi.fn();
    render(<AgentCreateWizard open onOpenChange={onOpenChange} />);

    onSuccessCallback?.({ id: "novo-agente" });

    expect(toast.success).toHaveBeenCalledWith("Agente criado.");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/agentes/$agentId",
      params: { agentId: "novo-agente" },
    });
  });

  it("se o provedor de agentes não devolver o id do agente, avisa e não navega", () => {
    const onOpenChange = vi.fn();
    render(<AgentCreateWizard open onOpenChange={onOpenChange} />);

    onSuccessCallback?.({ id: undefined });

    expect(toast.error).toHaveBeenCalledWith(
      "O provedor de agentes não retornou o ID do agente criado.",
    );
    expect(navigateMock).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("mostra o erro em PT-BR do proxy quando a criação falha", () => {
    const onOpenChange = vi.fn();
    render(<AgentCreateWizard open onOpenChange={onOpenChange} />);

    onErrorCallback?.(new AgentPlatformCallError("VALIDATION_ERROR", "Nome inválido"));

    expect(toast.error).toHaveBeenCalledWith("Nome inválido");
  });

  it("cancelar fecha o diálogo sem chamar a mutação", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<AgentCreateWizard open onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mutate).not.toHaveBeenCalled();
  });
});
