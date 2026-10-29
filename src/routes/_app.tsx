import {
  Outlet,
  createFileRoute,
  redirect,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { useQueryClient, useQueryErrorResetBoundary } from "@tanstack/react-query";

import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/AppSidebar";
import { AppTopbar } from "@/components/layout/AppTopbar";
import { supabase } from "@/integrations/supabase/client";
import { AuthProvider } from "@/lib/auth/AuthProvider";
import { useApplyTenantTheme, useTenantTitle } from "@/lib/api/tenant-brand";
import { useAppearanceSync } from "@/lib/useAppearanceSync";
import { OnboardingGate } from "@/components/onboarding/OnboardingGate";
import { GlobalSearchCommand } from "@/components/search/GlobalSearchCommand";
import { reportLovableError } from "@/lib/lovable-error-reporting";
import { logClientError } from "@/lib/client-error-telemetry";
import { ErrorTechnicalDetails } from "@/components/common/ErrorTechnicalDetails";
import { ErrorReference } from "@/components/common/ErrorReference";

import { assertPublicSupabaseEnv, isMissingEnvError, toMissingEnvError } from "@/lib/env";
import { MissingEnvScreen } from "@/components/common/MissingEnvScreen";
import { ConsentModal } from "@/components/common/ConsentModal";
import { MaintenanceBanner } from "@/components/common/MaintenanceBanner";
import { DevDebugButton } from "@/components/common/DevDebugButton";
import { cn } from "@/lib/utils";

function AppErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  const queryClient = useQueryClient();
  const queryErrorResetBoundary = useQueryErrorResetBoundary();
  useEffect(() => {
    reportLovableError(error, { boundary: "app_layout_error_component" });
    // Sem `await`/`throw`: telemetria não pode virar um segundo erro em cima
    // do primeiro nem impedir o boundary de renderizar.
    void logClientError(error, {
      origin: "error_boundary",
      boundary: "app_layout_error_component",
    });
  }, [error]);

  if (isMissingEnvError(error)) {
    return <MissingEnvScreen error={toMissingEnvError(error)} />;
  }

  return (
    <div className="col-span-12 flex min-h-[60vh] items-center justify-center">
      <div className="w-full max-w-lg rounded-lg border border-border bg-card p-6 text-center shadow-sm">
        <h2 className="text-lead font-semibold text-foreground">
          Não foi possível carregar essa seção
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Aconteceu um erro inesperado ao mostrar essa página. Você pode tentar novamente sem sair
          do app.
        </p>
        <button
          onClick={async () => {
            await queryClient.cancelQueries();
            queryClient.removeQueries({ predicate: (query) => query.state.status === "error" });
            queryErrorResetBoundary.reset();
            reset();
            await router.invalidate();
          }}
          className="mt-5 inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Tentar novamente
        </button>
        {/* Referência curta para todo mundo (inclusive quando o perfil ainda
         * não está no cache, como num login frio) + causa técnica só para
         * admin: era exatamente o que faltava quando /pipeline quebrou e o
         * boundary escondeu o erro de schema. */}
        <ErrorReference error={error} />
        <ErrorTechnicalDetails error={error} />
      </div>
    </div>
  );
}

export const Route = createFileRoute("/_app")({
  ssr: false,
  beforeLoad: async () => {
    // Falha cedo com uma mensagem clara se as env vars públicas do backend
    // não chegaram no build — evita o "Algo deu errado" genérico.
    assertPublicSupabaseEnv();
    // Use getSession() (reads from storage) — avoids an extra /auth/v1/user
    // network round-trip and lock contention with queries mounted on the page.
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw redirect({ to: "/auth" });
    return { user: data.session.user };
  },

  component: AppLayout,
  errorComponent: AppErrorComponent,
});

/* Precisa viver DENTRO do AuthProvider — por isso não é hook direto no layout. */
function TenantThemeApplier() {
  useApplyTenantTheme();
  useTenantTitle();
  // Preferência de aparência do usuário (tema + skin): vem do perfil, não só
  // do localStorage, para acompanhar quem troca de navegador ou de máquina.
  useAppearanceSync();
  return null;
}

function AppLayout() {
  const { user } = Route.useRouteContext();
  const isInboxList = useRouterState({
    select: (state) => {
      if (state.location.pathname !== "/inbox") return false;
      const search = state.location.search as { mode?: string };
      return search.mode === "lista";
    },
  });
  return (
    <AuthProvider initialUser={user}>
      <ConsentModal />
      <TenantThemeApplier />
      <MaintenanceBanner />
      {import.meta.env.DEV && <DevDebugButton />}
      <SidebarProvider>
        {/* Altura fixa no shell + rolagem só no <main>: evita duas barras de
            rolagem concorrentes (página + painel interno) e o "pulo" do scroll
            quando o ponteiro passa de uma área para a outra. */}
        <div data-app-shell className="flex h-svh w-full overflow-hidden bg-background">
          <AppSidebar />
          {/* SidebarInset já renderiza <main>; aqui só o contêiner interno rola. */}
          <SidebarInset className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <AppTopbar />
            <div
              data-app-scroll
              className={cn(
                "min-h-0 flex-1 overflow-x-hidden overscroll-contain",
                isInboxList ? "overflow-y-hidden" : "overflow-y-auto",
              )}
            >
              <div
                className={cn(
                  "mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8",
                  isInboxList && "box-border h-full",
                )}
              >
                <div className={cn("grid grid-cols-12 gap-6", isInboxList && "h-full min-h-0")}>
                  <Outlet />
                </div>
              </div>
            </div>
          </SidebarInset>
        </div>
        <OnboardingGate />
        <GlobalSearchCommand />
      </SidebarProvider>
    </AuthProvider>
  );
}
