import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { userFacingErrorMessage } from "@/lib/integrations/friendly-errors";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  SkipForward,
  Sparkles,
  Upload,
  Check,
  UserPlus,
  Mail,
  MessageCircle,
  AudioLines,
  FileUp,
  X,
} from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth/AuthProvider";
import { createInvite } from "@/lib/api/invites";
import { useCurrentProfile } from "@/lib/api/session";
import { applyBrandTheme, type TenantBrandColors } from "@/lib/brand-theme";
import { resizeImageFile } from "@/lib/image";
import {
  useNicheTemplates,
  useTenantOnboarding,
  useApplyNicheTemplate,
  useCompleteOnboarding,
  fetchDefaultBoardInfo,
  type NicheTemplate,
} from "@/lib/api/onboarding";
import { useTenantIntegrations } from "@/lib/api/integrations";
import {
  BusinessProfileForm,
  emptyBusinessProfile,
  normalizeBusinessProfile,
  type BusinessProfile,
} from "@/components/settings/BusinessProfileForm";
import {
  autoFillEntries,
  mergeBusinessProfile,
  readExtractedBusiness,
  SOURCE_LABEL,
  type ExtractedBusiness,
} from "@/lib/onboarding/business-autofill";
import {
  IntegrationCard,
  useVisibleIntegrationsCatalog,
} from "@/components/integrations/IntegrationCard";
import { ContactImportDialog } from "@/components/contacts/ContactImportDialog";
import { StepRotinas } from "@/components/onboarding/StepRotinas";
import { StepAmbiente } from "@/components/onboarding/StepAmbiente";
import {
  BrandExtractDiagnostics,
  type BrandDiagnostics,
} from "@/components/onboarding/BrandExtractDiagnostics";

const STEPS = [
  {
    key: "ambiente",
    title: "Preparar o ambiente",
    subtitle: "Deixamos o backend do seu CRM pronto automaticamente.",
  },
  { key: "empresa", title: "Empresa", subtitle: "Como o seu negócio se apresenta." },
  { key: "nicho", title: "Nicho", subtitle: "Escolha um modelo de funil e prompts prontos." },
  { key: "canais", title: "Canais", subtitle: "Conecte seus canais de mensagem." },
  { key: "perfil", title: "Perfil do negócio", subtitle: "O que a IA precisa saber sobre você." },
  { key: "equipe", title: "Equipe", subtitle: "Convide pessoas para acessar o CRM." },
  { key: "contatos", title: "Contatos", subtitle: "Importe sua base agora ou pule para depois." },
  {
    key: "rotinas",
    title: "Rotinas automáticas",
    subtitle: "Consulte as tarefas da plataforma que rodam em segundo plano.",
  },
] as const;

/**
 * Índice do passo "Nicho" — é nele que o funil do tenant nasce
 * (useApplyNicheTemplate). Exportado para quem precisa abrir o assistente
 * direto nesse passo, como o estado vazio do Funil.
 */
export const ONBOARDING_STEP_NICHO = 2;

export function OnboardingWizard({
  open,
  onOpenChange,
  initialStep = 0,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Passo em que o assistente abre. Só vale na montagem do componente. */
  initialStep?: number;
}) {
  const [step, setStep] = useState(initialStep);
  const [saving, setSaving] = useState(false);
  const complete = useCompleteOnboarding();
  const stepSaveRef = useRef<(() => Promise<boolean>) | null>(null);
  const registerSave = useCallback((fn: (() => Promise<boolean>) | null) => {
    stepSaveRef.current = fn;
  }, []);

  const advance = () => {
    if (step < STEPS.length - 1) {
      setStep(step + 1);
    } else {
      complete.mutate(undefined, {
        onSuccess: (result) => {
          toast.success("Configuração inicial concluída.");
          // A conclusão do tenant independe da ativação global pelo operador.
          if (result.vaultMissing.length > 0) {
            toast.warning(
              "Peça ao operador para configurar as credenciais das rotinas no Vault: " +
                result.vaultMissing.join(", "),
            );
          } else if (!result.scheduledJobsActivated) {
            toast.warning(
              "As rotinas automáticas da plataforma são gerenciadas pelo operador. A configuração do seu tenant foi concluída.",
            );
          }
          onOpenChange(false);
        },
        onError: (e: Error) => toast.error(e.message ?? "Não foi possível concluir."),
      });
    }
  };

  const goNext = async () => {
    if (stepSaveRef.current) {
      setSaving(true);
      let ok = false;
      try {
        ok = await stepSaveRef.current();
      } finally {
        setSaving(false);
      }
      if (!ok) return; // save falhou → fica no passo (toast já mostrado)
    }
    advance();
  };
  const goBack = () => setStep((s) => Math.max(0, s - 1));
  const isLastStep = step === STEPS.length - 1;
  // Achado 1 — antes era `skip = () => advance()`, então pular o último passo
  // gravava `onboarded_at` com o mesmo toast de quem preencheu tudo e o
  // OnboardingGate nunca mais reabria: o tenant ficava sem nicho, sem funil e
  // sem canal achando que tinha terminado. Optamos pela opção (a) — no último
  // passo o botão vira "Pular por enquanto" e apenas fecha, sem carimbar
  // conclusão. Ninguém fica preso num loop: a dispensa é lembrada pelo gate até
  // o próximo carregamento e "Concluir" continua a um clique de distância.
  const skip = () => {
    if (!isLastStep) {
      setStep(step + 1);
      return;
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[92vh] max-w-3xl flex-col overflow-hidden p-0"
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader className="border-b border-border px-6 pt-6 pr-12 pb-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <DialogTitle className="text-h5">
                Configuração inicial — {STEPS[step].title}
              </DialogTitle>
              <DialogDescription>{STEPS[step].subtitle}</DialogDescription>
            </div>
            <span className="text-caption text-muted-foreground whitespace-nowrap">
              Passo {step + 1} de {STEPS.length}
            </span>
          </div>
          <div className="mt-3">
            <Progress value={((step + 1) / STEPS.length) * 100} />
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {step === 0 && <StepAmbiente />}
          {step === 1 && <StepEmpresa registerSave={registerSave} />}
          {step === 2 && <StepNicho registerSave={registerSave} />}
          {step === 3 && <StepCanais />}
          {step === 4 && <StepPerfilNegocio registerSave={registerSave} />}
          {step === 5 && <StepEquipe />}
          {step === 6 && <StepImportarContatos />}
          {step === 7 && <StepRotinas />}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border bg-surface px-6 py-4">
          <Button
            variant="ghost"
            onClick={goBack}
            disabled={step === 0 || complete.isPending || saving}
          >
            <ChevronLeft className="mr-1 h-4 w-4" /> Voltar
          </Button>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={skip}
              disabled={complete.isPending || saving}
              title={
                isLastStep
                  ? "Fechar sem marcar a configuração inicial como concluída"
                  : "Pular esta etapa e ir para a próxima"
              }
            >
              <SkipForward className="mr-1 h-4 w-4" />
              {isLastStep ? "Pular por enquanto" : "Pular"}
            </Button>
            <Button onClick={goNext} disabled={complete.isPending || saving}>
              {(saving || complete.isPending) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isLastStep ? "Concluir" : "Avançar"}
              {!isLastStep && <ChevronRight className="ml-1 h-4 w-4" />}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ================================================================== */
/* Passo 1 — Empresa                                                   */
/* ================================================================== */

type BrandExtractResult = TenantBrandColors & {
  source_hex: string;
  site_title: string | null;
  site_description: string | null;
  suggested_segment: string | null;
  contract_version?: number;
  revision?: string;
  request_id?: string;
  diagnostics?: BrandDiagnostics;
  /** Aditivo: backend antigo não devolve este objeto e o fluxo segue igual. */
  business?: unknown;
};

const BRAND_EXTRACT_CONTRACT_VERSION = 1;
const BRAND_EXTRACT_INCOMPATIBLE_MESSAGE =
  "O serviço de extração retornou um formato incompatível. Tente novamente em alguns instantes.";
const BRAND_EXTRACT_STALE_MESSAGE =
  "O backend deste ambiente está desatualizado. Reimplante o serviço de extração e publique novamente.";
const BRAND_EXTRACT_FALLBACK_MESSAGE = "Não conseguimos analisar o site — confira a URL.";
const BRAND_EXTRACT_CONNECTION_MESSAGE =
  "Não foi possível conectar ao serviço de extração. Tente novamente.";

type BrandExtractEnvelope = {
  error?: string;
  contract_version?: number;
  revision?: string;
  request_id?: string;
  diagnostics?: BrandDiagnostics;
  project_ref?: string;
  served_by?: string;
};

function readDiagnostics(value: unknown): BrandDiagnostics | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as { steps?: unknown; assets?: unknown };
  if (!Array.isArray(raw.steps) && !Array.isArray(raw.assets)) return undefined;
  return {
    steps: Array.isArray(raw.steps) ? (raw.steps as BrandDiagnostics["steps"]) : [],
    assets: Array.isArray(raw.assets) ? (raw.assets as BrandDiagnostics["assets"]) : [],
  };
}

function readBrandExtractEnvelope(
  value: unknown,
  headers?: Headers | null,
): BrandExtractEnvelope | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  // Identifica em qual instância a função foi servida — é o que distingue
  // "bug no código" de "deploy antigo em outro ambiente/remix".
  const projectRef = headers?.get("sb-project-ref") ?? undefined;
  const servedBy = headers?.get("x-served-by") ?? undefined;
  return {
    error: typeof raw.error === "string" ? raw.error : undefined,
    contract_version: typeof raw.contract_version === "number" ? raw.contract_version : undefined,
    revision: typeof raw.revision === "string" ? raw.revision : undefined,
    request_id: typeof raw.request_id === "string" ? raw.request_id : undefined,
    diagnostics: readDiagnostics(raw.diagnostics),
    project_ref: projectRef,
    served_by: servedBy,
  };
}

function isIncompatibleBrandContract(envelope: BrandExtractEnvelope | null): boolean {
  return (
    envelope?.contract_version !== undefined &&
    envelope.contract_version !== BRAND_EXTRACT_CONTRACT_VERSION
  );
}

/**
 * Corpo JSON de erro vindo da própria função, mas sem `contract_version` nem
 * `revision`: só versões antigas respondem assim. A mensagem crua de runtime
 * não deve ser repassada ao usuário. Falha de rede (sem resposta HTTP) NÃO
 * entra aqui — isso é indisponibilidade, não backend desatualizado.
 */
function isStaleBrandBackend(envelope: BrandExtractEnvelope | null): boolean {
  if (!envelope) return false;
  if (typeof envelope.error !== "string") return false;
  return envelope.contract_version === undefined && envelope.revision === undefined;
}

function unavailableDiagnostics(detail: string): BrandDiagnostics {
  return {
    steps: [
      {
        id: "chamada_servico",
        label: "Chamada ao serviço",
        status: "falhou",
        detail,
      },
    ],
    assets: [],
  };
}

function isBrandExtractResult(value: unknown): value is BrandExtractResult {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.primary === "string" &&
    typeof raw.primary_foreground === "string" &&
    typeof raw.accent_foreground === "string" &&
    typeof raw.source_hex === "string"
  );
}

function StepEmpresa({
  registerSave,
}: {
  registerSave: (fn: (() => Promise<boolean>) | null) => void;
}) {
  const { data: profile } = useCurrentProfile();
  const qc = useQueryClient();
  const tenantId = profile?.tenant_id;
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [segment, setSegment] = useState("");
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<{
    data: BrandDiagnostics;
    requestId: string | null;
    revision: string | null;
    projectRef: string | null;
    servedBy: string | null;
    hasError: boolean;
  } | null>(null);

  const [siteUrl, setSiteUrl] = useState("");
  const [extracted, setExtracted] = useState<BrandExtractResult | null>(null);
  const [business, setBusiness] = useState<ExtractedBusiness | null>(null);
  const businessEntries = useMemo(() => autoFillEntries(business), [business]);

  const tenantQ = useQuery({
    queryKey: ["tenant-onboarding", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants")
        .select("id, name, logo_url, business_profile")
        .eq("id", tenantId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  useEffect(() => {
    if (tenantQ.data) {
      setName(tenantQ.data.name ?? "");
      const bp = normalizeBusinessProfile(tenantQ.data.business_profile);
      setSegment(bp.segment ?? "");
    }
  }, [tenantQ.data]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!tenantQ.data?.logo_url) {
        setLogoPreview(null);
        return;
      }
      const { data } = await supabase.storage
        .from("logos")
        .createSignedUrl(tenantQ.data.logo_url, 3600);
      if (!cancelled) setLogoPreview(data?.signedUrl ?? null);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [tenantQ.data?.logo_url]);

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
      qc.invalidateQueries({ queryKey: ["tenant-onboarding"] });
      qc.invalidateQueries({ queryKey: ["tenant"] });
      qc.invalidateQueries({ queryKey: ["topbar-tenant"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "Erro no upload"),
  });

  const extractBrand = useMutation({
    mutationFn: async () => {
      setDiagnostics(null);
      let invocation: Awaited<ReturnType<typeof supabase.functions.invoke>>;
      try {
        invocation = await supabase.functions.invoke("brand-extract", {
          body: { url: siteUrl.trim() },
        });
      } catch (error) {
        setDiagnostics({
          data: unavailableDiagnostics("A chamada não chegou a produzir uma resposta."),
          requestId: null,
          revision: null,
          projectRef: null,
          servedBy: null,
          hasError: true,
        });
        throw new Error(userFacingErrorMessage(error, BRAND_EXTRACT_CONNECTION_MESSAGE));
      }
      const { data, error } = invocation;
      let envelope = readBrandExtractEnvelope(data);
      const registrar = (diag: BrandDiagnostics, hasError: boolean) =>
        setDiagnostics({
          data: diag,
          requestId: envelope?.request_id ?? null,
          revision: envelope?.revision ?? null,
          projectRef: envelope?.project_ref ?? null,
          servedBy: envelope?.served_by ?? null,
          hasError,
        });
      const staleDiagnostics = () =>
        unavailableDiagnostics(
          envelope?.project_ref
            ? `${BRAND_EXTRACT_STALE_MESSAGE} Instância: ${envelope.project_ref}.`
            : BRAND_EXTRACT_STALE_MESSAGE,
        );
      if (error) {
        // Em resposta não-2xx o supabase-js não parseia o corpo: ele vem no
        // `context` (Response) do FunctionsHttpError. Sempre lemos o envelope
        // inteiro para validar a revisão e guardar o diagnóstico também nos erros.
        const ctx = (error as { context?: unknown }).context;
        let status: number | null = null;
        if (ctx instanceof Response) {
          status = ctx.status;
          try {
            envelope = readBrandExtractEnvelope(await ctx.clone().json(), ctx.headers) ?? envelope;
          } catch {
            // corpo não-JSON — mantém a mensagem genérica
          }
        } else if ((error as { name?: string }).name === "FunctionsFetchError") {
          // Nem chegou a existir resposta HTTP: é indisponibilidade de rede,
          // nunca backend desatualizado.
          registrar(unavailableDiagnostics("A chamada não chegou ao serviço de extração."), true);
          throw new Error(BRAND_EXTRACT_CONNECTION_MESSAGE);
        }
        if (isIncompatibleBrandContract(envelope)) {
          registrar(
            envelope?.diagnostics ?? unavailableDiagnostics(BRAND_EXTRACT_INCOMPATIBLE_MESSAGE),
            true,
          );
          throw new Error(BRAND_EXTRACT_INCOMPATIBLE_MESSAGE);
        }
        // Backend antigo: a mensagem do corpo é texto cru de runtime e
        // confunde o usuário. Trocamos por orientação de reimplantação.
        if (isStaleBrandBackend(envelope)) {
          registrar(staleDiagnostics(), true);
          throw new Error(BRAND_EXTRACT_STALE_MESSAGE);
        }
        const mensagem =
          envelope?.error ??
          (status === 401
            ? "Sua sessão expirou. Entre novamente para continuar."
            : status !== null && status >= 500
              ? "O serviço de extração está indisponível no momento. Tente novamente."
              : BRAND_EXTRACT_FALLBACK_MESSAGE);
        registrar(envelope?.diagnostics ?? unavailableDiagnostics(mensagem), true);
        throw new Error(
          envelope?.request_id ? `${mensagem} (ref. ${envelope.request_id})` : mensagem,
        );
      }
      if (isIncompatibleBrandContract(envelope)) {
        registrar(
          envelope?.diagnostics ?? unavailableDiagnostics(BRAND_EXTRACT_INCOMPATIBLE_MESSAGE),
          true,
        );
        throw new Error(BRAND_EXTRACT_INCOMPATIBLE_MESSAGE);
      }
      if (envelope?.error) {
        if (isStaleBrandBackend(envelope)) {
          registrar(staleDiagnostics(), true);
          throw new Error(BRAND_EXTRACT_STALE_MESSAGE);
        }
        throw new Error(envelope.error);
      }
      if (!isBrandExtractResult(data)) {
        registrar(
          isStaleBrandBackend(envelope)
            ? staleDiagnostics()
            : unavailableDiagnostics("O serviço retornou uma resposta incompleta."),
          true,
        );
        throw new Error(
          isStaleBrandBackend(envelope)
            ? BRAND_EXTRACT_STALE_MESSAGE
            : BRAND_EXTRACT_FALLBACK_MESSAGE,
        );
      }
      return data;
    },
    onSuccess: (data) => {
      setExtracted(data);
      if (data.diagnostics) {
        setDiagnostics({
          data: data.diagnostics,
          requestId: data.request_id ?? null,
          revision: data.revision ?? null,
          projectRef: null,
          servedBy: null,
          hasError: false,
        });
      }
      if (!segment.trim() && data.suggested_segment) setSegment(data.suggested_segment);
      // Dados empresariais são aditivos: backend antigo não devolve `business`.
      const extractedBusiness = readExtractedBusiness(data.business);
      setBusiness(extractedBusiness);
      const companyName = extractedBusiness?.company_name;
      if (!name.trim() && companyName?.value && companyName.confidence >= 0.8) {
        setName(companyName.value);
      }
      if (!segment.trim() && !data.suggested_segment) {
        const seg = extractedBusiness?.segment;
        if (seg?.value && seg.confidence >= 0.8) setSegment(seg.value);
      }
    },
    onError: (e: Error) => toast.error(userFacingErrorMessage(e, "Falha na extração")),
  });

  const applyBrand = useMutation({
    mutationFn: async () => {
      if (!tenantId || !extracted) throw new Error("Nada para aplicar");
      // Merge respeita o que o usuário já preencheu: nada é sobrescrito.
      const { profile, applied } = mergeBusinessProfile(tenantQ.data?.business_profile, business);
      const bp = profile as unknown as Record<string, unknown>;
      const next = {
        ...bp,
        segment: segment.trim() || (bp.segment as string | undefined) || "",
        site_url: siteUrl.trim(),
        brand: {
          primary: extracted.primary,
          primary_foreground: extracted.primary_foreground,
          accent_foreground: extracted.accent_foreground,
        },
      };
      const { error } = await supabase
        .from("tenants")
        .update({ business_profile: JSON.parse(JSON.stringify(next)) })
        .eq("id", tenantId);
      if (error) throw error;
      return { brand: extracted, appliedCount: Object.keys(applied).length };
    },
    onSuccess: ({ brand, appliedCount }) => {
      applyBrandTheme(brand);
      setExtracted(null);
      setBusiness(null);
      toast.success(
        appliedCount > 0
          ? `Cores da marca aplicadas e ${appliedCount} campo(s) preenchidos com dados do site.`
          : "Cores da marca aplicadas.",
      );
      qc.invalidateQueries({ queryKey: ["tenant-onboarding"] });
      qc.invalidateQueries({ queryKey: ["topbar-tenant"] });
      qc.invalidateQueries({ queryKey: ["tenant-business-profile"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "Erro ao aplicar"),
  });

  // Persistência do passo 1 no Avançar. Declarado após as mutations para poder
  // observar `isPending` nas deps (evita capturar flags obsoletos).
  useEffect(() => {
    registerSave(async () => {
      if (!tenantId) return true;
      // Não persiste enquanto outra escrita do tenant está em voo — evita
      // last-write-wins sobrescrevendo brand/logo com snapshot obsoleto.
      if (applyBrand.isPending || uploadLogo.isPending || extractBrand.isPending) {
        toast.error("Aguarde a operação em andamento terminar.");
        return false;
      }
      try {
        const bp = normalizeBusinessProfile(tenantQ.data?.business_profile);
        const next = { ...bp, segment: segment.trim() };
        // Nome é obrigatório: só grava se não-vazio — nunca regride para vazio
        // (campo limpo ou tenant ainda carregando).
        const { error } = await supabase
          .from("tenants")
          .update(
            name.trim()
              ? { name: name.trim(), business_profile: JSON.parse(JSON.stringify(next)) }
              : { business_profile: JSON.parse(JSON.stringify(next)) },
          )
          .eq("id", tenantId);
        if (error) throw error;
        qc.invalidateQueries({ queryKey: ["tenant"] });
        qc.invalidateQueries({ queryKey: ["tenant-onboarding"] });
        qc.invalidateQueries({ queryKey: ["tenant-business-profile"] });
        qc.invalidateQueries({ queryKey: ["topbar-tenant"] });
        return true;
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Erro ao salvar");
        return false;
      }
    });
    return () => registerSave(null);
  }, [
    name,
    segment,
    tenantId,
    tenantQ.data?.business_profile,
    qc,
    registerSave,
    applyBrand.isPending,
    uploadLogo.isPending,
    extractBrand.isPending,
  ]);

  if (tenantQ.isLoading) return <Skeleton className="h-64 w-full" />;

  return (
    <div className="space-y-6">
      <p className="text-body text-muted-foreground">
        Comece pelo básico do seu negócio. Você pode pular e ajustar depois em Configurações →
        Empresa.
      </p>

      <div className="flex items-start gap-6">
        <div className="flex flex-col items-center gap-2">
          <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
            {logoPreview ? (
              <img src={logoPreview} alt="Logo" className="h-full w-full object-cover" />
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

        <div className="flex-1 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="wiz-name">Nome da empresa / marca</Label>
            <Input id="wiz-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wiz-segment">Segmento</Label>
            <Input
              id="wiz-segment"
              value={segment}
              onChange={(e) => setSegment(e.target.value)}
              placeholder="Ex.: clínica odontológica, marcenaria, estúdio de tatuagem"
            />
            <p className="text-caption text-muted-foreground">
              Uma frase curta descrevendo o que você faz — ajuda a IA a se apresentar no tom certo.
            </p>
          </div>
        </div>
      </div>

      {/* Identidade visual a partir do site (fator UAU) */}
      <div className="space-y-3 rounded-lg border border-border p-4">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <span className="text-body font-medium">Analisar identidade da sua empresa</span>
        </div>
        <p className="text-caption text-muted-foreground">
          Informe o site da sua empresa. A IA analisa sua marca e identifica informações para
          personalizar automaticamente o CRM.
        </p>
        <div className="flex gap-2">
          <Input
            value={siteUrl}
            onChange={(e) => setSiteUrl(e.target.value)}
            placeholder="https://seudominio.com.br"
            onKeyDown={(e) => {
              if (e.key === "Enter" && siteUrl.trim()) extractBrand.mutate();
            }}
          />
          <Button
            variant="outline"
            onClick={() => extractBrand.mutate()}
            disabled={!siteUrl.trim() || extractBrand.isPending}
          >
            {extractBrand.isPending ? (
              <>
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                Analisando…
              </>
            ) : (
              "Analisar site"
            )}
          </Button>
        </div>

        {extracted && (
          <div className="flex flex-wrap items-center gap-4 rounded-md bg-muted/40 p-3">
            <div className="flex items-center gap-2">
              <span
                className="h-8 w-8 rounded-md border border-border"
                style={{ backgroundColor: extracted.primary }}
                aria-label={`Cor principal ${extracted.primary}`}
              />
              <div className="text-caption">
                <p className="font-medium">{extracted.site_title ?? "Site analisado"}</p>
                <p className="text-muted-foreground">
                  {extracted.primary} · contraste ajustado automaticamente
                </p>
              </div>
            </div>
            <div className="ml-auto flex gap-2">
              <Button size="sm" onClick={() => applyBrand.mutate()} disabled={applyBrand.isPending}>
                {applyBrand.isPending ? "Aplicando…" : "Aplicar"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setExtracted(null);
                  setBusiness(null);
                }}
                disabled={applyBrand.isPending}
              >
                Descartar
              </Button>
            </div>
          </div>
        )}

        {extracted && businessEntries.length > 0 && (
          <div className="space-y-2 rounded-md border border-border p-3">
            <p className="text-caption font-medium">Dados encontrados no site</p>
            <ul className="space-y-1">
              {businessEntries.map((entry) => (
                <li key={entry.key} className="flex flex-wrap items-baseline gap-2 text-caption">
                  <span className="text-muted-foreground">{entry.label}:</span>
                  <span className="font-medium">{entry.display}</span>
                  <span className="text-muted-foreground">
                    ({SOURCE_LABEL[entry.source]}
                    {entry.applicable ? "" : " · confirmação manual"})
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-caption text-muted-foreground">
              Ao aplicar, só campos ainda vazios são preenchidos — o que você digitou permanece.
            </p>
          </div>
        )}

        {diagnostics && (
          <BrandExtractDiagnostics
            diagnostics={diagnostics.data}
            requestId={diagnostics.requestId}
            revision={diagnostics.revision}
            projectRef={diagnostics.projectRef}
            servedBy={diagnostics.servedBy}
            hasError={diagnostics.hasError}
          />
        )}
      </div>
    </div>
  );
}

/* ================================================================== */
/* Passo 2 — Nicho                                                     */
/* ================================================================== */

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function suggestTemplateSlug(
  segment: string | null | undefined,
  templates: NicheTemplate[],
): string | null {
  if (!segment) return null;
  const seg = normalizeText(segment);
  if (!seg) return null;
  const segTokens = seg.split(" ").filter((t) => t.length >= 3);
  if (segTokens.length === 0) return null;

  let best: { slug: string; score: number } | null = null;
  for (const t of templates) {
    const hay = normalizeText(`${t.name} ${t.description ?? ""} ${t.slug}`);
    if (!hay) continue;
    let score = 0;
    for (const tok of segTokens) {
      if (hay.includes(tok)) score += tok.length;
    }
    if (score > 0 && (!best || score > best.score)) best = { slug: t.slug, score };
  }
  return best?.slug ?? null;
}

function StepNicho({
  registerSave,
}: {
  registerSave: (fn: (() => Promise<boolean>) | null) => void;
}) {
  const templatesQ = useNicheTemplates();
  const tenantQ = useTenantOnboarding();
  const apply = useApplyNicheTemplate();
  const [pending, setPending] = useState<NicheTemplate | null>(null);
  const [confirmInfo, setConfirmInfo] = useState<{
    stageCount: number;
    dealCount: number;
  } | null>(null);
  const { data: profile } = useCurrentProfile();

  const doApply = (t: NicheTemplate) => {
    apply.mutate(t, {
      onSuccess: () => {
        toast.success(`Modelo "${t.name}" aplicado.`);
        setPending(null);
        setConfirmInfo(null);
      },
      onError: (e: Error) => toast.error(e.message ?? "Falha ao aplicar."),
    });
  };

  const onPick = async (t: NicheTemplate) => {
    if (!profile?.tenant_id) return;
    // Check if there are custom stages / deals already.
    const info = await fetchDefaultBoardInfo(profile.tenant_id);
    if (info.stageCount > 0) {
      setPending(t);
      setConfirmInfo({ stageCount: info.stageCount, dealCount: info.dealCount });
      return;
    }
    doApply(t);
  };

  const currentNiche = tenantQ.data?.niche ?? null;

  // Achado 2 — este era o único passo sem `registerSave`, então "Avançar" fazia
  // exatamente o mesmo que "Pular". Como o funil do tenant só nasce dentro de
  // useApplyNicheTemplate, quem clicava "Avançar" achando que tinha escolhido
  // saía do assistente sem board nenhum. Agora "Avançar" exige a escolha; quem
  // quer decidir depois usa "Pular", que é explícito.
  useEffect(() => {
    registerSave(async () => {
      if (currentNiche) return true;
      toast.error(
        'Escolha um modelo de funil para continuar — ou use "Pular" para configurar depois.',
      );
      return false;
    });
    return () => registerSave(null);
  }, [currentNiche, registerSave]);
  const segment = useMemo(() => {
    const bp = tenantQ.data?.business_profile as { segment?: string } | null | undefined;
    return bp?.segment ?? null;
  }, [tenantQ.data?.business_profile]);
  const suggestedSlug = useMemo(
    () => (currentNiche ? null : suggestTemplateSlug(segment, templatesQ.data ?? [])),
    [segment, templatesQ.data, currentNiche],
  );

  return (
    <div className="space-y-4">
      <p className="text-body text-muted-foreground">
        Aplicar um modelo cria/atualiza o funil padrão e semeia os prompts da assistente virtual.
        Você pode editar tudo depois em Assistente IA.
      </p>

      {templatesQ.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {(templatesQ.data ?? []).map((t) => {
            const active = currentNiche === t.slug;
            const suggested = !active && suggestedSlug === t.slug;
            return (
              <Card
                key={t.slug}
                className={`flex flex-col transition-colors ${
                  active
                    ? "border-primary ring-1 ring-primary/40"
                    : suggested
                      ? "border-primary/70 ring-1 ring-primary/20"
                      : ""
                }`}
              >
                <CardHeader>
                  {suggested && (
                    <div className="mb-1 flex items-center gap-1.5 text-caption font-medium text-primary">
                      <Sparkles className="h-3.5 w-3.5" />
                      Sugerido pelo seu segmento
                    </div>
                  )}
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-card-title">{t.name}</CardTitle>
                    {active && <StatusBadge variant="success">Aplicado</StatusBadge>}
                  </div>
                  <CardDescription>{t.description}</CardDescription>
                </CardHeader>
                <CardContent className="mt-auto space-y-3">
                  <div className="text-caption text-muted-foreground">
                    {t.stages.length} estágios · {t.stage_prompts.length} prompts prontos
                  </div>
                  <Button
                    onClick={() => onPick(t)}
                    disabled={apply.isPending}
                    className="w-full"
                    variant={active ? "outline" : "default"}
                  >
                    {apply.isPending && apply.variables?.slug === t.slug ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Aplicando…
                      </>
                    ) : active ? (
                      "Reaplicar"
                    ) : (
                      "Escolher este modelo"
                    )}
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <AlertDialog
        open={!!pending && !!confirmInfo}
        onOpenChange={(v) => {
          if (!v) {
            setPending(null);
            setConfirmInfo(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Substituir funil existente?</AlertDialogTitle>
            <AlertDialogDescription>
              Já existem {confirmInfo?.stageCount} estágios personalizados
              {confirmInfo && confirmInfo.dealCount > 0
                ? ` e ${confirmInfo.dealCount} negócios cadastrados`
                : ""}
              . Aplicar o modelo "{pending?.name}" vai substituir os estágios e reescrever os
              prompts da IA. Essa ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => pending && doApply(pending)}>
              Substituir mesmo assim
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ================================================================== */
/* Passo 3 — Canais                                                    */
/* ================================================================== */

function StepCanais() {
  const catalogQ = useVisibleIntegrationsCatalog();
  const tenantQ = useTenantIntegrations();

  const byslug = new Map((tenantQ.data ?? []).map((r) => [r.slug, r] as const));

  const targets = useMemo(() => {
    const map = new Map((catalogQ.data ?? []).map((c) => [c.slug, c] as const));
    // Ordem = do mais fácil para o mais trabalhoso, que é o que o leigo
    // precisa no onboarding: Zappaz primeiro (assistente próprio, configura o
    // webhook sozinho), depois a API oficial da Meta e as demais alternativas.
    // Lista fixa e não o catálogo inteiro: aqui só entra canal de conversa, e
    // `twilio`/`resend` seguem listados como intenção — hoje são filtrados
    // antes por `HIDDEN_CATALOG_SLUGS` (useVisibleIntegrationsCatalog).
    const slugs = ["zappaz", "meta-cloud", "twilio", "zapi", "elevenlabs"];
    return slugs.map((slug) => map.get(slug)).filter(Boolean) as NonNullable<
      ReturnType<typeof map.get>
    >[];
  }, [catalogQ.data]);

  const isLoading = catalogQ.isLoading || tenantQ.isLoading;

  return (
    <div className="space-y-4">
      <p className="text-body text-muted-foreground">
        Conecte o WhatsApp agora para começar a receber mensagens. Você pode pular e conectar depois
        em Integrações.
      </p>

      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface p-3 text-caption text-muted-foreground">
        <MessageCircle className="h-4 w-4 text-primary" /> WhatsApp
        <AudioLines className="ml-3 h-4 w-4 text-primary" /> Voz (IA)
      </div>

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-56 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {targets.map((c) => (
            <IntegrationCard key={c.slug} catalog={c} tenant={byslug.get(c.slug) ?? null} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ================================================================== */
/* Passo 4 — Perfil do negócio                                         */
/* ================================================================== */

function StepPerfilNegocio({
  registerSave,
}: {
  registerSave: (fn: (() => Promise<boolean>) | null) => void;
}) {
  const { data: profile } = useCurrentProfile();
  const qc = useQueryClient();
  const tenantId = profile?.tenant_id;
  const [value, setValue] = useState<BusinessProfile>(emptyBusinessProfile());

  const tenantQ = useQuery({
    queryKey: ["tenant-business-profile", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants")
        .select("business_profile")
        .eq("id", tenantId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  useEffect(() => {
    if (tenantQ.data) setValue(normalizeBusinessProfile(tenantQ.data.business_profile));
  }, [tenantQ.data]);

  const save = useMutation({
    mutationFn: async () => {
      if (!tenantId) throw new Error("Tenant inválido");
      const { error } = await supabase
        .from("tenants")
        .update({ business_profile: JSON.parse(JSON.stringify(value)) })
        .eq("id", tenantId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Perfil do negócio salvo");
      qc.invalidateQueries({ queryKey: ["tenant-business-profile"] });
      qc.invalidateQueries({ queryKey: ["tenant-onboarding"] });
    },
    onError: (e: Error) => toast.error(e.message ?? "Erro ao salvar"),
  });

  useEffect(() => {
    registerSave(async () => {
      if (!tenantId) return true;
      try {
        await save.mutateAsync();
        return true;
      } catch {
        return false;
      }
    });
    return () => registerSave(null);
  }, [value, tenantId, save, registerSave]);

  if (tenantQ.isLoading) return <Skeleton className="h-96 w-full" />;

  return (
    <div className="space-y-4">
      <BusinessProfileForm value={value} onChange={setValue} hideSegment showHelp={false} />
    </div>
  );
}

/* ================================================================== */
/* Passo 5 — Equipe                                                    */
/* ================================================================== */

function StepEquipe() {
  const { user } = useAuth();
  const { data: profile } = useCurrentProfile();
  const qc = useQueryClient();
  const tenantId = profile?.tenant_id;
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "agent">("agent");
  const [lastLink, setLastLink] = useState<string | null>(null);

  const invitesQ = useQuery({
    queryKey: ["team-invites", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("invites")
        .select("id, email, role, token, expires_at, accepted_at, created_at")
        .is("accepted_at", null)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      if (!tenantId) throw new Error("Tenant inválido");
      return createInvite({ tenantId, email, role, createdBy: user?.id ?? null });
    },
    onSuccess: ({ token, superseded }) => {
      qc.invalidateQueries({ queryKey: ["team-invites"] });
      toast.success(
        superseded > 0
          ? "Convite criado. O convite anterior para este e-mail deixou de valer."
          : "Convite criado",
      );
      const link = `${window.location.origin}/auth?invite=${token}`;
      setLastLink(link);
      navigator.clipboard.writeText(link).catch(() => {});
      setEmail("");
      setRole("agent");
    },
    onError: (e: Error) => toast.error(e.message ?? "Erro ao criar convite"),
  });

  const cancelInvite = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("invites").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["team-invites"] }),
  });

  return (
    <div className="space-y-5">
      <p className="text-body text-muted-foreground">
        Convide sua equipe agora ou pule esta etapa — dá para convidar depois em Configurações →
        Equipe.
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="text-card-title">Convidar pessoa</CardTitle>
          <CardDescription>
            Geramos um link de convite e copiamos pra você — envie à pessoa. Ao se cadastrar com
            esse e-mail, ela entra automaticamente na sua empresa.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-[1fr_150px_auto]">
            <Input
              type="email"
              placeholder="email@exemplo.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Select value={role} onValueChange={(v) => setRole(v as "admin" | "agent")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Administrador</SelectItem>
                <SelectItem value="agent">Atendente</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={() => create.mutate()} disabled={!email.trim() || create.isPending}>
              <UserPlus className="mr-1 h-4 w-4" />
              {create.isPending ? "Criando…" : "Convidar"}
            </Button>
          </div>
          {lastLink && (
            <div className="flex items-center gap-2 rounded-md border border-border bg-surface p-2 text-caption">
              <Check className="h-4 w-4 text-success" />
              Convite criado — link copiado para a área de transferência.
            </div>
          )}
        </CardContent>
      </Card>

      <div>
        <Label className="mb-2 block">Convites pendentes</Label>
        {invitesQ.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : (invitesQ.data ?? []).length === 0 ? (
          <p className="text-caption text-muted-foreground">Nenhum convite pendente.</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {invitesQ.data!.map((i) => (
              <li key={i.id} className="flex items-center gap-3 p-3">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="text-body font-medium">{i.email}</div>
                  <div className="text-caption text-muted-foreground">
                    Papel: {i.role === "admin" ? "Administrador" : "Atendente"}
                  </div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => cancelInvite.mutate(i.id)}>
                  <X className="mr-1 h-4 w-4" />
                  Cancelar
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* ================================================================== */
/* Passo 6 — Importar contatos (opcional)                              */
/* ================================================================== */

// Passo final e opcional: reaproveita EXATAMENTE o mesmo dialog/hook de
// import CSV usado na tela de Contatos (ContactImportDialog → useContactImport
// + parseContactImportFile) — nenhuma lógica de parsing/mapeamento duplicada
// aqui. O passo é pulável: "Pular"/"Concluir" fecham o wizard normalmente
// mesmo sem nenhum arquivo importado.
function StepImportarContatos() {
  const [importOpen, setImportOpen] = useState(false);

  return (
    <div className="space-y-4">
      <p className="text-body text-muted-foreground">
        Já tem uma base de contatos em CSV? Importe agora para começar a usar o CRM com seus dados
        reais. Esta etapa é opcional — você pode pular e importar depois em Contatos.
      </p>

      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border p-8 text-center">
        <FileUp className="h-6 w-6 text-muted-foreground" aria-hidden />
        <Button onClick={() => setImportOpen(true)}>Importar contatos via CSV</Button>
        <span className="text-caption text-muted-foreground">
          Ou clique em "Pular" para configurar depois.
        </span>
      </div>

      <ContactImportDialog open={importOpen} onOpenChange={setImportOpen} />
    </div>
  );
}
