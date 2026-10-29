import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { formatDateTime } from "@/lib/format";

const dimensionLabels: Record<string, string> = {
  resource: "Recurso/orçamento",
  authority: "Autoridade de decisão",
  need: "Necessidade",
  timeline: "Prazo",
};

function isJsonObject(value: Json): value is { [key: string]: Json | undefined } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function ContactQualificationCard({
  tenantId,
  contactId,
}: {
  tenantId: string;
  contactId: string;
}) {
  const qualifications = useQuery({
    queryKey: ["contact-qualifications", tenantId, contactId],
    throwOnError: false,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deals")
        .select(
          "id,title,qualifications:deal_qualification_snapshots(id,confidence,generated_at,based_on_messages,executive_summary,dimensions,recommended_approach)",
        )
        .eq("tenant_id", tenantId)
        .eq("contact_id", contactId)
        .eq("qualifications.tenant_id", tenantId)
        .order("generated_at", { ascending: false, referencedTable: "qualifications" })
        .order("id", { ascending: false, referencedTable: "qualifications" })
        .limit(1, { referencedTable: "qualifications" });
      if (error) throw error;
      return (data ?? []).filter((deal) => deal.qualifications.length > 0);
    },
  });

  return (
    <Card role="region" aria-label="Qualificação por IA">
      <CardHeader>
        <CardTitle className="text-card-title">Qualificação por IA</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {qualifications.isLoading || (qualifications.isFetching && !qualifications.data?.length) ? (
          <p role="status" className="text-body text-muted-foreground">
            Carregando qualificação por IA...
          </p>
        ) : qualifications.isError ? (
          <div role="alert" className="space-y-2">
            <p>Não foi possível carregar a qualificação por IA.</p>
            <Button variant="outline" onClick={() => void qualifications.refetch()}>
              Tentar novamente
            </Button>
          </div>
        ) : qualifications.data?.length ? (
          <>
            <p className="text-caption text-muted-foreground">
              Avaliação mais recente de cada negócio. A confiança indica a certeza da análise, não a
              probabilidade de fechamento.
            </p>
            <div className="divide-y divide-border">
              {qualifications.data.map((deal) => {
                const snapshot = deal.qualifications[0];
                const dimensions = Array.isArray(snapshot.dimensions)
                  ? snapshot.dimensions.filter(isJsonObject)
                  : [];
                const approach = isJsonObject(snapshot.recommended_approach)
                  ? snapshot.recommended_approach
                  : null;
                return (
                  <article
                    key={deal.id}
                    aria-label={deal.title}
                    className="space-y-4 py-4 first:pt-0"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h4 className="break-words font-medium">{deal.title}</h4>
                      <time
                        className="text-caption text-muted-foreground"
                        dateTime={snapshot.generated_at}
                      >
                        {formatDateTime(snapshot.generated_at)}
                      </time>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-muted-foreground">
                      <p>Confiança: {Math.round(snapshot.confidence * 100)}%</p>
                      <p>
                        Baseada em {snapshot.based_on_messages}{" "}
                        {snapshot.based_on_messages === 1 ? "mensagem" : "mensagens"}
                      </p>
                    </div>
                    <section className="space-y-1">
                      <h5 className="font-medium">Resumo executivo</h5>
                      <p className="whitespace-pre-wrap break-words text-body">
                        {snapshot.executive_summary}
                      </p>
                    </section>
                    <section className="space-y-2">
                      <h5 className="font-medium">Dimensões</h5>
                      {dimensions.length ? (
                        <dl className="grid gap-3 text-body sm:grid-cols-2">
                          {dimensions.map((dimension, index) => (
                            <div key={index} className="min-w-0 space-y-1">
                              <dt className="break-words font-medium">
                                {typeof dimension.key === "string"
                                  ? dimensionLabels[dimension.key] ||
                                    dimension.key.replace(/[_-]/g, " ")
                                  : "Dimensão"}
                                {typeof dimension.status === "string" && ` — ${dimension.status}`}
                              </dt>
                              <dd className="whitespace-pre-wrap break-words text-muted-foreground">
                                {typeof dimension.notes === "string" && dimension.notes
                                  ? dimension.notes
                                  : "Nenhuma observação registrada."}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      ) : (
                        <p className="text-body text-muted-foreground">
                          Dimensões não registradas.
                        </p>
                      )}
                    </section>
                    <section className="space-y-3 text-body">
                      <h5 className="font-medium">Abordagem recomendada</h5>
                      <p className="whitespace-pre-wrap break-words">
                        {typeof approach?.opening === "string" && approach.opening
                          ? approach.opening
                          : "Abordagem não registrada."}
                      </p>
                      {[
                        { title: "Perguntas sugeridas", value: approach?.keyQuestions },
                        { title: "Objeções a antecipar", value: approach?.objectionsToAnticipate },
                      ].map(({ title, value }) => {
                        const items = Array.isArray(value)
                          ? value.filter((item): item is string => typeof item === "string")
                          : [];
                        return items.length ? (
                          <div key={title} className="space-y-1">
                            <p className="font-medium">{title}</p>
                            <ul className="list-disc space-y-1 pl-5">
                              {items.map((item, index) => (
                                <li key={index} className="break-words">
                                  {item}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null;
                      })}
                      {typeof approach?.suggestedNextStep === "string" &&
                        approach.suggestedNextStep && (
                          <div className="space-y-1">
                            <p className="font-medium">Próximo passo sugerido</p>
                            <p className="whitespace-pre-wrap break-words">
                              {approach.suggestedNextStep}
                            </p>
                          </div>
                        )}
                    </section>
                  </article>
                );
              })}
            </div>
          </>
        ) : (
          <p className="text-body text-muted-foreground">
            Nenhuma qualificação registrada para os negócios deste contato.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
