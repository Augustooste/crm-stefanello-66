import { describe, expect, it } from "vitest";

import { runInBatches } from "./batch-runner";

describe("runInBatches", () => {
  it("processa todos os ids em lotes, nunca excedendo a concorrência pedida", async () => {
    const ids = ["a", "b", "c", "d", "e"];
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];

    await runInBatches(ids, 3, async (id) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(id);
      await Promise.resolve();
      inFlight -= 1;
    });

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(order).toEqual(ids);
  });

  it("reporta sucesso e falha corretamente quando 1 item falha no meio do lote", async () => {
    const ids = ["a", "b", "c", "d", "e"];

    const report = await runInBatches(ids, 3, async (id) => {
      if (id === "c") throw new Error("erro ao atualizar c");
    });

    expect(report.sucesso).toBe(4);
    expect(report.falhas).toBe(1);
    expect(report.erros).toEqual([{ id: "c", motivo: "erro ao atualizar c" }]);
  });

  it("não interrompe os lotes seguintes quando um item de um lote anterior falha", async () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g"];
    const processed: string[] = [];

    const report = await runInBatches(ids, 3, async (id) => {
      processed.push(id);
      if (id === "b") throw new Error("falhou no primeiro lote");
    });

    // batches: [a,b,c] [d,e,f] [g] — mesmo falhando "b" no 1º lote, os
    // lotes seguintes continuam rodando.
    expect(processed).toEqual(ids);
    expect(report.sucesso).toBe(6);
    expect(report.falhas).toBe(1);
    expect(report.erros).toEqual([{ id: "b", motivo: "falhou no primeiro lote" }]);
  });

  it("extrai motivo de erros não-Error (string, objeto, undefined)", async () => {
    const ids = ["a", "b", "c"];

    const report = await runInBatches(ids, 3, async (id) => {
      if (id === "a") throw "motivo em string";
      if (id === "b") throw new Error("motivo em Error");
      if (id === "c") throw { code: 500 };
    });

    expect(report.falhas).toBe(3);
    expect(report.erros).toEqual(
      expect.arrayContaining([
        { id: "a", motivo: "motivo em string" },
        { id: "b", motivo: "motivo em Error" },
        { id: "c", motivo: "Erro desconhecido" },
      ]),
    );
  });

  it("retorna relatório zerado para lista vazia, sem chamar a task", async () => {
    let calls = 0;
    const report = await runInBatches([], 3, async () => {
      calls += 1;
    });

    expect(calls).toBe(0);
    expect(report).toEqual({ sucesso: 0, falhas: 0, erros: [] });
  });

  it("rejeita batchSize menor que 1", async () => {
    await expect(runInBatches(["a"], 0, async () => {})).rejects.toThrow("batchSize deve ser >= 1");
  });
});
