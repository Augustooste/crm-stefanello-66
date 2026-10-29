import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ManyChatSetupPanel } from "./ManyChatSetupPanel";
import { ConnectDialog, type CatalogRow } from "./IntegrationCard";
import { getChecklist } from "./checklists";
import { friendlyIntegrationError } from "@/lib/integrations/friendly-errors";
import { getWizard } from "@/lib/integrations/wizards/registry";
import {
  FULL_CONTACT_DATA_PLACEHOLDER,
  isManyChatSlug,
  manyChatRequestTemplate,
} from "@/lib/integrations/manychat";
import type { ChannelRow, TenantIntegrationRow } from "@/lib/api/integrations";

const invokeMock = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(),
    functions: { invoke: (...args: unknown[]) => invokeMock(...args) },
  },
}));
vi.mock("@/lib/api/session", () => ({ useCurrentProfile: () => ({ data: null }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const CATALOG: CatalogRow = {
  slug: "manychat-instagram",
  name: "ManyChat — Instagram",
  description: "",
  icon: "message-circle",
  required_secrets: [{ key: "api_key", label: "API Key do ManyChat", help: "", type: "password" }],
  setup_steps: [],
  available: true,
};

const CHANNEL = {
  id: "11111111-2222-4333-8444-555555555555",
  provider_slug: "manychat-instagram",
  status: "connected",
  config: {},
  webhook_token: "tok",
  qr_code: null,
  webhook_health: "unknown",
  last_connected_at: null,
  status_message: null,
} as ChannelRow;

const ACTIVE = { slug: "manychat-instagram", status: "active", config: {} } as TenantIntegrationRow;

beforeEach(() => invokeMock.mockReset());

describe("ManyChat — helpers", () => {
  it("reconhece só os três slugs", () => {
    expect(isManyChatSlug("manychat-whatsapp")).toBe(true);
    expect(isManyChatSlug("manychat")).toBe(false);
    expect(isManyChatSlug(null)).toBe(false);
  });

  it("modelo do External Request é JSON válido depois de trocar o marcador", () => {
    const template = manyChatRequestTemplate("manychat-instagram");
    const filled = template.replace(FULL_CONTACT_DATA_PLACEHOLDER, '{"key":"user:1"}');
    expect(JSON.parse(filled)).toEqual({
      channel: "instagram",
      event_type: "message.received",
      contact: { key: "user:1" },
    });
  });

  it("wizard existe para as três superfícies e pede só a API Key", () => {
    for (const slug of ["manychat-whatsapp", "manychat-instagram", "manychat-messenger"]) {
      const fields = getWizard(slug)?.steps.flatMap((s) => s.fields);
      expect(fields).toEqual(["api_key"]);
    }
  });

  it("checklist não marca primeiro evento sem webhook_health ok", () => {
    const pending = getChecklist("manychat-instagram", { channel: CHANNEL, tenant: ACTIVE });
    expect(pending?.items.find((i) => i.key === "first-event")?.state).toBe("pending");
    expect(pending?.items.find((i) => i.key === "api-key")?.state).toBe("ok");
    const ok = getChecklist("manychat-instagram", {
      channel: { ...CHANNEL, webhook_health: "ok" },
      tenant: ACTIVE,
    });
    expect(ok?.items.every((i) => i.state === "ok")).toBe(true);
  });

  it("erros amigáveis específicos", () => {
    expect(
      friendlyIntegrationError("manychat-whatsapp", "O ManyChat recusou: mais de 24h").message,
    ).toMatch(/24h/);
    expect(
      friendlyIntegrationError("manychat-whatsapp", "API Key do ManyChat inválida ou revogada.")
        .message,
    ).toMatch(/Settings > API/);
    expect(friendlyIntegrationError("manychat-messenger", "HTTP 429").message).toMatch(/limitando/);
  });
});

describe("ManyChatSetupPanel", () => {
  it("sem segredo recém-gerado, não mostra valor nenhum", () => {
    wrap(<ManyChatSetupPanel slug="manychat-instagram" revealedSecret={null} />);
    expect(screen.queryByTestId("manychat-secret")).toBeNull();
    expect(screen.getByTestId("manychat-secret-hidden")).toBeTruthy();
    expect(screen.getByTestId("manychat-template").textContent).toContain('"channel": "instagram"');
    expect(screen.getAllByText("x-webhook-secret", { selector: "code" }).length).toBeGreaterThan(0);
  });

  it("gerar novo segredo chama rotate e exibe o valor uma vez", async () => {
    invokeMock.mockResolvedValue({
      data: { ok: true, webhook_secret: "novo-segredo" },
      error: null,
    });
    wrap(<ManyChatSetupPanel slug="manychat-instagram" revealedSecret={null} />);
    await userEvent.click(screen.getByRole("button", { name: /Gerar novo segredo/ }));
    await waitFor(() =>
      expect(screen.getByTestId("manychat-secret").textContent).toBe("novo-segredo"),
    );
    expect(invokeMock).toHaveBeenCalledWith("integration-connect", {
      body: { action: "rotate_webhook_secret", slug: "manychat-instagram" },
    });
  });
});

describe("ConnectDialog — ManyChat", () => {
  it("canal já conectado abre em gerenciamento com URL, sem revelar segredo", () => {
    wrap(
      <ConnectDialog
        open
        onOpenChange={() => {}}
        catalog={CATALOG}
        tenant={ACTIVE}
        channel={CHANNEL}
      />,
    );
    expect(screen.getByTestId("manychat-setup")).toBeTruthy();
    expect(screen.queryByTestId("manychat-secret")).toBeNull();
    expect(screen.getByText(/messaging-webhook\/manychat-instagram\//)).toBeTruthy();
  });

  it("conectar mostra o segredo devolvido pelo servidor", async () => {
    invokeMock.mockResolvedValue({
      data: { ok: true, webhook_secret: "segredo-uma-vez" },
      error: null,
    });
    wrap(
      <ConnectDialog open onOpenChange={() => {}} catalog={CATALOG} tenant={null} channel={null} />,
    );
    await userEvent.type(screen.getByLabelText("API Key do ManyChat"), "mc-key");
    // Wizard: avança até o passo final e envia.
    for (let i = 0; i < 3; i++) {
      const next = screen.queryByRole("button", { name: /Próximo|Testar e conectar|Conectar/ });
      if (!next) break;
      await userEvent.click(next);
      if (invokeMock.mock.calls.length > 0) break;
    }
    await waitFor(() =>
      expect(screen.getByTestId("manychat-secret").textContent).toBe("segredo-uma-vez"),
    );
    expect(invokeMock.mock.calls[0][1]).toEqual({
      body: { action: "connect", slug: "manychat-instagram", values: { api_key: "mc-key" } },
    });
  });
});
