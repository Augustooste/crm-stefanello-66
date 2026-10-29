import { Loader2 } from "lucide-react";

/**
 * `defaultPendingComponent` do router (src/router.tsx). Cobre o caso de
 * deep-link em rota com `beforeLoad`/`loader` assíncrono lento (ex.:
 * `requirePluginActive` em plugins.ts aguardando profile+tenant) -- sem isso
 * o app fica com a tela em branco (sem sidebar, sem loading) até o usuário
 * dar reload manual. O TanStack Router só troca pelo componente da rota
 * depois de `defaultPendingMs` (~1s default), então não aparece flicker em
 * navegações rápidas.
 *
 * `pendingComponent`/`defaultPendingComponent` é renderizado POR MATCH (cada
 * rota tem seu próprio Suspense boundary local -- ver
 * node_modules/@tanstack/react-router/dist/esm/Match.js, `MatchView`), não
 * como overlay global no root. Na maioria dos disparos reais (guard de rede
 * lento em rota FILHA, ex. `requirePluginActive` em `/_app/agenda`), o layout
 * do `_app` (sidebar/topbar) já renderizou e este componente é montado
 * aninhado dentro do `<Outlet/>` de `_app`, dentro de
 * `<div className="grid grid-cols-12 gap-6">` (src/routes/_app.tsx) -- um
 * item de grid implícito sem `col-span-12`. `position: fixed` tira o
 * componente do fluxo/grid do pai e o ancora no viewport, então ele sempre
 * aparece como overlay full-screen centralizado, tanto nesse caso aninhado
 * quanto no caso raro em que nada renderizou ainda (beforeLoad do `_app`
 * falhando/lento).
 */
export function RouterPendingFallback() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background"
    >
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-hidden />
    </div>
  );
}
