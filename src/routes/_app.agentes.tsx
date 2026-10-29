import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";

import { AGENTES_IA_HABILITADO } from "@/lib/feature-flags";

export const Route = createFileRoute("/_app/agentes")({
  // O guard fica no `beforeLoad` do layout, não no componente: esconder só o
  // item do sidebar deixaria `/agentes` e `/agentes/<id>` acessíveis por
  // deep-link, e no SSR uma rota órfã renderiza tela branca em vez de 404
  // (foi o que aconteceu com /empresas). `beforeLoad` roda no servidor e no
  // cliente, então cobre digitar a URL, refresh e link salvo.
  beforeLoad: () => {
    if (!AGENTES_IA_HABILITADO) throw redirect({ to: "/configuracoes" });
  },
  component: AgentesLayout,
});

function AgentesLayout() {
  return <Outlet />;
}
