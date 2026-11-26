/**
 * Leitura e validação centralizada das variáveis públicas do backend.
 *
 * O objetivo é ter UMA fonte de verdade para "as env vars públicas existem?"
 * — as rotas usam isso no `beforeLoad` para falhar cedo com uma mensagem clara,
 * em vez de deixar o cliente do backend estourar no meio de uma navegação
 * (o que caía no ErrorBoundary global como "Algo deu errado").
 */

export class MissingEnvError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(
      `Variáveis de ambiente ausentes: ${missing.join(", ")}. ` +
        `Conecte o Lovable Cloud nas configurações do projeto.`,
    );
    this.name = "MissingEnvError";
    this.missing = missing;
  }
}

export function isMissingEnvError(error: unknown): error is MissingEnvError {
  if (error instanceof MissingEnvError) return true;
  // Compatibilidade com o erro cru lançado pelo cliente auto-gerado.
  if (error instanceof Error && /Missing Supabase environment variable/i.test(error.message)) {
    return true;
  }
  return false;
}

/** Converte qualquer erro reconhecido em `MissingEnvError` preservando `.missing`. */
export function toMissingEnvError(error: unknown): MissingEnvError {
  if (error instanceof MissingEnvError) return error;
  if (error instanceof Error) {
    const match = error.message.match(/variable\(s\):\s*([^.]+)/i);
    const missing = match
      ? match[1]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    return new MissingEnvError(missing);
  }
  return new MissingEnvError([]);
}

export type PublicSupabaseEnv = {
  url: string;
  publishableKey: string;
};

function normalizeEnvValue(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function readPublicSupabaseEnv():
  { ok: true; env: PublicSupabaseEnv } | { ok: false; missing: string[] } {
  // Vite substitui `import.meta.env.VITE_*` em build; `process.env.*` só chega
  // via `define` no vite.config para o caminho SSR. Aceitamos os dois.
  const url = normalizeEnvValue(
    import.meta.env?.VITE_SUPABASE_URL ||
      (typeof process !== "undefined" ? process.env?.SUPABASE_URL : undefined),
  );
  const publishableKey = normalizeEnvValue(
    import.meta.env?.VITE_SUPABASE_PUBLISHABLE_KEY ||
      (typeof process !== "undefined" ? process.env?.SUPABASE_PUBLISHABLE_KEY : undefined),
  );

  const missing: string[] = [];
  if (!url) missing.push("SUPABASE_URL");
  if (!publishableKey) missing.push("SUPABASE_PUBLISHABLE_KEY");

  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, env: { url, publishableKey } };
}

/** Retorna `{ ok, missing }` — não lança. Use no `beforeLoad` para desviar. */
export function checkPublicSupabaseEnv():
  { ok: true; env: PublicSupabaseEnv } | { ok: false; missing: string[] } {
  return readPublicSupabaseEnv();
}

/** Lança `MissingEnvError` quando algo estiver faltando. */
export function assertPublicSupabaseEnv(): PublicSupabaseEnv {
  const result = readPublicSupabaseEnv();
  if (!result.ok) throw new MissingEnvError(result.missing);
  return result.env;
}
