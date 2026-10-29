import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Session, User } from "@supabase/supabase-js";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable";
import { renderWithQueryClient } from "@/test/render";
import { navigateMock, routerOverrides } from "@/test/router-mocks";
import { Route } from "./auth";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { routerOverrides: overrides } = await import("@/test/router-mocks");
  return { ...actual, ...overrides() };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: vi.fn(),
    auth: {
      getSession: vi.fn(),
      onAuthStateChange: vi.fn(),
      signInWithPassword: vi.fn(),
      signUp: vi.fn(),
      resetPasswordForEmail: vi.fn(),
      updateUser: vi.fn(),
    },
  },
}));

vi.mock("@/integrations/lovable", () => ({
  lovable: { auth: { signInWithOAuth: vi.fn() } },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function fakeSession(): Session {
  return {
    user: { id: "u1" } as User,
    access_token: "token",
    refresh_token: "refresh",
    expires_in: 3600,
    token_type: "bearer",
  } as Session;
}

describe("beforeLoad de /auth", () => {
  it("redireciona para /app quando já existe sessão ativa", async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: { session: fakeSession() },
      error: null,
    } as Awaited<ReturnType<typeof supabase.auth.getSession>>);

    let caught: unknown;
    try {
      await Route.options.beforeLoad?.({} as never);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Response);
    expect((caught as Response & { options: { to: string } }).options.to).toBe("/app");
  });

  it("não redireciona quando não há sessão", async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: { session: null },
      error: null,
    } as Awaited<ReturnType<typeof supabase.auth.getSession>>);

    await expect(Route.options.beforeLoad?.({} as never)).resolves.toBeUndefined();
  });

  it("mantém a rota de atualização de senha quando a sessão do link existe", async () => {
    window.history.pushState({}, "", "/auth?mode=update");
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: { session: fakeSession() },
      error: null,
    } as Awaited<ReturnType<typeof supabase.auth.getSession>>);

    try {
      await expect(Route.options.beforeLoad?.({} as never)).resolves.toBeUndefined();
    } finally {
      window.history.pushState({}, "", "/auth");
    }
  });
});

describe("head de /auth", () => {
  it("define título e meta robots para não indexação", () => {
    const head = Route.options.head?.({} as never);

    expect(head).toEqual({
      meta: [{ title: "Entrar — CRM IA" }, { name: "robots", content: "noindex" }],
    });
  });
});

describe("página de autenticação", () => {
  const AuthPage = Route.options.component!;

  beforeEach(() => {
    navigateMock.mockClear();
    vi.mocked(supabase.rpc).mockReturnValue(
      Promise.resolve({ data: true, error: null }) as unknown as ReturnType<typeof supabase.rpc>,
    );
    vi.mocked(supabase.auth.onAuthStateChange).mockReturnValue({
      data: { subscription: { unsubscribe: vi.fn() } },
    } as unknown as ReturnType<typeof supabase.auth.onAuthStateChange>);
  });

  it("renderiza o formulário de login por padrão", async () => {
    renderWithQueryClient(<AuthPage />);
    expect(await screen.findByLabelText("E-mail")).toBeInTheDocument();
    expect(screen.getByLabelText("Senha")).toBeInTheDocument();
    expect(screen.queryByLabelText("Nome")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Entrar" })).toBeInTheDocument();
  });

  it("alterna para o modo de cadastro exibindo o campo Nome", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<AuthPage />);
    await screen.findByLabelText("E-mail");

    await user.click(screen.getByText("Não tem conta? Criar conta"));

    expect(screen.getByLabelText("Nome")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Criar conta" })).toBeInTheDocument();
  });

  it("efetua login chamando signInWithPassword com email e senha", async () => {
    const user = userEvent.setup();
    vi.mocked(supabase.auth.signInWithPassword).mockResolvedValue({
      data: { user: null, session: null },
      error: null,
    } as unknown as Awaited<ReturnType<typeof supabase.auth.signInWithPassword>>);

    renderWithQueryClient(<AuthPage />);
    await user.type(await screen.findByLabelText("E-mail"), "ana@exemplo.com");
    await user.type(screen.getByLabelText("Senha"), "123456");
    await user.click(screen.getByRole("button", { name: "Entrar" }));

    await waitFor(() =>
      expect(supabase.auth.signInWithPassword).toHaveBeenCalledWith({
        email: "ana@exemplo.com",
        password: "123456",
      }),
    );
  });

  it("mostra toast de erro quando o login falha", async () => {
    const user = userEvent.setup();
    vi.mocked(supabase.auth.signInWithPassword).mockResolvedValue({
      data: { user: null, session: null },
      error: Object.assign(new Error("Invalid login credentials"), {
        code: "invalid_credentials",
      }),
    } as unknown as Awaited<ReturnType<typeof supabase.auth.signInWithPassword>>);

    renderWithQueryClient(<AuthPage />);
    await user.type(await screen.findByLabelText("E-mail"), "ana@exemplo.com");
    await user.type(screen.getByLabelText("Senha"), "senhaerrada");
    await user.click(screen.getByRole("button", { name: "Entrar" }));

    // Erro cru em inglês do Supabase é traduzido para PT-BR antes do toast.
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("E-mail ou senha incorretos."));
  });

  it("aciona login com Google via lovable.auth.signInWithOAuth", async () => {
    const user = userEvent.setup();
    vi.mocked(lovable.auth.signInWithOAuth).mockResolvedValue({
      redirected: true,
    } as unknown as Awaited<ReturnType<typeof lovable.auth.signInWithOAuth>>);

    renderWithQueryClient(<AuthPage />);
    await user.click(await screen.findByRole("button", { name: "Entrar com Google" }));

    await waitFor(() =>
      expect(lovable.auth.signInWithOAuth).toHaveBeenCalledWith(
        "google",
        expect.objectContaining({ redirect_uri: expect.any(String) }),
      ),
    );
  });

  it("navega para /app quando onAuthStateChange emite uma sessão", async () => {
    type OnAuthStateChangeCallback = Parameters<typeof supabase.auth.onAuthStateChange>[0];
    let capturedCallback: OnAuthStateChangeCallback | undefined;
    vi.mocked(supabase.auth.onAuthStateChange).mockImplementation((callback) => {
      capturedCallback = callback;
      return {
        data: { subscription: { unsubscribe: vi.fn() } },
      } as unknown as ReturnType<typeof supabase.auth.onAuthStateChange>;
    });

    renderWithQueryClient(<AuthPage />);
    await screen.findByLabelText("E-mail");

    capturedCallback?.("SIGNED_IN", fakeSession());

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: "/app", replace: true }));
  });

  it("não navega quando onAuthStateChange emite sessão nula", async () => {
    type OnAuthStateChangeCallback = Parameters<typeof supabase.auth.onAuthStateChange>[0];
    let capturedCallback: OnAuthStateChangeCallback | undefined;
    vi.mocked(supabase.auth.onAuthStateChange).mockImplementation((callback) => {
      capturedCallback = callback;
      return {
        data: { subscription: { unsubscribe: vi.fn() } },
      } as unknown as ReturnType<typeof supabase.auth.onAuthStateChange>;
    });

    renderWithQueryClient(<AuthPage />);
    await screen.findByLabelText("E-mail");

    capturedCallback?.("SIGNED_OUT", null);

    expect(navigateMock).not.toHaveBeenCalledWith({ to: "/app" });
  });

  it("mantém o formulário de atualização após INITIAL_SESSION do link de recuperação", async () => {
    type OnAuthStateChangeCallback = Parameters<typeof supabase.auth.onAuthStateChange>[0];
    let capturedCallback: OnAuthStateChangeCallback | undefined;
    window.history.pushState({}, "", "/auth?mode=update");
    vi.mocked(supabase.auth.onAuthStateChange).mockImplementation((callback) => {
      capturedCallback = callback;
      return {
        data: { subscription: { unsubscribe: vi.fn() } },
      } as unknown as ReturnType<typeof supabase.auth.onAuthStateChange>;
    });

    try {
      renderWithQueryClient(<AuthPage />);
      expect(await screen.findByLabelText("Confirme a nova senha")).toBeInTheDocument();

      capturedCallback?.("INITIAL_SESSION", fakeSession());

      expect(navigateMock).not.toHaveBeenCalledWith({ to: "/app" });
      expect(screen.getByLabelText("Confirme a nova senha")).toBeInTheDocument();
    } finally {
      window.history.pushState({}, "", "/auth");
    }
  });

  it("cria conta chamando signUp com nome, email e senha", async () => {
    const user = userEvent.setup();
    vi.mocked(supabase.auth.signUp).mockResolvedValue({
      data: { user: null, session: null },
      error: null,
    } as unknown as Awaited<ReturnType<typeof supabase.auth.signUp>>);

    renderWithQueryClient(<AuthPage />);
    await user.click(await screen.findByText("Não tem conta? Criar conta"));

    await user.type(screen.getByLabelText("Nome"), "Ana Souza");
    await user.type(screen.getByLabelText("E-mail"), "ana@exemplo.com");
    await user.type(screen.getByLabelText("Senha"), "senha-de-teste");
    await user.click(screen.getByRole("button", { name: "Criar conta" }));

    await waitFor(() =>
      expect(supabase.auth.signUp).toHaveBeenCalledWith({
        email: "ana@exemplo.com",
        password: "senha-de-teste",
        options: {
          data: { name: "Ana Souza" },
          emailRedirectTo: `${window.location.origin}/auth`,
        },
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Conta criada. Verifique seu e-mail se necessário.");
  });

  it("bloqueia cadastro com senha fraca sem chamar signUp", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<AuthPage />);
    await user.click(await screen.findByText("Não tem conta? Criar conta"));

    await user.type(screen.getByLabelText("Nome"), "Ana Souza");
    await user.type(screen.getByLabelText("E-mail"), "ana@exemplo.com");
    await user.type(screen.getByLabelText("Senha"), "123456");
    await user.click(screen.getByRole("button", { name: "Criar conta" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(supabase.auth.signUp).not.toHaveBeenCalled();
  });

  it("inclui invite_token no cadastro quando presente na URL", async () => {
    const user = userEvent.setup();
    window.history.pushState({}, "", "/auth?invite=convite-abc123");
    vi.mocked(supabase.auth.signUp).mockResolvedValue({
      data: { user: null, session: null },
      error: null,
    } as unknown as Awaited<ReturnType<typeof supabase.auth.signUp>>);

    try {
      renderWithQueryClient(<AuthPage />);
      await user.click(await screen.findByText("Não tem conta? Criar conta"));

      await user.type(screen.getByLabelText("Nome"), "Ana Souza");
      await user.type(screen.getByLabelText("E-mail"), "ana@exemplo.com");
      await user.type(screen.getByLabelText("Senha"), "senha-de-teste");
      await user.click(screen.getByRole("button", { name: "Criar conta" }));

      await waitFor(() =>
        expect(supabase.auth.signUp).toHaveBeenCalledWith(
          expect.objectContaining({
            options: expect.objectContaining({
              data: { name: "Ana Souza", invite_token: "convite-abc123" },
            }),
          }),
        ),
      );
    } finally {
      window.history.pushState({}, "", "/auth");
    }
  });

  it("explica o convite quando o cadastro com invite_token falha com o 500 opaco", async () => {
    const user = userEvent.setup();
    window.history.pushState({}, "", "/auth?invite=convite-expirado");
    // O trigger handle_new_user aborta e o GoTrue devolve isto — medido contra o
    // GoTrue local em 10/08/2026.
    vi.mocked(supabase.auth.signUp).mockResolvedValue({
      data: { user: null, session: null },
      error: Object.assign(new Error("Database error saving new user"), {
        code: "unexpected_failure",
        status: 500,
      }),
    } as unknown as Awaited<ReturnType<typeof supabase.auth.signUp>>);

    try {
      renderWithQueryClient(<AuthPage />);
      await user.click(await screen.findByText("Não tem conta? Criar conta"));

      await user.type(screen.getByLabelText("Nome"), "Ana Souza");
      await user.type(screen.getByLabelText("E-mail"), "ana@exemplo.com");
      await user.type(screen.getByLabelText("Senha"), "senha-de-teste");
      await user.click(screen.getByRole("button", { name: "Criar conta" }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          "Não foi possível usar este convite. Ele pode ter expirado ou ter sido emitido para outro e-mail — peça um link novo a quem convidou.",
        ),
      );
    } finally {
      window.history.pushState({}, "", "/auth");
    }
  });

  it("não culpa o convite quando o erro tem causa própria", async () => {
    const user = userEvent.setup();
    window.history.pushState({}, "", "/auth?invite=convite-abc123");
    vi.mocked(supabase.auth.signUp).mockResolvedValue({
      data: { user: null, session: null },
      error: Object.assign(new Error("User already registered"), { code: "email_exists" }),
    } as unknown as Awaited<ReturnType<typeof supabase.auth.signUp>>);

    try {
      renderWithQueryClient(<AuthPage />);
      await user.click(await screen.findByText("Não tem conta? Criar conta"));

      await user.type(screen.getByLabelText("Nome"), "Ana Souza");
      await user.type(screen.getByLabelText("E-mail"), "ana@exemplo.com");
      await user.type(screen.getByLabelText("Senha"), "senha-de-teste");
      await user.click(screen.getByRole("button", { name: "Criar conta" }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith("Já existe uma conta com esse e-mail."),
      );
    } finally {
      window.history.pushState({}, "", "/auth");
    }
  });

  it("mostra toast de erro quando o cadastro falha", async () => {
    const user = userEvent.setup();
    vi.mocked(supabase.auth.signUp).mockResolvedValue({
      data: { user: null, session: null },
      error: Object.assign(new Error("User already registered"), { code: "email_exists" }),
    } as unknown as Awaited<ReturnType<typeof supabase.auth.signUp>>);

    renderWithQueryClient(<AuthPage />);
    await user.click(await screen.findByText("Não tem conta? Criar conta"));

    await user.type(screen.getByLabelText("Nome"), "Ana Souza");
    await user.type(screen.getByLabelText("E-mail"), "ana@exemplo.com");
    await user.type(screen.getByLabelText("Senha"), "senha-de-teste");
    await user.click(screen.getByRole("button", { name: "Criar conta" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Já existe uma conta com esse e-mail."),
    );
  });

  it("volta para o login ao clicar em 'Já tem conta? Entrar' no modo de cadastro", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<AuthPage />);
    await user.click(await screen.findByText("Não tem conta? Criar conta"));
    await screen.findByLabelText("Nome");

    await user.click(screen.getByText("Já tem conta? Entrar"));

    expect(screen.getByRole("button", { name: "Entrar" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Nome")).not.toBeInTheDocument();
  });

  it("renderiza o formulário de cadastro direto quando a URL tem ?mode=signup", async () => {
    window.history.pushState({}, "", "/auth?mode=signup");
    try {
      renderWithQueryClient(<AuthPage />);
      expect(await screen.findByLabelText("Nome")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Criar conta" })).toBeInTheDocument();
    } finally {
      window.history.pushState({}, "", "/auth");
    }
  });

  it("mostra toast de erro quando o login com Google falha", async () => {
    const user = userEvent.setup();
    vi.mocked(lovable.auth.signInWithOAuth).mockResolvedValue({
      error: Object.assign(new Error("OAuth cancelado"), { code: "validation_failed" }),
    } as unknown as Awaited<ReturnType<typeof lovable.auth.signInWithOAuth>>);

    renderWithQueryClient(<AuthPage />);
    await user.click(await screen.findByRole("button", { name: "Entrar com Google" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Dados inválidos. Confira e-mail e senha."),
    );
  });

  describe("modo de recuperação de senha", () => {
    it("exibe o formulário de recuperação ao clicar em 'Esqueci minha senha'", async () => {
      const user = userEvent.setup();
      renderWithQueryClient(<AuthPage />);
      await screen.findByLabelText("E-mail");

      await user.click(screen.getByText("Esqueci minha senha"));

      expect(screen.getByRole("heading", { name: "Recupere seu acesso" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Enviar link seguro" })).toBeInTheDocument();
      expect(screen.queryByLabelText("Senha")).not.toBeInTheDocument();
    });

    it("envia o link de recuperação e volta para o login", async () => {
      const user = userEvent.setup();
      vi.mocked(supabase.auth.resetPasswordForEmail).mockResolvedValue({
        data: {},
        error: null,
      } as unknown as Awaited<ReturnType<typeof supabase.auth.resetPasswordForEmail>>);

      renderWithQueryClient(<AuthPage />);
      await user.click(await screen.findByText("Esqueci minha senha"));
      await user.type(screen.getByLabelText("E-mail"), "ana@exemplo.com");
      await user.click(screen.getByRole("button", { name: "Enviar link seguro" }));

      await waitFor(() =>
        expect(supabase.auth.resetPasswordForEmail).toHaveBeenCalledWith("ana@exemplo.com", {
          redirectTo: `${window.location.origin}/auth?mode=update`,
        }),
      );
      expect(toast.success).toHaveBeenCalledWith(
        "Enviamos um link seguro para redefinir sua senha.",
      );
      // Continua em recuperação, com o aviso sobre conta inexistente no ambiente.
      expect(await screen.findByText(/não exista neste ambiente/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "crie uma conta" })).toBeInTheDocument();
    });

    it("mostra toast de erro quando o envio do link de recuperação falha", async () => {
      const user = userEvent.setup();
      vi.mocked(supabase.auth.resetPasswordForEmail).mockResolvedValue({
        data: {},
        error: Object.assign(new Error("Too many requests"), {
          code: "over_email_send_rate_limit",
        }),
      } as unknown as Awaited<ReturnType<typeof supabase.auth.resetPasswordForEmail>>);

      renderWithQueryClient(<AuthPage />);
      await user.click(await screen.findByText("Esqueci minha senha"));
      await user.type(screen.getByLabelText("E-mail"), "ana@exemplo.com");
      await user.click(screen.getByRole("button", { name: "Enviar link seguro" }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith("Muitos e-mails enviados. Aguarde um instante."),
      );
    });

    it("volta para o login ao clicar em 'Voltar para entrar'", async () => {
      const user = userEvent.setup();
      renderWithQueryClient(<AuthPage />);
      await user.click(await screen.findByText("Esqueci minha senha"));
      await screen.findByRole("button", { name: "Enviar link seguro" });

      await user.click(screen.getByText("Voltar para entrar"));

      expect(screen.getByRole("button", { name: "Entrar" })).toBeInTheDocument();
      expect(screen.getByLabelText("Senha")).toBeInTheDocument();
    });
  });

  describe("modo de atualização de senha", () => {
    beforeEach(() => {
      window.history.pushState({}, "", "/auth?mode=update");
    });

    afterEach(() => {
      window.history.pushState({}, "", "/auth");
    });

    it("avisa quando a confirmação não confere com a nova senha", async () => {
      const user = userEvent.setup();
      renderWithQueryClient(<AuthPage />);
      await user.type(await screen.findByLabelText("Senha"), "123456");
      await user.type(screen.getByLabelText("Confirme a nova senha"), "654321");
      await user.click(screen.getByRole("button", { name: "Atualizar senha" }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("As senhas não conferem."));
      expect(supabase.auth.updateUser).not.toHaveBeenCalled();
    });

    it("atualiza a senha e navega para /app quando a confirmação confere", async () => {
      const user = userEvent.setup();
      vi.mocked(supabase.auth.updateUser).mockResolvedValue({
        data: { user: null },
        error: null,
      } as unknown as Awaited<ReturnType<typeof supabase.auth.updateUser>>);

      renderWithQueryClient(<AuthPage />);
      await user.type(await screen.findByLabelText("Senha"), "senha-de-teste");
      await user.type(screen.getByLabelText("Confirme a nova senha"), "senha-de-teste");
      await user.click(screen.getByRole("button", { name: "Atualizar senha" }));

      await waitFor(() =>
        expect(supabase.auth.updateUser).toHaveBeenCalledWith({ password: "senha-de-teste" }),
      );
      expect(toast.success).toHaveBeenCalledWith("Senha atualizada. Seu ambiente está pronto.");
      expect(navigateMock).toHaveBeenCalledWith({ to: "/app" });
    });

    it("mostra toast de erro quando a atualização de senha falha no backend", async () => {
      const user = userEvent.setup();
      vi.mocked(supabase.auth.updateUser).mockResolvedValue({
        data: { user: null },
        error: new Error("Something went wrong"),
      } as unknown as Awaited<ReturnType<typeof supabase.auth.updateUser>>);

      renderWithQueryClient(<AuthPage />);
      await user.type(await screen.findByLabelText("Senha"), "senha-de-teste");
      await user.type(screen.getByLabelText("Confirme a nova senha"), "senha-de-teste");
      await user.click(screen.getByRole("button", { name: "Atualizar senha" }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith("Não foi possível autenticar. Tente novamente."),
      );
      expect(navigateMock).not.toHaveBeenCalledWith({ to: "/app" });
    });
  });

  it("entra em modo de atualização quando onAuthStateChange emite PASSWORD_RECOVERY", async () => {
    type OnAuthStateChangeCallback = Parameters<typeof supabase.auth.onAuthStateChange>[0];
    let capturedCallback: OnAuthStateChangeCallback | undefined;
    vi.mocked(supabase.auth.onAuthStateChange).mockImplementation((callback) => {
      capturedCallback = callback;
      return {
        data: { subscription: { unsubscribe: vi.fn() } },
      } as unknown as ReturnType<typeof supabase.auth.onAuthStateChange>;
    });

    renderWithQueryClient(<AuthPage />);
    await screen.findByLabelText("E-mail");

    capturedCallback?.("PASSWORD_RECOVERY", fakeSession());

    expect(await screen.findByLabelText("Confirme a nova senha")).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalledWith({ to: "/app" });
  });

  describe("erro de callback de auth vindo da URL (fragmento #error=... ou query ?error=...)", () => {
    beforeEach(() => {
      window.location.hash = "";
    });

    afterEach(() => {
      window.location.hash = "";
    });

    it("volta para recuperação e avisa quando o link de atualização expirou ou já foi usado", async () => {
      window.history.pushState({}, "", "/auth?mode=update");
      window.location.hash =
        "error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired";

      try {
        renderWithQueryClient(<AuthPage />);

        // otp_expired não distingue expirado de já usado no Supabase — cai na mesma mensagem.
        expect(
          await screen.findByRole("heading", { name: "Recupere seu acesso" }),
        ).toBeInTheDocument();
        expect(screen.queryByLabelText("Confirme a nova senha")).not.toBeInTheDocument();
        await waitFor(() =>
          expect(toast.error).toHaveBeenCalledWith(
            "Este link expirou ou já foi utilizado. Solicite um novo para continuar.",
          ),
        );
      } finally {
        window.history.pushState({}, "", "/auth");
      }
    });

    it("avisa acesso negado quando o OAuth é cancelado (error sem error_code)", async () => {
      window.location.hash = "error=access_denied&error_description=User+denied+access";

      renderWithQueryClient(<AuthPage />);
      await screen.findByLabelText("E-mail");

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          "Você cancelou a autorização ou não tem permissão para continuar.",
        ),
      );
      // Sem ?mode=update na URL, o modo permanece o padrão (signin).
      expect(screen.getByRole("button", { name: "Entrar" })).toBeInTheDocument();
    });

    it("não mostra erro quando a URL não tem fragmento de erro", async () => {
      renderWithQueryClient(<AuthPage />);
      await screen.findByLabelText("E-mail");

      expect(toast.error).not.toHaveBeenCalled();
    });

    it("reconhece o mesmo erro quando vem na query string (fluxo PKCE) em vez do fragmento", async () => {
      window.history.pushState(
        {},
        "",
        "/auth?mode=update&error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
      );

      try {
        renderWithQueryClient(<AuthPage />);

        expect(
          await screen.findByRole("heading", { name: "Recupere seu acesso" }),
        ).toBeInTheDocument();
        await waitFor(() =>
          expect(toast.error).toHaveBeenCalledWith(
            "Este link expirou ou já foi utilizado. Solicite um novo para continuar.",
          ),
        );
      } finally {
        window.history.pushState({}, "", "/auth");
      }
    });
  });

  describe("tradução de erros por texto da mensagem (sem code)", () => {
    it("traduz credenciais inválidas reconhecendo o texto da mensagem", async () => {
      const user = userEvent.setup();
      vi.mocked(supabase.auth.signInWithPassword).mockResolvedValue({
        data: { user: null, session: null },
        error: new Error("Invalid login credentials"),
      } as unknown as Awaited<ReturnType<typeof supabase.auth.signInWithPassword>>);

      renderWithQueryClient(<AuthPage />);
      await user.type(await screen.findByLabelText("E-mail"), "ana@exemplo.com");
      await user.type(screen.getByLabelText("Senha"), "123456");
      await user.click(screen.getByRole("button", { name: "Entrar" }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("E-mail ou senha incorretos."));
    });

    it("traduz e-mail não confirmado reconhecendo o texto da mensagem", async () => {
      const user = userEvent.setup();
      vi.mocked(supabase.auth.signInWithPassword).mockResolvedValue({
        data: { user: null, session: null },
        error: new Error("Email not confirmed"),
      } as unknown as Awaited<ReturnType<typeof supabase.auth.signInWithPassword>>);

      renderWithQueryClient(<AuthPage />);
      await user.type(await screen.findByLabelText("E-mail"), "ana@exemplo.com");
      await user.type(screen.getByLabelText("Senha"), "123456");
      await user.click(screen.getByRole("button", { name: "Entrar" }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith("Confirme seu e-mail antes de entrar."),
      );
    });

    it("traduz conta já existente reconhecendo o texto da mensagem", async () => {
      const user = userEvent.setup();
      vi.mocked(supabase.auth.signUp).mockResolvedValue({
        data: { user: null, session: null },
        error: new Error("User is already registered"),
      } as unknown as Awaited<ReturnType<typeof supabase.auth.signUp>>);

      renderWithQueryClient(<AuthPage />);
      await user.click(await screen.findByText("Não tem conta? Criar conta"));
      await user.type(screen.getByLabelText("Nome"), "Ana Souza");
      await user.type(screen.getByLabelText("E-mail"), "ana@exemplo.com");
      await user.type(screen.getByLabelText("Senha"), "senha-de-teste");
      await user.click(screen.getByRole("button", { name: "Criar conta" }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith("Já existe uma conta com esse e-mail."),
      );
    });

    it("traduz senha fraca reconhecendo o texto da mensagem", async () => {
      const user = userEvent.setup();
      vi.mocked(supabase.auth.signUp).mockResolvedValue({
        data: { user: null, session: null },
        error: new Error("Password should be at least 6 characters"),
      } as unknown as Awaited<ReturnType<typeof supabase.auth.signUp>>);

      renderWithQueryClient(<AuthPage />);
      await user.click(await screen.findByText("Não tem conta? Criar conta"));
      await user.type(screen.getByLabelText("Nome"), "Ana Souza");
      await user.type(screen.getByLabelText("E-mail"), "ana@exemplo.com");
      await user.type(screen.getByLabelText("Senha"), "senha-de-teste");
      await user.click(screen.getByRole("button", { name: "Criar conta" }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith("Senha muito fraca — use ao menos 6 caracteres."),
      );
    });

    it("traduz rate limit reconhecendo o texto da mensagem", async () => {
      const user = userEvent.setup();
      vi.mocked(supabase.auth.signInWithPassword).mockResolvedValue({
        data: { user: null, session: null },
        error: new Error("Rate limit exceeded, try again later"),
      } as unknown as Awaited<ReturnType<typeof supabase.auth.signInWithPassword>>);

      renderWithQueryClient(<AuthPage />);
      await user.type(await screen.findByLabelText("E-mail"), "ana@exemplo.com");
      await user.type(screen.getByLabelText("Senha"), "123456");
      await user.click(screen.getByRole("button", { name: "Entrar" }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          "Muitas tentativas. Aguarde um instante e tente de novo.",
        ),
      );
    });

    it("usa a mensagem genérica quando o erro não é reconhecido", async () => {
      const user = userEvent.setup();
      vi.mocked(supabase.auth.signInWithPassword).mockResolvedValue({
        data: { user: null, session: null },
        error: new Error("Totally unexpected backend failure"),
      } as unknown as Awaited<ReturnType<typeof supabase.auth.signInWithPassword>>);

      renderWithQueryClient(<AuthPage />);
      await user.type(await screen.findByLabelText("E-mail"), "ana@exemplo.com");
      await user.type(screen.getByLabelText("Senha"), "123456");
      await user.click(screen.getByRole("button", { name: "Entrar" }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith("Não foi possível autenticar. Tente novamente."),
      );
    });
  });
});

describe("primeiro acesso depois de um remix", () => {
  const AuthPage = Route.options.component!;

  beforeEach(() => {
    navigateMock.mockClear();
    vi.mocked(supabase.auth.onAuthStateChange).mockReturnValue({
      data: { subscription: { unsubscribe: vi.fn() } },
    } as unknown as ReturnType<typeof supabase.auth.onAuthStateChange>);
  });

  function mockTemAlgumaConta(data: boolean | null, error: unknown = null) {
    vi.mocked(supabase.rpc).mockReturnValue(
      Promise.resolve({ data, error }) as unknown as ReturnType<typeof supabase.rpc>,
    );
  }

  it("abre em criar conta quando o ambiente ainda não tem nenhuma conta", async () => {
    mockTemAlgumaConta(false);
    renderWithQueryClient(<AuthPage />);

    expect(await screen.findByLabelText("Nome")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Criar conta" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Esqueci minha senha" })).not.toBeInTheDocument();
    expect(screen.getByText(/não vêm junto no remix/i)).toBeInTheDocument();
  });

  it("mantém o login quando já existe conta no ambiente", async () => {
    mockTemAlgumaConta(true);
    renderWithQueryClient(<AuthPage />);

    expect(await screen.findByRole("button", { name: "Entrar" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Esqueci minha senha" })).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText("Nome")).not.toBeInTheDocument();
  });

  it("não quebra a tela quando a consulta de ambiente vazio falha", async () => {
    mockTemAlgumaConta(null, { message: "falhou" });
    renderWithQueryClient(<AuthPage />);

    expect(await screen.findByRole("button", { name: "Entrar" })).toBeInTheDocument();
  });
});
