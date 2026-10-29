import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithQueryClient } from "@/test/render";
import { AutomationSettingsDialog } from "./PipelineAutomation";

const state = vi.hoisted(() => ({
  profile: { id: "admin-1", tenant_id: "tenant-1", role: "admin" },
  feature: null as { enabled: boolean; enabled_at: string | null } | null,
  readError: null as { message: string } | null,
  writeError: null as { message: string } | null,
  eq: vi.fn(),
  upsert: vi.fn(),
}));
vi.mock("@/lib/api/session", () => ({ useCurrentProfile: () => ({ data: state.profile }) }));
vi.mock("@/lib/api/pipeline-automation", () => ({
  useStageTransitionRules: () => ({ data: [], isLoading: false }),
  usePipelineAutomationMetrics: () => ({ data: null }),
  useUpdateStageTransitionRule: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      if (table !== "tenant_ai_features") throw new Error(`Tabela inesperada: ${table}`);
      const query = {
        select: () => query,
        eq: (key: string, value: string) => {
          state.eq(key, value);
          return query;
        },
        maybeSingle: async () => ({ data: state.feature, error: state.readError }),
        upsert: state.upsert,
      };
      return query;
    },
  },
}));

async function openSettings() {
  const user = userEvent.setup();
  renderWithQueryClient(<AutomationSettingsDialog boardId="board-1" stages={[]} />);
  await user.click(screen.getByRole("button", { name: "Autonomia" }));
  return user;
}

beforeEach(() => {
  state.profile = { id: "admin-1", tenant_id: "tenant-1", role: "admin" };
  state.feature = null;
  state.readError = null;
  state.writeError = null;
  state.eq.mockClear();
  state.upsert.mockReset().mockImplementation(async (row: { enabled: boolean }) => {
    if (!state.writeError) {
      state.feature = {
        enabled: row.enabled,
        enabled_at: row.enabled ? "2026-10-15T12:00:00Z" : null,
      };
    }
    return { error: state.writeError };
  });
});

describe("Agente de pipeline neste workspace", () => {
  it("nasce desligado, liga apenas o tenant atual e mostra o início informado pelo banco", async () => {
    const user = await openSettings();
    const toggle = await screen.findByRole("switch", {
      name: "Agente de pipeline neste workspace",
    });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    expect(state.upsert).toHaveBeenCalledWith(
      {
        tenant_id: "tenant-1",
        feature_key: "pipeline_agent",
        enabled: true,
        updated_by: "admin-1",
      },
      { onConflict: "tenant_id,feature_key" },
    );
    expect(state.eq).toHaveBeenCalledWith("tenant_id", "tenant-1");
    expect(state.eq).toHaveBeenCalledWith("feature_key", "pipeline_agent");
    expect(screen.getByText(/Ligado desde/).querySelector("time")).toHaveAttribute(
      "datetime",
      "2026-10-15T12:00:00Z",
    );
  });

  it("desliga sem enviar data forjada nem alterar outro tenant", async () => {
    state.feature = { enabled: true, enabled_at: "2026-10-15T12:00:00Z" };
    const user = await openSettings();
    const toggle = await screen.findByRole("switch", {
      name: "Agente de pipeline neste workspace",
    });
    await waitFor(() => expect(toggle).toBeChecked());
    await user.click(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(state.upsert).toHaveBeenCalledWith(
      {
        tenant_id: "tenant-1",
        feature_key: "pipeline_agent",
        enabled: false,
        updated_by: "admin-1",
      },
      { onConflict: "tenant_id,feature_key" },
    );
    expect(screen.queryByText(/Ligado desde/)).not.toBeInTheDocument();
  });

  it("não oferece escrita a atendente", async () => {
    state.profile.role = "agent";
    const user = await openSettings();
    const toggle = await screen.findByRole("switch", {
      name: "Agente de pipeline neste workspace",
    });
    expect(toggle).toBeDisabled();
    await user.click(toggle);
    expect(state.upsert).not.toHaveBeenCalled();
    expect(screen.getByText(/Apenas administradores/)).toBeInTheDocument();
  });

  it("falha de leitura não se apresenta como desligado nem permite sobrescrever configuração", async () => {
    state.readError = { message: "permission denied" };
    await openSettings();
    expect(await screen.findByText(/Não foi possível consultar o agente/)).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Agente de pipeline neste workspace" }),
    ).toBeDisabled();
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it("erro ao gravar mantém o estado confirmado pelo banco", async () => {
    state.writeError = { message: "Falha ao salvar configuração" };
    const user = await openSettings();
    const toggle = await screen.findByRole("switch", {
      name: "Agente de pipeline neste workspace",
    });
    await waitFor(() => expect(toggle).toBeEnabled());
    await user.click(toggle);
    expect(await screen.findByText("Falha ao salvar configuração")).toBeInTheDocument();
    expect(toggle).not.toBeChecked();
  });
});
