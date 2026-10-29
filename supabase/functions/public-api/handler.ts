import { authenticateRequest, hasScope } from "./auth.ts";
import { apiError, CORS_HEADERS } from "./errors.ts";
import { matchRoute, publicSpecResponse } from "./router.ts";
import { DbError, tenantScoped } from "./tenant-scoped.ts";
import type { ApiDeps } from "./types.ts";

// check_violation, invalid_parameter_value, not_null_violation, invalid_text_representation
const VALIDATION_SQLSTATES = new Set(["23514", "22023", "23502", "22P02"]);
const NOT_FOUND_SQLSTATE = "P0002";

export async function handleRequest(req: Request, deps: ApiDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  const publicSpec = publicSpecResponse(req.method, new URL(req.url).pathname);
  if (publicSpec) return publicSpec;
  const requestId = deps.newRequestId();
  try {
    const auth = await authenticateRequest(req, deps, requestId);
    if (!auth.ok) return auth.response;
    const { ctx } = auth;

    const scoped = { db: tenantScoped(deps.db, ctx.tenantId) };
    // Falha fechada: tenant removido (a chave some em cascata, mas não confiar nisso).
    if (!(await scoped.db.tenantExists())) {
      return apiError("tenant_inactive", "Conta inativa.", requestId);
    }

    const url = new URL(req.url);
    const matched = matchRoute(scoped, req.method, url.pathname, requestId);
    if (matched instanceof Response) return matched;
    if (matched.scope && !hasScope(ctx, matched.scope)) {
      return apiError("insufficient_scope", "Chave sem o escopo necessário.", requestId);
    }
    return await matched.handler({ req, ctx, deps, requestId, params: matched.params, url });
  } catch (err) {
    // Nunca logar req/headers: só a classe do erro e o request_id.
    if (err instanceof DbError) {
      deps.log({ event: "db_error", request_id: requestId, sqlstate: err.sqlstate ?? "none" });
      if (err.sqlstate && VALIDATION_SQLSTATES.has(err.sqlstate)) {
        return apiError("validation_error", "Dados inválidos.", requestId);
      }
      if (err.sqlstate === NOT_FOUND_SQLSTATE) {
        return apiError("not_found", "Recurso não encontrado.", requestId);
      }
      return apiError("service_unavailable", "Serviço indisponível.", requestId);
    }
    deps.log({ event: "unhandled", request_id: requestId });
    return apiError("internal_error", "Falha ao processar a requisição.", requestId);
  }
}
