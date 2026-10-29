import { useState } from "react";
import { FlaskConical, Info } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  usePreviewInboundRule,
  type InboundAction,
  type InboundPreview,
} from "@/lib/api/inbound-rules";
import { errorText } from "./format";
import { MAX_SAMPLE_BYTES, type StageKind } from "./inbound-rule-form";

const SAMPLE_PLACEHOLDER = '{\n  "id": "evt_123",\n  "email": "cliente@exemplo.com.br"\n}';

type Status = { tone: "ok" | "none"; text: string };

/** Os 3 estados do negócio pedidos no brief, mais os casos em que nem se procura. */
function dealStatus(p: InboundPreview): Status {
  switch (p.outcome) {
    case "missing_event_id":
      return {
        tone: "none",
        text: "Id do evento não encontrado no exemplo: o gateway receberia 400.",
      };
    case "ignored":
      return { tone: "none", text: "Condições não atendidas: evento ignorado." };
    case "ambiguous":
      return { tone: "none", text: "Mais de um negócio: nenhuma ação" };
    case "not_found":
      return { tone: "none", text: "Nenhum negócio" };
    case "deal_not_open":
      return {
        tone: "none",
        text: p.dealTitle
          ? `Negócio encontrado: ${p.dealTitle} (já fechado, nenhuma ação)`
          : "Negócio já fechado: nenhuma ação",
      };
    default:
      return { tone: "ok", text: `Negócio encontrado: ${p.dealTitle ?? "sem título"}` };
  }
}

function actionText(p: InboundPreview, action: InboundAction, stages: StageKind[]): string {
  if (p.outcome === "already_in_stage") return "Nenhuma: o negócio já está na etapa de destino.";
  if (p.outcome !== "act") return "Nenhuma.";
  const stage = stages.find((s) => s.id === p.targetStageId)?.name ?? "etapa de destino";
  switch (action) {
    case "move_stage":
      return `Mover para a etapa ${stage}.`;
    case "mark_won":
      return `Marcar como ganho (etapa ${stage}).`;
    case "mark_lost":
      return `Marcar como perdido (etapa ${stage}), motivo: ${p.reason ?? "vazio"}.`;
    case "add_note":
      return `Registrar nota: ${p.noteText ?? "vazia"}`;
    default:
      return `Criar atividade: ${p.noteText ?? "sem título"}`;
  }
}

/** Dry run da regra salva. A amostra fica só no estado local; o resultado não vai para cache. */
export function InboundRuleTestPanel({
  ruleId,
  action,
  stages,
  disabledReason,
}: {
  ruleId: string | null;
  action: InboundAction;
  stages: StageKind[];
  /** Texto do motivo quando o teste não pode rodar (regra não salva ou alterada). */
  disabledReason: string | null;
}) {
  const previewM = usePreviewInboundRule();
  const [sample, setSample] = useState("");
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!ruleId) return;
    if (new TextEncoder().encode(sample).length > MAX_SAMPLE_BYTES) {
      return setError("Exemplo grande demais: use um JSON de até 64 KB.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(sample);
    } catch {
      return setError("JSON inválido. Cole o corpo exatamente como o gateway envia.");
    }
    // O receptor só aceita um objeto JSON no corpo; lista ou valor solto nunca chega à regra.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return setError(
        "O exemplo precisa ser um objeto JSON (entre chaves { }), como o gateway envia.",
      );
    }
    setError(null);
    try {
      await previewM.mutateAsync({ ruleId, sample: parsed });
    } catch (e) {
      setError(errorText(e));
    }
  };

  const result = previewM.data;
  const status = result ? dealStatus(result) : null;

  return (
    <section aria-labelledby="inbound-test-title" className="flex flex-col gap-3">
      <h3 id="inbound-test-title" className="text-body font-semibold text-foreground">
        Testar com um exemplo
      </h3>
      <Alert>
        <Info className="h-4 w-4" aria-hidden="true" />
        <AlertTitle>Teste não altera nada</AlertTitle>
        <AlertDescription>
          O exemplo é avaliado pela regra salva e nenhum negócio é movido ou alterado. O exemplo não
          é guardado.
        </AlertDescription>
      </Alert>
      <div className="flex flex-col gap-2">
        <Label htmlFor="inbound-sample">JSON de exemplo</Label>
        <Textarea
          id="inbound-sample"
          value={sample}
          onChange={(e) => setSample(e.target.value)}
          placeholder={SAMPLE_PLACEHOLDER}
          rows={6}
          className="font-mono text-caption"
          spellCheck={false}
        />
      </div>
      {disabledReason && <p className="text-caption text-muted-foreground">{disabledReason}</p>}
      <div>
        <Button
          type="button"
          variant="secondary"
          onClick={() => void run()}
          disabled={!ruleId || !!disabledReason || previewM.isPending || !sample.trim()}
        >
          <FlaskConical className="mr-2 h-4 w-4" aria-hidden="true" />
          Testar
        </Button>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {result && status && (
        <div
          role="status"
          className="flex flex-col gap-2 rounded-md border border-border bg-muted p-3 text-body"
        >
          <p
            className={
              status.tone === "ok"
                ? "font-medium text-foreground"
                : "font-medium text-muted-foreground"
            }
          >
            {status.text}
          </p>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-caption">
            <dt className="text-muted-foreground">Id do evento</dt>
            <dd className="break-all font-mono text-foreground">{result.externalEventId ?? "-"}</dd>
            <dt className="text-muted-foreground">Identificador</dt>
            <dd className="break-all font-mono text-foreground">{result.identifier ?? "-"}</dd>
            <dt className="text-muted-foreground">Condições</dt>
            <dd className="text-foreground">
              {result.conditionsOk === null
                ? "-"
                : result.conditionsOk
                  ? "atendidas"
                  : "não atendidas"}
            </dd>
            <dt className="text-muted-foreground">Ação que seria executada</dt>
            <dd className="text-foreground">{actionText(result, action, stages)}</dd>
          </dl>
        </div>
      )}
    </section>
  );
}
