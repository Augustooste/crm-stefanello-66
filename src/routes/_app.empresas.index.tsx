import { useMemo, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Building2, ExternalLink, Plus, Search, Trash2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { PageHeader } from "@/components/common/PageHeader";
import { EmptyState } from "@/components/common/EmptyState";
import { CompanyFormDialog, type CompanyRow } from "@/components/companies/CompanyFormDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { supabase } from "@/integrations/supabase/client";
import { formatDate } from "@/lib/format";

export const Route = createFileRoute("/_app/empresas/")({
  // ssr:false — subtree /empresas é client-only (ver _app.empresas.tsx): o
  // guard de plugin async redireciona e, com SSR, isso branqueia a página.
  ssr: false,
  head: () => ({
    meta: [
      { title: "Empresas" },
      {
        name: "description",
        content: "Empresas do seu CRM: contatos e negócios agrupados por conta.",
      },
    ],
  }),
  component: CompaniesPage,
});

function CompaniesPage() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [openNew, setOpenNew] = useState(false);
  const [deleting, setDeleting] = useState<CompanyRow | null>(null);

  const companiesQuery = useQuery({
    queryKey: ["companies"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("crm_companies")
        .select("id, tenant_id, name, industry, website, created_at")
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as CompanyRow[];
    },
  });

  const companies = companiesQuery.data ?? [];

  // Depende de `companiesQuery.data` (referência estável entre renders),
  // não de `companies` (fallback `?? []` cria array novo a cada render e
  // invalidaria a memoização) -- mesmo padrão de `dealIds` em _app.pipeline.tsx.
  const filtered = useMemo(() => {
    const list = companiesQuery.data ?? [];
    const t = q.trim().toLowerCase();
    if (!t) return list;
    return list.filter((c) =>
      [c.name, c.industry ?? "", c.website ?? ""].some((v) => v.toLowerCase().includes(t)),
    );
  }, [companiesQuery.data, q]);

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      // Soft delete -- mesmo critério de contacts: nunca DELETE físico. Um
      // UPDATE de deleted_at NÃO dispara o "on delete set null" da FK (que só
      // roda em DELETE físico), então o desvínculo dos contatos precisa ser
      // feito explicitamente aqui para a empresa realmente "sumir" pros
      // contatos vinculados, como o texto do diálogo de confirmação promete.
      const { error } = await supabase
        .from("crm_companies")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;

      const { error: unlinkError } = await supabase
        .from("contacts")
        .update({ company_id: null })
        .eq("company_id", id);
      if (unlinkError) throw unlinkError;

      return id;
    },
    onSuccess: (id) => {
      qc.invalidateQueries({ queryKey: ["companies"] });
      qc.invalidateQueries({ queryKey: ["companies-lite"] });
      qc.invalidateQueries({ queryKey: ["company-contacts", id] });
      qc.invalidateQueries({ queryKey: ["company-deals"] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["contact"] });
      toast.success("Empresa excluída");
      setDeleting(null);
    },
    onError: (e: Error) => toast.error(e.message ?? "Erro ao excluir"),
  });

  return (
    <div className="col-span-12 flex flex-col gap-4">
      <PageHeader
        title="Empresas"
        description={
          companiesQuery.isLoading ? "Carregando…" : `${companies.length} empresas na base`
        }
        actions={
          <Button onClick={() => setOpenNew(true)}>
            <Plus className="mr-1 h-4 w-4" /> Nova empresa
          </Button>
        }
      />

      <div className="flex items-center gap-3 rounded-lg border border-border bg-surface p-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
          <Input
            aria-label="Buscar empresas"
            placeholder="Buscar por nome, setor ou website…"
            className="pl-8"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>

      <div className="rounded-lg border border-border bg-surface">
        {companiesQuery.isLoading ? (
          <div className="p-4 space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-8 w-8 rounded-full" />
                <Skeleton className="h-4 flex-1" />
              </div>
            ))}
          </div>
        ) : companiesQuery.isError ? (
          <div className="p-6">
            <EmptyState
              title="Erro ao carregar empresas"
              description={(companiesQuery.error as Error).message}
              actionLabel="Tentar novamente"
              onAction={() => companiesQuery.refetch()}
            />
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={Building2}
              title={
                companies.length === 0 ? "Nenhuma empresa ainda" : "Nenhuma empresa encontrada"
              }
              description={
                companies.length === 0
                  ? "Comece adicionando sua primeira empresa."
                  : "Ajuste a busca para tentar de novo."
              }
              actionLabel={companies.length === 0 ? "Nova empresa" : "Limpar busca"}
              onAction={companies.length === 0 ? () => setOpenNew(true) : () => setQ("")}
            />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome</TableHead>
                <TableHead>Setor</TableHead>
                <TableHead>Website</TableHead>
                <TableHead>Criada em</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((c) => (
                <TableRow key={c.id} className="cursor-pointer" tabIndex={0}>
                  <TableCell>
                    <Link
                      to="/empresas/$id"
                      params={{ id: c.id }}
                      className="flex items-center gap-2 font-medium text-foreground hover:underline"
                    >
                      <Building2 className="h-4 w-4 text-muted-foreground" />
                      {c.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{c.industry || "—"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {c.website ? (
                      <a
                        href={c.website}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {c.website} <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(c.created_at)}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Excluir ${c.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleting(c);
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <CompanyFormDialog open={openNew} onOpenChange={setOpenNew} />

      <AlertDialog open={!!deleting} onOpenChange={(v) => !v && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir empresa</AlertDialogTitle>
            <AlertDialogDescription>
              Tem certeza que deseja excluir <strong>{deleting?.name}</strong>? Os contatos
              vinculados não são apagados, só perdem o vínculo com esta empresa nas listas.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleting && deleteMut.mutate(deleting.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
