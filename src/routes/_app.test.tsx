import type { ReactElement } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Session, User } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import { createTestQueryClient, renderWithQueryClient } from "@/test/render";
import { reportLovableError } from "@/lib/lovable-error-reporting";
import { resetClientErrorTelemetry } from "@/lib/client-error-telemetry";
import { MissingEnvError } from "@/lib/env";
import { Route } from "./_app";

const routerInvalidateMock = vi.fn();
const queryErrorResetMock = vi.fn();

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { routerOverrides } = await import("@/test/router-mocks");
  return {
    ...actual,
    ...routerOverrides(),
    Outlet: () => <div data-testid="outlet" />,
    useRouter: () => ({ invalidate: routerInvalidateMock }),
    useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
      select({ location: { pathname: "/dashboard", search: {} } }),
  };
});

vi.mock("@/lib/lovable-error-reporting", () => ({
  reportLovableError: vi.fn(),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...actual, useQueryErrorResetBoundary: () => ({ reset: queryErrorResetMock }) };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
    // Telemetria de erro do frontend usa rpc(); aqui ela sempre falha de
    // propósito, para provar que um boundary quebrado de telemetria não
    // derruba a tela de erro.
    rpc: vi.fn(() => Promise.reject(new Error("rpc fora do ar"))),
  },
}));

vi.mock("@/lib/api/tenant-brand", () => ({
  useApplyTenantTheme: vi.fn(),
  useTenantTitle: vi.fn(),
}));

vi.mock("@/components/layout/AppSidebar", () => ({
  AppSidebar: () => <nav data-testid="app-sidebar" />,
}));
vi.mock("@/components/layout/AppTopbar", () => ({
  AppTopbar: () => <header data-testid="app-topbar" />,
}));
vi.mock("@/components/onboarding/OnboardingGate", () => ({
  OnboardingGate: () => null,
}));

function fakeSession(): Session {
  return { user: { id: "u1" } as User } as Session;
}

describe("beforeLoad de /_app", () => {
  it("retorna o usuário quando há sessão ativa", async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: { session: fakeSession() },
      error: null,
    } as Awaited<ReturnType<typeof supabase.auth.getSession>>);

    const result = await Route.options.beforeLoad?.({} as never);

    expect(result).toEqual({ user: { id: "u1" } });
  });

  it("redireciona para /auth quando não há sessão", async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: { session: null },
      error: null,
    } as Awaited<ReturnType<typeof supabase.auth.getSession>>);

    let caught: unknown;
    try {
      await Route.options.beforeLoad?.({} as never);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Response);
    expect((caught as Response & { options: { to: string } }).options.to).toBe("/auth");
  });
});

describe("layout do app autenticado", () => {
  beforeEach(() => {
    vi.spyOn(Route, "useRouteContext").mockReturnValue({ user: { id: "u1" } as User });
  });

  it("renderiza sidebar, topbar e o conteúdo da rota filha após montar", async () => {
    const AppLayout = Route.options.component!;
    renderWithQueryClient(<AppLayout />);

    expect(await screen.findByTestId("app-sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("app-topbar")).toBeInTheDocument();
    expect(screen.getByTestId("outlet")).toBeInTheDocument();
  });
});

describe("AppErrorComponent", () => {
  beforeEach(() => {
    routerInvalidateMock.mockClear();
    queryErrorResetMock.mockClear();
    vi.mocked(reportLovableError).mockClear();
    resetClientErrorTelemetry();
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: { session: fakeSession() },
      error: null,
    } as Awaited<ReturnType<typeof supabase.auth.getSession>>);
  });

  function renderBoundary(error: Error, queryClient = createTestQueryClient()) {
    const ErrorComponent = Route.options.errorComponent as (props: {
      error: Error;
      reset: () => void;
    }) => ReactElement;
    return renderWithQueryClient(<ErrorComponent error={error} reset={vi.fn()} />, {
      queryClient,
    });
  }

  function queryClientWithProfileRole(role: "admin" | "agent") {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(["current-profile", "u1"], {
      id: "u1",
      tenant_id: "t1",
      name: "Fulano",
      role,
    });
    return queryClient;
  }

  it("exibe a tela genérica de erro e reporta o erro ao montar", () => {
    const ErrorComponent = Route.options.errorComponent as (props: {
      error: Error;
      reset: () => void;
    }) => ReactElement;
    const reset = vi.fn();
    const error = new Error("falha ao renderizar a seção");

    renderWithQueryClient(<ErrorComponent error={error} reset={reset} />);

    expect(screen.getByText("Não foi possível carregar essa seção")).toBeInTheDocument();
    expect(reportLovableError).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ boundary: "app_layout_error_component" }),
    );
  });

  it("limpa queries com erro e reinicia os boundaries ao tentar novamente", async () => {
    const user = userEvent.setup();
    const ErrorComponent = Route.options.errorComponent as (props: {
      error: Error;
      reset: () => void;
    }) => ReactElement;
    const reset = vi.fn();

    const queryClient = createTestQueryClient();
    const cancelQueries = vi.spyOn(queryClient, "cancelQueries");
    const removeQueries = vi.spyOn(queryClient, "removeQueries");
    renderWithQueryClient(<ErrorComponent error={new Error("boom")} reset={reset} />, {
      queryClient,
    });

    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));

    expect(routerInvalidateMock).toHaveBeenCalled();
    expect(cancelQueries).toHaveBeenCalled();
    expect(removeQueries).toHaveBeenCalled();
    expect(queryErrorResetMock).toHaveBeenCalled();
    expect(reset).toHaveBeenCalled();
  });

  it("exibe a MissingEnvScreen quando o erro é de env var ausente", () => {
    const ErrorComponent = Route.options.errorComponent as (props: {
      error: Error;
      reset: () => void;
    }) => ReactElement;
    const error = new MissingEnvError(["SUPABASE_URL"]);

    renderWithQueryClient(<ErrorComponent error={error} reset={vi.fn()} />);

    expect(screen.getByText("Backend não conectado")).toBeInTheDocument();
    expect(screen.queryByText("Não foi possível carregar essa seção")).not.toBeInTheDocument();
  });

  it("registra o erro na telemetria com a rota, e não re-lança quando a RPC falha", async () => {
    renderBoundary(new Error("falha de telemetria não derruba o boundary"));

    // A tela amigável continua de pé mesmo com a RPC rejeitando.
    expect(screen.getByText("Não foi possível carregar essa seção")).toBeInTheDocument();

    await vi.waitFor(() => expect(supabase.rpc).toHaveBeenCalled());
    const [name, args] = vi.mocked(supabase.rpc).mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(name).toBe("log_client_error");
    expect(args.p_route).toBe(window.location.pathname);
    expect(args.p_context).toMatchObject({
      origin: "error_boundary",
      boundary: "app_layout_error_component",
    });
    expect(screen.getByText("Não foi possível carregar essa seção")).toBeInTheDocument();
  });

  it("esconde a causa técnica de quem não é admin", () => {
    renderBoundary(
      new Error("column contacts.audio_status does not exist"),
      queryClientWithProfileRole("agent"),
    );

    expect(screen.getByText("Não foi possível carregar essa seção")).toBeInTheDocument();
    expect(screen.queryByTestId("error-technical-details")).not.toBeInTheDocument();
  });

  it("mostra a causa técnica do schema para admin, mantendo o texto amigável", () => {
    const error = Object.assign(new Error("column contacts.audio_status does not exist"), {
      code: "42703",
    });

    renderBoundary(error, queryClientWithProfileRole("admin"));

    expect(screen.getByText("Não foi possível carregar essa seção")).toBeInTheDocument();
    expect(screen.getByTestId("error-technical-details")).toBeInTheDocument();
    expect(screen.getByText("column contacts.audio_status does not exist")).toBeInTheDocument();
    expect(screen.getByText("42703")).toBeInTheDocument();
  });
});
