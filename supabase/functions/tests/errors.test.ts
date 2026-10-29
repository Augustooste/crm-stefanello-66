// Testa o contrato de erro tipado de IA (supabase/functions/_shared/ai/errors.ts):
// sanitizeProviderError nunca vaza segredo e classifica corretamente,
// extractProviderErrorMeta lê status/Retry-After de uma Response, e
// isRateLimitError é o guard de conveniência sobre o código classificado.
import {
  extractProviderErrorMeta,
  isRateLimitError,
  sanitizeProviderError,
} from "../_shared/ai/errors.ts";

Deno.test("sanitizeProviderError", async (t) => {
  await t.step("sanitiza mensagem com Bearer token (nunca vaza o segredo)", () => {
    const err = new Error("Request failed: Authorization: Bearer sk-abc123XYZ (401)");
    const result = sanitizeProviderError(err);

    if (result.message.includes("sk-abc123XYZ")) {
      throw new Error(`segredo vazou na mensagem: ${result.message}`);
    }
    if (!result.message.includes("Bearer [REDACTED]")) {
      throw new Error(`mensagem não redigida como esperado: ${result.message}`);
    }
  });

  await t.step("sanitiza mensagem com key=... (nunca vaza o segredo)", () => {
    const err = new Error("provider rejected request, key=sk-live-9f8e7d6c5b4a");
    const result = sanitizeProviderError(err);

    if (result.message.includes("sk-live-9f8e7d6c5b4a")) {
      throw new Error(`segredo vazou na mensagem: ${result.message}`);
    }
    if (!result.message.includes("key=[REDACTED]")) {
      throw new Error(`mensagem não redigida como esperado: ${result.message}`);
    }
  });

  await t.step("statusCode extraído do próprio erro quando presente", () => {
    const err = { message: "internal server error", status: 503 };
    const result = sanitizeProviderError(err);

    if (result.statusCode !== 503) throw new Error(`statusCode=${result.statusCode}`);
    if (result.code !== "PROVIDER_5XX") throw new Error(`code=${result.code}`);
  });

  await t.step("code UNKNOWN quando erro não reconhecido por nenhuma heurística", () => {
    const err = new Error("algo inesperado aconteceu, sem padrão conhecido");
    const result = sanitizeProviderError(err);

    if (result.code !== "UNKNOWN") throw new Error(`code=${result.code}`);
    if (result.statusCode !== undefined) throw new Error(`statusCode=${result.statusCode}`);
  });

  await t.step("erro não-Error (string / objeto sem message) não lança", () => {
    const fromString = sanitizeProviderError("connection reset");
    if (fromString.code !== "UNKNOWN") throw new Error(`code=${fromString.code}`);

    const fromPlainObject = sanitizeProviderError({ foo: "bar" });
    if (fromPlainObject.code !== "UNKNOWN") throw new Error(`code=${fromPlainObject.code}`);
  });

  await t.step("code RATE_LIMIT quando statusCode 429", () => {
    const err = { message: "rate limited, back off", status: 429 };
    const result = sanitizeProviderError(err);

    if (result.code !== "RATE_LIMIT") throw new Error(`code=${result.code}`);
    if (result.statusCode !== 429) throw new Error(`statusCode=${result.statusCode}`);
  });

  await t.step("code RATE_LIMIT quando mensagem indica 'too many requests' sem statusCode", () => {
    const err = new Error("too many requests, please retry later");
    const result = sanitizeProviderError(err);

    if (result.code !== "RATE_LIMIT") throw new Error(`code=${result.code}`);
    if (result.statusCode !== undefined) throw new Error(`statusCode=${result.statusCode}`);
  });

  await t.step("code PROVIDER_AUTH quando statusCode 401", () => {
    const err = { message: "invalid api key", status: 401 };
    const result = sanitizeProviderError(err);

    if (result.code !== "PROVIDER_AUTH") throw new Error(`code=${result.code}`);
    if (result.statusCode !== 401) throw new Error(`statusCode=${result.statusCode}`);
  });

  await t.step("code PROVIDER_AUTH quando statusCode 403", () => {
    const err = { message: "forbidden", status: 403 };
    const result = sanitizeProviderError(err);

    if (result.code !== "PROVIDER_AUTH") throw new Error(`code=${result.code}`);
    if (result.statusCode !== 403) throw new Error(`statusCode=${result.statusCode}`);
  });

  await t.step("code PROVIDER_QUOTA quando mensagem indica quota/créditos insuficientes", () => {
    const err = new Error("insufficient quota for this request");
    const result = sanitizeProviderError(err);

    if (result.code !== "PROVIDER_QUOTA") throw new Error(`code=${result.code}`);
  });

  await t.step(
    "code PROVIDER_QUOTA quando statusCode 402, mesmo sem a mensagem bater no regex de quota",
    () => {
      // Mensagem real gerada por supabase/functions/ai-respond/index.ts pra
      // statusCode 402 — não bate em /quota|insufficient .../, então sem o
      // check direto de statusCode esse erro virava UNKNOWN (bug corrigido).
      const err = {
        message: "Créditos de IA esgotados. Recarregue para continuar respondendo.",
        status: 402,
      };
      const result = sanitizeProviderError(err);

      if (result.code !== "PROVIDER_QUOTA") throw new Error(`code=${result.code}`);
      if (result.statusCode !== 402) throw new Error(`statusCode=${result.statusCode}`);
    },
  );

  await t.step("code CONTENT_BLOCKED quando mensagem indica bloqueio de moderação", () => {
    const err = new Error("this response was blocked by safety filters");
    const result = sanitizeProviderError(err);

    if (result.code !== "CONTENT_BLOCKED") throw new Error(`code=${result.code}`);
  });

  await t.step("code TIMEOUT quando mensagem indica timeout/abort", () => {
    const err = new Error("request timed out after 30s (ETIMEDOUT)");
    const result = sanitizeProviderError(err);

    if (result.code !== "TIMEOUT") throw new Error(`code=${result.code}`);
  });

  // SUPPRESSED não é alcançável via classify()/sanitizeProviderError: é um
  // código construído manualmente no handler quando o contato optou por não
  // receber mensagens (fluxo separado, sem heurística de mensagem/status —
  // ver src/lib/api/ai-failure-logs.ts e src/routes/_app.inbox.tsx). Não há
  // branch em classify() que produza esse código, então nenhum teste aqui
  // exercita esse caminho.
});

Deno.test("extractProviderErrorMeta", async (t) => {
  await t.step("extrai retryAfterSeconds de header Retry-After (segundos)", () => {
    const response = new Response(null, { status: 429, headers: { "Retry-After": "30" } });
    const meta = extractProviderErrorMeta(response);

    if (meta.statusCode !== 429) throw new Error(`statusCode=${meta.statusCode}`);
    if (meta.retryAfterSeconds !== 30) {
      throw new Error(`retryAfterSeconds=${meta.retryAfterSeconds}`);
    }
  });

  await t.step("statusCode de response.status quando não há Retry-After", () => {
    const response = new Response(null, { status: 500 });
    const meta = extractProviderErrorMeta(response);

    if (meta.statusCode !== 500) throw new Error(`statusCode=${meta.statusCode}`);
    if (meta.retryAfterSeconds !== undefined) {
      throw new Error(`retryAfterSeconds=${meta.retryAfterSeconds}`);
    }
  });

  await t.step("Retry-After como data HTTP resulta em segundos >= 0", () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const response = new Response(null, { status: 429, headers: { "Retry-After": future } });
    const meta = extractProviderErrorMeta(response);

    if (meta.retryAfterSeconds === undefined || meta.retryAfterSeconds < 0) {
      throw new Error(`retryAfterSeconds=${meta.retryAfterSeconds}`);
    }
  });

  await t.step("objeto minimo sem headers não lança e omite retryAfterSeconds", () => {
    const meta = extractProviderErrorMeta({ status: 200 });
    if (meta.statusCode !== 200) throw new Error(`statusCode=${meta.statusCode}`);
    if (meta.retryAfterSeconds !== undefined) {
      throw new Error(`retryAfterSeconds=${meta.retryAfterSeconds}`);
    }
  });
});

Deno.test("isRateLimitError", async (t) => {
  await t.step("true quando o AiError tem code RATE_LIMIT", () => {
    const result = sanitizeProviderError({ message: "rate limited, back off", status: 429 });

    if (!isRateLimitError(result)) throw new Error("esperado true pra AiError RATE_LIMIT");
  });

  await t.step("false quando o AiError tem outro code", () => {
    const result = sanitizeProviderError({ message: "invalid api key", status: 401 });

    if (isRateLimitError(result)) throw new Error("esperado false pra AiError PROVIDER_AUTH");
  });

  await t.step("false quando o erro é null ou undefined", () => {
    if (isRateLimitError(null)) throw new Error("esperado false pra null");
    if (isRateLimitError(undefined)) throw new Error("esperado false pra undefined");
  });
});
