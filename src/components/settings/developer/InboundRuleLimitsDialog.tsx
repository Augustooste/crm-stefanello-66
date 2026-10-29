import { useState } from "react";
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
  MAX_LIMIT_PER_DAY,
  MAX_LIMIT_PER_MINUTE,
  useSetInboundRuleLimits,
  type InboundRule,
} from "@/lib/api/inbound-rules";
import { errorText } from "./format";

/** Inteiro de 1 até o teto, ou null: mesma regra de set_inbound_rule_limits. */
export function parseLimit(value: string, max: number): number | null {
  if (!/^[0-9]{1,5}$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
}

export const DAILY_LIMIT_WARNING =
  "Se o novo limite diário for igual ou menor que as ações das últimas 24 horas (ou desde o último Reativar), a regra é pausada na próxima ação e só volta quando alguém clicar em Reativar.";

/** Edita os limites de ações por minuto e por dia de uma regra. */
export function InboundRuleLimitsDialog({
  rule,
  open,
  onOpenChange,
}: {
  rule: InboundRule;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const limitsM = useSetInboundRuleLimits();
  const [perMinute, setPerMinute] = useState(String(rule.maxActionsPerMinute));
  const [perDay, setPerDay] = useState(String(rule.maxActionsPerDay));
  // Erro de campo (some ao digitar valor válido) separado do erro do servidor.
  const [minuteInvalid, setMinuteInvalid] = useState(false);
  const [dayInvalid, setDayInvalid] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Fechar durante o envio desmontaria o diálogo antes do erro chegar.
  const guardedOpenChange = (next: boolean) => {
    if (!next && limitsM.isPending) return;
    onOpenChange(next);
  };

  const save = async () => {
    const minute = parseLimit(perMinute, MAX_LIMIT_PER_MINUTE);
    const day = parseLimit(perDay, MAX_LIMIT_PER_DAY);
    setMinuteInvalid(minute === null);
    setDayInvalid(day === null);
    setError(null);
    if (minute === null || day === null) {
      // Sem alerta global: o foco leva o leitor de tela ao campo, que lê "inválido" e o erro.
      document
        .getElementById(minute === null ? "inbound-limit-minute" : "inbound-limit-day")
        ?.focus();
      return;
    }
    try {
      await limitsM.mutateAsync({ id: rule.id, perMinute: minute, perDay: day });
      toast.success("Limites atualizados.");
      onOpenChange(false);
    } catch (e) {
      // Diálogo continua aberto: o admin corrige sem redigitar.
      setError(errorText(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-md grid-cols-[minmax(0,1fr)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Limites da regra</DialogTitle>
          <DialogDescription className="break-words">
            {rule.name}. Quantas ações a regra pode aplicar nos negócios.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="inbound-limit-minute">Ações por minuto</Label>
            <Input
              id="inbound-limit-minute"
              inputMode="numeric"
              value={perMinute}
              aria-invalid={minuteInvalid || undefined}
              aria-describedby={`inbound-limit-minute-hint${minuteInvalid ? " inbound-limit-minute-error" : ""}`}
              onChange={(e) => {
                setPerMinute(e.target.value);
                if (minuteInvalid) {
                  setMinuteInvalid(parseLimit(e.target.value, MAX_LIMIT_PER_MINUTE) === null);
                }
              }}
            />
            <p id="inbound-limit-minute-hint" className="text-caption text-muted-foreground">
              De 1 a {MAX_LIMIT_PER_MINUTE}. Acima do limite o gateway recebe 429; o reenvio depende
              do gateway.
            </p>
            {minuteInvalid && (
              <p id="inbound-limit-minute-error" className="text-caption text-destructive">
                Ações por minuto: use um número inteiro de 1 a {MAX_LIMIT_PER_MINUTE}.
              </p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="inbound-limit-day">Ações por dia (últimas 24 horas)</Label>
            <Input
              id="inbound-limit-day"
              inputMode="numeric"
              value={perDay}
              aria-invalid={dayInvalid || undefined}
              aria-describedby={`inbound-limit-day-hint${dayInvalid ? " inbound-limit-day-error" : ""}`}
              onChange={(e) => {
                setPerDay(e.target.value);
                if (dayInvalid)
                  setDayInvalid(parseLimit(e.target.value, MAX_LIMIT_PER_DAY) === null);
              }}
            />
            <p id="inbound-limit-day-hint" className="text-caption text-muted-foreground">
              De 1 a {MAX_LIMIT_PER_DAY}.
            </p>
            {dayInvalid && (
              <p id="inbound-limit-day-error" className="text-caption text-destructive">
                Ações por dia: use um número inteiro de 1 a {MAX_LIMIT_PER_DAY}.
              </p>
            )}
          </div>
          <Alert>
            <AlertDescription className="break-words">{DAILY_LIMIT_WARNING}</AlertDescription>
          </Alert>
          {error && (
            <Alert id="inbound-limit-error" variant="destructive">
              <AlertDescription className="break-words">{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={limitsM.isPending}
              onClick={() => onOpenChange(false)}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={limitsM.isPending}>
              Salvar limites
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
