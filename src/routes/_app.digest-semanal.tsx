import { createFileRoute, redirect } from "@tanstack/react-router";

// Rota antiga, absorvida pela aba "Notificações" em /configuracoes (ver
// NotificationsTab.tsx). Mantida como redirect (não 404) para não quebrar
// bookmarks/deep-links existentes.
export const Route = createFileRoute("/_app/digest-semanal")({
  beforeLoad: () => {
    throw redirect({ to: "/configuracoes", hash: "notificacoes" });
  },
});
