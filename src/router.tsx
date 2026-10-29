import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { RouterPendingFallback } from "./components/common/RouterPendingFallback";
import { logClientError } from "./lib/client-error-telemetry";

/**
 * Nome legível do que falhou, para o log: `["my-capabilities","u1"]` vira
 * "my-capabilities". Só o primeiro segmento textual — o resto costuma ser id,
 * que não deve ir para telemetria.
 */
function describeKey(key: unknown): string | undefined {
  if (!Array.isArray(key) || key.length === 0) return undefined;
  const head = key[0];
  return typeof head === "string" ? head : undefined;
}

export const getRouter = () => {
  const queryClient = new QueryClient({
    // Telemetria no cache, não no error boundary: o caso que motivou isto
    // (/pipeline quebrada por dias em produção, system_events vazio) passa por
    // uma query com `throwOnError: false` (deal-board-lookup em
    // _app.pipeline.tsx), que por definição nunca chega a um boundary.
    // Instrumentar aqui pega toda falha de query/mutation, tratada ou não.
    // logClientError nunca lança e é no-op no SSR.
    queryCache: new QueryCache({
      onError: (error, query) =>
        void logClientError(error, { origin: "query", operation: describeKey(query.queryKey) }),
    }),
    mutationCache: new MutationCache({
      onError: (error, _vars, _ctx, mutation) =>
        void logClientError(error, {
          origin: "mutation",
          // A maioria das mutations do app não declara `mutationKey` (só 1 caso
          // hoje) — sem fallback, `context.operation` simplesmente não existia
          // para quase nenhum erro de mutation em produção. O marcador explícito
          // torna a lacuna visível e contável em vez de omitir o campo.
          operation: describeKey(mutation.options.mutationKey) ?? "(sem mutationKey)",
        }),
    }),

    defaultOptions: {
      queries: {
        staleTime: 60_000, // 1min: evita refetch imediato a cada mount/foco
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        // Falha de query (após os retries) propaga para o errorComponent da rota
        // em vez de renderizar como estado vazio ("Nenhum...") — o usuário vê o
        // erro e o "tentar de novo", não um "sem dados" enganoso.
        // ponytail: erro global de rota; granularidade por-tela (isError) só se
        // um widget específico não puder derrubar a página inteira.
        throwOnError: true,
      },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: "intent",
    // React Query é a fonte de verdade da validade dos dados. Manter cache de
    // preload também no Router pode reutilizar uma transição autenticada depois
    // que a sessão mudou (inclusive durante logout/login de outra conta).
    defaultPreloadStaleTime: 0,
    // Deep-link em rota com beforeLoad/loader assíncrono lento (ex.:
    // requirePluginActive aguardando profile+tenant) sem isso fica com tela
    // em branco até reload manual -- ver RouterPendingFallback.tsx.
    // defaultPendingMs fica no default (~1s) de propósito: já evita flicker
    // em navegações rápidas, só queremos cobrir o caso lento.
    defaultPendingComponent: RouterPendingFallback,
  });

  return router;
};
