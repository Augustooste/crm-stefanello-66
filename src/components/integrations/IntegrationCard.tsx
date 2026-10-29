import { useEffect, useRef, useState, type ReactNode } from "react";
import { friendlyIntegrationError } from "@/lib/integrations/friendly-errors";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MessageCircle,
  Mail,
  Phone,
  Megaphone,
  AudioLines,
  Sparkles,
  Lock,
  Copy,
  Check,
  Loader2,
  AlertCircle,
  Info,
  Trash2,
  QrCode,
  ExternalLink,
  CircleDashed,
  CircleAlert,
  CircleCheck,
  BookOpenText,
} from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/common/StatusBadge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { relativeFromNow } from "@/lib/format";
import {
  type IntegrationStatus,
  type TenantIntegrationRow,
  type ChannelRow,
  type WebhookHealth,
} from "@/lib/api/integrations";
import { getWizard } from "@/lib/integrations/wizards/registry";
import { IntegrationWizardDialog, clearWizardDraft } from "./IntegrationWizardDialog";
import { ManyChatSetupPanel } from "./ManyChatSetupPanel";
import { isManyChatSlug } from "@/lib/integrations/manychat";
import { getChecklist, type ChecklistDef } from "./checklists";
import { ConnectionDiagnostics } from "./ConnectionDiagnostics";
import { ElevenLabsVoiceSettings } from "./ElevenLabsVoiceSettings";
import { useCurrentProfile } from "@/lib/api/session";

export type CatalogField = {
  key: string;
  label: string;
  help: string;
  type?: "text" | "password" | "select";
  options?: string[];
  default?: string;
  /** Campo dispensável: não bloqueia o avanço do assistente nem o salvamento. */
  optional?: boolean;
};
/** Rótulos amigáveis para valores de opção crus vindos do catálogo. */
const SELECT_OPTION_LABELS: Record<string, string> = {
  na: "América do Norte (na)",
  eu: "Europa (eu)",
};
export type CatalogRow = {
  slug: string;
  name: string;
  description: string;
  icon: string | null;
  available: boolean;
  required_secrets: CatalogField[] | null;
  setup_steps: Array<{ title: string; body: string } | string> | null;
};

type SetupStep = { title: string; body: string };

export function normalizeSetupSteps(steps: CatalogRow["setup_steps"]): SetupStep[] {
  if (!Array.isArray(steps)) return [];
  return steps.flatMap((step, index) => {
    if (typeof step === "string") {
      const body = step.trim();
      return body ? [{ title: `Passo ${index + 1}`, body }] : [];
    }
    const title = typeof step?.title === "string" ? step.title.trim() : "";
    const body = typeof step?.body === "string" ? step.body.trim() : "";
    return title || body ? [{ title: title || `Passo ${index + 1}`, body }] : [];
  });
}

// Provedores de WhatsApp reconhecidos. Vários podem coexistir por tenant
// (a seleção de qual número usar fica no filtro do inbox).
const WA_SLUGS = ["zapi", "twilio", "meta-cloud", "evolution", "zappaz"];

const ICONS: Record<string, ReactNode> = {
  whatsapp: <MessageCircle className="h-6 w-6" />,
  mail: <Mail className="h-6 w-6" />,
  phone: <Phone className="h-6 w-6" />,
  megaphone: <Megaphone className="h-6 w-6" />,
  voice: <AudioLines className="h-6 w-6" />,
  sparkles: <Sparkles className="h-6 w-6" />,
  knowledge: <BookOpenText className="h-6 w-6" />,
};

// Integrações sem webhook inbound (chamam a API do provedor pra fora, não
// recebem callback) — sem URL de webhook pra exibir/configurar no painel
// externo. Usado tanto pelo SetupView (esconde o bloco de webhook) quanto
// pela descrição do ConnectDialog (não instrui "copie a URL de webhook").
const NO_WEBHOOK_SLUGS = new Set<string>(["elevenlabs", "llamacloud", "apify"]);

export function iconFor(slug: string, icon: string | null) {
  if (icon && ICONS[icon]) return ICONS[icon];
  if (slug === "resend") return ICONS.mail;
  if (slug === "twilio") return ICONS.phone;
  if (slug === "zapi" || slug === "zappaz" || slug === "evolution") return ICONS.whatsapp;
  if (slug === "meta-ads") return ICONS.megaphone;
  if (slug === "elevenlabs") return ICONS.voice;
  if (slug === "llamacloud") return ICONS.knowledge;
  return <MessageCircle className="h-6 w-6" />;
}

export function statusVariant(
  s: IntegrationStatus,
): "success" | "warning" | "destructive" | "neutral" {
  if (s === "active") return "success";
  if (s === "error") return "destructive";
  if (s === "pending") return "warning";
  return "neutral";
}
export function statusLabel(s: IntegrationStatus): string {
  if (s === "active") return "Ativo";
  if (s === "error") return "Erro";
  if (s === "pending") return "Pendente";
  return "Desconectado";
}

// Saúde do webhook (channels.webhook_health) — distinto do status da integração
// acima (tenant_integrations.status): um webhook pode ficar "broken" mesmo com a
// integração ativa (ex.: provedor mudou o payload, assinatura passou a falhar).
//
// `silent` NÃO é vermelho de propósito: significa "nunca recebeu evento algum",
// que é falta de tráfego/configuração, não regressão. Antes desta separação os 6
// canais de produção apareciam como "Webhook com problema" com zero falhas
// registradas, mandando o operador caçar bug inexistente.
//
// `broken` também deixou de ser vermelho (2026-07-27): o reconcile classifica
// assim qualquer canal que já recebeu algo mas ficou a janela inteira sem
// evento novo — em conta de baixo volume isso é só silêncio, não falha. Os dois
// canais de produção nessa situação (Meta e Zappaz) tinham 100% dos webhooks
// processados e `webhook_consecutive_failures = 0`. Rótulo neutro/aviso, sem
// alarme falso.
export function webhookHealthVariant(
  h: WebhookHealth | null,
): "success" | "warning" | "destructive" | "neutral" {
  if (h === "ok") return "success";
  if (h === "broken") return "warning";
  if (h === "silent") return "warning";
  return "neutral";
}
export function webhookHealthLabel(h: WebhookHealth | null): string {
  if (h === "ok") return "Webhook ok";
  if (h === "broken") return "Sem mensagens recentes";
  if (h === "silent") return "Nunca recebeu mensagem";
  return "Aguardando 1ª mensagem";
}

// Estado exibido no card = combinação de channels.status (conexão) com
// channels.webhook_health (tráfego). São sinais diferentes e antes colapsavam
// num badge só, o que fazia "pausado" e "falhou" aparecerem como silêncio.
// Precedência: falha real > pausa manual > tráfego.
export type ChannelCardState =
  | "failed" // webhook/canal em erro confirmado — exige ação
  | "session_down" // provedor confirmou que a sessão/conexão caiu
  | "paused" // desligado por decisão humana — não é problema
  | "no_recent" // já recebeu, mas nada nas últimas 72h
  | "never" // nunca recebeu evento algum
  | "waiting" // canal novo demais para julgar
  | "ok";

const CHANNEL_STATE_UI: Record<
  ChannelCardState,
  {
    label: string;
    variant: "success" | "warning" | "destructive" | "neutral";
    hint: string;
  }
> = {
  failed: {
    label: "Webhook falhou",
    variant: "destructive",
    hint: "O provedor recusou ou o processamento falhou. Revise as credenciais e a URL do webhook.",
  },
  session_down: {
    label: "Sessão desconectada",
    variant: "destructive",
    hint: "O provedor informou que a conexão caiu. Reconecte a integração (e escaneie o QR, se for o caso).",
  },
  paused: {
    label: "Pausado manualmente",
    variant: "neutral",
    hint: "Este canal foi desligado por um administrador. Reative para voltar a receber mensagens.",
  },
  no_recent: {
    label: "Sem mensagens recentes",
    variant: "warning",
    hint: "Nenhuma mensagem nas últimas 72 horas. Normal em canais de baixo volume.",
  },
  never: {
    label: "Nunca recebeu mensagem",
    variant: "warning",
    hint: "A URL do webhook pode não estar cadastrada no provedor.",
  },
  waiting: {
    label: "Aguardando 1ª mensagem",
    variant: "neutral",
    hint: "Canal recém-conectado. Envie uma mensagem de teste para confirmar.",
  },
  ok: {
    label: "Webhook ok",
    variant: "success",
    hint: "Mensagens chegando normalmente.",
  },
};

// Precedência: falha real > sessão caída > pausa manual > tráfego.
//
// `disconnected` passou a ter estado próprio (2026-07-31): a reconciliação
// agora consulta o provedor ao vivo (Evolution e Zappaz) e grava
// `status='disconnected'` quando a sessão morreu. Sem este ramo, o card caía
// no `webhook_health` — que só mede tráfego nas últimas 72h — e continuava
// exibindo "Webhook ok / Mensagens chegando normalmente" por até 3 dias
// depois de o WhatsApp ter caído. Foi exatamente o sintoma relatado no Zappaz.
export function channelCardState(channel: {
  status?: ChannelRow["status"];
  webhook_health: WebhookHealth | null;
}): ChannelCardState {
  if (channel.status === "error") return "failed";
  if (channel.status === "disconnected") return "session_down";
  if (channel.status === "disabled") return "paused";
  const h = channel.webhook_health;
  if (h === "ok") return "ok";
  if (h === "broken") return "no_recent";
  if (h === "silent") return "never";
  return "waiting";
}

export function channelCardStateUi(state: ChannelCardState) {
  return CHANNEL_STATE_UI[state];
}

// Integrações ocultadas da UI sem removê-las do backend (edge function +
// tabelas + migrations continuam de pé). A tela Integrações não filtra por
// `available` — `available:false` só vira selo "em breve", ainda visível —,
// então esconder de verdade exige tirar o slug daqui. Reversível: basta
// remover o slug para a integração reaparecer no catálogo.
// feegow, doutore e meta-ads: fora de uso por ora (decisão de produto);
// backend preservado.
// twilio, resend e evolution: ocultados a pedido (2026-07-27). Idem — só some
// do catálogo; provider-send.ts, evolution-client.ts, os branches de
// messaging-webhook e os secrets já gravados continuam intactos e funcionando.
// ATENÇÃO: `resend` tem tenant conectado e canal ativo em produção; ocultar
// tira a tela de gestão/reconexão dele, não desliga o canal.
// apify: fora do MVP (2026-07-27). Edge functions lead-enrich/integration-connect,
// a tabela apify_enrichment_runs e os secrets seguem intactos.
// agent-platform: área de Agentes de IA está desligada (ver AGENTES_IA_HABILITADO).
// O card oferecia "Conectar" para uma área que não existe na UI.
const HIDDEN_CATALOG_SLUGS = new Set<string>([
  "feegow",
  "doutore",
  "meta-ads",
  "twilio",
  "resend",
  "apify",
  "agent-platform",
]);

/** Integrações preservadas no backend, mas removidas de toda superfície visual. */
export function isIntegrationHidden(slug: string): boolean {
  return HIDDEN_CATALOG_SLUGS.has(slug);
}

const catalogQueryOptions = {
  queryKey: ["integrations-catalog"] as const,
  queryFn: async (): Promise<CatalogRow[]> => {
    const { data, error } = await supabase
      .from("integrations")
      .select("slug, name, description, icon, available, required_secrets, setup_steps")
      .order("available", { ascending: false })
      .order("name");
    if (error) throw error;
    return (data ?? []) as unknown as CatalogRow[];
  },
};

/**
 * Catálogo COMPLETO, sem aplicar HIDDEN_CATALOG_SLUGS.
 *
 * Ocultar um slug é decisão de descoberta ("não ofereça isso para conectar"), não
 * de observabilidade. Filtrar aqui dentro apagava junto a única superfície que
 * mostra `tenant_integrations.status`, `last_error` e o botão "Testar conexão"
 * (IntegrationStatusTable) — e `resend` tem tenant conectado e canal ativo em
 * produção. O canal seguia funcionando e quebrando em silêncio, sem tela para
 * diagnosticar. Monitoramento usa este hook; quem oferece conexão usa
 * useVisibleIntegrationsCatalog.
 */
export function useIntegrationsCatalog() {
  return useQuery<CatalogRow[]>(catalogQueryOptions);
}

/**
 * Catálogo das telas de descoberta/conexão (PluginsTab, OnboardingWizard):
 * esconde HIDDEN_CATALOG_SLUGS. Mesma queryKey — o `select` deriva do cache
 * compartilhado, sem segunda requisição.
 */
export function useVisibleIntegrationsCatalog() {
  return useQuery<CatalogRow[], Error, CatalogRow[]>({
    ...catalogQueryOptions,
    select: (rows) => rows.filter((row) => !isIntegrationHidden(row.slug)),
  });
}

export function IntegrationCard({
  catalog,
  tenant,
  channel = null,
  openRequested = false,
  onOpenRequestHandled,
}: {
  catalog: CatalogRow;
  tenant: TenantIntegrationRow | null;
  channel?: ChannelRow | null;
  openRequested?: boolean;
  onOpenRequestHandled?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const status: IntegrationStatus = tenant?.status ?? "disabled";
  const soon = !catalog.available;

  useEffect(() => {
    if (!openRequested || soon) return;
    cardRef.current?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    setOpen(true);
    onOpenRequestHandled?.();
  }, [openRequested, onOpenRequestHandled, soon]);

  return (
    <>
      <Card
        ref={cardRef}
        tabIndex={-1}
        data-integration-card={catalog.slug}
        className={`flex flex-col scroll-mt-24 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${soon ? "opacity-60" : ""}`}
      >
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-accent text-accent-foreground">
              {iconFor(catalog.slug, catalog.icon)}
            </div>
            {soon ? (
              <StatusBadge variant="warning">Em breve</StatusBadge>
            ) : (
              <StatusBadge variant={statusVariant(status)}>{statusLabel(status)}</StatusBadge>
            )}
          </div>
          <CardTitle className="mt-3">{catalog.name}</CardTitle>
          <CardDescription>{catalog.description}</CardDescription>
          {status === "error" && tenant?.last_error && (
            <p className="mt-2 flex items-start gap-1 text-caption text-destructive">
              <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
              {tenant.last_error}
            </p>
          )}
          {channel &&
            (() => {
              const state = channelCardState(channel);
              const ui = channelCardStateUi(state);
              return (
                <div className="mt-2 flex flex-col gap-1">
                  <div
                    className="flex flex-wrap items-center gap-2"
                    data-testid="webhook-health-badge"
                    data-channel-state={state}
                  >
                    <StatusBadge variant={ui.variant}>{ui.label}</StatusBadge>
                    {channel.last_connected_at && (
                      <span className="text-caption text-muted-foreground">
                        {/* "última conexão" (não "conectado") — o timestamp é histórico; o canal
                        pode estar desconectado agora mesmo com last_connected_at recente. */}
                        última conexão {relativeFromNow(channel.last_connected_at)}
                      </span>
                    )}
                  </div>
                  <p
                    className={`flex items-start gap-1 text-caption ${
                      state === "failed" ? "text-destructive" : "text-muted-foreground"
                    }`}
                    data-testid="webhook-health-hint"
                  >
                    {state === "failed" ? (
                      <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                    ) : (
                      <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                    )}
                    {ui.hint}
                  </p>
                  {channel.status_message && (
                    <p className="flex items-start gap-1 text-caption text-muted-foreground">
                      <Info className="mt-0.5 h-3 w-3 shrink-0" />
                      {/* Mesmo tratamento da IntegrationStatusTable: o status_message vem
                      cru do provedor (às vezes em inglês) e não pode ir direto pra tela. */}
                      {friendlyIntegrationError(catalog.slug, channel.status_message).message}
                    </p>
                  )}
                </div>
              );
            })()}
        </CardHeader>
        <CardContent className="mt-auto">
          <Button
            className="w-full"
            disabled={soon}
            variant={status === "active" ? "outline" : "default"}
            onClick={() => setOpen(true)}
          >
            {soon ? "Conectar" : status === "active" ? "Gerenciar" : "Conectar"}
          </Button>
        </CardContent>
      </Card>

      {!soon && (
        <ConnectDialog
          open={open}
          onOpenChange={setOpen}
          catalog={catalog}
          tenant={tenant}
          channel={channel}
        />
      )}
    </>
  );
}

// (Aviso de exclusividade removido — múltiplos provedores de WhatsApp podem
// coexistir. O inbox permite escolher qual número exibir.)

export function ConnectDialog({
  open,
  onOpenChange,
  catalog,
  tenant,
  channel = null,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  catalog: CatalogRow;
  tenant: TenantIntegrationRow | null;
  channel?: ChannelRow | null;
}) {
  const qc = useQueryClient();
  const profileQ = useCurrentProfile();
  const profileTenantId = profileQ.data?.tenant_id ?? null;
  const fields = catalog.required_secrets ?? [];
  // Campos `select` já entram preenchidos com o default do catálogo — sem isso o
  // submit envia string vazia e o teste de conexão falha.
  const [values, setValues] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const f of catalog.required_secrets ?? []) {
      if (f.type === "select") seed[f.key] = f.default ?? f.options?.[0] ?? "";
    }
    return seed;
  });
  const isActive = tenant?.status === "active";
  // Se já existe uma linha em `channels` (conexão iniciada, mesmo que
  // tenant_integrations ainda não esteja "active" — ex.: Evolution aguardando
  // QR), abre direto na tela de gerenciamento em vez do formulário de
  // credenciais: o operador precisa ver saúde/URL/QR, não redigitar chaves.
  const initialStep: "form" | "setup" = isActive || channel ? "setup" : "form";
  const [step, setStep] = useState<"form" | "setup">(initialStep);
  // Segredo do webhook ManyChat recém-gerado: a resposta do connect é a única
  // vez que ele vem ao navegador.
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  // Wizard passo-a-passo por provedor (opcional). Sem wizard, cai no
  // formulário plano — todos os campos de uma vez. Com wizard, cada passo
  // exibe só o subconjunto de campos declarado no registry; Voltar/Próximo
  // navegam sem submeter.
  const wizard = !isActive ? getWizard(catalog.slug) : null;

  const connect = useMutation({
    mutationFn: async (submittedValues: Record<string, string>) => {
      const { data, error } = await supabase.functions.invoke("integration-connect", {
        body: { action: "connect", slug: catalog.slug, values: submittedValues },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error ?? "Não foi possível conectar.");
      return data;
    },
    onSuccess: (data) => {
      toast.success(`${catalog.name} conectado.`);
      if (typeof data?.webhook_secret === "string") setRevealedSecret(data.webhook_secret);
      // Duas chaves, dois consumidores: o card lê `tenant_integrations`, mas o
      // checklist e o painel de diagnóstico leem `useTenantChannels`
      // (["tenant-channels", tenantId]). Invalidar só a primeira deixava o
      // canal antigo no cache pelo `staleTime` global de 60s (router.tsx) — e
      // quem tinha acabado de conectar via "Instância desconectada. Reabra a
      // Z-API e escaneie o QR novamente" no exato instante do sucesso.
      // Mesmo par usado em ConnectionDiagnostics.tsx.
      qc.invalidateQueries({ queryKey: ["tenant-integrations"] });
      qc.invalidateQueries({ queryKey: ["tenant-channels"] });
      setValues({});
      setStep("setup");
      clearWizardDraft(profileTenantId, catalog.slug);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const disconnect = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("integration-connect", {
        body: { action: "disconnect", slug: catalog.slug },
      });
      if (error) throw error;
      // A edge function reporta falha de escrita como 200 + {ok:false} (é assim
      // que a mensagem chega até aqui — invoke descarta o corpo em não-2xx). Sem
      // esta checagem, uma falha real vira toast de sucesso.
      if (!data?.ok) throw new Error(data?.error ?? "Não foi possível desativar.");
      return data;
    },
    onSuccess: () => {
      toast.success(`${catalog.name} desativado.`);
      qc.invalidateQueries({ queryKey: ["tenant-integrations"] });
      qc.invalidateQueries({ queryKey: ["tenant-channels"] });
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message ?? "Erro ao desativar."),
  });

  const forget = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("integration-connect", {
        body: { action: "forget", slug: catalog.slug },
      });
      if (error) throw error;
      // Fluxo de LGPD: confirmar "credenciais apagadas" quando o delete falhou é
      // exatamente o bug que este PR corrige no backend — a checagem tem que
      // existir dos dois lados.
      if (!data?.ok) throw new Error(data?.error ?? "Não foi possível apagar as credenciais.");
      return data;
    },
    onSuccess: () => {
      toast.success("Credenciais apagadas.");
      qc.invalidateQueries({ queryKey: ["tenant-integrations"] });
      qc.invalidateQueries({ queryKey: ["tenant-channels"] });
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message ?? "Erro ao apagar credenciais."),
  });

  // Sem wizard, mostra todos os campos do catálogo (fluxo plano legado —
  // usado no modo "edit" de uma integração já ativa). O caminho de conexão
  // inicial usa o IntegrationWizardDialog e não depende disto.
  const visibleFields = fields;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setValues({});
          setStep(initialStep);
          setRevealedSecret(null);
        }
        onOpenChange(v);
      }}
    >
      <DialogContent className="flex h-[calc(100dvh-2rem)] max-h-[760px] w-[calc(100vw-2rem)] max-w-xl flex-col gap-0 overflow-hidden p-0 break-words [overflow-wrap:anywhere]">
        <DialogHeader className="shrink-0 border-b border-border px-4 py-4 pr-12 sm:px-6 sm:py-5 sm:pr-12">
          <DialogTitle className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-md bg-accent text-accent-foreground">
              {iconFor(catalog.slug, catalog.icon)}
            </span>
            {isActive ? `Gerenciar ${catalog.name}` : `Conectar ${catalog.name}`}
          </DialogTitle>
          <DialogDescription>
            {step === "form"
              ? (wizard?.intro ??
                "Preencha as credenciais do provedor. Vamos testar antes de ativar.")
              : catalog.slug === "elevenlabs"
                ? "Integração ativa. O assistente já pode gerar áudios com a sua conta ElevenLabs. Use os botões abaixo para atualizar a chave ou desativar."
                : NO_WEBHOOK_SLUGS.has(catalog.slug)
                  ? "Integração ativa. Use os botões abaixo para atualizar a chave ou desativar."
                  : "Integração ativa. Copie a URL de webhook e siga os passos abaixo no painel do provedor."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col">
          {step === "form" ? (
            wizard ? (
              <IntegrationWizardDialog
                slug={catalog.slug}
                wizard={wizard}
                catalog={fields}
                tenantId={profileTenantId}
                submitting={connect.isPending}
                errorMessage={connect.isError ? (connect.error as Error).message : undefined}
                onSubmit={(vals) => connect.mutate(vals)}
              />
            ) : (
              <form
                className="flex min-h-0 flex-1 flex-col"
                onSubmit={(e) => {
                  e.preventDefault();
                  const trimmed: Record<string, string> = {};
                  for (const [k, val] of Object.entries(values)) trimmed[k] = (val ?? "").trim();
                  connect.mutate(trimmed);
                }}
              >
                <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">
                  {visibleFields.map((f) => (
                    <div key={f.key} className="flex flex-col gap-1.5">
                      <Label htmlFor={`${catalog.slug}-${f.key}`}>{f.label}</Label>
                      {f.type === "select" ? (
                        // Campos de escolha (ex.: região do LlamaCloud) precisam de
                        // <select>: um <input type="select"> vira caixa de texto livre
                        // e o backend rejeita o valor.
                        <select
                          id={`${catalog.slug}-${f.key}`}
                          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                          value={values[f.key] ?? f.default ?? f.options?.[0] ?? ""}
                          onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                        >
                          {(f.options ?? []).map((opt) => (
                            <option key={opt} value={opt}>
                              {SELECT_OPTION_LABELS[opt] ?? opt}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <Input
                          id={`${catalog.slug}-${f.key}`}
                          type={f.type ?? "text"}
                          autoComplete="off"
                          value={values[f.key] ?? ""}
                          onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                          placeholder={
                            isActive && f.type === "password" && !values[f.key]
                              ? "•••• configurado"
                              : undefined
                          }
                        />
                      )}
                      <p className="text-caption text-muted-foreground">{f.help}</p>
                    </div>
                  ))}

                  <div className="flex items-start gap-2 rounded-md border border-border bg-surface p-3 text-caption text-muted-foreground">
                    <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>
                      Suas chaves ficam guardadas com segurança e nunca aparecem no navegador.
                    </span>
                  </div>

                  {connect.isError && (
                    <p className="flex items-start gap-1 text-caption text-destructive">
                      <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                      {(connect.error as Error).message}
                    </p>
                  )}
                </div>

                <DialogFooter className="shrink-0 items-stretch gap-2 border-t border-border px-4 py-3 sm:items-center sm:space-x-0 sm:px-6">
                  {isActive && (
                    <Button
                      type="button"
                      variant="ghost"
                      className="w-full sm:w-auto"
                      onClick={() => setStep("setup")}
                      disabled={connect.isPending}
                    >
                      Cancelar
                    </Button>
                  )}
                  <Button className="w-full sm:w-auto" type="submit" disabled={connect.isPending}>
                    {connect.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Testar e conectar
                  </Button>
                </DialogFooter>
              </form>
            )
          ) : (
            <SetupView
              catalog={catalog}
              tenant={tenant}
              channel={channel}
              revealedSecret={revealedSecret}
              onEdit={() => setStep("form")}
              onDisconnect={() => disconnect.mutate()}
              onForget={() => forget.mutate()}
              isBusy={disconnect.isPending || forget.isPending}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Constrói a URL de webhook por canal.
//
// Confirmado contra `supabase/functions/messaging-webhook/index.ts`
// (autenticação por canal finalizada nesta mesma fase): a function resolve
// tenant/canal por dois formatos, escolhidos só pelo shape do segmento final
// da URL (UUID = canal novo, não-UUID = slug legado) — `/<slug>/<channel_id>
// ?token=<channels.webhook_token>` (novo, usado pelo Evolution e disponível a
// qualquer provider) ou `/<slug>?token=<tenant_integrations.webhook_token>`
// (legado, mantido para não quebrar integrações já configuradas no painel de
// um provider externo). O formato abaixo espelha exatamente isso. É o único
// ponto de construção da URL na UI — ajustar só aqui se a function mudar.
export function buildWebhookUrl(
  supabaseUrl: string,
  slug: string,
  channel: ChannelRow | null,
  legacyToken: string | null,
): string {
  if (channel?.webhook_token) {
    return `${supabaseUrl}/functions/v1/messaging-webhook/${slug}/${channel.id}?token=${channel.webhook_token}`;
  }
  // Fallback: canal ainda sem webhook_token (backfill não rodou pra essa
  // linha) — mantém a URL antiga por tenant+slug funcionando.
  if (legacyToken) {
    return `${supabaseUrl}/functions/v1/messaging-webhook/${slug}?token=${legacyToken}`;
  }
  return `${supabaseUrl}/functions/v1/messaging-webhook/${slug}`;
}

export function SetupView({
  catalog,
  tenant,
  channel = null,
  revealedSecret = null,
  onEdit,
  onDisconnect,
  onForget,
  isBusy,
}: {
  catalog: CatalogRow;
  tenant: TenantIntegrationRow | null;
  channel?: ChannelRow | null;
  revealedSecret?: string | null;
  onEdit: () => void;
  onDisconnect: () => void;
  onForget: () => void;
  isBusy: boolean;
}) {
  const [voiceConfigured, setVoiceConfigured] = useState(false);
  const [copied, setCopied] = useState(false);
  const supabaseUrl =
    (typeof import.meta !== "undefined" &&
      (import.meta as { env?: Record<string, string> }).env?.VITE_SUPABASE_URL) ||
    "";
  const legacyToken = tenant?.webhook_token ?? null;
  const webhookUrl = buildWebhookUrl(supabaseUrl, catalog.slug, channel, legacyToken);
  // Integrações sem callback inbound (ElevenLabs, Apify) — sem webhook pra configurar.
  const hasWebhook = !NO_WEBHOOK_SLUGS.has(catalog.slug);
  // Os `setup_steps` do catálogo descrevem como *obter* as credenciais
  // (criar conta, gerar API key). Fazem sentido antes de conectar, mas viram
  // ruído depois — o operador já cumpriu esses passos. Continuam valendo
  // pós-conexão para provedores com webhook, onde ainda há configuração no
  // painel externo (URL de callback, assinatura de campos, etc.).
  //
  // O `!getWizard` cobre quem não tem wizard passo-a-passo: sem wizard na
  // entrada e sem webhook na saída, esconder os passos aqui deixava a tela de
  // gerenciamento literalmente vazia — era o caso do LlamaCloud, única
  // integração visível nessa combinação. Quem tem wizard (ElevenLabs, Apify)
  // já foi guiado na conexão e segue sem repetição.
  const steps =
    hasWebhook || !getWizard(catalog.slug) ? normalizeSetupSteps(catalog.setup_steps) : [];

  // Os dois mecanismos de auth coexistem até o operador atualizar a URL no
  // painel externo (Meta/Evolution/Z-API) — isso é ação manual, a migração de
  // banco não troca sozinha o que está cadastrado lá fora (PRD Fase 5).
  const showMigrationBanner = Boolean(legacyToken) && Boolean(channel?.webhook_token);

  // `channel.qr_code` vem da RPC admin-only get_channel_qr_codes(), já
  // filtrada por tenant e TTL. O provider não garante prefixo de data URL;
  // normalizamos defensivamente antes de usar em <img src>.
  const rawQrCode =
    catalog.slug === "evolution" && channel?.status === "waiting_qr" ? channel.qr_code : null;
  const qrCode =
    rawQrCode && !rawQrCode.startsWith("data:") ? `data:image/png;base64,${rawQrCode}` : rawQrCode;

  return (
    <div className="grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(0,1fr)_auto]">
      <div
        className="min-h-0 space-y-4 overflow-y-auto overscroll-contain px-4 py-4 [scrollbar-color:var(--border-strong)_transparent] [scrollbar-width:thin] sm:px-6"
        data-testid="integration-setup-scroll"
      >
        {showMigrationBanner && (
          <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-caption text-foreground">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
            <span>
              A URL de webhook mudou. Atualize-a no painel do provedor ({catalog.name}) — a URL
              antiga continua funcionando até você trocar manualmente lá fora.
            </span>
          </div>
        )}

        {qrCode && (
          <div className="flex flex-col items-center gap-2 rounded-md border border-border bg-surface p-4">
            <p className="flex items-center gap-1 text-caption font-medium text-foreground">
              <QrCode className="h-3.5 w-3.5" />
              Escaneie o QR code no WhatsApp para reconectar
            </p>
            <img
              src={qrCode}
              alt="QR code de reconexão do WhatsApp (Evolution)"
              className="h-48 w-48"
            />
          </div>
        )}

        {hasWebhook && (
          <div className="flex flex-col gap-2">
            <Label>URL do webhook</Label>
            <div className="flex min-w-0 flex-col gap-2 rounded-md border border-border bg-surface p-3">
              <code
                className="block w-full min-w-0 break-all font-mono text-caption leading-relaxed text-muted-foreground"
                title={webhookUrl}
              >
                {webhookUrl}
              </code>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="w-full sm:w-auto sm:self-start"
                aria-label={copied ? "URL copiada" : "Copiar URL do webhook"}
                onClick={() => {
                  navigator.clipboard.writeText(webhookUrl);
                  setCopied(true);
                  toast.success("URL copiada.");
                  setTimeout(() => setCopied(false), 2000);
                }}
              >
                {copied ? (
                  <Check className="mr-2 h-4 w-4 text-success" />
                ) : (
                  <Copy className="mr-2 h-4 w-4" />
                )}
                {copied ? "Copiada" : "Copiar URL"}
              </Button>
            </div>
          </div>
        )}

        {isManyChatSlug(catalog.slug) && (
          <ManyChatSetupPanel slug={catalog.slug} revealedSecret={revealedSecret} />
        )}

        {catalog.slug === "elevenlabs" && (
          <ElevenLabsVoiceSettings onVoiceConfigured={setVoiceConfigured} />
        )}

        {hasWebhook && <ConnectionDiagnostics slug={catalog.slug} channel={channel} />}

        {(() => {
          const checklist = getChecklist(catalog.slug, { channel, tenant, voiceConfigured });
          return checklist ? <IntegrationChecklist def={checklist} /> : null;
        })()}

        {steps.length > 0 && (
          <section className="rounded-md border border-border bg-surface p-3">
            <h3 className="mb-3 text-card-title font-semibold text-foreground">
              Etapas de configuração
            </h3>
            <ol className="flex flex-col gap-3 text-body" data-testid="setup-steps">
              {steps.map((s, i) => (
                <li key={`${s.title}-${i}`} className="flex gap-3">
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-caption font-semibold text-accent-foreground">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-foreground">{s.title}</p>
                    {s.body && (
                      <p className="text-caption leading-relaxed text-muted-foreground">{s.body}</p>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>

      <DialogFooter className="shrink-0 items-stretch gap-2 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:space-x-0 sm:px-6">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className="w-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:w-auto"
              disabled={isBusy}
            >
              <Trash2 className="mr-1 h-4 w-4" />
              Esquecer credenciais
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Esquecer credenciais de {catalog.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                Isso apaga permanentemente as chaves salvas. Você precisará colá-las de novo para
                reconectar. Esta ação não pode ser desfeita.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancelar</AlertDialogCancel>
              <AlertDialogAction
                onClick={onForget}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Esquecer credenciais
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <Button type="button" variant="outline" onClick={onDisconnect} disabled={isBusy}>
            Desativar
          </Button>
          <Button type="button" onClick={onEdit} disabled={isBusy}>
            <span className="truncate">Atualizar credenciais</span>
          </Button>
        </div>
      </DialogFooter>
    </div>
  );
}

// Renderiza um checklist pós-conexão genérico. A lógica de quais itens
// aparecem por integração vive em `./checklists.ts` — este componente só
// pinta estado + link. Objetivo: eliminar a fricção de "canal ativo mas
// nada funciona" para operadores leigos, mostrando o que ainda falta
// verificar no painel do provedor com link direto para o passo certo.
export function IntegrationChecklist({ def }: { def: ChecklistDef }) {
  const okCount = def.items.filter((i) => i.state === "ok").length;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-caption font-semibold text-foreground">{def.title}</p>
        <span className="text-caption text-muted-foreground">
          {okCount} de {def.items.length} confirmados
        </span>
      </div>
      <ul className="flex flex-col gap-2" data-testid="integration-checklist">
        {def.items.map((item) => {
          const Icon =
            item.state === "ok" ? CircleCheck : item.state === "warn" ? CircleAlert : CircleDashed;
          const tone =
            item.state === "ok"
              ? "text-success"
              : item.state === "warn"
                ? "text-warning"
                : "text-muted-foreground";
          const linkProps = item.internal ? {} : { target: "_blank", rel: "noopener noreferrer" };
          return (
            <li key={item.key} className="flex gap-2" data-testid={`check-${item.key}`}>
              <Icon
                className={`mt-0.5 h-4 w-4 shrink-0 ${tone}`}
                aria-hidden
                data-state={item.state}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">{item.label}</p>
                <p className="text-caption leading-relaxed text-muted-foreground">{item.hint}</p>
                <a
                  href={item.href}
                  {...linkProps}
                  className="mt-1 inline-flex items-center gap-1 text-caption text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                >
                  {item.linkLabel}
                  {!item.internal && <ExternalLink className="h-3 w-3" aria-hidden />}
                </a>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
