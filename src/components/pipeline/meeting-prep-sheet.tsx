import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ClipboardList, Loader2, RefreshCw } from "lucide-react";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { prepareMeeting, type MeetingPrep } from "@/lib/api/meeting-prep";

export interface MeetingPrepTarget {
  id: string;
  title: string;
}

interface MeetingPrepSheetProps {
  /** null = fechado. */
  deal: MeetingPrepTarget | null;
  onOpenChange: (open: boolean) => void;
}

// Reabrir o mesmo negócio em poucos minutos reaproveita o briefing — evita
// uma chamada de IA a cada abertura. "Gerar novamente" força.
const MEETING_PREP_STALE_MS = 10 * 60 * 1000;

/**
 * "Preparar reunião": briefing do negócio antes da call. Fatos (empresa,
 * contato, cargo, valor, estágio, reunião, próximo passo) vêm de
 * `data.facts`, lidos do banco pela Edge Function prepare-meeting. A IA só
 * preenche resumo, hipóteses, perguntas e pontos de atenção.
 */
export function MeetingPrepSheet({ deal, onOpenChange }: MeetingPrepSheetProps) {
  const query = useQuery({
    queryKey: ["meeting-prep", deal?.id],
    queryFn: () => prepareMeeting(deal!.id),
    enabled: !!deal,
    staleTime: MEETING_PREP_STALE_MS,
    retry: false,
    // O QueryClient global usa throwOnError: true (derruba a rota inteira).
    // Aqui o erro tem lugar próprio dentro do Sheet.
    throwOnError: false,
  });

  return (
    <Sheet open={!!deal} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
        <SheetHeader className="border-b border-border px-5 py-4 text-left">
          <SheetTitle className="flex items-center gap-2">
            <ClipboardList className="h-4 w-4 text-primary" /> Preparação da reunião
          </SheetTitle>
          <SheetDescription>
            {query.data
              ? [query.data.facts.company?.name, query.data.facts.deal.title]
                  .filter(Boolean)
                  .join(" · ")
              : deal?.title}
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {query.isFetching && !query.data ? (
            <div className="flex items-center gap-2 text-body text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Lendo o CRM e preparando o briefing…
            </div>
          ) : query.isError ? (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{(query.error as Error).message}</AlertDescription>
            </Alert>
          ) : query.data ? (
            <Briefing prep={query.data} />
          ) : null}
        </div>
        {deal && (
          <div className="border-t border-border px-5 py-3">
            <Button
              variant="outline"
              size="sm"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              {query.isFetching ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              Gerar novamente
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
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

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-caption text-muted-foreground">{label}</dt>
      <dd className="text-body font-medium text-foreground">{value}</dd>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-body text-muted-foreground">{children}</p>;
}

function Briefing({ prep }: { prep: MeetingPrep }) {
  const { facts, generated, aiError } = prep;
  const attention = [...facts.attentionPoints, ...(generated?.attentionPoints ?? [])];
  return (
    <>
      <dl className="grid grid-cols-2 gap-3 rounded-md border border-border bg-card p-3">
        <Field label="Empresa" value={facts.company?.name ?? "Empresa não informada"} />
        <Field label="Negócio" value={facts.deal.title} />
      </dl>

      <Section title="Contato">
        {facts.contact ? (
          <div>
            <p className="text-body font-medium text-foreground">{facts.contact.name}</p>
            <p className="text-body text-muted-foreground">
              {facts.contact.title ?? "Cargo não informado"}
            </p>
          </div>
        ) : (
          <Empty>Nenhum contato vinculado ao negócio.</Empty>
        )}
      </Section>

      <Section title="Reunião">
        {facts.meeting ? (
          <dl className="grid grid-cols-2 gap-3">
            <Field label="Data" value={facts.meeting.dateLabel} />
            <Field label="Horário" value={facts.meeting.timeLabel} />
          </dl>
        ) : (
          <Empty>Nenhuma reunião agendada.</Empty>
        )}
        <Field label="Objetivo" value={facts.objective ?? "Objetivo não registrado"} />
      </Section>

      <Section title="Oportunidade">
        <dl className="grid grid-cols-2 gap-3">
          <Field label="Valor" value={facts.deal.valueLabel} />
          <Field label="Estágio" value={facts.deal.stageName ?? "Estágio não identificado"} />
          <Field label="Responsável" value={facts.deal.ownerName ?? "Não atribuído"} />
        </dl>
      </Section>

      <Section title="Contexto conhecido">
        {facts.knownContext.length > 0 ? (
          <ul className="list-disc space-y-1 pl-5 text-body text-foreground">
            {facts.knownContext.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        ) : (
          <Empty>Sem notas registradas sobre a empresa.</Empty>
        )}
        {generated?.summary && (
          <p className="text-body text-muted-foreground">
            <span className="font-medium">Resumo da IA:</span> {generated.summary}
          </p>
        )}
      </Section>

      {aiError && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>{aiError}</AlertDescription>
        </Alert>
      )}

      <Section title="Hipóteses a validar">
        {generated && generated.hypotheses.length > 0 ? (
          <ul className="space-y-2">
            {generated.hypotheses.map((h) => (
              <li
                key={h.text}
                className="rounded-md border border-dashed border-border p-2 text-body"
              >
                <span className="text-foreground">{h.text}</span>
                {h.reason && (
                  <span className="block text-caption text-muted-foreground">Base: {h.reason}</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Nenhuma hipótese gerada.</Empty>
        )}
      </Section>

      <Section title="Perguntas sugeridas">
        {generated && generated.suggestedQuestions.length > 0 ? (
          <ol className="list-decimal space-y-1 pl-5 text-body text-foreground">
            {generated.suggestedQuestions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ol>
        ) : (
          <Empty>Nenhuma pergunta gerada.</Empty>
        )}
      </Section>

      <Section title="Pontos de atenção">
        <ul className="list-disc space-y-1 pl-5 text-body text-foreground">
          {attention.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </Section>

      <Section title="Próximo passo">
        {facts.nextStep ? (
          <p className="text-body text-foreground">
            {facts.nextStep.title}
            {facts.nextStep.dateLabel && (
              <span className="text-muted-foreground"> · {facts.nextStep.dateLabel}</span>
            )}
          </p>
        ) : (
          <Empty>Próximo passo não definido.</Empty>
        )}
      </Section>
    </>
  );
}
