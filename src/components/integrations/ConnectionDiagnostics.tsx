// Painel de diagnóstico da conexão (usado no modal de gerenciamento da
// integração): botões "Reconectar" e "Testar integração", com progresso ao
// vivo por passo e histórico dos motivos do último estado.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Loader2,
  RefreshCw,
  Send,
  CircleCheck,
  CircleAlert,
  CircleDashed,
  MinusCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import type { ChannelRow } from "@/lib/api/integrations";
import {
  useChannelStatusEvents,
  eventsForRun,
  type ChannelStatusEventRow,
} from "@/lib/api/channel-status";
import { relativeFromNow } from "@/lib/format";

type StepResult = {
  step: string;
  state: "ok" | "failed" | "skipped";
  label: string;
  detail?: string | null;
};

type ActionResponse = {
  ok?: boolean;
  error?: string;
  run_id?: string;
  steps?: StepResult[];
};

function StateIcon({ state }: { state: string | null }) {
  if (state === "ok") return <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />;
  if (state === "failed")
    return <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />;
  if (state === "skipped")
    return <MinusCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />;
  return <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />;
}

function RunProgress({ events }: { events: ChannelStatusEventRow[] }) {
  if (events.length === 0) return null;
  // Um passo pode ter 2 linhas (running → ok/failed): mostramos a última.
  const latestByStep = new Map<string, ChannelStatusEventRow>();
  for (const e of events) latestByStep.set(e.step ?? e.reason_code, e);
  return (
    <ul className="flex flex-col gap-2" data-testid="run-progress">
      {[...latestByStep.values()].map((e) => (
        <li key={e.id} className="flex gap-2" data-testid={`run-step-${e.step ?? e.reason_code}`}>
          <StateIcon state={e.step_state} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium capitalize text-foreground">
              {e.step ?? e.reason_code}
            </p>
            {e.reason_detail && (
              <p className="text-caption leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                {e.reason_detail}
              </p>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ConnectionDiagnostics({
  slug,
  channel,
}: {
  slug: string;
  channel: ChannelRow | null;
}) {
  const qc = useQueryClient();
  const [runId, setRunId] = useState<string | null>(null);
  const [phone, setPhone] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const eventsQ = useChannelStatusEvents(channel?.id, Boolean(channel?.id));
  const runEvents = eventsForRun(eventsQ.data, runId);

  const invokeAction = async (body: Record<string, unknown>) => {
    const { data, error } = await supabase.functions.invoke("integration-connect", { body });
    if (error) throw error;
    const res = (data ?? {}) as ActionResponse;
    if (res.run_id) setRunId(res.run_id);
    return res;
  };

  const reconnect = useMutation({
    mutationFn: async () => {
      setRunId(null);
      const res = await invokeAction({ action: "reconnect", slug });
      if (!res.ok) throw new Error(res.error ?? "Não foi possível reconectar.");
      return res;
    },
    onSuccess: () => {
      toast.success("Reconexão concluída.");
      qc.invalidateQueries({ queryKey: ["tenant-channels"] });
      qc.invalidateQueries({ queryKey: ["tenant-integrations"] });
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["channel-status-events", channel?.id] });
    },
  });

  const testMessaging = useMutation({
    mutationFn: async () => {
      setRunId(null);
      const res = await invokeAction({ action: "test_messaging", slug, phone });
      if (!res.ok) throw new Error(res.error ?? "O teste falhou.");
      return res;
    },
    onSuccess: () => toast.success("Teste enviado. Confira o WhatsApp informado."),
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["channel-status-events", channel?.id] });
    },
  });

  const busy = reconnect.isPending || testMessaging.isPending;
  const canReconnect = slug === "zappaz" && Boolean(channel);
  if (!channel) return null;

  const history = (eventsQ.data ?? []).filter((e) => !e.step);

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-caption font-semibold text-foreground">Diagnóstico da conexão</p>
        {channel.last_status_reason && (
          <span
            className="min-w-0 text-caption text-muted-foreground [overflow-wrap:anywhere]"
            data-testid="last-status-reason"
          >
            Último motivo: {channel.last_status_reason}
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {canReconnect && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => reconnect.mutate()}
          >
            {reconnect.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            Reconectar Zappaz
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={`test-phone-${slug}`}>Testar integração (texto + áudio)</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id={`test-phone-${slug}`}
            inputMode="tel"
            placeholder="5511999998888"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            disabled={busy}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="sm:w-auto"
            disabled={busy || phone.replace(/\D/g, "").length < 10}
            onClick={() => testMessaging.mutate()}
          >
            {testMessaging.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Send className="mr-2 h-4 w-4" />
            )}
            Enviar teste
          </Button>
        </div>
        <p className="text-caption text-muted-foreground">
          Enviamos uma mensagem de texto e um áudio para o número informado. Confirme se os dois
          chegaram no WhatsApp e aparecem no inbox.
        </p>
      </div>

      {(busy || runEvents.length > 0) && (
        <div className="rounded-md border border-border bg-background p-3">
          {runEvents.length > 0 ? (
            <RunProgress events={runEvents} />
          ) : (
            <p className="flex items-center gap-2 text-caption text-muted-foreground">
              <CircleDashed className="h-4 w-4 animate-spin" />
              Iniciando…
            </p>
          )}
        </div>
      )}

      {history.length > 0 && (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            className="self-start text-caption text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
            onClick={() => setShowHistory((v) => !v)}
            aria-expanded={showHistory}
          >
            {showHistory ? "Ocultar histórico" : `Ver histórico (${history.length})`}
          </button>
          {showHistory && (
            <ul className="flex flex-col gap-2" data-testid="status-history">
              {history.map((e) => (
                <li key={e.id} className="flex flex-col gap-0.5 border-l-2 border-border pl-2">
                  <p className="text-caption font-medium text-foreground">
                    {e.reason_code} · {e.source}
                  </p>
                  {e.reason_detail && (
                    <p className="text-caption text-muted-foreground [overflow-wrap:anywhere]">
                      {e.reason_detail}
                    </p>
                  )}
                  <p className="text-caption text-muted-foreground">
                    {relativeFromNow(e.created_at)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
