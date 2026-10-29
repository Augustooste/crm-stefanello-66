import { buildOpenApiSpec } from "../_shared/public-api/openapi.ts";
import { apiError, jsonResponse } from "./errors.ts";
import { createContact, getContact, listContacts } from "./routes/contacts.ts";
import { getDeal, listDeals } from "./routes/deals.ts";
import { getMe } from "./routes/me.ts";
import type { TenantScoped } from "./tenant-scoped.ts";
import type { RouteHandler } from "./types.ts";

interface Route {
  method: "GET" | "POST";
  /** Caminho no formato OpenAPI, usado pelo teste de paridade com a spec. */
  path: string;
  pattern: RegExp;
  scope: string | null;
  handler: RouteHandler;
}

export interface Matched {
  handler: RouteHandler;
  scope: string | null;
  params: Record<string, string>;
}

const SPEC_PATH_RE = /^\/v1\/openapi\.json$/;
const specResponse = () => jsonResponse(200, buildOpenApiSpec());

function stripGatewayPrefix(pathname: string): string {
  return pathname.replace(/^\/functions\/v1\/public-api/, "").replace(/^\/public-api/, "")
    .replace(/\/+$/, "");
}

/** A spec é pública: o handler a responde ANTES de autenticar (sem chave, sem banco). */
export function publicSpecResponse(method: string, pathname: string): Response | null {
  return method === "GET" && SPEC_PATH_RE.test(stripGatewayPrefix(pathname)) ? specResponse() : null;
}

function buildRoutes(s: { db: TenantScoped }): Route[] {
  return [
    {
      method: "GET",
      path: "/v1/openapi.json",
      pattern: SPEC_PATH_RE,
      scope: null,
      handler: () => Promise.resolve(specResponse()),
    },
    { method: "GET", path: "/v1/me", pattern: /^\/v1\/me$/, scope: null, handler: getMe },
    { method: "GET", path: "/v1/contacts", pattern: /^\/v1\/contacts$/, scope: "contacts:read", handler: listContacts(s) },
    { method: "GET", path: "/v1/contacts/{id}", pattern: /^\/v1\/contacts\/(?<id>[^/]+)$/, scope: "contacts:read", handler: getContact(s) },
    { method: "POST", path: "/v1/contacts", pattern: /^\/v1\/contacts$/, scope: "contacts:write", handler: createContact(s) },
    // deals:write fica reservado para a v2 (fechar negócio por integração); a v1 não tem rota com esse escopo.
    { method: "GET", path: "/v1/deals", pattern: /^\/v1\/deals$/, scope: "deals:read", handler: listDeals(s) },
    { method: "GET", path: "/v1/deals/{id}", pattern: /^\/v1\/deals\/(?<id>[^/]+)$/, scope: "deals:read", handler: getDeal(s) },
  ];
}

/** Rotas registradas (método, caminho OpenAPI, escopo) para o teste de paridade com a spec. */
export function listRoutes(s: { db: TenantScoped }): Array<{ method: string; path: string; scope: string | null }> {
  return buildRoutes(s).map(({ method, path, scope }) => ({ method, path, scope }));
}

/** Casa método+caminho (ignora prefixo /functions/v1/public-api do gateway). */
export function matchRoute(
  s: { db: TenantScoped },
  method: string,
  pathname: string,
  requestId: string,
): Matched | Response {
  const path = stripGatewayPrefix(pathname);
  const allowed: string[] = [];
  for (const route of buildRoutes(s)) {
    const m = route.pattern.exec(path);
    if (!m) continue;
    allowed.push(route.method);
    if (route.method !== method) continue;
    return { handler: route.handler, scope: route.scope, params: { ...m.groups } };
  }
  return allowed.length > 0
    ? apiError("method_not_allowed", "Método não permitido.", requestId, { Allow: allowed.join(", ") })
    : apiError("not_found", "Rota não encontrada.", requestId);
}
