import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile } from "@/lib/api/session";
import { __resetAppearanceStoreForTests, setSkin } from "@/lib/useAppearance";
import { parseAppearance, useAppearanceSync } from "@/lib/useAppearanceSync";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: vi.fn(() => Promise.resolve({ data: null, error: null })) },
}));
vi.mock("@/lib/api/session", () => ({ useCurrentProfile: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const useCurrentProfileMock = vi.mocked(useCurrentProfile);
const rpc = vi.mocked(supabase.rpc);

afterEach(() => {
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-skin");
  document.documentElement.removeAttribute("data-theme");
  localStorage.clear();
  __resetAppearanceStoreForTests();
  vi.clearAllMocks();
});

describe("parseAppearance", () => {
  it("aceita só o par completo e conhecido", () => {
    expect(parseAppearance({ theme: "light", skin: "profundo" })).toEqual({
      theme: "light",
      skin: "profundo",
    });
    expect(parseAppearance({ theme: "light" })).toBeNull();
    expect(parseAppearance({ theme: "sepia", skin: "clean" })).toBeNull();
    expect(parseAppearance({ theme: "dark", skin: "eletrico" })).toBeNull();
    expect(parseAppearance(null)).toBeNull();
  });
});

describe("useAppearanceSync", () => {
  it("aplica no <html> a preferência salva no perfil", async () => {
    useCurrentProfileMock.mockReturnValue({
      data: { id: "u1", appearance: { theme: "light", skin: "profundo" } },
    } as ReturnType<typeof useCurrentProfile>);

    renderHook(() => useAppearanceSync());

    await waitFor(() =>
      expect(document.documentElement.getAttribute("data-skin")).toBe("profundo"),
    );
    // Aplicar o que veio do banco não pode disparar escrita de volta.
    expect(rpc).not.toHaveBeenCalled();
  });

  it("grava no perfil quando o usuário troca depois da sessão carregar", async () => {
    useCurrentProfileMock.mockReturnValue({
      data: { id: "u1", appearance: { theme: "dark", skin: "clean" } },
    } as ReturnType<typeof useCurrentProfile>);

    renderHook(() => useAppearanceSync());
    await waitFor(() => expect(document.documentElement.getAttribute("data-skin")).toBeNull());

    act(() => setSkin("power"));

    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("set_appearance_preference", {
        p_theme: "dark",
        p_skin: "power",
      }),
    );
  });

  it("não grava enquanto o perfil não chegou", () => {
    useCurrentProfileMock.mockReturnValue({ data: undefined } as ReturnType<
      typeof useCurrentProfile
    >);

    renderHook(() => useAppearanceSync());

    expect(rpc).not.toHaveBeenCalled();
  });
});
