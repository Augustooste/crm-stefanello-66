import { assertEquals } from "https://deno.land/std@0.217.0/assert/mod.ts";
import { splitIntoBubbles } from "./send-dispatch.ts";

Deno.test("splitIntoBubbles respects maxBlocks limit", () => {
  // 4 parágrafos longos (cada um > 25 chars, sem juntagem automática)
  const text = `This is a long first paragraph that exceeds the minimum character limit.

This is a long second paragraph that also exceeds the minimum character limit.

This is a long third paragraph that also exceeds the minimum character limit.

This is a long fourth paragraph that also exceeds the minimum character limit.`;

  const result1 = splitIntoBubbles(text, 1);
  assertEquals(result1.length, 1, `maxBlocks=1 should merge all, got ${result1.length}: ${JSON.stringify(result1)}`);

  const result2 = splitIntoBubbles(text, 2);
  assertEquals(result2.length, 2, `maxBlocks=2 should split into 2, got ${result2.length}: ${JSON.stringify(result2)}`);

  const result4 = splitIntoBubbles(text, 4);
  assertEquals(result4.length, 4, `maxBlocks=4 should keep 4, got ${result4.length}: ${JSON.stringify(result4)}`);

  const result5 = splitIntoBubbles(text, 5);
  assertEquals(result5.length, 4, `maxBlocks=5 but only 4 paras, should stay 4, got ${result5.length}`);
});

Deno.test("splitIntoBubbles merges short paragraphs", () => {
  const text = `Long paragraph that definitely exceeds the minimum bubble chars needed here.

Short one.

Another long paragraph that definitely exceeds the minimum bubble chars needed here too.`;

  const result = splitIntoBubbles(text, 10);
  // "Short one." is < 25 chars, gets merged with previous
  assertEquals(result.length, 2, `Short para merged, expected 2, got ${result.length}: ${JSON.stringify(result)}`);
  assertEquals(result[0].includes("Long paragraph"), true, "First bubble should be the long one + short");
});

Deno.test("splitIntoBubbles default maxBlocks=1", () => {
  const text = `Para 1 is definitely long enough to not get merged automatically by short logic here.

Para 2 is definitely long enough to not get merged automatically by short logic here.`;

  const result = splitIntoBubbles(text);
  assertEquals(result.length, 1, `Default maxBlocks=1 should merge all, got ${result.length}`);
});
