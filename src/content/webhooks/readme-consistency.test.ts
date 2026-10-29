// Confere fatos do README de webhooks contra o código-fonte, para a documentação não envelhecer.
// Mudou um limite, um evento, um código HTTP ou um modelo? Este teste fica vermelho até o
// README ser atualizado no mesmo commit.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  NODE_VERIFY_SNIPPET,
  PYTHON_VERIFY_SNIPPET,
} from "@/components/settings/developer/verify-snippets";
import { INBOUND_PRESETS } from "@/lib/inbound-presets";
import { parseMarkdown, type MdBlock } from "@/lib/markdown-lite";

const ROOT = process.cwd();
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

const README = read("src/content/webhooks/README.md");
const BLOCKS = parseMarkdown(README);
const MIGRATIONS = readdirSync(resolve(ROOT, "supabase/migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => read(`supabase/migrations/${f}`));

function num(source: string, re: RegExp): number {
  const m = re.exec(source);
  if (!m) throw new Error(`padrão não encontrado: ${re}`);
  return Number(m[1]);
}

/** Corpo da última definição da função SQL (migrations em ordem), para pegar a versão vigente. */
function lastSqlArray(fn: string): string[] {
  const re = new RegExp(`function public\\.${fn}\\(\\)[\\s\\S]*?array\\[([^\\]]*)\\]`, "g");
  const all = MIGRATIONS.flatMap((sql) => [...sql.matchAll(re)].map((m) => m[1]));
  if (all.length === 0) throw new Error(`função ${fn} não encontrada nas migrations`);
  return [...all[all.length - 1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
}

/** Corpo ($$ … $$) da última definição da função SQL nas migrations em ordem: a versão vigente. */
function lastSqlBody(fn: string): string {
  // Ancorado em "create or replace": "revoke … on function public.x(" não é definição.
  const re = new RegExp(
    `create or replace function public\\.${fn}\\([\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$`,
    "gi",
  );
  const all = MIGRATIONS.flatMap((sql) => [...sql.matchAll(re)].map((m) => m[1]));
  if (all.length === 0) throw new Error(`função ${fn} não encontrada nas migrations`);
  return all[all.length - 1];
}

/** Número da última ocorrência do padrão nas migrations em ordem (primeiro grupo que casou). */
function lastNum(re: RegExp): number {
  const all = MIGRATIONS.flatMap((sql) =>
    [...sql.matchAll(new RegExp(re.source, "g"))].map((m) => Number(m.slice(1).find(Boolean))),
  );
  if (all.length === 0) throw new Error(`padrão não encontrado nas migrations: ${re}`);
  return all[all.length - 1];
}

/** Primeira coluna da primeira tabela depois do título indicado, sem crases. */
function firstColumnAfter(headingText: string): string[] {
  const start = BLOCKS.findIndex((b) => b.type === "heading" && b.text === headingText);
  if (start < 0) throw new Error(`título "${headingText}" não encontrado no README`);
  const table = BLOCKS.slice(start).find(
    (b): b is Extract<MdBlock, { type: "table" }> => b.type === "table",
  );
  if (!table) throw new Error(`tabela depois de "${headingText}" não encontrada`);
  return table.rows.map((r) => r[0].replace(/`/g, "").trim());
}

function codeBlocks(lang: string): string[] {
  return BLOCKS.flatMap((b) => (b.type === "code" && b.lang === lang ? [b.code] : []));
}

// Espaços colapsados: o prettier alinha as tabelas com espaços variáveis.
const FLAT = README.replace(/[ \t]+/g, " ");
const has = (text: string) => FLAT.includes(text);

describe("README de webhooks x código", () => {
  it("eventos de saída = public.webhook_allowed_event_types() vigente", () => {
    expect([...firstColumnAfter("Eventos disponíveis")].sort()).toEqual(
      lastSqlArray("webhook_allowed_event_types"),
    );
  });

  it("escopos da API = public.api_allowed_scopes() vigente", () => {
    expect([...firstColumnAfter("Chaves")].sort()).toEqual(lastSqlArray("api_allowed_scopes"));
  });

  it("códigos HTTP da tabela = respostas do handler de entrada (sem o 204 do OPTIONS)", () => {
    const handler = read("supabase/functions/inbound-webhook/handler.ts");
    const codes = new Set([...handler.matchAll(/respond\((\d{3})/g)].map((m) => m[1]));
    codes.delete("204");
    expect([...firstColumnAfter("Respostas HTTP e limites")].sort()).toEqual([...codes].sort());
  });

  it("limites da entrada batem com o código", () => {
    const handler = read("supabase/functions/inbound-webhook/handler.ts");
    const form = read("src/components/settings/developer/inbound-rule-form.ts");
    const verify = read("supabase/functions/_shared/inbound/verify.ts");
    const perMinute = num(form, /DEFAULT_MAX_PER_MINUTE = (\d+)/);
    const perDay = num(form, /DEFAULT_MAX_PER_DAY = (\d+)/);
    const reqPerMinute = num(handler, /RATE_LIMIT_MAX = (\d+)/);
    const bodyKb = num(verify, /INBOUND_MAX_BODY_BYTES = (\d+) \* 1024/);
    const retentionDays = num(
      read("supabase/migrations/20261021140000_inbound_retention_cron.sql"),
      /c_retention constant interval := interval '(\d+) days'/,
    );
    expect(has(`| ${perMinute} por padrão`)).toBe(true);
    expect(has(`| ${perDay} nas últimas 24 horas por padrão`)).toBe(true);
    expect(has(`| ${perMinute} / ${perDay} por padrão`)).toBe(true);
    expect(has(`| ${reqPerMinute} (contadas só depois`)).toBe(true);
    expect(has(`| ${bodyKb} KB`)).toBe(true);
    expect(has(`últimos ${retentionDays} dias`)).toBe(true);
  });

  it("assinatura, tolerância, versão e entrega de saída batem com o código", () => {
    const sign = read("supabase/functions/_shared/webhooks/sign.ts");
    const runner = read("supabase/functions/webhook-delivery-worker/runner.ts");
    const backoff = read("supabase/functions/_shared/webhooks/backoff.ts");
    const envelope = read("supabase/functions/_shared/webhooks/envelope.ts");
    const maxAttempts = lastNum(
      /create table (?:if not exists )?public\.webhook_deliveries[^;]*?max_attempts integer not null default (\d+)|public\.webhook_deliveries\s+alter column max_attempts set default (\d+)/,
    );
    const maxEndpoints = num(lastSqlBody("create_webhook_endpoint"), /'limite de (\d+) endpoints/);

    const tolerance = num(sign, /DEFAULT_TOLERANCE_SECONDS = (\d+)/);
    expect(has(`| Tolerância de horário | ${tolerance} segundos`)).toBe(true);
    expect(has(`a mais de ${tolerance} segundos`)).toBe(true);
    expect(has(`\`${/API_VERSION = "([^"]+)"/.exec(envelope)?.[1]}\``)).toBe(true);
    expect(has(`| ${num(runner, /DELIVERY_TIMEOUT_MS = (\d+)_000/)} segundos`)).toBe(true);
    expect(has(`Corpo acima de ${num(runner, /MAX_PAYLOAD_BYTES = (\d+) \* 1024/)} KB`)).toBe(true);
    expect(has(`São até ${maxAttempts} tentativas`)).toBe(true);
    expect(has(`| Tentativas de entrega (saída) | Até ${maxAttempts},`)).toBe(true);
    expect(has(`Até ${maxEndpoints} webhooks por conta`)).toBe(true);
    expect(has(`| Webhooks de saída por conta | ${maxEndpoints} |`)).toBe(true);

    const human = (s: number) => (s < 3600 ? `${s / 60} min` : `${s / 3600} h`);
    const steps = /\[([\d, ]+)\]/
      .exec(backoff)?.[1]
      .split(",")
      .map((s) => human(Number(s)));
    if (!steps) throw new Error("BACKOFF_STEPS_SECONDS não encontrado");
    const sentence = `${steps.slice(0, -1).join(", ")} e depois ${steps[steps.length - 1]}`;
    expect(has(sentence)).toBe(true);
  });

  it("rotação de segredo: 24 horas nas duas direções", () => {
    const grace = /previous_secret_expires_at = now\(\) \+ interval '(\d+) hours'/;
    const hours = num(lastSqlBody("rotate_webhook_endpoint_secret"), grace);
    expect(num(lastSqlBody("rotate_inbound_rule_secret"), grace)).toBe(hours);
    expect(has(`O anterior continua válido por ${hours} horas`)).toBe(true);
    expect(has(`| Validade do segredo anterior | ${hours} horas após a rotação`)).toBe(true);
    const maxRules = num(lastSqlBody("create_inbound_rule"), /'limite de (\d+) regras/);
    expect(has(`Até ${maxRules} regras de entrada por conta`)).toBe(true);
    expect(has(`| Regras por conta | ${maxRules} |`)).toBe(true);
    expect(has(`| Regras de entrada por conta | ${maxRules} |`)).toBe(true);
  });

  it("detalhes da entrega de saída, das regras e da paginação batem com o código", () => {
    const runner = read("supabase/functions/webhook-delivery-worker/runner.ts");
    const page = read("supabase/functions/public-api/pagination.ts");
    expect(has(`(até ${num(runner, /MAX_EXCERPT_BYTES = (\d+)/) / 1024} KB)`)).toBe(true);
    expect(has(`\`${/USER_AGENT = "([^"]+)"/.exec(runner)?.[1]}\``)).toBe(true);
    expect(runner).toContain("res.status === 410");
    expect(has("respondeu `410`")).toBe(true);
    const maxLimit = num(page, /MAX_LIMIT = (\d+)/);
    expect(has(`\`limit\` de 1 a ${maxLimit} (padrão ${num(page, /DEFAULT_LIMIT = (\d+)/)};`)).toBe(
      true,
    );
    expect(has(`acima de ${maxLimit} vale ${maxLimit}`)).toBe(true);
    expect(
      has(`Até ${lastNum(/jsonb_array_length\(p_conditions\) > (\d+)/)} condições por regra`),
    ).toBe(true);
    expect(
      has(`(1 a ${lastNum(/jsonb_array_length\(v_cond -> 'in'\) not between 1 and (\d+)/)} itens)`),
    ).toBe(true);
    expect(
      has(`de 1 a ${lastNum(/cardinality\(p_allowed_stage_ids\) not between 1 and (\d+)/)} etapas`),
    ).toBe(true);
    // v2.2: o teto que o admin consegue gravar é o de set_inbound_rule_limits (o check da
    // tabela vai além, até 300/min); a tela usa os mesmos tetos.
    const limitsBody = lastSqlBody("set_inbound_rule_limits");
    const minuteCap = num(limitsBody, /c_minute_cap constant integer := (\d+)/);
    const dayCap = num(limitsBody, /c_day_cap constant integer := (\d+)/);
    const api = read("src/lib/api/inbound-rules.ts");
    expect(num(api, /MAX_LIMIT_PER_MINUTE = (\d+)/)).toBe(minuteCap);
    expect(num(api, /MAX_LIMIT_PER_DAY = (\d+)/)).toBe(dayCap);
    expect(has(`(configurável de 1 a ${minuteCap})`)).toBe(true);
    expect(has(`(configurável de 1 a ${dayCap};`)).toBe(true);
    expect(has(`O limite por minuto vai até ${minuteCap}`)).toBe(true);
    const secret = /char_length\(p_secret\) not between (\d+) and (\d+)/;
    const lastSecret = MIGRATIONS.flatMap((sql) => [...sql.matchAll(new RegExp(secret, "g"))]).at(
      -1,
    );
    if (!lastSecret) throw new Error("limite do segredo não encontrado");
    expect(has(`de ${lastSecret[1]} a ${lastSecret[2]} caracteres`)).toBe(true);
    const handler = read("supabase/functions/inbound-webhook/handler.ts");
    const reserved = /RESERVED_TOKEN_HEADERS = new Set\(\[([^\]]*)\]/.exec(handler)?.[1] ?? "";
    const headers = [...reserved.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(headers.length).toBeGreaterThan(3);
    for (const h of headers) expect(has(`\`${h}\``), h).toBe(true);
  });

  it("API pública: limite por chave e códigos de erro da OpenAPI", () => {
    const auth = read("supabase/functions/public-api/auth.ts");
    const max = num(auth, /RATE_LIMIT_MAX = (\d+)/);
    const windowS = num(auth, /RATE_LIMIT_WINDOW_SECONDS = (\d+)/);
    expect(has(`| ${max} a cada ${windowS} segundos`)).toBe(true);
    const openapi = read("supabase/functions/_shared/public-api/openapi.ts");
    const enumBlock = /enum: \[\s*("auth_missing"[\s\S]*?)\]/.exec(openapi)?.[1] ?? "";
    const codes = [...enumBlock.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThan(5);
    for (const code of codes) expect(has(`\`${code}\``), code).toBe(true);
  });

  it("todos os modelos de entrada aparecem com nome, header e caminhos", () => {
    for (const preset of INBOUND_PRESETS) {
      expect(has(preset.label), preset.label).toBe(true);
      expect(has(`\`${preset.verificationMode}\``), preset.id).toBe(true);
      expect(has(`\`${preset.matchPath}\``), preset.id).toBe(true);
      expect(has(`\`${preset.eventIdPath}\``), `${preset.id}: id do evento`).toBe(true);
      if (preset.matchFallbackPath)
        expect(has(`\`${preset.matchFallbackPath}\``), `${preset.id}: alternativo`).toBe(true);
      if (preset.tokenHeaderName)
        expect(has(`\`${preset.tokenHeaderName}\``), preset.id).toBe(true);
      for (const c of preset.conditions) {
        const values = "in" in c ? c.in : [c.equals];
        for (const v of values) expect(has(`\`${v}\``), `${preset.id}: ${v}`).toBe(true);
      }
    }
  });

  it("v2.2: caminho alternativo, motivos de ignorado e reprocesso documentados", () => {
    // assert_inbound_rule_config é private.*: a última definição precisa aceitar a chave.
    const asserts = MIGRATIONS.flatMap((sql) => [
      ...sql.matchAll(
        /create or replace function private\.assert_inbound_rule_config\([\s\S]*?\$\$([\s\S]*?)\$\$/gi,
      ),
    ]);
    expect(asserts.at(-1)?.[1]).toContain("match_fallback_path");
    expect(has("`match_fallback_path`")).toBe(true);
    const reasons = /p_reason not in \(([^)]*)\)/.exec(lastSqlBody("record_inbound_ignored"))?.[1];
    if (!reasons) throw new Error("lista de motivos de record_inbound_ignored não encontrada");
    for (const r of reasons.matchAll(/'([^']+)'/g)) expect(has(`\`${r[1]}\``), r[1]).toBe(true);
    // Status que reprocessam = os do update de reprocesso em process_inbound_event.
    const process = lastSqlBody("process_inbound_event");
    expect(process).toMatch(/e\.status in \('failed', 'rate_limited', 'not_found', 'ambiguous'\)/);
    expect(process).toMatch(/e\.status = 'ignored' and e\.extracted ->> 'conditions_ok' = 'false'/);
    for (const label of ["Falhou", "Limite atingido", "Não encontrado", "Ambíguo"]) {
      expect(has(`**${label}**`), label).toBe(true);
    }
    expect(has("**Ignorado** porque as condições não casaram")).toBe(true);
  });

  it("exemplos de verificação = verify-snippets (paridade com o Deno)", () => {
    expect(codeBlocks("js")).toEqual([NODE_VERIFY_SNIPPET.trimEnd()]);
    expect(codeBlocks("python")).toEqual([PYTHON_VERIFY_SNIPPET.trimEnd()]);
  });

  it("toda âncora interna existe e as âncoras da tela estão no README", () => {
    const ids = new Set(BLOCKS.flatMap((b) => (b.type === "heading" ? [b.id] : [])));
    for (const id of ["comece", "saida", "assinatura", "entrada"])
      expect(ids.has(id), id).toBe(true);
    const links = [...README.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(5);
    for (const link of links) expect(ids.has(link), link).toBe(true);
  });

  it("sem segredo, chave ou id de projeto reais", () => {
    expect(README).not.toMatch(/acf_live_(?!EXEMPLO_NAO_USE)[A-Za-z0-9_-]{8,}/);
    expect(README).not.toMatch(/https:\/\/(?!SEU-PROJETO)[a-z0-9]{20}\.supabase\.co/);
    expect(README).not.toMatch(/sb_publishable_|eyJ[A-Za-z0-9]{10,}/);
    expect(README).not.toMatch(/whsec_[0-9a-f]{16,}|whin_[0-9a-f]{16,}/);
  });
});
