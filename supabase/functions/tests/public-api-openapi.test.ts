import { createHmac, timingSafeEqual } from "node:crypto";
import { buildOpenApiSpec } from "../_shared/public-api/openapi.ts";
import { NODE_VERIFY_SNIPPET, PYTHON_VERIFY_SNIPPET } from "../_shared/webhooks/docs-snippets.ts";
import {
  GOLDEN_BODY,
  GOLDEN_SECRET,
  GOLDEN_SIGNATURE,
  GOLDEN_TIMESTAMP,
} from "../_shared/webhooks/golden-vector.ts";
import { handleRequest } from "../public-api/handler.ts";
import { listRoutes } from "../public-api/router.ts";
import { tenantScoped } from "../public-api/tenant-scoped.ts";
import type { DbClient } from "../public-api/types.ts";
import { call, makeKit } from "./public-api-test-kit.ts";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];
const INBOUND_PATH = "/inbound-webhook/{rule_id}";
const EVENTS = ["deal.won", "deal.lost", "deal.stage_changed", "contact.created"];

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function specOperations() {
  const spec = buildOpenApiSpec();
  const ops: Array<{
    key: string;
    scope: string | null | undefined;
    operationId: string;
    hasScopeKey: boolean;
  }> = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!HTTP_METHODS.includes(method)) continue;
      // Operação com servers próprio (receptor de entrada) não é rota do router da API pública.
      if (op.servers) continue;
      ops.push({
        key: `${method.toUpperCase()} ${path}`,
        scope: op["x-required-scope"],
        operationId: op.operationId,
        hasScopeKey: "x-required-scope" in op,
      });
    }
  }
  return ops;
}

Deno.test("paridade: todo par metodo+caminho do router existe na spec e vice-versa", () => {
  const routes = listRoutes({ db: tenantScoped({} as DbClient, "t") });
  const registered = routes.map((r) => `${r.method} ${r.path}`).sort();
  const documented = specOperations()
    .map((o) => o.key)
    .sort();
  assert(registered.includes("GET /v1/openapi.json"), "router sem GET /v1/openapi.json");
  assert(
    JSON.stringify(registered) === JSON.stringify(documented),
    `router ${JSON.stringify(registered)} difere da spec ${JSON.stringify(documented)}`,
  );
});

Deno.test("operationId unico e escopo da spec igual ao do router", () => {
  const ops = specOperations();
  const spec = buildOpenApiSpec();
  const ids = [...ops.map((o) => o.operationId), spec.paths[INBOUND_PATH].post.operationId];
  for (const item of Object.values(spec.webhooks)) ids.push(item.post.operationId);
  assert(
    ids.every((id) => typeof id === "string" && id.length > 0),
    "operationId vazio",
  );
  assert(new Set(ids).size === ids.length, `operationId repetido: ${ids.join(",")}`);

  const routes = listRoutes({ db: tenantScoped({} as DbClient, "t") });
  for (const op of ops) {
    assert(op.hasScopeKey, `${op.key} sem x-required-scope`);
    const route = routes.find((r) => `${r.method} ${r.path}` === op.key);
    assert(route !== undefined && route.scope === op.scope, `${op.key} escopo difere do router`);
  }
});

Deno.test("spec: OpenAPI 3.1, apiKey X-Api-Key, schemas, erros e 4 eventos de webhook", () => {
  const spec = buildOpenApiSpec();
  assert(spec.openapi === "3.1.0", "versao");
  assert(spec.servers.length > 0, "servers");
  const scheme = spec.components.securitySchemes.ApiKey;
  assert(
    scheme.type === "apiKey" && scheme.in === "header" && scheme.name === "X-Api-Key",
    "apiKey",
  );
  for (const s of ["Contact", "Deal", "Error", "ContactPage", "DealPage", "WebhookEnvelope"]) {
    assert(s in spec.components.schemas, `schema ${s} ausente`);
  }
  assert(
    JSON.stringify(Object.keys(spec.webhooks).sort()) === JSON.stringify([...EVENTS].sort()),
    "eventos",
  );
  const text = JSON.stringify(spec);
  for (const code of [
    "401",
    "403",
    "404",
    "405",
    "413",
    "422",
    "429",
    "Retry-After",
    "2026-10-20",
  ]) {
    assert(text.includes(code), `spec sem ${code}`);
  }
  assert(!text.includes("deals:write"), "spec ainda cita deals:write sem rota");
  const open = spec.paths["/v1/openapi.json"].get;
  assert(
    Array.isArray(open.security) && open.security.length === 0,
    "openapi.json deve ser publico",
  );
});

Deno.test("spec: envelope lista webhook.test e cada evento documenta o schema de data", () => {
  const spec = buildOpenApiSpec();
  const envelope = spec.components.schemas.WebhookEnvelope as {
    properties: { type: { enum: string[] } };
  };
  assert(envelope.properties.type.enum.includes("webhook.test"), "enum sem webhook.test");
  for (const type of EVENTS)
    assert(envelope.properties.type.enum.includes(type), `enum sem ${type}`);
  const expected: Record<string, string[]> = {
    "deal.won": ["deal", "contact"],
    "deal.lost": ["deal", "contact"],
    "deal.stage_changed": [
      "history_id",
      "deal_id",
      "from_stage_id",
      "to_stage_id",
      "changed_by_user_id",
      "changed_by_automation",
    ],
    "contact.created": ["contact_id", "status", "owner_id"],
  };
  const schemas = spec.components.schemas as Record<
    string,
    { properties?: Record<string, unknown> }
  >;
  for (const [type, keys] of Object.entries(expected)) {
    const body = JSON.stringify(spec.webhooks[type].post.requestBody);
    const match = body.match(/#\/components\/schemas\/(\w+Data)/);
    assert(match !== null, `${type} sem schema de data`);
    const props = Object.keys(schemas[match![1]].properties ?? {});
    assert(
      JSON.stringify(props.sort()) === JSON.stringify([...keys].sort()),
      `${type}: ${props.join(",")}`,
    );
  }
  const deal = schemas.DealClosedData.properties!.deal as { properties: Record<string, unknown> };
  for (const k of [
    "id",
    "title",
    "value",
    "currency",
    "board_id",
    "board_name",
    "stage_id",
    "stage_name",
    "closed_at",
  ]) {
    assert(k in deal.properties, `deal.${k} ausente`);
  }
});

Deno.test(
  "spec: sem operações de fechar negócio; avisa deal.won e deal.lost por webhook; /v1/me declara 403",
  () => {
    const spec = buildOpenApiSpec();
    assert(!("/v1/deals/{id}/won" in spec.paths), "won ainda documentado");
    assert(!("/v1/deals/{id}/lost" in spec.paths), "lost ainda documentado");
    const text = JSON.stringify(spec);
    assert(
      !text.includes("markDealWon") && !text.includes("markDealLost"),
      "operationId de fechar negócio",
    );
    const info = JSON.stringify(spec.info);
    assert(info.includes("deal.won") && info.includes("deal.lost"), "info sem aviso por webhook");
    assert(info.includes("não está disponível"), "info sem a frase de fechar por API indisponível");
    assert("403" in spec.paths["/v1/me"].get.responses, "/v1/me sem 403 tenant_inactive");
  },
);

Deno.test(
  "spec: receptor de entrada sem API key, servers próprio e respostas 200/400/401/413/429/503",
  () => {
    const spec = buildOpenApiSpec();
    const item = spec.paths[INBOUND_PATH];
    assert(item !== undefined, "path de entrada ausente");
    const post = item.post;
    assert(
      Array.isArray(post.security) && post.security.length === 0,
      "entrada não pode exigir X-Api-Key",
    );
    assert(post["x-required-scope"] === null, "entrada sem escopo");
    assert(
      JSON.stringify(post.servers) ===
        JSON.stringify([
          {
            url: "https://SEU-PROJETO.supabase.co/functions/v1",
            description: post.servers![0].description,
          },
        ]),
      "servers do receptor",
    );
    const codes = Object.keys(post.responses).sort();
    assert(
      JSON.stringify(codes) === JSON.stringify(["200", "400", "401", "413", "429", "503"]),
      `respostas ${codes}`,
    );
    const headers = (post.responses["429"] as { headers?: Record<string, unknown> }).headers ?? {};
    assert("Retry-After" in headers, "429 sem Retry-After");
    const text = JSON.stringify(post);
    assert(!text.includes("202"), "entrada não usa 202");
    for (const word of [
      "X-Aceleraflow-Signature",
      "Stripe-Signature",
      "asaas-access-token",
      "X-HOTMART-HOTTOK",
      "64 KB",
      "120",
    ]) {
      assert(text.includes(word), `descrição sem ${word}`);
    }
    // Nenhum gateway garante reenvio depois de 401 (spike §1.3, §2.3, §3.3): a spec não promete.
    for (const promise of [
      "reenviar quando ela voltar",
      "O gateway deve reenviar",
      "guardar e reenviar",
    ]) {
      assert(!text.includes(promise), `spec promete reenvio: ${promise}`);
    }
    assert(
      text.includes("o comportamento de reenvio depende do gateway"),
      "spec sem aviso de reenvio",
    );
    assert(text.includes("padrão 30"), "429 sem o limite de ações por minuto");
    // Nada interno na spec pública.
    for (const word of [
      "service_role",
      "vault",
      "process_inbound_event",
      "get_inbound_rule_auth",
      "inbound-req:",
    ]) {
      assert(!JSON.stringify(spec).includes(word), `spec vaza ${word}`);
    }
    const params = JSON.stringify(post.parameters);
    assert(params.includes("rule_id") && params.includes('"in":"path"'), "parâmetro rule_id");
  },
);

// v2.1 (Task B): depois de autenticar, gateway responde 200 ignored; aceleraflow_hmac mantém 400.
Deno.test("spec: receptor documenta 200 ignored nos gateways e 400 só no HMAC", () => {
  const post = buildOpenApiSpec().paths[INBOUND_PATH].post;
  const ok = post.responses["200"] as {
    description: string;
    content: {
      "application/json": { schema: { properties: Record<string, { enum?: string[] }> } };
    };
  };
  const ignored = ok.content["application/json"].schema.properties.ignored;
  assert(ignored !== undefined, "200 sem a propriedade ignored");
  assert(
    JSON.stringify(ignored.enum) ===
      JSON.stringify(["invalid_json", "invalid_payload", "missing_event_id"]),
    `motivos de ignored: ${JSON.stringify(ignored.enum)}`,
  );
  for (const word of ["stripe_signature", "header_token"]) {
    assert(ok.description.includes(word), `200 não cita ${word}`);
  }
  const bad = (post.responses["400"] as { description: string }).description;
  assert(bad.includes("aceleraflow_hmac"), "400 não diz que é do modo aceleraflow_hmac");
  assert(bad.includes("UTF-8"), "400 sem o caso de UTF-8 inválido (todos os modos)");
  assert(post.description!.includes("200 com ignored"), "descrição sem o comportamento por modo");
});

Deno.test("GET /v1/openapi.json responde 200 sem chave e sem tocar o banco", async () => {
  const { deps, rpcs, queries } = await makeKit();
  const res = await handleRequest(call("/v1/openapi.json", { token: null }), deps);
  assert(res.status === 200, `status ${res.status}`);
  const body = await res.json();
  assert(body.openapi === "3.1.0", "corpo nao e a spec");
  assert(rpcs.length === 0 && queries.length === 0, "nao deve consultar banco");
  assert(!JSON.stringify(body).includes("aaaaaaaa-0000"), "sem dados de tenant");
});

// Trecho Node: executado de verdade com o vetor dourado.
function loadNodeVerifier(): (
  s: string,
  h: string,
  b: string,
  tol?: number,
  now?: number,
) => boolean {
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  const requireStub = (name: string) => {
    if (name !== "node:crypto") throw new Error(`require inesperado: ${name}`);
    return { createHmac, timingSafeEqual };
  };
  new Function("require", "module", NODE_VERIFY_SNIPPET)(requireStub, mod);
  return mod.exports.verifyAceleraflowSignature as ReturnType<typeof loadNodeVerifier>;
}

const GOLDEN_HEADER = `t=${GOLDEN_TIMESTAMP},${GOLDEN_SIGNATURE}`;
const GOLDEN_NOW_MS = GOLDEN_TIMESTAMP * 1000;

Deno.test("trecho Node: aceita valida, rejeita adulterada e fora da tolerancia", () => {
  const verify = loadNodeVerifier();
  assert(
    verify(GOLDEN_SECRET, GOLDEN_HEADER, GOLDEN_BODY, 300, GOLDEN_NOW_MS),
    "valida deveria passar",
  );
  assert(
    !verify(GOLDEN_SECRET, GOLDEN_HEADER, GOLDEN_BODY + " ", 300, GOLDEN_NOW_MS),
    "corpo adulterado",
  );
  assert(
    !verify("outro_segredo", GOLDEN_HEADER, GOLDEN_BODY, 300, GOLDEN_NOW_MS),
    "segredo errado",
  );
  assert(
    !verify(GOLDEN_SECRET, GOLDEN_HEADER, GOLDEN_BODY, 300, GOLDEN_NOW_MS + 301_000),
    "fora da tolerancia",
  );
  assert(
    verify(GOLDEN_SECRET, GOLDEN_HEADER, GOLDEN_BODY, 300, GOLDEN_NOW_MS + 300_000),
    "limite deveria passar",
  );
  const rotated = `t=${GOLDEN_TIMESTAMP},v1=${"0".repeat(64)},${GOLDEN_SIGNATURE}`;
  assert(verify(GOLDEN_SECRET, rotated, GOLDEN_BODY, 300, GOLDEN_NOW_MS), "dois v1 (rotacao)");
  assert(!verify(GOLDEN_SECRET, "lixo", GOLDEN_BODY, 300, GOLDEN_NOW_MS), "header invalido");
});

async function pythonAvailable(): Promise<boolean> {
  try {
    return (await new Deno.Command("python3", { args: ["-I", "--version"] }).output()).success;
  } catch {
    return false;
  }
}

Deno.test("trecho Python: sintaxe valida e aceita/rejeita o vetor dourado", async () => {
  if (!(await pythonAvailable())) {
    console.warn("AVISO: python3 ausente ou sem --allow-run, teste do trecho Python pulado");
    return;
  }
  const check = [
    `H = ${JSON.stringify(GOLDEN_HEADER)}`,
    `B = ${JSON.stringify(GOLDEN_BODY)}`,
    `S = ${JSON.stringify(GOLDEN_SECRET)}`,
    `N = ${GOLDEN_TIMESTAMP}`,
    "assert verify_aceleraflow_signature(S, H, B, now=N)",
    "assert verify_aceleraflow_signature(S, H, B.encode(), now=N)",
    "assert not verify_aceleraflow_signature(S, H, B + ' ', now=N)",
    "assert not verify_aceleraflow_signature(S, H, B, now=N + 301)",
    "print('ok')",
  ].join("\n");
  const child = new Deno.Command("python3", {
    args: ["-I", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(`${PYTHON_VERIFY_SNIPPET}\n${check}\n`));
  await writer.close();
  const out = await child.output();
  assert(out.success, `python falhou: ${new TextDecoder().decode(out.stderr)}`);
});
