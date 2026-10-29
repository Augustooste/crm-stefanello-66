import type { MissingEnvError } from "@/lib/env";

/**
 * Tela amigável para quando as env vars do backend não chegaram no build.
 * Usada pelos error boundaries em vez do "Algo deu errado" genérico.
 */
export function MissingEnvScreen({ error }: { error: MissingEnvError }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-lg rounded-lg border border-border bg-card p-8 text-center shadow-sm">
        <h1 className="text-h5 font-semibold tracking-tight text-foreground">
          Backend não conectado
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          O app foi publicado sem as credenciais do backend. Conecte o Lovable Cloud nas
          configurações do projeto e publique novamente.
        </p>
        {error.missing.length > 0 ? (
          <div className="mt-4 rounded-md border border-dashed border-border bg-muted/40 p-3 text-left">
            <p className="text-caption font-medium uppercase tracking-wide text-muted-foreground">
              Variáveis ausentes
            </p>
            <ul className="mt-1 list-inside list-disc text-sm text-foreground">
              {error.missing.map((name) => (
                <li key={name}>
                  <code className="font-mono text-caption">{name}</code>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Recarregar
          </button>
        </div>
      </div>
    </div>
  );
}
