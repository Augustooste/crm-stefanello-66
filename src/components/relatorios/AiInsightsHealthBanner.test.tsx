import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { AiInsightsHealthBanner } from "./AiInsightsHealthBanner";
import { useAiInsightsFailureAlert } from "@/lib/api/insights-health";
import { renderWithQueryClient } from "@/test/render";

vi.mock("@/lib/api/insights-health", () => ({
  useAiInsightsFailureAlert: vi.fn(),
}));

function mockAlert(data: unknown, extras: Partial<{ isFetching: boolean }> = {}) {
  vi.mocked(useAiInsightsFailureAlert).mockReturnValue({
    data,
    isFetching: extras.isFetching ?? false,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useAiInsightsFailureAlert>);
}

describe("AiInsightsHealthBanner", () => {
  afterEach(() => vi.clearAllMocks());

  it("não renderiza quando ainda não há dados", () => {
    mockAlert(undefined);
    const { container } = renderWithQueryClient(<AiInsightsHealthBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("não renderiza quando a contagem está abaixo do limite", () => {
    mockAlert({ count: 2, threshold: 3, windowMinutes: 15, latest: [] });
    const { container } = renderWithQueryClient(<AiInsightsHealthBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renderiza alerta quando a contagem atinge o limite", () => {
    mockAlert({ count: 3, threshold: 3, windowMinutes: 15, latest: [] });
    renderWithQueryClient(<AiInsightsHealthBanner />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/3 falhas/i)).toBeInTheDocument();
    expect(screen.getByText(/15 minutos/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /verificar/i })).toBeEnabled();
  });

  it("desabilita o botão enquanto refetch está em andamento", () => {
    mockAlert({ count: 5, threshold: 3, windowMinutes: 15, latest: [] }, { isFetching: true });
    renderWithQueryClient(<AiInsightsHealthBanner />);
    expect(screen.getByRole("button", { name: /verificando/i })).toBeDisabled();
  });
});
