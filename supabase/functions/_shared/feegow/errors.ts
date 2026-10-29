// errors.ts — erros tipados da API Feegow (Fase 6, Sub-feature 2). Porta
// SÓ o que o client de busca de agendamentos (client.ts) usa de
// medflow-v0 lib/feegow/errors.ts (fonte de verdade, somente leitura) --
// corte de escopo deliberado (PRD, docs/PRD-CRM-IA-MULTINICHO.md linhas
// 2514-2572): sem os códigos/erros específicos de paciente, convênio,
// procedimento ou sincronização (PATIENT_NOT_FOUND, DUPLICATE_ENTRY,
// SYNC_FAILED, etc.) -- nenhum consumidor deles neste adapter, que só faz
// GET /appoints/search.

export enum FeegowErrorCode {
  BAD_REQUEST = "BAD_REQUEST",
  INVALID_TOKEN = "INVALID_TOKEN",
  NOT_FOUND = "NOT_FOUND",
  VALIDATION_ERROR = "VALIDATION_ERROR",
  RATE_LIMIT_EXCEEDED = "RATE_LIMIT_EXCEEDED",
  INTERNAL_ERROR = "INTERNAL_ERROR",
  SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE",
  TIMEOUT = "TIMEOUT",
  NETWORK_ERROR = "NETWORK_ERROR",
}

const STATUS_TO_ERROR_CODE: Record<number, FeegowErrorCode> = {
  400: FeegowErrorCode.BAD_REQUEST,
  401: FeegowErrorCode.INVALID_TOKEN,
  403: FeegowErrorCode.INVALID_TOKEN,
  404: FeegowErrorCode.NOT_FOUND,
  422: FeegowErrorCode.VALIDATION_ERROR,
  429: FeegowErrorCode.RATE_LIMIT_EXCEEDED,
  500: FeegowErrorCode.INTERNAL_ERROR,
  502: FeegowErrorCode.SERVICE_UNAVAILABLE,
  503: FeegowErrorCode.SERVICE_UNAVAILABLE,
  504: FeegowErrorCode.SERVICE_UNAVAILABLE,
};

function isRetryableCode(code: FeegowErrorCode): boolean {
  return (
    code === FeegowErrorCode.TIMEOUT ||
    code === FeegowErrorCode.NETWORK_ERROR ||
    code === FeegowErrorCode.SERVICE_UNAVAILABLE ||
    code === FeegowErrorCode.RATE_LIMIT_EXCEEDED
  );
}

export class FeegowError extends Error {
  public readonly code: FeegowErrorCode;
  public readonly statusCode?: number;
  public readonly details?: unknown;
  public readonly isRetryable: boolean;
  public readonly retryAfter?: number;

  constructor(
    message: string,
    code: FeegowErrorCode,
    options?: { statusCode?: number; details?: unknown; isRetryable?: boolean; retryAfter?: number },
  ) {
    super(message);
    this.name = "FeegowError";
    this.code = code;
    this.statusCode = options?.statusCode;
    this.details = options?.details;
    this.retryAfter = options?.retryAfter;
    this.isRetryable = options?.isRetryable ?? isRetryableCode(code);
  }
}

/** Erro de autenticação/autorização (token/clinic_id inválidos). */
export class FeegowAuthError extends FeegowError {
  constructor(message: string, options?: { statusCode?: number; details?: unknown }) {
    super(message, FeegowErrorCode.INVALID_TOKEN, options);
    this.name = "FeegowAuthError";
  }
}

/** Erro de validação de parâmetros antes de chamar a API (fail fast). */
export class FeegowValidationError extends FeegowError {
  public readonly validationErrors: Record<string, string[]>;

  constructor(validationErrors: Record<string, string[]>) {
    super(`Validação falhou: ${JSON.stringify(validationErrors)}`, FeegowErrorCode.VALIDATION_ERROR, {
      statusCode: 422,
    });
    this.name = "FeegowValidationError";
    this.validationErrors = validationErrors;
  }
}

/** 429 — sempre retryable; `retryAfter` em segundos quando a API informar. */
export class FeegowRateLimitError extends FeegowError {
  constructor(retryAfter?: number) {
    super("Limite de requisições da Feegow excedido", FeegowErrorCode.RATE_LIMIT_EXCEEDED, {
      statusCode: 429,
      isRetryable: true,
      retryAfter,
    });
    this.name = "FeegowRateLimitError";
  }
}

/** Timeout/erro de rede (fetch abortado, DNS, conexão recusada) -- sempre retryable. */
export class FeegowNetworkError extends FeegowError {
  constructor(message: string) {
    super(message, FeegowErrorCode.NETWORK_ERROR, { isRetryable: true });
    this.name = "FeegowNetworkError";
  }
}

/** Converte um response HTTP não-ok da Feegow no FeegowError correspondente. */
export function createFeegowError(statusCode: number, responseBody?: unknown): FeegowError {
  const code = STATUS_TO_ERROR_CODE[statusCode] ?? FeegowErrorCode.INTERNAL_ERROR;
  let message = `Feegow API error: ${statusCode}`;
  let details: unknown;

  if (responseBody && typeof responseBody === "object") {
    const body = responseBody as Record<string, unknown>;
    message = (body.message as string) || (body.error as string) || message;
    details = body;
  }

  return new FeegowError(message, code, {
    statusCode,
    details,
    isRetryable: statusCode >= 500 || statusCode === 429,
  });
}

/** 5xx e 429 (e timeout/erro de rede) são retryable; os demais, não. */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof FeegowError) return error.isRetryable;
  if (error instanceof Error) {
    return error.name === "AbortError" || error.message.toLowerCase().includes("network");
  }
  return false;
}
