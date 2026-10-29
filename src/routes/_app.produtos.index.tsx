import { useMemo, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Package, Plus, Search, Trash2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { PageHeader } from "@/components/common/PageHeader";
import { EmptyState } from "@/components/common/EmptyState";
import { ProductFormDialog, type ProductRow } from "@/components/products/ProductFormDialog";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
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
import { formatBRL } from "@/lib/format";

export const Route = createFileRoute("/_app/produtos/")({
  head: () => ({
    meta: [
      { title: "Produtos" },
      {
        name: "description",
        content: "Catálogo de produtos e serviços: preço, duração e SKU num só lugar.",
      },
    ],
  }),
  component: ProductsPage,
});

/** "90 min" -- sem conversão pra "1h30" (MVP, produto raramente passa de horas exatas). */
function formatDuration(minutes: number | null): string {
  return minutes != null ? `${minutes} min` : "—";
}

const PRODUCTS_QUERY_KEY = ["products"] as const;

function ProductsPage() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [openNew, setOpenNew] = useState(false);
  // Confirmação só faz sentido pra DESATIVAR (esconde o produto como opção
  // ativa pra toda a equipe) -- reativar é inócuo e chama a mutation direto,
  // sem diálogo (pedir confirmação pra ação sem risco só ensina a clicar
  // "sim" no automático).
  const [deactivating, setDeactivating] = useState<ProductRow | null>(null);
  const [deleting, setDeleting] = useState<ProductRow | null>(null);

  const productsQuery = useQuery({
    queryKey: PRODUCTS_QUERY_KEY,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("crm_products")
        .select(
          "id, tenant_id, name, description, price, duration_minutes, sku, active, created_at",
        )
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as ProductRow[];
    },
  });

  const products = productsQuery.data ?? [];

  // Depende de `productsQuery.data` (referência estável entre renders), não
  // de `products` (fallback `?? []` cria array novo a cada render e
  // invalidaria a memoização) -- mesmo padrão de `_app.empresas.tsx`.
  const filtered = useMemo(() => {
    const list = productsQuery.data ?? [];
    const t = q.trim().toLowerCase();
    if (!t) return list;
    return list.filter((p) =>
      [p.name, p.sku ?? "", p.description ?? ""].some((v) => v.toLowerCase().includes(t)),
    );
  }, [productsQuery.data, q]);

  const toggleActiveMut = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      const { error } = await supabase.from("crm_products").update({ active }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: PRODUCTS_QUERY_KEY }),
    onError: (e: Error) => toast.error(e.message ?? "Erro ao atualizar produto"),
  });

  // Reativar chama a mutation direto; desativar abre confirmação antes.
  const handleToggleActive = (product: ProductRow, active: boolean) => {
    if (active) {
      toggleActiveMut.mutate({ id: product.id, active: true });
    } else {
      setDeactivating(product);
    }
  };

  // Delete físico -- crm_products ainda não é referenciado por nenhuma outra
  // tabela nesta versão (deal_items é fora de escopo v1, ver comentário em
  // supabase/migrations/20260714150000_crm_products_v1.sql), então não há
  // cascade nem histórico de negócio associado a preservar. Se/quando
  // deal_items existir, revisitar -- delete físico pode passar a exigir
  // checagem de uso antes (mesmo critério de contatos/etapas).
  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("crm_products").delete().eq("id", id);
      if (error) throw error;
      return id;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PRODUCTS_QUERY_KEY });
      toast.success("Produto excluído");
      setDeleting(null);
    },
    onError: (e: Error) => toast.error(e.message ?? "Erro ao excluir"),
  });

  return (
    <div className="col-span-12 flex flex-col gap-4">
      <PageHeader
        title="Produtos"
        description={
          productsQuery.isLoading ? "Carregando…" : `${products.length} produtos no catálogo`
        }
        actions={
          <Button onClick={() => setOpenNew(true)}>
            <Plus className="mr-1 h-4 w-4" /> Novo produto
          </Button>
        }
      />

      <div className="flex items-center gap-3 rounded-lg border border-border bg-surface p-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
          <Input
            aria-label="Buscar produtos"
            placeholder="Buscar por nome, SKU ou descrição…"
            className="pl-8"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>

      <div className="rounded-lg border border-border bg-surface">
        {productsQuery.isLoading ? (
          <div className="p-4 space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-8 w-8 rounded-full" />
                <Skeleton className="h-4 flex-1" />
              </div>
            ))}
          </div>
        ) : productsQuery.isError ? (
          <div className="p-6">
            <EmptyState
              title="Erro ao carregar produtos"
              description={(productsQuery.error as Error).message}
              actionLabel="Tentar novamente"
              onAction={() => productsQuery.refetch()}
            />
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={Package}
              title={products.length === 0 ? "Nenhum produto ainda" : "Nenhum produto encontrado"}
              description={
                products.length === 0
                  ? "Comece adicionando seu primeiro produto ou serviço."
                  : "Ajuste a busca para tentar de novo."
              }
              actionLabel={products.length === 0 ? "Novo produto" : "Limpar busca"}
              onAction={products.length === 0 ? () => setOpenNew(true) : () => setQ("")}
            />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>Preço</TableHead>
                <TableHead>Duração</TableHead>
                <TableHead className="w-20">Ativo</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <Link
                      to="/produtos/$id"
                      params={{ id: p.id }}
                      className="flex items-center gap-2 font-medium text-foreground hover:underline"
                    >
                      <Package className="h-4 w-4 text-muted-foreground" />
                      {p.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{p.sku || "—"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {p.price != null ? formatBRL(p.price) : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDuration(p.duration_minutes)}
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={p.active}
                      disabled={toggleActiveMut.isPending}
                      aria-label={`${p.active ? "Desativar" : "Ativar"} ${p.name}`}
                      onCheckedChange={(checked) => handleToggleActive(p, checked)}
                    />
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Excluir ${p.name}`}
                      onClick={() => setDeleting(p)}
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

      <ProductFormDialog open={openNew} onOpenChange={setOpenNew} />

      <AlertDialog open={!!deactivating} onOpenChange={(v) => !v && setDeactivating(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Desativar produto</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{deactivating?.name}</strong> ficará marcado como inativo para toda a equipe.
              Ele continua no catálogo e pode ser reativado a qualquer momento.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                deactivating &&
                toggleActiveMut.mutate(
                  { id: deactivating.id, active: false },
                  // onSettled, não onSuccess -- se der erro o toast já avisa,
                  // mas o diálogo não pode ficar preso aberto (usuário clicaria
                  // "Desativar" de novo em cima do próprio erro).
                  { onSettled: () => setDeactivating(null) },
                )
              }
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Desativar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleting} onOpenChange={(v) => !v && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir produto</AlertDialogTitle>
            <AlertDialogDescription>
              Tem certeza que deseja excluir <strong>{deleting?.name}</strong>? Nesta versão o
              catálogo ainda não está vinculado a negócios ou vendas, então nada mais é afetado.
              Esta ação não pode ser desfeita.
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
