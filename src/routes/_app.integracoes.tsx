import { createFileRoute, redirect } from "@tanstack/react-router";

// Rota antiga, absorvida pela aba "Integrações e Plugins" em /configuracoes
// (ver PluginsTab.tsx). Mantida como redirect (não 404) para não quebrar
// bookmarks/deep-links existentes.
export const Route = createFileRoute("/_app/integracoes")({
  beforeLoad: () => {
    throw redirect({ to: "/configuracoes", hash: "plugins" });
  },
});
