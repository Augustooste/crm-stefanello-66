// Testa limitEmojis/countEmojis (supabase/functions/_shared/ai/emoji-limiter.ts).
// Função pura, sem I/O — não precisa de mock de rede/env.
import { countEmojis, limitEmojis } from "../_shared/ai/emoji-limiter.ts";

Deno.test("limitEmojis", async (t) => {
  await t.step("texto sem emoji fica intacto (mesma referência)", () => {
    const text = "Olá, tudo bem com você?";
    const result = limitEmojis(text);
    if (result !== text) throw new Error(`esperado texto original, obtido "${result}"`);
  });

  await t.step("texto com 3 emojis vira 1 (mantém o primeiro)", () => {
    const text = "Combinado 😊 vou te ajudar 😍 com isso 👍";
    const result = limitEmojis(text);
    const count = countEmojis(result);
    if (count !== 1) throw new Error(`esperado 1 emoji, obtido ${count} em "${result}"`);
    if (!result.includes("😊")) {
      throw new Error(`esperado manter o primeiro emoji, obtido "${result}"`);
    }
    if (result.includes("😍") || result.includes("👍")) {
      throw new Error(`esperado remover emojis extras, obtido "${result}"`);
    }
  });

  await t.step("max=0 remove todos os emojis", () => {
    const text = "Oi 😊 tudo bem 👍";
    const result = limitEmojis(text, 0);
    const count = countEmojis(result);
    if (count !== 0) throw new Error(`esperado 0 emojis, obtido ${count} em "${result}"`);
  });

  await t.step("emoji em meio à palavra preserva o resto do texto", () => {
    const text = "combi😊nado com você amanhã 👍 às 10h";
    const result = limitEmojis(text, 1);
    if (!result.includes("combi") || !result.includes("nado com você amanhã")) {
      throw new Error(`esperado preservar texto ao redor, obtido "${result}"`);
    }
    if (!result.includes("às 10h")) {
      throw new Error(`esperado preservar sufixo do texto, obtido "${result}"`);
    }
    const count = countEmojis(result);
    if (count !== 1) throw new Error(`esperado 1 emoji, obtido ${count} em "${result}"`);
  });
});

Deno.test("countEmojis", async (t) => {
  await t.step("texto vazio retorna 0", () => {
    if (countEmojis("") !== 0) throw new Error("esperado 0 para texto vazio");
  });

  await t.step("conta múltiplos emojis atomic corretamente", () => {
    const count = countEmojis("😊😍👍🤝");
    if (count !== 4) throw new Error(`esperado 4, obtido ${count}`);
  });
});
