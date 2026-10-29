// Configurações do canal Widget — `PUT /v2/channel/{channelId}/widget-settings`
// (escreve, sem GET equivalente no contrato — mesma situação do `signMessages`
// em agent.settings, D3 em contracts/agent-platform/CONTRACT_MATRIX.md: o
// formulário não tem como vir pré-carregado do provedor de agentes). Por isso o rascunho
// começa vazio e só entra no corpo o que o usuário efetivamente tocou —
// nenhum valor "vazio por padrão" pisa em cima de uma configuração já salva
// lá no provedor.
//
// `widget-links` (`GET /v2/channel/{channelId}/widget-links`) devolve os dois
// scripts de incorporação (`float`, `iframe`) — nenhum dos dois carrega token
// no embed, então copiar e colar no site é seguro.
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useAgentPlatformMutation, useAgentPlatformQuery } from "@/lib/api/agent-platform";
import type { AgentPlatformWidgetSettings } from "@/lib/api/agent-platform-contract";

import type { NormalizedChannel } from "./channel-labels";

type FieldKey = keyof AgentPlatformWidgetSettings;

interface ChannelWidgetSettingsProps {
  channel: NormalizedChannel;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ChannelWidgetSettings({ channel, open, onOpenChange }: ChannelWidgetSettingsProps) {
  const [form, setForm] = useState<AgentPlatformWidgetSettings>({});
  const [touched, setTouched] = useState<Set<FieldKey>>(new Set());

  function setField<K extends FieldKey>(key: K, value: AgentPlatformWidgetSettings[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setTouched((t) => new Set(t).add(key));
  }

  const updateMut = useAgentPlatformMutation("channel.widgetSettings.update", {
    invalidate: ["channels.list"],
    onSuccess: () => {
      toast.success("Configuração do widget salva.");
      setTouched(new Set());
    },
    onError: (error) => toast.error(error.message),
  });

  const linksQuery = useAgentPlatformQuery(
    "channel.widgetLinks",
    { params: { channelId: channel.id } },
    { enabled: open },
  );

  function handleSave() {
    if (touched.size === 0) {
      toast.info("Nada para salvar — altere algum campo primeiro.");
      return;
    }
    const body: AgentPlatformWidgetSettings = {};
    for (const key of touched) {
      (body as Record<string, unknown>)[key] = form[key];
    }
    updateMut.mutate({ params: { channelId: channel.id }, body });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Widget — {channel.name}</DialogTitle>
          <DialogDescription>
            Só o que você alterar aqui é enviado — o provedor de agentes não devolve as
            configurações atuais do widget para pré-carregar o formulário.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <label className="flex items-center gap-2 text-body text-foreground">
            <Switch
              checked={form.isPublic ?? false}
              onCheckedChange={(v) => setField("isPublic", v)}
            />
            Widget público (sem restrição de domínio)
          </label>

          <div className="space-y-1.5">
            <Label htmlFor="widget-initial-message">Mensagem inicial</Label>
            <Textarea
              id="widget-initial-message"
              rows={2}
              value={form.initialMessage ?? ""}
              onChange={(e) => setField("initialMessage", e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="widget-origins">Domínios autorizados (um por linha)</Label>
            <Textarea
              id="widget-origins"
              rows={2}
              value={(form.origins ?? []).join("\n")}
              onChange={(e) => setField("origins", splitLines(e.target.value))}
              placeholder={"https://minhaempresa.com.br"}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="widget-suggestions">Sugestões de pergunta (uma por linha)</Label>
            <Textarea
              id="widget-suggestions"
              rows={2}
              value={(form.suggestMessages ?? []).join("\n")}
              onChange={(e) => setField("suggestMessages", splitLines(e.target.value))}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <ColorField
              id="widget-header-bg"
              label="Fundo do topo"
              value={form.headerBackground}
              onChange={(v) => setField("headerBackground", v)}
            />
            <ColorField
              id="widget-header-color"
              label="Cor da fonte do topo"
              value={form.headerColor}
              onChange={(v) => setField("headerColor", v)}
            />
            <ColorField
              id="widget-user-msg-bg"
              label="Fundo da msg. do usuário"
              value={form.messageUserBackground}
              onChange={(v) => setField("messageUserBackground", v)}
            />
            <ColorField
              id="widget-button-bg"
              label="Fundo do botão flutuante"
              value={form.buttonBackground}
              onChange={(v) => setField("buttonBackground", v)}
            />
          </div>

          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <p className="text-caption font-medium text-foreground">Código de incorporação</p>
            {linksQuery.isLoading ? (
              <Skeleton className="h-16 w-full" />
            ) : linksQuery.isError ? (
              <p className="text-caption text-destructive">{linksQuery.error?.message}</p>
            ) : (
              <>
                <EmbedRow label="Botão flutuante" value={linksQuery.data?.float} />
                <EmbedRow label="Iframe" value={linksQuery.data?.iframe} />
              </>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Fechar
          </Button>
          <Button onClick={handleSave} disabled={updateMut.isPending}>
            {updateMut.isPending ? "Salvando…" : "Salvar alterações"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function ColorField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string | undefined;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Ex.: #111827"
      />
    </div>
  );
}

function EmbedRow({ label, value }: { label: string; value: string | undefined }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopied(true);
    toast.success("Código copiado.");
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <code
          className="flex-1 min-w-0 truncate rounded-md border border-border bg-surface px-3 py-2 font-mono text-caption text-muted-foreground"
          title={value}
        >
          {value ?? "—"}
        </code>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleCopy}
          disabled={!value}
          aria-label={`Copiar código de incorporação (${label})`}
        >
          {copied ? (
            <Check className="mr-1.5 h-3.5 w-3.5 text-success" aria-hidden />
          ) : (
            <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          )}
          Copiar
        </Button>
      </div>
    </div>
  );
}
