// Regressão anti-SSRF: um admin pode gravar `channels.config.api_url` /
// `channels.config.webhook_url` direto via PostgREST (policy "channels admin
// update"), driblando o guard `validatePublicHttpsUrl` que só roda no fluxo
// integration-connect. Os workers (evolution-watchdog, messaging-channels-
// reconcile, provider-send) depois fazem fetch dessa URL. Estes testes provam
// que os 4 sinks de fetch revalidam a URL no boundary e NÃO disparam nenhum
// request (fetch/transport.request) quando a URL aponta para um IP interno.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { installFetchMock } from "./_helpers.ts";
import {
  checkEvolutionInstanceStatus,
  type EvolutionCredentials,
  reconnectEvolutionInstance,
  sendEvolutionMessage,
} from "../_shared/messaging/evolution-client.ts";
import { createMultichannelAdapter } from "../_shared/messaging/multichannel-adapters.ts";

// IP-literais internos: bloqueados pela checagem literal de
// validatePublicHttpsUrl ANTES de qualquer resolução DNS (por isso o teste
// roda offline, sem --allow-net). 169.254.169.254 = endpoint de metadata.
const BLOCKED_URLS = [
  "https://169.254.169.254",
  "https://127.0.0.1",
  "https://10.0.0.1",
];

function credWith(apiUrl: string): EvolutionCredentials {
  return {
    api_url: apiUrl,
    instance_name: "inst-teste",
    api_key: "chave-de-teste-1234567890",
    instance_token: "token-de-teste-abcdef",
  };
}

// Mock de fetch que conta chamadas. Qualquer chamada com uma URL bloqueada é
// uma falha de SSRF: o guard deveria ter retornado antes de o request sair.
function countingFetchMock(): { calls: () => number; uninstall: () => void } {
  let calls = 0;
  const uninstall = installFetchMock(() => {
    calls++;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
  return { calls: () => calls, uninstall };
}

function countingTransport(): {
  calls: () => number;
  request: (url: string, init: RequestInit) => Promise<Response>;
} {
  let calls = 0;
  return {
    calls: () => calls,
    request: () => {
      calls++;
      return Promise.resolve(new Response("{}", { status: 200 }));
    },
  };
}

Deno.test("SSRF: sendEvolutionMessage rejeita api_url interna sem nenhum fetch", async (t) => {
  for (const url of BLOCKED_URLS) {
    await t.step(url, async () => {
      const mock = countingFetchMock();
      try {
        const result = await sendEvolutionMessage(credWith(url), "5511999999999", "oi");
        assertEquals(result.ok, false);
        assertEquals(mock.calls(), 0);
      } finally {
        mock.uninstall();
      }
    });
  }
});

Deno.test("SSRF: checkEvolutionInstanceStatus rejeita api_url interna sem nenhum fetch", async (t) => {
  for (const url of BLOCKED_URLS) {
    await t.step(url, async () => {
      const mock = countingFetchMock();
      try {
        const result = await checkEvolutionInstanceStatus(credWith(url));
        assertEquals(result.state, "error");
        assertEquals(mock.calls(), 0);
      } finally {
        mock.uninstall();
      }
    });
  }
});

Deno.test("SSRF: reconnectEvolutionInstance rejeita api_url interna sem nenhum fetch", async (t) => {
  for (const url of BLOCKED_URLS) {
    await t.step(url, async () => {
      const mock = countingFetchMock();
      try {
        const result = await reconnectEvolutionInstance(credWith(url));
        assertEquals(result.ok, false);
        assertEquals(mock.calls(), 0);
      } finally {
        mock.uninstall();
      }
    });
  }
});

Deno.test("SSRF: multichannel adapter (sms/email/push) rejeita api_url interna sem transport.request", async (t) => {
  for (const provider of ["sms", "email", "push"] as const) {
    for (const url of BLOCKED_URLS) {
      await t.step(`${provider} ${url}`, async () => {
        const transport = countingTransport();
        const adapter = createMultichannelAdapter(
          provider,
          { api_url: url, api_key: "k" },
          transport,
        );
        const result = await adapter.send({ destination: "+5511999999999", content: "oi" });
        assertEquals(result.ok, false);
        assertEquals(transport.calls(), 0);
      });
    }
  }
});

Deno.test("SSRF: multichannel adapter (discord) rejeita webhook_url interna sem transport.request", async (t) => {
  for (const url of BLOCKED_URLS) {
    await t.step(`discord ${url}`, async () => {
      const transport = countingTransport();
      const adapter = createMultichannelAdapter("discord", { webhook_url: url }, transport);
      const result = await adapter.send({ destination: "canal-1", content: "oi" });
      assertEquals(result.ok, false);
      assertEquals(transport.calls(), 0);
    });
  }
});

// Prova complementar: uma URL pública PASSA a verificação e chega ao sink.
// Usa IP-literal público (1.1.1.1) de propósito — passa na validação e pula o
// ramo de DNS (o guard `!/^\d+\.\d+\.\d+\.\d+$/` do validador), então a
// asserção "chegou ao fetch, calls === 1" não depende de rede nem de
// --allow-net e não pode flakar.
Deno.test("SSRF: URL pública passa na verificação e chega ao sink", async (t) => {
  await t.step("evolution: sendEvolutionMessage faz exatamente 1 fetch", async () => {
    let calls = 0;
    const uninstall = installFetchMock(() => {
      calls++;
      return new Response(JSON.stringify({ data: { Info: { ID: "STANZA1" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      const result = await sendEvolutionMessage(credWith("https://1.1.1.1"), "5511999999999", "oi");
      assertEquals(result.ok, true);
      assertEquals(calls, 1);
    } finally {
      uninstall();
    }
  });

  await t.step("multichannel: sms chama transport.request exatamente 1 vez", async () => {
    let calls = 0;
    const transport = {
      request: () => {
        calls++;
        return Promise.resolve(Response.json({ result: { message_id: "m1" } }));
      },
    };
    const adapter = createMultichannelAdapter("sms", {
      api_url: "https://1.1.1.1/send",
      api_key: "k",
    }, transport);
    const result = await adapter.send({ destination: "+5511999999999", content: "oi" });
    assertEquals(result.ok, true);
    assertEquals(calls, 1);
  });
});
