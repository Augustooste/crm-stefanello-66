// Banco falso para a edge inbound-webhook. Lição C1 (v1): mock que não conhece o
// schema esconde bug. Este kit lê das migrations reais:
// - nome e parâmetros de cada RPC usada (a última migration que define vence);
// - colunas do `returns table` de get_inbound_rule_auth;
// - chaves e valores de `status` que process_inbound_event devolve.
// Nome de função ou parâmetro que não existe dá PGRST202, como o PostgREST.
import type { InboundDeps } from "../inbound-webhook/handler.ts";

const MIGRATIONS_DIR = new URL("../../migrations/", import.meta.url);
const RPCS = [
  "get_inbound_rule_auth",
  "process_inbound_event",
  "check_and_record_rate_limit",
  "record_inbound_ignored",
] as const;
type RpcName = (typeof RPCS)[number];

export interface FnSignature {
  params: string[];
  returnsColumns: string[] | null;
  body: string;
}

/** Divide por vírgula de nível zero (ignora vírgulas dentro de parênteses e aspas). */
function splitTopLevel(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = "";
  for (const ch of src) {
    if (ch === "'") quoted = !quoted;
    if (!quoted && ch === "(") depth++;
    if (!quoted && ch === ")") depth--;
    if (!quoted && depth === 0 && ch === ",") {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Texto entre o "(" em `start` e o ")" que o fecha. */
function balanced(src: string, start: number): string {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "(") depth++;
    if (src[i] === ")" && --depth === 0) return src.slice(start + 1, i);
  }
  throw new Error("parênteses sem fechamento na migration");
}

const firstWord = (s: string) => s.trim().split(/\s+/)[0].toLowerCase();

async function loadSignatures(): Promise<Map<RpcName, FnSignature>> {
  const files: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS_DIR))
    if (e.name.endsWith(".sql")) files.push(e.name);
  files.sort();
  const found = new Map<RpcName, FnSignature>();
  for (const file of files) {
    const sql = await Deno.readTextFile(new URL(file, MIGRATIONS_DIR));
    const re = /create\s+or\s+replace\s+function\s+public\.(\w+)\s*\(/gi;
    for (let m = re.exec(sql); m; m = re.exec(sql)) {
      const name = m[1].toLowerCase() as RpcName;
      if (!RPCS.includes(name)) continue;
      const open = m.index + m[0].length - 1;
      const args = balanced(sql, open);
      const after = sql.slice(open + args.length + 2);
      const table = after.match(/^\s*returns\s+table\s*\(/i);
      const returnsColumns = table
        ? splitTopLevel(balanced(after, table[0].length - 1)).map(firstWord)
        : null;
      const bodyStart = after.indexOf("$$");
      const body = after.slice(bodyStart + 2, after.indexOf("$$", bodyStart + 2));
      found.set(name, {
        params: args.trim() ? splitTopLevel(args).map(firstWord) : [],
        returnsColumns,
        body,
      });
    }
  }
  for (const name of RPCS) if (!found.has(name)) throw new Error(`migration sem ${name}`);
  return found;
}

/** Chaves e valores de status que `return jsonb_build_object(...)` produz no corpo. */
function processReturnShape(body: string): { keys: Set<string>; statuses: Set<string> } {
  const keys = new Set<string>();
  const statuses = new Set<string>();
  const re = /return\s+jsonb_build_object\s*\(/gi;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const args = splitTopLevel(balanced(body, m.index + m[0].length - 1));
    for (let i = 0; i + 1 < args.length; i += 2) {
      const key = args[i].replace(/^'|'$/g, "");
      keys.add(key);
      if (key === "status") {
        for (const lit of args[i + 1].matchAll(/'([a-z_]+)'/g)) statuses.add(lit[1]);
      }
    }
  }
  return { keys, statuses };
}

export const SIGNATURES = await loadSignatures();
export const PROCESS_SHAPE = processReturnShape(SIGNATURES.get("process_inbound_event")!.body);
/** Motivos aceitos por record_inbound_ignored, lidos do `p_reason not in (...)` da migration. */
export const IGNORED_REASONS = new Set(
  [
    ...(
      SIGNATURES.get("record_inbound_ignored")!.body.match(
        /p_reason\s+not\s+in\s*\(([^)]*)\)/i,
      )?.[1] ?? ""
    ).matchAll(/'([a-z_]+)'/g),
  ].map((m) => m[1]),
);

export const RULE_ID = "11111111-0000-4000-8000-000000000001";
export const TENANT_ID = "aaaaaaaa-0000-4000-8000-00000000000a";
export const HMAC_SECRET = "whin_SEGREDO_DE_TESTE_0123456789abcdef0123456789abcdef";

export type AuthRow = Record<string, unknown>;

export function hmacRule(overrides: AuthRow = {}): AuthRow {
  return {
    tenant_id: TENANT_ID,
    active: true,
    verification_mode: "aceleraflow_hmac",
    token_header_name: null,
    current_secret: HMAC_SECRET,
    previous_secret: null,
    ...overrides,
  };
}

export interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

export interface InboundKitOptions {
  /** Linha de get_inbound_rule_auth; null = regra inexistente (0 linhas). */
  rule?: AuthRow | null;
  rateLimit?: { allowed: boolean; retryAfterSeconds: number };
  process?: Record<string, unknown>;
  /** RPC que devolve `error` do supabase-js. */
  errorOn?: { fn: string; code?: string };
  /** RPC cuja promessa rejeita (rede/abort). */
  rejectOn?: string;
  nowMs?: number;
}

type RpcResult = { data: unknown; error: { code?: string; message: string } | null };

export function makeInboundKit(options: InboundKitOptions = {}) {
  const rule = options.rule === undefined ? hmacRule() : options.rule;
  if (rule) {
    const cols = SIGNATURES.get("get_inbound_rule_auth")!.returnsColumns!;
    const wrong = Object.keys(rule).filter((k) => !cols.includes(k));
    if (wrong.length)
      throw new Error(`fixture com coluna que a RPC não devolve: ${wrong.join(",")}`);
  }
  const processed = options.process ?? { status: "processed", inbound_event_id: "e-1" };
  const badKeys = Object.keys(processed).filter((k) => !PROCESS_SHAPE.keys.has(k));
  if (badKeys.length)
    throw new Error(`fixture de process com chave inexistente: ${badKeys.join(",")}`);

  const rpcs: RpcCall[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const nowMs = options.nowMs ?? 1_792_500_000_000;

  function rpc(name: string, params: Record<string, unknown>): Promise<RpcResult> {
    rpcs.push({ fn: name, args: params });
    const sig = SIGNATURES.get(name as RpcName);
    const given = Object.keys(params).sort().join(",");
    if (!sig || given !== [...sig.params].sort().join(",")) {
      return Promise.resolve({
        data: null,
        error: {
          code: "PGRST202",
          message: `Could not find the function public.${name}(${given})`,
        },
      });
    }
    if (options.rejectOn === name) return Promise.reject(new Error("AbortError: segredo-do-erro"));
    if (options.errorOn?.fn === name) {
      return Promise.resolve({
        data: null,
        error: {
          code: options.errorOn.code ?? "40P01",
          message: "deadlock detected DETAIL interno secreto",
        },
      });
    }
    switch (name as RpcName) {
      case "get_inbound_rule_auth":
        return Promise.resolve({ data: rule ? [rule] : [], error: null });
      case "check_and_record_rate_limit":
        return Promise.resolve({
          data: options.rateLimit ?? { allowed: true, retryAfterSeconds: 0 },
          error: null,
        });
      case "process_inbound_event":
        return Promise.resolve({ data: processed, error: null });
      case "record_inbound_ignored":
        // Motivo fora do `not in (...)` da migration dá 22023, como o Postgres.
        if (!IGNORED_REASONS.has(String(params.p_reason))) {
          return Promise.resolve({
            data: null,
            error: { code: "22023", message: "motivo invalido" },
          });
        }
        return Promise.resolve({ data: null, error: null });
    }
    throw new Error("inalcançável");
  }

  const deps: InboundDeps = {
    db: { rpc },
    log: (entry) => logs.push(entry),
    now: () => nowMs,
  };
  return { deps, rpcs, logs, nowMs };
}
