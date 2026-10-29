import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UseQueryResult } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  useActivePlugins,
  useTogglePlugin,
  type useTogglePlugin as UseTogglePluginType,
} from "@/lib/api/plugins";
import {
  useTenantIntegrations,
  useTenantChannels,
  type TenantIntegrationRow,
  type ChannelRow,
} from "@/lib/api/integrations";
import { useIntegrationHealthAlerts, useTestIntegration } from "@/lib/api/integration-health";
import {
  useIntegrationsCatalog,
  useVisibleIntegrationsCatalog,
  type CatalogRow,
} from "@/components/integrations/IntegrationCard";
import { renderWithQueryClient } from "@/test/render";
import { PluginsTab } from "./PluginsTab";

vi.mock("@/lib/api/plugins", () => ({
  useActivePlugins: vi.fn(),
  useTogglePlugin: vi.fn(),
}));
vi.mock("@/lib/api/integrations", () => ({
  useTenantIntegrations: vi.fn(),
  useTenantChannels: vi.fn(),
  // ApifyCostsCard (renderizado dentro do PluginsTab) consome este hook —
  // sem o stub, todo teste deste arquivo quebra na renderização.
  useApifyEnrichmentRuns: vi.fn(() => ({ data: [], isLoading: false })),
}));
vi.mock("@/lib/api/integration-health", () => ({
  useIntegrationHealthAlerts: vi.fn(() => ({ data: [] })),
  useTestIntegration: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));
vi.mock("@/components/integrations/IntegrationCard", () => ({
  useIntegrationsCatalog: vi.fn(),
  useVisibleIntegrationsCatalog: vi.fn(),
  isIntegrationHidden: (slug: string) => slug === "apify",
  IntegrationCard: ({
    catalog,
    openRequested,
  }: {
    catalog: { slug: string; name: string };
    openRequested?: boolean;
  }) => (
    <div
      data-testid={`integration-${catalog.slug}`}
      data-open-requested={openRequested ? "true" : "false"}
    >
      {catalog.name}
    </div>
  ),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

type UseQueryLike<T> = { data?: T; isLoading: boolean; error?: unknown };

function asQueryResult<T>(partial: UseQueryLike<T>): UseQueryResult<T, Error> {
  return partial as unknown as UseQueryResult<T, Error>;
}

function mockIntegrationsQueries(
  overrides: {
    catalog?: UseQueryLike<CatalogRow[]>;
    tenant?: UseQueryLike<TenantIntegrationRow[]>;
    channels?: UseQueryLike<ChannelRow[]>;
  } = {},
) {
  vi.mocked(useVisibleIntegrationsCatalog).mockReturnValue(
    asQueryResult<CatalogRow[]>({ isLoading: false, data: [], ...overrides.catalog }),
  );
  // IntegrationStatusTable é filha do PluginsTab e lê o catálogo NÃO filtrado
  // (ocultar slug não pode apagar a tela de diagnóstico de canal já conectado).
  vi.mocked(useIntegrationsCatalog).mockReturnValue(
    asQueryResult<CatalogRow[]>({ isLoading: false, data: [], ...overrides.catalog }),
  );
  vi.mocked(useTenantIntegrations).mockReturnValue(
    asQueryResult<TenantIntegrationRow[]>({ isLoading: false, data: [], ...overrides.tenant }),
  );
  vi.mocked(useTenantChannels).mockReturnValue(
    asQueryResult<ChannelRow[]>({ isLoading: false, data: [], ...overrides.channels }),
  );
}

function mockPlugins(active: string[] = []) {
  vi.mocked(useActivePlugins).mockReturnValue(active);
  vi.mocked(useTogglePlugin).mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof UseTogglePluginType>);
}

function mockHealthAlerts(slugs: string[] = []) {
  vi.mocked(useIntegrationHealthAlerts).mockReturnValue({
    data: slugs.map((slug) => ({
      slug,
      severity: "error",
      reason_code: "integration_error",
      human_message: "Credenciais inválidas",
      failures_15m: 3,
      last_error: "Credenciais inválidas",
      last_check_at: null,
    })),
  } as ReturnType<typeof useIntegrationHealthAlerts>);
  vi.mocked(useTestIntegration).mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof useTestIntegration>);
}

describe("PluginsTab (aba 'Integrações e Plugins' em Configurações)", () => {
  describe("Plugins do nicho", () => {
    it("mostra o catálogo de plugins com o estado ativo/inativo correto", () => {
      mockPlugins(["agenda"]);
      mockIntegrationsQueries();
      renderWithQueryClient(<PluginsTab />);

      expect(screen.getByText("Plugins do nicho")).toBeInTheDocument();
      expect(screen.getByLabelText("Agenda")).toBeChecked();
      expect(screen.getByLabelText("Catálogo (produtos/serviços)")).not.toBeChecked();
    });

    it("alterna um plugin e mostra toast de sucesso", async () => {
      mockPlugins([]);
      const toggle = { mutate: vi.fn(), isPending: false };
      vi.mocked(useTogglePlugin).mockReturnValue(
        toggle as unknown as ReturnType<typeof UseTogglePluginType>,
      );
      mockIntegrationsQueries();
      const user = userEvent.setup();
      renderWithQueryClient(<PluginsTab />);

      await user.click(screen.getByLabelText("Agenda"));

      expect(toggle.mutate).toHaveBeenCalledWith(
        { slug: "agenda", active: true },
        expect.anything(),
      );
    });

    it("mostra toast de erro quando falha ao atualizar um plugin", async () => {
      mockPlugins([]);
      const toggle = {
        mutate: vi.fn((_vars: unknown, opts?: { onError?: (e: Error) => void }) =>
          opts?.onError?.(new Error("Falha ao alternar")),
        ),
        isPending: false,
      };
      vi.mocked(useTogglePlugin).mockReturnValue(
        toggle as unknown as ReturnType<typeof UseTogglePluginType>,
      );
      mockIntegrationsQueries();
      const user = userEvent.setup();
      renderWithQueryClient(<PluginsTab />);

      await user.click(screen.getByLabelText("Agenda"));
      expect(toast.error).toHaveBeenCalledWith("Falha ao alternar");
    });
  });

  describe("Canais e integrações (antiga rota /integracoes)", () => {
    it("mostra placeholders de loading enquanto catálogo/integrações carregam", () => {
      mockPlugins([]);
      mockIntegrationsQueries({
        catalog: { isLoading: true, data: undefined },
        tenant: { isLoading: true, data: undefined },
        channels: { isLoading: true, data: undefined },
      });

      renderWithQueryClient(<PluginsTab />);
      expect(screen.getByText("Canais e integrações")).toBeInTheDocument();
      expect(document.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
    });

    it("mostra mensagem de erro quando o catálogo falha", () => {
      mockPlugins([]);
      mockIntegrationsQueries({ catalog: { isLoading: false, error: new Error("falhou") } });

      renderWithQueryClient(<PluginsTab />);
      expect(screen.getByText("Não foi possível carregar as integrações.")).toBeInTheDocument();
    });

    it("lista as integrações do catálogo", () => {
      mockPlugins([]);
      mockIntegrationsQueries({
        catalog: { isLoading: false, data: [{ slug: "whatsapp", name: "WhatsApp" } as CatalogRow] },
      });

      renderWithQueryClient(<PluginsTab />);
      expect(screen.getByTestId("integration-whatsapp")).toHaveTextContent("WhatsApp");
    });

    it('botão "Abrir integração" do alerta abre o card correspondente', async () => {
      mockPlugins([]);
      mockHealthAlerts(["elevenlabs"]);
      mockIntegrationsQueries({
        catalog: {
          isLoading: false,
          data: [{ slug: "elevenlabs", name: "ElevenLabs", available: true } as CatalogRow],
        },
      });
      const user = userEvent.setup();

      renderWithQueryClient(<PluginsTab />);

      await user.click(screen.getByRole("button", { name: /Abrir integração/i }));

      expect(screen.getByTestId("integration-elevenlabs")).toHaveAttribute(
        "data-open-requested",
        "true",
      );
    });

    it('botão "Abrir integração" mostra feedback quando o slug não está visível', async () => {
      mockPlugins([]);
      mockHealthAlerts(["zapi"]);
      mockIntegrationsQueries({ catalog: { isLoading: false, data: [] } });
      const user = userEvent.setup();

      renderWithQueryClient(<PluginsTab />);

      await user.click(screen.getByRole("button", { name: /Abrir integração/i }));

      expect(toast.error).toHaveBeenCalledWith(
        "Integração não encontrada ou indisponível nesta tela.",
      );
    });

    it("monta o mapa de integrações do tenant por slug quando já existem conexões", () => {
      mockPlugins([]);
      mockIntegrationsQueries({
        catalog: { isLoading: false, data: [{ slug: "whatsapp", name: "WhatsApp" } as CatalogRow] },
        tenant: {
          isLoading: false,
          data: [
            {
              slug: "whatsapp",
              status: "active",
              config: null,
              connected_at: "2026-01-01T00:00:00.000Z",
              last_check_at: null,
              last_error: null,
              webhook_token: null,
            },
          ],
        },
        channels: {
          isLoading: false,
          data: [
            {
              id: "ch1",
              provider_slug: "whatsapp",
              status: "connected",
              config: null,
              webhook_token: "tok-ch1",
              qr_code: null,
              webhook_health: "ok",
              last_connected_at: "2026-01-01T00:00:00.000Z",
              status_message: null,
            },
          ],
        },
      });

      renderWithQueryClient(<PluginsTab />);
      expect(screen.getByTestId("integration-whatsapp")).toHaveTextContent("WhatsApp");
    });
  });
});
