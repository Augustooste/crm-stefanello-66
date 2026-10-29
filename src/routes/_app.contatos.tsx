import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/contatos")({
  component: ContactsLayout,
});

function ContactsLayout() {
  return <Outlet />;
}
