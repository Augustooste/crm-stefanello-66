import { normalizePhone } from "../../_shared/messaging/conversation.ts";
import { readJsonObject } from "../body.ts";
import { apiError, jsonResponse } from "../errors.ts";
import { parseCursor, parseLimit, toPage, UUID_RE } from "../pagination.ts";
import type { TenantScoped } from "../tenant-scoped.ts";
import type { RouteHandler } from "../types.ts";

type Scoped = { db: TenantScoped };
const MAX_NAME = 200;
const MAX_TEXT = 500;
const MAX_TAGS = 50;
const MAX_TAG = 50;
const MIN_PHONE_DIGITS = 8;
const MAX_PHONE_DIGITS = 15;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const listContacts = (s: Scoped): RouteHandler => async ({ url, requestId }) => {
  const cursor = parseCursor(url.searchParams.get("cursor"), requestId);
  if (cursor instanceof Response) return cursor;
  const limit = parseLimit(url.searchParams.get("limit"), requestId);
  if (limit instanceof Response) return limit;
  const items = await s.db.contacts.list({ limit: limit + 1, after: cursor.after });
  return jsonResponse(200, toPage(items, limit));
};

export const getContact = (s: Scoped): RouteHandler => async ({ params, requestId }) => {
  const found = UUID_RE.test(params.id) ? await s.db.contacts.get(params.id) : null;
  if (!found) return apiError("not_found", "Contato não encontrado.", requestId);
  return jsonResponse(200, { data: found });
};

type Field = { ok: true; value: string | null } | { ok: false };
const BAD: Field = { ok: false };

function text(v: unknown, max: number): Field {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== "string" || v.length > max) return BAD;
  return { ok: true, value: v.trim() || null };
}

function email(v: unknown): Field {
  const f = text(v, MAX_TEXT);
  if (!f.ok || f.value === null) return f;
  return EMAIL_RE.test(f.value) ? { ok: true, value: f.value.toLowerCase() } : BAD;
}

/** Exige formato internacional (começa com "+"), normaliza como a inbound ("+<dígitos>"). */
function phone(v: unknown): Field {
  const f = text(v, MAX_TEXT);
  if (!f.ok || f.value === null) return f;
  if (!f.value.startsWith("+")) return BAD;
  const normalized = normalizePhone(f.value);
  const digits = normalized.length - 1;
  return digits >= MIN_PHONE_DIGITS && digits <= MAX_PHONE_DIGITS ? { ok: true, value: normalized } : BAD;
}

export const createContact = (s: Scoped): RouteHandler => async ({ req, requestId }) => {
  const body = await readJsonObject(req, requestId);
  if (body instanceof Response) return body;
  const invalid = (msg: string) => apiError("validation_error", msg, requestId);

  const name = text(body.name, MAX_NAME);
  if (!name.ok || name.value === null) return invalid("Campo name é obrigatório (até 200 caracteres).");
  const mail = email(body.email);
  if (!mail.ok) return invalid("Campo email inválido.");
  const tel = phone(body.phone);
  if (!tel.ok) return invalid("Campo phone inválido (use formato internacional, ex.: +5511999998888).");
  const source = text(body.source, MAX_TEXT);
  const notes = text(body.notes, MAX_TEXT);
  if (!source.ok || !notes.ok) return invalid("Campos de texto inválidos.");
  const tags = body.tags ?? [];
  if (
    !Array.isArray(tags) || tags.length > MAX_TAGS ||
    tags.some((t) => typeof t !== "string" || t.length === 0 || t.length > MAX_TAG)
  ) {
    return invalid("Campo tags deve ser lista de até 50 textos de até 50 caracteres.");
  }
  // Lista branca: campos desconhecidos (tenant_id, id, ai_paused...) são descartados.
  const created = await s.db.contacts.create({
    name: name.value,
    email: mail.value,
    phone: tel.value,
    source: source.value,
    notes: notes.value,
    tags,
  });
  return jsonResponse(201, { data: created });
};
