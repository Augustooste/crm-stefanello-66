// Testa o comportamento real do contrato de erro tipado de IA. O corpo deste
// arquivo é travado byte-a-byte contra supabase/functions/_shared/ai/errors.ts
// por errors-sync.test.ts (guarda de drift) — os casos abaixo espelham
// supabase/functions/tests/errors.test.ts (suíte Deno do gêmeo), adaptados
// para vitest, porque nenhum teste anterior exercitava o comportamento em si
// (sanitização, classificação, extração de metadados) do lado do client.
import { describe, expect, it } from "vitest";
import { extractProviderErrorMeta, isRateLimitError, sanitizeProviderError } from "./errors";

describe("sanitizeProviderError", () => {
  it("redige um Bearer token e nunca vaza o segredo na mensagem", () => {
    const err = new Error("Request failed: Authorization: Bearer sk-abc123XYZ (401)");
    const result = sanitizeProviderError(err);

    expect(result.message).not.toContain("sk-abc123XYZ");
    expect(result.message).toContain("Bearer [REDACTED]");
  });

  it("redige key=... e nunca vaza o segredo na mensagem", () => {
    const err = new Error("provider rejected request, key=sk-live-9f8e7d6c5b4a");
    const result = sanitizeProviderError(err);

    expect(result.message).not.toContain("sk-live-9f8e7d6c5b4a");
    expect(result.message).toContain("key=[REDACTED]");
  });

  it("redige token:... e secret:... preservando o prefixo", () => {
    const err = new Error("token: abc.def.ghi and secret: shh-dont-tell");
    const result = sanitizeProviderError(err);

    expect(result.message).not.toContain("abc.def.ghi");
    expect(result.message).not.toContain("shh-dont-tell");
    expect(result.message).toContain("token: [REDACTED]");
    expect(result.message).toContain("secret: [REDACTED]");
  });

  it("extrai statusCode do campo `status` quando presente", () => {
    const err = { message: "internal server error", status: 503 };
    const result = sanitizeProviderError(err);

    expect(result.statusCode).toBe(503);
    expect(result.code).toBe("PROVIDER_5XX");
  });

  it("extrai statusCode do campo `statusCode` quando presente (prioridade sobre `status`)", () => {
    const err = { message: "erro", statusCode: 429, status: 500 };
    const result = sanitizeProviderError(err);

    expect(result.statusCode).toBe(429);
    expect(result.code).toBe("RATE_LIMIT");
  });

  it("code UNKNOWN e statusCode omitido quando erro não bate em nenhuma heurística", () => {
    const err = new Error("algo inesperado aconteceu, sem padrão conhecido");
    const result = sanitizeProviderError(err);

    expect(result.code).toBe("UNKNOWN");
    expect(result).not.toHaveProperty("statusCode");
    expect(result).not.toHaveProperty("provider");
    expect(result).not.toHaveProperty("retryAfterSeconds");
  });

  it("erro como string vira UNKNOWN sem lançar", () => {
    const result = sanitizeProviderError("connection reset");
    expect(result.code).toBe("UNKNOWN");
    expect(result.message).toBe("connection reset");
  });

  it("erro como objeto sem `message` cai no fallback JSON.stringify sem lançar", () => {
    const result = sanitizeProviderError({ foo: "bar" });
    expect(result.code).toBe("UNKNOWN");
    expect(result.message).toBe(JSON.stringify({ foo: "bar" }));
  });

  it("erro null/undefined não lança e vira UNKNOWN", () => {
    expect(sanitizeProviderError(null).code).toBe("UNKNOWN");
    expect(sanitizeProviderError(undefined).code).toBe("UNKNOWN");
  });

  it("objeto com referência circular (JSON.stringify lança) cai no fallback String(err) sem lançar", () => {
    const circular: Record<string, unknown> = { status: 500 };
    circular.self = circular;

    const result = sanitizeProviderError(circular);

    expect(result.code).toBe("PROVIDER_5XX");
    expect(result.message).toBe(String(circular));
  });

  it("code RATE_LIMIT quando statusCode 429", () => {
    const result = sanitizeProviderError({ message: "rate limited, back off", status: 429 });
    expect(result.code).toBe("RATE_LIMIT");
    expect(result.statusCode).toBe(429);
  });

  it("code RATE_LIMIT quando a mensagem indica 'too many requests' sem statusCode", () => {
    const result = sanitizeProviderError(new Error("too many requests, please retry later"));
    expect(result.code).toBe("RATE_LIMIT");
    expect(result).not.toHaveProperty("statusCode");
  });

  it("code PROVIDER_AUTH quando statusCode 401", () => {
    const result = sanitizeProviderError({ message: "invalid api key", status: 401 });
    expect(result.code).toBe("PROVIDER_AUTH");
    expect(result.statusCode).toBe(401);
  });

  it("code PROVIDER_AUTH quando statusCode 403", () => {
    const result = sanitizeProviderError({ message: "forbidden", status: 403 });
    expect(result.code).toBe("PROVIDER_AUTH");
    expect(result.statusCode).toBe(403);
  });

  it("code PROVIDER_AUTH quando a mensagem indica falha de autenticação sem statusCode", () => {
    const result = sanitizeProviderError(new Error("authentication failed for this request"));
    expect(result.code).toBe("PROVIDER_AUTH");
  });

  it("code PROVIDER_QUOTA quando a mensagem indica quota/créditos insuficientes", () => {
    const result = sanitizeProviderError(new Error("insufficient quota for this request"));
    expect(result.code).toBe("PROVIDER_QUOTA");
  });

  it("code PROVIDER_QUOTA quando statusCode 402, mesmo sem a mensagem bater no regex de quota", () => {
    // Mensagem real gerada por supabase/functions/ai-respond/index.ts para
    // statusCode 402 — sem o check direto de statusCode esse erro viraria
    // UNKNOWN (mesmo caso coberto na suíte Deno do gêmeo).
    const err = {
      message: "Créditos de IA esgotados. Recarregue para continuar respondendo.",
      status: 402,
    };
    const result = sanitizeProviderError(err);

    expect(result.code).toBe("PROVIDER_QUOTA");
    expect(result.statusCode).toBe(402);
  });

  it("code PROVIDER_5XX para qualquer statusCode entre 500 e 599", () => {
    expect(sanitizeProviderError({ message: "x", status: 500 }).code).toBe("PROVIDER_5XX");
    expect(sanitizeProviderError({ message: "x", status: 599 }).code).toBe("PROVIDER_5XX");
  });

  it("code CONTENT_BLOCKED quando a mensagem indica bloqueio de moderação", () => {
    const result = sanitizeProviderError(new Error("this response was blocked by safety filters"));
    expect(result.code).toBe("CONTENT_BLOCKED");
  });

  it("code TIMEOUT quando a mensagem indica timeout/abort", () => {
    const result = sanitizeProviderError(new Error("request timed out after 30s (ETIMEDOUT)"));
    expect(result.code).toBe("TIMEOUT");
  });

  it("inclui provider e retryAfterSeconds quando presentes no erro de origem", () => {
    const err = {
      message: "rate limited",
      status: 429,
      provider: "openai",
      retryAfterSeconds: 12,
    };
    const result = sanitizeProviderError(err);

    expect(result.provider).toBe("openai");
    expect(result.retryAfterSeconds).toBe(12);
  });

  it("omite provider/retryAfterSeconds (chave ausente, não só undefined) quando não vêm no erro", () => {
    const result = sanitizeProviderError(new Error("qualquer coisa"));
    expect(Object.prototype.hasOwnProperty.call(result, "provider")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result, "retryAfterSeconds")).toBe(false);
  });
});

describe("extractProviderErrorMeta", () => {
  it("extrai retryAfterSeconds de header Retry-After (segundos)", () => {
    const response = new Response(null, { status: 429, headers: { "Retry-After": "30" } });
    const meta = extractProviderErrorMeta(response);

    expect(meta.statusCode).toBe(429);
    expect(meta.retryAfterSeconds).toBe(30);
  });

  it("statusCode de response.status quando não há Retry-After", () => {
    const response = new Response(null, { status: 500 });
    const meta = extractProviderErrorMeta(response);

    expect(meta.statusCode).toBe(500);
    expect(meta).not.toHaveProperty("retryAfterSeconds");
  });

  it("Retry-After como data HTTP resulta em segundos >= 0", () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const response = new Response(null, { status: 429, headers: { "Retry-After": future } });
    const meta = extractProviderErrorMeta(response);

    expect(meta.retryAfterSeconds).toBeGreaterThanOrEqual(0);
  });

  it("objeto mínimo sem headers não lança e omite retryAfterSeconds", () => {
    const meta = extractProviderErrorMeta({ status: 200 });
    expect(meta.statusCode).toBe(200);
    expect(meta).not.toHaveProperty("retryAfterSeconds");
  });

  it("omite statusCode quando response.status não é number", () => {
    const meta = extractProviderErrorMeta({});
    expect(meta).not.toHaveProperty("statusCode");
  });
});

describe("isRateLimitError", () => {
  it("true quando o AiError tem code RATE_LIMIT", () => {
    const result = sanitizeProviderError({ message: "rate limited, back off", status: 429 });
    expect(isRateLimitError(result)).toBe(true);
  });

  it("false quando o AiError tem outro code", () => {
    const result = sanitizeProviderError({ message: "invalid api key", status: 401 });
    expect(isRateLimitError(result)).toBe(false);
  });

  it("false quando o erro é null ou undefined", () => {
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
  });
});
