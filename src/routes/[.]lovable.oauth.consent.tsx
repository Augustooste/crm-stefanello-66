import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// Wrapper tipado para o namespace beta `auth.oauth` — o supabase-js instalado
// ainda não expõe os tipos, mas os métodos existem em runtime.
type OAuthClient = { name?: string | null; redirect_uris?: string[] | null };
type OAuthAuthorizationDetails = {
  client?: OAuthClient | null;
  scope?: string | null;
  redirect_url?: string | null;
  redirect_to?: string | null;
};
type OAuthResponse<T> = { data: T | null; error: { message: string } | null };
type OAuthNamespace = {
  getAuthorizationDetails(id: string): Promise<OAuthResponse<OAuthAuthorizationDetails>>;
  approveAuthorization(id: string): Promise<OAuthResponse<OAuthAuthorizationDetails>>;
  denyAuthorization(id: string): Promise<OAuthResponse<OAuthAuthorizationDetails>>;
};

function getOAuth(): OAuthNamespace {
  const client = supabase as unknown as SupabaseClient & {
    auth: SupabaseClient["auth"] & { oauth?: OAuthNamespace };
  };
  const oauth = client.auth.oauth;
  if (!oauth) throw new Error("Servidor OAuth não configurado.");
  return oauth;
}

function isSameOriginRelative(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//");
}

export const Route = createFileRoute("/.lovable/oauth/consent")({
  ssr: false,
  validateSearch: (s: Record<string, unknown>) => ({
    authorization_id: typeof s.authorization_id === "string" ? s.authorization_id : "",
  }),
  beforeLoad: async ({ search, location }) => {
    if (!search.authorization_id) throw new Error("authorization_id ausente na URL.");
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      const next = location.pathname + location.searchStr;
      throw redirect({
        to: "/auth",
        search: isSameOriginRelative(next) ? { next } : {},
      });
    }
  },
  loader: async ({ location }) => {
    const authorizationId = new URLSearchParams(location.search).get("authorization_id") ?? "";
    const { data, error } = await getOAuth().getAuthorizationDetails(authorizationId);
    if (error) throw new Error(error.message);
    const immediate = data?.redirect_url ?? data?.redirect_to;
    if (immediate && !data?.client) throw redirect({ href: immediate });
    return data;
  },
  component: ConsentPage,
  errorComponent: ({ error }) => (
    <main className="mx-auto max-w-md p-6 text-slate-100">
      <h1 className="text-lead font-semibold">Não foi possível carregar esta autorização</h1>
      <p className="mt-2 text-sm text-slate-400">{String((error as Error)?.message ?? error)}</p>
    </main>
  ),
});

function ConsentPage() {
  const details = Route.useLoaderData();
  const { authorization_id } = Route.useSearch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(approve: boolean) {
    setBusy(true);
    setError(null);
    const oauth = getOAuth();
    const { data, error: err } = approve
      ? await oauth.approveAuthorization(authorization_id)
      : await oauth.denyAuthorization(authorization_id);
    if (err) {
      setBusy(false);
      setError(err.message);
      return;
    }
    const target = data?.redirect_url ?? data?.redirect_to;
    if (!target) {
      setBusy(false);
      setError("A autorização não retornou uma URL de redirecionamento.");
      return;
    }
    window.location.href = target;
  }

  const clientName = details?.client?.name ?? "Aplicativo externo";
  const scope = details?.scope ?? "";

  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-4 py-10">
      <Card className="w-full border-white/10 bg-[var(--neutral-950)]/90 text-slate-100 shadow-2xl">
        <CardHeader>
          <CardTitle className="[font-family:Lexend,sans-serif] text-h4">
            Conectar {clientName} ao Stefanello
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-slate-300">
            Isso permitirá que <strong>{clientName}</strong> use o Stefanello como você, respeitando as
            permissões do seu papel e o isolamento do seu tenant.
          </p>
          {scope && (
            <p className="text-caption text-slate-400">
              Escopos solicitados: <code className="text-slate-300">{scope}</code>
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex gap-3 pt-2">
            <Button className="flex-1" disabled={busy} onClick={() => decide(true)}>
              Aprovar
            </Button>
            <Button
              variant="outline"
              className="flex-1 border-white/15 bg-transparent"
              disabled={busy}
              onClick={() => decide(false)}
            >
              Recusar
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
