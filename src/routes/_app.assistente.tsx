import { createFileRoute, redirect } from "@tanstack/react-router";

// Rota antiga, absorvida pela aba "Assistente IA" em /configuracoes (ver
// AiAssistantTab.tsx). Mantida como redirect (não 404) para não quebrar
// bookmarks/deep-links existentes.
export const Route = createFileRoute("/_app/assistente")({
  beforeLoad: () => {
    throw redirect({ to: "/configuracoes", hash: "ia/assistente" });
  },
});
