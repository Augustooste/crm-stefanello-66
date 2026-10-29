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
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile } from "@/lib/api/session";

export type CompanyRow = {
  id: string;
  tenant_id: string;
  name: string;
  industry: string | null;
  website: string | null;
  created_at: string;
};

const schema = z.object({
  name: z.string().min(1, "Nome é obrigatório"),
  industry: z.string().optional(),
  website: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

export function CompanyFormDialog({
  open,
  onOpenChange,
  company,
  defaultName,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  company?: CompanyRow;
  // Preenche o nome ao abrir em modo criação (ex.: texto digitado no
  // combobox de empresas do ContactFormDialog) -- só se aplica quando
  // `company` está ausente (edição sempre usa o nome do registro).
  defaultName?: string;
  // Chamado com a empresa recém-criada -- o combobox de empresas usa isto
  // para selecionar automaticamente a empresa que acabou de criar inline.
  onCreated?: (company: CompanyRow) => void;
}) {
  const { data: profile } = useCurrentProfile();
  const qc = useQueryClient();
  const editing = !!company;

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: company?.name ?? defaultName ?? "",
      industry: company?.industry ?? "",
      website: company?.website ?? "",
    },
  });

  useEffect(() => {
    if (open) {
      reset({
        name: company?.name ?? defaultName ?? "",
        industry: company?.industry ?? "",
        website: company?.website ?? "",
      });
    }
  }, [open, company, defaultName, reset]);

  const mutation = useMutation({
    mutationFn: async (data: FormValues) => {
      if (!profile) throw new Error("Sessão inválida");
      const payload = {
        name: data.name,
        industry: data.industry || null,
        website: data.website || null,
      };
      if (editing && company) {
        const { error } = await supabase.from("crm_companies").update(payload).eq("id", company.id);
        if (error) throw error;
        return { ...company, ...payload };
      }
      const { data: created, error } = await supabase
        .from("crm_companies")
        .insert({ ...payload, tenant_id: profile.tenant_id })
        .select("id, tenant_id, name, industry, website, created_at")
        .single();
      if (error) throw error;
      return created as CompanyRow;
    },
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["companies"] });
      qc.invalidateQueries({ queryKey: ["companies-lite"] });
      qc.invalidateQueries({ queryKey: ["company", company?.id] });
      toast.success(editing ? "Empresa atualizada" : "Empresa criada");
      onOpenChange(false);
      if (!editing) onCreated?.(result);
    },
    onError: (e: Error) => toast.error(e.message ?? "Erro ao salvar"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Editar empresa" : "Nova empresa"}</DialogTitle>
          <DialogDescription>Preencha as informações da empresa.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="company-name">Nome *</Label>
            <Input id="company-name" {...register("name")} aria-invalid={!!errors.name} />
            {errors.name && <p className="text-caption text-destructive">{errors.name.message}</p>}
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="company-industry">Setor</Label>
              <Input
                id="company-industry"
                {...register("industry")}
                placeholder="Ex.: Tecnologia"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="company-website">Website</Label>
              <Input
                id="company-website"
                {...register("website")}
                placeholder="https://empresa.com"
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? "Salvando…" : editing ? "Salvar" : "Criar empresa"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
