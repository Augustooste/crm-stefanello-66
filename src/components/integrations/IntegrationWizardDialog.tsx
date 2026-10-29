// Wizard passo-a-passo isolado, usado pelo ConnectDialog quando existe uma
// definição em `wizards/registry.ts` para o slug. Este componente é só a
// UI do formulário multi-step — a mutation `integration-connect` continua no
// ConnectDialog e é injetada via `onSubmit(values)`.
//
// Responsabilidades exclusivas deste componente:
//   1. Navegação Voltar/Próximo com Progress visual e docsUrl opcional.
//   2. Persistência de rascunho em localStorage sob
//      `wizard-draft:${tenantId}:${slug}` (nunca salva campos password).
//   3. Roteamento de erro: quando o backend retorna uma mensagem que
//      contém o `key` de um `required_secret`, o wizard volta para o passo
//      que contém aquele campo e marca `aria-invalid` no input.
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ExternalLink, Loader2, Lock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import type { WizardDef } from "@/lib/integrations/wizards/registry";
import type { CatalogField } from "./IntegrationCard";

const DRAFT_PREFIX = "wizard-draft";

function draftKey(tenantId: string | null, slug: string): string | null {
  if (!tenantId) return null;
  return `${DRAFT_PREFIX}:${tenantId}:${slug}`;
}

function isPasswordField(catalog: CatalogField[], key: string): boolean {
  return catalog.find((f) => f.key === key)?.type === "password";
}

/**
 * Dado o erro do backend (ex.: "api_key inválido"), retorna o índice do
 * passo cujo `fields` contém a chave mencionada — para o wizard voltar
 * automaticamente ao passo problemático.
 */
export function stepIndexForError(
  wizard: WizardDef,
  errorMessage: string | undefined,
  catalog: CatalogField[],
): { step: number; fieldKey: string } | null {
  if (!errorMessage) return null;
  const lower = errorMessage.toLowerCase();
  // Casa o `key` do secret no texto do erro; longer keys first para evitar
  // colisão (`api_key_v2` antes de `api_key`).
  const keys = catalog
    .map((f) => f.key)
    .slice()
    .sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (lower.includes(key.toLowerCase())) {
      const idx = wizard.steps.findIndex((s) => s.fields.includes(key));
      if (idx >= 0) return { step: idx, fieldKey: key };
    }
  }
  return null;
}

export type IntegrationWizardDialogProps = {
  slug: string;
  wizard: WizardDef;
  catalog: CatalogField[];
  tenantId: string | null;
  submitting: boolean;
  errorMessage?: string;
  onSubmit: (values: Record<string, string>) => void;
  onCancel?: () => void;
  cancelLabel?: string;
  submitLabelOverride?: string;
};

export function IntegrationWizardDialog({
  slug,
  wizard,
  catalog,
  tenantId,
  submitting,
  errorMessage,
  onSubmit,
  onCancel,
  cancelLabel,
  submitLabelOverride,
}: IntegrationWizardDialogProps) {
  const total = wizard.steps.length;
  const [step, setStep] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  // Marca o campo problemático (aria-invalid) enquanto o erro do backend
  // continuar mencionando-o. Um novo submit tenta de novo e limpa se sumir.
  const [invalidKey, setInvalidKey] = useState<string | null>(null);
  const draftLoaded = useRef(false);

  // Carrega rascunho salvo (só campos não-password).
  useEffect(() => {
    const key = draftKey(tenantId, slug);
    if (!key || draftLoaded.current) return;
    draftLoaded.current = true;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, string>;
        setValues(parsed);
      }
    } catch {
      /* ignore corrupted draft */
    }
  }, [tenantId, slug]);

  // Salva rascunho a cada mudança, filtrando campos sensíveis.
  useEffect(() => {
    const key = draftKey(tenantId, slug);
    if (!key || !draftLoaded.current) return;
    try {
      const safe: Record<string, string> = {};
      for (const [k, v] of Object.entries(values)) {
        if (!isPasswordField(catalog, k)) safe[k] = v;
      }
      window.localStorage.setItem(key, JSON.stringify(safe));
    } catch {
      /* ignore quota */
    }
  }, [values, tenantId, slug, catalog]);

  // Ao receber um erro, volta ao passo do campo mencionado (se houver).
  useEffect(() => {
    const hit = stepIndexForError(wizard, errorMessage, catalog);
    if (hit) {
      setStep(hit.step);
      setInvalidKey(hit.fieldKey);
    } else if (!errorMessage) {
      setInvalidKey(null);
    }
  }, [errorMessage, wizard, catalog]);

  const isLast = step >= total - 1;
  const currentDef = wizard.steps[step];
  const stepFields = useMemo(
    () =>
      (currentDef?.fields ?? [])
        .map((k) => catalog.find((f) => f.key === k))
        .filter((f): f is CatalogField => Boolean(f)),
    [currentDef, catalog],
  );

  // "Avançar" só é permitido quando os campos obrigatórios deste passo estão
  // preenchidos — campos marcados como opcionais no catálogo não bloqueiam.
  const canAdvance = stepFields.every((f) => f.optional || (values[f.key] ?? "").trim().length > 0);

  function clearDraft() {
    const key = draftKey(tenantId, slug);
    if (!key) return;
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        if (!isLast) {
          if (canAdvance) setStep((s) => Math.min(s + 1, total - 1));
          return;
        }
        const trimmed: Record<string, string> = {};
        for (const [k, val] of Object.entries(values)) trimmed[k] = (val ?? "").trim();
        onSubmit(trimmed);
      }}

      data-testid="integration-wizard-form"
    >
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4 [scrollbar-color:var(--border-strong)_transparent] [scrollbar-width:thin] sm:px-6">
        <div
          className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3"
          data-testid="wizard-step-card"
        >
          <div className="flex items-center justify-between text-caption text-muted-foreground">
            <span>
              Passo {step + 1} de {total}
            </span>
            <span className="font-medium text-foreground">{currentDef?.title}</span>
          </div>
          <Progress value={((step + 1) / total) * 100} aria-label="Progresso do assistente" />
          <ul className="ml-4 list-disc space-y-1 text-caption text-muted-foreground">
            {currentDef?.bullets.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
          {currentDef?.docsUrl && (
            <a
              href={currentDef.docsUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex w-fit items-center gap-1 text-caption text-primary hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              Abrir painel do provedor
            </a>
          )}
        </div>

        {stepFields.map((f) => (
          <div key={f.key} className="flex flex-col gap-1.5">
            <Label htmlFor={`${slug}-${f.key}`}>
              {f.label}
              {f.optional && (
                <span className="ml-1 font-normal text-muted-foreground">(opcional)</span>
              )}
            </Label>
            <Input
              id={`${slug}-${f.key}`}
              type={f.type ?? "text"}
              autoComplete="off"
              aria-invalid={invalidKey === f.key || undefined}
              value={values[f.key] ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                setValues((prev) => ({ ...prev, [f.key]: v }));
                if (invalidKey === f.key) setInvalidKey(null);
              }}
            />
            <p className="text-caption text-muted-foreground">{f.help}</p>
          </div>
        ))}

        <div className="flex items-start gap-2 rounded-md border border-border bg-surface p-3 text-caption text-muted-foreground">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Suas chaves ficam guardadas com segurança e nunca aparecem no navegador.</span>
        </div>

        {errorMessage && (
          <p className="flex items-start gap-1 text-caption text-destructive" role="alert">
            <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
            {errorMessage}
          </p>
        )}
      </div>

      <DialogFooter className="shrink-0 items-stretch gap-2 border-t border-border px-4 py-3 sm:items-center sm:space-x-0 sm:px-6">
        {step > 0 && (
          <Button
            type="button"
            variant="ghost"
            className="w-full sm:w-auto"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={submitting}
          >
            Voltar
          </Button>
        )}
        {onCancel && (
          <Button
            type="button"
            variant="ghost"
            className="w-full sm:w-auto"
            onClick={onCancel}
            disabled={submitting}
          >
            {cancelLabel ?? "Cancelar"}
          </Button>
        )}
        <Button className="w-full sm:w-auto" type="submit" disabled={submitting || !canAdvance}>
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {isLast ? (submitLabelOverride ?? "Testar e conectar") : "Próximo"}
        </Button>
      </DialogFooter>

      {/* helper para consumidor limpar rascunho ao concluir; expõe via ref? */}
      <button type="button" hidden data-testid="wizard-clear-draft" onClick={clearDraft} />
    </form>
  );
}

/** Exportado para o consumidor limpar rascunho após sucesso. */
export function clearWizardDraft(tenantId: string | null, slug: string) {
  const key = draftKey(tenantId, slug);
  if (!key) return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
