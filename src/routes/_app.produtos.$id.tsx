import { useState } from "react";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { ArrowLeft, Clock, DollarSign, Package, Pencil, Tag } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { PageHeader } from "@/components/common/PageHeader";
import { EmptyState } from "@/components/common/EmptyState";
import { StatusBadge } from "@/components/common/StatusBadge";
import { ProductFormDialog, type ProductRow } from "@/components/products/ProductFormDialog";
import { requirePluginActive } from "@/lib/api/plugins";
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
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { formatBRL, formatDate } from "@/lib/format";

export const Route = createFileRoute("/_app/produtos/$id")({
  beforeLoad: ({ context }) => requirePluginActive(context.queryClient, "catalogo"),
  head: () => ({
    meta: [
      { title: "Produto" },
      { name: "description", content: "Detalhes do produto ou serviço do catálogo." },
    ],
  }),
  component: ProductDetail,
  notFoundComponent: () => (
    <div className="col-span-12">
      <EmptyState title="Produto não encontrado" description="Este produto não existe mais." />
    </div>
  ),
});

const PRODUCT_SELECT =
  "id, tenant_id, name, description, price, duration_minutes, sku, active, created_at";

function ProductDetail() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const [openEdit, setOpenEdit] = useState(false);
  // Mesmo critério da listagem (_app.produtos.index.tsx): confirmar só ao
  // DESATIVAR, nunca ao reativar.
  const [confirmingDeactivate, setConfirmingDeactivate] = useState(false);

  const productQuery = useQuery({
    queryKey: ["product", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("crm_products")
        .select(PRODUCT_SELECT)
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      return (data as ProductRow) ?? null;
    },
  });

  const toggleActiveMut = useMutation({
    mutationFn: async (active: boolean) => {
      const { error } = await supabase.from("crm_products").update({ active }).eq("id", id);
      if (error) throw error;
      return active;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["product", id] });
      qc.invalidateQueries({ queryKey: ["products"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "Erro ao atualizar produto"),
    // onSettled, não só onSuccess -- se der erro o toast já avisa, mas o
    // diálogo de confirmação não pode ficar preso aberto (usuário clicaria
    // "Desativar" de novo em cima do próprio erro).
    onSettled: () => setConfirmingDeactivate(false),
  });

  // Reativar chama a mutation direto; desativar abre confirmação antes.
  const handleToggleActive = (active: boolean) => {
    if (active) {
      toggleActiveMut.mutate(true);
    } else {
      setConfirmingDeactivate(true);
    }
  };

  if (productQuery.isLoading) {
    return (
      <div className="col-span-12 space-y-3">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const product = productQuery.data;
  if (!product) throw notFound();

  return (
    <div className="col-span-12 flex flex-col gap-4">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2">
          <Link to="/produtos">
            <ArrowLeft className="mr-1 h-4 w-4" /> Produtos
          </Link>
        </Button>
        <PageHeader
          title={
            <span className="flex items-center gap-2">
              <Avatar className="h-9 w-9">
                <AvatarFallback className="bg-primary/10 text-primary">
                  <Package className="h-4 w-4" />
                </AvatarFallback>
              </Avatar>
              {product.name}
            </span>
          }
          description={product.sku ? `SKU: ${product.sku}` : undefined}
          actions={
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <Switch
                  checked={product.active}
                  disabled={toggleActiveMut.isPending}
                  aria-label={product.active ? "Desativar produto" : "Ativar produto"}
                  onCheckedChange={handleToggleActive}
                />
                <StatusBadge variant={product.active ? "success" : "neutral"}>
                  {product.active ? "Ativo" : "Inativo"}
                </StatusBadge>
              </div>
              <Button variant="outline" onClick={() => setOpenEdit(true)}>
                <Pencil className="mr-1 h-4 w-4" /> Editar
              </Button>
            </div>
          }
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-caption font-medium text-muted-foreground">Preço</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-card-title font-semibold text-foreground">
              {product.price != null ? formatBRL(product.price) : "—"}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-caption font-medium text-muted-foreground">
              Duração
            </CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-card-title font-semibold text-foreground">
              {product.duration_minutes != null ? `${product.duration_minutes} min` : "—"}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-card-title">
            <Tag className="h-4 w-4 text-muted-foreground" /> Descrição
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="whitespace-pre-wrap text-body text-foreground">
            {product.description || "Sem descrição."}
          </p>
        </CardContent>
      </Card>

      <p className="text-caption text-muted-foreground">
        Produto criado em {formatDate(product.created_at)}.
      </p>

      <ProductFormDialog open={openEdit} onOpenChange={setOpenEdit} product={product} />

      <AlertDialog open={confirmingDeactivate} onOpenChange={setConfirmingDeactivate}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Desativar produto</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{product.name}</strong> ficará marcado como inativo para toda a equipe. Ele
              continua no catálogo e pode ser reativado a qualquer momento.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => toggleActiveMut.mutate(false)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Desativar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
