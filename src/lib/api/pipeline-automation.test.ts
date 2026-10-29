import { describe, expect, it } from "vitest";

import type { DealsUpdate, StageTransitionsUpdate } from "./pipeline-automation";

/**
 * Teste de CONTRATO DE TIPO (roda no `tsc --noEmit`, não só no vitest).
 *
 * Achado 04 · H2 do code review de 10/08: `LooseQuery` tipava `.update()` como
 * `(values: Record<string, unknown>) => LooseQuery`, sem nenhum vínculo com as
 * colunas reais -- um nome de coluna errado compilava limpo e só quebrava em
 * runtime (PostgREST 42703/PGRST204), no meio de uma mutation do Kanban.
 *
 * Cada `@ts-expect-error` abaixo é a regressão: se o payload voltar a ser
 * frouxo, a linha errada passa a compilar, a diretiva fica sem uso e o tsc
 * falha com TS2578 ("Unused '@ts-expect-error' directive").
 */
describe("contrato de tipos das mutations do pipeline automation", () => {
  it("payload de pausa de deal é validado contra as colunas de public.deals", () => {
    const valido: DealsUpdate = {
      automation_mode: "paused",
      automation_lock_reason: "Pausada manualmente no Kanban",
      automation_paused_until: null,
    };
    expect(valido.automation_mode).toBe("paused");

    const colunaInexistente: DealsUpdate = {
      // @ts-expect-error `automation_mod` (typo) não existe em public.deals
      automation_mod: "paused",
    };
    expect(colunaInexistente).toBeTruthy();

    const tipoErrado: DealsUpdate = {
      // @ts-expect-error automation_paused_until é timestamp (string|null), não number
      automation_paused_until: 42,
    };
    expect(tipoErrado).toBeTruthy();
  });

  it("payload da regra de transição é validado contra public.stage_transitions", () => {
    const valido: StageTransitionsUpdate = {
      autonomy_mode: "assisted",
      min_confidence: 0.8,
      requires_human_approval: true,
    };
    expect(valido.min_confidence).toBe(0.8);

    const colunaInexistente: StageTransitionsUpdate = {
      // @ts-expect-error `minimum_confidence` não existe em public.stage_transitions
      minimum_confidence: 0.8,
    };
    expect(colunaInexistente).toBeTruthy();

    const tipoErrado: StageTransitionsUpdate = {
      // @ts-expect-error requires_human_approval é boolean, não string
      requires_human_approval: "sim",
    };
    expect(tipoErrado).toBeTruthy();
  });
});
