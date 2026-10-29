import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { installClientErrorHandlers, logClientError } from "../lib/client-error-telemetry";
import { appearanceBootScript } from "../lib/appearance-boot";
import { isMissingEnvError, toMissingEnvError } from "../lib/env";
import { MissingEnvScreen } from "../components/common/MissingEnvScreen";
import { DeferredRootWidgets } from "@/components/common/DeferredRootWidgets";

function NotFoundComponent() {
  // O root não define head próprio pra 404 (notFoundComponent não participa do
  // roteamento por rota/arquivo), então sem isso a aba herda o título default
  // do root. Client-only: não cobre o <title> do HTML servido por SSR nem
  // og:title de preview de link — só a aba do navegador depois de montar.
  useEffect(() => {
    document.title = "Página não encontrada — Stefanello";
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-h5 font-semibold text-foreground">Página não encontrada</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          A página que você tentou abrir não existe ou foi movida.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Voltar para o início
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
    // Sem `await`/`throw`: telemetria não pode virar um segundo erro em cima
    // do primeiro nem impedir o boundary de renderizar.
    void logClientError(error, {
      origin: "error_boundary",
      boundary: "tanstack_root_error_component",
    });
  }, [error]);

  if (isMissingEnvError(error)) {
    return <MissingEnvScreen error={toMissingEnvError(error)} />;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-h5 font-semibold tracking-tight text-foreground">Algo deu errado</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Não conseguimos carregar essa página. Tente novamente em instantes ou volte para o início.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Tentar novamente
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Ir para o início
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Stefanello — Laticínios e embutidos" },
      {
        name: "description",
        content:
          "CRM com assistente de IA para pequenas e médias empresas: pipeline kanban, inbox unificado de WhatsApp e e-mail, e qualificação automática de leads.",
      },
      { name: "author", content: "Stefanello" },
      { property: "og:site_name", content: "Stefanello" },
      { property: "og:title", content: "Stefanello — Laticínios e embutidos" },
      {
        property: "og:description",
        content:
          "CRM com assistente de IA para pequenas e médias empresas: pipeline kanban, inbox unificado de WhatsApp e e-mail, e qualificação automática de leads.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "theme-color", content: "#0a0f1a" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/png", href: "/favicon.png" },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      // Preload da folha crítica: encurta a cadeia HTML → CSS → woff2 iniciando
      // o download do CSS de fontes junto com o CSS do app.
      {
        rel: "preload",
        as: "style",
        href: "https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,400..900;1,600&family=Geist+Mono:wght@400..600&display=swap",
      },
      {
        rel: "stylesheet",
        // Itálico só é usado no peso 600 (utility .t-ital) — pede só ele em vez do eixo 400..900.
        href: "https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,400..900;1,600&family=Geist+Mono:wght@400..600&display=swap",
      },
      {
        // Lexend só é usada no skin opcional "Power": carrega fora do caminho
        // crítico (media="print") e é promovida pelo script inline do shell.
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Lexend:wght@300;400;500;600;700&display=swap",
        media: "print",
        "data-lazy-font": "lexend",
      } as unknown as { rel: string; href: string },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR" className="dark" data-theme="dark" suppressHydrationWarning>
      <head suppressHydrationWarning>
        {/* Antes do paint: aplica o tema salvo (dark é o default do produto).
         * Mantém .dark (shadcn) e data-theme (DS §5) espelhados. O conteúdo do
         * script mora em lib/appearance-boot.ts, que é onde a lista de skins é
         * declarada uma vez só (e onde ele é testado). */}
        <script
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: appearanceBootScript() }}
        />
        <HeadContent />
      </head>
      <body suppressHydrationWarning>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  // Erro que escapa do React (handler de evento, timer, promessa solta) não
  // passa por error boundary nem pelo QueryCache — só por estes dois listeners.
  // No root para cobrir também as rotas fora de /_app; client-only.
  useEffect(() => {
    const cleanup = installClientErrorHandlers();
    // O script pré-paint roda antes do bundle e não tem para onde reportar: ele
    // deixa a mensagem aqui. Sem drenar, "meu tema salvo não aplica" não deixa
    // rastro nenhum em produção.
    const bootError = window.__appearanceBootError;
    if (bootError !== undefined) {
      delete window.__appearanceBootError;
      void logClientError(new Error(`appearance boot: ${bootError}`), {
        origin: "window_error",
      });
    }
    return cleanup;
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
      <Outlet />
      {/* Toaster global: precisa cobrir rotas fora do _app (ex.: /auth), senão os
       * toast.error do login somem silenciosamente. */}
      <DeferredRootWidgets />
    </QueryClientProvider>
  );
}
