import { useEffect, useRef } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/common/StatusBadge";
import { userFacingErrorMessage } from "@/lib/integrations/friendly-errors";
import { useBootstrapStatus, useConfigureEnvironment } from "@/lib/api/onboarding";

/**
 * Passo "Preparar o ambiente" — a configuração automática do remix.
 *
 * Quem remixa recebe um backend novo, cujo cofre interno nasce vazio: sem ele
 * as rotinas automáticas não conseguem chamar nada e o dono da PME não tem
 * como resolver. Ao abrir, este passo dispara a auto-configuração (o servidor
 * grava o próprio endereço e credencial interna no cofre) e mostra um
 * checklist do ambiente. Falha aqui não trava o wizard: o item aparece
 * escrito, com botão de tentar de novo.
 */
export function StepAmbiente({ auto = true }: { auto?: boolean }) {
  const status = useBootstrapStatus();
  const configure = useConfigureEnvironment();
  const ranRef = useRef(false);

  const vaultMissing = status.data?.vault_missing ?? [];
  const items = status.data?.items ?? [];

  const run = () =>
    configure.mutate(undefined, {
      onSuccess: () => toast.success("Ambiente preparado."),
      onError: (e) =>
        toast.error(userFacingErrorMessage(e, "Não foi possível preparar o ambiente.")),
    });

  // Auto-configura uma vez, só quando o cofre está mesmo incompleto.
  useEffect(() => {
    if (!auto || ranRef.current) return;
    if (status.isLoading || status.isError || !status.data) return;
    if (vaultMissing.length === 0) return;
    ranRef.current = true;
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, status.isLoading, status.isError, status.data, vaultMissing.length]);

  if (status.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (status.isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-card-title">Preparar o ambiente</CardTitle>
          <CardDescription>
            Não foi possível consultar o diagnóstico. Apenas administradores têm acesso a esta etapa
            — você pode pular e concluir depois.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const pending = items.filter((i) => i.status === "pendente");
  const ready = pending.length === 0;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-card-title flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" aria-hidden />
            Preparar o ambiente
          </CardTitle>
          <CardDescription>
            Deixamos o backend do seu CRM pronto sozinho: acesso interno, catálogos e eventos. Você
            não precisa digitar nenhuma chave.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2 text-body">
            {configure.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
            ) : ready ? (
              <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
            ) : (
              <AlertTriangle className="h-4 w-4 text-warning" aria-hidden />
            )}
            <span>
              {configure.isPending
                ? "Configurando automaticamente…"
                : ready
                  ? "Ambiente pronto."
                  : `${pending.length} item(ns) ainda pendente(s).`}
            </span>
          </div>

          <Button variant="outline" onClick={run} disabled={configure.isPending}>
            {configure.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            {ready ? "Reconfigurar automaticamente" : "Tentar de novo"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-card-title">Diagnóstico do ambiente</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {items.length === 0 && (
            <p className="text-caption text-muted-foreground">Nada a verificar por enquanto.</p>
          )}
          {items.map((item) => (
            <div
              key={item.key}
              className="flex items-start justify-between gap-3 rounded-md border border-border p-3"
            >
              <div className="min-w-0">
                <p className="text-body font-medium">{item.label}</p>
                <p className="text-caption text-muted-foreground tabular-nums">{item.detail}</p>
              </div>
              <StatusBadge
                variant={
                  item.status === "ok"
                    ? "success"
                    : item.status === "atencao"
                      ? "warning"
                      : "neutral"
                }
              >
                {item.status === "ok"
                  ? "Pronto"
                  : item.status === "atencao"
                    ? "Atenção"
                    : "Pendente"}
              </StatusBadge>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
