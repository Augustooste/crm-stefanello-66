import { useQueryClient } from "@tanstack/react-query";

import { extractClientError, getClientErrorObservation } from "@/lib/client-error-telemetry";
import type { CurrentProfile } from "@/lib/api/session";

/**
 * Causa técnica do erro, visível apenas para admin. Fica dentro de um
 * `<details>` fechado: o texto amigável continua sendo a primeira coisa que
 * qualquer pessoa lê.
 *
 * Por que ler o perfil do cache e não `useCurrentProfile()`: quando um
 * errorComponent renderiza, ele SUBSTITUI o componente da rota — o
 * `AuthProvider` de /_app não está montado, então o hook não teria sessão. O
 * `QueryClientProvider` do root, sim, continua acima do boundary, e o perfil
 * já foi buscado antes do erro. Sem sessão em cache, não mostra nada
 * (fail-closed).
 *
 * O texto passa pela mesma redação da telemetria, então segredo em URL,
 * e-mail e telefone não aparecem na tela nem em screenshot de suporte.
 */
export function ErrorTechnicalDetails({ error }: { error: unknown }) {
  const queryClient = useQueryClient();
  const isAdmin = queryClient
    .getQueriesData<CurrentProfile | null>({ queryKey: ["current-profile"] })
    .some(([, profile]) => profile?.role === "admin");

  if (!isAdmin) return null;

  const { message, code, stack, details, hint } = extractClientError(error);
  const observation = getClientErrorObservation(error);

  return (
    <details className="mt-5 text-left" data-testid="error-technical-details">
      <summary className="cursor-pointer text-caption text-muted-foreground">
        Detalhes técnicos (visível para administradores)
      </summary>
      <dl className="mt-2 space-y-1 text-caption">
        {code ? (
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Código:</dt>
            <dd className="font-mono">{code}</dd>
          </div>
        ) : null}
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Mensagem:</dt>
          <dd className="font-mono break-words">{message}</dd>
        </div>
        {details ? (
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Detalhe:</dt>
            <dd className="font-mono break-words">{details}</dd>
          </div>
        ) : null}
        {hint ? (
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Dica:</dt>
            <dd className="font-mono break-words">{hint}</dd>
          </div>
        ) : null}
        {observation?.operation ? (
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Operação:</dt>
            <dd className="font-mono break-words">{observation.operation}</dd>
          </div>
        ) : null}
        {observation?.observedAt ? (
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Ocorrido em:</dt>
            <dd className="font-mono">
              {new Date(observation.observedAt).toLocaleString("pt-BR")}
            </dd>
          </div>
        ) : null}
      </dl>
      {stack ? (
        <pre className="mt-2 max-h-48 overflow-auto rounded bg-muted p-2 text-caption whitespace-pre-wrap">
          {stack}
        </pre>
      ) : null}
    </details>
  );
}
