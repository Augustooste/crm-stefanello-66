import { buildEnvelope } from "../_shared/webhooks/envelope.ts";
import { nextAttemptDelaySeconds } from "../_shared/webhooks/backoff.ts";
import { SIGNATURE_HEADER, signWebhook } from "../_shared/webhooks/sign.ts";
import {
  type ValidateOptions,
  type ValidateResult,
  validatePublicHttpsUrl,
} from "../_shared/validate-http-url.ts";

/** Validação da URL na entrega: DNS com teto de 3 s e falha fechada (retry), para o lote não passar do lease. */
export const validateWebhookUrl = (url: string, overrides: ValidateOptions = {}): Promise<ValidateResult> =>
  validatePublicHttpsUrl(url, { ...overrides, failClosedOnDnsTimeout: true });

export const BATCH_SIZE = 10;
export const CLAIM_LIMIT = 30; // 3 lotes de até 10 s cabem no lease de 60 s
export const DELIVERY_TIMEOUT_MS = 10_000;
export const MAX_EXCERPT_BYTES = 2048;
export const MAX_PAYLOAD_BYTES = 256 * 1024;
const USER_AGENT = "Aceleraflow-Webhooks/1";

export interface DeliveryRow {
  id: string;
  tenant_id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  status: string;
  attempts: number;
  max_attempts: number;
}
export interface EventRow {
  id: string;
  event_type: string;
  tenant_id: string;
  occurred_at: string;
  payload: unknown;
}
export interface EndpointRow {
  id: string;
  url: string;
  active: boolean;
}
export interface WebhookWorkerDb {
  claim(limit: number, worker: string): Promise<DeliveryRow[]>;
  loadEndpoint(id: string): Promise<EndpointRow | null>;
  loadEvent(id: string): Promise<EventRow | null>;
  getSecrets(endpointId: string): Promise<{ current: string | null; previous: string | null }>;
  complete(id: string, worker: string, status: number, excerpt: string | null): Promise<void>;
  fail(
    id: string,
    worker: string,
    error: string,
    status: number | null,
    excerpt: string | null,
    retryAt: Date,
  ): Promise<void>;
  /** Vai direto a dead_letter (sem nova tentativa), só se o lease ainda for deste worker. */
  deadLetter(id: string, worker: string, error: string): Promise<void>;
  disableEndpoint(id: string, reason: string): Promise<void>;
}
export interface WorkerOptions {
  validateUrl: (url: string) => Promise<ValidateResult>;
  timeoutMs?: number;
}
export interface WorkerResult {
  claimed: number;
  delivered: number;
  failed: number;
  errored: number;
}

type Outcome = "delivered" | "failed";

/** Lê no máximo `max` bytes do corpo e cancela o resto (memória limitada). */
async function readExcerpt(res: Response, max: number): Promise<string | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value.subarray(0, max - total));
      total += chunks[chunks.length - 1].length;
    }
  } catch {
    // corpo interrompido (timeout/reset): usa o que já chegou
  } finally {
    await reader.cancel().catch(() => {});
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }
  // Postgres text não aceita NUL: sem isto, um 200 com 0x00 no corpo viraria erro e reentrega duplicada.
  const text = new TextDecoder().decode(buf).replaceAll("\u0000", "");
  return text || null;
}

async function buildSignatureHeader(
  secrets: { current: string | null; previous: string | null },
  timestamp: number,
  body: string,
): Promise<string> {
  if (!secrets.current) throw new Error("segredo ausente");
  const parts = [`t=${timestamp}`, await signWebhook(secrets.current, timestamp, body)];
  if (secrets.previous) parts.push(await signWebhook(secrets.previous, timestamp, body));
  return parts.join(",");
}

async function deliverOne(
  db: WebhookWorkerDb,
  worker: string,
  d: DeliveryRow,
  opts: WorkerOptions,
): Promise<Outcome> {
  const retry = (error: string, status: number | null = null, excerpt: string | null = null) =>
    db.fail(d.id, worker, error, status, excerpt, new Date(Date.now() + nextAttemptDelaySeconds(d.attempts) * 1000))
      .then((): Outcome => "failed");

  let endpoint: EndpointRow | null;
  let prepared: { url: string; eventType: string; body: string; signature: string };
  try {
    endpoint = await db.loadEndpoint(d.endpoint_id);
    if (!endpoint || !endpoint.active) return retry("endpoint indisponivel");
    const event = await db.loadEvent(d.event_id);
    if (!event) return retry("evento nao encontrado");

    const check = await opts.validateUrl(endpoint.url);
    if (!check.ok) return retry(`url bloqueada: ${check.error ?? "invalida"}`);

    const body = JSON.stringify(buildEnvelope({
      id: event.id,
      type: event.event_type,
      tenant_id: event.tenant_id,
      occurred_at: event.occurred_at,
      payload: event.payload,
    }));
    if (new TextEncoder().encode(body).length > MAX_PAYLOAD_BYTES) {
      await db.deadLetter(d.id, worker, "payload muito grande");
      return "failed";
    }
    const secrets = await db.getSecrets(d.endpoint_id);
    const timestamp = Math.floor(Date.now() / 1000);
    prepared = {
      url: endpoint.url,
      eventType: event.event_type,
      body,
      signature: await buildSignatureHeader(secrets, timestamp, body),
    };
  } catch (e) {
    // Falha de preparação (banco, RPC, segredo): registra a falha em vez de deixar o lease expirar.
    return await retry(`erro interno: ${e instanceof Error ? e.name : "desconhecido"}`);
  }

  let res: Response;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? DELIVERY_TIMEOUT_MS);
  try {
    res = await fetch(prepared.url, {
      method: "POST",
      redirect: "manual",
      signal,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "X-Aceleraflow-Event": prepared.eventType,
        "X-Aceleraflow-Delivery": d.id,
        [SIGNATURE_HEADER]: prepared.signature,
      },
      body: prepared.body,
    });
  } catch (e) {
    const timedOut = signal.aborted || (e instanceof DOMException && e.name === "TimeoutError");
    return retry(timedOut ? "timeout" : `erro de rede: ${e instanceof Error ? e.name : "desconhecido"}`);
  }

  const excerpt = await readExcerpt(res, MAX_EXCERPT_BYTES);
  if (res.status >= 200 && res.status < 300) {
    await db.complete(d.id, worker, res.status, excerpt);
    return "delivered";
  }
  if (res.status === 410) {
    // Isolado: falha ao desativar não pode impedir o registro da entrega (nem o contrário).
    await db.disableEndpoint(d.endpoint_id, "gone").catch(() => {});
  }
  return retry(`resposta HTTP ${res.status}`, res.status, excerpt);
}

export async function runWebhookDeliveryWorker(
  db: WebhookWorkerDb,
  worker: string,
  opts: WorkerOptions,
): Promise<WorkerResult> {
  const claimed = await db.claim(CLAIM_LIMIT, worker);
  const result: WorkerResult = { claimed: claimed.length, delivered: 0, failed: 0, errored: 0 };
  for (let i = 0; i < claimed.length; i += BATCH_SIZE) {
    const batch = claimed.slice(i, i + BATCH_SIZE);
    const settled = await Promise.allSettled(batch.map((d) => deliverOne(db, worker, d, opts)));
    for (const s of settled) {
      if (s.status === "rejected") result.errored++; // lease expira e a tentativa é recontada
      else if (s.value === "delivered") result.delivered++;
      else result.failed++;
    }
  }
  return result;
}
