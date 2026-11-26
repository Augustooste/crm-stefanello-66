import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { formatBRL, formatDate } from "@/lib/format";

export type CreditCondition = "a_vista" | "credito_aprovado" | "sem_aprovacao";

export type DealCredit = {
  id: string;
  credit_condition: CreditCondition | null;
  credit_limit: number | null;
  payment_terms_days: number[];
  credit_notes: string | null;
  credit_evaluated_at: string | null;
};

export const CREDIT_CONDITION_LABELS: Record<CreditCondition, string> = {
  a_vista: "À vista (sem crédito)",
  credito_aprovado: "Crédito aprovado",
  sem_aprovacao: "Sem aprovação (não pode comprar)",
};

const PAYMENT_TERM_OPTIONS = [7, 14, 21, 28];

export function DealCreditSection({ deal, canEdit }: { deal: DealCredit; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [condition, setCondition] = useState<CreditCondition | "">(deal.credit_condition ?? "");
  const [limit, setLimit] = useState(deal.credit_limit?.toString() ?? "");
  const [terms, setTerms] = useState<number[]>(deal.payment_terms_days ?? []);
  const [notes, setNotes] = useState(deal.credit_notes ?? "");

  useEffect(() => {
    setCondition(deal.credit_condition ?? "");
    setLimit(deal.credit_limit?.toString() ?? "");
    setTerms(deal.payment_terms_days ?? []);
    setNotes(deal.credit_notes ?? "");
  }, [deal.id, deal.credit_condition, deal.credit_limit, deal.payment_terms_days, deal.credit_notes]);

  const save = useMutation({
    mutationFn: async () => {
      const parsedLimit = limit.trim() === "" ? null : Number(limit);
      if (parsedLimit !== null && (!Number.isInteger(parsedLimit) || parsedLimit < 0)) {
        throw new Error("Informe um limite inteiro maior ou igual a zero.");
      }
      const { error } = await supabase
        .from("deals")
        .update({
          credit_condition: condition || null,
          credit_limit: parsedLimit,
          payment_terms_days: terms,
          credit_notes: notes.trim() || null,
        })
        .eq("id", deal.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["deals"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["pipeline-activities"] });
      toast.success("Crédito atualizado");
    },
    onError: (error: Error) => toast.error(error.message || "Não foi possível salvar o crédito"),
  });

  return (
    <section className="mt-4 space-y-3 border-t border-border pt-3" aria-label="Avaliação de crédito">
      <div>
        <h3 className="text-body font-semibold text-foreground">Crédito</h3>
        {!canEdit && <p className="text-caption text-muted-foreground">Somente leitura</p>}
      </div>

      {canEdit ? (
        <>
          <div className="space-y-1.5">
            <Label>Condição</Label>
            <Select value={condition} onValueChange={(value) => setCondition(value as CreditCondition)}>
              <SelectTrigger aria-label="Condição de crédito">
                <SelectValue placeholder="Selecione a condição" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(CREDIT_CONDITION_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`credit-limit-${deal.id}`}>Limite (R$, inteiro)</Label>
            <Input
              id={`credit-limit-${deal.id}`}
              inputMode="numeric"
              value={limit}
              onChange={(event) => setLimit(event.target.value.replace(/\D/g, ""))}
              placeholder="0"
            />
          </div>
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">Prazos de pagamento (dias)</legend>
            <div className="flex flex-wrap gap-2">
              {PAYMENT_TERM_OPTIONS.map((days) => (
                <label key={days} className="flex items-center gap-1.5 text-caption">
                  <input
                    type="checkbox"
                    checked={terms.includes(days)}
                    onChange={(event) =>
                      setTerms((current) =>
                        event.target.checked
                          ? [...current, days].sort((a, b) => a - b)
                          : current.filter((value) => value !== days),
                      )
                    }
                  />
                  {days}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="space-y-1.5">
            <Label htmlFor={`credit-notes-${deal.id}`}>Observações</Label>
            <Textarea
              id={`credit-notes-${deal.id}`}
              rows={2}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
          <Button size="sm" className="w-full" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Salvando…" : "Salvar crédito"}
          </Button>
        </>
      ) : (
        <dl className="space-y-2 text-caption">
          <div><dt className="text-muted-foreground">Condição</dt><dd>{deal.credit_condition ? CREDIT_CONDITION_LABELS[deal.credit_condition] : "Não avaliado"}</dd></div>
          <div><dt className="text-muted-foreground">Limite</dt><dd>{deal.credit_limit === null ? "—" : formatBRL(deal.credit_limit)}</dd></div>
          <div><dt className="text-muted-foreground">Prazos</dt><dd>{deal.payment_terms_days.length ? `${deal.payment_terms_days.join(", ")} dias` : "—"}</dd></div>
          {deal.credit_notes && <div><dt className="text-muted-foreground">Observações</dt><dd>{deal.credit_notes}</dd></div>}
        </dl>
      )}
      {deal.credit_evaluated_at && (
        <p className="text-caption text-muted-foreground">Avaliado em {formatDate(deal.credit_evaluated_at)}</p>
      )}
    </section>
  );
}
