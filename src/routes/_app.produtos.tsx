import { Outlet, createFileRoute } from "@tanstack/react-router";
import { requirePluginActive } from "@/lib/api/plugins";

export const Route = createFileRoute("/_app/produtos")({
  beforeLoad: ({ context }) => requirePluginActive(context.queryClient, "catalogo"),
  component: ProductsLayout,
});

function ProductsLayout() {
  return <Outlet />;
}
