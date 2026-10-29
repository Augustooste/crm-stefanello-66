import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Bot, History, Pause, RotateCcw, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile } from "@/lib/api/session";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import {
  transitionDealStage,
  type AutomationMode,
  type DealStageEvaluation,
  type DealStageHistory,
  type PendingStageAdvance,
  type TransitionCommand,
  usePauseDealAutomation,
  usePipelineAutomationMetrics,
  useResolvePipelineAdvance,
  useReviewDealEvaluation,
  useStageTransitionRules,
  useUpdateStageTransitionRule,
} from "@/lib/api/pipeline-automation";

export interface AutomationDeal {
  id: string;
  stage_id: string;
  automation_mode: string;
  automation_paused_until: string | null;
  automation_lock_reason: string | null;
}

interface StageOption {
  id: string;
  name: string;
}

export interface DealAutomationSnapshot {
  evaluations: DealStageEvaluation[];
  pending?: PendingStageAdvance;
  latestHistory?: DealStageHistory;
  latestCommand?: TransitionCommand;
}

function confidencePercent(value: number | null | undefined) {
  return Math.round((value ?? 0) * 100);
}

/** Pausa efetiva: modo pausado, janela de pausa ainda vigente ou trava operacional. */
function isAutomationPaused(deal: AutomationDeal): boolean {
  return (
    deal.automation_mode === "paused" ||
    (!!deal.automation_paused_until &&
      new Date(deal.automation_paused_until).getTime() > Date.now()) ||
    !!deal.automation_lock_reason
  );
}

/**
 * Resumo de UMA linha para o card do quadro. As etiquetas completas, os
 * critérios e a aprovação vivem no diálogo (`DealAutomationDetails`): numa
 * coluna de 288px a pilha de etiquetas tirava a altura previsível do card e
 * matava a leitura do funil. `null` = nada de automação a mostrar.
 */
export function automationSummary(
  deal: AutomationDeal,
  snapshot: DealAutomationSnapshot,
): string | null {
  if (snapshot.pending) return "IA: aguardando aprovação";
  if (isAutomationPaused(deal)) return "IA pausada";
  const currentEvaluations = snapshot.evaluations.filter((item) => item.stage_id === deal.stage_id);
  if (currentEvaluations.length > 0) {
    const unmet = currentEvaluations.filter((item) => item.status !== "met").length;
    if (unmet === 0) return "IA: critérios cumpridos";
    return `IA: ${unmet} ${unmet === 1 ? "pendência" : "pendências"}`;
  }
  // `evaluations` inteiro (não só o da etapa atual) porque antes deste resumo o
  // card mostrava o botão de detalhes sempre que houvesse QUALQUER avaliação.
  // Sem esta cláusula, negócio avaliado numa etapa anterior e sem histórico
  // perderia o acesso ao diálogo — regressão silenciosa em relação à versão
  // com três blocos.
  if (snapshot.latestCommand || snapshot.latestHistory || snapshot.evaluations.length > 0) {
    return "IA acompanhando";
  }
  return null;
}

export function DealAutomationBadges({
  deal,
  snapshot,
}: {
  deal: AutomationDeal;
  snapshot: DealAutomationSnapshot;
}) {
  const currentEvaluations = snapshot.evaluations.filter((item) => item.stage_id === deal.stage_id);
  const met = currentEvaluations.filter((item) => item.status === "met").length;
  const averageConfidence =
    currentEvaluations.length > 0
      ? currentEvaluations.reduce((sum, item) => sum + item.confidence, 0) /
        currentEvaluations.length
      : null;
  const paused = isAutomationPaused(deal);

  // `latestHistory` entra no guard porque o resumo do card já promete
  // "IA acompanhando" nesse cenário: sem ele o diálogo abria com a tira de
  // etiquetas vazia.
  if (
    !paused &&
    !snapshot.pending &&
    !snapshot.latestCommand &&
    !snapshot.latestHistory &&
    currentEvaluations.length === 0
  ) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-1.5" data-testid="deal-automation-badges">
      {paused ? (
        <StatusBadge variant="warning">IA pausada</StatusBadge>
      ) : (
        <StatusBadge variant="brand">IA acompanhando</StatusBadge>
      )}
      {currentEvaluations.length > 0 && (
        <StatusBadge variant={met === currentEvaluations.length ? "success" : "neutral"}>
          {met}/{currentEvaluations.length} critérios
        </StatusBadge>
      )}
      {/* "Confiança 100%" sozinha ao lado de "0/3 critérios" era lida como "100%
          de certeza de que deve avançar". É o oposto: a IA está confiante na
          ANÁLISE, e a análise concluiu que nenhum critério foi cumprido. O
          rótulo agora diz de quem é a confiança. */}
      {averageConfidence !== null && (
        <StatusBadge variant="outline">
          Análise {confidencePercent(averageConfidence)}% confiável
        </StatusBadge>
      )}
      {snapshot.pending && <StatusBadge variant="warning">Aguardando aprovação</StatusBadge>}
      {snapshot.latestHistory?.actor_type === "ai" && (
        <StatusBadge variant="success">
          Movido pela IA{" "}
          {formatDistanceToNow(new Date(snapshot.latestHistory.created_at), {
            addSuffix: true,
            locale: ptBR,
          })}
        </StatusBadge>
      )}
      {snapshot.latestCommand?.status === "blocked" && (
        <StatusBadge variant="destructive">Conflito detectado</StatusBadge>
      )}
      {snapshot.latestCommand?.status === "rejected" && (
        <StatusBadge variant="neutral">Informação insuficiente</StatusBadge>
      )}
    </div>
  );
}

export function InlineStageApproval({
  pending,
  stages,
}: {
  pending?: PendingStageAdvance;
  stages: StageOption[];
}) {
  const resolve = useResolvePipelineAdvance();
  const [destination, setDestination] = useState(pending?.suggested_stage_id ?? "");
  if (!pending) return null;

  const target = stages.find((stage) => stage.id === destination);
  const submit = (action: "approve" | "reject") => {
    resolve.mutate(
      {
        advanceId: pending.id,
        action,
        reason: action === "reject" ? "Rejeitada no Kanban" : undefined,
        suggestedStageId:
          action === "approve" && destination !== pending.suggested_stage_id
            ? destination
            : undefined,
      },
      {
        onSuccess: () =>
          toast.success(action === "approve" ? "Movimento aprovado." : "Sugestão rejeitada."),
        onError: (error) => toast.error(error.message),
      },
    );
  };

  return (
    <div
      className="space-y-2 rounded-md border border-border bg-muted/30 p-2"
      data-testid="inline-stage-approval"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <p className="text-caption font-medium">
        Sugestão da IA: mover para {target?.name ?? "outro estágio"}
      </p>
      <Select value={destination} onValueChange={setDestination}>
        <SelectTrigger className="h-8" aria-label="Editar destino sugerido">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {stages.map((stage) => (
            <SelectItem key={stage.id} value={stage.id}>
              {stage.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="flex gap-1.5">
        <Button
          size="sm"
          className="h-7"
          disabled={resolve.isPending || !destination}
          onClick={() => submit("approve")}
        >
          Aprovar
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          disabled={resolve.isPending}
          onClick={() => submit("reject")}
        >
          Rejeitar
        </Button>
      </div>
    </div>
  );
}

export function DealAutomationDetails({
  deal,
  snapshot,
  stages,
}: {
  deal: AutomationDeal;
  snapshot: DealAutomationSnapshot;
  stages: StageOption[];
}) {
  const [open, setOpen] = useState(false);
  const pause = usePauseDealAutomation();
  const review = useReviewDealEvaluation();
  const history = snapshot.latestHistory;
  const fromStage = stages.find((stage) => stage.id === history?.from_stage_id);
  const toStage = stages.find((stage) => stage.id === history?.to_stage_id);
  const currentEvaluations = snapshot.evaluations.filter((item) => item.stage_id === deal.stage_id);
  const met = currentEvaluations.filter((item) => item.status === "met").length;
  const isPaused = isAutomationPaused(deal);
  const summary = automationSummary(deal, snapshot);

  const undo = async () => {
    if (!history?.from_stage_id) return;
    try {
      await transitionDealStage({
        dealId: deal.id,
        expectedStageId: deal.stage_id,
        targetStageId: history.from_stage_id,
        reason: `Desfazer transição para ${toStage?.name ?? "estágio anterior"}`,
        evidence: { source: "kanban.undo", history_id: history.id },
        idempotencyKey: `kanban-undo:${history.id}`,
        reversalOfHistoryId: history.id,
      });
      toast.success("Transição desfeita com nova entrada de auditoria.");
      setOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não foi possível desfazer.");
    }
  };

  if (!summary) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-full justify-start px-1.5 text-caption"
          aria-label={`${summary} — abrir detalhes da IA`}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <Bot className="mr-1 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">{summary}</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Decisão da IA no funil</DialogTitle>
          <DialogDescription>
            Evidência persistida, política aplicada e ações auditadas.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <DealAutomationBadges deal={deal} snapshot={snapshot} />
          <InlineStageApproval pending={snapshot.pending} stages={stages} />

          {currentEvaluations.length > 0 && (
            <section className="space-y-2">
              <div className="flex items-center justify-between text-caption">
                <span>Critérios cumpridos</span>
                <span>
                  {met}/{currentEvaluations.length}
                </span>
              </div>
              <Progress value={(met / currentEvaluations.length) * 100} />
              <div className="space-y-2">
                {currentEvaluations.map((item) => (
                  <div key={item.id} className="rounded-md border border-border p-2">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-body font-medium">{item.criterion_label}</p>
                      <StatusBadge variant={item.status === "met" ? "success" : "neutral"}>
                        {item.status === "met" ? "Cumprido" : "Pendente"}
                      </StatusBadge>
                    </div>
                    <p className="mt-1 text-caption text-muted-foreground">
                      {item.evidence || "Sem evidência suficiente."}
                    </p>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-1 h-7 px-1.5"
                      disabled={review.isPending}
                      onClick={() =>
                        review.mutate(
                          {
                            evaluationId: item.id,
                            note: "Avaliação corrigida manualmente no Kanban",
                          },
                          {
                            onSuccess: () => toast.success("Avaliação marcada para calibração."),
                            onError: (error) => toast.error(error.message),
                          },
                        )
                      }
                    >
                      Corrigir avaliação
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          )}

          {history && (
            <section className="space-y-2 rounded-md border border-border p-3">
              <div className="flex items-center gap-2 font-medium">
                <History className="h-4 w-4" aria-hidden />
                Movido de {fromStage?.name ?? "estágio anterior"} para{" "}
                {toStage?.name ?? "novo estágio"}
              </div>
              <p className="text-caption text-muted-foreground">
                {history.reason || "Movimento registrado sem descrição adicional."}
              </p>
              {history.confidence !== null && (
                <p className="text-caption">Confiança: {confidencePercent(history.confidence)}%</p>
              )}
            </section>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            variant="outline"
            disabled={pause.isPending}
            onClick={() =>
              pause.mutate(
                { dealId: deal.id, paused: !isPaused },
                {
                  onSuccess: () =>
                    toast.success(isPaused ? "Automação retomada." : "Automação pausada."),
                  onError: (error) => toast.error(error.message),
                },
              )
            }
          >
            <Pause className="mr-1 h-4 w-4" aria-hidden />
            {isPaused ? "Retomar IA" : "Pausar IA"}
          </Button>
          <Button variant="secondary" disabled={!history?.from_stage_id} onClick={undo}>
            <RotateCcw className="mr-1 h-4 w-4" aria-hidden />
            Desfazer movimento
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const pipelineAgentFeatureSchema = z
  .object({ enabled: z.boolean(), enabled_at: z.string().datetime({ offset: true }).nullable() })
  .nullable();

function PipelineAgentToggle() {
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id;
  const qc = useQueryClient();
  const feature = useQuery({
    queryKey: ["pipeline-agent-feature", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenant_ai_features")
        .select("enabled, enabled_at")
        .eq("tenant_id", tenantId!)
        .eq("feature_key", "pipeline_agent")
        .maybeSingle();
      if (error) throw error;
      return pipelineAgentFeatureSchema.parse(data);
    },
  });
  const toggle = useMutation({
    mutationFn: async (enabled: boolean) => {
      if (!tenantId || profile?.role !== "admin") {
        throw new Error("Apenas administradores podem configurar o agente.");
      }
      const { error } = await supabase.from("tenant_ai_features").upsert(
        {
          tenant_id: tenantId,
          feature_key: "pipeline_agent",
          enabled,
          updated_by: profile.id,
        },
        { onConflict: "tenant_id,feature_key" },
      );
      if (error) throw error;
    },
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["pipeline-agent-feature", tenantId] }),
        qc.invalidateQueries({ queryKey: ["ai-feature-catalog", tenantId] }),
      ]);
      toast.success("Agente de pipeline atualizado neste workspace.");
    },
  });
  const enabledAt = feature.data?.enabled_at;

  return (
    <section className="space-y-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="pipeline-agent-enabled">Agente de pipeline neste workspace</Label>
        <Switch
          id="pipeline-agent-enabled"
          checked={feature.data?.enabled ?? false}
          disabled={
            profile?.role !== "admin" || feature.isPending || feature.isError || toggle.isPending
          }
          onCheckedChange={(enabled) => toggle.mutate(enabled)}
          aria-describedby="pipeline-agent-status"
        />
      </div>
      <div id="pipeline-agent-status" className="text-caption text-muted-foreground">
        {feature.isPending ? (
          <p>Consultando o agente deste workspace...</p>
        ) : feature.isError ? (
          <p role="alert">
            Não foi possível consultar o agente. Reabra esta janela para tentar novamente.
          </p>
        ) : feature.data?.enabled && enabledAt ? (
          <p>
            Ligado desde{" "}
            <time dateTime={enabledAt}>{new Date(enabledAt).toLocaleString("pt-BR")}</time>.
          </p>
        ) : (
          <p>Desligado. Os eventos anteriores à ativação não serão processados.</p>
        )}
        <p>
          Ao ligar, somente eventos novos deste workspace serão avaliados, enquanto a rotina do
          servidor estiver ativa. As políticas abaixo continuam controlando cada movimento.
        </p>
        {profile?.role !== "admin" && <p>Apenas administradores podem alterar esta opção.</p>}
      </div>
      {toggle.isError && (
        <p role="alert" className="text-caption text-destructive">
          {toggle.error.message}
        </p>
      )}
    </section>
  );
}

export function AutomationSettingsDialog({
  boardId,
  stages,
}: {
  boardId?: string;
  stages: StageOption[];
}) {
  const [open, setOpen] = useState(false);
  const rules = useStageTransitionRules(boardId);
  const metrics = usePipelineAutomationMetrics(boardId);
  const update = useUpdateStageTransitionRule(boardId);
  const stageNames = useMemo(
    () => new Map(stages.map((stage) => [stage.id, stage.name])),
    [stages],
  );

  const saveRule = (
    id: string,
    mode: AutomationMode,
    minConfidence: number,
    requiresHumanApproval: boolean,
  ) => {
    update.mutate(
      {
        id,
        autonomyMode: mode,
        minConfidence,
        requiresHumanApproval,
      },
      {
        onSuccess: () => toast.success("Política de transição atualizada."),
        onError: (error) => toast.error(error.message),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" disabled={!boardId}>
          <Settings2 className="mr-1 h-4 w-4" aria-hidden />
          Autonomia
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Autonomia do funil</DialogTitle>
          <DialogDescription>
            Configure cada transição separadamente. A IA pode apenas observar, sugerir uma mudança
            ou movimentar o card automaticamente, conforme o modo e as proteções escolhidas.
          </DialogDescription>
        </DialogHeader>

        <PipelineAgentToggle />

        <ul className="space-y-0.5 text-caption text-muted-foreground">
          <li>Manual: o operador movimenta.</li>
          <li>Shadow: a IA observa e registra.</li>
          <li>Assistido: a IA sugere e o humano aprova.</li>
          <li>Autônomo: a IA pode executar.</li>
        </ul>

        {metrics.data && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ["Sugestões", metrics.data.suggested],
              ["Automáticas", metrics.data.automatic],
              ["Bloqueadas", metrics.data.blocked],
              ["Reversões", metrics.data.reversals],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-md border border-border p-3">
                <p className="text-caption text-muted-foreground">{label}</p>
                <p className="text-h5 font-semibold">{value}</p>
              </div>
            ))}
          </div>
        )}

        <div className="space-y-2">
          {(rules.data ?? []).map((rule) => (
            <RuleEditor
              key={rule.id}
              label={`${stageNames.get(rule.from_stage_id) ?? "Origem"} → ${
                stageNames.get(rule.to_stage_id) ?? "Destino"
              }`}
              mode={rule.autonomy_mode}
              minConfidence={rule.min_confidence}
              requiresHumanApproval={rule.requires_human_approval}
              pending={update.isPending}
              onSave={(mode, confidence, approval) => saveRule(rule.id, mode, confidence, approval)}
            />
          ))}
          {!rules.isLoading && (rules.data?.length ?? 0) === 0 && (
            <p className="text-body text-muted-foreground">
              Nenhuma regra de transição disponível.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Aprovação humana só é configurável no modo autônomo. Nos demais o motor
 * ignora (manual/shadow nunca criam pendência; assistido sempre cria), então a
 * UI normaliza o valor antes de salvar para nunca persistir estado
 * contraditório vindo de um modo anterior.
 */
const FORCED_APPROVAL: Record<AutomationMode, boolean | null> = {
  manual: false,
  shadow: false,
  assisted: true,
  autonomous: null,
};

export function normalizeApproval(mode: AutomationMode, draft: boolean): boolean {
  const forced = FORCED_APPROVAL[mode];
  return forced === null ? draft : forced;
}

const CONFIDENCE_LABEL: Record<AutomationMode, string> = {
  manual: "Confiança de referência %",
  shadow: "Confiança de referência %",
  assisted: "Confiança de referência %",
  autonomous: "Confiança mínima %",
};

const CONFIDENCE_HINT: Record<AutomationMode, string> = {
  manual: "A IA pode registrar uma recomendação, mas o card só pode ser movimentado manualmente.",
  shadow:
    "A IA registra que teria movimentado o negócio, mas não altera o Kanban e não solicita aprovação.",
  assisted: "A IA envia a sugestão para revisão humana, inclusive abaixo desta confiança.",
  autonomous:
    "Ao atingir este percentual, a IA pode movimentar o card. Abaixo dele, solicita aprovação humana.",
};

const APPROVAL_LABEL: Record<AutomationMode, string> = {
  manual: "Aprovação humana",
  shadow: "Aprovação humana",
  assisted: "Aprovação humana obrigatória",
  autonomous: "Aprovação humana",
};

function approvalHint(mode: AutomationMode, approval: boolean): string {
  if (mode === "manual") return "Não se aplica no modo manual.";
  if (mode === "shadow") return "Não se aplica no modo shadow.";
  if (mode === "assisted")
    return "Toda sugestão deste modo precisa ser aprovada antes de movimentar o card.";
  return approval
    ? "A decisão será enviada para aprovação humana e o card não será movimentado automaticamente."
    : "O card poderá ser movimentado automaticamente.";
}

function confidenceError(raw: string): string | null {
  if (raw.trim() === "") return "Informe um valor entre 0 e 100.";
  const value = Number(raw);
  if (!Number.isFinite(value)) return "Informe um número válido entre 0 e 100.";
  if (value < 0 || value > 100) return "O valor deve estar entre 0 e 100.";
  return null;
}

export function RuleEditor({
  label,
  mode,
  minConfidence,
  requiresHumanApproval,
  pending,
  onSave,
}: {
  label: string;
  mode: AutomationMode;
  minConfidence: number;
  requiresHumanApproval: boolean;
  pending: boolean;
  onSave: (mode: AutomationMode, minConfidence: number, requiresHumanApproval: boolean) => void;
}) {
  const [draftMode, setDraftMode] = useState<AutomationMode>(mode);
  const [draftConfidence, setDraftConfidence] = useState(String(Math.round(minConfidence * 100)));
  const [draftApproval, setDraftApproval] = useState(() =>
    normalizeApproval(mode, requiresHumanApproval),
  );
  // Ressincroniza quando a query devolve valores novos: compara com o que veio
  // das props na última renderização, então uma edição em andamento sobre os
  // MESMOS dados de origem não é descartada.
  const [source, setSource] = useState({ mode, minConfidence, requiresHumanApproval });
  if (
    source.mode !== mode ||
    source.minConfidence !== minConfidence ||
    source.requiresHumanApproval !== requiresHumanApproval
  ) {
    setSource({ mode, minConfidence, requiresHumanApproval });
    setDraftMode(mode);
    setDraftConfidence(String(Math.round(minConfidence * 100)));
    setDraftApproval(normalizeApproval(mode, requiresHumanApproval));
  }

  const changeMode = (next: AutomationMode) => {
    setDraftMode(next);
    // Autônomo começa com aprovação ligada por segurança quando o usuário vem
    // de outro modo; se a regra já estava salva como autônoma, o valor
    // persistido é respeitado.
    if (next === "autonomous") {
      setDraftApproval(mode === "autonomous" ? requiresHumanApproval : true);
    } else {
      setDraftApproval(normalizeApproval(next, draftApproval));
    }
  };

  const approvalLocked = FORCED_APPROVAL[draftMode] !== null;
  const effectiveApproval = normalizeApproval(draftMode, draftApproval);
  const error = confidenceError(draftConfidence);
  const confidenceId = `confianca-${label}`;
  const approvalId = `aprovacao-${label}`;

  return (
    <div className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-[1fr_150px_180px_200px_auto] sm:items-start">
      <p className="pt-6 text-body font-medium">{label}</p>
      <div className="space-y-1">
        <Label htmlFor={`modo-${label}`}>Modo</Label>
        <Select value={draftMode} onValueChange={(value) => changeMode(value as AutomationMode)}>
          <SelectTrigger id={`modo-${label}`} aria-label={`Modo da transição ${label}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="manual">Manual</SelectItem>
            <SelectItem value="shadow">Shadow</SelectItem>
            <SelectItem value="assisted">Assistido</SelectItem>
            <SelectItem value="autonomous">Autônomo</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={confidenceId}>{CONFIDENCE_LABEL[draftMode]}</Label>
        <Input
          id={confidenceId}
          aria-label={`Confiança da transição ${label}`}
          aria-describedby={`${confidenceId}-hint${error ? ` ${confidenceId}-erro` : ""}`}
          aria-invalid={error ? true : undefined}
          type="number"
          inputMode="numeric"
          min={0}
          max={100}
          className="tabular-nums"
          value={draftConfidence}
          onChange={(event) => setDraftConfidence(event.target.value)}
        />
        <p id={`${confidenceId}-hint`} className="text-caption text-muted-foreground">
          {CONFIDENCE_HINT[draftMode]}
        </p>
        {error && (
          <p id={`${confidenceId}-erro`} role="alert" className="text-caption text-destructive">
            {error}
          </p>
        )}
      </div>
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Switch
            id={approvalId}
            aria-label={`Aprovação da transição ${label}`}
            aria-describedby={`${approvalId}-hint`}
            checked={effectiveApproval}
            disabled={approvalLocked}
            onCheckedChange={setDraftApproval}
          />
          <Label htmlFor={approvalId}>{APPROVAL_LABEL[draftMode]}</Label>
        </div>
        <p id={`${approvalId}-hint`} className="text-caption text-muted-foreground">
          {approvalHint(draftMode, effectiveApproval)}
        </p>
      </div>
      <Button
        size="sm"
        className="sm:mt-6"
        disabled={pending || !!error}
        onClick={() => onSave(draftMode, Number(draftConfidence) / 100, effectiveApproval)}
      >
        Salvar
      </Button>
    </div>
  );
}
