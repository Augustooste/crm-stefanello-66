import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { InstallBanner } from "./InstallBanner";
import { useInstallPrompt } from "@/hooks/use-install-prompt";

vi.mock("@/hooks/use-install-prompt", () => ({
  useInstallPrompt: vi.fn(),
}));

const mockedUseInstallPrompt = vi.mocked(useInstallPrompt);

describe("InstallBanner", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("não renderiza nada quando não é instalável", () => {
    mockedUseInstallPrompt.mockReturnValue({ canInstall: false, promptInstall: vi.fn() });
    const { container } = render(<InstallBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renderiza o banner quando é instalável", () => {
    mockedUseInstallPrompt.mockReturnValue({ canInstall: true, promptInstall: vi.fn() });
    render(<InstallBanner />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Instalar app" })).toBeInTheDocument();
  });

  it("chama promptInstall ao clicar em Instalar app", async () => {
    const user = userEvent.setup();
    const promptInstall = vi.fn().mockResolvedValue(undefined);
    mockedUseInstallPrompt.mockReturnValue({ canInstall: true, promptInstall });
    render(<InstallBanner />);

    await user.click(screen.getByRole("button", { name: "Instalar app" }));
    expect(promptInstall).toHaveBeenCalledTimes(1);
  });

  it("esconde o banner e persiste dismissal ao clicar em dispensar", async () => {
    const user = userEvent.setup();
    mockedUseInstallPrompt.mockReturnValue({ canInstall: true, promptInstall: vi.fn() });
    render(<InstallBanner />);

    await user.click(screen.getByRole("button", { name: "Dispensar" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(localStorage.getItem("af_install_banner_dismissed_until")).not.toBeNull();
  });

  it("não reexibe o banner enquanto o dismissal de 7 dias não expira", () => {
    localStorage.setItem("af_install_banner_dismissed_until", String(Date.now() + 1000));
    mockedUseInstallPrompt.mockReturnValue({ canInstall: true, promptInstall: vi.fn() });
    render(<InstallBanner />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reexibe o banner quando o dismissal já expirou", () => {
    localStorage.setItem("af_install_banner_dismissed_until", String(Date.now() - 1000));
    mockedUseInstallPrompt.mockReturnValue({ canInstall: true, promptInstall: vi.fn() });
    render(<InstallBanner />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
