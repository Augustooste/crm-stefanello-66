import { createFileRoute, redirect } from "@tanstack/react-router";

// Rota antiga, absorvida pela aba "Agendamentos" dentro de /templates (ver
// AgendamentosTab.tsx). Mantida como redirect (não 404) para não quebrar
// bookmarks/deep-links existentes.
export const Route = createFileRoute("/_app/agendamentos")({
  beforeLoad: () => {
    throw redirect({ to: "/templates", hash: "agendamentos" });
  },
});
