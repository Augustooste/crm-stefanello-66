// Aba "Canais" do agente provedor de agentes.
//
// Fluxo por WORKSPACE (channels.list/channels.create/channel.update/...) —
// nunca os endpoints legados por agente (`POST /agent/{agentId}/create-channel`,
// `GET /agent/{agentId}/search`), que o contrato mantém só por compatibilidade
// e cobrem 7 dos 9 tipos (ver contracts/agent-platform/CONTRACT_MATRIX.md §1.7).
//
// `connected` é o ÚNICO indicador de conexão que o contrato devolve — nenhum
// estado intermediário é inventado aqui.
//
// Vincular/desvincular/"trocar de agente" são a MESMA operação (`channel.update`
// com `agentId`): esta tela só conhece o agente atual (`agentId` da prop), não
// existe endpoint pra listar todos os agentes aqui dentro, então não há um
// seletor livre de "para qual outro agente". Trazer um canal de outro agente
// para o atual (o "trocar") é feito a partir da visão "Todos do workspace".
import { useEffect, useState } from "react";
import { Plus, Search } from "lucide-react";

import { EmptyState } from "@/components/common/EmptyState";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAgentPlatformMutation, useAgentPlatformQuery } from "@/lib/api/agent-platform";
import { toast } from "sonner";

import { ChannelConfigForm } from "./ChannelConfigForm";
import { ChannelDeleteDialog } from "./ChannelDeleteDialog";
import { ChannelFormDialog } from "./ChannelFormDialog";
import { ChannelQrCodeDialog } from "./ChannelQrCodeDialog";
import { ChannelRow } from "./ChannelRow";
import { ChannelWidgetSettings } from "./ChannelWidgetSettings";
import { normalizeChannel, type NormalizedChannel } from "./channel-labels";

const PAGE_SIZE = 25; // default do contrato (`GET .../channels`)
const SEARCH_DEBOUNCE_MS = 300;

type FormDialogState = { mode: "create" } | { mode: "rename"; channel: NormalizedChannel };

export function AgentChannelsTab({ agentId }: { agentId: string }) {
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [formDialog, setFormDialog] = useState<FormDialogState | null>(null);
  const [deleting, setDeleting] = useState<NormalizedChannel | null>(null);
  const [qrTarget, setQrTarget] = useState<NormalizedChannel | null>(null);
  const [configTarget, setConfigTarget] = useState<NormalizedChannel | null>(null);
  const [widgetTarget, setWidgetTarget] = useState<NormalizedChannel | null>(null);

  // Trocar de escopo reinicia a paginação — página 2 do workspace inteiro não
  // faz sentido depois de filtrar só pra este agente (ou vice-versa).
  useEffect(() => setPage(1), [scope]);

  useEffect(() => {
    // Só agenda o debounce quando a busca realmente mudou. Sem esta guarda, o
    // timer agendado no mount (busca vazia) continua pendente — `searchInput`
    // não muda enquanto o usuário só pagina, então o efeito não re-roda e o
    // cleanup não dispara — e 300 ms depois chama `setPage(1)`, jogando de
    // volta pra página 1 quem clicou em "Próxima" nesse intervalo. Mesma
    // causa do flake corrigido em #246 (src/routes/_app.agentes.index.tsx).
    const next = searchInput.trim();
    if (next === query) return;

    const timer = setTimeout(() => {
      setQuery(next);
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput, query]);

  const listQuery = useAgentPlatformQuery("channels.list", {
    params: {
      page,
      pageSize: PAGE_SIZE,
      ...(query ? { query } : {}),
      ...(scope === "mine" ? { agentId } : {}),
    },
  });

  const linkMut = useAgentPlatformMutation("channel.update", {
    invalidate: ["channels.list"],
    onSuccess: (_data, variables) => {
      toast.success(
        variables.body?.agentId
          ? "Canal vinculado a este agente."
          : "Canal desvinculado deste agente.",
      );
    },
    onError: (error) => toast.error(error.message),
  });

  function toggleLink(channel: NormalizedChannel) {
    const nextAgentId = channel.agentId === agentId ? null : agentId;
    linkMut.mutate({
      params: { channelId: channel.id },
      body: { name: channel.name, agentId: nextAgentId },
    });
  }

  const items = (listQuery.data?.data ?? [])
    .map(normalizeChannel)
    .filter((c): c is NormalizedChannel => c !== null);
  const count = listQuery.data?.count ?? 0;
  const hasNextPage = page * PAGE_SIZE < count;

  return (
    <Card>
      <CardHeader className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="text-card-title">Canais</CardTitle>
            <CardDescription>
              Conecte e gerencie os canais de mensagem deste agente (WhatsApp, Instagram, widget do
              site e outros).
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setFormDialog({ mode: "create" })}>
            <Plus className="mr-1.5 h-4 w-4" aria-hidden />
            Novo canal
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1 rounded-md border border-border p-1">
            <Button
              type="button"
              size="sm"
              variant={scope === "mine" ? "default" : "ghost"}
              onClick={() => setScope("mine")}
            >
              Só deste agente
            </Button>
            <Button
              type="button"
              size="sm"
              variant={scope === "all" ? "default" : "ghost"}
              onClick={() => setScope("all")}
            >
              Todos do workspace
            </Button>
          </div>
          <div className="relative min-w-[200px] flex-1">
            <Search
              className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Buscar canal..."
              aria-label="Buscar canal"
              className="pl-8"
            />
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {listQuery.isPending ? (
          <div className="space-y-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : listQuery.isError ? (
          <EmptyState
            title="Não foi possível carregar os canais"
            description={listQuery.error?.message ?? "Erro ao carregar os canais."}
            actionLabel="Tentar de novo"
            onAction={() => listQuery.refetch()}
          />
        ) : items.length === 0 ? (
          <EmptyState
            title="Nenhum canal encontrado"
            description={
              scope === "mine"
                ? 'Este agente ainda não tem canal vinculado. Crie um novo ou traga um já existente pela aba "Todos do workspace".'
                : "Nenhum canal neste workspace ainda. Crie o primeiro acima."
            }
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {items.map((channel) => (
              <ChannelRow
                key={channel.id}
                channel={channel}
                agentId={agentId}
                onRename={() => setFormDialog({ mode: "rename", channel })}
                onToggleLink={() => toggleLink(channel)}
                onConfigure={() =>
                  channel.type === "WIDGET" ? setWidgetTarget(channel) : setConfigTarget(channel)
                }
                onQrCode={() => setQrTarget(channel)}
                onDelete={() => setDeleting(channel)}
                linkPending={linkMut.isPending}
              />
            ))}
          </ul>
        )}

        {items.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-caption text-muted-foreground">
              Página {page} de {Math.max(1, Math.ceil(count / PAGE_SIZE))} · {count} canal
              {count === 1 ? "" : "is"}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                Anterior
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!hasNextPage}
                onClick={() => setPage((current) => current + 1)}
              >
                Próxima
              </Button>
            </div>
          </div>
        )}
      </CardContent>

      {formDialog && (
        <ChannelFormDialog
          mode={formDialog.mode}
          agentId={agentId}
          channel={formDialog.mode === "rename" ? formDialog.channel : undefined}
          open
          onOpenChange={(next) => !next && setFormDialog(null)}
        />
      )}

      {deleting && (
        <ChannelDeleteDialog
          channel={deleting}
          open
          onOpenChange={(next) => !next && setDeleting(null)}
        />
      )}

      {qrTarget && (
        <ChannelQrCodeDialog
          channelId={qrTarget.id}
          channelName={qrTarget.name}
          open
          onOpenChange={(next) => !next && setQrTarget(null)}
          onConnected={() => listQuery.refetch()}
        />
      )}

      {configTarget && (
        <ChannelConfigForm
          channel={configTarget}
          open
          onOpenChange={(next) => !next && setConfigTarget(null)}
        />
      )}

      {widgetTarget && (
        <ChannelWidgetSettings
          channel={widgetTarget}
          open
          onOpenChange={(next) => !next && setWidgetTarget(null)}
        />
      )}
    </Card>
  );
}
