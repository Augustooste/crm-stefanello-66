// Testa detectAssistantUncertainty (supabase/functions/_shared/ai/uncertainty.ts).
// Função pura, sem I/O — não precisa de mock de rede/env.
import { detectAssistantUncertainty } from "../_shared/ai/uncertainty.ts";

Deno.test("detectAssistantUncertainty", async (t) => {
  await t.step("frase com 'não sei' sinaliza incerteza", () => {
    const result = detectAssistantUncertainty("Não sei te responder isso agora.");
    if (result !== true) throw new Error("esperado true para frase com 'não sei'");
  });

  await t.step("resposta normal do fluxo não sinaliza incerteza", () => {
    const result = detectAssistantUncertainty(
      "Perfeito! Vou verificar os horários disponíveis para você essa semana.",
    );
    if (result !== false) throw new Error("esperado false para resposta normal de agenda");
  });

  await t.step("frase que menciona 'sei' mas não é incerteza não é falso positivo", () => {
    const result = detectAssistantUncertainty("Seu problema, eu entendo, vamos resolver juntos.");
    if (result !== false) {
      throw new Error("esperado false — 'sei' não deve casar fora de negação de conhecimento");
    }
  });

  await t.step("'não sei se' (uso especulativo) não sinaliza incerteza", () => {
    const result = detectAssistantUncertainty("Não sei se ficou claro, mas vamos continuar.");
    if (result !== false) throw new Error("esperado false para uso especulativo de 'não sei se'");
  });

  await t.step("'não tenho certeza' sinaliza incerteza", () => {
    const result = detectAssistantUncertainty("Não tenho certeza sobre esse valor específico.");
    if (result !== true) throw new Error("esperado true para 'não tenho certeza'");
  });

  await t.step("'vou verificar com a equipe' sinaliza incerteza (handoff canônico)", () => {
    const result = detectAssistantUncertainty("Vou verificar com a equipe e já te retorno.");
    if (result !== true) throw new Error("esperado true para 'vou verificar com a equipe'");
  });

  await t.step("'não consigo confirmar' sinaliza incerteza", () => {
    const result = detectAssistantUncertainty("Não consigo confirmar esse dado agora.");
    if (result !== true) throw new Error("esperado true para 'não consigo confirmar'");
  });

  await t.step("texto vazio não sinaliza incerteza", () => {
    const result = detectAssistantUncertainty("");
    if (result !== false) throw new Error("esperado false para texto vazio");
  });
});
