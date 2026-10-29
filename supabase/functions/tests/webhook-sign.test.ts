import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { signWebhook, verifyWebhook } from "../_shared/webhooks/sign.ts";
import { buildEnvelope } from "../_shared/webhooks/envelope.ts";
import {
  GOLDEN_BODY,
  GOLDEN_SECRET,
  GOLDEN_SIGNATURE,
  GOLDEN_TIMESTAMP,
} from "../_shared/webhooks/golden-vector.ts";

const NOW_MS = GOLDEN_TIMESTAMP * 1000;
const header = (...sigs: string[]) => `t=${GOLDEN_TIMESTAMP},${sigs.join(",")}`;

Deno.test("signWebhook reproduz o vetor dourado (conferido com openssl)", async () => {
  assertEquals(await signWebhook(GOLDEN_SECRET, GOLDEN_TIMESTAMP, GOLDEN_BODY), GOLDEN_SIGNATURE);
  assert(GOLDEN_SIGNATURE.startsWith("v1="));
});

Deno.test("verifyWebhook aceita assinatura válida", async () => {
  assert(await verifyWebhook(GOLDEN_SECRET, header(GOLDEN_SIGNATURE), GOLDEN_BODY, 300, NOW_MS));
});

Deno.test("verifyWebhook rejeita corpo adulterado", async () => {
  assertEquals(
    await verifyWebhook(GOLDEN_SECRET, header(GOLDEN_SIGNATURE), GOLDEN_BODY + " ", 300, NOW_MS),
    false,
  );
});

Deno.test("verifyWebhook rejeita segredo errado", async () => {
  assertEquals(
    await verifyWebhook("outro", header(GOLDEN_SIGNATURE), GOLDEN_BODY, 300, NOW_MS),
    false,
  );
});

Deno.test("verifyWebhook rejeita timestamp fora da tolerância (ambos os lados)", async () => {
  assertEquals(
    await verifyWebhook(GOLDEN_SECRET, header(GOLDEN_SIGNATURE), GOLDEN_BODY, 300, NOW_MS + 301_000),
    false,
  );
  assertEquals(
    await verifyWebhook(GOLDEN_SECRET, header(GOLDEN_SIGNATURE), GOLDEN_BODY, 300, NOW_MS - 301_000),
    false,
  );
  assert(
    await verifyWebhook(GOLDEN_SECRET, header(GOLDEN_SIGNATURE), GOLDEN_BODY, 300, NOW_MS + 300_000),
  );
});

Deno.test("verifyWebhook aceita se qualquer um dos dois v1 bate (rotação)", async () => {
  const bad = `v1=${"0".repeat(64)}`;
  assert(await verifyWebhook(GOLDEN_SECRET, header(bad, GOLDEN_SIGNATURE), GOLDEN_BODY, 300, NOW_MS));
  assert(await verifyWebhook(GOLDEN_SECRET, header(GOLDEN_SIGNATURE, bad), GOLDEN_BODY, 300, NOW_MS));
  assertEquals(await verifyWebhook(GOLDEN_SECRET, header(bad, bad), GOLDEN_BODY, 300, NOW_MS), false);
});

Deno.test("verifyWebhook rejeita header malformado sem lançar", async () => {
  for (const h of ["", "garbage", `t=abc,${GOLDEN_SIGNATURE}`, `v1=abc`, `t=${GOLDEN_TIMESTAMP}`]) {
    assertEquals(await verifyWebhook(GOLDEN_SECRET, h, GOLDEN_BODY, 300, NOW_MS), false, h);
  }
});

Deno.test("buildEnvelope monta o envelope exato com api_version", () => {
  const env = buildEnvelope({
    id: "evt_1",
    type: "lead.created",
    tenant_id: "t1",
    occurred_at: "2026-10-20T12:00:00.000Z",
    payload: { id: 7 },
  });
  assertEquals(env, {
    id: "evt_1",
    type: "lead.created",
    api_version: "2026-10-20",
    created_at: "2026-10-20T12:00:00.000Z",
    tenant_id: "t1",
    data: { id: 7 },
  });
});

Deno.test("verifyWebhook falha fechado com tolerância ou now não finitos", async () => {
  const h = header(GOLDEN_SIGNATURE);
  assertEquals(await verifyWebhook(GOLDEN_SECRET, h, GOLDEN_BODY, NaN, NOW_MS), false);
  assertEquals(await verifyWebhook(GOLDEN_SECRET, h, GOLDEN_BODY, 300, NaN), false);
  assertEquals(await verifyWebhook(GOLDEN_SECRET, h, GOLDEN_BODY, 300, Infinity), false);
});

Deno.test("signWebhook rejeita timestamp não inteiro ou negativo", async () => {
  for (const t of [NaN, 1.5, -1, Infinity]) {
    await assertRejects(() => signWebhook("s", t, "x"), Error);
  }
});

Deno.test("verifyWebhook rejeita hex em MAIÚSCULAS (formato canônico é minúsculo)", async () => {
  const upper = `v1=${GOLDEN_SIGNATURE.slice(3).toUpperCase()}`;
  assertEquals(await verifyWebhook(GOLDEN_SECRET, header(upper), GOLDEN_BODY, 300, NOW_MS), false);
});

Deno.test("signWebhook rejeita segredo vazio", async () => {
  await assertRejects(() => signWebhook("", 1, "x"), Error);
});
