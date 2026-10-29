import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, FileSignature, Loader2, Save } from "lucide-react";
import { toast } from "sonner";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DEFAULT_ASSUMPTIONS,
  fetchProposal,
  saveProposalAssumptions,
  type ProposalAssumptions,
  type ProposalView,
} from "@/lib/api/proposal";
import {
  computeBusinessCase,
  fmtBRL,
  fmtNumber,
  fmtPercent,
  parseDecimalBR,
} from "@/lib/business-case";
import { buildProposalSections } from "@/lib/proposal-draft";

export interface ProposalTarget {
  id: string;
  title: string;
}

interface ProposalSheetProps {
  /** null = fechado. */
  deal: ProposalTarget | null;
  onOpenChange: (open: boolean) => void;
}

export const SIMULATION_DISCLAIMER =
  "Os valores acima são uma simulação baseada em premissas ajustáveis e não representam economia garantida.";

/**
 * "Proposta (simulação)": o que a proposta seria SE a oportunidade chegasse à
 * etapa de proposta. Fatos vêm do CRM, texto vem da reunião gravada e de
 * seções fixas, números vêm de business-case.ts. Não move o negócio de
 * estágio e não envia nada.
 */
export function ProposalSheet({ deal, onOpenChange }: ProposalSheetProps) {
  const query = useQuery({
    queryKey: ["proposal", deal?.id],
    queryFn: () => fetchProposal(deal!.id),
    enabled: !!deal,
    retry: false,
    throwOnError: false,
  });

  return (
    <Sheet open={!!deal} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
        <SheetHeader className="border-b border-border px-5 py-4 text-left">
          <SheetTitle className="flex items-center gap-2">
            <FileSignature className="h-4 w-4 text-primary" /> Proposta comercial
            <Badge variant="outline">Rascunho — simulação, revisar antes de enviar</Badge>
          </SheetTitle>
          <SheetDescription>
            {query.data
              ? `Automação Comercial B2B — ${query.data.deal.companyName ?? query.data.deal.title}`
              : deal?.title}
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {query.isFetching && !query.data ? (
            <div className="flex items-center gap-2 text-body text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Lendo o CRM…
            </div>
          ) : query.isError ? (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{(query.error as Error).message}</AlertDescription>
            </Alert>
          ) : query.data && deal ? (
            <Proposal dealId={deal.id} view={query.data} />
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Proposal({ dealId, view }: { dealId: string; view: ProposalView }) {
  const qc = useQueryClient();
  const saved = view.draft?.assumptions ?? DEFAULT_ASSUMPTIONS;
  const [form, setForm] = useState<ProposalAssumptions>(saved);
  useEffect(() => setForm(saved), [saved]);

  const save = useMutation({
    mutationFn: () => saveProposalAssumptions(dealId, view.draft?.activityId ?? null, form),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["proposal", dealId] });
      toast.success("Premissas salvas no rascunho.");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const { deal } = view;
  const s = buildProposalSections(view.meeting);
  const r = computeBusinessCase({ ...form, sellers: deal.sellers, investment: deal.value });
  const dirty = JSON.stringify(form) !== JSON.stringify(saved) || !view.draft;

  return (
    <div className="space-y-6">
      <p className="rounded-md border border-dashed border-border p-3 text-body text-muted-foreground">
        Simulação da etapa seguinte da oportunidade. O negócio segue em{" "}
        <strong className="text-foreground">{deal.stageName ?? "estágio não identificado"}</strong>{" "}
        e nenhuma proposta foi solicitada ou enviada.
      </p>

      <Block title="Fatos do CRM" tone="fact">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label="Empresa" value={deal.companyName ?? "Não informada"} />
          <Field label="Contato" value={deal.contactName ?? "Sem contato"} />
          <Field label="Cargo" value={deal.contactTitle ?? "Não informado"} />
          <Field label="Negócio" value={deal.title} />
          <Field label="Valor da oportunidade" value={fmtBRL(deal.value)} />
          <Field label="Estágio" value={deal.stageName ?? "Não identificado"} />
        </dl>
      </Block>

      <Section title="Contexto da oportunidade">
        <List items={[...s.context, ...s.problems]} empty="Nenhuma reunião registrada no CRM." />
        {s.concerns.length > 0 && (
          <p className="text-body text-muted-foreground">
            Preocupação registrada: {s.concerns.join(" ")}
          </p>
        )}
      </Section>
      <Section title="Objetivos">
        <List items={s.objectives} />
      </Section>
      <Section title="Escopo proposto">
        <List items={s.scope} />
      </Section>
      <Section title="Entregáveis">
        <List items={s.deliverables} />
      </Section>
      <Section title="Como funcionaria">
        <List items={s.howItWorks} />
      </Section>

      <Section title="Business case">
        <Block title="Entradas da simulação — fatos do CRM e premissas" tone="assumption">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Metric
              label="Vendedores"
              value={fmtNumber(deal.sellers)}
              tag={deal.sellers === null ? "Não informado no CRM" : "Fato do CRM"}
            />
            <Editable
              label="Horas administrativas por vendedor/dia"
              value={form.adminHoursPerDay}
              onChange={(v) => setForm({ ...form, adminHoursPerDay: v })}
            />
            <Editable
              label="Dias úteis/mês"
              value={form.workDaysPerMonth}
              onChange={(v) => setForm({ ...form, workDaysPerMonth: v })}
            />
            <Editable
              label="Automatizável (%)"
              value={form.automatableShare === null ? null : form.automatableShare * 100}
              onChange={(v) => setForm({ ...form, automatableShare: v === null ? null : v / 100 })}
            />
            <Editable
              label="Custo hora carregado (R$)"
              value={form.hourlyCost}
              onChange={(v) => setForm({ ...form, hourlyCost: v })}
            />
            <Metric
              label="Investimento considerado"
              value={fmtBRL(deal.value)}
              tag="Valor da oportunidade no CRM"
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            className="mt-3"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            {view.draft ? "Salvar premissas" : "Criar rascunho com estas premissas"}
          </Button>
        </Block>

        <Block title="Resultados calculados" tone="result">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Metric
              label="Horas administrativas/mês"
              value={withUnit(fmtNumber(r.adminHoursPerMonth), "h")}
            />
            <Metric
              label="Economia potencial de tempo"
              value={withUnit(fmtNumber(r.savedHoursPerMonth), "h/mês")}
            />
            <Metric label="Economia potencial mensal" value={fmtBRL(r.monthlySaving)} />
            <Metric label="Economia potencial anual" value={fmtBRL(r.annualSaving)} />
            <Metric
              label="Payback estimado"
              value={withUnit(fmtNumber(r.paybackMonths, 1), "meses")}
            />
            <Metric label="ROI estimado em 12 meses" value={fmtPercent(r.roi12mPercent)} />
          </div>
          <p className="mt-3 text-caption text-muted-foreground">
            Horas = vendedores × horas/dia × dias úteis · Economia = horas × % automatizável ×
            custo/h · Payback = investimento ÷ economia mensal · ROI = (economia anual −
            investimento) ÷ investimento.
          </p>
        </Block>
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>{SIMULATION_DISCLAIMER}</AlertDescription>
        </Alert>
      </Section>

      <Section title="Próximos passos">
        <p className="text-body text-muted-foreground">
          Se essa oportunidade avançasse para a etapa de proposta, os próximos passos poderiam ser:
        </p>
        <ol className="list-decimal space-y-1 pl-5 text-body text-foreground">
          {s.nextSteps.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ol>
        {s.previousNextStep.length > 0 && (
          <p className="text-caption text-muted-foreground">
            Próximo passo registrado na última reunião: {s.previousNextStep.join(" ")}
          </p>
        )}
      </Section>
    </div>
  );
}

/** "N/A" fica sem unidade ("N/A meses" não quer dizer nada). */
const withUnit = (v: string, unit: string) => (v === "N/A" ? v : `${v} ${unit}`);

const TONES = {
  fact: "border-border bg-card",
  assumption: "border-dashed border-amber-500/60 bg-amber-500/5",
  result: "border-primary/50 bg-primary/5",
} as const;

function Block({
  title,
  tone,
  children,
}: {
  title: string;
  tone: keyof typeof TONES;
  children: ReactNode;
}) {
  return (
    <div className={`rounded-md border p-3 ${TONES[tone]}`}>
      <p className="mb-2 text-caption font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      {children}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

function List({ items, empty }: { items: string[]; empty?: string }) {
  if (items.length === 0) return <p className="text-body text-muted-foreground">{empty}</p>;
  return (
    <ul className="list-disc space-y-1 pl-5 text-body text-foreground">
      {items.map((i) => (
        <li key={i}>{i}</li>
      ))}
    </ul>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-caption text-muted-foreground">{label}</dt>
      <dd className="text-body font-medium text-foreground">{value}</dd>
    </div>
  );
}

function Metric({ label, value, tag }: { label: string; value: string; tag?: string }) {
  return (
    <div>
      <p className="text-h3 font-semibold text-foreground">{value}</p>
      <p className="text-caption text-muted-foreground">{label}</p>
      {tag && <p className="text-caption text-muted-foreground">{tag}</p>}
    </div>
  );
}

function Editable({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  const [text, setText] = useState(value === null ? "" : String(value).replace(".", ","));
  return (
    <label className="block">
      <Input
        inputMode="decimal"
        className="h-8 w-24"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parseDecimalBR(e.target.value));
        }}
      />
      <span className="text-caption text-muted-foreground">{label}</span>
      <span className="block text-caption text-amber-600 dark:text-amber-400">
        Premissa de simulação
      </span>
    </label>
  );
}
