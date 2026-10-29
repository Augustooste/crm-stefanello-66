/**
 * Executor genérico de operações em lote com concorrência limitada.
 *
 * Porta o padrão `useBulkDeleteContacts` do medflow: nunca dispara N
 * requisições simultâneas, roda em lotes de `batchSize` com
 * `Promise.allSettled` (uma falha isolada não derruba o lote nem os
 * seguintes) e devolve um relatório com sucesso/falha por item, cada falha
 * com seu motivo — nunca mascara erro nem para no primeiro problema.
 */

export interface BatchFailure<TId = string> {
  id: TId;
  motivo: string;
}

export interface BatchReport<TId = string> {
  sucesso: number;
  falhas: number;
  erros: BatchFailure<TId>[];
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Erro desconhecido";
}

/**
 * Roda `task` para cada item de `ids`, em lotes de `batchSize` com
 * `Promise.allSettled` (concorrência limitada dentro do lote, lotes em
 * série). Um item que falha não interrompe os demais — sua falha é
 * reportada em `erros` com o motivo extraído do erro lançado.
 */
export async function runInBatches<TId = string>(
  ids: readonly TId[],
  batchSize: number,
  task: (id: TId) => Promise<void>,
): Promise<BatchReport<TId>> {
  if (batchSize < 1) throw new Error("batchSize deve ser >= 1");

  let sucesso = 0;
  const erros: BatchFailure<TId>[] = [];

  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const settled = await Promise.allSettled(batch.map((id) => task(id)));
    settled.forEach((result, idx) => {
      if (result.status === "fulfilled") {
        sucesso += 1;
      } else {
        erros.push({ id: batch[idx], motivo: getErrorMessage(result.reason) });
      }
    });
  }

  return { sucesso, falhas: erros.length, erros };
}
