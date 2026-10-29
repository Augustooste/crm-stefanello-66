import { useState } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useBoards } from "@/lib/api/boards";
import {
  inboundWebhookUrl,
  useCreateInboundRule,
  useUpdateInboundRule,
  type InboundRule,
} from "@/lib/api/inbound-rules";
import { INBOUND_PRESETS, type InboundPreset } from "@/lib/inbound-presets";
import { errorText } from "./format";
import {
  ACTION_LABEL,
  conditionSummary,
  applyPreset,
  buildRuleInput,
  DEFAULT_MAX_PER_DAY,
  DEFAULT_MAX_PER_MINUTE,
  emptyForm,
  formFromRule,
  MATCH_LABEL,
  MODE_LABEL,
  MOVES_DEAL,
  ruleFingerprint,
  useBoardStageKinds,
  useDealCustomFields,
  usesFallbackPath,
  validateStep,
  WIZARD_STEPS,
  type StageKind,
  type WizardForm,
} from "./inbound-rule-form";
import { InboundRuleHelp } from "./InboundRuleHelp";
import { InboundRuleTestPanel } from "./InboundRuleTestPanel";
import {
  ActionStep,
  IdentificationStep,
  type Patch,
  type StepProps,
} from "./InboundRuleWizardSteps";
import { SecretRevealDialog } from "./SecretRevealDialog";

/** Assistente de 5 passos. Com `initial`, edita (o modo de verificação não muda). */
export function InboundRuleWizard({
  open,
  onOpenChange,
  initial,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: InboundRule;
}) {
  const createM = useCreateInboundRule();
  const updateM = useUpdateInboundRule();
  const [form, setForm] = useState<WizardForm>(() =>
    initial ? formFromRule(initial) : emptyForm(),
  );
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [ruleId, setRuleId] = useState<string | null>(initial?.id ?? null);
  const [saved, setSaved] = useState<string | null>(() =>
    initial ? ruleFingerprint(formFromRule(initial)) : null,
  );
  const [saving, setSaving] = useState(false);
  const stagesQ = useBoardStageKinds(form.boardId || null);
  const fieldsQ = useDealCustomFields();
  const isEdit = ruleId !== null;
  const ctx = { isEdit, stages: stagesQ.data, customFields: fieldsQ.data };
  const patch: Patch = (p) => setForm((current) => ({ ...current, ...p }));
  const last = WIZARD_STEPS.length - 1;

  const goNext = () => {
    const problem = validateStep(step, form, ctx);
    if (problem) return setError(problem);
    setError(null);
    setStep((s) => Math.min(s + 1, last));
  };
  const goBack = () => {
    setError(null);
    setStep((s) => Math.max(s - 1, 0));
  };

  const save = async () => {
    for (let s = 0; s < last; s += 1) {
      const problem = validateStep(s, form, ctx);
      if (problem) {
        setStep(s);
        return setError(problem);
      }
    }
    setError(null);
    setSaving(true);
    try {
      const input = buildRuleInput(form);
      if (ruleId) {
        await updateM.mutateAsync({ id: ruleId, ...input });
        toast.success("Regra atualizada.");
      } else {
        const created = await createM.mutateAsync(input);
        setRuleId(created.id);
        if (!created.secret) toast.success("Regra criada.");
      }
      // O segredo colado não fica no estado depois de enviado.
      const clean = { ...form, secret: "" };
      setForm(clean);
      setSaved(ruleFingerprint(clean));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const dirty = saved !== ruleFingerprint(form);
  const testBlocked = !ruleId
    ? "Crie a regra para testar."
    : dirty
      ? "Salve para testar as mudanças."
      : null;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90vh] max-w-2xl grid-cols-[minmax(0,1fr)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {initial ? "Editar regra de entrada" : "Nova regra de entrada"}
            </DialogTitle>
            <DialogDescription>
              Passo {step + 1} de {WIZARD_STEPS.length}: {WIZARD_STEPS[step]}
            </DialogDescription>
          </DialogHeader>
          <ol aria-label="Passos" className="flex flex-wrap gap-2 text-caption">
            {WIZARD_STEPS.map((label, index) => (
              <li
                key={label}
                aria-current={index === step ? "step" : undefined}
                className={
                  index === step
                    ? "rounded-md bg-primary px-2 py-1 text-primary-foreground"
                    : "rounded-md bg-muted px-2 py-1 text-muted-foreground"
                }
              >
                {index + 1}. {label}
              </li>
            ))}
          </ol>

          {step === 0 && <ModelStep form={form} patch={patch} isEdit={isEdit} setForm={setForm} />}
          {step === 1 && <VerificationStep form={form} patch={patch} isEdit={isEdit} />}
          {step === 2 && (
            <IdentificationStep form={form} patch={patch} isEdit={isEdit} fieldsQ={fieldsQ} />
          )}
          {step === 3 && (
            <ActionStep
              form={form}
              patch={patch}
              isEdit={isEdit}
              stagesQ={stagesQ}
              limits={initial}
            />
          )}
          {step === 4 && (
            <div className="flex flex-col gap-4">
              <Summary form={form} stages={stagesQ.data ?? []} limits={initial} />
              {ruleId && <RuleUrl ruleId={ruleId} />}
              <InboundRuleTestPanel
                ruleId={ruleId}
                action={form.action}
                stages={stagesQ.data ?? []}
                disabledReason={testBlocked}
              />
            </div>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter className="gap-2">
            {step > 0 && (
              <Button type="button" variant="outline" onClick={goBack}>
                Voltar
              </Button>
            )}
            {step < last ? (
              <Button type="button" onClick={goNext}>
                Avançar
              </Button>
            ) : (
              <Button
                type="button"
                onClick={() => void save()}
                disabled={saving || (isEdit && !dirty)}
              >
                {isEdit ? "Salvar alterações" : "Criar regra"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <SecretRevealDialog
        open={!!createM.data?.secret}
        title="Regra criada"
        description="Use este segredo para assinar cada requisição enviada para a URL da regra."
        secretLabel="Segredo"
        copyLabel="Copiar segredo"
        closeLabel="Já guardei o segredo"
        secret={createM.data?.secret ?? undefined}
        onClose={() => createM.reset()}
      />
    </>
  );
}

function RuleUrl({ ruleId }: { ruleId: string }) {
  let url: string | null = null;
  try {
    url = inboundWebhookUrl(ruleId);
  } catch {
    url = null;
  }
  if (!url) {
    return <p className="text-body text-destructive">Não foi possível montar a URL da regra.</p>;
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("URL copiada.");
    } catch {
      toast.error("Não foi possível copiar. Selecione o texto e copie manualmente.");
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <span className="text-caption font-medium text-muted-foreground">
        URL da regra (cole no gateway)
      </span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-md border border-border bg-muted px-3 py-2 font-mono text-caption text-foreground">
          {url}
        </code>
        <Button type="button" variant="secondary" size="sm" onClick={() => void copy()}>
          <Copy className="mr-2 h-4 w-4" aria-hidden="true" />
          Copiar URL
        </Button>
      </div>
    </div>
  );
}

function ModelStep({
  form,
  patch,
  isEdit,
  setForm,
}: StepProps & { setForm: React.Dispatch<React.SetStateAction<WizardForm>> }) {
  const boardsQ = useBoards();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="inbound-name">Nome da regra</Label>
        <Input
          id="inbound-name"
          value={form.name}
          maxLength={120}
          onChange={(e) => patch({ name: e.target.value })}
          placeholder="Ex.: Pagamentos do Asaas"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="inbound-board">Funil</Label>
        {boardsQ.isLoading ? (
          <Skeleton role="status" aria-label="Carregando funis" className="h-9 w-full" />
        ) : (
          <Select
            value={form.boardId}
            onValueChange={(boardId) => patch({ boardId, allowedStageIds: [], toStageId: "" })}
          >
            <SelectTrigger id="inbound-board" aria-label="Funil">
              <SelectValue placeholder="Escolha o funil" />
            </SelectTrigger>
            <SelectContent>
              {(boardsQ.data ?? []).map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {boardsQ.error && (
          <p className="text-body text-destructive">Não foi possível carregar os funis.</p>
        )}
      </div>
      {!isEdit && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="inbound-preset">Modelo</Label>
          <Select
            value={form.presetId}
            onValueChange={(id) => setForm((f) => applyPreset(f, id as InboundPreset["id"]))}
          >
            <SelectTrigger id="inbound-preset" aria-label="Modelo">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INBOUND_PRESETS.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-caption text-muted-foreground">
            O modelo preenche a verificação, os caminhos e as condições. Você pode ajustar tudo nos
            próximos passos.
          </p>
        </div>
      )}
    </div>
  );
}

function VerificationStep({ form, patch, isEdit }: StepProps) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-body text-foreground">
        Modo de verificação: <strong>{MODE_LABEL[form.verificationMode]}</strong>
        {isEdit && " (não muda depois de criada)"}
      </p>
      {form.verificationMode === "aceleraflow_hmac" && (
        <p className="text-body text-muted-foreground">
          O CRM gera o segredo ao criar a regra e mostra uma única vez. Quem envia assina o corpo
          com ele no cabeçalho X-Aceleraflow-Signature.
        </p>
      )}
      {form.verificationMode === "header_token" && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="inbound-header">Nome do header do token</Label>
          <Input
            id="inbound-header"
            value={form.tokenHeaderName}
            maxLength={64}
            onChange={(e) => patch({ tokenHeaderName: e.target.value })}
            className="font-mono"
          />
        </div>
      )}
      {!isEdit && form.verificationMode !== "aceleraflow_hmac" && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="inbound-secret">Segredo do gateway</Label>
          <Input
            id="inbound-secret"
            type="password"
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            value={form.secret}
            maxLength={512}
            onChange={(e) => patch({ secret: e.target.value })}
          />
          <p className="text-caption text-muted-foreground">
            Cole o valor que o gateway mostra (de 8 a 512 caracteres). Ele fica guardado no cofre e
            nunca é exibido de novo.
          </p>
        </div>
      )}
      {!isEdit && <InboundRuleHelp presetId={form.presetId} />}
    </div>
  );
}

function Summary({
  form,
  stages,
  limits,
}: {
  form: WizardForm;
  stages: StageKind[];
  limits: InboundRule | undefined;
}) {
  const boardsQ = useBoards();
  const stageName = (id: string) => stages.find((s) => s.id === id)?.name ?? "etapa apagada";
  const match =
    form.matchField === "deal_custom_field"
      ? `${MATCH_LABEL[form.matchField]} ${form.customFieldKey}`
      : MATCH_LABEL[form.matchField];
  const rows: Array<[string, string]> = [
    ["Nome", form.name.trim()],
    ["Funil", boardsQ.data?.find((b) => b.id === form.boardId)?.name ?? "-"],
    ["Verificação", MODE_LABEL[form.verificationMode]],
    ["Id do evento", form.eventIdPath],
    [
      "Identificação",
      `${match} em ${form.matchPath}${
        usesFallbackPath(form.matchField) && form.matchFallbackPath.trim()
          ? ` (alternativo: ${form.matchFallbackPath.trim()})`
          : ""
      }`,
    ],
    [
      "Condições",
      form.conditions.length ? form.conditions.map(conditionSummary).join("; ") : "nenhuma",
    ],
    ["Ação", ACTION_LABEL[form.action]],
    ["Etapas permitidas", form.allowedStageIds.map(stageName).join(", ")],
    [
      "Limites",
      `${limits?.maxActionsPerMinute ?? DEFAULT_MAX_PER_MINUTE} por minuto, ${limits?.maxActionsPerDay ?? DEFAULT_MAX_PER_DAY} por dia`,
    ],
  ];
  if (MOVES_DEAL.has(form.action)) rows.splice(7, 0, ["Destino", stageName(form.toStageId)]);
  return (
    <dl
      aria-label="Resumo da regra"
      className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-md border border-border p-3 text-body"
    >
      {rows.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-muted-foreground">{term}</dt>
          <dd className="break-all text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
