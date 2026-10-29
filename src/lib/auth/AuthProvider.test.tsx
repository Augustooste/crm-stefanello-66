import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { User } from "@supabase/supabase-js";
import { AuthProvider, useAuth } from "./AuthProvider";
import { supabase } from "@/integrations/supabase/client";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      onAuthStateChange: vi.fn(),
      getSession: vi.fn(),
    },
  },
}));

const mockedAuth = supabase.auth as unknown as {
  onAuthStateChange: Mock;
  getSession: Mock;
};

type Session = { user: User } | null;
type AuthChangeCallback = (event: string, session: Session) => void;

function makeUser(id: string): User {
  return { id } as User;
}

/* AuthProvider usa useQueryClient() — todo render precisa do provider do react-query. */
function renderAuth(ui: ReactNode, queryClient = new QueryClient()) {
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function TestConsumer() {
  const { user, isReady } = useAuth();
  return (
    <div>
      <span data-testid="ready">{String(isReady)}</span>
      <span data-testid="user">{user?.id ?? "none"}</span>
    </div>
  );
}

describe("AuthProvider", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("começa não pronto e hidrata o usuário a partir de getSession", async () => {
    const user = makeUser("u1");
    mockedAuth.onAuthStateChange.mockReturnValue({
      data: { subscription: { unsubscribe: vi.fn() } },
    });
    mockedAuth.getSession.mockResolvedValue({ data: { session: { user } } });

    renderAuth(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    expect(screen.getByTestId("ready").textContent).toBe("false");
    await waitFor(() => expect(screen.getByTestId("ready").textContent).toBe("true"));
    expect(screen.getByTestId("user").textContent).toBe("u1");
  });

  it("usa initialUser como estado inicial (isReady já true)", () => {
    const initial = makeUser("initial");
    mockedAuth.onAuthStateChange.mockReturnValue({
      data: { subscription: { unsubscribe: vi.fn() } },
    });
    mockedAuth.getSession.mockResolvedValue({ data: { session: null } });

    renderAuth(
      <AuthProvider initialUser={initial}>
        <TestConsumer />
      </AuthProvider>,
    );

    expect(screen.getByTestId("ready").textContent).toBe("true");
    expect(screen.getByTestId("user").textContent).toBe("initial");
  });

  it("atualiza o usuário quando onAuthStateChange dispara um evento", async () => {
    let capturedCallback: AuthChangeCallback | undefined;
    mockedAuth.onAuthStateChange.mockImplementation((cb: AuthChangeCallback) => {
      capturedCallback = cb;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });
    mockedAuth.getSession.mockResolvedValue({ data: { session: null } });

    renderAuth(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("ready").textContent).toBe("true"));

    act(() => {
      capturedCallback?.("SIGNED_IN", { user: makeUser("u2") });
    });

    expect(screen.getByTestId("user").textContent).toBe("u2");
  });

  it("limpa o usuário quando a sessão é encerrada", async () => {
    let capturedCallback: AuthChangeCallback | undefined;
    mockedAuth.onAuthStateChange.mockImplementation((cb: AuthChangeCallback) => {
      capturedCallback = cb;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });
    mockedAuth.getSession.mockResolvedValue({ data: { session: { user: makeUser("u3") } } });

    renderAuth(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("user").textContent).toBe("u3"));

    act(() => {
      capturedCallback?.("SIGNED_OUT", null);
    });

    expect(screen.getByTestId("user").textContent).toBe("none");
  });

  it("cancela a subscription ao desmontar", async () => {
    const unsubscribe = vi.fn();
    mockedAuth.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe } } });
    mockedAuth.getSession.mockResolvedValue({ data: { session: null } });

    const { unmount } = renderAuth(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );
    await waitFor(() => expect(unsubscribe).not.toHaveBeenCalled());
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("ignora a resolução de getSession após desmontar", async () => {
    let resolveGetSession: (value: { data: { session: null } }) => void = () => {};
    mockedAuth.onAuthStateChange.mockReturnValue({
      data: { subscription: { unsubscribe: vi.fn() } },
    });
    mockedAuth.getSession.mockReturnValue(
      new Promise((resolve) => {
        resolveGetSession = resolve;
      }),
    );

    const { unmount } = renderAuth(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );
    unmount();
    expect(() => resolveGetSession({ data: { session: null } })).not.toThrow();
    await Promise.resolve();
  });

  it("ignora eventos do onAuthStateChange recebidos após desmontar", async () => {
    let capturedCallback: AuthChangeCallback | undefined;
    mockedAuth.onAuthStateChange.mockImplementation((cb: AuthChangeCallback) => {
      capturedCallback = cb;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });
    mockedAuth.getSession.mockResolvedValue({ data: { session: null } });

    const { unmount } = renderAuth(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("ready").textContent).toBe("true"));
    unmount();

    expect(() => capturedCallback?.("SIGNED_IN", { user: makeUser("late") })).not.toThrow();
  });

  describe("reset do cache do react-query na troca de identidade", () => {
    function setupWithCache(initialUser: User | null) {
      let capturedCallback: AuthChangeCallback | undefined;
      mockedAuth.onAuthStateChange.mockImplementation((cb: AuthChangeCallback) => {
        capturedCallback = cb;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      });
      mockedAuth.getSession.mockResolvedValue({
        data: { session: initialUser ? { user: initialUser } : null },
      });

      const queryClient = new QueryClient();
      renderAuth(
        <AuthProvider initialUser={initialUser}>
          <TestConsumer />
        </AuthProvider>,
        queryClient,
      );
      // Dado da identidade anterior, numa queryKey sem discriminante.
      queryClient.setQueryData(["my-capabilities"], ["admin"]);
      return {
        queryClient,
        fire: (event: string, session: Session) => capturedCallback?.(event, session),
      };
    }

    it("descarta o cache quando outra conta assume a sessão", async () => {
      const { queryClient, fire } = setupWithCache(makeUser("conta-a"));
      await waitFor(() => expect(screen.getByTestId("user").textContent).toBe("conta-a"));

      act(() => fire("SIGNED_IN", { user: makeUser("conta-b") }));

      expect(queryClient.getQueryData(["my-capabilities"])).toBeUndefined();
    });

    it("descarta o cache no logout", async () => {
      const { queryClient, fire } = setupWithCache(makeUser("conta-a"));
      await waitFor(() => expect(screen.getByTestId("user").textContent).toBe("conta-a"));

      act(() => fire("SIGNED_OUT", null));

      expect(queryClient.getQueryData(["my-capabilities"])).toBeUndefined();
    });

    it("PRESERVA o cache quando o evento repete a mesma identidade (refresh de token)", async () => {
      const { queryClient, fire } = setupWithCache(makeUser("conta-a"));
      await waitFor(() => expect(screen.getByTestId("user").textContent).toBe("conta-a"));

      act(() => fire("TOKEN_REFRESHED", { user: makeUser("conta-a") }));

      expect(queryClient.getQueryData(["my-capabilities"])).toEqual(["admin"]);
    });

    it("descarta o cache quando o provider REMONTA já com a outra identidade", async () => {
      // Cenário real: aba parada em /auth (AuthProvider desmontado) enquanto
      // outra conta faz login. O provider remonta com initialUser = conta-b, sem
      // reload da página — então o cache da conta-a ainda está vivo no
      // queryClient, que é singleton em src/router.tsx.
      const queryClient = new QueryClient();
      mockedAuth.onAuthStateChange.mockReturnValue({
        data: { subscription: { unsubscribe: vi.fn() } },
      });
      mockedAuth.getSession.mockResolvedValue({
        data: { session: { user: makeUser("conta-a") } },
      });

      const primeira = renderAuth(
        <AuthProvider initialUser={makeUser("conta-a")}>
          <TestConsumer />
        </AuthProvider>,
        queryClient,
      );
      await waitFor(() => expect(screen.getByTestId("user").textContent).toBe("conta-a"));
      queryClient.setQueryData(["my-capabilities"], ["admin"]);
      primeira.unmount();

      mockedAuth.getSession.mockResolvedValue({
        data: { session: { user: makeUser("conta-b") } },
      });
      renderAuth(
        <AuthProvider initialUser={makeUser("conta-b")}>
          <TestConsumer />
        </AuthProvider>,
        queryClient,
      );
      await waitFor(() => expect(screen.getByTestId("user").textContent).toBe("conta-b"));

      expect(queryClient.getQueryData(["my-capabilities"])).toBeUndefined();
    });
  });

  it("useAuth retorna o contexto padrão fora do provider", () => {
    const { result } = renderHook(() => useAuth());
    expect(result.current).toEqual({ user: null, isReady: false });
  });
});
