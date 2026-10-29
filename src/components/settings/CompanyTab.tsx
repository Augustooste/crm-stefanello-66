import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { RefreshCw, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { useCurrentProfile } from "@/lib/api/session";
import { resizeImageFile } from "@/lib/image";
import { userFacingErrorMessage } from "@/lib/integrations/friendly-errors";

export function CompanyTab() {
  const { data: profile } = useCurrentProfile();
  const qc = useQueryClient();
  const tenantId = profile?.tenant_id;
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const tenantQ = useQuery({
    queryKey: ["tenant", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants")
        .select("id, name, logo_url, onboarded_at")
        .eq("id", tenantId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  // Resincroniza o input com o servidor SEM sobrescrever edição em andamento:
  // ["tenant"] é invalidada por três mutations desta aba (saveName, uploadLogo,
  // resetOnboarding) — um upload de logo no meio da digitação do nome não pode
  // descartar o texto do usuário. Só reseta se o valor atual ainda for o último
  // valor vindo do servidor (ou seja, usuário não divergiu).
  const lastServerName = useRef<string | null>(null);
  useEffect(() => {
    if (!tenantQ.data) return;
    const serverName = tenantQ.data.name;
    // Captura o valor anterior ANTES do setName: o updater roda lazy (só no
    // próximo render), e o ref já teria sido sobrescrito abaixo — lê-lo dentro
    // do updater compararia o input com o valor novo, nunca resincronizando.
    const prevServerName = lastServerName.current;
    lastServerName.current = serverName;
    setName((current) =>
      prevServerName === null || current === prevServerName ? serverName : current,
    );
  }, [tenantQ.data]);

  useEffect(() => {
    let cancelled = false;
    async function loadLogo() {
      if (!tenantQ.data?.logo_url) {
        setLogoPreview(null);
        return;
      }
      const { data } = await supabase.storage
        .from("logos")
        .createSignedUrl(tenantQ.data.logo_url, 3600);
      if (!cancelled) setLogoPreview(data?.signedUrl ?? null);
    }
    loadLogo();
    return () => {
      cancelled = true;
    };
  }, [tenantQ.data?.logo_url]);

  const saveName = useMutation({
    mutationFn: async () => {
      if (!tenantId) throw new Error("Tenant inválido");
      const { error } = await supabase
        .from("tenants")
        .update({ name: name.trim() })
        .eq("id", tenantId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Nome atualizado");
      qc.invalidateQueries({ queryKey: ["tenant"] });
      qc.invalidateQueries({ queryKey: ["topbar-tenant"] });
    },
    onError: (e: Error) => toast.error(userFacingErrorMessage(e, "Erro ao salvar")),
  });

  const uploadLogo = useMutation({
    mutationFn: async (file: File) => {
      if (!tenantId) throw new Error("Tenant inválido");
      const resized = await resizeImageFile(file);
      const ext = resized.name.split(".").pop()?.toLowerCase() ?? "webp";
      const path = `${tenantId}/logo-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("logos")
        .upload(path, resized, { upsert: false, contentType: resized.type });
      if (upErr) throw upErr;
      const { error: updErr } = await supabase
        .from("tenants")
        .update({ logo_url: path })
        .eq("id", tenantId);
      if (updErr) throw updErr;
    },
    onSuccess: () => {
      toast.success("Logo atualizado");
      qc.invalidateQueries({ queryKey: ["tenant"] });
      qc.invalidateQueries({ queryKey: ["topbar-tenant"] });
    },
    onError: (e: Error) => toast.error(userFacingErrorMessage(e, "Erro no upload")),
  });

  const resetOnboarding = useMutation({
    mutationFn: async () => {
      if (!tenantId) throw new Error("Tenant inválido");
      // Refazer = recomeçar do zero: além de reabrir o wizard, remove a
      // identidade visual salva para o tema voltar ao azul padrão até o
      // usuário reextrair/reaplicar. Preserva o resto do business_profile.
      const { data: current, error: readError } = await supabase
        .from("tenants")
        .select("business_profile, updated_at")
        .eq("id", tenantId)
        .maybeSingle();
      if (readError) throw readError;
      const profile: Record<string, Json> =
        current?.business_profile && typeof current.business_profile === "object"
          ? { ...(current.business_profile as Record<string, Json>) }
          : {};
      delete profile.brand;
      // Lock otimista: só grava se o tenant não mudou desde a leitura, senão o
      // read/modify/write cego poderia sobrescrever uma edição concorrente.
      const { data: updated, error } = await supabase
        .from("tenants")
        .update({ onboarded_at: null, business_profile: profile })
        .eq("id", tenantId)
        .eq("updated_at", current?.updated_at ?? "")
        .select("id");
      if (error) throw error;
      if (!updated || updated.length === 0) {
        throw new Error("A empresa foi alterada em outra aba. Recarregue e tente de novo.");
      }
    },
    onSuccess: () => {
      toast.success("Configuração inicial reaberta. As cores voltaram ao padrão.");
      qc.invalidateQueries({ queryKey: ["tenant"] });
      // OnboardingGate observa a query "tenant-onboarding"; useApplyTenantTheme
      // observa "topbar-tenant". Sem invalidar ambas o wizard e o tema azul só
      // aparecem após reload de página, não na hora.
      qc.invalidateQueries({ queryKey: ["tenant-onboarding"] });
      qc.invalidateQueries({ queryKey: ["topbar-tenant"] });
      setConfirmReset(false);
    },
    onError: (e: Error) => toast.error(userFacingErrorMessage(e, "Erro")),
  });

  if (tenantQ.isLoading) return <Skeleton className="h-64 w-full" />;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-card-title">Empresa</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-start gap-6">
          <div className="flex flex-col items-center gap-2">
            <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
              {logoPreview ? (
                <img
                  src={logoPreview}
                  alt="Logo da empresa"
                  className="h-full w-full object-cover"
                />
              ) : (
                <span className="text-caption text-muted-foreground">Sem logo</span>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadLogo.mutate(f);
                e.target.value = "";
              }}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileRef.current?.click()}
              disabled={uploadLogo.isPending}
            >
              <Upload className="mr-1 h-4 w-4" />
              {uploadLogo.isPending ? "Enviando…" : "Enviar logo"}
            </Button>
          </div>

          <div className="flex-1 space-y-1.5">
            <Label htmlFor="tenant-name">Nome da empresa</Label>
            <Input id="tenant-name" value={name} onChange={(e) => setName(e.target.value)} />
            <div className="pt-2">
              <Button
                onClick={() => saveName.mutate()}
                disabled={!name.trim() || saveName.isPending || name.trim() === tenantQ.data?.name}
              >
                {saveName.isPending ? "Salvando…" : "Salvar nome"}
              </Button>
            </div>
          </div>
        </div>

        <div className="rounded-md border border-border p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-body font-medium text-foreground">
                Refazer configuração inicial
              </div>
              <div className="text-caption text-muted-foreground">
                Reabre o assistente de onboarding para revisar segmento, funil e prompts da IA.
              </div>
            </div>
            <Button variant="outline" onClick={() => setConfirmReset(true)}>
              <RefreshCw className="mr-1 h-4 w-4" /> Refazer
            </Button>
          </div>
        </div>
      </CardContent>

      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Refazer configuração inicial?</AlertDialogTitle>
            <AlertDialogDescription>
              O assistente de onboarding será reaberto e as cores da marca voltarão ao padrão até
              você aplicá-las de novo. Seus leads, contatos e pipeline permanecem intactos.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => resetOnboarding.mutate()}>
              Confirmar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
