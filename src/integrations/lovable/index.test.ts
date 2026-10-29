import { afterEach, describe, expect, it, vi } from "vitest";

const signInWithOAuthMock = vi.fn();
const setSessionMock = vi.fn();

vi.mock("@lovable.dev/cloud-auth-js", () => ({
  createLovableAuth: () => ({ signInWithOAuth: signInWithOAuthMock }),
}));

vi.mock("../supabase/client", () => ({
  supabase: { auth: { setSession: setSessionMock } },
}));

const { lovable } = await import("./index");

describe("lovable.auth.signInWithOAuth", () => {
  afterEach(() => {
    signInWithOAuthMock.mockReset();
    setSessionMock.mockReset();
  });

  it("repassa opções para o provider e retorna direto quando houve redirecionamento", async () => {
    signInWithOAuthMock.mockResolvedValue({ redirected: true });

    const result = await lovable.auth.signInWithOAuth("google", {
      redirect_uri: "https://app.test/callback",
      extraParams: { flow: "signup" },
    });

    expect(signInWithOAuthMock).toHaveBeenCalledWith("google", {
      redirect_uri: "https://app.test/callback",
      extraParams: { flow: "signup" },
    });
    expect(result).toEqual({ redirected: true });
    expect(setSessionMock).not.toHaveBeenCalled();
  });

  it("retorna o erro do provider sem tentar abrir sessão no supabase", async () => {
    const providerError = new Error("provider indisponível");
    signInWithOAuthMock.mockResolvedValue({ error: providerError });

    const result = await lovable.auth.signInWithOAuth("apple");

    expect(result).toEqual({ error: providerError });
    expect(setSessionMock).not.toHaveBeenCalled();
  });

  it("chama opts sem valores quando nenhuma opção é passada", async () => {
    signInWithOAuthMock.mockResolvedValue({ redirected: true });

    await lovable.auth.signInWithOAuth("microsoft");

    expect(signInWithOAuthMock).toHaveBeenCalledWith("microsoft", {
      redirect_uri: undefined,
      extraParams: {},
    });
  });

  it("define a sessão do supabase com os tokens e devolve o resultado em caso de sucesso", async () => {
    const tokens = { access_token: "a", refresh_token: "b" };
    signInWithOAuthMock.mockResolvedValue({ tokens });
    setSessionMock.mockResolvedValue({ data: {}, error: null });

    const result = await lovable.auth.signInWithOAuth("lovable");

    expect(setSessionMock).toHaveBeenCalledWith(tokens);
    expect(result).toEqual({ tokens });
  });

  it("captura uma rejeição do setSession que já é um Error e a devolve como { error }", async () => {
    signInWithOAuthMock.mockResolvedValue({ tokens: {} });
    const setSessionError = new Error("sessão inválida");
    setSessionMock.mockRejectedValue(setSessionError);

    const result = await lovable.auth.signInWithOAuth("google");

    expect(result).toEqual({ error: setSessionError });
  });

  it("envolve uma rejeição não-Error do setSession em um novo Error", async () => {
    signInWithOAuthMock.mockResolvedValue({ tokens: {} });
    setSessionMock.mockRejectedValue("motivo-string");

    const result = await lovable.auth.signInWithOAuth("apple");

    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe("motivo-string");
  });
});
