import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { callLovableGateway } from "../_shared/ai/gateway.ts";
import { installFetchMock } from "./_helpers.ts";

Deno.test("callLovableGateway aborts a pending fetch when its deadline expires", async () => {
  const previousApiKey = Deno.env.get("LOVABLE_API_KEY");
  Deno.env.set("LOVABLE_API_KEY", "test-key");

  let abortObserved = false;
  const uninstall = installFetchMock((req) => {
    return new Promise<Response>((_resolve, reject) => {
      if (!req.signal) {
        reject(new Error("gateway fetch did not receive an AbortSignal"));
        return;
      }
      const signal = req.signal;
      req.signal.addEventListener(
        "abort",
        () => {
          abortObserved = signal.aborted;
          reject(signal.reason);
        },
        { once: true },
      );
    });
  });

  try {
    const error = await assertRejects(() =>
      callLovableGateway("system", [], "test-model", {
        maxOutputTokens: 1,
        timeoutMs: 10,
      })
    );
    assert(error instanceof Error);
    assertEquals(error.name, "TimeoutError");
    assertEquals(abortObserved, true);
  } finally {
    uninstall();
    if (previousApiKey === undefined) Deno.env.delete("LOVABLE_API_KEY");
    else Deno.env.set("LOVABLE_API_KEY", previousApiKey);
  }
});

Deno.test("gateway usa endpoint, chave e modelo locais sem exigir LOVABLE_API_KEY", async () => {
  const names = ["AI_GATEWAY_URL", "AI_GATEWAY_API_KEY", "AI_GATEWAY_MODEL", "LOVABLE_API_KEY"];
  const previous = names.map((name) => Deno.env.get(name));
  Deno.env.set("AI_GATEWAY_URL", "https://api.deepseek.com/chat/completions");
  Deno.env.set("AI_GATEWAY_API_KEY", "chave-local-de-teste");
  Deno.env.set("AI_GATEWAY_MODEL", "deepseek-flash");
  Deno.env.delete("LOVABLE_API_KEY");
  let request: { url: string; authorization: string | null; body: unknown } | null = null;
  const uninstall = installFetchMock((req) => {
    request = { url: req.url, authorization: req.headers.get("authorization"), body: req.bodyJson };
    return new Response(JSON.stringify({ choices: [{ message: { content: "avançar" } }] }));
  });
  try {
    assertEquals(await callLovableGateway("Avalie", [], "google/gemini-3-flash-preview", {
      maxOutputTokens: 100,
      responseFormat: { type: "json_object" },
    }), "avançar");
    assertEquals(request, {
      url: "https://api.deepseek.com/chat/completions",
      authorization: "Bearer chave-local-de-teste",
      body: {
        model: "deepseek-flash",
        messages: [{ role: "system", content: "Avalie" }],
        max_tokens: 100,
        reasoning_effort: "none",
        response_format: { type: "json_object" },
      },
    });
  } finally {
    uninstall();
    names.forEach((name, index) => {
      if (previous[index] === undefined) Deno.env.delete(name);
      else Deno.env.set(name, previous[index]!);
    });
  }
});

Deno.test("gateway sem override preserva endpoint, chave e modelo de produção", async () => {
  const names = ["AI_GATEWAY_URL", "AI_GATEWAY_API_KEY", "AI_GATEWAY_MODEL", "LOVABLE_API_KEY"];
  const previous = names.map((name) => Deno.env.get(name));
  names.forEach((name) => Deno.env.delete(name));
  Deno.env.set("LOVABLE_API_KEY", "chave-lovable");
  const uninstall = installFetchMock((req) => {
    assertEquals(req.url, "https://ai.gateway.lovable.dev/v1/chat/completions");
    assertEquals(req.headers.get("authorization"), "Bearer chave-lovable");
    assert(req.bodyJson !== null && typeof req.bodyJson === "object" && "model" in req.bodyJson);
    assertEquals(req.bodyJson.model, "modelo-do-tenant");
    assertEquals("reasoning_effort" in req.bodyJson, false);
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
  try {
    assertEquals(await callLovableGateway("Avalie", [], "modelo-do-tenant"), "ok");
  } finally {
    uninstall();
    names.forEach((name, index) => {
      if (previous[index] === undefined) Deno.env.delete(name);
      else Deno.env.set(name, previous[index]!);
    });
  }
});

Deno.test("gateway alternativo sem chave própria nunca recebe a chave Lovable", async () => {
  const names = ["AI_GATEWAY_URL", "AI_GATEWAY_API_KEY", "LOVABLE_API_KEY"];
  const previous = names.map((name) => Deno.env.get(name));
  Deno.env.set("AI_GATEWAY_URL", "https://api.deepseek.com/chat/completions");
  Deno.env.delete("AI_GATEWAY_API_KEY");
  Deno.env.set("LOVABLE_API_KEY", "nao-enviar-ao-outro-provedor");
  let called = false;
  const uninstall = installFetchMock(() => {
    called = true;
    return new Response("{}");
  });
  try {
    await assertRejects(() => callLovableGateway("Avalie", [], "modelo"), Error, "AI_GATEWAY_API_KEY ausente.");
    assertEquals(called, false);
  } finally {
    uninstall();
    names.forEach((name, index) => {
      if (previous[index] === undefined) Deno.env.delete(name);
      else Deno.env.set(name, previous[index]!);
    });
  }
});
