import { useState } from "react";
import { KeyRound, Plus } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/common/EmptyState";
import { StatusBadge } from "@/components/common/StatusBadge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  useAllowedApiScopes,
  useApiKeys,
  useCreateApiKey,
  useRevokeApiKey,
  type ApiKey,
} from "@/lib/api/developer";
import { errorText, formatDate, formatDateTime } from "./format";
import { SecretRevealDialog } from "./SecretRevealDialog";

/** Reservado para a v2 (fechar negócio por integração): a v1 não tem rota com este escopo. */
const RESERVED_SCOPE = "deals:write";

function isExpired(key: ApiKey): boolean {
  return !!key.expires_at && new Date(key.expires_at).getTime() <= Date.now();
}

export function ApiKeysSection() {
  const keysQ = useApiKeys();
  const createM = useCreateApiKey();
  const revokeM = useRevokeApiKey();
  const [createOpen, setCreateOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);

  const confirmRevoke = async () => {
    if (!revokeTarget) return;
    const target = revokeTarget;
    setRevokeTarget(null);
    try {
      await revokeM.mutateAsync(target.id);
      toast.success(`Chave "${target.name}" revogada.`);
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  const keys = keysQ.data ?? [];

  return (
    <section aria-labelledby="api-keys-title" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="api-keys-title" className="text-section-title font-semibold text-foreground">
            Chaves de API
          </h2>
          <p className="text-body text-muted-foreground">
            Autentique chamadas à API pública enviando a chave no cabeçalho{" "}
            <code className="font-mono">X-Api-Key</code>.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {keysQ.isFetching && !keysQ.isLoading && (
            <span role="status" className="text-caption text-muted-foreground">
              Atualizando…
            </span>
          )}
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
            Criar chave de API
          </Button>
        </div>
      </div>

      {keysQ.isLoading ? (
        <div role="status" aria-label="Carregando chaves de API" className="flex flex-col gap-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : keysQ.error ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>{errorText(keysQ.error)}</span>
            <Button variant="secondary" size="sm" onClick={() => void keysQ.refetch()}>
              Tentar novamente
            </Button>
          </AlertDescription>
        </Alert>
      ) : keys.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="Nenhuma chave de API"
          description="Crie uma chave para que um sistema seu leia ou grave dados deste workspace."
          actionLabel="Criar chave de API"
          onAction={() => setCreateOpen(true)}
        />
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
          {keys.map((key) => (
            <li key={key.id} className="flex flex-wrap items-start justify-between gap-4 p-4">
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">{key.name}</span>
                  {key.revoked_at ? (
                    <StatusBadge variant="destructive">Revogada</StatusBadge>
                  ) : isExpired(key) ? (
                    <StatusBadge variant="warning">Expirada</StatusBadge>
                  ) : (
                    <StatusBadge variant="success">Ativa</StatusBadge>
                  )}
                </div>
                <code className="font-mono text-caption text-muted-foreground">
                  {key.key_prefix}
                </code>
                <div className="flex flex-wrap gap-1">
                  {key.scopes.map((scope) => (
                    <StatusBadge key={scope} variant="outline" showDot={false}>
                      {scope}
                    </StatusBadge>
                  ))}
                </div>
                <p className="text-caption text-muted-foreground">
                  Último uso: {formatDateTime(key.last_used_at)} · Expira:{" "}
                  {formatDate(key.expires_at)}
                </p>
              </div>
              {!key.revoked_at && (
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Revogar chave ${key.name}`}
                  onClick={() => setRevokeTarget(key)}
                >
                  Revogar
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <CreateApiKeyDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSubmit={async (input) => {
          await createM.mutateAsync(input);
          setCreateOpen(false);
        }}
      />

      <SecretRevealDialog
        open={!!createM.data}
        title="Chave criada"
        description="Copie a chave e guarde em um cofre de segredos do seu sistema."
        secretLabel="Chave"
        copyLabel="Copiar chave"
        closeLabel="Já guardei a chave"
        secret={createM.data?.token}
        usage={
          <>
            Envie em cada requisição o cabeçalho <code className="font-mono">X-Api-Key</code> com
            esta chave.
          </>
        }
        onClose={() => createM.reset()}
      />

      <AlertDialog
        open={!!revokeTarget}
        onOpenChange={(next) => {
          if (!next) setRevokeTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revogar esta chave?</AlertDialogTitle>
            <AlertDialogDescription>
              Os sistemas que usam a chave &quot;{revokeTarget?.name}&quot; deixam de conseguir
              acessar a API imediatamente. Não é possível desfazer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmRevoke()}>Revogar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function CreateApiKeyDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: { name: string; scopes: string[]; expiresAt: string | null }) => Promise<void>;
}) {
  const scopesQ = useAllowedApiScopes();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [expires, setExpires] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setName("");
    setScopes([]);
    setExpires("");
    setError(null);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return setError("Informe um nome para a chave.");
    if (scopes.length === 0) return setError("Selecione ao menos um escopo.");
    let expiresAt: string | null = null;
    if (expires) {
      const date = new Date(`${expires}T23:59:59`);
      if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
        return setError("A data de expiração precisa ser futura.");
      }
      expiresAt = date.toISOString();
    }
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit({ name: name.trim(), scopes, expiresAt });
      reset();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Nova chave de API</DialogTitle>
            <DialogDescription>
              Dê só os escopos de que o sistema precisa. A chave aparece uma única vez.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="api-key-name">Nome</Label>
            <Input
              id="api-key-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex.: Integração com o ERP"
            />
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-body font-medium text-foreground">Escopos</legend>
            {scopesQ.isLoading && <Skeleton className="h-8 w-full" />}
            {scopesQ.error && (
              <p className="text-body text-destructive">{errorText(scopesQ.error)}</p>
            )}
            {(scopesQ.data ?? []).map((scope) => (
              <div key={scope} className="flex items-center gap-2">
                <Checkbox
                  id={`scope-${scope}`}
                  checked={scopes.includes(scope)}
                  onCheckedChange={(checked) =>
                    setScopes((current) =>
                      checked === true ? [...current, scope] : current.filter((s) => s !== scope),
                    )
                  }
                />
                <Label htmlFor={`scope-${scope}`} className="font-mono">
                  {scope}
                </Label>
                {scope === RESERVED_SCOPE && (
                  <span className="text-caption text-muted-foreground">
                    reservado, sem rotas na v1
                  </span>
                )}
              </div>
            ))}
          </fieldset>
          <div className="flex flex-col gap-2">
            <Label htmlFor="api-key-expires">Expira em (opcional)</Label>
            <Input
              id="api-key-expires"
              type="date"
              value={expires}
              onChange={(e) => setExpires(e.target.value)}
            />
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={submitting}>
              Criar chave
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
