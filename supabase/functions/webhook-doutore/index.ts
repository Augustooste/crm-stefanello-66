// Endpoint PÚBLICO (sem autenticação de usuário) que recebe leads capturados
// no Doutore (PRD Fase 6, Sub-feature 3) e os grava como `contacts` no CRM.
// É puro parsing de payload + validação + upsert de contato — zero lógica
// clínica; os campos específicos do Doutore (genero, data_interesse, etc.)
// viram `contacts.custom_fields`, nunca colunas novas.
//
// Autenticação: mesmo mecanismo já usado por qualquer outro provider deste
// repo para o caminho "legado slug+tenant" (ver
// `messaging-webhook/index.ts`, ramo `else` da resolução de tenant, e
// `mintWebhookToken()`/fluxo de connect em `integration-connect/index.ts`) —
// `tenant_integrations.webhook_token`, minerado automaticamente pelo
// `integration-connect` no momento em que o admin clica "Conectar" (sem
// segredo nenhum para digitar, já que `required_secrets` do catálogo
// 'doutore' é `[]`). Token vem via query param `?token=`, igual à convenção
// de `buildWebhookUrl` em `IntegrationCard.tsx`. Comparação é feita como
// `.eq()` no banco — mesmo padrão aceito no restante do repo para este
// mecanismo (o token não é um segredo super-sensível: só permite *criar*
// contato, nunca ler dados).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { checkRateLimit } from "../_shared/ai/rate-limiter.ts";
import { normalizePhone } from "../_shared/messaging/conversation.ts";
import { loadProviderSecrets } from "../_shared/messaging/provider-send.ts";
import { captureEdgeError } from "../_shared/telemetry.ts";
import { timingSafeEqualStrings } from "../_shared/timing-safe-equal.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-doutore-webhook-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GENERIC_ERROR = "Não foi possível registrar o lead agora. Tente novamente em instantes.";
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_REQUESTS_PER_MINUTE = 60;

// Campos "de primeira classe" do payload Doutore — tudo o mais (genero,
// data_interesse, convenio, etc.) é genérico e vai para custom_fields.
const KNOWN_PAYLOAD_KEYS = new Set(["nome", "telefone", "email"]);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

function normalizeStr(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function extractSourceIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  const parts =
    forwarded
      ?.split(",")
      .map((part) => part.trim())
      .filter(Boolean) ?? [];
  return parts[parts.length - 1] ?? "unknown";
}

interface ParsedLead {
  nome: string;
  telefone: string;
  email?: string;
  customFields: Record<string, unknown>;
}

/** Valida `nome`/`telefone` (obrigatórios) e genericiza o resto do payload em
 * customFields. Retorna a lista de campos faltando quando a validação falha —
 * o chamador decide o formato da mensagem 400. */
function parseLeadPayload(raw: unknown): { lead: ParsedLead } | { missing: string[] } {
  const obj =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const nome = normalizeStr(obj.nome);
  const telefone = normalizePhone(normalizeStr(obj.telefone));
  const missing: string[] = [];
  if (!nome) missing.push("nome");
  if (!telefone) missing.push("telefone");
  if (missing.length > 0) return { missing };

  const email = normalizeStr(obj.email)?.toLowerCase();
  const customFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (KNOWN_PAYLOAD_KEYS.has(key)) continue;
    customFields[key] = value;
  }

  return { lead: { nome: nome!, telefone: telefone!, email, customFields } };
}

interface ContactRow {
  id: string;
  name: string;
  custom_fields: Record<string, unknown> | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1. Autenticação via tenant_integrations.webhook_token (query param) —
  // precisa vir antes de tudo, inclusive do parse do corpo, para não gastar
  // trabalho em requisições não autenticadas. Exige status 'active': um
  // token preservado de uma integração desconectada não deve continuar
  // aceitando leads.
  const url = new URL(req.url);
  const providedToken = normalizeStr(url.searchParams.get("token"));
  if (!providedToken) return json(401, { error: "Token de webhook ausente." });

  const { data: ti, error: tiErr } = await admin
    .from("tenant_integrations")
    .select("tenant_id, status")
    .eq("slug", "doutore")
    .eq("webhook_token", providedToken)
    .maybeSingle<{ tenant_id: string; status: string }>();
  if (tiErr) {
    console.error("webhook-doutore: falha ao resolver tenant pelo webhook_token", tiErr);
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "webhook.doutore.resolve_tenant",
      tenantId: null,
      errorCode: tiErr.code ?? null,
      message: tiErr.message,
      context: {},
    });
    return json(500, { error: GENERIC_ERROR });
  }
  if (!ti || ti.status !== "active") return json(401, { error: "Token de webhook inválido." });
  const tenantId = ti.tenant_id;

  let expectedSecret: string | undefined;
  try {
    const secrets = await loadProviderSecrets(admin, tenantId, "doutore");
    expectedSecret = secrets.webhook_secret;
  } catch (error) {
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "webhook.doutore.load_secret",
      tenantId,
      message: error instanceof Error ? error.message : String(error),
      context: {},
    });
    return json(503, { error: GENERIC_ERROR });
  }
  const providedSecret = req.headers.get("x-doutore-webhook-secret") ?? "";
  if (
    !expectedSecret ||
    !providedSecret ||
    !timingSafeEqualStrings(providedSecret, expectedSecret)
  ) {
    return json(401, { error: "Assinatura do webhook inválida." });
  }

  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return json(413, { error: "Payload excede o limite permitido." });
  }

  const rateLimit = await checkRateLimit(
    admin,
    `webhook-doutore:${tenantId}:${extractSourceIp(req)}`,
    MAX_REQUESTS_PER_MINUTE,
    60_000,
  );
  if (rateLimit.rpcFailed) return json(503, { error: GENERIC_ERROR });
  if (!rateLimit.allowed) {
    return json(429, { error: "Muitas requisições. Tente novamente em um minuto." });
  }

  // 2. Corpo: nome/telefone obrigatórios, resto genericizado em custom_fields.
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    // Payload de terceiro malformado, não é incidente nosso — mas repetição
    // sinaliza integração quebrada do lado do Doutore (ex.: mudança de
    // content-type). severity "warn": não é falha nossa.
    await captureEdgeError(admin, {
      severity: "warn",
      source: "edge",
      operation: "webhook.doutore.invalid_json",
      tenantId,
      message: "Corpo da requisição não é JSON válido.",
      context: {},
    });
    return json(400, { error: "Corpo inválido." });
  }
  const parsed = parseLeadPayload(rawBody);
  if ("missing" in parsed) {
    await captureEdgeError(admin, {
      severity: "warn",
      source: "edge",
      operation: "webhook.doutore.missing_fields",
      tenantId,
      message: `Campo(s) obrigatório(s) faltando: ${parsed.missing.join(", ")}`,
      context: { missing_fields: parsed.missing },
    });
    return json(400, { error: `Campo(s) obrigatório(s) faltando: ${parsed.missing.join(", ")}` });
  }
  const { nome, telefone, email, customFields } = parsed.lead;

  // 3. Dedupe por (tenant_id, phone) — igual ao padrão de lead-form-submit:
  // .is("deleted_at", null).is("merged_into_id", null) ignora contatos
  // soft-deletados/mesclados (senão um lead novo "ressuscitaria" um contato
  // morto). .order + .limit(1) antes de .maybeSingle() é obrigatório porque o
  // índice de dedupe não é unique; sem o limit, 2+ linhas fariam
  // maybeSingle() devolver erro e cairíamos indevidamente no ramo de criação.
  const { data: existing, error: findErr } = await admin
    .from("contacts")
    .select("id, name, custom_fields")
    .eq("tenant_id", tenantId)
    .eq("phone", telefone)
    .is("deleted_at", null)
    .is("merged_into_id", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle<ContactRow>();
  if (findErr) {
    console.error("webhook-doutore: falha ao buscar contato por telefone", tenantId, findErr);
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "webhook.doutore.find_contact",
      tenantId,
      errorCode: findErr.code ?? null,
      message: findErr.message,
      context: {},
    });
    return json(500, { error: GENERIC_ERROR });
  }

  if (existing) {
    // Contrato do header: token só permite CRIAR contato, nunca sobrescrever
    // dados existentes. No update de um contato já cadastrado, só preenche
    // name/email quando ainda estão vazios, e mescla apenas as chaves de
    // custom_fields AUSENTES (não sobrescreve as já preenchidas).
    const existingCustom = (existing.custom_fields ?? {}) as Record<string, unknown>;
    const mergedCustomFields: Record<string, unknown> = { ...existingCustom };
    for (const [key, value] of Object.entries(customFields)) {
      if (!(key in existingCustom)) mergedCustomFields[key] = value;
    }
    const updatePayload: Record<string, unknown> = { custom_fields: mergedCustomFields };
    if (!existing.name || existing.name.trim() === "") updatePayload.name = nome;
    // email só é gravado quando o contato ainda não tem um. Não temos o
    // valor atual de email carregado no select acima, então fazemos update
    // condicional no filtro (email is null) para não sobrescrever de forma
    // atômica.
    const { error: updateErr } = await admin
      .from("contacts")
      .update(updatePayload)
      .eq("id", existing.id);
    if (updateErr) {
      console.error("webhook-doutore: falha ao atualizar contato", existing.id, updateErr);
      await captureEdgeError(admin, {
        severity: "error",
        source: "edge",
        operation: "webhook.doutore.update_contact",
        tenantId,
        errorCode: updateErr.code ?? null,
        message: updateErr.message,
        context: { contact_id: existing.id },
      });
      return json(500, { error: GENERIC_ERROR });
    }
    if (email) {
      // Resultado descartado no fluxo original — a resposta ao cliente não
      // depende dele. Passa a capturar o erro (sem mudar o que é retornado)
      // porque, sem isso, um e-mail que deveria ter sido gravado some sem
      // deixar rastro nenhum.
      const { error: emailUpdateErr } = await admin
        .from("contacts")
        .update({ email })
        .eq("id", existing.id)
        .is("email", null);
      if (emailUpdateErr) {
        await captureEdgeError(admin, {
          severity: "error",
          source: "edge",
          operation: "webhook.doutore.update_email",
          tenantId,
          errorCode: emailUpdateErr.code ?? null,
          message: emailUpdateErr.message,
          context: { contact_id: existing.id },
        });
      }
    }
    return json(200, { ok: true, contact_id: existing.id, created: false });
  }

  const { data: created, error: createErr } = await admin
    .from("contacts")
    .insert({
      tenant_id: tenantId,
      name: nome,
      phone: telefone,
      email: email ?? null,
      source: "doutore",
      tags: [],
      custom_fields: customFields,
    })
    .select("id")
    .single<{ id: string }>();
  if (createErr || !created) {
    console.error("webhook-doutore: falha ao criar contato", tenantId, createErr);
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "webhook.doutore.create_contact",
      tenantId,
      errorCode: createErr?.code ?? null,
      message: createErr?.message ?? "insert de contato sem retorno de id",
      context: {},
    });
    return json(500, { error: GENERIC_ERROR });
  }

  return json(200, { ok: true, contact_id: created.id, created: true });
});
