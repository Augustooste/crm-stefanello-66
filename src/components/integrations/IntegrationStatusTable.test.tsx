import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { IntegrationStatusTable } from "./IntegrationStatusTable";
import type { ChannelRow, TenantIntegrationRow } from "@/lib/api/integrations";

const tenantRows: TenantIntegrationRow[] = [
  {
    slug: "evolution",
    status: "active",
    last_error: null,
    last_check_at: new Date().toISOString(),
  } as TenantIntegrationRow,
];

let channelRows: ChannelRow[] = [];

vi.mock("@/lib/api/integrations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/integrations")>();
  return {
    ...actual,
    useTenantIntegrations: () => ({ data: tenantRows, isLoading: false }),
    useTenantChannels: () => ({ data: channelRows, isLoading: false }),
  };
});

vi.mock("./IntegrationCard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./IntegrationCard")>();
  return {
    ...actual,
    useIntegrationsCatalog: () => ({
      data: [{ slug: "evolution", name: "WhatsApp (Evolution Go)", available: true }],
      isLoading: false,
    }),
  };
});

vi.mock("@/lib/api/integration-health", () => ({
  useTestIntegration: () => ({ isPending: false, variables: undefined, mutate: vi.fn() }),
}));

function renderTable() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <IntegrationStatusTable />
    </QueryClientProvider>,
  );
}

describe("IntegrationStatusTable", () => {
  it("não mostra erro antigo do canal quando a integração está ativa e conectada", () => {
    channelRows = [
      {
        provider_slug: "evolution",
        status: "connected",
        webhook_health: "ok",
        status_message: "Evolution respondeu HTTP 401 em /instance/status.",
      } as ChannelRow,
    ];
    renderTable();
    expect(screen.getByText("Funcionando normalmente")).toBeInTheDocument();
    expect(screen.queryByText(/URL da API Evolution inválida/)).not.toBeInTheDocument();
  });

  it("mostra o detalhe quando o canal realmente está desconectado", () => {
    channelRows = [
      {
        provider_slug: "evolution",
        status: "disconnected",
        webhook_health: "broken",
        status_message: "Evolution respondeu HTTP 401 em /instance/status.",
      } as ChannelRow,
    ];
    renderTable();
    expect(screen.getByText(/recusou as credenciais/i)).toBeInTheDocument();
  });
});
