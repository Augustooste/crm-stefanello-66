// agent-platform-proxy — única porta de saída do AceleraFlow para o provedor de agentes.
//
// O navegador NUNCA fala com o provedor de agentes: ele chama esta function com o JWT do
// usuário, e o Bearer token do provedor fica só aqui (integration_secrets, ou
// env como fallback declarado). Toda operação:
//   1. autentica o caller (JWT) e exige admin do tenant;
//   2. resolve workspaceId no SERVIDOR — nunca aceita do cliente;
//   3. valida posse do recurso (agent_platform_agent_links / agent_platform_channel_links);
//   4. chama a operação do contrato pelo registro de actions;
//   5. audita em agent_platform_audit_log e reporta erro em system_events.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

import { loadProfileOrFail, PROFILE_DB_ERROR_MESSAGE } from "../_shared/load-profile.ts";
import { captureEdgeError } from "../_shared/telemetry.ts";
import {
  AGENT_PLATFORM_ERROR_MESSAGES,
  AgentPlatformError,
  type AgentPlatformErrorCode,
  createAgentPlatformClient,
} from "../_shared/agent-platform/client.ts";
import {
  type ActionParams,
  ActionResolveError,
  type ActionSpec,
  AGENT_PLATFORM_ACTIONS,
  resolveAction,
} from "../_shared/agent-platform/actions.ts";
import { buildTrainingCallbackUrl } from "../_shared/agent-platform/callback.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SLUG = "agent-platform";

interface ProxyBody {
  action?: string;
  params?: ActionParams;
  body?: unknown;
}

interface Credentials {
  token: string;
  workspaceId: string | null;
  /** `tenant` = segredo do próprio tenant (fronteira real é o token remoto).
   * `env` = token global de fallback, compartilhado entre tenants. */
  source: "tenant" | "env";
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

/** Erro esperado sai em 200 + envelope: `functions.invoke` descarta o corpo em
 * não-2xx, e sem isto a UI mostraria "non-2xx status code" no lugar da causa. */
function errorEnvelope(
  code: AgentPlatformErrorCode,
  correlationId: string,
  message?: string,
): Response {
  return json(200, {
    error: { code, message: message ?? AGENT_PLATFORM_ERROR_MESSAGES[code], correlationId },
  });
}

/** Leitura do banco que falhou vira `db_error` para o caller — mas `error.message`
 * e `error.code` são o único jeito de saber DEPOIS se foi RLS, coluna faltando ou
 * banco fora. Mesma regra que `loadProfileOrFail` já aplica neste arquivo. */
async function reportReadError(
  admin: SupabaseClient,
  tenantId: string,
  operation: string,
  error: { message: string; code?: string },
): Promise<void> {
  await captureEdgeError(admin, {
    severity: "error",
    source: "edge",
    operation,
    tenantId,
    errorCode: error.code ?? null,
    message: error.message,
  });
}

/**
 * JWT ausente/expirado/adulterado vs. GoTrue instável.
 *
 * O erro de sessão inválida chega com status HTTP 401/403; qualquer outra coisa
 * (5xx, falha de rede — `AuthRetryableFetchError` sai sem `status`) é
 * infraestrutura e precisa de resposta retentável, não de "Não autenticado.".
 */
function isInvalidSessionError(error: { status?: number }): boolean {
  return error.status === 401 || error.status === 403;
}

async function loadCredentials(
  admin: SupabaseClient,
  tenantId: string,
): Promise<{ ok: true; credentials: Credentials } | { ok: false; reason: "db_error" | "missing" }> {
  // O status da integração é a PRIMEIRA coisa checada, antes de qualquer
  // credencial. Motivo: `disconnect` (integration-connect) grava
  // status:"disabled" e NÃO apaga o `integration_secrets` — só o `forget` apaga.
  // Checando o status depois do token, "desconectar" seguia sendo no-op: o
  // proxy continuava usando o api_token antigo. Com o status na frente, os dois
  // caminhos de revogação fecham, e o do tenant e o global fecham juntos.
  const { data: link, error: linkError } = await admin
    .from("tenant_integrations")
    .select("slug, status")
    .eq("tenant_id", tenantId)
    .eq("slug", SLUG)
    .maybeSingle();
  if (linkError) {
    await reportReadError(
      admin,
      tenantId,
      "agent-platform.load_credentials.tenant_integration",
      linkError,
    );
    return { ok: false, reason: "db_error" };
  }
  if (!link || link.status !== "active") return { ok: false, reason: "missing" };

  const { data, error } = await admin
    .from("integration_secrets")
    .select("key, value")
    .eq("tenant_id", tenantId)
    .eq("slug", SLUG);
  if (error) {
    await reportReadError(admin, tenantId, "agent-platform.load_credentials.secrets", error);
    return { ok: false, reason: "db_error" };
  }

  const values = new Map<string, string>();
  for (const row of data ?? []) values.set(row.key as string, row.value as string);

  const tenantToken = values.get("api_token")?.trim();
  if (tenantToken) {
    return {
      ok: true,
      credentials: {
        token: tenantToken,
        workspaceId: values.get("workspace_id")?.trim() || null,
        source: "tenant",
      },
    };
  }

  // Fallback de ambiente: um token global só vale para tenant com a integração
  // habilitada explicitamente — senão daria acesso ao workspace para qualquer
  // tenant do banco. A checagem de `active` acima já é essa fronteira.
  const envToken = Deno.env.get("AGENT_PLATFORM_API_TOKEN")?.trim();
  if (!envToken) return { ok: false, reason: "missing" };

  return {
    ok: true,
    credentials: {
      token: envToken,
      workspaceId: Deno.env.get("AGENT_PLATFORM_WORKSPACE_ID")?.trim() || null,
      source: "env",
    },
  };
}

type OwnershipResult = { ok: true } | { ok: false; reason: "denied" | "db_error" };

async function assertResourceOwnership(
  admin: SupabaseClient,
  tenantId: string,
  credentials: Credentials,
  kind: "agent" | "channel",
  resourceId: string,
): Promise<OwnershipResult> {
  const table = kind === "agent" ? "agent_platform_agent_links" : "agent_platform_channel_links";
  const column = kind === "agent" ? "platform_agent_id" : "platform_channel_id";
  const { data, error } = await admin
    .from(table)
    .select("id")
    .eq("tenant_id", tenantId)
    .eq(column, resourceId)
    .maybeSingle();
  if (error) {
    await reportReadError(admin, tenantId, `agent-platform.ownership.${kind}.select`, error);
    return { ok: false, reason: "db_error" };
  }
  if (data) return { ok: true };

  // Sem vínculo registrado: com credencial do próprio tenant, o token remoto já
  // é a fronteira (id de outra conta simplesmente não existe para ele), então o
  // vínculo é criado sob demanda. Com token global compartilhado não há
  // fronteira remota — nega.
  if (credentials.source === "env") return { ok: false, reason: "denied" };
  if (!credentials.workspaceId) return { ok: false, reason: "denied" };

  const row = kind === "agent"
    ? {
      tenant_id: tenantId,
      platform_agent_id: resourceId,
      platform_workspace_id: credentials.workspaceId,
    }
    : {
      tenant_id: tenantId,
      platform_channel_id: resourceId,
      platform_workspace_id: credentials.workspaceId,
      channel_type: "UNKNOWN",
    };
  const { error: insertError } = await admin
    .from(table)
    .upsert(row, {
      onConflict: kind === "agent"
        ? "tenant_id,platform_agent_id"
        : "tenant_id,platform_channel_id",
    });
  if (insertError) {
    await reportReadError(admin, tenantId, `agent-platform.ownership.${kind}.upsert`, insertError);
    return { ok: false, reason: "db_error" };
  }
  return { ok: true };
}

interface AgentPayload {
  id?: unknown;
  name?: unknown;
}

interface ChannelPayload {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  agentId?: unknown;
  connected?: unknown;
}

/** Mantém os vínculos em dia a partir da resposta remota — é o "Sincronizar" do
 * produto. Best-effort: falha aqui não invalida a leitura que o usuário já viu.
 *
 * Nunca lança. Devolve a lista das operações que falharam (vazia = tudo gravado).
 * supabase-js NÃO lança em RLS negada, constraint violada ou banco fora: sem
 * destructurar `{ error }` a escrita vira no-op absoluto e o usuário vê o
 * "Sincronizar" concluir sem nada ter sido gravado. */
async function syncLinks(
  admin: SupabaseClient,
  tenantId: string,
  credentials: Credentials,
  action: string,
  params: ActionParams,
  payload: unknown,
): Promise<string[]> {
  const failed: string[] = [];
  const workspaceId = credentials.workspaceId;
  // Token global: `agents.list`/`channels.list` devolvem o workspace COMPARTILHADO
  // inteiro. Gravar vínculo a partir disso fabricaria exatamente as linhas que
  // `assertResourceOwnership` consulta para barrar (ela nega quando
  // `source === "env"` e não há vínculo) — depois do primeiro "Sincronizar" um
  // tenant passaria a editar/apagar agente de outro. Em modo env não existe
  // vínculo legítimo a registrar: não é falha, é não ter o que sincronizar.
  if (credentials.source === "env") return failed;
  if (!workspaceId) return failed;
  const now = new Date().toISOString();

  const report = async (operation: string, error: { message: string }): Promise<void> => {
    failed.push(operation);
    await captureEdgeError(admin, {
      severity: "warn",
      source: "edge",
      operation: `agent-platform.sync_links.${operation}`,
      tenantId,
      message: error.message,
      context: { action },
    });
  };

  const upsertAgents = async (agents: AgentPayload[]) => {
    const rows = agents
      .filter((a) => typeof a?.id === "string" && a.id)
      .map((a) => ({
        tenant_id: tenantId,
        platform_agent_id: a.id as string,
        platform_workspace_id: workspaceId,
        name: typeof a.name === "string" ? a.name : null,
        last_sync_at: now,
      }));
    if (rows.length === 0) return;
    const { error } = await admin
      .from("agent_platform_agent_links")
      .upsert(rows, { onConflict: "tenant_id,platform_agent_id" });
    if (error) await report("agent_links.upsert", error);
  };

  const upsertChannels = async (channels: ChannelPayload[]) => {
    const rows = channels
      .filter((c) => typeof c?.id === "string" && c.id)
      .map((c) => ({
        tenant_id: tenantId,
        platform_channel_id: c.id as string,
        platform_agent_id: typeof c.agentId === "string" ? c.agentId : null,
        platform_workspace_id: workspaceId,
        channel_type: typeof c.type === "string" ? c.type : "UNKNOWN",
        name: typeof c.name === "string" ? c.name : null,
        connected: typeof c.connected === "boolean" ? c.connected : null,
        last_sync_at: now,
      }));
    if (rows.length === 0) return;
    const { error } = await admin
      .from("agent_platform_channel_links")
      .upsert(rows, { onConflict: "tenant_id,platform_channel_id" });
    if (error) await report("channel_links.upsert", error);
  };

  if (action === "agents.list" && Array.isArray(payload)) {
    await upsertAgents(payload as AgentPayload[]);
    return failed;
  }
  if (action === "agents.create" && payload && typeof payload === "object") {
    await upsertAgents([payload as AgentPayload]);
    return failed;
  }
  if (action === "agent.delete") {
    const { error } = await admin
      .from("agent_platform_agent_links")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("platform_agent_id", String(params.agentId ?? ""));
    if (error) await report("agent_links.delete", error);
    return failed;
  }
  if (action === "agent.activate" || action === "agent.deactivate") {
    const { error } = await admin
      .from("agent_platform_agent_links")
      .update({ last_known_active: action === "agent.activate", last_sync_at: now })
      .eq("tenant_id", tenantId)
      .eq("platform_agent_id", String(params.agentId ?? ""));
    if (error) await report("agent_links.update_active", error);
    return failed;
  }
  if (action === "channels.list" && payload && typeof payload === "object") {
    const data = (payload as { data?: unknown }).data;
    if (Array.isArray(data)) await upsertChannels(data as ChannelPayload[]);
    return failed;
  }
  if (
    (action === "channels.create" || action === "channels.createForAgent" ||
      action === "channel.update") && payload && typeof payload === "object"
  ) {
    const channel = payload as ChannelPayload & { assistantId?: unknown };
    await upsertChannels([
      {
        id: channel.id ?? params.channelId,
        name: channel.name,
        type: channel.type ?? params.type,
        agentId: channel.agentId ?? channel.assistantId,
        connected: channel.connected,
      },
    ]);
    return failed;
  }
  if (action === "channel.delete") {
    const { error } = await admin
      .from("agent_platform_channel_links")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("platform_channel_id", String(params.channelId ?? ""));
    if (error) await report("channel_links.delete", error);
  }
  return failed;
}

async function audit(
  admin: SupabaseClient,
  entry: {
    tenantId: string;
    userId: string | null;
    workspaceId: string | null;
    action: string;
    resourceType: string;
    resourceId: string | null;
    status: "ok" | "denied" | "error";
    errorCode?: string | null;
    correlationId: string;
  },
): Promise<void> {
  const { error } = await admin.from("agent_platform_audit_log").insert({
    tenant_id: entry.tenantId,
    user_id: entry.userId,
    workspace_id: entry.workspaceId,
    resource_type: entry.resourceType,
    resource_id: entry.resourceId,
    action: entry.action,
    status: entry.status,
    error_code: entry.errorCode ?? null,
    correlation_id: entry.correlationId,
  });
  // Auditoria perdida não pode morrer em console: `status: "denied"` é tentativa
  // de acesso cross-tenant, e é justamente a linha que alguém vai procurar depois.
  if (error) {
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "agent-platform.audit.persist",
      tenantId: entry.tenantId,
      correlationId: entry.correlationId,
      message: error.message,
      context: { action: entry.action, status: entry.status },
    });
  }
}

/**
 * Corpos de saída passam por aqui antes de ir ao provedor.
 *
 * `callbackUrl`/`onFinishCallback` vindos do cliente são DESCARTADOS: seriam
 * URLs arbitrárias que o provedor de agentes chamaria com conteúdo do tenant (canal de
 * exfiltração via formulário). Para treinamento, o servidor injeta a própria
 * URL assinada por tenant.
 */
async function prepareBody(
  action: string,
  body: unknown,
  supabaseUrl: string,
  tenantId: string,
): Promise<unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const { callbackUrl: _ignored, onFinishCallback: _alsoIgnored, ...rest } = body as Record<
    string,
    unknown
  >;
  if (action !== "trainings.create") return rest;
  const callbackUrl = await buildTrainingCallbackUrl(
    supabaseUrl,
    Deno.env.get("AGENT_PLATFORM_TRAINING_CALLBACK_SECRET"),
    tenantId,
  );
  return callbackUrl ? { ...rest, callbackUrl } : rest;
}

function resourceOf(action: string): string {
  return action.split(".")[0];
}

/**
 * Normaliza um id vindo do cliente para a checagem de posse.
 *
 * `ActionParams` admite `number | boolean`, e `resolveAction` faz `String(raw)`
 * antes de montar o path. Um guard `typeof x === "string"` portanto NÃO é
 * narrowing defensivo: é um filtro que o chamador escolhe não passar. `agentId:
 * 123` pulava `assertResourceOwnership` inteiro e mesmo assim chegava ao
 * provedor como "123". Normaliza aqui no mesmo formato que o resolver usa.
 *
 * - `""`  → id ausente, não há o que checar
 * - `null` → objeto/array, que não é id: o caller recusa o pedido
 */
function ownershipId(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "object") return null;
  return String(value);
}

function resourceIdOf(params: ActionParams): string | null {
  const candidate = params.channelId ?? params.agentId ?? params.mcpId ?? params.customfieldId;
  return candidate === undefined || candidate === null ? null : String(candidate);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const correlationId = crypto.randomUUID();
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;

  const userClient = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr && !isInvalidSessionError(userErr)) {
    // Instabilidade do GoTrue (5xx, AuthRetryableFetchError) não é sessão
    // inválida. Devolver "Não autenticado." aqui mente e é TERMINAL — o cliente
    // não repete. Mesma separação que `loadProfileOrFail` já faz 10 linhas
    // abaixo; faltava só neste ponto.
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "agent-platform.proxy.auth",
      correlationId,
      errorCode: typeof userErr.status === "number" ? String(userErr.status) : null,
      message: userErr.message,
    });
    return errorEnvelope("REMOTE_SERVER_ERROR", correlationId, PROFILE_DB_ERROR_MESSAGE);
  }
  if (userErr || !userData.user) {
    return errorEnvelope("AUTHENTICATION_FAILED", correlationId, "Não autenticado.");
  }
  const userId = userData.user.id;

  const profile = await loadProfileOrFail(admin, userId, {
    operation: "agent-platform.proxy.load_profile",
    requireAdmin: true,
  });
  if (!profile.ok) {
    if (profile.reason === "db_error") {
      return errorEnvelope("REMOTE_SERVER_ERROR", correlationId, PROFILE_DB_ERROR_MESSAGE);
    }
    if (profile.reason === "not_admin") {
      return errorEnvelope("FORBIDDEN", correlationId, "Apenas administradores.");
    }
    return errorEnvelope("FORBIDDEN", correlationId, "Perfil ou vínculo não encontrado.");
  }
  const tenantId = profile.tenantId;

  let parsed: ProxyBody;
  try {
    parsed = (await req.json()) as ProxyBody;
  } catch {
    return errorEnvelope("VALIDATION_ERROR", correlationId, "Corpo inválido.");
  }

  const actionName = parsed.action ?? "";
  const spec: ActionSpec | undefined = Object.hasOwn(AGENT_PLATFORM_ACTIONS, actionName)
    ? AGENT_PLATFORM_ACTIONS[actionName]
    : undefined;
  if (!spec) {
    return errorEnvelope(
      "UNSUPPORTED_BY_PUBLIC_API",
      correlationId,
      "Operação não suportada pela API pública do provedor de agentes.",
    );
  }
  const params: ActionParams = parsed.params ?? {};

  const credentialsResult = await loadCredentials(admin, tenantId);
  if (!credentialsResult.ok) {
    if (credentialsResult.reason === "db_error") {
      return errorEnvelope("REMOTE_SERVER_ERROR", correlationId, PROFILE_DB_ERROR_MESSAGE);
    }
    return errorEnvelope(
      "AUTHENTICATION_FAILED",
      correlationId,
      "Conecte o provedor de agentes em Configurações > Integrações antes de usar esta área.",
    );
  }
  const credentials = credentialsResult.credentials;

  // Rota com `scopeGap`: o id que `assertResourceOwnership` valida não chega ao
  // provedor (ver ActionSpec.scopeGap). Com credencial do próprio tenant o token
  // remoto continua sendo a fronteira e a ação segue normal; com o token global
  // de fallback não sobra fronteira nenhuma — nega ANTES do trust-on-first-use
  // da checagem de posse, senão o vínculo é criado para um pedido já recusado.
  if (spec.scopeGap && credentials.source === "env") {
    await audit(admin, {
      tenantId,
      userId,
      workspaceId: credentials.workspaceId,
      action: actionName,
      resourceType: resourceOf(actionName),
      resourceId: resourceIdOf(params),
      status: "denied",
      errorCode: "FORBIDDEN",
      correlationId,
    });
    return errorEnvelope(
      "FORBIDDEN",
      correlationId,
      "Esta operação exige o token do provedor configurado para a sua conta. " +
        "Conecte-o em Configurações > Integrações.",
    );
  }

  // Posse: além do escopo declarado, qualquer agentId/channelId presente nos
  // params é verificado (ex.: filtro `agentId` em channels.list, `agentId` do
  // corpo de channel.update tratado abaixo).
  const bodyAgentId = spec.hasBody && parsed.body && typeof parsed.body === "object"
    ? (parsed.body as { agentId?: unknown }).agentId
    : undefined;
  const ownershipChecks: Array<{ kind: "agent" | "channel"; id: string }> = [];
  for (
    const [kind, raw] of [
      ["agent", params.agentId],
      ["channel", params.channelId],
      ["agent", bodyAgentId],
    ] as const
  ) {
    const id = ownershipId(raw);
    if (id === null) {
      return errorEnvelope("VALIDATION_ERROR", correlationId, "Identificador inválido.");
    }
    if (id) ownershipChecks.push({ kind, id });
  }
  for (const check of ownershipChecks) {
    const result = await assertResourceOwnership(
      admin,
      tenantId,
      credentials,
      check.kind,
      check.id,
    );
    if (!result.ok) {
      if (result.reason === "db_error") {
        return errorEnvelope("REMOTE_SERVER_ERROR", correlationId, PROFILE_DB_ERROR_MESSAGE);
      }
      await audit(admin, {
        tenantId,
        userId,
        workspaceId: credentials.workspaceId,
        action: actionName,
        resourceType: check.kind,
        resourceId: check.id,
        status: "denied",
        errorCode: "FORBIDDEN",
        correlationId,
      });
      return errorEnvelope(
        "FORBIDDEN",
        correlationId,
        "Este recurso não pertence ao workspace configurado para a sua conta.",
      );
    }
  }

  let resolved: { path: string; query: Record<string, unknown> };
  try {
    resolved = resolveAction(spec, params, credentials.workspaceId);
  } catch (e) {
    if (e instanceof ActionResolveError) {
      return errorEnvelope("VALIDATION_ERROR", correlationId, e.message);
    }
    throw e;
  }

  const client = createAgentPlatformClient({
    baseUrl: Deno.env.get("AGENT_PLATFORM_API_BASE_URL"),
    token: credentials.token,
    onLog: (entry) =>
      console.log(JSON.stringify({ fn: "agent-platform-proxy", action: actionName, ...entry })),
  });

  const requestBody = spec.hasBody
    ? await prepareBody(actionName, parsed.body, SUPABASE_URL, tenantId)
    : undefined;

  try {
    const payload = await client.request<unknown>({
      method: spec.method,
      path: resolved.path,
      query: resolved.query as Record<string, string | number | boolean | null | undefined>,
      body: requestBody,
      retryable: spec.retryable === true,
      correlationId,
    });

    // syncLinks não lança (devolve a lista de falhas). O catch fica como rede de
    // segurança para um throw inesperado — do client, não das escritas.
    let syncFailures: string[] = [];
    try {
      syncFailures = await syncLinks(
        admin,
        tenantId,
        credentials,
        actionName,
        params,
        payload,
      );
    } catch (syncError) {
      syncFailures = ["unexpected"];
      await captureEdgeError(admin, {
        severity: "error",
        source: "edge",
        operation: `agent-platform.sync_links.${actionName}`,
        tenantId,
        correlationId,
        message: syncError instanceof Error ? syncError.message : String(syncError),
        stack: syncError instanceof Error ? syncError.stack ?? null : null,
        context: { action: actionName },
      });
    }

    await audit(admin, {
      tenantId,
      userId,
      workspaceId: credentials.workspaceId,
      action: actionName,
      resourceType: resourceOf(actionName),
      resourceId: resourceIdOf(params),
      status: "ok",
      correlationId,
    });

    // `data` mantém o formato (o frontend lê `data.data`); `syncWarning` é irmão.
    return json(200, {
      data: payload,
      ...(syncFailures.length > 0
        ? {
          syncWarning:
            "Dados carregados, mas os vínculos locais não foram atualizados. Tente sincronizar de novo.",
        }
        : {}),
    });
  } catch (e) {
    const code: AgentPlatformErrorCode = e instanceof AgentPlatformError ? e.code : "UNKNOWN";
    const detail = e instanceof AgentPlatformError
      ? e.detail
      : e instanceof Error
      ? e.message
      : String(e);
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: `agent-platform.proxy.${actionName}`,
      tenantId,
      correlationId,
      errorCode: code,
      message: detail ?? code,
      context: {
        action: actionName,
        path: resolved.path,
        http_status: e instanceof AgentPlatformError ? e.httpStatus : null,
        credential_source: credentials.source,
      },
    });
    await audit(admin, {
      tenantId,
      userId,
      workspaceId: credentials.workspaceId,
      action: actionName,
      resourceType: resourceOf(actionName),
      resourceId: resourceIdOf(params),
      status: "error",
      errorCode: code,
      correlationId,
    });
    return errorEnvelope(code, correlationId);
  }
});
