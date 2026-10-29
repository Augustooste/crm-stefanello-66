import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type BrandDiagnosticStep = {
  id: string;
  label: string;
  status: "ok" | "falhou" | "pulado";
  detail: string | null;
};

export type BrandDiagnosticAsset = {
  role: string;
  kind: string | null;
  url: string | null;
  status: "lido" | "ignorado" | "nao_encontrado";
  reason: string | null;
};

export type BrandDiagnostics = {
  steps: BrandDiagnosticStep[];
  assets: BrandDiagnosticAsset[];
};

const ROLE_LABEL: Record<string, string> = {
  favicon: "Favicon",
  logo: "Logo",
  "og:image": "og:image",
  "twitter:image": "twitter:image",
  stylesheet: "CSS",
  manifest: "Manifest",
};

const ASSET_LABEL: Record<BrandDiagnosticAsset["status"], string> = {
  lido: "Encontrado",
  ignorado: "Ignorado",
  nao_encontrado: "Não encontrado",
};

const STEP_LABEL: Record<BrandDiagnosticStep["status"], string> = {
  ok: "Concluída",
  falhou: "Falhou",
  pulado: "Não executada",
};

function statusTone(kind: "ok" | "erro" | "neutro"): string {
  if (kind === "ok") return "text-primary";
  if (kind === "erro") return "text-destructive";
  return "text-muted-foreground";
}

/** Painel de diagnóstico da extração — abre sozinho quando houve falha. */
export function BrandExtractDiagnostics({
  diagnostics,
  requestId,
  revision,
  projectRef,
  servedBy,
  hasError,
}: {
  diagnostics: BrandDiagnostics;
  requestId?: string | null;
  revision?: string | null;
  projectRef?: string | null;
  servedBy?: string | null;
  hasError?: boolean;
}) {
  const [open, setOpen] = useState(!!hasError);

  useEffect(() => {
    if (hasError) setOpen(true);
  }, [hasError]);

  const hasContent = diagnostics.steps.length > 0 || diagnostics.assets.length > 0;
  if (!hasContent) return null;

  return (
    <div className="rounded-md border border-border bg-muted/30">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-caption font-medium"
      >
        <span>{open ? "Ocultar diagnóstico" : "Ver diagnóstico"}</span>
        <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="space-y-4 border-t border-border px-3 py-3 text-caption tabular-nums">
          <section>
            <p className="mb-2 font-medium">Assets encontrados</p>
            {diagnostics.assets.length === 0 ? (
              <p className="text-muted-foreground">Nenhum asset avaliado.</p>
            ) : (
              <ul className="space-y-1">
                {diagnostics.assets.map((asset) => (
                  <li key={asset.role} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">{ROLE_LABEL[asset.role] ?? asset.role}</span>
                    <span
                      className={statusTone(
                        asset.status === "lido"
                          ? "ok"
                          : asset.status === "ignorado"
                            ? "erro"
                            : "neutro",
                      )}
                    >
                      {ASSET_LABEL[asset.status]}
                    </span>
                    {asset.url && (
                      <span className="break-all text-muted-foreground">{asset.url}</span>
                    )}
                    {asset.reason && <span className="text-destructive">{asset.reason}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <p className="mb-2 font-medium">Etapas</p>
            <ul className="space-y-1">
              {diagnostics.steps.map((step) => (
                <li key={step.id} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium">{step.label}</span>
                  <span
                    className={statusTone(
                      step.status === "ok" ? "ok" : step.status === "falhou" ? "erro" : "neutro",
                    )}
                  >
                    {STEP_LABEL[step.status]}
                  </span>
                  {step.detail && <span className="text-muted-foreground">{step.detail}</span>}
                </li>
              ))}
            </ul>
          </section>

          {(requestId || revision || projectRef || servedBy) && (
            <p className="text-muted-foreground">
              Referência: {requestId ?? "—"} · versão {revision ?? "—"} · instância{" "}
              {projectRef ?? "—"}
              {servedBy ? ` (${servedBy})` : ""}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
