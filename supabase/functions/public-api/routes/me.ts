import { jsonResponse } from "../errors.ts";
import type { RouteHandler } from "../types.ts";

export const getMe: RouteHandler = ({ ctx }) =>
  Promise.resolve(jsonResponse(200, {
    data: { tenant_id: ctx.tenantId, key_id: ctx.keyId, scopes: ctx.scopes },
  }));
