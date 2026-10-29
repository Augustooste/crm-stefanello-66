// Edge inbound-webhook (regras de entrada v2, Task 6). Contrato: task-4-review §G, D7, D8.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { handleInbound } from "../inbound-webhook/handler.ts";
import { signWebhook } from "../_shared/webhooks/sign.ts";
import {
  HMAC_SECRET,
  hmacRule,
  type InboundKitOptions,
  makeInboundKit,
  IGNORED_REASONS,
  PROCESS_SHAPE,
  RULE_ID,
  SIGNATURES,
} from "./inbound-test-kit.ts";

const EMAIL = "cliente.secreta@example.com";
const BODY = JSON.stringify({ id: "evt_1", type: "pagamento.aprovado", email: EMAIL });
const ASAAS_TOKEN = "asaas_token_fixo_de_teste_com_32_chars_ok";
const UNAUTHORIZED = '{"error":"unauthorized"}';

async function signed(body: string, nowMs: number, secret = HMAC_SECRET): Promise<string> {
  const t = Math.floor(nowMs / 1000);
  return `t=${t},${await signWebhook(secret, t, body)}`;
}

function request(
  init: {
    body?: BodyInit | null;
    headers?: Record<string, string>;
    method?: string;
    path?: string;
  } = {},
): Request {
  return new Request(`http://fn.local/functions/v1/inbound-webhook/${init.path ?? RULE_ID}`, {
    method: init.method ?? "POST",
    headers: { "content-type": "application/json", ...init.headers },
    body: init.body === undefined ? BODY : init.body,
  });
}

async function call(
  options: InboundKitOptions,
  build: (nowMs: number) => Promise<Request> | Request,
) {
  const kit = makeInboundKit(options);
  const res = await handleInbound(await build(kit.nowMs), kit.deps);
  return { kit, res, text: res.status === 204 ? "" : await res.text() };
}

const validReq =
  (body = BODY) =>
  async (now: number) =>
    request({ body, headers: { "X-Aceleraflow-Signature": await signed(body, now) } });

/** Corpo sem o request_id, para comparar respostas de sucesso entre si. */
const withoutRequestId = (text: string) => {
  const { request_id: _id, ...rest } = JSON.parse(text);
  return JSON.stringify(rest);
};

Deno.test("kit: assinaturas lidas das migrations reais", () => {
  assertEquals(SIGNATURES.get("get_inbound_rule_auth")!.params, ["p_rule_id"]);
  assertEquals(SIGNATURES.get("process_inbound_event")!.params, ["p_rule_id", "p_payload"]);
  assertEquals(SIGNATURES.get("check_and_record_rate_limit")!.params, [
    "p_key",
    "p_max_calls",
    "p_window_seconds",
  ]);
  assertEquals(SIGNATURES.get("record_inbound_ignored")!.params, ["p_rule_id", "p_reason"]);
  assertEquals(SIGNATURES.get("get_inbound_rule_auth")!.returnsColumns, [
    "tenant_id",
    "active",
    "verification_mode",
    "token_header_name",
    "current_secret",
    "previous_secret",
  ]);
  for (const s of [
    "inactive",
    "missing_event_id",
    "processed",
    "duplicate",
    "ignored",
    "not_found",
    "ambiguous",
    "failed",
    "rate_limited",
  ]) {
    assert(PROCESS_SHAPE.statuses.has(s), `status ${s} na migration`);
  }
  for (const k of ["status", "inbound_event_id", "reason", "retry_after_seconds"]) {
    assert(PROCESS_SHAPE.keys.has(k), `chave ${k} na migration`);
  }
});

Deno.test("kit: recusa função ou parâmetro inexistente com PGRST202", async () => {
  const { deps } = makeInboundKit();
  const wrongParam = await deps.db.rpc("process_inbound_event", {
    rule_id: RULE_ID,
    p_payload: {},
  });
  assertEquals(wrongParam.error?.code, "PGRST202");
  // Ruling T6-2: a RPC não tem p_excerpt; mandar o "excerpt de 2048" do brief quebraria em produção.
  const extra = await deps.db.rpc("process_inbound_event", {
    p_rule_id: RULE_ID,
    p_payload: {},
    p_excerpt: "x",
  });
  assertEquals(extra.error?.code, "PGRST202");
  const missing = await deps.db.rpc("get_inbound_rule_auth", {});
  assertEquals(missing.error?.code, "PGRST202");
  const unknownFn = await deps.db.rpc("get_inbound_rule_secret", { p_rule_id: RULE_ID });
  assertEquals(unknownFn.error?.code, "PGRST202");
});

Deno.test("kit: fixture de process com chave fora da migration é recusada", () => {
  let threw = false;
  try {
    makeInboundKit({ process: { status: "processed", deal_id: "x" } });
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test(
  "evento assinado válido: 200 {received:true,request_id} e RPCs com nomes reais",
  async () => {
    const { kit, res, text } = await call({}, validReq());
    assertEquals(res.status, 200);
    const body = JSON.parse(text);
    assertEquals(body.received, true);
    assertEquals(body.request_id, res.headers.get("X-Request-Id"));
    assertEquals(
      kit.rpcs.map((r) => r.fn),
      ["get_inbound_rule_auth", "check_and_record_rate_limit", "process_inbound_event"],
    );
    assertEquals(kit.rpcs[1].args, {
      p_key: `inbound-req:${RULE_ID}`,
      p_max_calls: 120,
      p_window_seconds: 60,
    });
    assertEquals(kit.rpcs[2].args, { p_rule_id: RULE_ID, p_payload: JSON.parse(BODY) });
  },
);

Deno.test(
  "401 uniforme: inexistente, inativa, assinatura errada, não-uuid, header reservado, inactive no process",
  async () => {
    const wrongSig = (now: number) =>
      signed(BODY, now, "whin_outro_segredo").then((sig) =>
        request({ headers: { "X-Aceleraflow-Signature": sig } }),
      );
    const cases: Array<[string, InboundKitOptions, (now: number) => Promise<Request> | Request]> = [
      ["inexistente", { rule: null }, validReq()],
      ["inativa", { rule: hmacRule({ active: false, current_secret: null }) }, validReq()],
      ["assinatura errada", {}, wrongSig],
      ["sem assinatura", {}, () => request()],
      ["não uuid", {}, () => request({ path: "abc" })],
      ["uuid com sufixo", {}, () => request({ path: `${RULE_ID}x` })],
      [
        "header reservado",
        {
          rule: hmacRule({
            verification_mode: "header_token",
            token_header_name: "Authorization",
            current_secret: ASAAS_TOKEN,
          }),
        },
        () => request({ headers: { authorization: ASAAS_TOKEN } }),
      ],
      ["inactive no process", { process: { status: "inactive" } }, validReq()],
    ];
    const headerSets = new Set<string>();
    for (const [name, options, build] of cases) {
      const { res, text, kit } = await call(options, build);
      headerSets.add([...res.headers.keys()].sort().join(","));
      // I1: 401 nunca consome a cota da regra.
      const signedOk = name === "inactive no process";
      assertEquals(
        kit.rpcs.some((r) => r.fn === "check_and_record_rate_limit"),
        signedOk,
        name,
      );
      assertEquals(res.status, 401, name);
      assertEquals(text, UNAUTHORIZED, name);
      assertEquals(res.headers.get("content-type"), "application/json", name);
      assert(res.headers.get("X-Request-Id"), name);
      assertEquals(res.headers.get("WWW-Authenticate"), null, name);
    }
    assertEquals([...headerSets], ["content-type,x-request-id"], "mesmos nomes de header");
  },
);

Deno.test("regra inexistente/inativa: sem rate limit e sem process (D8)", async () => {
  for (const rule of [null, hmacRule({ active: false })]) {
    const { kit } = await call({ rule }, validReq());
    assertEquals(
      kit.rpcs.map((r) => r.fn),
      ["get_inbound_rule_auth"],
    );
  }
  const { kit } = await call({}, () => request({ path: "nao-uuid" }));
  assertEquals(kit.rpcs.length, 0, "não-uuid não chama RPC");
});

Deno.test("header_token Asaas: token certo 200, errado 401", async () => {
  const rule = hmacRule({
    verification_mode: "header_token",
    token_header_name: "asaas-access-token",
    current_secret: ASAAS_TOKEN,
  });
  const ok = await call({ rule }, () =>
    request({ headers: { "asaas-access-token": ASAAS_TOKEN } }),
  );
  assertEquals(ok.res.status, 200);
  assertEquals(JSON.parse(ok.text).received, true);
  const bad = await call({ rule }, () =>
    request({ headers: { "asaas-access-token": `${ASAAS_TOKEN}x` } }),
  );
  assertEquals(bad.res.status, 401);
  assertEquals(bad.text, UNAUTHORIZED);
});

Deno.test("sucesso é 200 em todo modo: Hotmart, header_token genérico e Stripe", async () => {
  const hot = hmacRule({
    verification_mode: "header_token",
    token_header_name: "X-HOTMART-HOTTOK",
    current_secret: ASAAS_TOKEN,
  });
  assertEquals(
    (await call({ rule: hot }, () => request({ headers: { "x-hotmart-hottok": ASAAS_TOKEN } }))).res
      .status,
    200,
  );
  const generic = hmacRule({
    verification_mode: "header_token",
    token_header_name: "x-meu-token",
    current_secret: ASAAS_TOKEN,
  });
  assertEquals(
    (await call({ rule: generic }, () => request({ headers: { "x-meu-token": ASAAS_TOKEN } }))).res
      .status,
    200,
  );
  const stripe = hmacRule({
    verification_mode: "stripe_signature",
    current_secret: "whsec_teste",
  });
  const s = await call({ rule: stripe }, async (now) =>
    request({ headers: { "Stripe-Signature": await signed(BODY, now, "whsec_teste") } }),
  );
  assertEquals(s.res.status, 200);
});

Deno.test("resultados de negócio: mesmo sucesso e mesmo corpo (menos request_id)", async () => {
  const outcomes = ["processed", "duplicate", "ignored", "not_found", "ambiguous", "failed"];
  const bodies = new Set<string>();
  for (const status of outcomes) {
    const { res, text } = await call({ process: { status, inbound_event_id: "e-1" } }, validReq());
    assertEquals(res.status, 200, status);
    bodies.add(withoutRequestId(text));
    assert(!text.includes("e-1"), "inbound_event_id não vai ao gateway");
  }
  assertEquals([...bodies], ['{"received":true}']);
});

Deno.test(
  "rate_limited do process: minute_limit 429 com Retry-After; daily_limit e sem reason 503",
  async () => {
    const minute = await call(
      {
        process: {
          status: "rate_limited",
          inbound_event_id: "e",
          reason: "minute_limit",
          retry_after_seconds: 17,
        },
      },
      validReq(),
    );
    assertEquals(minute.res.status, 429);
    assertEquals(minute.res.headers.get("Retry-After"), "17");
    const daily = await call(
      { process: { status: "rate_limited", inbound_event_id: "e", reason: "daily_limit" } },
      validReq(),
    );
    assertEquals(daily.res.status, 503);
    assertEquals(daily.text, '{"error":"unavailable"}');
    const noReason = await call({ process: { status: "rate_limited" } }, validReq());
    assertEquals(noReason.res.status, 503);
  },
);

Deno.test("status desconhecido do process falha fechado em 503", async () => {
  const { res } = await call({ process: { status: "processing" } }, validReq());
  assertEquals(res.status, 503);
});

Deno.test("missing_event_id no hmac: 400 bad_request", async () => {
  const { res, text } = await call({ process: { status: "missing_event_id" } }, validReq());
  assertEquals(res.status, 400);
  assertEquals(text, '{"error":"bad_request"}');
});

// v2.1 Task B: Asaas só aceita 200 e pausa a fila após 15 falhas; Hotmart desativa a URL
// que "retorna erro". Depois da autenticação válida, problema de negócio vira 200 ignored.
const STRIPE_SECRET = "whsec_teste_v21";
const GATEWAYS: Array<{
  mode: string;
  rule: Record<string, unknown>;
  build: (body: string) => (now: number) => Promise<Request> | Request;
  wrong: (body: string) => (now: number) => Promise<Request> | Request;
}> = [
  {
    mode: "stripe_signature",
    rule: hmacRule({ verification_mode: "stripe_signature", current_secret: STRIPE_SECRET }),
    build: (body) => async (now) =>
      request({ body, headers: { "Stripe-Signature": await signed(body, now, STRIPE_SECRET) } }),
    wrong: (body) => async (now) =>
      request({ body, headers: { "Stripe-Signature": await signed(body, now, "whsec_outro") } }),
  },
  {
    mode: "header_token",
    rule: hmacRule({
      verification_mode: "header_token",
      token_header_name: "asaas-access-token",
      current_secret: ASAAS_TOKEN,
    }),
    build: (body) => () => request({ body, headers: { "asaas-access-token": ASAAS_TOKEN } }),
    wrong: (body) => () => request({ body, headers: { "asaas-access-token": `${ASAAS_TOKEN}x` } }),
  },
];
const HMAC_MODE = {
  mode: "aceleraflow_hmac",
  rule: hmacRule(),
  build: (body: string) => validReq(body),
  wrong: (body: string) => async (now: number) =>
    request({
      body,
      headers: { "X-Aceleraflow-Signature": await signed(body, now, "whin_outro") },
    }),
};
const ALL_MODES = [HMAC_MODE, ...GATEWAYS];

/** Casos que a edge decide sozinha (sem RPC de process). */
const LOCAL_CASES: Array<[string, string, string, string, string]> = [
  // [nome, corpo, motivo no gateway, corpo 400 no hmac, motivo em record_inbound_ignored]
  ["JSON inválido", "{nao json", "invalid_json", '{"error":"bad_request"}', "invalid_json"],
  ["corpo vazio", "", "invalid_json", '{"error":"bad_request"}', "invalid_json"],
  ["array", "[1,2]", "invalid_payload", '{"error":"bad_request"}', "invalid_payload"],
  ["null", "null", "invalid_payload", '{"error":"bad_request"}', "invalid_payload"],
  ["string", '"texto"', "invalid_payload", '{"error":"bad_request"}', "invalid_payload"],
  [
    "\\u0000",
    '{"id":"evt_nul","nome":"a\\u0000b"}',
    "invalid_payload",
    '{"error":"invalid_payload"}',
    "nul_payload",
  ],
];

const ignoredBody = (res: Response, reason: string) => ({
  received: true,
  ignored: reason,
  request_id: res.headers.get("X-Request-Id"),
});

Deno.test(
  "gateway com auth válida: JSON inválido/não-objeto/\\u0000 dão 200 ignored, consomem cota e contam o motivo",
  async () => {
    for (const g of GATEWAYS) {
      for (const [name, body, reason, , recorded] of LOCAL_CASES) {
        const label = `${g.mode} ${name}`;
        const { res, text, kit } = await call({ rule: g.rule }, g.build(body));
        assertEquals(res.status, 200, label);
        assertEquals(JSON.parse(text), ignoredBody(res, reason), label);
        // Contador depois da cota (UPDATE na linha da regra sob o limite) e nunca o process.
        assertEquals(
          kit.rpcs.map((r) => r.fn),
          ["get_inbound_rule_auth", "check_and_record_rate_limit", "record_inbound_ignored"],
          label,
        );
        assertEquals(kit.rpcs[2].args, { p_rule_id: RULE_ID, p_reason: recorded }, label);
        assert(IGNORED_REASONS.has(recorded), `${recorded} aceito pela migration`);
        assertEquals(
          kit.logs.map((l) => Object.keys(l).sort().join(",")),
          ["event,reason,request_id,rule_id"],
          label,
        );
        assertEquals(kit.logs[0].reason, reason, label);
      }
    }
  },
);

Deno.test(
  "gateway: erro ou rejeição de record_inbound_ignored não muda o 200 e o log só tem o code",
  async () => {
    for (const g of GATEWAYS) {
      for (const [name, body, reason] of LOCAL_CASES) {
        const label = `${g.mode} ${name}`;
        const failed = await call(
          { rule: g.rule, errorOn: { fn: "record_inbound_ignored", code: "57014" } },
          g.build(body),
        );
        assertEquals(failed.res.status, 200, label);
        assertEquals(JSON.parse(failed.text), ignoredBody(failed.res, reason), label);
        const recErr = failed.kit.logs.find((l) => l.event === "inbound_ignored_record_error");
        assertEquals(recErr?.code, "57014", label);
        const logged = JSON.stringify(failed.kit.logs);
        assert(!logged.includes("deadlock") && !logged.includes("DETAIL"), label);
        assert(!logged.includes("evt_nul") && !logged.includes("nao json"), label);

        const rejected = await call(
          { rule: g.rule, rejectOn: "record_inbound_ignored" },
          g.build(body),
        );
        assertEquals(rejected.res.status, 200, label);
        assertEquals(JSON.parse(rejected.text), ignoredBody(rejected.res, reason), label);
        assert(!JSON.stringify(rejected.kit.logs).includes("segredo-do-erro"), label);
      }
    }
  },
);

Deno.test(
  "gateway: corpo descartado com cota esgotada ou RPC de cota com erro dá 200 sem contar",
  async () => {
    for (const g of GATEWAYS) {
      for (const [name, body, reason] of LOCAL_CASES) {
        const label = `${g.mode} ${name}`;
        const limited = await call(
          { rule: g.rule, rateLimit: { allowed: false, retryAfterSeconds: 9 } },
          g.build(body),
        );
        assertEquals(limited.res.status, 200, label);
        assertEquals(JSON.parse(limited.text), ignoredBody(limited.res, reason), label);
        assertEquals(
          limited.kit.rpcs.map((r) => r.fn),
          ["get_inbound_rule_auth", "check_and_record_rate_limit"],
          label,
        );
        const broken = await call(
          { rule: g.rule, errorOn: { fn: "check_and_record_rate_limit" } },
          g.build(body),
        );
        assertEquals(broken.res.status, 200, label);
        assertEquals(JSON.parse(broken.text), ignoredBody(broken.res, reason), label);
        assertEquals(
          broken.kit.rpcs.map((r) => r.fn),
          ["get_inbound_rule_auth", "check_and_record_rate_limit"],
          label,
        );
      }
    }
  },
);

Deno.test("kit: motivo fora da migration em record_inbound_ignored dá 22023", async () => {
  const { deps } = makeInboundKit();
  const res = await deps.db.rpc("record_inbound_ignored", { p_rule_id: RULE_ID, p_reason: "x" });
  assertEquals(res.error?.code, "22023");
  for (const r of ["missing_event_id", "invalid_json", "invalid_payload", "nul_payload"]) {
    assert(IGNORED_REASONS.has(r), r);
  }
});

Deno.test(
  "hmac com auth válida: JSON inválido/não-objeto/\\u0000 continuam 400 sem process, cota nem contador",
  async () => {
    // Rejeitado (400), não ignorado: o dev do sistema próprio vê o erro; nada é contado.
    for (const [name, body, , hmacBody] of LOCAL_CASES) {
      const { res, text, kit } = await call({}, validReq(body));
      assertEquals(res.status, 400, name);
      assertEquals(text, hmacBody, name);
      assertEquals(
        kit.rpcs.map((r) => r.fn),
        ["get_inbound_rule_auth"],
        name,
      );
    }
  },
);

Deno.test(
  "missing_event_id: gateway 200 ignored, hmac 400 (process decide e conta; edge não conta de novo)",
  async () => {
    for (const g of GATEWAYS) {
      const { res, text, kit } = await call(
        { rule: g.rule, process: { status: "missing_event_id" } },
        g.build('{"type":"PAYMENT_CONFIRMED"}'),
      );
      assertEquals(res.status, 200, g.mode);
      assertEquals(
        JSON.parse(text),
        {
          received: true,
          ignored: "missing_event_id",
          request_id: res.headers.get("X-Request-Id"),
        },
        g.mode,
      );
      // O caminho do id do evento só o Postgres conhece (inbound_resolve): a RPC roda e
      // a cota é consumida; a RPC retorna antes de criar evento, mas já soma ignored_count.
      // Lista exata: sem record_inbound_ignored aqui (contaria missing_event_id em dobro).
      assertEquals(
        kit.rpcs.map((r) => r.fn),
        ["get_inbound_rule_auth", "check_and_record_rate_limit", "process_inbound_event"],
        g.mode,
      );
      assert(!text.includes("PAYMENT_CONFIRMED"), g.mode);
    }
  },
);

Deno.test(
  "v2.1: auth inválida continua 401 uniforme nos três modos, mesmo com corpo ruim",
  async () => {
    for (const m of ALL_MODES) {
      for (const body of [BODY, "{nao json", "[1]", '{"n":"\\u0000"}']) {
        const label = `${m.mode} ${body}`;
        const { res, text, kit } = await call({ rule: m.rule }, m.wrong(body));
        assertEquals(res.status, 401, label);
        assertEquals(text, UNAUTHORIZED, label);
        assertEquals(
          kit.rpcs.map((r) => r.fn),
          ["get_inbound_rule_auth"],
          label,
        );
      }
    }
  },
);

Deno.test("v2.1: 413, 429 e 503 inalterados nos gateways; UTF-8 inválido segue 400", async () => {
  for (const g of GATEWAYS) {
    const big = JSON.stringify({ id: "e", pad: "x".repeat(70 * 1024) });
    assertEquals((await call({ rule: g.rule }, g.build(big))).res.status, 413, g.mode);
    const limited = await call(
      { rule: g.rule, rateLimit: { allowed: false, retryAfterSeconds: 9 } },
      g.build(BODY),
    );
    assertEquals(limited.res.status, 429, g.mode);
    assertEquals(limited.res.headers.get("Retry-After"), "9", g.mode);
    const minute = await call(
      {
        rule: g.rule,
        process: { status: "rate_limited", reason: "minute_limit", retry_after_seconds: 5 },
      },
      g.build(BODY),
    );
    assertEquals(minute.res.status, 429, g.mode);
    const daily = await call(
      { rule: g.rule, process: { status: "rate_limited", reason: "daily_limit" } },
      g.build(BODY),
    );
    assertEquals(daily.res.status, 503, g.mode);
    const rpcErr = await call(
      { rule: g.rule, errorOn: { fn: "process_inbound_event" } },
      g.build(BODY),
    );
    assertEquals(rpcErr.res.status, 503, g.mode);
    // UTF-8 é decidido antes da autenticação: igual para regra existente ou não.
    const bytes = new Uint8Array([0x7b, 0x22, 0x69, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);
    const utf = await call({ rule: g.rule }, () =>
      request({ body: bytes, headers: { "asaas-access-token": ASAAS_TOKEN } }),
    );
    assertEquals(utf.res.status, 400, g.mode);
    assertEquals(utf.text, '{"error":"bad_request"}', g.mode);
  }
});

Deno.test("rate limit da edge: 429 com Retry-After depois da assinatura válida", async () => {
  const { res, kit, text } = await call(
    { rateLimit: { allowed: false, retryAfterSeconds: 42 } },
    validReq(),
  );
  assertEquals(res.status, 429);
  assertEquals(res.headers.get("Retry-After"), "42");
  assertEquals(text, '{"error":"rate_limited"}');
  assertEquals(
    kit.rpcs.some((r) => r.fn === "process_inbound_event"),
    false,
  );
});

Deno.test(
  "corpo acima de 64 KB: 413 pelo Content-Length e pelo stream sem Content-Length",
  async () => {
    const big = JSON.stringify({ id: "e", pad: "x".repeat(70 * 1024) });
    const declared = await call({}, validReq(big));
    assertEquals(declared.res.status, 413);
    assertEquals(
      declared.kit.rpcs.some((r) => r.fn === "process_inbound_event"),
      false,
    );

    // m1: Content-Length declarado acima do teto com corpo pequeno: 413 sem ler o stream.
    let touched = 0;
    const small = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          touched++;
          c.enqueue(new TextEncoder().encode("{}"));
          c.close();
        },
      },
      { highWaterMark: 0 },
    );
    const lying = await call({}, () =>
      request({ body: small, headers: { "content-length": String(64 * 1024 + 1) } }),
    );
    assertEquals(lying.res.status, 413);
    assertEquals(touched, 0, "stream não foi lido");

    let pulled = 0;
    const chunk = new Uint8Array(16 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += chunk.byteLength;
        if (pulled > 10 * 1024 * 1024) c.close();
        else c.enqueue(chunk);
      },
    });
    const streamed = await call({}, () => request({ body: stream }));
    assertEquals(streamed.res.status, 413);
    assert(pulled < 1024 * 1024, `puxou ${pulled} bytes`);
    // m2: 65536 bytes exatos passam; 65537 dão 413.
    const atCap = JSON.stringify({ id: "e", p: "y".repeat(64 * 1024 - 17) });
    assertEquals(new TextEncoder().encode(atCap).byteLength, 64 * 1024);
    assertEquals((await call({}, validReq(atCap))).res.status, 200);
    const overCap = JSON.stringify({ id: "e", p: "y".repeat(64 * 1024 - 16) });
    assertEquals((await call({}, validReq(overCap))).res.status, 413);
  },
);

Deno.test("stream abortado pelo cliente: 400 genérico, nunca 500", async () => {
  const broken = new ReadableStream<Uint8Array>({
    pull(c) {
      c.error(new Error("connection reset com segredo"));
    },
  });
  const { res, text, kit } = await call({}, () => request({ body: broken }));
  assertEquals(res.status, 400);
  assertEquals(text, '{"error":"bad_request"}');
  assert(!JSON.stringify(kit.logs).includes("segredo"));
});

Deno.test("JSON inválido ou não-objeto com assinatura válida: 400 sem process", async () => {
  for (const body of ["{nao json", "[1,2]", "null", '"texto"', ""]) {
    const { res, kit } = await call({}, validReq(body));
    assertEquals(res.status, 400, body);
    assertEquals(
      kit.rpcs.some((r) => r.fn === "process_inbound_event"),
      false,
      body,
    );
  }
});

Deno.test("UTF-8 inválido: 400 sem process", async () => {
  const bytes = new Uint8Array([0x7b, 0x22, 0x69, 0x64, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]);
  const { res, kit } = await call({}, (now) =>
    request({
      body: bytes,
      headers: { "X-Aceleraflow-Signature": `t=${Math.floor(now / 1000)},v1=00` },
    }),
  );
  assertEquals(res.status, 400);
  assertEquals(
    kit.rpcs.some((r) => r.fn === "process_inbound_event"),
    false,
  );
});

Deno.test("erro de RPC: 503 genérico sem detalhe do Postgres, log só com code", async () => {
  for (const fn of [
    "get_inbound_rule_auth",
    "check_and_record_rate_limit",
    "process_inbound_event",
  ]) {
    const { res, text, kit } = await call({ errorOn: { fn, code: "57014" } }, validReq());
    assertEquals(res.status, 503, fn);
    assertEquals(text, '{"error":"unavailable"}', fn);
    const logged = JSON.stringify(kit.logs);
    assert(logged.includes("57014"), fn);
    assert(!logged.includes("deadlock") && !logged.includes("DETAIL"), fn);
  }
  const rejected = await call({ rejectOn: "process_inbound_event" }, validReq());
  assertEquals(rejected.res.status, 503);
  assert(!JSON.stringify(rejected.kit.logs).includes("segredo-do-erro"));
});

Deno.test("logs nunca recebem segredo, assinatura, token nem corpo", async () => {
  const all: unknown[] = [];
  const sigs: string[] = [];
  const runs: Array<[InboundKitOptions, (now: number) => Promise<Request> | Request]> = [
    [
      {},
      async (now) => {
        const s = await signed(BODY, now);
        sigs.push(s);
        return request({ headers: { "X-Aceleraflow-Signature": s } });
      },
    ],
    [{ process: { status: "failed", inbound_event_id: "e" } }, validReq()],
    [{ errorOn: { fn: "process_inbound_event" } }, validReq()],
    [
      {
        rule: hmacRule({
          verification_mode: "header_token",
          token_header_name: "cookie",
          current_secret: ASAAS_TOKEN,
        }),
      },
      () => request({ headers: { cookie: ASAAS_TOKEN } }),
    ],
    [{}, () => request({ body: "{nao json" })],
    // v2.1: corpo ignorado no gateway (200) também não vai ao log.
    [
      { rule: GATEWAYS[1].rule },
      GATEWAYS[1].build(`{"email":"${EMAIL}","type":"pagamento.aprovado","x":"\\u0000"}`),
    ],
    [
      { rule: GATEWAYS[1].rule, process: { status: "missing_event_id" } },
      GATEWAYS[1].build(`{"email":"${EMAIL}","type":"pagamento.aprovado"}`),
    ],
  ];
  for (const [options, build] of runs) {
    const { kit } = await call(options, build);
    all.push(...kit.logs);
  }
  const text = JSON.stringify(all);
  assert(all.length > 0);
  for (const needle of [HMAC_SECRET, ASAAS_TOKEN, EMAIL, "pagamento.aprovado", ...sigs]) {
    assert(!text.includes(needle), `log contém ${needle.slice(0, 12)}`);
  }
});

Deno.test("métodos: OPTIONS 204 sem CORS amplo, GET 405", async () => {
  const opt = await call({}, () => request({ method: "OPTIONS", body: null }));
  assertEquals(opt.res.status, 204);
  assertEquals(opt.res.headers.get("Access-Control-Allow-Origin"), null);
  assert(opt.res.headers.get("X-Request-Id"));
  const get = await call({}, () => request({ method: "GET", body: null }));
  assertEquals(get.res.status, 405);
  assertEquals(get.kit.rpcs.length, 0);
});

Deno.test("segredo anterior (rotação) ainda aceito", async () => {
  const rule = hmacRule({ current_secret: "whin_novo_segredo", previous_secret: HMAC_SECRET });
  const { res } = await call({ rule }, validReq());
  assertEquals(res.status, 200);
});

Deno.test(
  "I1: 200 POSTs sem assinatura numa regra ativa dão só 401 e não tocam na cota",
  async () => {
    const kit = makeInboundKit();
    for (let i = 0; i < 200; i++) {
      const res = await handleInbound(request(), kit.deps);
      assertEquals(res.status, 401);
      await res.body?.cancel();
    }
    assertEquals(kit.rpcs.filter((r) => r.fn === "check_and_record_rate_limit").length, 0);
    assertEquals(kit.rpcs.filter((r) => r.fn === "get_inbound_rule_auth").length, 200);
  },
);

Deno.test(
  "\\u0000 em string assinada: 400 invalid_payload sem RPC de process nem cota",
  async () => {
    const bodies = [
      '{"id":"evt_nul","nome":"a\\u0000b"}',
      '{"id":"evt_nul","meta":{"lista":["ok","\\u0000"]}}',
      '{"id":"evt_nul","ch\\u0000ve":1}',
    ];
    for (const body of bodies) {
      const { res, text, kit } = await call({}, validReq(body));
      assertEquals(res.status, 400, body);
      assertEquals(text, '{"error":"invalid_payload"}', body);
      assertEquals(
        kit.rpcs.map((r) => r.fn),
        ["get_inbound_rule_auth"],
        body,
      );
    }
    // Barra invertida literal seguida de "u0000" não é NUL: segue normal.
    const literal = await call({}, validReq('{"id":"evt_ok","t":"\\\\u0000"}'));
    assertEquals(literal.res.status, 200);
    // Sem assinatura válida continua 401 (o veto vem depois da assinatura).
    const unsigned = await call({}, () => request({ body: '{"id":"x","n":"\\u0000"}' }));
    assertEquals(unsigned.res.status, 401);
  },
);
