import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { formatDateTime } from "@/lib/format";

type ExtractionRow = {
  id: string;
  tenant_id: string;
  contact_id: string;
  field_name: string;
  field_label: string | null;
  extracted_value: string;
  confidence: number;
  created_at: string;
  applied: boolean;
  apply_reason: string | null;
  source_message_ids: string[];
};

type EnrichmentDatabase = {
  public: {
    Tables: {
      contact_field_extractions: {
        Row: ExtractionRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
};

const enrichmentClient = supabase as unknown as SupabaseClient<EnrichmentDatabase>;

export function ExtractedFieldsCard({
  tenantId,
  contactId,
}: {
  tenantId: string;
  contactId: string;
}) {
  const [sourceId, setSourceId] = useState<string | null>(null);
  const history = useQuery({
    queryKey: ["contact-field-extractions", tenantId, contactId],
    queryFn: async () => {
      const { data, error } = await enrichmentClient
        .from("contact_field_extractions")
        .select(
          "id,field_name,field_label,extracted_value,confidence,created_at,applied,apply_reason,source_message_ids",
        )
        .eq("tenant_id", tenantId)
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data ?? [];
    },
  });
  const source = useQuery({
    queryKey: ["contact-extraction-source", tenantId, contactId, sourceId],
    enabled: !!sourceId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("messages")
        .select("id,content,created_at,conversation_id")
        .eq("tenant_id", tenantId)
        .eq("id", sourceId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-card-title">Informações extraídas pela IA</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {history.isLoading ? (
          <p role="status" className="text-body text-muted-foreground">
            Carregando informações extraídas...
          </p>
        ) : history.isError ? (
          <div role="alert" className="space-y-2">
            <p>Não foi possível carregar as informações extraídas.</p>
            <Button variant="outline" onClick={() => void history.refetch()}>
              Tentar novamente
            </Button>
          </div>
        ) : history.data?.length ? (
          <>
            <p className="text-caption text-muted-foreground">
              Até 50 extrações mais recentes. Valores ignorados não alteraram a ficha.
            </p>
            <ul className="divide-y divide-border">
              {history.data.map((row) => (
                <li key={row.id} className="space-y-2 py-3 first:pt-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">{row.field_label || row.field_name}</span>
                    <time className="text-caption text-muted-foreground" dateTime={row.created_at}>
                      {formatDateTime(row.created_at)}
                    </time>
                  </div>
                  <p className="break-words text-body">{row.extracted_value}</p>
                  <p className="text-caption text-muted-foreground">
                    Confiança: {Math.round(Number(row.confidence) * 100)}%
                  </p>
                  <p className="text-caption">
                    {row.applied
                      ? "Aplicado à ficha"
                      : `Ignorado: ${row.apply_reason || "valor preservado"}`}
                  </p>
                  <div className="flex flex-wrap gap-3">
                    {row.source_message_ids.map((id, index) => (
                      <a
                        key={id}
                        className="text-primary underline underline-offset-4 focus-visible:outline focus-visible:outline-2"
                        href="#contact-extraction-source"
                        onClick={() => setSourceId(id)}
                      >
                        Ver mensagem-fonte {index + 1}
                      </a>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div className="space-y-2 text-body text-muted-foreground">
            <p>Nenhuma extração registrada.</p>
            <p>
              Um administrador pode ativar o enriquecimento em Configurações → IA → Features. Novas
              mensagens passam a alimentar a ficha.
            </p>
          </div>
        )}
        <section
          id="contact-extraction-source"
          tabIndex={-1}
          aria-label="Mensagem-fonte"
          className="scroll-mt-8 space-y-2"
        >
          {sourceId &&
            (source.isLoading ? (
              <p role="status">Carregando mensagem-fonte...</p>
            ) : source.isError ? (
              <div role="alert">
                <p>Não foi possível carregar a mensagem-fonte.</p>
                <Button variant="outline" onClick={() => void source.refetch()}>
                  Recarregar mensagem
                </Button>
              </div>
            ) : source.data ? (
              <>
                <h3 className="font-medium">Mensagem-fonte</h3>
                <blockquote className="whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-body">
                  {source.data.content || "Mensagem sem texto disponível."}
                </blockquote>
                <p className="text-caption text-muted-foreground">
                  {formatDateTime(source.data.created_at)}
                </p>
                <a
                  className="text-primary underline underline-offset-4"
                  href={`/inbox?conversationId=${encodeURIComponent(source.data.conversation_id)}&mode=lista`}
                >
                  Abrir conversa
                </a>
              </>
            ) : (
              <p>Mensagem-fonte removida ou indisponível para seu usuário.</p>
            ))}
        </section>
      </CardContent>
    </Card>
  );
}
