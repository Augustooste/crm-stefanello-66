import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ConsentModal } from "./ConsentModal";

const useCurrentProfileMock = vi.fn();
vi.mock("@/lib/api/session", () => ({
  useCurrentProfile: () => useCurrentProfileMock(),
}));

const POLICY_VERSION = "2026-07-19";
const keyFor = (userId: string) => `lgpd-consent:${userId}:${POLICY_VERSION}`;

describe("ConsentModal", () => {
  beforeEach(() => {
    localStorage.clear();
    useCurrentProfileMock.mockReset();
    useCurrentProfileMock.mockReturnValue({ data: { id: "user-1" } });
  });

  it("não mostra o modal enquanto o perfil ainda não carregou", () => {
    useCurrentProfileMock.mockReturnValue({ data: undefined });
    render(<ConsentModal />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("mostra o modal quando o consentimento ainda não foi reconhecido", async () => {
    render(<ConsentModal />);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Entendi" })).toBeInTheDocument();
  });

  it("não mostra o modal quando o usuário já reconheceu esta versão", () => {
    localStorage.setItem(keyFor("user-1"), "true");
    render(<ConsentModal />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("mostra o modal para o usuário B mesmo com o A já tendo aceitado no mesmo navegador", async () => {
    localStorage.setItem(keyFor("user-1"), "true");
    useCurrentProfileMock.mockReturnValue({ data: { id: "user-2" } });
    render(<ConsentModal />);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("volta a mostrar o modal quando a versão da política sobe (aceite antigo não vale)", async () => {
    localStorage.setItem("lgpd-consent:user-1:2000-01-01", "true");
    render(<ConsentModal />);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("mostra o modal (fail-closed) quando localStorage lança exceção (Safari private mode)", async () => {
    const getItemSpy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    render(<ConsentModal />);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    getItemSpy.mockRestore();
  });

  it("fecha e persiste o reconhecimento na chave do usuário + versão ao clicar em Entendi", async () => {
    const user = userEvent.setup();
    render(<ConsentModal />);

    await user.click(await screen.findByRole("button", { name: "Entendi" }));

    expect(localStorage.getItem(keyFor("user-1"))).toBe("true");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});
