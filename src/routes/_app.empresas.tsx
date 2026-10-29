import { Outlet, createFileRoute } from "@tanstack/react-router";
import { requirePluginActive } from "@/lib/api/plugins";

// ssr:false — o guard `requirePluginActive` é assíncrono (lê sessão + DB) e,
// quando o plugin "companies" está inativo, faz `throw redirect({to:"/app"})`.
// No full-load esse redirect assíncrono roda DURANTE a hidratação (o servidor
// já mandou o shell SSR de /empresas), quebrando a hidratação e deixando a
// página BRANCA. Client-only elimina o shell SSR: o redirect passa a rodar
// como numa navegação client-side (que já funcionava limpo). Difere dos
// redirects síncronos de /integracoes,/agendamentos (esses o servidor resolve
// sozinho e não precisam disto).
export const Route = createFileRoute("/_app/empresas")({
  ssr: false,
  beforeLoad: ({ context }) => requirePluginActive(context.queryClient, "companies"),
  component: CompaniesLayout,
});

function CompaniesLayout() {
  return <Outlet />;
}
