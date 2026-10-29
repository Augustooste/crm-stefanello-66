import { useMemo, useState } from "react";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { ArrowLeft, Building2, ExternalLink, Handshake, Pencil, Users } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { PageHeader } from "@/components/common/PageHeader";
import { EmptyState } from "@/components/common/EmptyState";
import { CompanyFormDialog, type CompanyRow } from "@/components/companies/CompanyFormDialog";
import { requirePluginActive } from "@/lib/api/plugins";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { InitialsAvatar } from "@/components/common/InitialsAvatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { formatDate } from "@/lib/format";

export const Route = createFileRoute("/_app/empresas/$id")({
  // ssr:false — mesmo motivo do layout _app.empresas.tsx: guard async +
  // redirect no full-load quebra a hidratação e deixa a página branca.
  ssr: false,
  beforeLoad: ({ context }) => requirePluginActive(context.queryClient, "companies"),
  head: () => ({
    meta: [
      { title: "Empresa" },
      { name: "description", content: "Contatos e negócios agrupados por empresa." },
    ],
  }),
  component: CompanyDetail,
  notFoundComponent: () => (
    <div className="col-span-12">
      <EmptyState title="Empresa não encontrada" description="Esta empresa não existe mais." />
    </div>
  ),
});

type CompanyContactRow = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
};

type CompanyDealRow = {
  id: string;
  contact_id: string | null;
  status: string | null;
};

function CompanyDetail() {
  const { id } = Route.useParams();
  const [openEdit, setOpenEdit] = useState(false);

  const companyQuery = useQuery({
    queryKey: ["company", id],
    queryFn: async () => {
      // .is("deleted_at", null) -- defesa em profundidade: uma empresa
      // soft-deletada nunca deve renderizar como registro vivo aqui, mesmo se
      // algo (bug, edge case) deixar um contato ainda apontando pra ela.
      const { data, error } = await supabase
        .from("crm_companies")
        .select("id, tenant_id, name, industry, website, created_at")
        .eq("id", id)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) throw error;
      return (data as CompanyRow) ?? null;
    },
  });

  const contactsQuery = useQuery({
    queryKey: ["company-contacts", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("contacts")
        .select("id, name, phone, email")
        .eq("company_id", id)
        .is("deleted_at", null)
        .order("name");
      if (error) throw error;
      return (data ?? []) as CompanyContactRow[];
    },
  });

  const contacts = contactsQuery.data ?? [];
  // Depende de `contactsQuery.data` (referência estável entre renders), não
  // de `contacts` (fallback `?? []` cria array novo a cada render) -- mesmo
  // padrão de `dealIds` em _app.pipeline.tsx.
  const contactIds = useMemo(
    () => (contactsQuery.data ?? []).map((c) => c.id),
    [contactsQuery.data],
  );

  // Stats de negócios da empresa: sem deals.company_id (fora de escopo v1),
  // então agrega client-side via contato -> empresa. Só dispara quando há
  // contatos -- lista vazia não bate no banco à toa.
  const dealsQuery = useQuery({
    queryKey: ["company-deals", id, contactIds],
    enabled: contactIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deals")
        .select("id, contact_id, status")
        .in("contact_id", contactIds);
      if (error) throw error;
      return (data ?? []) as CompanyDealRow[];
    },
  });

  const deals = dealsQuery.data ?? [];
  const openDeals = deals.filter((d) => d.status !== "won" && d.status !== "lost").length;
  const wonDeals = deals.filter((d) => d.status === "won").length;

  if (companyQuery.isLoading) {
    return (
      <div className="col-span-12 space-y-3">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const company = companyQuery.data;
  if (!company) throw notFound();

  return (
    <div className="col-span-12 flex flex-col gap-4">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2">
          <Link to="/empresas">
            <ArrowLeft className="mr-1 h-4 w-4" /> Empresas
          </Link>
        </Button>
        <PageHeader
          title={
            <span className="flex items-center gap-2">
              <Avatar className="h-9 w-9">
                <AvatarFallback className="bg-primary/10 text-primary">
                  <Building2 className="h-4 w-4" />
                </AvatarFallback>
              </Avatar>
              {company.name}
            </span>
          }
          description={company.industry ?? undefined}
          actions={
            <Button variant="outline" onClick={() => setOpenEdit(true)}>
              <Pencil className="mr-1 h-4 w-4" /> Editar
            </Button>
          }
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-caption font-medium text-muted-foreground">
              Contatos
            </CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-card-title font-semibold text-foreground">{contacts.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-caption font-medium text-muted-foreground">
              Negócios em aberto
            </CardTitle>
            <Handshake className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-card-title font-semibold text-foreground">{openDeals}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-caption font-medium text-muted-foreground">
              Negócios ganhos
            </CardTitle>
            <Handshake className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-card-title font-semibold text-foreground">{wonDeals}</div>
          </CardContent>
        </Card>
      </div>

      {company.website && (
        <a
          href={company.website}
          target="_blank"
          rel="noreferrer"
          className="inline-flex w-fit items-center gap-1 text-body text-primary hover:underline"
        >
          {company.website} <ExternalLink className="h-3.5 w-3.5" />
        </a>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-card-title">Contatos desta empresa</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {contactsQuery.isLoading ? (
            <div className="space-y-3 p-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : contacts.length === 0 ? (
            <div className="p-6">
              <EmptyState
                icon={Users}
                title="Nenhum contato vinculado"
                description="Contatos ficam ligados a esta empresa pelo campo Empresa no formulário de contato."
              />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>Telefone</TableHead>
                  <TableHead>E-mail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {contacts.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link
                        to="/contatos/$id"
                        params={{ id: c.id }}
                        className="flex items-center gap-2 font-medium text-foreground hover:underline"
                      >
                        <InitialsAvatar name={c.name} variant="muted" size="xs" />
                        {c.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{c.phone || "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{c.email || "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <p className="text-caption text-muted-foreground">
        Empresa criada em {formatDate(company.created_at)}.
      </p>

      <CompanyFormDialog open={openEdit} onOpenChange={setOpenEdit} company={company} />
    </div>
  );
}
