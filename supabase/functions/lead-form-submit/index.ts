// Endpoint PÚBLICO (sem autenticação de usuário, chamado com a anon key) que
// recebe submissões de formulários de captura de leads (PRD Fase 4, user
// story I). É a maior superfície de risco do projeto até aqui: escrita
// anônima em contacts/lead_form_submissions a partir de qualquer origem.
//
// A validação de negócio "de verdade" (formulário existe/está ativo, e o
// tenant_id nunca pode ser forjado pelo cliente) já vive no trigger
// SECURITY DEFINER `validate_lead_form_submission()` (BEFORE INSERT em
// lead_form_submissions, ver 20260711100200_fase4_prb_lead_forms_schema.sql).
// Este arquivo faz uma checagem antecipada (para responder 404/400 com uma
// mensagem clara antes de chegar no INSERT) e trata o erro que o Postgres
// devolve se o trigger rejeitar mesmo assim (corrida entre o SELECT e o
// INSERT, formulário desativado no meio do caminho etc.) — nunca repassa o
// erro cru do Postgres para o cliente.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { captureEdgeError } from "../_shared/telemetry.ts";
import { normalizePhone } from "../_shared/messaging/conversation.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Rate limit: N submissões por (lead_form_id, source_ip OU telefone/e-mail)
// numa janela de M minutos. Constantes nomeadas — nunca mágicas.
const RATE_LIMIT_WINDOW_MINUTES = 10;
const RATE_LIMIT_MAX_SUBMISSIONS = 3;
// Backstop global por lead_form_id/janela: mesmo com IP rotacionado e
// telefone/e-mail variando, um único formulário não deve receber mais que
// isso em RATE_LIMIT_WINDOW_MINUTES minutos. Corta ataque distribuído que
// escapa dos filtros (source_ip / phone / email) por unicidade.
const RATE_LIMIT_MAX_TOTAL_PER_FORM = 60;

const DEFAULT_SUCCESS_MESSAGE = "Recebemos sua mensagem! Em breve entraremos em contato.";
const FALLBACK_CONTACT_NAME = "Lead sem nome";
const GENERIC_SUBMIT_ERROR =
  "Não foi possível registrar sua submissão. Tente novamente em instantes.";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

interface LeadFormRow {
  id: string;
  tenant_id: string;
  name: string;
  is_active: boolean;
  success_message: string | null;
  fields: unknown;
}

interface LeadFormField {
  key: string;
  maps_to_custom_field_id?: string | null;
}

interface ContactRow {
  id: string;
  custom_fields: Record<string, unknown> | null;
}

/**
 * Extrai o campo do formulário: só aceita `form_id`/`data` do corpo — NUNCA
 * um `tenant_id` do cliente (o trigger do banco sobrescreve de qualquer
 * forma, mas nem aceitamos esse campo no shape de input para não sugerir que
 * é um valor confiável).
 */
function parseBody(raw: unknown): { formId: string; data: Record<string, unknown> } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const formId = typeof obj.form_id === "string" ? obj.form_id.trim() : "";
  if (!formId) return null;
  const data =
    obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)
      ? (obj.data as Record<string, unknown>)
      : {};
  return { formId, data };
}

/** IP de origem confiável a partir do x-forwarded-for.
 *
 * O ÚLTIMO hop do XFF é o mais próximo do proxy da plataforma (o cliente
 * pode injetar qualquer coisa nos primeiros valores — "1.1.1.1, real-ip"
 * — mas não pode falsificar o valor que o proxy final anexa). Ler o
 * primeiro token permitiria ao cliente rotacionar o header e escapar do
 * rate-limit indefinidamente (=> criação ilimitada de contatos). Se o
 * header não existir, retorna null — nunca fabricamos um IP. */
function extractSourceIp(req: Request): string | null {
  const header = req.headers.get("x-forwarded-for");
  if (!header) return null;
  const parts = header
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const last = parts[parts.length - 1];
  return last ?? null;
}

function normalizeStr(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** Escapa curingas de ILIKE (%, _, \) para que a busca de e-mail seja uma
 * comparação case-insensitive exata, não um pattern match — sem isso, um
 * `data.email` malicioso como "%" casaria com qualquer contato do tenant. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Formata um valor para uso dentro de um filtro `.or(...)` do PostgREST.
 * Sempre entre aspas duplas (com escape de \ e ") porque telefone/e-mail
 * podem conter caracteres que colidem com a mini-linguagem de filtros
 * (vírgula separa condições, parênteses abrem grupo lógico). */
function pgOrValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Tetos de payload do endpoint público. O chamador é anônimo por definição
// (formulário embutido), então a defesa possível não é autenticar e sim
// reduzir ao mínimo o que ele consegue gravar: só as chaves declaradas no
// próprio formulário, com tamanho limitado e e-mail em formato válido.
const MAX_FIELD_LENGTH = 500;
const MAX_NAME_LENGTH = 200;
const MAX_EMAIL_LENGTH = 254;
const MAX_PHONE_LENGTH = 32;
const MAX_DATA_KEYS = 50;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Allowlist de escrita anônima: descarta qualquer chave que o formulário não
 * declare (mais `name`/`phone`/`email`, que são canônicos), corta strings no
 * teto e recusa e-mail fora de formato. Sem isso, um chamador anônimo escolhe
 * livremente o conteúdo que a service role grava em contacts.
 */
function sanitizeSubmissionData(
  raw: Record<string, unknown>,
  formFields: unknown,
): Record<string, unknown> {
  const declared = new Set<string>(["name", "phone", "email"]);
  if (Array.isArray(formFields)) {
    for (const f of formFields) {
      const key = (f as { key?: unknown } | null)?.key;
      if (typeof key === "string" && key) declared.add(key);
    }
  }
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (!declared.has(key)) continue;
    if (count >= MAX_DATA_KEYS) break;
    let normalized: unknown;
    if (typeof value === "string") {
      const cap =
        key === "name"
          ? MAX_NAME_LENGTH
          : key === "email"
            ? MAX_EMAIL_LENGTH
            : key === "phone"
              ? MAX_PHONE_LENGTH
              : MAX_FIELD_LENGTH;
      normalized = value.trim().slice(0, cap);
    } else if (typeof value === "number" || typeof value === "boolean") {
      normalized = value;
    } else {
      // objeto/array/null vindo de terceiro não tem uso legítimo aqui.
      continue;
    }
    if (key === "email" && typeof normalized === "string" && !EMAIL_RE.test(normalized)) continue;
    out[key] = normalized;
    count += 1;
  }
  return out;
}


Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    // Payload de terceiro malformado — não é incidente nosso, mas repetição
    // sinaliza integração de embed quebrada. severity "warn": não é falha nossa.
    await captureEdgeError(admin, {
      severity: "warn",
      source: "edge",
      operation: "lead.form_submit.invalid_json",
      tenantId: null,
      message: "Corpo da requisição não é JSON válido.",
      context: {},
    });
    return json(400, { error: "Corpo inválido." });
  }
  const parsed = parseBody(rawBody);
  if (!parsed) {
    await captureEdgeError(admin, {
      severity: "warn",
      source: "edge",
      operation: "lead.form_submit.missing_form_id",
      tenantId: null,
      message: "form_id ausente ou inválido no corpo da submissão.",
      context: {},
    });
    return json(400, { error: "Formulário é obrigatório." });
  }
  const { formId, data: rawSubmissionData } = parsed;
  const sourceIp = extractSourceIp(req);

  // 1. Busca o lead_form ANTES do rate-limit e do insert, para responder
  // 404/400 cedo com uma mensagem clara (defesa em profundidade além do
  // trigger, que rejeita a mesma coisa silenciosamente no INSERT). Erro de
  // infra aqui (timeout, conexão) é distinto de "não encontrado" — nunca
  // reaproveitar o branch 404 para um erro real de banco.
  const { data: form, error: formErr } = await admin
    .from("lead_forms")
    .select("id, tenant_id, name, is_active, success_message, fields")
    .eq("id", formId)
    .maybeSingle<LeadFormRow>();
  if (formErr) {
    console.error("lead-form-submit: falha ao buscar lead_form", formId, formErr);
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "lead.form_submit.fetch_form",
      tenantId: null,
      errorCode: formErr.code ?? null,
      message: formErr.message,
      context: { form_id: formId },
    });
    return json(500, { error: GENERIC_SUBMIT_ERROR });
  }
  if (!form) {
    // form_id de terceiro que não existe mais (embed desatualizado/copiado
    // errado) — não é incidente nosso, mas repetir no mesmo form_id é sinal.
    await captureEdgeError(admin, {
      severity: "warn",
      source: "edge",
      operation: "lead.form_submit.form_not_found",
      tenantId: null,
      message: "lead_form não encontrado para o form_id recebido.",
      context: { form_id: formId },
    });
    return json(404, { error: "Formulário não encontrado." });
  }
  if (!form.is_active) {
    await captureEdgeError(admin, {
      severity: "warn",
      source: "edge",
      operation: "lead.form_submit.form_inactive",
      tenantId: form.tenant_id,
      message: "Submissão recebida para lead_form inativo.",
      context: { form_id: formId },
    });
    return json(400, { error: "Este formulário não está mais recebendo submissões." });
  }

  // Allowlist + tetos aplicados assim que o formulário é conhecido: daqui
  // para frente ninguém mais toca no corpo cru vindo do chamador anônimo.
  const data = sanitizeSubmissionData(rawSubmissionData, form.fields);

  const rawPhone = normalizeStr(data.phone);

  const normalizedPhone = normalizePhone(rawPhone);
  const phone = normalizedPhone || undefined;
  const email = normalizeStr(data.email)?.toLowerCase();
  const name = normalizeStr(data.name) ?? phone ?? email ?? FALLBACK_CONTACT_NAME;

  // 2. Rate limit por (lead_form_id, source_ip) OU (lead_form_id,
  // telefone/e-mail normalizado) — o que for mais restritivo. Cobre as duas
  // lacunas óbvias de limitar só por IP: telefones diferentes atrás do mesmo
  // IP (rede corporativa/CGNAT) competindo no mesmo balde, e o mesmo telefone
  // atrás de IPs diferentes (troca de rede) nunca sendo limitado. Sempre
  // antes de tocar contacts/lead_form_submissions.
  // Limitação que permanece (aceita nesta fase): a contagem e o INSERT não
  // são atômicos — sem lock/transação, duas requisições simultâneas perto do
  // limite podem passar as duas. Resolver com lock otimista se virar problema
  // real.
  const cutoffIso = new Date(Date.now() - RATE_LIMIT_WINDOW_MINUTES * 60_000).toISOString();
  // sourceIp precisa passar por pgOrValue: mesmo sendo o último hop do XFF
  // (não trivialmente forjável), continua sendo entrada externa e pode
  // conter vírgula/parênteses/aspas que quebram a mini-linguagem do .or().
  const rateLimitOrParts = [sourceIp ? `source_ip.eq.${pgOrValue(sourceIp)}` : "source_ip.is.null"];
  if (phone) rateLimitOrParts.push(`data->>phone.eq.${pgOrValue(phone)}`);
  if (email) rateLimitOrParts.push(`data->>email.ilike.${pgOrValue(escapeLikePattern(email))}`);
  const { count: recentCount, error: rateLimitErr } = await admin
    .from("lead_form_submissions")
    .select("id", { count: "exact", head: true })
    .eq("lead_form_id", formId)
    .gte("created_at", cutoffIso)
    .or(rateLimitOrParts.join(","));
  if (rateLimitErr) {
    // Fail-closed: esta contagem é a única defesa de abuso do endpoint. Se a
    // query falhar (ex.: timeout sob flood de spam, justamente quando mais
    // precisa funcionar), nunca deixar a submissão passar silenciosamente.
    console.error(
      "lead-form-submit: falha ao verificar rate-limit",
      formId,
      sourceIp,
      rateLimitErr,
    );
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "lead.form_submit.rate_limit_check",
      tenantId: form.tenant_id,
      errorCode: rateLimitErr.code ?? null,
      message: rateLimitErr.message,
      context: { form_id: formId },
    });
    return json(503, { error: GENERIC_SUBMIT_ERROR });
  }
  if ((recentCount ?? 0) >= RATE_LIMIT_MAX_SUBMISSIONS) {
    return json(429, {
      error: "Muitas submissões recebidas. Tente novamente em alguns minutos.",
    });
  }

  // Backstop global por lead_form_id/janela: pega ataque distribuído em
  // que IP e telefone/e-mail estão sendo rotacionados para escapar do
  // filtro acima (cada tentativa cai num "balde" único). Mesmo tratamento
  // fail-closed em erro de banco.
  const { count: totalRecent, error: totalErr } = await admin
    .from("lead_form_submissions")
    .select("id", { count: "exact", head: true })
    .eq("lead_form_id", formId)
    .gte("created_at", cutoffIso);
  if (totalErr) {
    console.error("lead-form-submit: falha ao verificar backstop global", formId, totalErr);
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "lead.form_submit.rate_limit_backstop",
      tenantId: form.tenant_id,
      errorCode: totalErr.code ?? null,
      message: totalErr.message,
      context: { form_id: formId },
    });
    return json(503, { error: GENERIC_SUBMIT_ERROR });
  }
  if ((totalRecent ?? 0) >= RATE_LIMIT_MAX_TOTAL_PER_FORM) {
    return json(429, {
      error: "Muitas submissões recebidas. Tente novamente em alguns minutos.",
    });
  }

  // 3. Find-or-create contato: reutiliza por telefone, depois por e-mail
  // (mesmos índices de dedup de contacts, ignoram deleted_at/merged_into_id).
  // .limit(1) antes de .maybeSingle() é obrigatório aqui: os índices de dedup
  // NÃO são unique (2+ contatos podem compartilhar telefone/e-mail no mesmo
  // tenant por entrada manual/import/corrida anterior). Sem o .limit(1), um
  // resultado com 2+ linhas faz .maybeSingle() devolver erro com data=null —
  // cairíamos no ramo de criação e duplicaríamos o contato exatamente no
  // caso em que o dedup deveria evitar isso.
  //
  // Se a própria busca de dedup falhar (erro de infra), abortamos com 500 em
  // vez de seguir para a criação: continuar sem saber se o contato já existe
  // duplicaria exatamente o caso que o dedup deveria evitar.
  let existing: ContactRow | null = null;
  if (phone) {
    const { data: found, error: phoneErr } = await admin
      .from("contacts")
      .select("id, custom_fields")
      .eq("tenant_id", form.tenant_id)
      .eq("phone", phone)
      .is("deleted_at", null)
      .is("merged_into_id", null)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle<ContactRow>();
    if (phoneErr) {
      console.error(
        "lead-form-submit: falha ao buscar contato por telefone",
        form.tenant_id,
        phoneErr,
      );
      await captureEdgeError(admin, {
        severity: "error",
        source: "edge",
        operation: "lead.form_submit.find_contact_phone",
        tenantId: form.tenant_id,
        errorCode: phoneErr.code ?? null,
        message: phoneErr.message,
        context: { form_id: formId },
      });
      return json(500, { error: GENERIC_SUBMIT_ERROR });
    }
    existing = found;
  }
  if (!existing && email) {
    const { data: found, error: emailErr } = await admin
      .from("contacts")
      .select("id, custom_fields")
      .eq("tenant_id", form.tenant_id)
      .ilike("email", escapeLikePattern(email))
      .is("deleted_at", null)
      .is("merged_into_id", null)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle<ContactRow>();
    if (emailErr) {
      console.error(
        "lead-form-submit: falha ao buscar contato por e-mail",
        form.tenant_id,
        emailErr,
      );
      await captureEdgeError(admin, {
        severity: "error",
        source: "edge",
        operation: "lead.form_submit.find_contact_email",
        tenantId: form.tenant_id,
        errorCode: emailErr.code ?? null,
        message: emailErr.message,
        context: { form_id: formId },
      });
      return json(500, { error: GENERIC_SUBMIT_ERROR });
    }
    existing = found;
  }

  let contactId: string;
  let currentCustomFields: Record<string, unknown>;
  if (existing) {
    // Reaproveita sem sobrescrever status/owner_id do contato existente.
    contactId = existing.id;
    currentCustomFields = existing.custom_fields ?? {};
  } else {
    const { data: created, error: createErr } = await admin
      .from("contacts")
      .insert({
        tenant_id: form.tenant_id,
        name,
        phone: phone ?? null,
        email: email ?? null,
        source: `lead_form:${form.name}`,
        tags: [],
        // status não é setado — usa o default da coluna ('lead').
      })
      .select("id, custom_fields")
      .single<ContactRow>();
    if (createErr || !created) {
      console.error("lead-form-submit: falha ao criar contato", createErr);
      await captureEdgeError(admin, {
        severity: "error",
        source: "edge",
        operation: "lead.form_submit.create_contact",
        tenantId: form.tenant_id,
        errorCode: createErr?.code ?? null,
        message: createErr?.message ?? "insert de contato sem retorno de id",
        context: { form_id: formId },
      });
      return json(500, { error: "Não foi possível registrar seu contato. Tente novamente." });
    }
    contactId = created.id;
    currentCustomFields = created.custom_fields ?? {};
  }

  // 4. Mapeamento de custom fields: só os campos do form com
  // maps_to_custom_field_id preenchido E presentes em `data`. Merge sem
  // sobrescrever outras chaves já existentes em custom_fields.
  const fieldDefs: LeadFormField[] = Array.isArray(form.fields)
    ? (form.fields as unknown[]).filter(
        (f): f is LeadFormField =>
          !!f && typeof f === "object" && typeof (f as LeadFormField).key === "string",
      )
    : [];
  const mappedIds = fieldDefs
    .map((f) => f.maps_to_custom_field_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  const customFieldUpdates: Record<string, unknown> = {};
  if (mappedIds.length > 0) {
    const { data: defs, error: defsErr } = await admin
      .from("custom_field_definitions")
      .select("id, key")
      .eq("tenant_id", form.tenant_id)
      .eq("entity", "contact")
      .in("id", mappedIds);
    if (defsErr) {
      // Não aborta a submissão por isso — só loga: sem os defs, os campos
      // mapeados são pulados (idToKey fica vazio), mas o lead em si ainda é
      // salvo. Sem o log, isso é indistinguível de "sem mapeamento
      // configurado".
      console.error(
        "lead-form-submit: falha ao buscar custom_field_definitions",
        mappedIds,
        defsErr,
      );
      await captureEdgeError(admin, {
        severity: "error",
        source: "edge",
        operation: "lead.form_submit.fetch_field_defs",
        tenantId: form.tenant_id,
        errorCode: defsErr.code ?? null,
        message: defsErr.message,
        context: { form_id: formId, mapped_ids_count: mappedIds.length },
      });
    }
    const idToKey = new Map((defs ?? []).map((d) => [d.id as string, d.key as string]));
    for (const field of fieldDefs) {
      if (!field.maps_to_custom_field_id) continue;
      const defKey = idToKey.get(field.maps_to_custom_field_id);
      if (!defKey) continue;
      if (data[field.key] === undefined) continue;
      customFieldUpdates[defKey] = data[field.key];
    }
  }

  if (Object.keys(customFieldUpdates).length > 0) {
    const mergedCustomFields = { ...currentCustomFields };
    for (const [key, value] of Object.entries(customFieldUpdates)) {
      if (!(key in currentCustomFields)) mergedCustomFields[key] = value;
    }
    const { error: patchErr } = await admin
      .from("contacts")
      .update({ custom_fields: mergedCustomFields })
      .eq("id", contactId);
    if (patchErr) {
      // Não aborta a resposta ao cliente: o lead já foi capturado (contato
      // existe/foi criado); perder o merge de custom_fields é pior que
      // silêncio total, mas não justifica falhar a submissão inteira.
      console.error(
        "lead-form-submit: falha ao mesclar custom_fields do contato",
        contactId,
        customFieldUpdates,
        patchErr,
      );
      await captureEdgeError(admin, {
        severity: "error",
        source: "edge",
        operation: "lead.form_submit.merge_custom_fields",
        tenantId: form.tenant_id,
        errorCode: patchErr.code ?? null,
        message: patchErr.message,
        context: {
          contact_id: contactId,
          updated_keys_count: Object.keys(customFieldUpdates).length,
        },
      });
    }
  }

  // 5. Insere a submissão. O trigger BEFORE INSERT valida (de novo, em
  // profundidade) e sobrescreve tenant_id — se rejeitar (RAISE EXCEPTION),
  // capturamos o erro e respondemos uma mensagem limpa, sem vazar o corpo
  // cru que o PostgREST devolve (message/code/details/hint do Postgres).
  const { error: submitErr } = await admin.from("lead_form_submissions").insert({
    lead_form_id: form.id,
    contact_id: contactId,
    data,
    source_ip: sourceIp,
  });
  if (submitErr) {
    console.error("lead-form-submit: insert de submissão rejeitado", submitErr);
    // Trigger BEFORE INSERT rejeitou — pode ser corrida real (form
    // desativado entre o SELECT e o INSERT) ou drift entre esta checagem e a
    // validação do trigger. Não é "falha nossa" no sentido de infra, mas
    // repetição no mesmo form_id é sinal de que o pré-check ficou desalinhado
    // com a regra do banco.
    await captureEdgeError(admin, {
      severity: "warn",
      source: "edge",
      operation: "lead.form_submit.trigger_reject",
      tenantId: form.tenant_id,
      errorCode: submitErr.code ?? null,
      message: submitErr.message,
      context: { form_id: formId, contact_id: contactId },
    });
    return json(400, { error: GENERIC_SUBMIT_ERROR });
  }

  return json(200, { ok: true, message: form.success_message || DEFAULT_SUCCESS_MESSAGE });
});
