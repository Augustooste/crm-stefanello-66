// lead-enrich — enriquece um contato do CRM com dados públicos via Apify (BYO
// token do tenant). Trigger MANUAL (botão no contato) — trava de custo por design.
//
// Fontes LGPD-safe: perfil público do Instagram, contatos do site, validação
// has-WhatsApp (booleano). NÃO usa Actor lastreado em vazamento/breach.
//
// Custo: teto por Actor via maxTotalChargeUsd; preferimos poucos itens (limit).
// Cada run é registrado em apify_enrichment_runs (dashboard de custos).
// Empty-fill: só preenche coluna vazia — nunca sobrescreve dado do usuário.
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { captureEdgeError } from "../_shared/telemetry.ts";
import {
  type ContactPatch,
  instagramHandle,
  mapInstagram,
  mapWebsite,
  mapWhatsapp,
  mergeEmptyOnly,
} from "./mappers.ts";

const ENRICH_TTL_DAYS = 7; // não re-enriquece se rodou há menos disso (salvo force)
const RUN_WAIT_SEC = 60; // Apify waitForFinish (máx suportado = 60)
const ITEMS_LIMIT = 3;
// Acima do RUN_WAIT_SEC: a Apify segura a conexão até 60s no caminho feliz, então
// um deadline <= 60s transformaria run bem-sucedido em falha.
const RUN_TIMEOUT_MS = 90_000;
// Leitura do dataset não tem espera server-side.
const DATASET_TIMEOUT_MS = 20_000;
const DAILY_TENANT_RUN_CAP = 500; // teto de runs/dia por tenant (freio de custo BYO)

// Remove qualquer Apify API token de uma string antes de persistir. Defesa em
// profundidade: já mandamos o token via header (não na URL), mas uma msg de erro
// jamais deve deixar o token cair numa coluna legível por membro do tenant.
function redactToken(s: string): string {
  return s.replace(/apify_api_[A-Za-z0-9]+/g, "apify_api_***");
}

const ACTORS = {
  instagram: "apify~instagram-profile-scraper",
  website: "vdrmota~contact-info-scraper",
  whatsapp: "vero-api~whatsapp-scraper",
} as const;

// Teto de custo POR Actor. Cada Actor tem um mínimo próprio: o contact-info-scraper
// (website) rejeita run com teto < $0.50 (erro max-total-charge-usd-below-minimum,
// confirmado ao vivo). Instagram/WhatsApp são pay-per-event baratos. NÃO baixar o
// teto do website abaixo de 0.50 — a run falha antes de rodar.
const MAX_CHARGE_USD: Record<keyof typeof ACTORS, number> = {
  instagram: 0.1,
  website: 0.6,
  whatsapp: 0.1,
};

// CORS por allowlist (mesmo padrão de brand-extract): reflete Origin só se for do app.
function buildCors(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const extra = (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(
    Boolean,
  );
  let allowed = false;
  if (origin) {
    if (extra.includes(origin)) allowed = true;
    else {
      try {
        const host = new URL(origin).hostname;
        allowed =
          host.endsWith(".lovable.app") ||
          host.endsWith(".lovableproject.com") ||
          host.endsWith(".sandbox.lovable.dev") ||
          host === "localhost" ||
          host === "127.0.0.1";
      } catch {
        allowed = false;
      }
    }
  }
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "null",
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

interface ActorRun {
  runId: string | null;
  status: string;
  cost: number;
  items: Record<string, unknown>[];
}

// Roda um Actor de forma síncrona (waitForFinish) com teto de custo e busca os
// itens do dataset. Lança em erro de API — o caller trata por-Actor (allSettled).
async function runActor(
  admin: SupabaseClient,
  tenantId: string,
  token: string,
  actorId: string,
  input: Record<string, unknown>,
  maxChargeUsd: number,
): Promise<ActorRun> {
  // Token via Authorization: Bearer (não query param) — mantém o segredo fora da
  // URL, que vaza em access log/proxy e na mensagem de TypeError de erro de rede.
  const runRes = await fetch(
    `https://api.apify.com/v2/acts/${actorId}/runs` +
      `?waitForFinish=${RUN_WAIT_SEC}&maxTotalChargeUsd=${maxChargeUsd}&maxItems=${ITEMS_LIMIT}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
    },
  );
  const runJson = await runRes.json().catch(() => ({}));
  if (!runRes.ok) {
    throw new Error(
      (runJson as { error?: { message?: string } })?.error?.message ?? `Apify HTTP ${runRes.status}`,
    );
  }
  const run = (runJson as { data?: Record<string, unknown> }).data ?? {};
  const cost = Number(run.usageTotalUsd ?? 0);
  const status = String(run.status ?? "UNKNOWN");
  let items: Record<string, unknown>[] = [];
  if (status === "SUCCEEDED" && run.defaultDatasetId) {
    const itRes = await fetch(
      `https://api.apify.com/v2/datasets/${run.defaultDatasetId}/items?clean=true&limit=${ITEMS_LIMIT}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(DATASET_TIMEOUT_MS),
      },
    );
    if (itRes.ok) {
      let datasetParseFailed = false;
      let datasetParseError: unknown = null;
      const parsed = await itRes.json().catch((e) => {
        datasetParseFailed = true;
        datasetParseError = e;
        console.error(
          `[lead-enrich] dataset JSON inválido actor=${actorId}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        return [];
      });
      if (Array.isArray(parsed)) items = parsed as Record<string, unknown>[];
      // Sem isto, um dataset com JSON inválido vira items=[] e a linha 357+
      // (abaixo) classifica como "SUCCEEDED com 0 itens = não achou nada" —
      // uma falha real fica indistinguível de "rodou e não achou nada".
      if (datasetParseFailed) {
        await captureEdgeError(admin, {
          severity: "warn",
          source: "edge",
          operation: "lead.enrich.fetch_dataset",
          tenantId,
          message: `Dataset do actor ${actorId} retornou JSON inválido.`,
          // redactToken mesmo aqui: o stack de um SyntaxError de JSON.parse
          // costuma ecoar um trecho da entrada, e este arquivo assumiu por
          // decisão (ver redactToken, topo) que nenhuma string persistida
          // passa sem filtro. O token vai por header, não pela URL, então o
          // vazamento seria indireto — é defesa em profundidade, não remendo.
          stack: datasetParseError instanceof Error && datasetParseError.stack
            ? redactToken(datasetParseError.stack)
            : null,
          context: { actor_id: actorId, reason: "invalid_json" },
        });
      }
    } else {
      console.error(`[lead-enrich] falha ao buscar dataset (${itRes.status}) actor=${actorId}`);
      await captureEdgeError(admin, {
        severity: "warn",
        source: "edge",
        operation: "lead.enrich.fetch_dataset",
        tenantId,
        message: `Falha ao buscar dataset do actor ${actorId} (HTTP ${itRes.status}).`,
        context: { actor_id: actorId, reason: "http_error", status: itRes.status },
      });
    }
  }
  return { runId: (run.id as string) ?? null, status, cost, items };
}

async function ledger(
  admin: SupabaseClient,
  row: {
    tenant_id: string;
    contact_id: string;
    actor_id: string;
    triggered_by: string;
    run?: ActorRun | null;
    error?: string;
  },
): Promise<void> {
  // RUNNING (run estourou o waitForFinish de 60s, ainda rodando) é registrado como
  // "running", não colapsado em "failed" — a constraint da tabela aceita os três.
  const status = row.error
    ? "failed"
    : row.run?.status === "SUCCEEDED"
    ? "succeeded"
    : row.run?.status === "RUNNING" || row.run?.status === "READY"
    ? "running"
    : "failed";
  const { error } = await admin.from("apify_enrichment_runs").insert({
    tenant_id: row.tenant_id,
    contact_id: row.contact_id,
    actor_id: row.actor_id,
    run_id: row.run?.runId ?? null,
    status,
    cost_usd: row.run?.cost ?? 0,
    items_count: row.run?.items.length ?? 0,
    triggered_by: row.triggered_by,
    error: row.error ? redactToken(row.error) : null,
    finished_at: new Date().toISOString(),
  });
  // Best-effort (não derruba o enrich), mas observável: o ledger é a fonte do
  // dashboard de custos; insert calado deixaria o gasto invisível.
  if (error) {
    console.error(`[lead-enrich] falha ao gravar ledger (actor=${row.actor_id}): ${error.message}`);
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "lead.enrich.write_ledger",
      tenantId: row.tenant_id,
      errorCode: error.code ?? null,
      message: error.message,
      context: { contact_id: row.contact_id, actor_id: row.actor_id },
    });
  }
}

Deno.serve(async (req) => {
  const cors = buildCors(req);
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
  const authHeader = req.headers.get("Authorization") ?? "";

  const userClient = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  });
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json(401, { error: "Não autenticado." });
  const userId = userData.user.id;

  const { data: profile, error: profErr } = await admin.from("profiles")
    .select("tenant_id, role").eq("id", userId).maybeSingle();
  if (profErr) {
    // Sem log nenhum antes disto — o 500 era completamente invisível.
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "lead.enrich.fetch_profile",
      tenantId: null,
      errorCode: profErr.code ?? null,
      message: profErr.message,
      context: { user_id: userId },
    });
    return json(500, { error: "Falha ao consultar perfil." });
  }
  if (!profile?.tenant_id) return json(403, { error: "Perfil não encontrado." });
  const tenantId = profile.tenant_id as string;
  const isAdmin = profile.role === "admin";

  let contactId = "";
  let force = false;
  try {
    const body = (await req.json()) as { contact_id?: string; force?: boolean };
    contactId = (body.contact_id ?? "").trim();
    // `force` re-roda os Actors pagos, ignorando o cache/TTL → só admin pode; o
    // flag vindo de não-admin é ignorado (freio de custo).
    force = body.force === true && isAdmin;
  } catch {
    return json(400, { error: "Corpo inválido." });
  }
  if (!contactId) return json(400, { error: "contact_id é obrigatório." });

  // Contato precisa ser do tenant do usuário (isolamento — não confia no client).
  const { data: contact, error: contactErr } = await admin
    .from("contacts")
    .select("id, name, email, phone, website, instagram, linkedin, job_title, description, custom_fields")
    .eq("id", contactId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  if (contactErr) {
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "lead.enrich.fetch_contact",
      tenantId,
      errorCode: contactErr.code ?? null,
      message: contactErr.message,
      context: { contact_id: contactId },
    });
    return json(500, { error: "Falha ao consultar contato." });
  }
  if (!contact) return json(404, { error: "Contato não encontrado." });

  const customFields = (contact.custom_fields ?? {}) as Record<string, unknown>;
  const prev = (customFields.enrichment ?? null) as { at?: string } | null;
  if (!force && prev?.at) {
    const ageMs = Date.now() - new Date(prev.at).getTime();
    if (ageMs < ENRICH_TTL_DAYS * 24 * 60 * 60 * 1000) {
      return json(200, { ok: true, cached: true, enrichment: prev });
    }
  }

  // Credencial do tenant (BYO). Sem token → integração não conectada.
  const { data: secretRow, error: secretErr } = await admin
    .from("integration_secrets")
    .select("value")
    .eq("tenant_id", tenantId)
    .eq("slug", "apify")
    .eq("key", "api_token")
    .maybeSingle();
  // Erro real de consulta é 500 distinto — não colapsar em "não conectada", que
  // mandaria o usuário reconectar algo que já está conectado.
  if (secretErr) {
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "lead.enrich.fetch_credentials",
      tenantId,
      errorCode: secretErr.code ?? null,
      message: secretErr.message,
      context: { contact_id: contactId },
    });
    return json(500, { error: "Falha ao consultar credenciais." });
  }
  const token = (secretRow?.value as string) ?? "";
  if (!token) {
    return json(400, { error: "Integração Apify não conectada. Conecte em Integrações e informe sua API key." });
  }

  // Freio de custo: teto de runs/dia por tenant (evita drenar o saldo Apify BYO,
  // ex.: um agente percorrendo todos os contatos).
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const { count: runsToday, error: capErr } = await admin
    .from("apify_enrichment_runs")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .gte("created_at", dayStart.toISOString());
  // Fail-closed: erro na consulta do teto não pode passar como "abaixo do limite"
  // (senão o freio de custo some numa soneca do DB). Mesmo padrão dos reads acima.
  if (capErr) {
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "lead.enrich.check_daily_cap",
      tenantId,
      errorCode: capErr.code ?? null,
      message: capErr.message,
      context: { contact_id: contactId },
    });
    return json(500, { error: "Falha ao verificar limite de uso." });
  }
  if ((runsToday ?? 0) >= DAILY_TENANT_RUN_CAP) {
    return json(429, {
      error: "Limite diário de enriquecimentos deste workspace atingido. Tente novamente amanhã.",
    });
  }

  // Monta as tarefas conforme os identificadores disponíveis no contato.
  const tasks: { key: keyof typeof ACTORS; input: Record<string, unknown> }[] = [];
  const igHandle = instagramHandle(contact.instagram);
  if (igHandle) tasks.push({ key: "instagram", input: { usernames: [igHandle] } });
  const website = (contact.website ?? "").toString().trim();
  if (website) {
    tasks.push({
      key: "website",
      input: {
        startUrls: [{ url: /^https?:\/\//i.test(website) ? website : `https://${website}` }],
        proxyConfig: { useApifyProxy: true },
        maxRequests: 1,
        maxDepth: 0,
      },
    });
  }
  const phone = (contact.phone ?? "").toString().trim();
  if (phone) {
    tasks.push({ key: "whatsapp", input: { numbers: [phone] } });
  }

  if (tasks.length === 0) {
    return json(422, {
      error: "Contato sem Instagram, site ou telefone para enriquecer.",
    });
  }

  // Roda todos em paralelo; falha de um Actor não derruba os outros.
  const results = await Promise.allSettled(
    tasks.map((t) => runActor(admin, tenantId, token, ACTORS[t.key], t.input, MAX_CHARGE_USD[t.key])),
  );

  let combined: ContactPatch = {};
  const sources: Record<string, unknown> = {};
  const failed: string[] = []; // fontes que falharam (rejected ou run não-SUCCEEDED)
  let anySucceeded = false;
  let whatsapp: { hasWhatsapp: boolean; accountType?: string } | null = null;
  let costUsd = 0;

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const res = results[i];
    if (res.status === "rejected") {
      const msg = res.reason instanceof Error ? res.reason.message : String(res.reason);
      await ledger(admin, {
        tenant_id: tenantId,
        contact_id: contactId,
        actor_id: ACTORS[t.key],
        triggered_by: userId,
        error: msg,
      });
      failed.push(t.key);
      sources[t.key] = { error: redactToken(msg) };
      continue;
    }
    const run = res.value;
    costUsd += run.cost;
    await ledger(admin, {
      tenant_id: tenantId,
      contact_id: contactId,
      actor_id: ACTORS[t.key],
      triggered_by: userId,
      run,
    });
    // Run em estado não-SUCCEEDED (FAILED/ABORTED/RUNNING) é falha — NÃO deixar
    // cair no caminho de sucesso, senão a resposta seria um "ok" mudo.
    if (run.status !== "SUCCEEDED") {
      failed.push(t.key);
      sources[t.key] = { status: run.status, items: run.items.length };
      continue;
    }
    anySucceeded = true;
    const item = run.items[0];
    if (!item) {
      // SUCCEEDED com 0 itens = rodou e não achou nada (não é falha).
      sources[t.key] = { status: run.status, items: 0 };
      continue;
    }
    if (t.key === "instagram") combined = { ...mapInstagram(item), ...combined };
    else if (t.key === "website") combined = { ...mapWebsite(item), ...combined };
    else if (t.key === "whatsapp") {
      const w = mapWhatsapp(item);
      whatsapp = { hasWhatsapp: w.hasWhatsapp, accountType: w.accountType };
      combined = { ...w.patch, ...combined };
    }
    sources[t.key] = item;
  }

  const filled = mergeEmptyOnly(contact as Record<string, unknown>, combined);

  // Só marca o TTL (`at`) quando ao menos um Actor teve sucesso — senão uma falha
  // total envenenaria o cache de 7 dias e travaria o contato com "já enriquecido".
  const costTotal = Number(costUsd.toFixed(4));
  const enrichment: Record<string, unknown> = { cost_usd: costTotal, whatsapp, failed, sources };
  if (anySucceeded) enrichment.at = new Date().toISOString();

  const { error: updErr } = await admin
    .from("contacts")
    .update({ ...filled, custom_fields: { ...customFields, enrichment } })
    .eq("id", contactId)
    .eq("tenant_id", tenantId);
  if (updErr) {
    // Pior caso do arquivo: o(s) Actor(s) já rodaram e já foram cobrados
    // (ledger já gravado acima), mas o resultado do enriquecimento não é
    // persistido no contato — custo pago sem o benefício.
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "lead.enrich.persist_result",
      tenantId,
      errorCode: updErr.code ?? null,
      message: updErr.message,
      context: { contact_id: contactId, cost_usd: costTotal },
    });
    return json(500, { error: `Falha ao gravar: ${updErr.message}` });
  }

  return json(200, {
    ok: true,
    filled: Object.keys(filled),
    failed,
    cost_usd: costTotal,
    whatsapp,
    ran: tasks.map((t) => t.key),
  });
});
