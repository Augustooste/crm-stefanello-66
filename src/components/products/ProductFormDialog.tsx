import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile } from "@/lib/api/session";

export type ProductRow = {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  price: number | null;
  duration_minutes: number | null;
  sku: string | null;
  active: boolean;
  created_at: string;
};

const schema = z.object({
  name: z.string().min(1, "Nome é obrigatório"),
  description: z.string().optional(),
  price: z.string().optional(),
  duration_minutes: z.string().optional(),
  sku: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

// Parsing de moeda pt-BR: "." é sempre separador de milhar, "," é sempre o
// decimal (convenção BRL -- o placeholder do campo é "0,00"). Remove todo "."
// antes de trocar a "," decimal por ".", em vez de só trocar a primeira
// ocorrência -- isso é o que fazia "1.500" virar 1.5 (erro de 1000x) e
// "1.500,00" virar null (vírgula nunca chegava a ser trocada porque o "."
// anterior já tinha virado ".", gerando "1.500.00" = NaN). Entrada sem
// nenhum dígito (ex.: "abc") retorna null explicitamente -- Number("") é 0,
// não NaN, então sem esse guard um valor não numérico virava preço R$ 0
// silenciosamente.
function parsePrice(raw?: string): number | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const digitsOnly = trimmed.replace(/[^\d.,]/g, "");
  if (!digitsOnly) return null;
  const numeric = Number(digitsOnly.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(numeric) ? numeric : null;
}

// Mesma convenção de separador de parsePrice (só "," é decimal), arredondada
// pro minuto inteiro -- duration_minutes é integer. "60,00" virava 6000
// porque o parsing antigo removia TODOS os caracteres não-dígito (inclusive
// a vírgula) e concatenava os dígitos restantes, em vez de interpretar a
// vírgula como decimal.
function parseDuration(raw?: string): number | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const digitsOnly = trimmed.replace(/[^\d.,]/g, "");
  if (!digitsOnly) return null;
  const numeric = Number(digitsOnly.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(numeric) ? Math.round(numeric) : null;
}

export function ProductFormDialog({
  open,
  onOpenChange,
  product,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  product?: ProductRow;
}) {
  const { data: profile } = useCurrentProfile();
  const qc = useQueryClient();
  const editing = !!product;

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: product?.name ?? "",
      description: product?.description ?? "",
      price: product?.price != null ? String(product.price) : "",
      duration_minutes: product?.duration_minutes != null ? String(product.duration_minutes) : "",
      sku: product?.sku ?? "",
    },
  });

  useEffect(() => {
    if (open) {
      reset({
        name: product?.name ?? "",
        description: product?.description ?? "",
        price: product?.price != null ? String(product.price) : "",
        duration_minutes: product?.duration_minutes != null ? String(product.duration_minutes) : "",
        sku: product?.sku ?? "",
      });
    }
  }, [open, product, reset]);

  const mutation = useMutation({
    mutationFn: async (data: FormValues) => {
      if (!profile) throw new Error("Sessão inválida");
      const payload = {
        name: data.name,
        description: data.description || null,
        price: parsePrice(data.price),
        duration_minutes: parseDuration(data.duration_minutes),
        sku: data.sku || null,
      };
      if (editing && product) {
        const { error } = await supabase.from("crm_products").update(payload).eq("id", product.id);
        if (error) throw error;
        return { ...product, ...payload };
      }
      const { data: created, error } = await supabase
        .from("crm_products")
        .insert({ ...payload, tenant_id: profile.tenant_id })
        .select(
          "id, tenant_id, name, description, price, duration_minutes, sku, active, created_at",
        )
        .single();
      if (error) throw error;
      return created as ProductRow;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["product", product?.id] });
      toast.success(editing ? "Produto atualizado" : "Produto criado");
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message ?? "Erro ao salvar"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Editar produto" : "Novo produto"}</DialogTitle>
          <DialogDescription>
            Preencha os dados do produto ou serviço. Preço e duração são opcionais -- deixe em
            branco o que não se aplicar.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="product-name">Nome *</Label>
            <Input id="product-name" {...register("name")} aria-invalid={!!errors.name} />
            {errors.name && <p className="text-caption text-destructive">{errors.name.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="product-description">Descrição</Label>
            <Textarea
              id="product-description"
              {...register("description")}
              placeholder="Detalhes do produto ou serviço"
              rows={3}
            />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="product-price">Preço (R$)</Label>
              <Input
                id="product-price"
                inputMode="decimal"
                {...register("price")}
                placeholder="0,00"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="product-duration">Duração (min)</Label>
              <Input
                id="product-duration"
                inputMode="numeric"
                {...register("duration_minutes")}
                placeholder="Ex.: 60"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="product-sku">SKU</Label>
              <Input id="product-sku" {...register("sku")} placeholder="Opcional" />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? "Salvando…" : editing ? "Salvar" : "Criar produto"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
