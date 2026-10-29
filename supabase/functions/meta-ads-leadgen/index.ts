// meta-ads-leadgen — webhook de leadgen do Meta Ads (Fase 6, sub-feature 5).
// URL: /functions/v1/meta-ads-leadgen?token=<tenant_integrations.webhook_token>
//
// Escopo DELIBERADAMENTE fino (ver banner de
// supabase/migrations/20260712120200_fase6_meta_ads_verdicts.sql): isto NÃO
// é o motor de analytics/BI `ai-verdicts`/`meta_ads` do medflow-v0. Aqui é
// só: (1) receber o ping de leadgen, (2) buscar as respostas do lead no
// Graph API com o token de sistema colado manualmente (sem OAuth — mesmo
// padrão de `meta-cloud`), (3) criar o contato com atribuição de
// campanha/anúncio, (4) gerar 1 selo hot/warm/cold via 1 chamada de IA
// best-effort. Sem fila de background (EdgeRuntime.waitUntil) — escopo de
// 1 tenant por remix, volume baixo o bastante pra responder inline sem
// atrasar o ack ao Meta de forma perceptível.
//
// Autenticação:
// - GET (handshake de verificação do Meta): hub.verify_token comparado em
//   tempo constante contra o token da própria URL (?token=...), que já
//   resolveu o tenant acima. Mesmo `token` cadastrado pelo admin tanto na
//   Callback URL quanto no campo "Verify Token" do App do Meta.
// - POST (evento de leadgen): x-hub-signature-256 (HMAC-SHA256 do corpo cru
//   com app_secret) — mesmo algoritmo de messaging-webhook/index.ts
//   (verifyMetaSignature, linhas 932-955), duplicado aqui porque este
//   arquivo é Deno.serve top-level isolado, não um módulo compartilhado.
//
// Nunca 500 pro Meta: erro de processamento de um evento é logado e
// pulado, sempre respondendo 200 — do contrário o Meta reentrega o mesmo
// ping indefinidamente.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { callLovableGateway, stripJsonFence } from "../_shared/ai/gateway.ts";
import { redactSecrets } from "../_shared/redact-secrets.ts";
import { timingSafeEqualStrings } from "../_shared/timing-safe-equal.ts";
import { captureEdgeError } from "../_shared/telemetry.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-hub-signature-256",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const GRAPH_API_VERSION = "v23.0";
// Graph API responde rápido; o timeout aqui só evita pendurar o isolate.
const GRAPH_TIMEOUT_MS = 15_000;
const AI_MODEL = "google/gemini-3-flash-preview";
const VERDICT_MAX_OUTPUT_TOKENS = 300;
const FALLBACK_CONTACT_NAME = "Lead sem nome";
const MAX_FIELD_ANSWERS_IN_PROMPT = 8;

const VERDICT_SYSTEM_PROMPT =
  'Você é um classificador de leads de anúncios (Meta Ads) para um CRM. ' +
  'Dado um pequeno resumo do anúncio de origem e as respostas do formulário ' +
  'do lead, classifique o lead como "hot", "warm" ou "cold" e explique ' +
  "brevemente o porquê em português. Responda APENAS em JSON puro, sem " +
  'markdown, no formato exato: {"verdict":"hot"|"warm"|"cold","rationale":"..."}';

// ------- Tipos do payload de webhook do Meta (leadgen) -------

interface MetaLeadgenChangeValue {
  leadgen_id?: string;
  page_id?: string;
  form_id?: string;
  ad_id?: string;
  campaign_id?: string;
}

interface MetaLeadgenPayload {
  entry?: Array<{ changes?: Array<{ field?: string; value?: MetaLeadgenChangeValue }> }>;
}

interface MetaFieldDatum {
  name?: string;
  values?: string[];
}

interface MetaLeadDetails {
  field_data?: MetaFieldDatum[];
}

interface VerdictPayload {
  verdict: "hot" | "warm" | "cold";
  rationale: string;
}

function safeJsonPayload(raw: string): MetaLeadgenPayload | null {
  try {
    return JSON.parse(raw) as MetaLeadgenPayload;
  } catch {
    return null;
  }
}

/** Achata entry[].changes[].value pra lista de eventos de leadgen — ignora
 * qualquer change sem leadgen_id (outros tipos de campo que o Meta manda
 * na mesma assinatura de webhook, ex.: mudanças de página). */
function extractLeadgenValues(payload: MetaLeadgenPayload | null): MetaLeadgenChangeValue[] {
  if (!payload?.entry || !Array.isArray(payload.entry)) return [];
  const out: MetaLeadgenChangeValue[] = [];
  for (const entry of payload.entry) {
    for (const change of entry?.changes ?? []) {
      if (change?.value?.leadgen_id) out.push(change.value);
    }
  }
  return out;
}

// ------- Meta Cloud webhook signature (HMAC-SHA256 hex do corpo cru com app_secret). -------
// Réplica byte-a-byte de verifyMetaSignature em messaging-webhook/index.ts:932-955.
async function verifyMetaSignature(
  appSecret: string,
  body: string,
  signatureHeader: string,
): Promise<boolean> {
  const prefix = "sha256=";
  if (!signatureHeader.startsWith(prefix)) return false;
  const provided = signatureHeader.slice(prefix.length).trim().toLowerCase();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}

// timingSafeEqualStrings foi movido para _shared/timing-safe-equal.ts —
// mesmo helper agora usado por messaging-webhook em TODAS as comparações de
// segredo/assinatura (verifyTwilioSignature, verifySvix, Evolution instance
// token, handshake Meta GET, Client-Token do Z-API).

// ------- Graph API: busca as respostas do formulário (field_data) -------
// O ping de webhook do Meta NUNCA traz as respostas em si, só os IDs — é
// preciso um GET /{leadgen_id} separado com o token de sistema do tenant.
async function fetchLeadFieldData(leadgenId: string, accessToken: string): Promise<MetaFieldDatum[]> {
  if (!accessToken) return [];
  // access_token vai no header Authorization (Bearer) em vez da query string,
  // pra não vazar o token na URL quando um erro de rede coloca a URL completa
  // em Error.message (que depois é logado e/ou gravado em ai_failure_logs).
  const url =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(leadgenId)}` +
    `?fields=field_data`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Graph API respondeu HTTP ${res.status}`);
  const data = (await res.json()) as MetaLeadDetails;
  return Array.isArray(data.field_data) ? data.field_data : [];
}

function firstFieldValue(fields: MetaFieldDatum[], pattern: RegExp): string | undefined {
  const match = fields.find((f) => typeof f.name === "string" && pattern.test(f.name));
  const value = match?.values?.[0];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Extrai nome/telefone/e-mail dos field_data do Graph API por heurística
 * de nome de campo (formulários do Meta não têm um schema fixo de chaves).
 * Sem match de nome -> fallback pra telefone, depois e-mail, depois
 * FALLBACK_CONTACT_NAME (mesmo fallback de lead-form-submit/index.ts). */
function extractContactInfo(fields: MetaFieldDatum[]): { name: string; phone?: string; email?: string } {
  const email = firstFieldValue(fields, /email/i);
  const phone = firstFieldValue(fields, /phone/i);
  const fullName = firstFieldValue(fields, /^full[_ ]?name$/i);
  const firstName = firstFieldValue(fields, /^first[_ ]?name$/i);
  const lastName = firstFieldValue(fields, /^last[_ ]?name$/i);
  const combinedName = [firstName, lastName].filter(Boolean).join(" ").trim();
  const name = fullName || (combinedName.length > 0 ? combinedName : undefined) || phone || email || FALLBACK_CONTACT_NAME;
  return { name, phone, email };
}

// ------- Verdict de IA (hot/warm/cold), best-effort -------

function parseVerdictPayload(raw: string): VerdictPayload | null {
  const cleaned = stripJsonFence(raw);
  if (!cleaned) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const verdict = obj.verdict;
  if (verdict !== "hot" && verdict !== "warm" && verdict !== "cold") return null;
  const rationale = typeof obj.rationale === "string" ? obj.rationale.trim() : "";
  return { verdict, rationale };
}

function buildVerdictPrompt(fields: MetaFieldDatum[], value: MetaLeadgenChangeValue): string {
  const lines = fields
    .slice(0, MAX_FIELD_ANSWERS_IN_PROMPT)
    .map((f) => `${f.name ?? "campo"}: ${(f.values ?? []).join(", ")}`);
  return [
    `Campanha (id): ${value.campaign_id ?? "desconhecida"}`,
    `Anúncio (id): ${value.ad_id ?? "desconhecido"}`,
    "Respostas do formulário:",
    ...(lines.length > 0 ? lines : ["(nenhuma resposta disponível)"]),
  ].join("\n");
}

async function generateLeadVerdict(
  fields: MetaFieldDatum[],
  value: MetaLeadgenChangeValue,
): Promise<VerdictPayload | null> {
  const userPrompt = buildVerdictPrompt(fields, value);
  const raw = await callLovableGateway(
    VERDICT_SYSTEM_PROMPT,
    [{ role: "user", content: userPrompt }],
    AI_MODEL,
    { maxOutputTokens: VERDICT_MAX_OUTPUT_TOKENS },
  );
  return parseVerdictPayload(raw);
}

// ------- Contato: dedupe por meta_lead_id + criação -------

/** Dedupe por leadgen_id (mesma ideia de lead_mappings.meta_lead_id do
 * medflow, sem tabela de mapeamento dedicada aqui): custom_fields->>'meta_lead_id'
 * já visto para este tenant -> evento já processado, não recria. */
async function findContactByLeadId(
  admin: SupabaseClient,
  tenantId: string,
  leadgenId: string,
): Promise<{ id: string } | null> {
  const { data, error } = await admin
    .from("contacts")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("custom_fields->>meta_lead_id", leadgenId)
    .is("deleted_at", null)
    .is("merged_into_id", null)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as { id: string } | null;
}

async function createContactFromLead(
  admin: SupabaseClient,
  tenantId: string,
  info: { name: string; phone?: string; email?: string },
  value: MetaLeadgenChangeValue,
): Promise<{ id: string; created: boolean }> {
  const customFields: Record<string, string> = { meta_lead_id: value.leadgen_id ?? "" };
  if (value.campaign_id) customFields.campaign_id = value.campaign_id;
  if (value.ad_id) customFields.ad_id = value.ad_id;
  if (value.form_id) customFields.form_id = value.form_id;

  const { data, error } = await admin
    .from("contacts")
    .insert({
      tenant_id: tenantId,
      name: info.name,
      phone: info.phone ?? null,
      email: info.email ?? null,
      source: "meta-ads",
      custom_fields: customFields,
    })
    .select("id")
    .single();
  if (!error && data) return { id: data.id as string, created: true };

  // 23505 = unique_violation. O índice único parcial em
  // (tenant_id, custom_fields->>'meta_lead_id') fecha a corrida entre dois
  // retries do Meta que passaram no check-then-insert ao mesmo tempo — não é
  // erro, é a confirmação de que outro processo já criou. Mesmo padrão de
  // claim_messaging_webhook_event (idempotência via unique constraint).
  if ((error as { code?: string } | null)?.code === "23505") {
    const existing = await findContactByLeadId(admin, tenantId, value.leadgen_id ?? "");
    if (existing) return { id: existing.id, created: false };
  }
  throw error ?? new Error("insert de contato sem retorno de id");
}

/**
 * Processa 1 evento de leadgen: dedupe -> busca field_data no Graph API
 * (best-effort — falha aqui não impede a criação do contato, só o deixa
 * sem nome/telefone/e-mail) -> cria o contato (MANDATÓRIO) -> gera o
 * verdict de IA (best-effort — falha aqui nunca desfaz o contato já criado).
 */
async function processLeadgenEvent(
  admin: SupabaseClient,
  tenantId: string,
  accessToken: string,
  value: MetaLeadgenChangeValue,
): Promise<void> {
  const leadgenId = value.leadgen_id;
  if (!leadgenId) return;

  const existing = await findContactByLeadId(admin, tenantId, leadgenId);
  if (existing) return; // já processado -- idempotência de retry do Meta

  let fieldData: MetaFieldDatum[] = [];
  try {
    fieldData = await fetchLeadFieldData(leadgenId, accessToken);
  } catch (e) {
    console.error("meta-ads-leadgen: falha ao buscar field_data no Graph API", {
      tenant: tenantId,
      leadgenId,
      err: redactSecrets(e instanceof Error ? e.message : String(e)),
    });
    // Best-effort por design (contato ainda é criado, só sem nome/telefone/
    // e-mail) — mas para um lead de anúncio pago isso é degradação séria, e
    // repetir sinaliza access_token expirado/revogado. leadgenId é o handle
    // de recuperação: com ele dá pra puxar o lead de volta manualmente no
    // Meta. severity "warn": não impede o contato de ser criado.
    await captureEdgeError(admin, {
      severity: "warn",
      source: "edge",
      operation: "meta.ads_leadgen.fetch_field_data",
      tenantId,
      message: e instanceof Error ? redactSecrets(e.message) : String(e),
      // stack também passa por redactSecrets: a URL do Graph API (que pode
      // carregar o access_token em versões antigas de erro) pode aparecer
      // num frame do stack, igual à message.
      stack: e instanceof Error && e.stack ? redactSecrets(e.stack) : null,
      context: { leadgen_id: leadgenId },
    });
  }

  const info = extractContactInfo(fieldData);
  const { id: contactId, created } = await createContactFromLead(admin, tenantId, info, value);
  // Se perdemos a corrida (23505 → outro retry do Meta chegou primeiro),
  // apenas confirma idempotência sem gerar verdict duplicado.
  if (!created) return;

  let verdictPayload: VerdictPayload | null = null;
  try {
    verdictPayload = await generateLeadVerdict(fieldData, value);
  } catch (e) {
    console.error("meta-ads-leadgen: falha ao gerar verdict de IA (best-effort, contato já criado)", {
      tenant: tenantId,
      contactId,
      err: redactSecrets(e instanceof Error ? e.message : String(e)),
    });
  }

  if (verdictPayload) {
    const { error: verdictErr } = await admin.from("ai_lead_verdicts").upsert(
      {
        tenant_id: tenantId,
        contact_id: contactId,
        source: "meta-ads",
        verdict: verdictPayload.verdict,
        rationale: verdictPayload.rationale || null,
        model: AI_MODEL,
      },
      { onConflict: "contact_id" },
    );
    if (verdictErr) {
      console.error("meta-ads-leadgen: falha ao gravar verdict", {
        tenant: tenantId,
        contactId,
        verdictErr,
      });
      await captureEdgeError(admin, {
        severity: "error",
        source: "edge",
        operation: "meta.ads_leadgen.persist_verdict",
        tenantId,
        errorCode: verdictErr.code ?? null,
        message: verdictErr.message,
        context: { contact_id: contactId },
      });
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  if (!token) return new Response("Unauthorized", { status: 401 });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: ti, error: tiErr } = await admin
    .from("tenant_integrations")
    .select("tenant_id, status")
    .eq("slug", "meta-ads")
    .eq("webhook_token", token)
    .maybeSingle();
  // Sem isso, um erro de query aqui vira 401 igual a um token inválido — a
  // resposta ao Meta não muda (fail-closed continua correto), mas a causa
  // real (banco fora) ficava impossível de distinguir de um token errado.
  if (tiErr) {
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "meta.ads_leadgen.resolve_tenant",
      tenantId: null,
      errorCode: tiErr.code ?? null,
      message: tiErr.message,
      context: {},
    });
  }
  if (!ti || ti.status !== "active") return new Response("Unauthorized", { status: 401 });
  const tenantId = ti.tenant_id as string;

  // Handshake de verificação do Meta (GET com hub.challenge). O token da
  // URL já autenticou o tenant acima; comparação em tempo constante contra
  // hub.verify_token (pedido explícito desta sub-feature, diferente do
  // `!==` simples usado em messaging-webhook para o mesmo handshake).
  if (req.method === "GET") {
    if (url.searchParams.get("hub.mode") !== "subscribe") {
      return new Response("Bad Request", { status: 400 });
    }
    const verifyToken = url.searchParams.get("hub.verify_token") ?? "";
    if (!timingSafeEqualStrings(verifyToken, token)) {
      return new Response("Forbidden", { status: 403 });
    }
    return new Response(url.searchParams.get("hub.challenge") ?? "", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }

  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const rawBody = await req.text().catch(() => "");

  const { data: secrets, error: secretsErr } = await admin
    .from("integration_secrets")
    .select("key, value")
    .eq("tenant_id", tenantId)
    .eq("slug", "meta-ads");
  // Mesmo raciocínio do resolve_tenant acima: erro de query aqui hoje vira
  // "Forbidden" (cred fica vazio -> falta app_secret), indistinguível de
  // integração nunca conectada. Resposta não muda, só passa a ficar visível.
  if (secretsErr) {
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "meta.ads_leadgen.fetch_secrets",
      tenantId,
      errorCode: secretsErr.code ?? null,
      message: secretsErr.message,
      context: {},
    });
  }
  const cred: Record<string, string> = {};
  for (const r of secrets ?? []) cred[r.key as string] = r.value as string;

  // Assinatura obrigatória (fail-closed): sem app_secret cadastrado ou sem
  // x-hub-signature-256 válido, o evento é rejeitado. Impede que um POST
  // forjado crie contatos/verdicts em nome do tenant.
  const appSecret = cred.app_secret ?? "";
  const sig = req.headers.get("x-hub-signature-256") ?? "";
  if (!appSecret || !sig) return new Response("Forbidden", { status: 403 });
  const validSig = await verifyMetaSignature(appSecret, rawBody, sig);
  if (!validSig) return new Response("Forbidden", { status: 403 });

  const payload = safeJsonPayload(rawBody);
  if (payload === null) {
    // Corpo passou na verificação de assinatura mas não é JSON válido —
    // não é incidente nosso (payload de terceiro), mas repetir com
    // assinatura válida é estranho o bastante para merecer visibilidade.
    await captureEdgeError(admin, {
      severity: "warn",
      source: "edge",
      operation: "meta.ads_leadgen.invalid_payload",
      tenantId,
      message: "Corpo do webhook não é JSON válido.",
      context: { raw_body_length: rawBody.length },
    });
  }
  const leadgenValues = extractLeadgenValues(payload);

  for (const value of leadgenValues) {
    try {
      await processLeadgenEvent(admin, tenantId, cred.access_token ?? "", value);
    } catch (e) {
      // Nunca 500 pro Meta: um evento com erro é logado e pulado -- do
      // contrário o Meta reentrega o mesmo ping indefinidamente. É exatamente
      // por isso que este catch precisa de telemetria: a resposta 200 diz
      // "entregue" pro Meta, que nunca vai reenviar este ping — sem o evento
      // aqui, o lead perdido (ex.: createContactFromLead falhou, o passo
      // MANDATÓRIO) não deixa nenhum rastro consultável. leadgenId é o
      // handle de recuperação manual do lead no Meta.
      console.error("meta-ads-leadgen: falha ao processar evento leadgen", {
        tenant: tenantId,
        leadgenId: value.leadgen_id,
        err: redactSecrets(e instanceof Error ? e.message : String(e)),
      });
      await captureEdgeError(admin, {
        severity: "error",
        source: "edge",
        operation: "meta.ads_leadgen.process_event",
        tenantId,
        message: e instanceof Error ? redactSecrets(e.message) : String(e),
        stack: e instanceof Error && e.stack ? redactSecrets(e.stack) : null,
        context: {
          leadgen_id: value.leadgen_id ?? null,
          campaign_id: value.campaign_id ?? null,
          ad_id: value.ad_id ?? null,
        },
      });
    }
  }

  return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
});
