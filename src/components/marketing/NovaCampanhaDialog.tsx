import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile } from "@/lib/api/session";
import { formatDateTime } from "@/lib/format";
import { useMessagingTemplates } from "@/hooks/use-messaging-templates";
import {
  hasAudienceCriteria,
  useCreateTemplateSchedule,
  useEstimateAudience,
  type AudienceFilter,
} from "@/hooks/use-template-schedules";

// Espelha template-schedule-runner/runner.ts::CAMPAIGN_PROVIDER_SLUGS. Ficam de
// fora telegram/discord/sms/email/push: sem credencial, o adaptador deles
// devolve sucesso simulado, e a campanha contaria envio que não aconteceu.
const CAMPAIGN_PROVIDER_LABELS: Record<string, string> = {
  "meta-cloud": "WhatsApp oficial (Meta)",
  twilio: "WhatsApp oficial (Twilio)",
  zapi: "WhatsApp (Z-API)",
  evolution: "WhatsApp (Evolution)",
  zappaz: "WhatsApp (Zappaz)",
  resend: "E-mail (Resend)",
};

// Canais com janela de 24h: texto livre só chega a quem falou com a empresa
// nas últimas 24h (runner.ts::OFFICIAL_PROVIDER_SLUGS).
const OFFICIAL_PROVIDERS = new Set(["meta-cloud", "twilio"]);

const STEPS = ["Campanha", "Público", "Mensagem", "Agendamento", "Confirmar"] as const;
const NONE = "none";

interface ChannelOption {
  id: string;
  provider_slug: string;
  type: string;
}

export interface NovaCampanhaDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTemplateId?: string | null;
}

export function NovaCampanhaDialog({
  open,
  onOpenChange,
  initialTemplateId,
}: NovaCampanhaDialogProps) {
  const { data: profile } = useCurrentProfile();
  const createMut = useCreateTemplateSchedule();
  const templatesQ = useMessagingTemplates();

  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [channelId, setChannelId] = useState(NONE);
  const [tags, setTags] = useState<string[]>([]);
  const [stageId, setStageId] = useState(NONE);
  const [fieldKey, setFieldKey] = useState(NONE);
  const [fieldValue, setFieldValue] = useState("");
  const [templateId, setTemplateId] = useState(NONE);
  const [sendNow, setSendNow] = useState(false);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("10:00");
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setName("");
    setChannelId(NONE);
    setTags([]);
    setStageId(NONE);
    setFieldKey(NONE);
    setFieldValue("");
    setTemplateId(initialTemplateId ?? NONE);
    setSendNow(false);
    setDate(format(new Date(), "yyyy-MM-dd"));
    setTime("10:00");
    setConfirmed(false);
  }, [open, initialTemplateId]);

  const channelsQ = useQuery({
    queryKey: ["campaign-channels", profile?.tenant_id],
    enabled: open && !!profile?.tenant_id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("channels")
        .select("id, provider_slug, type")
        .eq("status", "connected");
      if (error) throw error;
      return ((data ?? []) as ChannelOption[]).filter(
        (c) => c.provider_slug in CAMPAIGN_PROVIDER_LABELS,
      );
    },
  });

  const tagsQ = useQuery({
    queryKey: ["tags", profile?.tenant_id],
    enabled: open && !!profile?.tenant_id,
    queryFn: async () => {
      const { data, error } = await supabase.from("tags").select("id, name").order("name");
      if (error) throw error;
      return (data ?? []) as { id: string; name: string }[];
    },
  });

  const stagesQ = useQuery({
    queryKey: ["campaign-stages", profile?.tenant_id],
    enabled: open && !!profile?.tenant_id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("board_stages")
        .select("id, name, board:boards!inner(name, is_default)")
        .order("position");
      if (error) throw error;
      return (data ?? []) as unknown as {
        id: string;
        name: string;
        board: { name: string; is_default: boolean };
      }[];
    },
  });

  const fieldsQ = useQuery({
    queryKey: ["campaign-custom-fields", profile?.tenant_id],
    enabled: open && !!profile?.tenant_id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("custom_field_definitions")
        .select("key, label")
        .eq("entity", "contact")
        .order("position");
      if (error) throw error;
      return (data ?? []) as { key: string; label: string }[];
    },
  });

  const approved = useMemo(
    () => (templatesQ.data ?? []).filter((t) => !t.is_draft && t.status === "approved"),
    [templatesQ.data],
  );
  const template = approved.find((t) => t.id === templateId) ?? null;
  const channel = (channelsQ.data ?? []).find((c) => c.id === channelId) ?? null;
  const stageName = (stagesQ.data ?? []).find((s) => s.id === stageId)?.name;

  const audience = useMemo<AudienceFilter>(() => {
    const f: AudienceFilter = {};
    if (tags.length > 0) f.tags = tags;
    if (stageId !== NONE) f.stage_id = stageId;
    if (fieldKey !== NONE && fieldValue.trim()) f.custom_field = { [fieldKey]: fieldValue.trim() };
    return f;
  }, [tags, stageId, fieldKey, fieldValue]);

  const estimateQ = useEstimateAudience(audience, open);
  const estimate = hasAudienceCriteria(audience) ? (estimateQ.data ?? null) : 0;

  const scheduledAt = useMemo(() => {
    if (sendNow) return new Date();
    const [yy, mm, dd] = date.split("-").map(Number);
    const [h, m] = time.split(":").map(Number);
    if (!yy || !mm || !dd || Number.isNaN(h) || Number.isNaN(m)) return null;
    return new Date(yy, mm - 1, dd, h, m, 0, 0);
  }, [sendNow, date, time]);

  const isOfficial = !!channel && OFFICIAL_PROVIDERS.has(channel.provider_slug);
  // Modelo aprovado só sai pela Meta Cloud (provider-send.ts::
  // PROVIDER_TEMPLATE_PROVIDERS); nos outros canais o backend recusa.
  const providerTemplateBlocked =
    !!channel && template?.kind === "provider_approved" && channel.provider_slug !== "meta-cloud";

  const stepError = (() => {
    if (step === 0) {
      if (!name.trim()) return "Dê um nome à campanha.";
      if (!channel) return "Escolha um canal conectado.";
    }
    if (step === 1) {
      if (!hasAudienceCriteria(audience)) return "Escolha ao menos um critério de público.";
      if (estimateQ.isFetching) return "Calculando o público…";
      if (estimateQ.isError) return "Não foi possível estimar o público.";
      if (estimate === 0) return "Nenhum contato corresponde a esse público.";
    }
    if (step === 2) {
      if (!template) return "Escolha um modelo aprovado.";
      if (providerTemplateBlocked)
        return "Modelo aprovado pelo provedor só é enviado pelo WhatsApp oficial (Meta). Troque o canal ou o modelo.";
    }
    if (step === 3) {
      if (!scheduledAt) return "Informe data e hora.";
      if (!sendNow && scheduledAt.getTime() <= Date.now())
        return "A data/hora precisa ser no futuro.";
    }
    if (step === 4 && !confirmed) return "Confirme o envio para continuar.";
    return null;
  })();

  const submit = () => {
    if (!profile || !template || !channel || !scheduledAt) return;
    createMut.mutate(
      {
        tenantId: profile.tenant_id,
        templateId: template.id,
        channelId: channel.id,
        name: name.trim(),
        scheduledFor: scheduledAt.toISOString(),
        audience,
      },
      {
        onSuccess: () => {
          toast.success(sendNow ? "Campanha na fila de envio" : "Campanha agendada");
          onOpenChange(false);
        },
        onError: (e: Error) => toast.error(e.message || "Erro ao criar campanha"),
      },
    );
  };

  const toggleTag = (tag: string, checked: boolean) =>
    setTags((prev) => (checked ? [...prev, tag] : prev.filter((t) => t !== tag)));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Nova campanha</DialogTitle>
          <DialogDescription>
            Passo {step + 1} de {STEPS.length}: {STEPS[step]}
          </DialogDescription>
        </DialogHeader>

        {step === 0 && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="campaign-name">Nome da campanha *</Label>
              <Input
                id="campaign-name"
                placeholder="ex.: Reativação de clientes inativos"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="campaign-channel">Canal *</Label>
              <Select value={channelId} onValueChange={setChannelId}>
                <SelectTrigger id="campaign-channel">
                  <SelectValue placeholder="Escolher canal" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Escolher canal</SelectItem>
                  {(channelsQ.data ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {CAMPAIGN_PROVIDER_LABELS[c.provider_slug]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {channelsQ.isSuccess && channelsQ.data.length === 0 && (
                <p className="text-caption text-muted-foreground">
                  Nenhum canal conectado. Conecte um canal em Configurações → Integrações.
                </p>
              )}
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Etiquetas</Label>
              <div className="max-h-36 space-y-1 overflow-y-auto rounded-md border p-2">
                {(tagsQ.data ?? []).length === 0 && (
                  <p className="p-1 text-caption text-muted-foreground">
                    Nenhuma etiqueta cadastrada
                  </p>
                )}
                {(tagsQ.data ?? []).map((t) => (
                  <label
                    key={t.id}
                    className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 hover:bg-muted"
                  >
                    <Checkbox
                      checked={tags.includes(t.name)}
                      onCheckedChange={(v) => toggleTag(t.name, v === true)}
                    />
                    <span className="text-body">{t.name}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="campaign-stage">Estágio do funil</Label>
              <Select value={stageId} onValueChange={setStageId}>
                <SelectTrigger id="campaign-stage">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Não filtrar por estágio</SelectItem>
                  {(stagesQ.data ?? []).map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.board.is_default ? s.name : `${s.board.name} · ${s.name}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {(fieldsQ.data ?? []).length > 0 && (
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="campaign-field">Campo personalizado</Label>
                  <Select value={fieldKey} onValueChange={setFieldKey}>
                    <SelectTrigger id="campaign-field">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Não filtrar</SelectItem>
                      {(fieldsQ.data ?? []).map((f) => (
                        <SelectItem key={f.key} value={f.key}>
                          {f.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="campaign-field-value">Valor igual a</Label>
                  <Input
                    id="campaign-field-value"
                    disabled={fieldKey === NONE}
                    value={fieldValue}
                    onChange={(e) => setFieldValue(e.target.value)}
                  />
                </div>
              </div>
            )}
            <p className="rounded-md border bg-muted/40 p-3 text-body" aria-live="polite">
              {!hasAudienceCriteria(audience)
                ? "Escolha ao menos um critério. Sem critério ninguém recebe."
                : estimateQ.isFetching
                  ? "Calculando público…"
                  : `Público estimado: ${estimate ?? 0} contato(s). Os critérios se somam (E).`}
            </p>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="campaign-template">Modelo aprovado *</Label>
              <Select value={templateId} onValueChange={setTemplateId}>
                <SelectTrigger id="campaign-template">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Escolher modelo</SelectItem>
                  {approved.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name} (v{t.version})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {template && (
              <p className="rounded-md border p-3 text-body text-muted-foreground">
                {template.body}
              </p>
            )}
            {isOfficial && template?.kind === "freeform" && (
              <p className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-caption">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                No WhatsApp oficial, modelo de corpo livre só chega a quem falou com você nas
                últimas 24h. Para reativar contatos parados, use um modelo aprovado pela Meta.
              </p>
            )}
            {template?.kind === "provider_approved" && channel?.provider_slug === "meta-cloud" && (
              <p className="text-caption text-muted-foreground">
                Envia o modelo aprovado na Meta ({template.provider_template_name}, idioma{" "}
                {template.language}).
                {template.variables.length > 0 &&
                  ` Variáveis preenchidas com o dado de cada contato, nesta ordem: ${template.variables
                    .map((v, idx) => `{{${idx + 1}}} = ${v}`)
                    .join(", ")}. Contato sem o dado não recebe.`}
              </p>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <label className="flex items-center gap-2">
              <Checkbox checked={sendNow} onCheckedChange={(v) => setSendNow(v === true)} />
              <span className="text-body">Enviar agora (sai em até 5 minutos)</span>
            </label>
            {!sendNow && (
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="campaign-date">Data *</Label>
                  <Input
                    id="campaign-date"
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="campaign-time">Hora *</Label>
                  <Input
                    id="campaign-time"
                    type="time"
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {step === 4 && (
          <div className="space-y-3">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border p-3 text-body">
              <dt className="text-muted-foreground">Campanha</dt>
              <dd>{name}</dd>
              <dt className="text-muted-foreground">Canal</dt>
              <dd>{channel ? CAMPAIGN_PROVIDER_LABELS[channel.provider_slug] : "—"}</dd>
              <dt className="text-muted-foreground">Modelo</dt>
              <dd>{template?.name ?? "—"}</dd>
              <dt className="text-muted-foreground">Público</dt>
              <dd>
                {estimate ?? 0} contato(s)
                {stageName ? ` · estágio ${stageName}` : ""}
                {tags.length ? ` · etiquetas ${tags.join(", ")}` : ""}
              </dd>
              <dt className="text-muted-foreground">Quando</dt>
              <dd>
                {sendNow
                  ? "Agora (em até 5 minutos)"
                  : scheduledAt
                    ? formatDateTime(scheduledAt.toISOString())
                    : "—"}
              </dd>
            </dl>
            <p className="text-caption text-muted-foreground">
              Contatos com opt-out são pulados, e cada contato recebe no máximo 1 mensagem
              automática por dia.
            </p>
            <label className="flex items-start gap-2">
              <Checkbox checked={confirmed} onCheckedChange={(v) => setConfirmed(v === true)} />
              <span className="text-body">
                Confirmo o envio desta campanha para {estimate ?? 0} contato(s).
              </span>
            </label>
          </div>
        )}

        {stepError && step !== 4 && step !== 1 && (
          <p className="text-caption text-muted-foreground">{stepError}</p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => (step === 0 ? onOpenChange(false) : setStep(step - 1))}
          >
            {step === 0 ? "Cancelar" : "Voltar"}
          </Button>
          {step < STEPS.length - 1 ? (
            <Button type="button" disabled={!!stepError} onClick={() => setStep(step + 1)}>
              Avançar
            </Button>
          ) : (
            <Button type="button" disabled={!!stepError || createMut.isPending} onClick={submit}>
              {createMut.isPending
                ? "Salvando…"
                : sendNow
                  ? "Confirmar e enviar"
                  : "Confirmar agendamento"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
