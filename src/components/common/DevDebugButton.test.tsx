import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";

import { DevDebugButton } from "./DevDebugButton";

const useCurrentProfileMock = vi.fn();

vi.mock("@/lib/api/session", () => ({
  useCurrentProfile: () => useCurrentProfileMock(),
}));

vi.mock("sonner", () => ({
  toast: {
    info: vi.fn(),
  },
}));

describe("DevDebugButton", () => {
  beforeEach(() => {
    useCurrentProfileMock.mockReset();
    vi.mocked(toast.info).mockReset();
    useCurrentProfileMock.mockReturnValue({
      data: { id: "user-1", tenant_id: "tenant-1", name: "Ana", role: "admin" },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renderiza o botão quando import.meta.env.DEV é true", () => {
    vi.stubEnv("DEV", true);

    render(<DevDebugButton />);

    expect(screen.getByRole("button", { name: "Informações técnicas" })).toBeInTheDocument();
  });

  it("não renderiza nada quando import.meta.env.DEV é false", () => {
    vi.stubEnv("DEV", false);

    const { container } = render(<DevDebugButton />);

    expect(container).toBeEmptyDOMElement();
  });

  it("loga o perfil atual e o tenant_id no console e mostra toast ao clicar", async () => {
    vi.stubEnv("DEV", true);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const user = userEvent.setup();
    const profile = { id: "user-1", tenant_id: "tenant-1", name: "Ana", role: "admin" as const };
    useCurrentProfileMock.mockReturnValue({ data: profile });

    render(<DevDebugButton />);
    await user.click(screen.getByRole("button", { name: "Informações técnicas" }));

    expect(logSpy).toHaveBeenCalledWith(
      "[DevDebugButton] profile:",
      profile,
      "tenant_id:",
      profile.tenant_id,
    );
    expect(toast.info).toHaveBeenCalledWith("Informações técnicas no console");
    logSpy.mockRestore();
  });
});
