// Uma linha da lista de canais em AgentChannelsTab — nome, status
// (`connected`, o único sinal do contrato), tipo e as ações disponíveis.
import { Link2, Link2Off, Pencil, QrCode as QrCodeIcon, Settings2, Trash2 } from "lucide-react";

import { StatusBadge } from "@/components/common/StatusBadge";
import { Button } from "@/components/ui/button";
import type { ChannelType } from "@/integrations/agent-platform/enums.gen";

import { CHANNEL_TYPE_LABELS, type NormalizedChannel } from "./channel-labels";

// Só estes dois tipos conectam por QR Code (padrão WhatsApp Web). Os outros
// sete dependem do painel do provedor de agentes (OAuth ou número oficial) — o
// contrato não descreve um fluxo de conexão alternativo pra eles.
const QR_ELIGIBLE_TYPES = new Set<ChannelType>(["Z_API", "WHATSAPP"]);

function linkActionLabel(channel: NormalizedChannel, currentAgentId: string): string {
  if (channel.agentId === currentAgentId) return "Desvincular deste agente";
  if (channel.agentId) return "Trazer para este agente";
  return "Vincular a este agente";
}

interface ChannelRowProps {
  channel: NormalizedChannel;
  agentId: string;
  onRename: () => void;
  onToggleLink: () => void;
  onConfigure: () => void;
  onQrCode: () => void;
  onDelete: () => void;
  linkPending: boolean;
}

export function ChannelRow({
  channel,
  agentId,
  onRename,
  onToggleLink,
  onConfigure,
  onQrCode,
  onDelete,
  linkPending,
}: ChannelRowProps) {
  const linkedHere = channel.agentId === agentId;
  const qrEligible = QR_ELIGIBLE_TYPES.has(channel.type);

  return (
    <li className="rounded-lg border border-border p-4" data-testid={`channel-row-${channel.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium text-foreground">{channel.name}</p>
            <StatusBadge variant={channel.connected ? "success" : "neutral"}>
              {channel.connected ? "Conectado" : "Desconectado"}
            </StatusBadge>
          </div>
          <p className="text-caption text-muted-foreground">
            {CHANNEL_TYPE_LABELS[channel.type]} ·{" "}
            {linkedHere
              ? "vinculado a este agente"
              : channel.agentId
                ? `vinculado a ${channel.agentName ?? "outro agente"}`
                : "sem agente vinculado"}
          </p>
          {!qrEligible && channel.type !== "WIDGET" && (
            <p className="mt-1 text-caption text-muted-foreground">
              O contrato público não descreve o fluxo de conexão deste canal — conclua no painel do
              provedor de agentes.
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={onRename}>
            <Pencil className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            Renomear
          </Button>
          <Button variant="outline" size="sm" onClick={onToggleLink} disabled={linkPending}>
            {linkedHere ? (
              <Link2Off className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            ) : (
              <Link2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            )}
            {linkActionLabel(channel, agentId)}
          </Button>
          <Button variant="outline" size="sm" onClick={onConfigure}>
            <Settings2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {channel.type === "WIDGET" ? "Widget" : "Configurar"}
          </Button>
          {qrEligible && (
            <Button variant="outline" size="sm" onClick={onQrCode}>
              <QrCodeIcon className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              QR Code
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            Excluir
          </Button>
        </div>
      </div>
    </li>
  );
}
