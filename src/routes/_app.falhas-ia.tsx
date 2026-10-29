import { createFileRoute, redirect } from "@tanstack/react-router";

// Rota antiga, absorvida pela aba "Falhas de IA" em /configuracoes (ver
// AiFailuresTab.tsx). Mantida como redirect (não 404) para não quebrar
// bookmarks/deep-links existentes.
export const Route = createFileRoute("/_app/falhas-ia")({
  beforeLoad: () => {
    throw redirect({ to: "/configuracoes", hash: "ia/falhas" });
  },
});
