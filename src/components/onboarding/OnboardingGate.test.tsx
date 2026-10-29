import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OnboardingGate } from "./OnboardingGate";

const useCurrentProfileMock = vi.fn();
const useTenantOnboardingMock = vi.fn();

vi.mock("@/lib/api/session", () => ({
  useCurrentProfile: () => useCurrentProfileMock(),
}));

vi.mock("@/lib/api/onboarding", () => ({
  useTenantOnboarding: () => useTenantOnboardingMock(),
}));

const consentAcknowledgedMock = vi.fn(() => true);

vi.mock("@/components/common/ConsentModal", () => ({
  useConsentAcknowledged: () => consentAcknowledgedMock(),
}));

vi.mock("./OnboardingWizard", () => ({
  OnboardingWizard: ({
    open,
    onOpenChange,
  }: {
    open: boolean;
    onOpenChange: (v: boolean) => void;
  }) => (
    <div data-testid="wizard" data-open={open}>
      <button onClick={() => onOpenChange(false)}>Fechar wizard</button>
    </div>
  ),
}));

describe("OnboardingGate", () => {
  beforeEach(() => {
    useCurrentProfileMock.mockReset();
    useTenantOnboardingMock.mockReset();
    consentAcknowledgedMock.mockReturnValue(true);
  });

  it("não abre enquanto o aviso de privacidade não for aceito", () => {
    consentAcknowledgedMock.mockReturnValue(false);
    useCurrentProfileMock.mockReturnValue({ data: { id: "u1", role: "admin" } });
    useTenantOnboardingMock.mockReturnValue({
      data: { id: "t1", onboarded_at: null },
      isLoading: false,
    });

    render(<OnboardingGate />);

    expect(screen.queryByTestId("wizard")).not.toBeInTheDocument();
  });

  it("não renderiza nada quando o usuário não é admin", () => {
    useCurrentProfileMock.mockReturnValue({ data: { role: "agent" } });
    useTenantOnboardingMock.mockReturnValue({
      data: { id: "t1", onboarded_at: null },
      isLoading: false,
    });

    const { container } = render(<OnboardingGate />);

    expect(container).toBeEmptyDOMElement();
  });

  it("não renderiza nada enquanto a query de onboarding está carregando", () => {
    useCurrentProfileMock.mockReturnValue({ data: { role: "admin" } });
    useTenantOnboardingMock.mockReturnValue({ data: undefined, isLoading: true });

    const { container } = render(<OnboardingGate />);

    expect(container).toBeEmptyDOMElement();
  });

  it("não renderiza nada quando o tenant já está onboarded", () => {
    useCurrentProfileMock.mockReturnValue({ data: { role: "admin" } });
    useTenantOnboardingMock.mockReturnValue({
      data: { id: "t1", onboarded_at: "2026-01-01T00:00:00Z" },
      isLoading: false,
    });

    const { container } = render(<OnboardingGate />);

    expect(container).toBeEmptyDOMElement();
  });

  it("abre automaticamente o wizard quando admin e tenant precisa de onboarding", async () => {
    useCurrentProfileMock.mockReturnValue({ data: { role: "admin" } });
    useTenantOnboardingMock.mockReturnValue({
      data: { id: "t1", onboarded_at: null },
      isLoading: false,
    });

    render(<OnboardingGate />);

    expect(await screen.findByTestId("wizard")).toHaveAttribute("data-open", "true");
  });

  it("fecha o wizard e lembra a dispensa para o mesmo tenant/estado", async () => {
    const user = userEvent.setup();
    useCurrentProfileMock.mockReturnValue({ data: { role: "admin" } });
    useTenantOnboardingMock.mockReturnValue({
      data: { id: "t1", onboarded_at: null },
      isLoading: false,
    });

    const { rerender } = render(<OnboardingGate />);
    expect(await screen.findByTestId("wizard")).toHaveAttribute("data-open", "true");

    await user.click(screen.getByText("Fechar wizard"));
    expect(screen.getByTestId("wizard")).toHaveAttribute("data-open", "false");

    // Rerender com o mesmo tenant/estado — não deve reabrir sozinho.
    rerender(<OnboardingGate />);
    expect(screen.getByTestId("wizard")).toHaveAttribute("data-open", "false");
  });

  it("reabre automaticamente quando o dismissKey muda (novo streak de onboarding)", async () => {
    const user = userEvent.setup();
    useCurrentProfileMock.mockReturnValue({ data: { role: "admin" } });
    useTenantOnboardingMock.mockReturnValue({
      data: { id: "t1", onboarded_at: null },
      isLoading: false,
    });

    const { rerender } = render(<OnboardingGate />);
    expect(await screen.findByTestId("wizard")).toHaveAttribute("data-open", "true");

    await user.click(screen.getByText("Fechar wizard"));
    expect(screen.getByTestId("wizard")).toHaveAttribute("data-open", "false");

    // Simula um novo streak de onboarding (outro tenant/estado) — o gate deve reabrir.
    useTenantOnboardingMock.mockReturnValue({
      data: { id: "t2", onboarded_at: null },
      isLoading: false,
    });
    rerender(<OnboardingGate />);

    expect(await screen.findByTestId("wizard")).toHaveAttribute("data-open", "true");
  });

  it("usa 'never' como chave de dispensa quando o tenant desaparece com o wizard já aberto", async () => {
    const user = userEvent.setup();
    useCurrentProfileMock.mockReturnValue({ data: { role: "admin" } });
    useTenantOnboardingMock.mockReturnValue({
      data: { id: "t1", onboarded_at: null },
      isLoading: false,
    });

    const { rerender } = render(<OnboardingGate />);
    expect(await screen.findByTestId("wizard")).toHaveAttribute("data-open", "true");

    // Tenant desaparece (ex.: query momentaneamente sem dado) enquanto o wizard segue aberto.
    useTenantOnboardingMock.mockReturnValue({ data: null, isLoading: false });
    rerender(<OnboardingGate />);
    expect(screen.getByTestId("wizard")).toHaveAttribute("data-open", "true");

    await user.click(screen.getByText("Fechar wizard"));

    // Sem tenant e com open=false, o gate deixa de renderizar o wizard.
    expect(screen.queryByTestId("wizard")).not.toBeInTheDocument();
  });
});
