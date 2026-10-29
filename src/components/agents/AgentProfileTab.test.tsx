import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";

import type { AgentPlatformAgent } from "@/lib/api/agent-platform-contract";
import { AgentProfileTab } from "./AgentProfileTab";

const agentQueryMock = vi.fn();
const updateMutationMock = vi.fn();

vi.mock("@/lib/api/agent-platform", () => ({
  useAgentPlatformQuery: (...args: unknown[]) => agentQueryMock(...args),
  useAgentPlatformMutation: (...args: unknown[]) => updateMutationMock(...args),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const AGENT: AgentPlatformAgent = {
  id: "agent-1",
  name: "Ana",
  behavior: "Você é uma assistente simpática.",
  avatar: "https://cdn.exemplo.com/ana.png",
  communicationType: "NORMAL",
  type: "SUPPORT",
  jobName: "Acelera IA",
  jobSite: "https://acelera.ia",
  jobDescription: "Plataforma de CRM com IA.",
};

function setAgentQuery(overrides: {
  isPending?: boolean;
  isError?: boolean;
  data?: unknown;
  error?: Error | null;
  refetch?: () => void;
}) {
  agentQueryMock.mockReturnValue({
    isPending: overrides.isPending ?? false,
    isError: overrides.isError ?? false,
    data: overrides.data,
    error: overrides.error ?? null,
    refetch: overrides.refetch ?? vi.fn(),
  });
}

function setUpdateMutation(mutate = vi.fn(), isPending = false) {
  updateMutationMock.mockReturnValue({ mutate, isPending });
  return mutate;
}

function renderTab() {
  return render(<AgentProfileTab agentId="agent-1" />);
}

describe("AgentProfileTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("mostra o skeleton enquanto o perfil do agente carrega", () => {
    setAgentQuery({ isPending: true });
    setUpdateMutation();

    const { container } = renderTab();

    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Nome")).not.toBeInTheDocument();
  });

  it("carrega e preenche o formulário com os dados remotos do agente", async () => {
    setAgentQuery({ data: AGENT });
    setUpdateMutation();

    renderTab();

    expect(await screen.findByLabelText("Nome")).toHaveValue("Ana");
    expect(screen.getByLabelText("URL do avatar")).toHaveValue("https://cdn.exemplo.com/ana.png");
    expect(screen.getByLabelText("Comportamento")).toHaveValue("Você é uma assistente simpática.");
    expect(screen.getByLabelText("Nome da empresa ou produto")).toHaveValue("Acelera IA");
    expect(screen.getByLabelText("Site")).toHaveValue("https://acelera.ia");
    expect(screen.getByLabelText("Descrição da empresa")).toHaveValue("Plataforma de CRM com IA.");
    expect(screen.getByRole("combobox", { name: "Tipo de comunicação" })).toHaveTextContent(
      "Normal",
    );
    expect(screen.getByRole("combobox", { name: "Objetivo do agente" })).toHaveTextContent(
      "Suporte",
    );
  });

  it("salva o perfil chamando agent.update com os nomes de campo do contrato", async () => {
    setAgentQuery({ data: AGENT });
    const mutate = setUpdateMutation();
    const user = userEvent.setup();

    renderTab();

    const nameInput = await screen.findByLabelText("Nome");
    await user.clear(nameInput);
    await user.type(nameInput, "Ana 2.0");
    await user.click(screen.getByRole("button", { name: "Salvar perfil do agente" }));

    expect(updateMutationMock).toHaveBeenCalledWith("agent.update", expect.anything());
    expect(mutate).toHaveBeenCalledWith({
      params: { agentId: "agent-1" },
      body: {
        name: "Ana 2.0",
        avatar: "https://cdn.exemplo.com/ana.png",
        behavior: "Você é uma assistente simpática.",
        jobName: "Acelera IA",
        jobSite: "https://acelera.ia",
        jobDescription: "Plataforma de CRM com IA.",
        communicationType: "NORMAL",
        type: "SUPPORT",
      },
    });
  });

  it("mostra o erro do provedor em PT-BR e permite tentar de novo", async () => {
    const refetch = vi.fn();
    setAgentQuery({
      isError: true,
      error: new Error("Os créditos do workspace no provedor de agentes acabaram."),
      refetch,
    });
    setUpdateMutation();
    const user = userEvent.setup();

    renderTab();

    expect(screen.getByText("Erro ao carregar perfil do agente")).toBeInTheDocument();
    expect(
      screen.getByText("Os créditos do workspace no provedor de agentes acabaram."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("preserva um communicationType desconhecido, visível e selecionado, sem quebrar a tela", async () => {
    setAgentQuery({ data: { ...AGENT, communicationType: "URGENTE" } });
    const mutate = setUpdateMutation();
    const user = userEvent.setup();

    renderTab();

    const combo = await screen.findByRole("combobox", { name: "Tipo de comunicação" });
    expect(combo).toHaveTextContent("URGENTE");

    await user.click(combo);
    expect(
      await screen.findByRole("option", {
        name: "URGENTE (valor não mapeado pelo provedor de agentes)",
      }),
    ).toBeInTheDocument();
    // Fecha o dropdown sem trocar a opção antes de submeter.
    await user.keyboard("{Escape}");

    // Visível não basta: salvar sem tocar no campo tem que ecoar o valor não
    // mapeado de volta pro provedor, nunca descartá-lo silenciosamente.
    await user.click(screen.getByRole("button", { name: "Salvar perfil do agente" }));
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ communicationType: "URGENTE" }),
      }),
    );
  });

  it("dispara toast de sucesso e de erro do provedor conforme o resultado da mutação", () => {
    setAgentQuery({ data: AGENT });
    setUpdateMutation();

    renderTab();

    const [, options] = updateMutationMock.mock.calls[0] as [
      string,
      { onSuccess?: () => void; onError?: (error: Error) => void },
    ];

    options.onSuccess?.();
    expect(toast.success).toHaveBeenCalledWith("Perfil do agente salvo.");

    options.onError?.(new Error("Revise os campos e tente novamente."));
    expect(toast.error).toHaveBeenCalledWith("Revise os campos e tente novamente.");
  });
});
