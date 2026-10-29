import { useState } from "react";
import { Copy, Check } from "lucide-react";

import { errorReference, extractClientError } from "@/lib/client-error-telemetry";

/**
 * Referência curta do incidente, visível para QUALQUER usuário (não só admin).
 * É a mesma string gravada em system_events.correlation_id, então o suporte
 * acha o evento exato a partir do que a pessoa leu na tela — antes disso, um
 * não-admin via só "aconteceu um erro" e nada rastreável.
 *
 * O código técnico (ex.: 42501) entra junto por ser curto e não sensível; a
 * mensagem completa continua restrita a admin em ErrorTechnicalDetails.
 */
export function ErrorReference({ error }: { error: unknown }) {
  const [copied, setCopied] = useState(false);
  const reference = errorReference(error);
  const { code } = extractClientError(error);
  const text = code ? `${reference} · ${code}` : reference;

  return (
    <div
      className="mt-4 flex items-center justify-center gap-2 text-caption text-muted-foreground"
      data-testid="error-reference"
    >
      <span>Referência do erro:</span>
      <code className="rounded bg-muted px-1.5 py-0.5 font-mono">{text}</code>
      <button
        type="button"
        aria-label="Copiar referência do erro"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(
            () => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 2000);
            },
            () => setCopied(false),
          );
        }}
        className="inline-flex items-center rounded p-1 transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {copied ? (
          <Check className="size-3.5" aria-hidden />
        ) : (
          <Copy className="size-3.5" aria-hidden />
        )}
      </button>
    </div>
  );
}
