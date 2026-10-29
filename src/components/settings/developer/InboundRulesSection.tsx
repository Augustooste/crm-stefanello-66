import { useState } from "react";
import { ArrowDownToLine, Plus } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/common/EmptyState";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useBoards } from "@/lib/api/boards";
import { useCanManageDeveloper } from "@/lib/api/developer";
import {
  inboundWebhookUrl,
  useDeleteInboundRule,
  useInboundEventCounts24h,
  useInboundRules,
  useRotateInboundRuleSecret,
  useSetInboundRuleActive,
  type InboundEventStatus,
  type InboundRule,
} from "@/lib/api/inbound-rules";
import { errorText, formatDateTime } from "./format";
import {
  ACTION_LABEL,
  EVENT_STATUS_LABEL,
  GATEWAY_PAUSE_NOTES,
  ignoredSummary,
  MAX_SECRET_LENGTH,
  MIN_SECRET_LENGTH,
  MODE_LABEL,
} from "./inbound-rule-form";
import { InboundEventsDialog } from "./InboundEventsDialog";
import { InboundRuleLimitsDialog } from "./InboundRuleLimitsDialog";
import { InboundRuleWizard } from "./InboundRuleWizard";
import { SecretRevealDialog } from "./SecretRevealDialog";
import { WebhooksDocsInlineLink, WebhooksHelpLink } from "./WebhooksHelpLink";

const COUNT_ORDER: InboundEventStatus[] = [
  "processed",
  "ignored",
  "not_found",
  "ambiguous",
  "rate_limited",
  "failed",
  "processing",
];

type Confirm = { kind: "rotate" | "delete"; rule: InboundRule } | null;
type WizardState = { key: number; rule?: InboundRule } | null;

/** Mesma regra da aba: sem developer.manage (ou enquanto carrega), a seção não existe. */
export function InboundRulesSection() {
  const { allowed, isLoading } = useCanManageDeveloper();
  if (isLoading || !allowed) return null;
  return <InboundRulesContent />;
}

function InboundRulesContent() {
  const rulesQ = useInboundRules();
  const countsQ = useInboundEventCounts24h();
  const boardsQ = useBoards();
  const activeM = useSetInboundRuleActive();
  const rotateM = useRotateInboundRuleSecret();
  const deleteM = useDeleteInboundRule();
  const [wizard, setWizard] = useState<WizardState>(null);
  const [wizardSeq, setWizardSeq] = useState(0);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [newSecret, setNewSecret] = useState("");
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<InboundRule | null>(null);
  const [limitsFor, setLimitsFor] = useState<InboundRule | null>(null);

  // key nova a cada abertura: estado (e regra criada) de uma sessão não volta na próxima.
  const openWizard = (rule?: InboundRule) => {
    setWizardSeq((n) => n + 1);
    setWizard({ key: wizardSeq + 1, rule });
  };

  const closeConfirm = () => {
    setConfirm(null);
    setNewSecret("");
    setConfirmError(null);
  };

  const run = async (action: () => Promise<unknown>, success: string) => {
    try {
      await action();
      toast.success(success);
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  const runConfirmed = async () => {
    if (!confirm) return;
    const { kind, rule } = confirm;
    const external = rule.verificationMode !== "aceleraflow_hmac";
    if (kind === "rotate" && external) {
      if (newSecret.length < MIN_SECRET_LENGTH || newSecret.length > MAX_SECRET_LENGTH) {
        return setConfirmError(
          `Cole o segredo novo do gateway (de ${MIN_SECRET_LENGTH} a ${MAX_SECRET_LENGTH} caracteres).`,
        );
      }
    }
    const secret = external ? newSecret : null;
    closeConfirm();
    if (kind === "rotate") {
      await run(
        () => rotateM.mutateAsync({ id: rule.id, newSecret: secret }),
        "Segredo rotacionado.",
      );
    } else {
      await run(() => deleteM.mutateAsync(rule.id), "Regra excluída.");
    }
  };

  const rules = rulesQ.data ?? [];
  // Mesmo que isPending do TanStack: com o perfil carregando a query fica desabilitada e
  // isLoading é false; sem isto a tela mostraria "Nenhuma regra" por um instante.
  const rulesPending = rulesQ.data === undefined && !rulesQ.error;
  const boardName = (id: string) => boardsQ.data?.find((b) => b.id === id)?.name ?? "funil apagado";
  const external = confirm ? confirm.rule.verificationMode !== "aceleraflow_hmac" : false;

  return (
    <section aria-labelledby="inbound-title" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="inbound-title" className="text-section-title font-semibold text-foreground">
            Regras de entrada
          </h2>
          <p className="text-body text-muted-foreground">
            Receba eventos de gateways e sistemas externos numa URL própria e atualize negócios
            automaticamente.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {rulesQ.isFetching && !rulesPending && (
            <span role="status" className="text-caption text-muted-foreground">
              Atualizando…
            </span>
          )}
          <WebhooksHelpLink hash="entrada" topic="regras de entrada" />
          <Button onClick={() => openWizard()}>
            <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
            Nova regra
          </Button>
        </div>
      </div>

      {rulesPending ? (
        <div
          role="status"
          aria-label="Carregando regras de entrada"
          className="flex flex-col gap-2"
        >
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : rulesQ.error ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>{errorText(rulesQ.error)}</span>
            <Button variant="secondary" size="sm" onClick={() => void rulesQ.refetch()}>
              Tentar novamente
            </Button>
          </AlertDescription>
        </Alert>
      ) : rules.length === 0 ? (
        <div className="flex flex-col gap-2">
          <EmptyState
            icon={ArrowDownToLine}
            title="Nenhuma regra de entrada"
            description="Crie uma regra para que um pagamento aprovado mova o negócio sozinho."
            actionLabel="Nova regra"
            onAction={() => openWizard()}
          />
          <p className="text-center">
            <WebhooksDocsInlineLink hash="entrada">
              Como configurar Stripe, Asaas, Hotmart ou n8n
            </WebhooksDocsInlineLink>
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
          {rules.map((rule) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              boardName={boardName(rule.boardId)}
              counts={countsQ.data?.byRule[rule.id]}
              countsState={countsQ.error ? "error" : countsQ.data === undefined ? "pending" : "ok"}
              busy={activeM.isPending}
              onToggle={() =>
                void run(
                  () => activeM.mutateAsync({ id: rule.id, active: !rule.active }),
                  rule.active ? "Regra pausada." : "Regra reativada.",
                )
              }
              onRotate={() => setConfirm({ kind: "rotate", rule })}
              onDelete={() => setConfirm({ kind: "delete", rule })}
              onHistory={() => setHistoryFor(rule)}
              onLimits={() => setLimitsFor(rule)}
              onEdit={() => openWizard(rule)}
            />
          ))}
        </ul>
      )}

      {wizard && (
        <InboundRuleWizard
          key={wizard.key}
          open
          initial={wizard.rule}
          onOpenChange={(next) => {
            if (!next) setWizard(null);
          }}
        />
      )}

      <SecretRevealDialog
        open={!!rotateM.data}
        title="Novo segredo gerado"
        description="O novo segredo vale a partir de agora. O anterior continua válido por 24 horas e depois para de funcionar; atualize quem envia nesse período."
        secretLabel="Segredo"
        copyLabel="Copiar segredo"
        closeLabel="Já guardei o segredo"
        secret={rotateM.data ?? undefined}
        onClose={() => rotateM.reset()}
      />

      {historyFor && (
        <InboundEventsDialog
          ruleId={historyFor.id}
          ruleName={historyFor.name}
          open
          onOpenChange={(next) => {
            if (!next) setHistoryFor(null);
          }}
        />
      )}

      {limitsFor && (
        <InboundRuleLimitsDialog
          key={limitsFor.id}
          rule={limitsFor}
          open
          onOpenChange={(next) => {
            if (!next) setLimitsFor(null);
          }}
        />
      )}

      <AlertDialog
        open={!!confirm}
        onOpenChange={(next) => {
          if (!next) closeConfirm();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === "rotate" ? "Rotacionar o segredo?" : "Excluir esta regra?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "rotate"
                ? `O novo segredo passa a valer agora${external ? "" : " e é mostrado uma única vez"}. O segredo anterior continua válido por 24 horas e depois para de funcionar; atualize o gateway nesse período.`
                : `A regra ${confirm?.rule.name ?? ""} e o histórico de eventos serão apagados, e a URL passa a responder 401. Não é possível desfazer.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirm?.kind === "rotate" && external && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="inbound-new-secret">Novo segredo do gateway</Label>
              <Input
                id="inbound-new-secret"
                type="password"
                autoComplete="off"
                maxLength={MAX_SECRET_LENGTH}
                value={newSecret}
                onChange={(e) => setNewSecret(e.target.value)}
              />
            </div>
          )}
          {confirmError && (
            <Alert variant="destructive">
              <AlertDescription>{confirmError}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <Button
              type="button"
              variant={confirm?.kind === "delete" ? "destructive" : "default"}
              onClick={() => void runConfirmed()}
            >
              {confirm?.kind === "rotate" ? "Rotacionar" : "Excluir"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function RuleRow({
  rule,
  boardName,
  counts,
  countsState,
  busy,
  onToggle,
  onRotate,
  onDelete,
  onHistory,
  onLimits,
  onEdit,
}: {
  rule: InboundRule;
  boardName: string;
  counts: Partial<Record<InboundEventStatus, number>> | undefined;
  countsState: "ok" | "pending" | "error";
  busy: boolean;
  onToggle: () => void;
  onRotate: () => void;
  onDelete: () => void;
  onHistory: () => void;
  onLimits: () => void;
  onEdit: () => void;
}) {
  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(inboundWebhookUrl(rule.id));
      toast.success("URL copiada.");
    } catch (e) {
      toast.error(errorText(e));
    }
  };
  const shown = COUNT_ORDER.filter((s) => (counts?.[s] ?? 0) > 0);
  const ignored = ignoredSummary(rule, (iso) => formatDateTime(iso));
  const sr = <span className="sr-only"> da regra {rule.name}</span>;

  return (
    <li className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 break-words text-body font-medium text-foreground">
          {rule.name}
        </span>
        {rule.active ? (
          <StatusBadge variant="success">Ativa</StatusBadge>
        ) : (
          <StatusBadge variant="warning">Pausada</StatusBadge>
        )}
      </div>
      <p className="text-caption text-muted-foreground">
        Funil: {boardName} · Ação: {ACTION_LABEL[rule.action]} · {MODE_LABEL[rule.verificationMode]}
      </p>
      {!rule.active && (
        <div className="flex flex-col gap-1 text-caption text-warning-foreground dark:text-warning">
          <p>
            {rule.disabledReason === "daily_limit"
              ? "Motivo: pausada por limite diário; reative para voltar a aceitar eventos."
              : "Motivo: pausada manualmente; reative para voltar a aceitar eventos."}
          </p>
          <p>
            Enquanto pausada, a URL responde 401 e os eventos podem se perder. Reative logo. O que
            cada gateway faz:
          </p>
          <ul className="list-disc pl-5">
            {GATEWAY_PAUSE_NOTES.map(([gateway, note]) => (
              <li key={gateway}>
                {gateway}: {note}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-caption text-muted-foreground">
        {countsState === "error"
          ? "Contagem das últimas 24 h indisponível."
          : countsState === "pending"
            ? "Carregando contagem…"
            : shown.length === 0
              ? "Nenhum evento nas últimas 24 h."
              : `Últimas 24 h: ${shown.map((s) => `${EVENT_STATUS_LABEL[s]}: ${counts?.[s]}`).join(" · ")}`}
      </p>
      <p className="text-caption text-muted-foreground">
        Limites: {rule.maxActionsPerMinute} ações por minuto · {rule.maxActionsPerDay} por dia
      </p>
      {ignored && (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <StatusBadge variant="neutral">Ignorados antes do histórico</StatusBadge>
          <span className="min-w-0 break-words text-caption text-muted-foreground">{ignored}</span>
        </div>
      )}
      {rule.previousSecretExpiresAt && (
        <p className="text-caption text-muted-foreground">
          Segredo anterior vale até {formatDateTime(rule.previousSecretExpiresAt)}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => void copyUrl()}>
          Copiar URL{sr}
        </Button>
        <Button variant="outline" size="sm" onClick={onHistory}>
          Histórico{sr}
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={onToggle}>
          {rule.active ? "Pausar" : "Reativar"}
          {sr}
        </Button>
        <Button variant="outline" size="sm" onClick={onEdit}>
          Editar{sr}
        </Button>
        <Button variant="outline" size="sm" onClick={onLimits}>
          Limites{sr}
        </Button>
        <Button variant="outline" size="sm" onClick={onRotate}>
          Rotacionar segredo{sr}
        </Button>
        <Button variant="outline" size="sm" onClick={onDelete}>
          Excluir{sr}
        </Button>
      </div>
    </li>
  );
}
