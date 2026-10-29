import { Plus, Trash2 } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import type {
  InboundAction,
  InboundCondition,
  InboundMatchField,
  InboundNotFoundMode,
  InboundRule,
} from "@/lib/api/inbound-rules";
import {
  ACTION_LABEL,
  DEFAULT_MAX_PER_DAY,
  DEFAULT_MAX_PER_MINUTE,
  destinationOptions,
  MATCH_LABEL,
  MAX_CONDITIONS,
  MAX_IN_ITEMS,
  MOVES_DEAL,
  NOT_FOUND_LABEL,
  SECRET_FIELDS_WARNING,
  TRANSFORM_LABEL,
  usesFallbackPath,
  withConditionKind,
  type ConditionKind,
  type DealCustomField,
  type MatchTransformChoice,
  type StageKind,
  type WizardForm,
} from "./inbound-rule-form";

// Passos 3 (identificação) e 4 (ação) do assistente de regra de entrada.

export type Patch = (patch: Partial<WizardForm>) => void;
export type StepProps = { form: WizardForm; patch: Patch; isEdit: boolean };
/** O que os passos precisam de uma query auxiliar (etapas, campos personalizados). */
export type AuxQuery<T> = { data: T | undefined; error: unknown; refetch: () => unknown };

/** Sem dados e sem erro = ainda carregando (inclui a query desabilitada, à espera do perfil). */
function isWaiting<T>(q: AuxQuery<T>): boolean {
  return q.data === undefined && !q.error;
}

function LoadError({ what, onRetry }: { what: string; onRetry: () => unknown }) {
  return (
    <Alert variant="destructive">
      <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
        <span>Não foi possível carregar {what}.</span>
        <Button type="button" variant="secondary" size="sm" onClick={() => void onRetry()}>
          Tentar novamente
        </Button>
      </AlertDescription>
    </Alert>
  );
}

export function IdentificationStep({
  form,
  patch,
  fieldsQ,
}: StepProps & { fieldsQ: AuxQuery<DealCustomField[]> }) {
  const fields = fieldsQ.data;
  const replaceCondition = (index: number, next: InboundCondition) =>
    patch({ conditions: form.conditions.map((c, i) => (i === index ? next : c)) });
  const setCondition = (index: number, change: Partial<InboundCondition>) =>
    replaceCondition(index, { ...form.conditions[index], ...change });
  return (
    <div className="flex flex-col gap-4">
      <PathInput
        id="inbound-event-id"
        label="Caminho do id do evento"
        value={form.eventIdPath}
        onChange={(eventIdPath) => patch({ eventIdPath })}
        hint="Usado para não repetir a ação quando o gateway reenvia o mesmo evento."
      />
      <div className="flex flex-col gap-2">
        <Label htmlFor="inbound-match-field">Identificar o negócio por</Label>
        <Select
          value={form.matchField}
          onValueChange={(v) => patch({ matchField: v as InboundMatchField, matchPrefix: "" })}
        >
          <SelectTrigger id="inbound-match-field" aria-label="Identificar o negócio por">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(MATCH_LABEL) as InboundMatchField[]).map((k) => (
              <SelectItem key={k} value={k}>
                {MATCH_LABEL[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {form.matchField === "deal_custom_field" && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="inbound-custom-field">Campo personalizado do negócio</Label>
          {fieldsQ.error ? (
            <LoadError what="os campos personalizados" onRetry={fieldsQ.refetch} />
          ) : isWaiting(fieldsQ) ? (
            <Skeleton
              role="status"
              aria-label="Carregando campos personalizados"
              className="h-9 w-full"
            />
          ) : (fields ?? []).length === 0 ? (
            <Alert variant="destructive">
              <AlertDescription>
                Nenhum campo personalizado de negócio existe. Crie um em Configurações, Campos
                personalizados, e preencha nele o identificador do pedido.
              </AlertDescription>
            </Alert>
          ) : (
            <Select
              value={form.customFieldKey}
              onValueChange={(customFieldKey) => patch({ customFieldKey })}
            >
              <SelectTrigger id="inbound-custom-field" aria-label="Campo personalizado do negócio">
                <SelectValue placeholder="Escolha o campo" />
              </SelectTrigger>
              <SelectContent>
                {(fields ?? []).map((f) => (
                  <SelectItem key={f.key} value={f.key}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}
      <PathInput
        id="inbound-match-path"
        label="Caminho do identificador no evento"
        value={form.matchPath}
        onChange={(matchPath) => patch({ matchPath })}
      />
      {usesFallbackPath(form.matchField) && (
        <PathInput
          id="inbound-match-fallback"
          label="Caminho alternativo do identificador (opcional)"
          value={form.matchFallbackPath}
          onChange={(matchFallbackPath) => patch({ matchFallbackPath })}
          hint="Usado só quando o caminho principal vem vazio."
        />
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="inbound-transform">Transformação</Label>
          <Select
            value={form.matchTransform}
            onValueChange={(v) => patch({ matchTransform: v as MatchTransformChoice })}
          >
            <SelectTrigger id="inbound-transform" aria-label="Transformação">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(TRANSFORM_LABEL) as MatchTransformChoice[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {TRANSFORM_LABEL[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {form.matchField === "phone" && (
          <div className="flex flex-col gap-2">
            <Label htmlFor="inbound-prefix">Prefixo do país (opcional)</Label>
            <Input
              id="inbound-prefix"
              value={form.matchPrefix}
              maxLength={5}
              placeholder="+55"
              onChange={(e) => patch({ matchPrefix: e.target.value })}
            />
          </div>
        )}
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-body font-medium text-foreground">
          Condições (todas precisam valer)
        </legend>
        {form.conditions.length === 0 && (
          <p className="text-caption text-muted-foreground">
            Sem condições: todo evento é avaliado.
          </p>
        )}
        {form.conditions.map((c, index) => (
          <div key={index} className="flex min-w-0 flex-wrap items-end gap-2">
            <div className="flex min-w-0 flex-1 basis-40 flex-col gap-1">
              <Label htmlFor={`cond-path-${index}`}>Caminho da condição {index + 1}</Label>
              <Input
                id={`cond-path-${index}`}
                value={c.path}
                className="font-mono"
                onChange={(e) => setCondition(index, { path: e.target.value })}
              />
            </div>
            <div className="flex min-w-0 flex-1 basis-40 flex-col gap-1">
              <Label htmlFor={`cond-kind-${index}`}>Tipo da condição {index + 1}</Label>
              <Select
                value={c.in !== undefined ? "in" : "equals"}
                onValueChange={(v) =>
                  replaceCondition(index, withConditionKind(c, v as ConditionKind))
                }
              >
                <SelectTrigger
                  id={`cond-kind-${index}`}
                  aria-label={`Tipo da condição ${index + 1}`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="equals">Igual a</SelectItem>
                  <SelectItem value="in">Qualquer um de</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {c.in !== undefined ? (
              <div className="flex min-w-0 flex-[2_1_14rem] flex-col gap-1">
                <Label htmlFor={`cond-in-${index}`}>Valores da condição {index + 1}</Label>
                <Input
                  id={`cond-in-${index}`}
                  value={c.in.join(",")}
                  aria-describedby={`cond-in-hint-${index}`}
                  onChange={(e) => setCondition(index, { in: e.target.value.split(",") })}
                />
                <p
                  id={`cond-in-hint-${index}`}
                  className="break-words text-caption text-muted-foreground"
                >
                  Separe por vírgula, até {MAX_IN_ITEMS} valores. Basta um deles para valer.
                </p>
              </div>
            ) : (
              <div className="flex min-w-0 flex-1 basis-40 flex-col gap-1">
                <Label htmlFor={`cond-equals-${index}`}>Valor da condição {index + 1}</Label>
                <Input
                  id={`cond-equals-${index}`}
                  value={c.equals ?? ""}
                  maxLength={200}
                  onChange={(e) => setCondition(index, { equals: e.target.value })}
                />
              </div>
            )}
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={`Remover condição ${index + 1}`}
              onClick={() => patch({ conditions: form.conditions.filter((_, i) => i !== index) })}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        ))}
        {form.conditions.length < MAX_CONDITIONS && (
          <div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => patch({ conditions: [...form.conditions, { path: "", equals: "" }] })}
            >
              <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
              Adicionar condição
            </Button>
          </div>
        )}
      </fieldset>
      <div className="flex flex-col gap-2">
        <Label htmlFor="inbound-not-found">Quando o negócio não for encontrado</Label>
        <Select
          value={form.notFoundMode}
          onValueChange={(v) => patch({ notFoundMode: v as InboundNotFoundMode })}
        >
          <SelectTrigger id="inbound-not-found" aria-label="Quando o negócio não for encontrado">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(NOT_FOUND_LABEL) as InboundNotFoundMode[]).map((k) => (
              <SelectItem key={k} value={k}>
                {NOT_FOUND_LABEL[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

export function PathInput({
  id,
  label,
  value,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        className="font-mono"
        maxLength={200}
        placeholder="data.object.email"
        onChange={(e) => onChange(e.target.value)}
      />
      <p className="text-caption text-muted-foreground">
        {hint ? `${hint} ` : ""}Segmentos separados por ponto; índice de lista é número
        (pix.0.txid).
      </p>
    </div>
  );
}

export function ActionStep({
  form,
  patch,
  stagesQ,
  limits,
}: StepProps & {
  stagesQ: AuxQuery<StageKind[]>;
  limits: InboundRule | undefined;
}) {
  const stages = stagesQ.data;
  const toggleStage = (id: string, checked: boolean) =>
    patch({
      allowedStageIds: checked
        ? [...form.allowedStageIds, id]
        : form.allowedStageIds.filter((s) => s !== id),
    });
  const options = destinationOptions(form, stages ?? []);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="inbound-action">Ação</Label>
        <Select
          value={form.action}
          onValueChange={(v) => patch({ action: v as InboundAction, toStageId: "" })}
        >
          <SelectTrigger id="inbound-action" aria-label="Ação">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(ACTION_LABEL) as InboundAction[]).map((k) => (
              <SelectItem key={k} value={k}>
                {ACTION_LABEL[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-body font-medium text-foreground">Etapas permitidas</legend>
        <p className="text-caption text-muted-foreground">
          A regra só age em negócios abertos deste funil e só leva o negócio para uma destas etapas.
        </p>
        {stagesQ.error ? (
          <LoadError what="as etapas do funil" onRetry={stagesQ.refetch} />
        ) : (
          isWaiting(stagesQ) && (
            <Skeleton role="status" aria-label="Carregando etapas" className="h-8 w-full" />
          )
        )}
        {(stages ?? []).map((s) => (
          <div key={s.id} className="flex items-center gap-2">
            <Checkbox
              id={`allowed-${s.id}`}
              checked={form.allowedStageIds.includes(s.id)}
              onCheckedChange={(checked) => toggleStage(s.id, checked === true)}
            />
            <Label htmlFor={`allowed-${s.id}`}>{s.name}</Label>
          </div>
        ))}
      </fieldset>
      {MOVES_DEAL.has(form.action) && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="inbound-target">Etapa de destino</Label>
          <Select value={form.toStageId} onValueChange={(toStageId) => patch({ toStageId })}>
            <SelectTrigger id="inbound-target" aria-label="Etapa de destino">
              <SelectValue placeholder="Escolha a etapa" />
            </SelectTrigger>
            <SelectContent>
              {options.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {stages !== undefined && options.length === 0 && (
            <p className="text-caption text-muted-foreground">
              {form.action === "mark_won"
                ? "Marque uma etapa de ganho entre as permitidas."
                : form.action === "mark_lost"
                  ? "Marque uma etapa de perda entre as permitidas."
                  : "Marque uma etapa aberta entre as permitidas (ganho e perda têm ação própria)."}
            </p>
          )}
        </div>
      )}
      {form.action === "mark_lost" && (
        <>
          <PathInput
            id="inbound-reason-path"
            label="Caminho do motivo no evento (opcional)"
            value={form.reasonPath}
            onChange={(reasonPath) => patch({ reasonPath })}
          />
          <TemplateInput
            id="inbound-reason-text"
            label="Motivo fixo (opcional; usado se o caminho vier vazio)"
            value={form.reasonText}
            onChange={(reasonText) => patch({ reasonText })}
          />
        </>
      )}
      {form.action === "add_note" && (
        <TemplateInput
          id="inbound-note"
          label="Texto da nota"
          value={form.noteText}
          onChange={(noteText) => patch({ noteText })}
        />
      )}
      {form.action === "create_activity" && (
        <>
          <TemplateInput
            id="inbound-activity-title"
            label="Título da atividade"
            value={form.activityTitle}
            onChange={(activityTitle) => patch({ activityTitle })}
          />
          <div className="flex flex-col gap-2">
            <Label htmlFor="inbound-due">Prazo em horas</Label>
            <Input
              id="inbound-due"
              inputMode="numeric"
              value={form.dueInHours}
              maxLength={3}
              onChange={(e) => patch({ dueInHours: e.target.value })}
            />
          </div>
        </>
      )}
      <p className="text-caption text-muted-foreground">
        Limites: até {limits?.maxActionsPerMinute ?? DEFAULT_MAX_PER_MINUTE} ações por minuto e{" "}
        {limits?.maxActionsPerDay ?? DEFAULT_MAX_PER_DAY} por dia. Ao passar do limite diário a
        regra é pausada.
      </p>
    </div>
  );
}

function TemplateInput({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const hintId = `${id}-hint`;
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        value={value}
        rows={2}
        maxLength={500}
        aria-describedby={hintId}
        onChange={(e) => onChange(e.target.value)}
      />
      <p id={hintId} className="text-caption text-muted-foreground">
        Use {"{{caminho}}"} para inserir um valor do evento. {SECRET_FIELDS_WARNING}
      </p>
    </div>
  );
}
