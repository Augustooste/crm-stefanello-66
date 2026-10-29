// AI Playground — runs the same prompt-assembly pipeline as ai-respond but is
// 100% isolated: never persists messages, never sends externally, never
// creates or moves deals, never creates activities. Admins only.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { captureEdgeError } from "../_shared/telemetry.ts";
import { loadProfileOrFail, PROFILE_DB_ERROR_MESSAGE } from "../_shared/load-profile.ts";
import { checkRateLimit } from "../_shared/ai/rate-limiter.ts";
import { getAIGatewayConfig } from "../_shared/ai/gateway.ts";

const RATE_LIMIT_MAX_CALLS = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const AI_MODEL = "google/gemini-3-flash-preview";
// Playground é interativo — o admin está olhando a resposta chegar.
const AI_TIMEOUT_MS = 45_000;
const DEFAULT_BASE_PROMPT =
  "Você é uma assistente virtual atenciosa que atende leads de {{empresa}}. Seja cordial, objetiva e ajude o cliente com clareza.";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

// Mirrors ai-respond: replace {{var}}; drop sentences with unresolved vars.
function renderTemplate(tpl: string, vars: Record<string, string | undefined>): string {
  if (!tpl) return "";
  const filled = tpl.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) => {
    const v = vars[key];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
    return "\u0000UNRESOLVED\u0000";
  });
  const cleaned = filled
    .split(/\n/)
    .map((line) => {
      const parts = line.split(/(?<=[.!?])\s+/);
      const kept = parts.filter((p) => !p.includes("\u0000UNRESOLVED\u0000"));
      return kept.join(" ").trim();
    })
    .filter((line) => line.length > 0)
    .join("\n");
  return cleaned.replace(/[ \t]+/g, " ").trim();
}

const WEEKDAY_PT: Record<string, string> = {
  mon: "seg",
  tue: "ter",
  wed: "qua",
  thu: "qui",
  fri: "sex",
  sat: "sáb",
  sun: "dom",
};

// business_profile.hours é objeto {mon:{enabled,open,close},...} — vira string legível.
function formatHours(v: unknown): string {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "";
  const parts: string[] = [];
  for (const [day, cfg] of Object.entries(v as Record<string, unknown>)) {
    const c = cfg as { enabled?: boolean; open?: string; close?: string } | null;
    if (!c || typeof c !== "object" || !c.enabled || !c.open || !c.close) continue;
    parts.push(`${WEEKDAY_PT[day] ?? day} ${c.open}-${c.close}`);
  }
  return parts.join(", ");
}

// Prompts dos nichos usam variáveis em PT ({{segmento}}, {{servicos}}...);
// o business_profile grava chaves em EN — sem os aliases, essas variáveis
// nunca resolvem e o renderTemplate apaga as frases inteiras do prompt.
const VAR_ALIASES_PT: Record<string, string> = {
  segmento: "segment",
  cidade: "city",
  equipe: "team",
  atendente_responsavel: "human_handoff_owner",
  nome_assistente: "assistant_name",
  servicos: "offerings",
  faixa_preco: "price_range",
};

function buildVars(tenant: {
  name: string;
  business_profile: Record<string, unknown> | null;
}): Record<string, string> {
  const bp = (tenant.business_profile ?? {}) as Record<string, unknown>;
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(bp)) {
    if (v == null) continue;
    if (typeof v === "string") flat[k] = v;
    else if (Array.isArray(v)) flat[k] = v.filter(Boolean).map(String).join(", ");
    else if (typeof v === "object")
      flat[k] = Object.values(v as Record<string, unknown>)
        .filter(Boolean)
        .map(String)
        .join(", ");
    else flat[k] = String(v);
  }
  const hours = formatHours(bp.hours);
  if (hours) {
    flat.hours = hours;
    flat.horarios = hours;
  } else {
    delete flat.hours; // achatamento genérico vira "[object Object]" — melhor não resolver
  }
  for (const [pt, en] of Object.entries(VAR_ALIASES_PT)) {
    if (!flat[pt] && flat[en]) flat[pt] = flat[en];
  }
  return { empresa: tenant.name, ...flat };
}

interface Body {
  stage_id?: string | null;
  // Tipado como desconhecido de propósito: o papel é normalizado no servidor.
  messages: Array<{ role?: unknown; content?: unknown }>;

}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
  const authHeader = req.headers.get("Authorization") ?? "";

  const userClient = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  });
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json(401, { error: "Não autenticado." });

  const prof = await loadProfileOrFail(admin, userData.user.id, {
    operation: "ai.playground.load_profile",
    requireAdmin: true,
  });
  if (!prof.ok) {
    if (prof.reason === "db_error") return json(503, { error: PROFILE_DB_ERROR_MESSAGE });
    if (prof.reason === "not_admin") return json(403, { error: "Apenas administradores." });
    return json(403, { error: "Perfil não encontrado." });
  }
  const tenantId = prof.tenantId;

  // O playground é interativo e o admin fica testando prompt em sequência — daí
  // o teto ser mais folgado que o do insight. O que ele barra é o loop, não o
  // uso normal.
  const limite = await checkRateLimit(
    admin,
    `ai-playground:${userData.user.id}`,
    RATE_LIMIT_MAX_CALLS,
    RATE_LIMIT_WINDOW_MS,
  );
  if (!limite.allowed) {
    if (limite.rpcFailed) {
      await captureEdgeError(admin, {
        severity: "error",
        source: "edge",
        operation: "ai.playground.rate_limit",
        tenantId,
        message: "RPC check_and_record_rate_limit falhou; negado por fail-closed.",
        context: { user_id: userData.user.id },
      });
      return json(500, { error: "Erro ao verificar limite de uso. Tente de novo em instantes." });
    }
    return json(429, {
      error: "Muitas mensagens seguidas no playground. Tente de novo em instantes.",
      retryAfterSeconds: Math.ceil((limite.retryAfterMs ?? RATE_LIMIT_WINDOW_MS) / 1000),
    });
  }

  // Catch de topo: zero sink hoje para qualquer falha nesta function (nem
  // captureEdgeError nem reportAIFailure). tenantId já resolvido acima.
  try {
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return json(400, { error: "Corpo inválido." });
    }
    // Papéis vêm do servidor, nunca do chamador: qualquer role diferente de
    // "assistant" é tratada como "user". Sem isso, o corpo da requisição
    // injeta uma mensagem "system" e sobrescreve as instruções do prompt.
    const messages = (Array.isArray(body.messages) ? body.messages : [])
      .filter(
        (m): m is { role: string; content: string } =>
          !!m && typeof m === "object" && typeof (m as { content?: unknown }).content === "string",
      )
      .map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      }));

    const stageId = body.stage_id ?? null;

    const [{ data: tenant }, { data: settings }] = await Promise.all([
      admin.from("tenants").select("name, business_profile").eq("id", tenantId).maybeSingle(),
      admin.from("ai_settings").select("base_system_prompt").eq("tenant_id", tenantId).maybeSingle(),
    ]);
    if (!tenant) return json(404, { error: "Tenant não encontrado." });

    let stagePrompt = "";
    if (stageId) {
      const { data: stageCfg } = await admin
        .from("stage_ai_config")
        .select("system_prompt, enabled")
        .eq("tenant_id", tenantId)
        .eq("stage_id", stageId)
        .maybeSingle();
      if (stageCfg?.enabled) stagePrompt = (stageCfg.system_prompt ?? "").trim();
    }

    const vars = buildVars({
      name: tenant.name as string,
      business_profile: (tenant.business_profile as Record<string, unknown> | null) ?? {},
    });
    const basePrompt = renderTemplate(
      // Mesmo fallback do caminho de producao (pipeline.ts): a coluna e
      // `text not null default ''`, e `"" ?? fallback` devolve "". Com `??` aqui e
      // `||` la, o playground simularia um prompt DIFERENTE do que roda ao vivo —
      // que e exatamente o que o playground existe para nao fazer.
      (settings?.base_system_prompt as string | null)?.trim() || DEFAULT_BASE_PROMPT,
      vars,
    );
    const stageRendered = stagePrompt ? renderTemplate(stagePrompt, vars) : "";
    const scopeGuard =
      "Se a mensagem do lead fugir do seu escopo ou você não souber responder com segurança, seja honesta e responda literalmente com a frase [TRANSFERIR_HUMANO] para que um atendente humano assuma.";
    const systemPrompt = [basePrompt, stageRendered, scopeGuard]
      .filter((s) => s && s.length > 0)
      .join("\n\n");

    const gateway = getAIGatewayConfig();
    if (!gateway.apiKey) return json(500, { error: "IA indisponível no momento." });

    try {
      const r = await fetch(gateway.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${gateway.apiKey}` },
        body: JSON.stringify({
          model: gateway.model || AI_MODEL,
          reasoning_effort: gateway.reasoningEffort,
          messages: [{ role: "system", content: systemPrompt }, ...messages],
        }),
        signal: AbortSignal.timeout(AI_TIMEOUT_MS),
      });
      if (!r.ok) {
        if (r.status === 429)
          return json(429, { error: "Muitas requisições à IA agora. Tente de novo em instantes." });
        if (r.status === 402) return json(402, { error: "Créditos de IA esgotados." });
        return json(500, { error: "A IA não conseguiu responder desta vez." });
      }
      const data = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const reply = data.choices?.[0]?.message?.content?.trim() ?? "";
      if (!reply) {
        await captureEdgeError(admin, {
          severity: "warn",
          source: "edge",
          operation: "ai.playground.empty_output",
          tenantId,
          message: "A IA retornou uma resposta vazia.",
          context: { stage_id: stageId },
        });
        return json(500, { error: "A IA retornou uma resposta vazia." });
      }
      return json(200, { reply, system_prompt_preview: systemPrompt });
    } catch (e) {
      // Falha de rede/parse chamando o gateway — sem reportAIFailure nesta
      // function, então vai para captureEdgeError (melhor que console apenas).
      await captureEdgeError(admin, {
        severity: "error",
        source: "edge",
        operation: "ai.playground.gateway",
        tenantId,
        message: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? (e.stack ?? null) : null,
        context: { stage_id: stageId },
      });
      return json(500, {
        error: "Não conseguimos falar com a IA agora — tente novamente em instantes.",
      });
    }
  } catch (e) {
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "ai.playground.handler",
      tenantId,
      message: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? (e.stack ?? null) : null,
    });
    return json(500, { error: "Erro ao gerar preview." });
  }
});
