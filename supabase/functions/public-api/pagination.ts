import { apiError } from "./errors.ts";
import type { Row } from "./types.ts";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseLimit(raw: string | null, requestId: string): number | Response {
  if (raw === null) return DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    return apiError("validation_error", "Parâmetro limit inválido.", requestId);
  }
  return Math.min(Number(raw), MAX_LIMIT);
}

/** Cursor opaco = id (uuid) do último item da página anterior. */
export function parseCursor(raw: string | null, requestId: string): { after: string | null } | Response {
  if (raw === null || raw === "") return { after: null };
  if (!UUID_RE.test(raw)) return apiError("validation_error", "Cursor inválido.", requestId);
  return { after: raw };
}

/** Pede limit+1 ao banco; devolve a página e o próximo cursor. */
export function toPage(items: Row[], limit: number): { data: Row[]; next_cursor: string | null } {
  const data = items.slice(0, limit);
  const more = items.length > limit;
  return { data, next_cursor: more ? String(data[data.length - 1].id) : null };
}
