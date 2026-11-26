import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";

const nf = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
export const formatCreditNumber = (value: number | null | undefined) => nf.format(value ?? 0);
const TERMS = [7, 14, 21, 28];
const STATUS_LABELS: Record<string, string> = {
  ativo: "Ativo",
  inadimplente: "Inadimplente",
  liberado: "Liberado",
  cancelado: "Cancelado",
};

export function canOfferCommercialCredit(condition: string | null, hasActiveGrant: boolean, hasAllowance: boolean) {
  return !hasActiveGrant && hasAllowance && (condition === "a_vista" || condition === "sem_aprovacao");
}

const errMsg = (e: unknown) => (e as { message?: string })?.message || "Não foi possível concluir a ação";

export function DealCommercialCreditSection({
  dealId,
  creditCondition,
  canManage,
}: {
  dealId: string;
  creditCondition: string | null;
  canManage: boolean;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [terms, setTerms] = useState<number[]>([]);
  const [notes, setNotes] = useState("");

  const grantQuery = useQuery({
    queryKey: ["commercial-credit-grant", dealId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("commercial_credit_grants")
        .select("id, amount, payment_terms_days, status, granted_at, granter:profiles!commercial_credit_grants_granted_by_fkey(name)")
        .eq("deal_id", dealId)
        .in("status", ["ativo", "inadimplente"])
        .order("granted_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const allowanceQuery = useQuery({
    queryKey: ["commercial-credit-allowance-me"],
    queryFn: async () => {
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) return null;
      const { data, error } = await supabase
        .from("v_stef_credit_allowance_usage")
        .select("*")
        .eq("profile_id", auth.user.id)
        .eq("active", true)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["commercial-credit-grant", dealId] });
    qc.invalidateQueries({ queryKey: ["commercial-credit-allowance-me"] });
    qc.invalidateQueries({ queryKey: ["deals"] });
  };

  const grant = useMutation({
    mutationFn: async () => {
      const value = Number(amount);
      if (!Number.isInteger(value) || value <= 0) throw new Error("Informe um valor inteiro maior que zero.");
      const { error } = await supabase.rpc("grant_commercial_credit", {
        p_deal_id: dealId,
        p_amount: value,
        p_payment_terms_days: terms,
        p_notes: notes.trim() || null,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Crédito comercial concedido");
      setOpen(false);
      setAmount("");
      setTerms([]);
      setNotes("");
      refresh();
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  const update = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const { error } = await supabase.rpc("update_commercial_credit_grant", {
        p_grant_id: id,
        p_status: status,
        p_reason: null,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Crédito comercial atualizado");
      refresh();
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  const g = grantQuery.data;
  const a = allowanceQuery.data;
  const granter = (g?.granter as { name?: string } | null)?.name ?? "—";
  const showOffer = canOfferCommercialCredit(creditCondition, !!g, !!a);

  return (
    <section className="mt-4 space-y-2 border-t border-border pt-3" aria-label="Crédito comercial">
      <h3 className="text-body font-semibold text-foreground">Crédito comercial</h3>
      {g ? (
        <>
          <p className="text-caption">
            R$ {formatCreditNumber(g.amount)} · prazo {(g.payment_terms_days ?? []).join("/") || "—"} dias · concedido por {granter} em{" "}
            {new Date(g.granted_at).toLocaleDateString("pt-BR")} · {STATUS_LABELS[g.status] ?? g.status}
          </p>
          {canManage && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={update.isPending} onClick={() => update.mutate({ id: g.id, status: "liberado" })}>Liberar</Button>
              {g.status !== "inadimplente" && (
                <Button size="sm" variant="outline" disabled={update.isPending} onClick={() => update.mutate({ id: g.id, status: "inadimplente" })}>Marcar inadimplente</Button>
              )}
              <Button size="sm" variant="outline" disabled={update.isPending} onClick={() => update.mutate({ id: g.id, status: "cancelado" })}>Cancelar</Button>
            </div>
          )}
        </>
      ) : showOffer ? (
        <Button size="sm" className="w-full" onClick={() => setOpen(true)}>Conceder crédito comercial</Button>
      ) : (
        <p className="text-caption text-muted-foreground">Nenhum crédito comercial ativo</p>
      )}

      {a && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Conceder crédito comercial</DialogTitle>
            </DialogHeader>
            <p className="text-caption text-muted-foreground">
              Disponível: R$ {formatCreditNumber(a.available_amount)} de R$ {formatCreditNumber(a.budget_total)} ·{" "}
              {formatCreditNumber(a.active_clients)} de {formatCreditNumber(a.max_clients)} clientes
            </p>
            <p className="text-caption text-muted-foreground">Máximo por cliente: R$ {formatCreditNumber(a.max_per_client)}</p>
            <div className="space-y-1.5">
              <Label htmlFor={`cc-amount-${dealId}`}>Valor (R$, inteiro)</Label>
              <Input id={`cc-amount-${dealId}`} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))} />
            </div>
            <fieldset className="space-y-1.5">
              <legend className="text-sm font-medium">Prazos (dias)</legend>
              <div className="flex flex-wrap gap-3">
                {TERMS.map((d) => (
                  <label key={d} className="flex items-center gap-1.5 text-caption">
                    <input
                      type="checkbox"
                      checked={terms.includes(d)}
                      onChange={(e) => setTerms((c) => (e.target.checked ? [...c, d].sort((x, y) => x - y) : c.filter((v) => v !== d)))}
                    />
                    {d}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="space-y-1.5">
              <Label htmlFor={`cc-notes-${dealId}`}>Observação</Label>
              <Textarea id={`cc-notes-${dealId}`} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
            <DialogFooter>
              <Button disabled={grant.isPending} onClick={() => grant.mutate()}>{grant.isPending ? "Concedendo…" : "Confirmar"}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}
