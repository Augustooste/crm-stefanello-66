import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Pencil, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/common/EmptyState";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { useCurrentProfile } from "@/lib/api/session";
import { userFacingErrorMessage } from "@/lib/integrations/friendly-errors";

type Tag = { id: string; name: string; color: string };
type ContactTagsRow = { id: string; tags: string[] };

const PRESET_COLORS = [
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#22c55e",
  "#10b981",
  "#3b82f6",
  "#6366f1",
  "#a855f7",
  "#ec4899",
  "#64748b",
];

export function TagsTab() {
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id;
  const qc = useQueryClient();
  const [openForm, setOpenForm] = useState<{ tag?: Tag } | null>(null);
  const [deleting, setDeleting] = useState<Tag | null>(null);

  const tagsQ = useQuery({
    queryKey: ["tags", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase.from("tags").select("id, name, color").order("name");
      if (error) throw error;
      return (data ?? []) as Tag[];
    },
  });

  const deleteMut = useMutation({
    mutationFn: async (tag: Tag) => {
      if (!tenantId) throw new Error("Tenant inválido");
      // Remove tag name from all contacts.tags arrays (contatos fundidos/removidos
      // não precisam dessa limpeza -- evita escrita à toa em registros mortos)
      const { data: affected, error: selErr } = await supabase
        .from("contacts")
        .select("id, tags")
        .is("deleted_at", null)
        .contains("tags", [tag.name]);
      if (selErr) throw selErr;
      const rows = (affected ?? []) as ContactTagsRow[];
      for (const c of rows) {
        const nextTags = (c.tags ?? []).filter((t) => t !== tag.name);
        const { error: upErr } = await supabase
          .from("contacts")
          .update({ tags: nextTags })
          .eq("id", c.id);
        if (upErr) throw upErr;
      }
      const { error } = await supabase.from("tags").delete().eq("id", tag.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tags"] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
      toast.success("Etiqueta removida");
      setDeleting(null);
    },
    onError: (e: Error) => toast.error(userFacingErrorMessage(e, "Erro ao remover")),
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-card-title">Etiquetas</CardTitle>
        <Button size="sm" onClick={() => setOpenForm({})}>
          <Plus className="mr-1 h-4 w-4" /> Nova etiqueta
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {tagsQ.isLoading ? (
          <div className="p-4">
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (tagsQ.data ?? []).length === 0 ? (
          <div className="p-6">
            <EmptyState
              title="Sem etiquetas"
              description="Crie etiquetas para organizar seus contatos."
            />
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {tagsQ.data!.map((t) => (
              <li key={t.id} className="flex items-center gap-3 p-3">
                <span
                  className="inline-block h-4 w-4 rounded-full border border-border"
                  style={{ backgroundColor: t.color }}
                  aria-hidden
                />
                <span className="flex-1 text-body font-medium text-foreground">{t.name}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Editar ${t.name}`}
                  onClick={() => setOpenForm({ tag: t })}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Excluir ${t.name}`}
                  onClick={() => setDeleting(t)}
                >
                  <Trash2 className="h-4 w-4 text-muted-foreground" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {openForm && (
        <TagFormDialog
          open={!!openForm}
          onOpenChange={(v) => !v && setOpenForm(null)}
          tag={openForm.tag}
          tenantId={tenantId!}
        />
      )}

      <AlertDialog open={!!deleting} onOpenChange={(v) => !v && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir etiqueta</AlertDialogTitle>
            <AlertDialogDescription>
              A etiqueta <strong>{deleting?.name}</strong> será removida de todos os contatos que a
              utilizam. Esta ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleting && deleteMut.mutate(deleting)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMut.isPending ? "Removendo…" : "Excluir"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function TagFormDialog({
  open,
  onOpenChange,
  tag,
  tenantId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  tag?: Tag;
  tenantId: string;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(tag?.name ?? "");
  const [color, setColor] = useState(tag?.color ?? PRESET_COLORS[0]);

  const saveMut = useMutation({
    mutationFn: async () => {
      const payload = { name: name.trim(), color };
      if (tag) {
        // If renamed, propagate to contacts.tags (contatos fundidos/removidos
        // não precisam dessa limpeza -- evita escrita à toa em registros mortos)
        if (payload.name !== tag.name) {
          const { data: affected, error: selErr } = await supabase
            .from("contacts")
            .select("id, tags")
            .is("deleted_at", null)
            .contains("tags", [tag.name]);
          if (selErr) throw selErr;
          for (const c of (affected ?? []) as ContactTagsRow[]) {
            const next = Array.from(
              new Set((c.tags ?? []).map((t) => (t === tag.name ? payload.name : t))),
            );
            const { error: upErr } = await supabase
              .from("contacts")
              .update({ tags: next })
              .eq("id", c.id);
            if (upErr) throw upErr;
          }
        }
        const { error } = await supabase.from("tags").update(payload).eq("id", tag.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("tags").insert({ ...payload, tenant_id: tenantId });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tags"] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
      toast.success(tag ? "Etiqueta atualizada" : "Etiqueta criada");
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(userFacingErrorMessage(e, "Erro ao salvar")),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{tag ? "Editar etiqueta" : "Nova etiqueta"}</DialogTitle>
          <DialogDescription>Defina nome e cor.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="tag-name">Nome *</Label>
            <Input id="tag-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Cor</Label>
            <div className="flex flex-wrap gap-2">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  aria-label={`Selecionar cor ${c}`}
                  className={`h-7 w-7 rounded-full border-2 ${color === c ? "border-foreground" : "border-transparent"}`}
                  style={{ backgroundColor: c }}
                />
              ))}
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                aria-label="Cor personalizada"
                className="h-7 w-7 cursor-pointer rounded border border-border"
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button disabled={!name.trim() || saveMut.isPending} onClick={() => saveMut.mutate()}>
            {saveMut.isPending ? "Salvando…" : "Salvar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
