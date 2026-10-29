// Testa o cliente Evolution Go isolado (envio/status/reconexão), mock de
// fetch, sem rede real. Mesmo padrão de provider-send.test.ts.
import { BASE_ENV, type FetchMatcher, installFetchMock, jsonResponse, setEnv } from "./_helpers.ts";
import {
  checkEvolutionInstanceStatus,
  connectEvolutionInstance,
  type EvolutionCredentials,
  reconnectEvolutionInstance,
  sendEvolutionAudio,
  sendEvolutionMessage,
} from "../_shared/messaging/evolution-client.ts";

setEnv(BASE_ENV);

const CRED: EvolutionCredentials = {
  api_url: "https://evo.example.com",
  instance_name: "cel-teste",
  api_key: "global-key-1234567890",
  instance_token: "instance-token-abc",
};

const SEND_URL = "https://evo.example.com/send/text";
const STATUS_URL = "https://evo.example.com/instance/status";
const RECONNECT_URL = "https://evo.example.com/instance/reconnect";
const QR_URL = `https://evo.example.com/instance/qr?id=${encodeURIComponent(CRED.instance_name)}`;

Deno.test("sendEvolutionMessage", async (t) => {
  await t.step("sucesso: retorna ok:true com external_id do Info.ID", async () => {
    const router: FetchMatcher = (req) => {
      if (req.url === SEND_URL && req.method === "POST") {
        if (req.headers.get("apikey") !== "instance-token-abc") {
          return jsonResponse(401, { error: "unauthorized" });
        }
        return jsonResponse(200, { data: { Info: { ID: "  STANZA123  " } } });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await sendEvolutionMessage(CRED, "+55 85 92002-0044", "Olá, tudo bem?");
      if (!result.ok || result.external_id !== "STANZA123") {
        throw new Error(`resultado inesperado: ${JSON.stringify(result)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("usa instance_token no header, não api_key (evita 401 documentado)", async () => {
    let capturedApiKey: string | null = null;
    const router: FetchMatcher = (req) => {
      if (req.url === SEND_URL && req.method === "POST") {
        capturedApiKey = req.headers.get("apikey");
        return jsonResponse(200, { data: { Info: { ID: "id-1" } } });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      await sendEvolutionMessage(CRED, "5511999999999", "oi");
      if (capturedApiKey !== CRED.instance_token) {
        throw new Error(
          `esperava header apikey="${CRED.instance_token}", recebeu "${capturedApiKey}"`,
        );
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "sem instance_token: descobre o token pelo nome em /instance/all (nunca manda a chave global)",
    async () => {
      let capturedApiKey: string | null = null;
      let listedWithGlobalKey = false;
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/instance/all" && req.method === "GET") {
          listedWithGlobalKey = req.headers.get("apikey") === CRED.api_key;
          return jsonResponse(200, {
            data: [
              { name: "outra-instancia", token: "token-errado" },
              { name: CRED.instance_name, token: "token-descoberto" },
            ],
          });
        }
        if (req.url === SEND_URL && req.method === "POST") {
          capturedApiKey = req.headers.get("apikey");
          return jsonResponse(200, { data: { Info: { ID: "id-1" } } });
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const { instance_token: _drop, ...credSemToken } = CRED;
        await sendEvolutionMessage(credSemToken, "5511999999999", "oi");
        if (!listedWithGlobalKey) throw new Error("/instance/all deveria usar a chave global");
        if (capturedApiKey !== "token-descoberto") {
          throw new Error(`esperava o token descoberto, recebeu "${capturedApiKey}"`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("instância inexistente: erro nomeia a instância e lista as existentes", async () => {
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/instance/all" && req.method === "GET") {
        return jsonResponse(200, { data: [{ name: "alguma-outra", token: "t" }] });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const { instance_token: _drop, ...credSemToken } = CRED;
      const result = await sendEvolutionMessage(credSemToken, "5511999999999", "oi");
      if (result.ok) throw new Error("deveria falhar sem instância correspondente");
      if (!result.error?.includes(CRED.instance_name) || !result.error.includes("alguma-outra")) {
        throw new Error(`mensagem pouco clara: ${result.error}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("chave global recusada em /instance/all vira mensagem específica", async () => {
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/instance/all" && req.method === "GET") {
        return jsonResponse(401, { error: "unauthorized" });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const { instance_token: _drop, ...credSemToken } = CRED;
      const result = await sendEvolutionMessage(credSemToken, "5511999999999", "oi");
      if (result.ok || !result.error?.includes("GLOBAL_API_KEY")) {
        throw new Error(`esperava erro sobre a chave global, veio: ${JSON.stringify(result)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("normaliza BR 12 dígitos → 13 dígitos (insere 9 do celular)", async () => {
    let capturedNumber: string | undefined;
    const router: FetchMatcher = (req) => {
      if (req.url === SEND_URL && req.method === "POST") {
        capturedNumber = (req.bodyJson as { number?: string } | undefined)?.number;
        return jsonResponse(200, { data: { Info: { ID: "id-1" } } });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      await sendEvolutionMessage(CRED, "558520020044", "oi");
      if (capturedNumber !== "5585920020044") {
        throw new Error(`número normalizado incorreto: ${capturedNumber}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("stanzaId (id do corpo) é sempre diferente entre envios", async () => {
    const seenIds: string[] = [];
    const router: FetchMatcher = (req) => {
      if (req.url === SEND_URL && req.method === "POST") {
        seenIds.push((req.bodyJson as { id?: string } | undefined)?.id ?? "");
        return jsonResponse(200, { data: { Info: { ID: "id-1" } } });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      await sendEvolutionMessage(CRED, "5511999999999", "msg 1");
      await sendEvolutionMessage(CRED, "5511999999999", "msg 2");
      if (seenIds.length !== 2 || seenIds[0] === seenIds[1] || !seenIds[0] || !seenIds[1]) {
        throw new Error(`stanzaIds inesperados: ${JSON.stringify(seenIds)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("falha HTTP (401): retorna ok:false com mensagem amigável", async () => {
    const router: FetchMatcher = (req) => {
      if (req.url === SEND_URL && req.method === "POST") {
        return jsonResponse(401, { error: "unauthorized" });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await sendEvolutionMessage(CRED, "5511999999999", "oi");
      if (
        result.ok ||
        result.error !==
          "Credenciais da Evolution (WhatsApp self-hosted) não estão mais válidas. Reconecte a integração."
      ) {
        throw new Error(`resultado inesperado: ${JSON.stringify(result)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("instância offline/número inválido: HTTP 200 sem 'data' vira ok:false", async () => {
    const router: FetchMatcher = (req) => {
      if (req.url === SEND_URL && req.method === "POST") {
        return jsonResponse(200, { message: "instance not found" });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await sendEvolutionMessage(CRED, "5511999999999", "oi");
      if (result.ok || result.error !== "instance not found") {
        throw new Error(`resultado inesperado: ${JSON.stringify(result)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("número não registrado no WhatsApp: mensagem específica", async () => {
    const router: FetchMatcher = (req) => {
      if (req.url === SEND_URL && req.method === "POST") {
        return new Response("number 5511999999999 is not registered on WhatsApp", { status: 400 });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await sendEvolutionMessage(CRED, "5511999999999", "oi");
      if (result.ok || result.error !== "O número 5511999999999 não está registrado no WhatsApp.") {
        throw new Error(`resultado inesperado: ${JSON.stringify(result)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "status HTTP desconhecido (ex.: 402): a mensagem inclui o status e o corpo, redigido",
    async () => {
      const router: FetchMatcher = (req) => {
        if (req.url === SEND_URL && req.method === "POST") {
          return new Response("saldo insuficiente (token: instance-token-abc)", { status: 402 });
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const result = await sendEvolutionMessage(CRED, "5511999999999", "oi");
        if (result.ok) throw new Error(`esperado ok:false, veio ${JSON.stringify(result)}`);
        if (!result.error.includes("402")) {
          throw new Error(`mensagem não traz o status HTTP: ${result.error}`);
        }
        if (!result.error.includes("saldo insuficiente")) {
          throw new Error(`mensagem não traz o corpo do provedor: ${result.error}`);
        }
        if (result.error.includes("instance-token-abc")) {
          throw new Error(`segredo vazou na mensagem: ${result.error}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("sem telefone: retorna ok:false sem chamar o provedor", async () => {
    const uninstall = installFetchMock(() => {
      throw new Error("não deveria chamar o provedor sem telefone");
    });
    try {
      const result = await sendEvolutionMessage(CRED, "", "oi");
      if (result.ok || result.error !== "Contato sem telefone cadastrado.") {
        throw new Error(`resultado inesperado: ${JSON.stringify(result)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("credenciais incompletas: retorna ok:false sem chamar o provedor", async () => {
    const uninstall = installFetchMock(() => {
      throw new Error("não deveria chamar o provedor sem credenciais");
    });
    try {
      const result = await sendEvolutionMessage(
        { api_url: "", instance_name: "", api_key: "" },
        "5511999999999",
        "oi",
      );
      if (
        result.ok || result.error !== "Integração Evolution (WhatsApp self-hosted) não configurada."
      ) {
        throw new Error(`resultado inesperado: ${JSON.stringify(result)}`);
      }
    } finally {
      uninstall();
    }
  });
});

Deno.test("checkEvolutionInstanceStatus", async (t) => {
  await t.step("conectado: Connected=true → state connected", async () => {
    const router: FetchMatcher = (req) => {
      if (req.url === STATUS_URL && req.method === "GET") {
        return jsonResponse(200, { data: { Connected: true } });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await checkEvolutionInstanceStatus(CRED);
      if (result.state !== "connected") {
        throw new Error(`resultado inesperado: ${JSON.stringify(result)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("deadline estourado: mensagem em PT-BR, nunca a string do runtime", async () => {
    const router: FetchMatcher = () => {
      // String real que o fetch do Deno produz quando AbortSignal.timeout dispara.
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await checkEvolutionInstanceStatus(CRED);
      if (result.state !== "error") {
        throw new Error(`esperava state error: ${JSON.stringify(result)}`);
      }
      if (/aborted|timeout/i.test(result.message ?? "")) {
        throw new Error(`mensagem crua do runtime vazou para a UI: ${result.message}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("aguardando QR / desconectado: Connected=false → state disconnected", async () => {
    const router: FetchMatcher = (req) => {
      if (req.url === STATUS_URL && req.method === "GET") {
        return jsonResponse(200, { data: { Connected: false } });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await checkEvolutionInstanceStatus(CRED);
      if (result.state !== "disconnected") {
        throw new Error(`resultado inesperado: ${JSON.stringify(result)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("falha HTTP: state error, não lança", async () => {
    const router: FetchMatcher = (req) => {
      if (req.url === STATUS_URL && req.method === "GET") {
        return jsonResponse(500, { error: "internal" });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await checkEvolutionInstanceStatus(CRED);
      if (result.state !== "error") {
        throw new Error(`resultado inesperado: ${JSON.stringify(result)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "corpo malformado (HTTP 200 sem 'data' e sem 'error'): state error, NÃO disconnected",
    async () => {
      // Regressão: tratar isso como "disconnected" alimentaria
      // messaging-channels-reconcile/runner.ts sobrescrevendo incondicionalmente
      // um canal em waiting_qr -- ver docstring de checkEvolutionInstanceStatus.
      const router: FetchMatcher = (req) => {
        if (req.url === STATUS_URL && req.method === "GET") {
          return jsonResponse(200, { unexpected: "shape" });
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const result = await checkEvolutionInstanceStatus(CRED);
        if (result.state !== "error") {
          throw new Error(
            `resultado inesperado (deveria ser 'error', não 'disconnected'): ${
              JSON.stringify(result)
            }`,
          );
        }
        if (!result.message) {
          throw new Error("message deveria estar preenchida explicando o corpo inesperado");
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "falha de rede: state error, não lança (contrato de cron tolerante a falha)",
    async () => {
      const uninstall = installFetchMock(() => {
        throw new TypeError("network down");
      });
      try {
        const result = await checkEvolutionInstanceStatus(CRED);
        if (result.state !== "error") {
          throw new Error(
            `resultado inesperado: ${JSON.stringify(result)}`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );
});

Deno.test("reconnectEvolutionInstance", async (t) => {
  await t.step("sucesso sem QR: sessão existente reconecta sozinha", async () => {
    const router: FetchMatcher = (req) => {
      if (req.url === RECONNECT_URL && req.method === "POST") {
        return jsonResponse(200, { ok: true });
      }
      if (req.url === QR_URL && req.method === "GET") {
        return jsonResponse(200, { error: "already connected" });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await reconnectEvolutionInstance(CRED);
      if (!result.ok || result.qrCode) {
        throw new Error(`resultado inesperado: ${JSON.stringify(result)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("sucesso com QR: sessão invalidada, novo QR retornado", async () => {
    const router: FetchMatcher = (req) => {
      if (req.url === RECONNECT_URL && req.method === "POST") {
        return jsonResponse(200, { ok: true });
      }
      if (req.url === QR_URL && req.method === "GET") {
        return jsonResponse(200, { data: { qrcode: "base64-qr-data" } });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await reconnectEvolutionInstance(CRED);
      if (!result.ok || result.qrCode !== "base64-qr-data") {
        throw new Error(`resultado inesperado: ${JSON.stringify(result)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("falha: reconnect HTTP não-ok retorna ok:false", async () => {
    const router: FetchMatcher = (req) => {
      if (req.url === RECONNECT_URL && req.method === "POST") {
        return jsonResponse(500, { error: "down" });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await reconnectEvolutionInstance(CRED);
      if (result.ok || !result.error) {
        throw new Error(`resultado inesperado: ${JSON.stringify(result)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("falha: rede indisponível no passo de reconnect retorna ok:false", async () => {
    const uninstall = installFetchMock(() => {
      throw new TypeError("network down");
    });
    try {
      const result = await reconnectEvolutionInstance(CRED);
      if (result.ok || !result.error) {
        throw new Error(`resultado inesperado: ${JSON.stringify(result)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "reconnect ok mas busca de QR falha: ainda retorna ok:true (reconexão já confirmada)",
    async () => {
      const router: FetchMatcher = (req) => {
        if (req.url === RECONNECT_URL && req.method === "POST") {
          return jsonResponse(200, { ok: true });
        }
        if (req.url === QR_URL && req.method === "GET") {
          throw new TypeError("network down");
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const result = await reconnectEvolutionInstance(CRED);
        if (!result.ok || result.qrCode) {
          throw new Error(`resultado inesperado: ${JSON.stringify(result)}`);
        }
      } finally {
        uninstall();
      }
    },
  );
});

const CONNECT_URL = "https://evo.example.com/instance/connect";
const WEBHOOK_URL = "https://app.example.com/functions/v1/messaging-webhook/abc?token=t1";

Deno.test("connectEvolutionInstance", async (t) => {
  await t.step("envia webhookUrl, eventos assinados e headers documentados", async () => {
    interface CapturedConnectCall {
      body: { webhookUrl: string; subscribe: string[]; immediate: boolean };
      apikey: string | null;
      instanceId: string | null;
    }
    const captured: CapturedConnectCall[] = [];
    const router: FetchMatcher = (req) => {
      if (req.url === CONNECT_URL && req.method === "POST") {
        captured.push({
          body: req.bodyJson as CapturedConnectCall["body"],
          apikey: req.headers.get("apikey"),
          instanceId: req.headers.get("instanceId"),
        });
        return jsonResponse(200, { data: { qrcode: "data:image/png;base64,AAA" } });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await connectEvolutionInstance(CRED, WEBHOOK_URL);
      if (!result.ok || result.qrCode !== "data:image/png;base64,AAA") {
        throw new Error(`resultado inesperado: ${JSON.stringify(result)}`);
      }
      const seen = captured[0];
      if (!seen) throw new Error("nenhuma chamada capturada");
      if (seen.apikey !== CRED.api_key) {
        throw new Error("deve usar a GLOBAL_API_KEY no header apikey");
      }
      if (seen.instanceId !== CRED.instance_name) {
        throw new Error("deve identificar a instância no header instanceId");
      }
      if (seen.body.webhookUrl !== WEBHOOK_URL || seen.body.immediate !== true) {
        throw new Error(`corpo inesperado: ${JSON.stringify(seen.body)}`);
      }
      if (!seen.body.subscribe.includes("MESSAGE") || !seen.body.subscribe.includes("CONNECTION")) {
        throw new Error(`eventos inesperados: ${JSON.stringify(seen.body.subscribe)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("falha de rede não lança, retorna ok:false", async () => {
    const uninstall = installFetchMock(() => {
      throw new TypeError("network down");
    });
    try {
      const result = await connectEvolutionInstance(CRED, WEBHOOK_URL);
      if (result.ok || !result.error) {
        throw new Error(`resultado inesperado: ${JSON.stringify(result)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("recusa servidor em endereço privado (anti-SSRF)", async () => {
    let called = false;
    const uninstall = installFetchMock(() => {
      called = true;
      return jsonResponse(200, {});
    });
    try {
      const result = await connectEvolutionInstance(
        { ...CRED, api_url: "http://localhost:8080" },
        WEBHOOK_URL,
      );
      if (result.ok || called) {
        throw new Error("URL privada não pode ser chamada");
      }
    } finally {
      uninstall();
    }
  });
});

// ---------------------------------------------------------------------------
// Áudio (POST /send/media) — ver docs oficiais do Evolution Go.
// ---------------------------------------------------------------------------
const MEDIA_URL = "https://evo.example.com/send/media";

function audioBytes(): ArrayBuffer {
  return new Uint8Array([1, 2, 3, 4, 5]).buffer;
}

Deno.test("sendEvolutionAudio", async (t) => {
  await t.step("usa o link assinado e o corpo documentado de SendMedia", async () => {
    let seen: Record<string, unknown> | null = null;
    const router: FetchMatcher = (req) => {
      if (req.url === MEDIA_URL && req.method === "POST") {
        if (req.headers.get("apikey") !== "instance-token-abc") {
          return jsonResponse(401, { error: "unauthorized" });
        }
        seen = req.bodyJson as Record<string, unknown>;

        return jsonResponse(200, { data: { Info: { ID: "AUDIO1" } } });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await sendEvolutionAudio(CRED, "+55 85 92002-0044", {
        bytes: audioBytes(),
        mime: "audio/mpeg",
        signedUrl: "https://storage.example.com/ai-audio/x.mp3?token=abc",
      });
      if (!result.ok || result.external_id !== "AUDIO1") {
        throw new Error(`esperado ok com external_id, recebido ${JSON.stringify(result)}`);
      }
      const body = seen as Record<string, unknown> | null;
      if (!body) throw new Error("corpo não capturado");
      if (body.type !== "audio") throw new Error("type deve ser audio");
      if (body.url !== "https://storage.example.com/ai-audio/x.mp3?token=abc") {
        throw new Error("deve usar o link assinado como url da mídia");
      }
      if (typeof body.number !== "string" || !/^\d+$/.test(body.number)) {
        throw new Error("number deve ser só dígitos");
      }
      if (body.filename !== "audio.mp3") {
        throw new Error(`filename deveria acompanhar o mime, recebido ${String(body.filename)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("link recusado: tenta de novo com o áudio embutido", async () => {
    const urls: string[] = [];
    const router: FetchMatcher = (req) => {
      if (req.url === MEDIA_URL && req.method === "POST") {
        const body = req.bodyJson as { url: string };

        urls.push(body.url);
        if (urls.length === 1) return jsonResponse(400, { error: "cannot fetch url" });
        return jsonResponse(200, { data: { Info: { ID: "AUDIO2" } } });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await sendEvolutionAudio(CRED, "5585920020044", {
        bytes: audioBytes(),
        mime: "audio/ogg",
        signedUrl: "https://storage.example.com/ai-audio/y.ogg?token=abc",
      });
      if (!result.ok) throw new Error(`esperado sucesso no fallback: ${result.error}`);
      // base64 PURO: data URI é recusado com "invalid base64 encoding".
      if (urls.length !== 2 || urls[1].startsWith("data:") || urls[1] !== btoa("\x01\x02\x03\x04\x05")) {
        throw new Error(`fallback deveria usar base64 puro, recebido ${JSON.stringify(urls)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("erro de base64 do provedor vira mensagem em PT-BR", async () => {
    const uninstall = installFetchMock((req) =>
      req.url === MEDIA_URL ? jsonResponse(400, { error: "invalid base64 encoding" }) : undefined
    );
    try {
      const result = await sendEvolutionAudio(CRED, "5585920020044", {
        bytes: audioBytes(),
        mime: "audio/ogg",
      });
      if (result.ok) throw new Error("esperado ok:false");
      if (!result.error.includes("recusou o formato do arquivo de áudio")) {
        throw new Error(`mensagem não traduzida: ${result.error}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("servidor interno é recusado antes do fetch", async () => {
    const uninstall = installFetchMock(() => {
      throw new Error("não deveria chamar a rede");
    });
    try {
      const result = await sendEvolutionAudio(
        { ...CRED, api_url: "https://localhost" },
        "5585920020044",
        { bytes: audioBytes(), mime: "audio/ogg" },
      );
      if (result.ok) throw new Error("URL interna deveria ser recusada");
    } finally {
      uninstall();
    }
  });

  await t.step("falha de rede não lança", async () => {
    const uninstall = installFetchMock(() => {
      throw new TypeError("network down");
    });
    try {
      const result = await sendEvolutionAudio(CRED, "5585920020044", {
        bytes: audioBytes(),
        mime: "audio/ogg",
      });
      if (result.ok) throw new Error("esperado ok:false");
    } finally {
      uninstall();
    }
  });
});
