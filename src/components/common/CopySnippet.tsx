import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

const COPIED_RESET_MS = 2000;

/** Bloco de código com botão de copiar (aba Desenvolvedores e documentação de webhooks). */
export function CopySnippet({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), COPIED_RESET_MS);
    } catch {
      toast.error("Não foi possível copiar. Selecione o texto e copie manualmente.");
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex justify-end">
        <Button type="button" variant="secondary" size="sm" onClick={copy}>
          {copied ? (
            <Check className="mr-2 h-4 w-4" aria-hidden="true" />
          ) : (
            <Copy className="mr-2 h-4 w-4" aria-hidden="true" />
          )}
          {copied ? "Copiado" : label}
        </Button>
        <span aria-live="polite" className="sr-only">
          {copied ? "Copiado" : ""}
        </span>
      </div>
      <pre
        tabIndex={0}
        className="max-h-96 min-w-0 max-w-full overflow-x-auto overflow-y-auto rounded-md border border-border bg-muted p-3 font-mono text-caption text-foreground"
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}
