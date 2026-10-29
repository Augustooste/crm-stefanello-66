import { assertEquals } from "jsr:@std/assert@1";
import { nextAttemptDelaySeconds } from "../_shared/webhooks/backoff.ts";

Deno.test("backoff: sequência exata sem jitter", () => {
  const got = [1, 2, 3, 4, 5, 6].map((a) => nextAttemptDelaySeconds(a, 0));
  assertEquals(got, [60, 300, 1800, 7200, 21600, 86400]);
});

Deno.test("backoff: teto 86400 além da 6ª tentativa", () => {
  assertEquals(nextAttemptDelaySeconds(7, 0), 86400);
  assertEquals(nextAttemptDelaySeconds(50, 0), 86400);
});

Deno.test("backoff: tentativa < 1 usa o primeiro degrau", () => {
  assertEquals(nextAttemptDelaySeconds(0, 0), 60);
});

Deno.test("backoff: jitter injetável ±10 %", () => {
  assertEquals(nextAttemptDelaySeconds(1, 0.1), 66);
  assertEquals(nextAttemptDelaySeconds(1, -0.1), 54);
  assertEquals(nextAttemptDelaySeconds(2, 0.05), 315);
});

Deno.test("backoff: jitter padrão fica dentro de ±10 %", () => {
  for (let i = 0; i < 200; i++) {
    const d = nextAttemptDelaySeconds(3);
    if (d < 1620 || d > 1980) throw new Error(`fora da faixa: ${d}`);
  }
});

Deno.test("backoff: jitter fora de ±10 % é limitado", () => {
  assertEquals(nextAttemptDelaySeconds(1, 5), 66);
  assertEquals(nextAttemptDelaySeconds(1, -5), 54);
});

Deno.test("backoff: attempt NaN/não inteiro/negativo vira 1", () => {
  for (const a of [NaN, 2.5, -3, Infinity]) assertEquals(nextAttemptDelaySeconds(a, 0), 60);
});
