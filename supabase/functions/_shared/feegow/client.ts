// client.ts — cliente HTTP mínimo da API Feegow (docs.feegow.com), Fase 6
// Sub-feature 2. Porta SÓ a capacidade de busca de agendamentos
// (GET /appoints/search) de medflow-v0 lib/feegow/{client,rate-limiter,
// errors}.ts (fonte de verdade, somente leitura, nunca copiada literalmente
// porque aquele repo usa classe + Node/Next.js e este projeto é Deno-puro/
// funcional -- mesmo racional documentado em
// _shared/messaging/evolution-client.ts). Corte de escopo deliberado (PRD,
// docs/PRD-CRM-IA-MULTINICHO.md linhas 2514-2572): nenhum CRUD de
// paciente/convênio/procedimento/profissional/unidade -- ~500 linhas do
// client original não usadas por este CRM genérico.
import {
  createFeegowError,
  FeegowError,
  FeegowErrorCode,
  FeegowNetworkError,
  isRetryableError,
} from "./errors.ts";
import { createRateLimiter, DEFAULT_RATE_LIMIT_CONFIG } from "./rate-limiter.ts";

const BASE_URL = "https://api.feegow.com/v1/api";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 3;

/**
 * Credenciais Feegow por tenant. `clinicId` hoje não é usado no header/query
 * de `/appoints/search` (a API resolve a clínica pelo próprio access_token),
 * mas é guardado em `integration_secrets` e exposto aqui porque o catálogo
 * (`required_secrets`) pede os dois campos ao admin -- e um endpoint futuro
 * (fora do escopo desta sub-feature) pode precisar dele.
 */
export interface FeegowCredentials {
  clinicId: string;
  accessToken: string;
  /** Só para teste/override -- produção sempre usa BASE_URL. */
  apiBaseUrl?: string;
}

export interface FeegowClientOptions {
  timeoutMs?: number;
  maxRetries?: number;
  rateLimitPerMinute?: number;
}

export interface SearchAppointmentsParams {
  /** Formato "dd-mm-YYYY", conforme a API Feegow. */
  data_start: string;
  data_end: string;
}

/**
 * GET /appoints/search -- shape real devolvido pela API Feegow, só os
 * campos usados pelo mapeamento em ../feegow-sync/runner.ts. `duracao` é um
 * campo extra que a API retorna mas não é documentado no schema básico
 * (mesma observação de medflow-v0 FeegowAppointmentRaw).
 */
export interface FeegowAppointment {
  agendamento_id: number;
  data: string;
  horario: string;
  status_id: number;
  telemedicina?: boolean;
  duracao?: number | string | null;
}

interface FeegowApiResponse<T> {
  success: boolean;
  content?: T;
  message?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSearchUrl(baseUrl: string, params: SearchAppointmentsParams): string {
  const url = new URL(`${baseUrl}/appoints/search`);
  url.searchParams.set("data_start", params.data_start);
  url.searchParams.set("data_end", params.data_end);
  return url.toString();
}

async function fetchWithTimeout(url: string, accessToken: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json", "x-access-token": accessToken },
      signal: controller.signal,
    });

    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = await response.text();
      }
      throw createFeegowError(response.status, body);
    }

    return await response.json();
  } catch (error) {
    if (error instanceof FeegowError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new FeegowError(`Timeout ao chamar a Feegow (${timeoutMs}ms)`, FeegowErrorCode.TIMEOUT, {
        statusCode: 408,
        isRetryable: true,
      });
    }
    throw new FeegowNetworkError(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Busca agendamentos da Feegow com retry exponencial (mesmos códigos
 * retryable de errors.ts: timeout, erro de rede, 5xx, 429) + rate limiting
 * (token-bucket, default 60 req/min, 1 bucket novo por chamada -- cada
 * tenant tem sua própria credencial/limite, nunca compartilhado entre
 * tenants). Nunca lança para `status_id` desconhecido no payload -- esse
 * mapeamento é responsabilidade de ../feegow-sync/runner.ts, não deste
 * client.
 */
export async function searchAppointments(
  credentials: FeegowCredentials,
  params: SearchAppointmentsParams,
  options: FeegowClientOptions = {},
): Promise<FeegowAppointment[]> {
  const baseUrl = credentials.apiBaseUrl || BASE_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const rateLimiter = createRateLimiter({
    maxRequests: options.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_CONFIG.maxRequests,
  });
  const url = buildSearchUrl(baseUrl, params);

  await rateLimiter.acquire();

  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const json = (await fetchWithTimeout(url, credentials.accessToken, timeoutMs)) as FeegowApiResponse<
        FeegowAppointment[]
      >;
      if (!json.success) return [];
      return Array.isArray(json.content) ? json.content : [];
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt === maxRetries - 1) throw error;
      await sleep(Math.pow(2, attempt) * 1000);
    }
  }
  throw lastError instanceof Error ? lastError : new FeegowNetworkError("Falha desconhecida ao chamar a Feegow");
}
