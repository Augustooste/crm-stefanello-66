// Testa normalizeMessagingText (supabase/functions/_shared/text-normalize.ts).
// Função pura, sem I/O — não precisa de mock de rede/env.
import { normalizeMessagingText } from "../_shared/text-normalize.ts";

function expectEqual(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label}: esperado ${JSON.stringify(expected)}, obtido ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("normalizeMessagingText", async (t) => {
  await t.step("lowercases all-caps input", () => {
    expectEqual(normalizeMessagingText("PARAR"), "parar", "PARAR");
  });

  await t.step("lowercases mixed case", () => {
    expectEqual(normalizeMessagingText("StOp"), "stop", "StOp");
  });

  await t.step("strips acute/circumflex/tilde accents", () => {
    expectEqual(normalizeMessagingText("Inscrição"), "inscricao", "Inscrição");
    expectEqual(normalizeMessagingText("não"), "nao", "não");
    expectEqual(normalizeMessagingText("café"), "cafe", "café");
  });

  await t.step("strips accents combined with uppercase", () => {
    expectEqual(normalizeMessagingText("VOLTAR JÁ"), "voltar ja", "VOLTAR JÁ");
  });

  // Pontuação NÃO é removida por esta função (decisão deliberada -- ver
  // comentário em text-normalize.ts). A tolerância a pontuação final pra
  // efeito de comparação de palavra-chave é aplicada separadamente no call
  // site (messaging-webhook/index.ts, stripTrailingPunctuation), não aqui.
  await t.step("keeps trailing punctuation untouched", () => {
    expectEqual(normalizeMessagingText("Sair!"), "sair!", "Sair!");
    expectEqual(normalizeMessagingText("sair."), "sair.", "sair.");
  });

  await t.step("trims leading/trailing whitespace", () => {
    expectEqual(normalizeMessagingText("  sair  "), "sair", "  sair  ");
  });

  await t.step("collapses internal multiple spaces", () => {
    expectEqual(
      normalizeMessagingText("quero    sair    agora"),
      "quero sair agora",
      "quero    sair    agora",
    );
  });

  await t.step("collapses tabs and newlines as whitespace", () => {
    expectEqual(normalizeMessagingText("sair\t\ndaqui"), "sair daqui", "sair\\t\\ndaqui");
  });

  await t.step("empty string stays empty", () => {
    expectEqual(normalizeMessagingText(""), "", "<empty>");
  });

  await t.step("whitespace-only collapses to empty", () => {
    expectEqual(normalizeMessagingText("   "), "", "<spaces>");
  });
});
