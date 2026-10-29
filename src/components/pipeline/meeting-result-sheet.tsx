import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Copy, FileText, Loader2, RefreshCw, Sparkles } from "lucide-react";
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
import { fetchDealMeeting, generateFollowup, type FollowupDraft } from "@/lib/api/meeting-result";
import { formatBRL, formatDateTime } from "@/lib/format";

export interface MeetingResultTarget {
  id: string;
  title: string;
}

interface MeetingResultSheetProps {
  /** null = fechado. */
  deal: MeetingResultTarget | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * "Resultado da reunião": o que a última reunião registrou no negócio
 * (resumo, dores, objeções, prioridades, próximo passo) e o RASCUNHO do
 * follow-up. Os dados do negócio vêm do CRM; o resultado vem da atividade
 * gravada pela Edge Function process-meeting. Nada aqui envia mensagem.
 */
export function MeetingResultSheet({ deal, onOpenChange }: MeetingResultSheetProps) {
  const qc = useQueryClient();
  const key = ["meeting-result", deal?.id];
  const query = useQuery({
    queryKey: key,
    queryFn: () => fetchDealMeeting(deal!.id),
    enabled: !!deal,
    retry: false,
    // O QueryClient global usa throwOnError: true (derruba a rota inteira).
    throwOnError: false,
  });
  const followup = useMutation({
    mutationFn: (regenerate: boolean) => generateFollowup(deal!.id, regenerate),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: (e: Error) => toast.error(e.message),
  });

  const view = query.data;
  const draft = view?.lastMeeting?.followupDraft ?? null;

  return (
    <Sheet open={!!deal} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
        <SheetHeader className="border-b border-border px-5 py-4 text-left">
          <SheetTitle className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary" /> Resultado da reunião
          </SheetTitle>
          <SheetDescription>
            {view
              ? [view.deal.companyName, view.deal.title].filter(Boolean).join(" · ")
              : deal?.title}
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {query.isFetching && !view ? (
            <div className="flex items-center gap-2 text-body text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Lendo o CRM…
            </div>
          ) : query.isError ? (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{(query.error as Error).message}</AlertDescription>
            </Alert>
          ) : view ? (
            <>
              <dl className="grid grid-cols-2 gap-3 rounded-md border border-border bg-card p-3">
                <Field label="Empresa" value={view.deal.companyName ?? "Empresa não informada"} />
                <Field
                  label="Contato"
                  value={
                    view.deal.contactName
                      ? [view.deal.contactName, view.deal.contactTitle].filter(Boolean).join(" · ")
                      : "Sem contato"
                  }
                />
                <Field
                  label="Valor"
                  value={view.deal.value === null ? "Não informado" : formatBRL(view.deal.value)}
                />
                <Field label="Estágio" value={view.deal.stageName ?? "Não identificado"} />
              </dl>

              {view.lastMeeting ? (
                <>
                  <Section title="Última reunião">
                    <p className="text-body font-medium text-foreground">
                      {view.lastMeeting.meeting.title}
                    </p>
                    <p className="text-caption text-muted-foreground">
                      Registrada em {formatDateTime(view.lastMeeting.processedAt)}
                      {view.lastMeeting.meeting.participants.length > 0 &&
                        ` · ${view.lastMeeting.meeting.participants.join(", ")}`}
                    </p>
                  </Section>
                  <Section title="Resumo">
                    <p className="text-body text-foreground">{view.lastMeeting.meeting.summary}</p>
                  </Section>
                  <Items title="Dores" items={view.lastMeeting.meeting.painPoints} />
                  <Items title="Objeções" items={view.lastMeeting.meeting.objections} />
                  <Items title="Prioridades" items={view.lastMeeting.meeting.priorities} />
                  <Items title="Próximo passo" items={view.lastMeeting.meeting.nextSteps} />

                  <Section title="Follow-up">
                    {draft ? (
                      <DraftCard draft={draft} />
                    ) : (
                      <p className="text-body text-muted-foreground">
                        Nenhum rascunho gerado ainda.
                      </p>
                    )}
                  </Section>
                </>
              ) : (
                <p className="rounded-md border border-dashed border-border p-4 text-body text-muted-foreground">
                  Nenhuma reunião processada para este negócio ainda.
                </p>
              )}
            </>
          ) : null}
        </div>
        {view?.lastMeeting && (
          <div className="border-t border-border px-5 py-3">
            <Button
              variant={draft ? "outline" : "default"}
              size="sm"
              disabled={followup.isPending}
              onClick={() => followup.mutate(!!draft)}
            >
              {followup.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : draft ? (
                <RefreshCw className="mr-2 h-4 w-4" />
              ) : (
                <Sparkles className="mr-2 h-4 w-4" />
              )}
              {draft ? "Gerar novamente" : "Gerar rascunho de follow-up"}
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function DraftCard({ draft }: { draft: FollowupDraft }) {
  const copy = (text: string) =>
    void navigator.clipboard.writeText(text).then(
      () => toast.success("Copiado. Revise antes de enviar."),
      () => toast.error("Não foi possível copiar."),
    );
  return (
    <div className="space-y-3 rounded-md border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <Badge variant="outline">Rascunho — revisar antes de enviar</Badge>
        <span className="text-caption text-muted-foreground">Não enviado</span>
      </div>
      <div>
        <p className="text-caption text-muted-foreground">E-mail · Assunto</p>
        <p className="text-body font-medium text-foreground">{draft.subject}</p>
        <p className="mt-2 whitespace-pre-line text-body text-foreground">{draft.email}</p>
        <Button
          variant="ghost"
          size="sm"
          className="mt-1"
          onClick={() => copy(`${draft.subject}\n\n${draft.email}`)}
        >
          <Copy className="mr-2 h-4 w-4" /> Copiar e-mail
        </Button>
      </div>
      <div>
        <p className="text-caption text-muted-foreground">WhatsApp (versão curta)</p>
        <p className="text-body text-foreground">{draft.whatsapp}</p>
        <Button variant="ghost" size="sm" className="mt-1" onClick={() => copy(draft.whatsapp)}>
          <Copy className="mr-2 h-4 w-4" /> Copiar mensagem
        </Button>
      </div>
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

function Items({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <Section title={title}>
      <ul className="list-disc space-y-1 pl-5 text-body text-foreground">
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </Section>
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
