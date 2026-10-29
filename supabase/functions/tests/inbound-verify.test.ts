import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { readCapped } from "../_shared/http/read-capped.ts";
import {
  INBOUND_MAX_BODY_BYTES,
  INBOUND_SIGNATURE_HEADER,
  type InboundAuth,
  STRIPE_SIGNATURE_HEADER,
  verifyInbound,
} from "../_shared/inbound/verify.ts";
import { signWebhook } from "../_shared/webhooks/sign.ts";
import {
  GOLDEN_BODY,
  GOLDEN_SECRET,
  GOLDEN_SIGNATURE,
  GOLDEN_TIMESTAMP,
} from "../_shared/webhooks/golden-vector.ts";

const NOW_MS = GOLDEN_TIMESTAMP * 1000;

// Vetor Stripe montado com o algoritmo documentado (docs.stripe.com/webhooks:
// HMAC-SHA256 de `${t}.${corpo}`), conferido de forma independente com:
//   printf '%s' '1700000000.{"id":"evt_stripe_golden","type":"checkout.session.completed"}' \
//     | openssl dgst -sha256 -hmac 'whsec_stripe_golden' -hex
const STRIPE_SECRET = "whsec_stripe_golden";
const STRIPE_OLD_SECRET = "whsec_stripe_old";
const STRIPE_BODY = '{"id":"evt_stripe_golden","type":"checkout.session.completed"}';
const STRIPE_V1 = "ab28d9f9542b58039ebf3607d863bd92acee981404c1378d21c64ee48432c515";
const STRIPE_OLD_V1 = "2cd55f5097d1920d50283f5ca64a9f51f3fd9944579c28b85a894c1cfeb3a573";

const ASAAS_TOKEN = "asaas_token_fixo_de_teste_com_32_chars_ok";

function hmacAuth(current: string | null, previous: string | null = null): InboundAuth {
  return {
    verification_mode: "aceleraflow_hmac",
    token_header_name: null,
    current_secret: current,
    previous_secret: previous,
  };
}
function stripeAuth(current: string | null, previous: string | null = null): InboundAuth {
  return { ...hmacAuth(current, previous), verification_mode: "stripe_signature" };
}
function tokenAuth(
  current: string | null,
  previous: string | null = null,
  name: string | null = "asaas-access-token",
): InboundAuth {
  return {
    verification_mode: "header_token",
    token_header_name: name,
    current_secret: current,
    previous_secret: previous,
  };
}
function h(name: string, value: string): Headers {
  return new Headers({ [name]: value });
}
const golden = (sig = GOLDEN_SIGNATURE, t = GOLDEN_TIMESTAMP) =>
  h(INBOUND_SIGNATURE_HEADER, `t=${t},${sig}`);

// ---------- aceleraflow_hmac ----------

Deno.test("hmac: vetor dourado da v1 aceito", async () => {
  assert(await verifyInbound(hmacAuth(GOLDEN_SECRET), golden(), GOLDEN_BODY, NOW_MS));
});

Deno.test("hmac: timestamp 301 s no passado e no futuro recusado; 300 s aceito", async () => {
  const auth = hmacAuth(GOLDEN_SECRET);
  assertEquals(await verifyInbound(auth, golden(), GOLDEN_BODY, NOW_MS + 301_000), false);
  assertEquals(await verifyInbound(auth, golden(), GOLDEN_BODY, NOW_MS - 301_000), false);
  assert(await verifyInbound(auth, golden(), GOLDEN_BODY, NOW_MS + 300_000));
});

Deno.test("hmac: assinatura de outro segredo (outra regra) recusada", async () => {
  assertEquals(
    await verifyInbound(hmacAuth("whin_outra_regra"), golden(), GOLDEN_BODY, NOW_MS),
    false,
  );
});

Deno.test("hmac: corpo alterado em 1 byte recusado", async () => {
  const tampered = GOLDEN_BODY.replace("golden", "goldeN");
  assertEquals(tampered.length, GOLDEN_BODY.length);
  assertEquals(await verifyInbound(hmacAuth(GOLDEN_SECRET), golden(), tampered, NOW_MS), false);
});

Deno.test("hmac: corpo reserializado (espaço) recusado: usa a string crua", async () => {
  const reserialized = JSON.stringify(JSON.parse(GOLDEN_BODY), null, 1);
  assertEquals(await verifyInbound(hmacAuth(GOLDEN_SECRET), golden(), reserialized, NOW_MS), false);
});

Deno.test("hmac: hex em maiúsculas, tamanho errado e não-hex recusados", async () => {
  const auth = hmacAuth(GOLDEN_SECRET);
  const hex = GOLDEN_SIGNATURE.slice(3);
  for (const bad of [hex.toUpperCase(), hex.slice(0, 63), hex + "0", "zz" + hex.slice(2)]) {
    assertEquals(await verifyInbound(auth, golden(`v1=${bad}`), GOLDEN_BODY, NOW_MS), false, bad);
  }
});

Deno.test("hmac: header ausente, v1 vazio, t não numérico, sem t recusados", async () => {
  const auth = hmacAuth(GOLDEN_SECRET);
  const cases: Headers[] = [
    new Headers(),
    h(INBOUND_SIGNATURE_HEADER, `t=${GOLDEN_TIMESTAMP},v1=`),
    h(INBOUND_SIGNATURE_HEADER, `t=abc,${GOLDEN_SIGNATURE}`),
    h(INBOUND_SIGNATURE_HEADER, GOLDEN_SIGNATURE),
    h(INBOUND_SIGNATURE_HEADER, ""),
  ];
  for (const headers of cases) {
    assertEquals(await verifyInbound(auth, headers, GOLDEN_BODY, NOW_MS), false);
  }
});

Deno.test("hmac: header duplicado (dois t=) recusado mesmo com assinatura válida", async () => {
  const headers = new Headers();
  // Headers.get junta os dois com ", "; sem a checagem o último t= valeria e a v1 boa casaria.
  headers.append(INBOUND_SIGNATURE_HEADER, `t=${GOLDEN_TIMESTAMP + 1},v1=${"0".repeat(64)}`);
  headers.append(INBOUND_SIGNATURE_HEADER, `t=${GOLDEN_TIMESTAMP},${GOLDEN_SIGNATURE}`);
  assertEquals(await verifyInbound(hmacAuth(GOLDEN_SECRET), headers, GOLDEN_BODY, NOW_MS), false);
  // Chave com espaço antes do "=" é `t` para o parser da v1: também conta como segundo t.
  assertEquals(
    await verifyInbound(
      hmacAuth(GOLDEN_SECRET),
      h(INBOUND_SIGNATURE_HEADER, `t=1,t =${GOLDEN_TIMESTAMP},${GOLDEN_SIGNATURE}`),
      GOLDEN_BODY,
      NOW_MS,
    ),
    false,
  );
  const stripeDup = new Headers();
  stripeDup.append(STRIPE_SIGNATURE_HEADER, `t=${GOLDEN_TIMESTAMP + 1},v1=${"0".repeat(64)}`);
  stripeDup.append(STRIPE_SIGNATURE_HEADER, `t=${GOLDEN_TIMESTAMP},v1=${STRIPE_V1}`);
  assertEquals(
    await verifyInbound(stripeAuth(STRIPE_SECRET), stripeDup, STRIPE_BODY, NOW_MS),
    false,
  );
});

Deno.test("hmac: segredo anterior aceito; atual errado + anterior nulo recusado", async () => {
  assert(await verifyInbound(hmacAuth("whin_novo", GOLDEN_SECRET), golden(), GOLDEN_BODY, NOW_MS));
  assertEquals(
    await verifyInbound(hmacAuth("whin_novo", null), golden(), GOLDEN_BODY, NOW_MS),
    false,
  );
});

Deno.test("hmac: duas v1 (rotação do emissor, errada + certa) aceitas", async () => {
  const headers = golden(`v1=${"0".repeat(64)},${GOLDEN_SIGNATURE}`);
  assert(await verifyInbound(hmacAuth(GOLDEN_SECRET), headers, GOLDEN_BODY, NOW_MS));
});

Deno.test("hmac: segredo nulo ou vazio recusa", async () => {
  for (const auth of [hmacAuth(null), hmacAuth(""), hmacAuth(null, "")]) {
    assertEquals(await verifyInbound(auth, golden(), GOLDEN_BODY, NOW_MS), false);
  }
});

Deno.test("hmac: assinatura Stripe-Signature não vale no modo aceleraflow_hmac", async () => {
  const headers = h(STRIPE_SIGNATURE_HEADER, `t=${GOLDEN_TIMESTAMP},${GOLDEN_SIGNATURE}`);
  assertEquals(await verifyInbound(hmacAuth(GOLDEN_SECRET), headers, GOLDEN_BODY, NOW_MS), false);
});

// ---------- stripe_signature ----------

const stripe = (value: string) => h(STRIPE_SIGNATURE_HEADER, value);

Deno.test("stripe: vetor dourado (openssl) bate com signWebhook", async () => {
  assertEquals(await signWebhook(STRIPE_SECRET, GOLDEN_TIMESTAMP, STRIPE_BODY), `v1=${STRIPE_V1}`);
});

Deno.test("stripe: assinatura válida aceita, com v0 falso do modo teste ignorado", async () => {
  const auth = stripeAuth(STRIPE_SECRET);
  assert(
    await verifyInbound(auth, stripe(`t=${GOLDEN_TIMESTAMP},v1=${STRIPE_V1}`), STRIPE_BODY, NOW_MS),
  );
  assert(
    await verifyInbound(
      auth,
      stripe(`t=${GOLDEN_TIMESTAMP},v1=${STRIPE_V1},v0=${"0".repeat(64)}`),
      STRIPE_BODY,
      NOW_MS,
    ),
  );
});

Deno.test("stripe: só v0 (mesmo correto) é recusado: anti downgrade", async () => {
  assertEquals(
    await verifyInbound(
      stripeAuth(STRIPE_SECRET),
      stripe(`t=${GOLDEN_TIMESTAMP},v0=${STRIPE_V1}`),
      STRIPE_BODY,
      NOW_MS,
    ),
    false,
  );
});

Deno.test(
  "stripe: várias v1 (rolagem do segredo no Stripe) aceitas em qualquer ordem",
  async () => {
    const auth = stripeAuth(STRIPE_SECRET);
    for (const value of [
      `t=${GOLDEN_TIMESTAMP},v1=${STRIPE_OLD_V1},v1=${STRIPE_V1}`,
      `t=${GOLDEN_TIMESTAMP},v1=${STRIPE_V1},v1=${STRIPE_OLD_V1}`,
    ]) {
      assert(await verifyInbound(auth, stripe(value), STRIPE_BODY, NOW_MS), value);
    }
  },
);

Deno.test("stripe: segredo anterior da regra aceito", async () => {
  assert(
    await verifyInbound(
      stripeAuth("whsec_novo", STRIPE_OLD_SECRET),
      stripe(`t=${GOLDEN_TIMESTAMP},v1=${STRIPE_OLD_V1}`),
      STRIPE_BODY,
      NOW_MS,
    ),
  );
});

Deno.test(
  "stripe: replay velho/futuro, corpo alterado, outro segredo, hex inválido recusados",
  async () => {
    const auth = stripeAuth(STRIPE_SECRET);
    const ok = stripe(`t=${GOLDEN_TIMESTAMP},v1=${STRIPE_V1}`);
    assertEquals(await verifyInbound(auth, ok, STRIPE_BODY, NOW_MS + 301_000), false);
    assertEquals(await verifyInbound(auth, ok, STRIPE_BODY, NOW_MS - 301_000), false);
    assertEquals(await verifyInbound(auth, ok, STRIPE_BODY + " ", NOW_MS), false);
    assertEquals(await verifyInbound(stripeAuth("whsec_outro"), ok, STRIPE_BODY, NOW_MS), false);
    for (const bad of [STRIPE_V1.toUpperCase(), STRIPE_V1.slice(1), "g".repeat(64)]) {
      assertEquals(
        await verifyInbound(auth, stripe(`t=${GOLDEN_TIMESTAMP},v1=${bad}`), STRIPE_BODY, NOW_MS),
        false,
      );
    }
  },
);

Deno.test(
  "stripe: header ausente, nome errado (X-Aceleraflow) e segredo nulo recusados",
  async () => {
    const value = `t=${GOLDEN_TIMESTAMP},v1=${STRIPE_V1}`;
    assertEquals(
      await verifyInbound(stripeAuth(STRIPE_SECRET), new Headers(), STRIPE_BODY, NOW_MS),
      false,
    );
    assertEquals(
      await verifyInbound(
        stripeAuth(STRIPE_SECRET),
        h(INBOUND_SIGNATURE_HEADER, value),
        STRIPE_BODY,
        NOW_MS,
      ),
      false,
    );
    assertEquals(await verifyInbound(stripeAuth(null), stripe(value), STRIPE_BODY, NOW_MS), false);
  },
);

// ---------- header_token ----------

Deno.test("header_token: token certo aceito, nome do header case-insensitive", async () => {
  const auth = tokenAuth(ASAAS_TOKEN);
  assert(await verifyInbound(auth, h("asaas-access-token", ASAAS_TOKEN), "{}", NOW_MS));
  assert(await verifyInbound(auth, h("Asaas-Access-Token", ASAAS_TOKEN), "{}", NOW_MS));
  assert(
    await verifyInbound(
      tokenAuth("hottok_x", null, "X-HOTMART-HOTTOK"),
      h("x-hotmart-hottok", "hottok_x"),
      "{}",
      NOW_MS,
    ),
  );
});

Deno.test("header_token: token errado, prefixo, sufixo, caixa diferente recusados", async () => {
  const auth = tokenAuth(ASAAS_TOKEN);
  for (const bad of [
    "outro",
    ASAAS_TOKEN.slice(0, -1),
    ASAAS_TOKEN + "x",
    ASAAS_TOKEN.toUpperCase(),
    ` ${ASAAS_TOKEN}x`,
  ]) {
    assertEquals(await verifyInbound(auth, h("asaas-access-token", bad), "{}", NOW_MS), false, bad);
  }
});

Deno.test("header_token: header ausente, vazio ou duplicado recusado", async () => {
  const auth = tokenAuth(ASAAS_TOKEN);
  assertEquals(await verifyInbound(auth, new Headers(), "{}", NOW_MS), false);
  assertEquals(await verifyInbound(auth, h("asaas-access-token", ""), "{}", NOW_MS), false);
  const dup = new Headers();
  dup.append("asaas-access-token", ASAAS_TOKEN);
  dup.append("asaas-access-token", ASAAS_TOKEN);
  assertEquals(await verifyInbound(auth, dup, "{}", NOW_MS), false);
});

Deno.test("header_token: token anterior aceito; ambos nulos/vazios recusam", async () => {
  assert(
    await verifyInbound(
      tokenAuth("novo_token", ASAAS_TOKEN),
      h("asaas-access-token", ASAAS_TOKEN),
      "{}",
      NOW_MS,
    ),
  );
  for (const auth of [tokenAuth(null), tokenAuth(""), tokenAuth(null, "")]) {
    assertEquals(await verifyInbound(auth, h("asaas-access-token", ""), "{}", NOW_MS), false);
    assertEquals(await verifyInbound(auth, h("asaas-access-token", "x"), "{}", NOW_MS), false);
  }
});

Deno.test("header_token: nome de header nulo ou fora do token HTTP recusa", async () => {
  for (const name of [null, "", "asaas access token", "x:y", "a".repeat(65), "ção"]) {
    assertEquals(
      await verifyInbound(
        tokenAuth(ASAAS_TOKEN, null, name),
        h("asaas-access-token", ASAAS_TOKEN),
        "{}",
        NOW_MS,
      ),
      false,
      String(name),
    );
  }
});

// ---------- modo desconhecido ----------

Deno.test("modo desconhecido ou vazio recusa mesmo com assinatura válida", async () => {
  for (const mode of ["", "none", "ACELERAFLOW_HMAC", "aceleraflow_hmac "]) {
    const auth = { ...hmacAuth(GOLDEN_SECRET), verification_mode: mode };
    assertEquals(await verifyInbound(auth, golden(), GOLDEN_BODY, NOW_MS), false, mode);
  }
});

// ---------- readCapped ----------

const CHUNK = 16 * 1024;

/** Stream de `total` bytes sem Content-Length; conta o que o leitor puxou. */
function countingStream(total: number): {
  stream: ReadableStream<Uint8Array>;
  pulled: () => number;
  canceled: () => boolean;
} {
  let sent = 0;
  let wasCanceled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) return controller.close();
      const n = Math.min(CHUNK, total - sent);
      sent += n;
      controller.enqueue(new Uint8Array(n));
    },
    cancel() {
      wasCanceled = true;
    },
  });
  return { stream, pulled: () => sent, canceled: () => wasCanceled };
}

Deno.test(
  "readCapped: 10 MB chunked devolve null tendo lido menos de 1 MB (teto 64 KB)",
  async () => {
    const s = countingStream(10 * 1024 * 1024);
    assertEquals(await readCapped(s.stream, INBOUND_MAX_BODY_BYTES), null);
    assert(s.canceled(), "stream deve ser cancelado");
    assertEquals(INBOUND_MAX_BODY_BYTES, 64 * 1024);
    // Para saber que passou do teto precisa ler 1 chunk além; o resto dos 10 MB nunca é puxado.
    assert(s.pulled() < 1024 * 1024, `puxou ${s.pulled()} bytes`);
    assert(s.pulled() <= INBOUND_MAX_BODY_BYTES + 2 * CHUNK, `puxou ${s.pulled()} bytes`);
  },
);

Deno.test("readCapped: exatamente no teto devolve tudo; 1 byte além devolve null", async () => {
  const at = await readCapped(
    countingStream(INBOUND_MAX_BODY_BYTES).stream,
    INBOUND_MAX_BODY_BYTES,
  );
  assertEquals(at?.byteLength, INBOUND_MAX_BODY_BYTES);
  assertEquals(
    await readCapped(countingStream(INBOUND_MAX_BODY_BYTES + 1).stream, INBOUND_MAX_BODY_BYTES),
    null,
  );
});

Deno.test("readCapped: stream nulo = vazio; bytes preservados na ordem", async () => {
  assertEquals((await readCapped(null, 10))?.byteLength, 0);
  const body = new TextEncoder().encode(GOLDEN_BODY);
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(body.slice(0, 5));
      c.enqueue(body.slice(5));
      c.close();
    },
  });
  const out = await readCapped(stream, INBOUND_MAX_BODY_BYTES);
  assertEquals(new TextDecoder().decode(out!), GOLDEN_BODY);
});

Deno.test("readCapped: Content-Length mentiroso não importa, conta os bytes reais", async () => {
  const req = new Request("http://x/", {
    method: "POST",
    headers: { "content-length": "10" },
    body: countingStream(2 * CHUNK).stream,
  });
  assertEquals(await readCapped(req.body, CHUNK), null);
});

Deno.test("readCapped: maxBytes NaN, Infinity ou negativo lança RangeError", async () => {
  for (const bad of [NaN, Infinity, -1]) {
    await assertRejects(() => readCapped(null, bad), RangeError, "maxBytes inválido");
  }
});
