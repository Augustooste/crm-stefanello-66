const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });
const dateOnly = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" });

export function formatDateTime(iso: string | null | undefined, fallback = "Nunca"): string {
  return iso ? dateTime.format(new Date(iso)) : fallback;
}

export function formatDate(iso: string | null | undefined, fallback = "Sem expiração"): string {
  return iso ? dateOnly.format(new Date(iso)) : fallback;
}

/** Mensagem exibível de um erro desconhecido; DeveloperApiError já vem em português. */
export function errorText(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Não foi possível concluir a operação. Tente novamente.";
}
