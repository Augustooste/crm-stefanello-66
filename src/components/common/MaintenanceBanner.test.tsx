import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { MaintenanceBanner } from "./MaintenanceBanner";

// Prefixo — a chave real inclui um hash da mensagem (ver dismissKey no componente).
const DISMISS_KEY_PREFIX = "maintenance-banner-dismissed";
const MESSAGE = "Manutenção programada hoje às 22h — o app pode ficar instável.";

describe("MaintenanceBanner", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("não renderiza nada quando a env var não está definida", async () => {
    vi.stubEnv("VITE_MAINTENANCE_MESSAGE", "");
    const { container } = render(<MaintenanceBanner />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("renderiza a mensagem quando a env var está definida", async () => {
    vi.stubEnv("VITE_MAINTENANCE_MESSAGE", MESSAGE);
    render(<MaintenanceBanner />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(MESSAGE)).toBeInTheDocument();
  });

  it("esconde o banner e persiste em sessionStorage ao clicar em dispensar", async () => {
    vi.stubEnv("VITE_MAINTENANCE_MESSAGE", MESSAGE);
    const user = userEvent.setup();
    render(<MaintenanceBanner />);

    await user.click(await screen.findByRole("button", { name: /dispensar aviso/i }));

    expect(Object.keys(sessionStorage).some((k) => k.startsWith(DISMISS_KEY_PREFIX))).toBe(true);
    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  it("mostra de novo em uma nova sessão, quando a flag não está no sessionStorage", async () => {
    vi.stubEnv("VITE_MAINTENANCE_MESSAGE", MESSAGE);
    const user = userEvent.setup();
    const { unmount } = render(<MaintenanceBanner />);

    await user.click(await screen.findByRole("button", { name: /dispensar aviso/i }));
    unmount();

    // Mesma sessão: a flag persiste no sessionStorage, então um novo mount continua escondido.
    render(<MaintenanceBanner />);
    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    // Nova sessão: sessionStorage não guarda a flag (diferente do localStorage do ConsentModal).
    sessionStorage.clear();
    render(<MaintenanceBanner />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("reaparece na mesma sessão quando a mensagem muda (chave derivada do conteúdo)", async () => {
    const MESSAGE_B = "Nova janela de manutenção às 23h — pode haver instabilidade.";
    vi.stubEnv("VITE_MAINTENANCE_MESSAGE", MESSAGE);
    const user = userEvent.setup();
    const { unmount } = render(<MaintenanceBanner />);

    await user.click(await screen.findByRole("button", { name: /dispensar aviso/i }));
    unmount();

    vi.stubEnv("VITE_MAINTENANCE_MESSAGE", MESSAGE_B);
    render(<MaintenanceBanner />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(MESSAGE_B)).toBeInTheDocument();
  });
});
