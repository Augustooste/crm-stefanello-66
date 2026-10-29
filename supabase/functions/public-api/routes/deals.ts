import { apiError, jsonResponse } from "../errors.ts";
import { parseCursor, parseLimit, toPage, UUID_RE } from "../pagination.ts";
import type { TenantScoped } from "../tenant-scoped.ts";
import type { RouteHandler } from "../types.ts";

type Scoped = { db: TenantScoped };

export const listDeals = (s: Scoped): RouteHandler => async ({ url, requestId }) => {
  const cursor = parseCursor(url.searchParams.get("cursor"), requestId);
  if (cursor instanceof Response) return cursor;
  const limit = parseLimit(url.searchParams.get("limit"), requestId);
  if (limit instanceof Response) return limit;
  const items = await s.db.deals.list({ limit: limit + 1, after: cursor.after });
  return jsonResponse(200, toPage(items, limit));
};

export const getDeal = (s: Scoped): RouteHandler => async ({ params, requestId }) => {
  const found = UUID_RE.test(params.id) ? await s.db.deals.get(params.id) : null;
  if (!found) return apiError("not_found", "Negócio não encontrado.", requestId);
  return jsonResponse(200, { data: found });
};
