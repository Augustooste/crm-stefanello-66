import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";

import { IdleActionsSection } from "./IdleActionsSection";
import { createQueryWrapper } from "@/test/query-mocks";

type QueryConfig = { data?: unknown; isLoading?: boolean; error?: { message: string } | null };
type MutationOptions = {
  onSuccess?: (data: unknown, variables: unknown) => void;
  onError?: (error: { message: string }, variables: unknown) => void;
};

const queryConfigs: Record<string, QueryConfig> = {};
// Memoizado por action (não recriado a cada render): o onSuccess desta seção
// muda estado local (existsOnServer/actions), o que re-renderiza e recriaria
// a mutation a cada chamada — um spy novo a cada render perderia a chamada
// real de vista ("0 chamadas" mesmo tendo disparado).
const mutationSpies: Record<string, ReturnType<typeof vi.fn>> = {};
const mutationOptionsByAction: Record<string, MutationOptions> = {};
const mutationOutcomes: Record<string, "success" | "error"> = {};

function setQuery(action: string, config: QueryConfig) {
  queryConfigs[action] = config;
}

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/api/agent-platform", () => ({
  useAgentPlatformQuery: (action: string) => {
    const cfg = queryConfigs[action] ?? {};
    return {
      data: cfg.data,
      isLoading: cfg.isLoading ?? false,
      error: cfg.error ?? null,
      refetch: vi.fn(),
    };
  },
  useAgentPlatformMutation: (action: string, options?: MutationOptions) => {
    mutationOptionsByAction[action] = options ?? {};
    if (!mutationSpies[action]) {
      mutationSpies[action] = vi.fn((variables: unknown) => {
        const outcome = mutationOutcomes[action] ?? "success";
        const opts = mutationOptionsByAction[action];
        if (outcome === "success") opts.onSuccess?.({}, variables);
        else opts.onError?.({ message: "Erro" }, variables);
      });
    }
    return { mutate: mutationSpies[action], isPending: false };
  },
  useAgentPlatformConnection: () => ({ data: null }),
}));

function renderSection() {
  return render(<IdleActionsSection agentId="agent-1" />, { wrapper: createQueryWrapper() });
}

describe("IdleActionsSection", () => {
  afterEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(queryConfigs)) delete queryConfigs[key];
    for (const key of Object.keys(mutationOutcomes)) delete mutationOutcomes[key];
    for (const key of Object.keys(mutationSpies)) delete mutationSpies[key];
    for (const key of Object.keys(mutationOptionsByAction)) delete mutationOptionsByAction[key];
  });

  it("cria (idleActions.create) quando ainda não havia configuração no servidor", async () => {
    setQuery("idleActions.get", { data: { actions: [], finishOn: { seconds: 0 } } });
    const user = userEvent.setup();

    renderSection();

    await screen.findByText("Nenhuma ação configurada ainda. Adicione uma abaixo.");
    expect(screen.getByRole("button", { name: /Remover todas/ })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Adicionar ação" }));
    await user.type(screen.getByLabelText("Mensagem/instruções"), "Ainda está aí?");
    await user.click(screen.getByRole("button", { name: "Salvar ações de inatividade" }));

    await waitFor(() =>
      expect(mutationSpies["idleActions.create"]).toHaveBeenCalledWith({
        params: { agentId: "agent-1" },
        body: {
          actions: [
            {
              instructions: "Ainda está aí?",
              seconds: 60,
              allowAllHours: true,
              workingHours: undefined,
            },
          ],
          finishOn: { seconds: 0 },
        },
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Ações de inatividade salvas");
    // Depois do sucesso o componente marca "existe no servidor" — o PRÓXIMO
    // salvamento já vai por idleActions.update. Não é bug: é a transição
    // esperada create → update na mesma sessão.
  });

  it("pré-preenche o editor a partir da forma aninhada do GET e salva na forma achatada do PUT (sem vazar tenant/sequence)", async () => {
    setQuery("idleActions.get", {
      data: {
        actions: [
          {
            id: "act-1",
            type: "SEND_MESSAGE",
            instructions: "Oi, ainda está aí?",
            allowAllHours: false,
            seconds: 120,
            workingHours: {
              id: "wh-1",
              tenant: "t",
              tenantOwner: "t",
              createdAt: 1,
              updatedAt: null,
              active: true,
              days: [
                {
                  id: "d1",
                  tenant: "t",
                  tenantOwner: "t",
                  createdAt: 1,
                  updatedAt: null,
                  active: true,
                  dayWeek: 1,
                  hours: [
                    {
                      id: "h1",
                      tenant: "t",
                      tenantOwner: "t",
                      createdAt: 1,
                      updatedAt: null,
                      start: "08:00",
                      end: "12:00",
                      sequence: 0,
                    },
                  ],
                },
              ],
            },
          },
        ],
        finishOn: { seconds: 300 },
      },
    });
    const user = userEvent.setup();

    renderSection();

    expect(await screen.findByLabelText("Segunda")).toBeChecked();
    expect(screen.getByLabelText("Início em Segunda")).toHaveValue("08:00");
    expect(screen.getByLabelText("Fim em Segunda")).toHaveValue("12:00");
    expect(screen.getByLabelText("Finalizar atendimento após (segundos)")).toHaveValue(300);
    // "Remover todas" habilitado: já existe configuração no servidor
    expect(screen.getByRole("button", { name: /Remover todas/ })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Salvar ações de inatividade" }));

    await waitFor(() =>
      expect(mutationSpies["idleActions.update"]).toHaveBeenCalledWith({
        params: { agentId: "agent-1" },
        body: {
          actions: [
            {
              instructions: "Oi, ainda está aí?",
              seconds: 120,
              allowAllHours: false,
              workingHours: [
                { dayWeek: 1, active: true, hours: [{ start: "08:00", end: "12:00" }] },
              ],
            },
          ],
          finishOn: { seconds: 300 },
        },
      }),
    );
  });

  it("exclusão avisa que remove TODO o conjunto (D10) e chama idleActions.delete só com agentId", async () => {
    setQuery("idleActions.get", {
      data: {
        actions: [{ id: "act-1", instructions: "Oi", allowAllHours: true, seconds: 60 }],
        finishOn: { seconds: 0 },
      },
    });
    const user = userEvent.setup();

    renderSection();

    expect(await screen.findByLabelText("Mensagem/instruções")).toHaveValue("Oi");
    await user.click(screen.getByRole("button", { name: /Remover todas/ }));

    expect(await screen.findByText("Remover todas as ações de inatividade")).toBeInTheDocument();
    // "todo o conjunto" está em <strong> — deixa explícito que a exclusão é do CONJUNTO (D10),
    // não de uma ação isolada.
    expect(screen.getByText("todo o conjunto")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Confirmar remoção" }));

    await waitFor(() =>
      expect(mutationSpies["idleActions.delete"]).toHaveBeenCalledWith({
        params: { agentId: "agent-1" },
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Ações de inatividade removidas");
  });
});
