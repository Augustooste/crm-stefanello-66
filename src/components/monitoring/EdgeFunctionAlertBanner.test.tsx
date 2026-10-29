import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";

import { EdgeFunctionAlertBanner } from "./EdgeFunctionAlertBanner";
import { renderWithQueryClient } from "@/test/render";
import { useEdgeFunctionErrorAlerts } from "@/lib/api/edge-health";

vi.mock("@/lib/api/edge-health", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api/edge-health")>("@/lib/api/edge-health");
  return { ...actual, useEdgeFunctionErrorAlerts: vi.fn() };
});

const mocked = vi.mocked(useEdgeFunctionErrorAlerts);

function mockAlerts(data: unknown[]) {
  mocked.mockReturnValue({
    data,
    isFetching: false,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useEdgeFunctionErrorAlerts>);
}

const ALERT = {
  function_name: "messaging-webhook",
  operation: "messaging.webhook.inbound",
  severity: "error" as const,
  errors_15m: 5,
  errors_prev_15m: 1,
  spike: true,
  last_error_code: "inbound_failed",
  last_message: "falha ao processar inbound",
  last_at: "2026-07-26T12:00:00.000Z",
};

describe("EdgeFunctionAlertBanner", () => {
  afterEach(() => vi.clearAllMocks());

  it("fica silencioso quando não há alertas", () => {
    mockAlerts([]);
    const { container } = renderWithQueryClient(<EdgeFunctionAlertBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lista a function, a contagem e o marcador de aumento", () => {
    mockAlerts([ALERT]);
    renderWithQueryClient(<EdgeFunctionAlertBanner />);
    expect(screen.getByTestId("edge-function-alert-banner")).toBeInTheDocument();
    expect(screen.getByText("messaging-webhook")).toBeInTheDocument();
    expect(screen.getByText("5 erros")).toBeInTheDocument();
    expect(screen.getByText("Aumento de erros")).toBeInTheDocument();
    expect(screen.getByText(/inbound_failed/)).toBeInTheDocument();
  });

  it("omite o marcador de aumento quando spike é falso", () => {
    mockAlerts([{ ...ALERT, spike: false, errors_15m: 1 }]);
    renderWithQueryClient(<EdgeFunctionAlertBanner />);
    expect(screen.getByText("1 erro")).toBeInTheDocument();
    expect(screen.queryByText("Aumento de erros")).not.toBeInTheDocument();
  });
});
