// Formato de fio do envio de áudio (TTS) por canal.
//
// Estes testes existem porque os providers embrulham o MESMO arquivo de
// formas incompatíveis, e tratar todos igual quebra envios em silêncio —
// contratos conferidos na doc oficial em 2026-07-27:
//
//   zapi        data URI COM prefixo   "data:audio/mpeg;base64,..."
//   zappaz      base64 CRU, sem prefixo
//   meta-cloud  nem base64: upload multipart -> media id -> envia por id
//
// A asserção que importa em cada caso é o formato, não o "deu 200".
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { type FetchMatcher, installFetchMock, jsonResponse, type MockRequest } from "./_helpers.ts";
import { providerSupportsAudio, sendAudioViaProvider } from "../_shared/messaging/provider-send.ts";
import {
  loadVoiceReplyPreference,
  shouldReplyWithAudio,
  synthesizeSpeech,
  transcribeAudio,
  transcribeMetaCloudAudio,
  VoiceError,
  type VoiceReplyPreference,
} from "../_shared/ai/voice.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { BASE_ENV } from "./_helpers.ts";

// "ID3" — bytes de header de um MP3 real, pra que o base64 seja verificável.
const MP3_BYTES = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]).buffer;
const AUDIO = { bytes: MP3_BYTES, mime: "audio/mpeg" };
const MP3_B64 = "SUQzBAA=";

async function expectVoiceError(
  fn: () => Promise<unknown>,
  stage: "download" | "transcribe",
  message: string,
): Promise<void> {
  let caught: unknown = null;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof VoiceError, `esperado VoiceError, veio ${caught}`);
  assertEquals((caught as VoiceError).stage, stage);
  assertStringIncludes((caught as VoiceError).message, message);
}

Deno.test("sendAudioViaProvider — formato de fio por canal", async (t) => {
  await t.step("zapi manda data URI COM prefixo", async () => {
    const seen: MockRequest[] = [];
    const restore = installFetchMock((req) => {
      seen.push(req);
      return jsonResponse(200, { messageId: "wa-1", zaapId: "z-1", id: "wa-1" });
    });
    try {
      const r = await sendAudioViaProvider({
        providerSlug: "zapi",
        cred: { instance_id: "i1", instance_token: "t1", client_token: "c1" },
        phone: "+55 (11) 99999-9999",
        audio: AUDIO,
      });
      assert(r.ok, `esperava sucesso: ${JSON.stringify(r)}`);
      assertEquals(r.external_id, "wa-1");
    } finally {
      restore();
    }

    assertEquals(seen.length, 1);
    assertStringIncludes(seen[0].url, "/send-audio");
    const body = seen[0].bodyJson as { phone: string; audio: string; waveform: boolean };
    assertEquals(body.phone, "5511999999999", "telefone tem que ir só com dígitos");
    assertEquals(body.audio, `data:audio/mpeg;base64,${MP3_B64}`);
    // waveform é o que renderiza como nota de voz em vez de anexo; default não
    // é documentado, então tem que ir explícito.
    assertEquals(body.waveform, true);
    // `async` não pode ir: com ele a doc não define o corpo da resposta e o
    // external_id deixaria de ser confiável.
    assert(!("async" in (seen[0].bodyJson as Record<string, unknown>)));
  });

  await t.step("zappaz manda base64 CRU, sem o prefixo data:", async () => {
    const seen: MockRequest[] = [];
    const restore = installFetchMock((req) => {
      seen.push(req);
      return jsonResponse(200, { id: "zap-1" });
    });
    try {
      const r = await sendAudioViaProvider({
        providerSlug: "zappaz",
        cred: { api_key: "k1", session_id: "s1" },
        phone: "5511999999999",
        audio: AUDIO,
      });
      assert(r.ok, `esperava sucesso: ${JSON.stringify(r)}`);
    } finally {
      restore();
    }

    const body = seen[0].bodyJson as { number: string; source: string };
    assertEquals(body.source, MP3_B64);
    assert(
      !body.source.startsWith("data:"),
      "zappaz NÃO aceita prefixo data: — este é o bug fácil",
    );
    assertEquals(body.number, "5511999999999");
    // Authorization cru, sem "Bearer" — o securityScheme é apiKey/header.
    assertEquals(seen[0].headers.get("authorization"), "k1");
  });

  await t.step("meta-cloud faz upload multipart e depois envia por media id", async () => {
    const seen: MockRequest[] = [];
    const restore = installFetchMock((req) => {
      seen.push(req);
      if (req.pathname.endsWith("/media")) return jsonResponse(200, { id: "media-123" });
      return jsonResponse(200, { messages: [{ id: "wamid.ABC" }] });
    });
    try {
      const r = await sendAudioViaProvider({
        providerSlug: "meta-cloud",
        cred: { access_token: "tok", phone_number_id: "10987" },
        phone: "+5511999999999",
        audio: AUDIO,
      });
      assert(r.ok, `esperava sucesso: ${JSON.stringify(r)}`);
      assertEquals(r.external_id, "wamid.ABC");
    } finally {
      restore();
    }

    assertEquals(seen.length, 2, "Meta exige upload antes do envio — são 2 chamadas, não 1");
    assertStringIncludes(seen[0].url, "/10987/media");
    assertEquals(seen[0].headers.get("authorization"), "Bearer tok");
    // O contrato que ESTE código controla é não setar Content-Type à mão: o
    // boundary do multipart é gerado pelo runtime a partir do FormData, e
    // sobrescrever o header quebra o parse do lado da Meta. (O boundary em si
    // é adicionado pelo fetch real, fora do alcance deste mock — assertá-lo
    // aqui testaria o runtime, não o nosso código.)
    assertEquals(
      seen[0].headers.get("content-type"),
      null,
      "não podemos setar Content-Type: o boundary tem que vir do FormData",
    );
    // NÃO COBERTO aqui: os campos do multipart (messaging_product/type/file).
    // installFetchMock não serializa corpo FormData — bodyText vem vazio —, e
    // asserção sobre "" passaria por acidente. O que dá pra travar sem mentir é
    // a forma da chamada (URL, auth, ausência de Content-Type) e o uso do id
    // devolvido, abaixo.

    assertStringIncludes(seen[1].url, "/10987/messages");
    const body = seen[1].bodyJson as { type: string; audio: { id: string }; to: string };
    assertEquals(body.type, "audio");
    assertEquals(body.audio.id, "media-123", "tem que usar o id devolvido pelo upload");
    assertEquals(body.to, "5511999999999");
  });

  await t.step("canal sem suporte recusa explicitamente e NÃO chama a rede", async () => {
    let chamou = false;
    const restore = installFetchMock(() => {
      chamou = true;
      return jsonResponse(200, {});
    });
    try {
      for (const slug of ["twilio", "resend", "telegram"]) {
        const r = await sendAudioViaProvider({
          providerSlug: slug,
          cred: {},
          phone: "5511999999999",
          audio: AUDIO,
        });
        assert(!r.ok, `${slug} não deveria aceitar áudio`);
        assertStringIncludes(r.error, slug, "o erro precisa nomear o canal");
      }
    } finally {
      restore();
    }
    assert(!chamou, "canal sem suporte não pode gastar uma chamada HTTP");
  });

  await t.step("providerSupportsAudio bate com quem foi implementado", () => {
    for (const s of ["zapi", "zappaz", "meta-cloud", "evolution"]) {
      assert(providerSupportsAudio(s), s);
    }
    for (const s of ["twilio", "resend", "email", "push"]) {
      assert(!providerSupportsAudio(s), s);
    }
  });
});

// `modelId` entrou em VoiceReplyPreference depois desta tabela, e como
// `deno test` type-checka antes de executar, os 8 literais incompletos
// derrubavam o ARQUIVO INTEIRO — nenhum teste de voz rodava. Não é campo que a
// decisão de falar ou não olhe, então fica no helper e sai da tabela.
const pref = (
  mode: VoiceReplyPreference["mode"],
  voiceId: string | null,
): VoiceReplyPreference => ({
  mode,
  voiceId,
  modelId: null,
});

Deno.test("shouldReplyWithAudio — tabela de decisão", async (t) => {
  await t.step("off nunca fala", () => {
    assertEquals(shouldReplyWithAudio(pref("off", "v1"), true), false);
    assertEquals(shouldReplyWithAudio(pref("off", "v1"), false), false);
  });

  await t.step("always fala nos dois casos", () => {
    assertEquals(shouldReplyWithAudio(pref("always", "v1"), false), true);
    assertEquals(shouldReplyWithAudio(pref("always", "v1"), true), true);
  });

  await t.step("on_audio só espelha quando entrou áudio", () => {
    assertEquals(shouldReplyWithAudio(pref("on_audio", "v1"), true), true);
    assertEquals(shouldReplyWithAudio(pref("on_audio", "v1"), false), false);
  });

  await t.step("sem voz escolhida cai para texto mesmo com o modo ligado", () => {
    // É o que a UI avisa em Configurações; sem isto o tenant marcaria áudio,
    // não receberia áudio e não teria como saber por quê.
    assertEquals(shouldReplyWithAudio(pref("always", null), true), false);
    assertEquals(shouldReplyWithAudio(pref("on_audio", null), true), false);
  });
});

// Regressão do review: `if (error || !data) return VOICE_OFF` engolia QUALQUER
// erro do PostgREST (RLS, timeout, pool esgotado), e o `catch {}` era vazio
// literal. Tenant com "sempre em áudio" passava a responder em texto para
// sempre, sem rastro em console, ai_failure_logs ou system_events. A tolerância
// documentada vale só para 42703 (coluna inexistente = migration não aplicada).
Deno.test("loadVoiceReplyPreference — só 42703 é falha tolerável em silêncio", async (t) => {
  const admin = () =>
    createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

  function router(settingsResponse: Response, sink: string[]) {
    return (req: { pathname: string; bodyText: string }) => {
      if (req.pathname.includes("ai_failure_logs")) {
        sink.push(req.bodyText);
        return jsonResponse(201, []);
      }
      if (req.pathname.includes("tenant_integrations")) {
        return jsonResponse(200, [{ status: "active" }]);
      }
      if (req.pathname.includes("ai_settings")) return settingsResponse;
      return undefined;
    };
  }

  await t.step("42703 cai em off e NÃO registra falha (é o cenário previsto)", async () => {
    const sink: string[] = [];
    const uninstall = installFetchMock(
      router(jsonResponse(400, { code: "42703", message: "column does not exist" }), sink),
    );
    try {
      const pref = await loadVoiceReplyPreference(admin(), "tenant-1");
      assertEquals(pref.mode, "off");
      assertEquals(sink.length, 0);
    } finally {
      uninstall();
    }
  });

  await t.step("timeout do banco cai em off MAS registra em ai_failure_logs", async () => {
    const sink: string[] = [];
    const uninstall = installFetchMock(
      router(
        jsonResponse(500, {
          code: "57014",
          message: "canceling statement due to statement timeout",
        }),
        sink,
      ),
    );
    try {
      const pref = await loadVoiceReplyPreference(admin(), "tenant-1");
      assertEquals(pref.mode, "off");
      assertEquals(sink.length, 1);
      assertStringIncludes(sink[0], "voice_preference");
    } finally {
      uninstall();
    }
  });
});

// A síntese era o único dos três fetch do módulo sem AbortController, e ela roda
// DENTRO do lock de conversa: ElevenLabs travada segurava o isolate até a
// plataforma matá-lo, e o claim em ai_processing_log (sem TTL nem delete)
// deixava a mensagem sem resposta para sempre. Aqui verifica-se o caminho de
// erro que o wrapper novo introduz — falha de rede vira VoiceError tipado com
// stage "synthesize", em vez de escapar como TypeError cru.
Deno.test("synthesizeSpeech — falha de rede vira VoiceError, não exceção crua", async () => {
  const uninstall = installFetchMock(() => {
    throw new TypeError("error sending request: connection closed");
  });
  try {
    let caught: unknown = null;
    try {
      await synthesizeSpeech("el-key", "voice-1", "Olá, tudo bem?");
    } catch (e) {
      caught = e;
    }
    assert(caught instanceof VoiceError, `esperado VoiceError, veio ${caught}`);
    assertEquals((caught as VoiceError).stage, "synthesize");
    assertStringIncludes((caught as VoiceError).message, "Falha na chamada de síntese");
  } finally {
    uninstall();
  }
});

// P0 observabilidade (2026-08-04): o HTTP 402 da ElevenLabs chegava cru e em
// inglês em reason_detail (channel_status_events) — reincidência de
// erro-ingles-vaza-na-ui-de-integracoes em caminho novo. Detecta pelo `code`
// estruturado do corpo (`paid_plan_required`), nunca por substring da
// mensagem em inglês (ela muda sem aviso).
Deno.test("synthesizeSpeech — 402 paid_plan_required vira mensagem PT-BR acionável", async () => {
  const uninstall = installFetchMock(() =>
    jsonResponse(402, {
      detail: {
        type: "payment_required",
        code: "paid_plan_required",
        message: "Free users cannot use library voices via the API. Upgrade to a paid plan.",
      },
    })
  );
  try {
    let caught: unknown = null;
    try {
      await synthesizeSpeech("el-key", "voice-1", "Olá, tudo bem?");
    } catch (e) {
      caught = e;
    }
    assert(caught instanceof VoiceError, `esperado VoiceError, veio ${caught}`);
    assertEquals((caught as VoiceError).stage, "synthesize");
    assertEquals((caught as VoiceError).statusCode, 402);
    assertStringIncludes((caught as VoiceError).message, "biblioteca da ElevenLabs");
    assertStringIncludes((caught as VoiceError).message, "plano pago");
    assert(
      !(caught as VoiceError).message.includes("Free users"),
      `mensagem crua em inglês vazou: ${(caught as VoiceError).message}`,
    );
  } finally {
    uninstall();
  }
});

// Um 402 SEM o `code` conhecido não deve travar em silêncio nem reintroduzir
// a mensagem crua em inglês — cai no PT-BR genérico de restrição de plano.
Deno.test("synthesizeSpeech — 402 sem code conhecido cai em PT-BR genérico", async () => {
  const uninstall = installFetchMock(() =>
    jsonResponse(402, { detail: { type: "payment_required", message: "Quota exceeded" } })
  );
  try {
    let caught: unknown = null;
    try {
      await synthesizeSpeech("el-key", "voice-1", "Olá, tudo bem?");
    } catch (e) {
      caught = e;
    }
    assert(caught instanceof VoiceError, `esperado VoiceError, veio ${caught}`);
    assertEquals((caught as VoiceError).statusCode, 402);
    assert(
      !(caught as VoiceError).message.includes("Quota exceeded"),
      `mensagem crua em inglês vazou: ${(caught as VoiceError).message}`,
    );
    assertStringIncludes((caught as VoiceError).message, "plano");
  } finally {
    uninstall();
  }
});

// Desconectar a ElevenLabs na UI não desligava o áudio: `disconnect` só marca
// tenant_integrations.status='disabled' e DEIXA a chave em integration_secrets
// (só `forget` apaga), e loadProviderSecrets lê o segredo direto. O assistente
// seguia sintetizando e queimando crédito da conta ElevenLabs do cliente depois
// de ele ter desconectado.
Deno.test("loadVoiceReplyPreference — voz exige integração ElevenLabs ativa", async (t) => {
  const admin = () =>
    createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

  function router(integrationStatus: string | null, sink: string[]) {
    return (req: { pathname: string; bodyText: string }) => {
      if (req.pathname.includes("ai_failure_logs")) {
        sink.push(req.bodyText);
        return jsonResponse(201, []);
      }
      if (req.pathname.includes("tenant_integrations")) {
        return jsonResponse(200, integrationStatus ? [{ status: integrationStatus }] : []);
      }
      if (req.pathname.includes("ai_settings")) {
        return jsonResponse(200, [{ voice_reply_mode: "always", voice_id: "voz-1" }]);
      }
      return undefined;
    };
  }

  // Controle POSITIVO: sem ele, um erro qualquer no caminho (rota não coberta,
  // seletor errado) daria "off" e o teste negativo passaria por acidente.
  await t.step("integração ativa mantém a preferência salva", async () => {
    const sink: string[] = [];
    const uninstall = installFetchMock(router("active", sink));
    try {
      const pref = await loadVoiceReplyPreference(admin(), "tenant-1");
      assertEquals(pref.mode, "always");
      assertEquals(pref.voiceId, "voz-1");
    } finally {
      uninstall();
    }
  });

  await t.step(
    "integração desconectada (disabled) derruba para texto, sem virar falha",
    async () => {
      const sink: string[] = [];
      const uninstall = installFetchMock(router("disabled", sink));
      try {
        const pref = await loadVoiceReplyPreference(admin(), "tenant-1");
        assertEquals(pref.mode, "off");
        // Desligar a voz de propósito não é falha: encher ai_failure_logs disso
        // esconderia falha de verdade.
        assertEquals(sink.length, 0);
      } finally {
        uninstall();
      }
    },
  );

  await t.step("tenant sem registro de integração também cai para texto", async () => {
    const sink: string[] = [];
    const uninstall = installFetchMock(router(null, sink));
    try {
      const pref = await loadVoiceReplyPreference(admin(), "tenant-1");
      assertEquals(pref.mode, "off");
      assertEquals(sink.length, 0);
    } finally {
      uninstall();
    }
  });
});

// O `clearTimeout` da transcrição rodava num finally colado ao fetch, e `fetch`
// resolve nos HEADERS: o `res.json()` que vem depois lia o corpo com o timer já
// cancelado. Um host que entrega header rápido e segura o corpo travava a
// função até a plataforma matar o isolate — com o claim em ai_processing_log já
// gravado (sem TTL nem delete), aquele áudio nunca mais seria reprocessado.
//
// A prova aqui é determinística e instantânea: instrumenta o clearTimeout e
// verifica, NO MOMENTO em que o corpo começa a ser lido, que ele ainda não
// rodou. Esperar os 20s reais do STT_TIMEOUT_MS provaria a mesma coisa e
// custaria 20s por execução da suíte.
Deno.test("transcribeAudio — o deadline continua ativo enquanto o corpo é lido", async () => {
  const realClearTimeout = globalThis.clearTimeout;
  let clearsDesdeOFetchDoStt = 0;
  let jaLimpouQuandoLeuOCorpo: boolean | null = null;
  globalThis.clearTimeout = ((id?: number) => {
    clearsDesdeOFetchDoStt++;
    return realClearTimeout(id as number);
  }) as typeof clearTimeout;

  const uninstall = installFetchMock((req) => {
    if (req.url.startsWith("https://audio.example.com/")) {
      return new Response(new Uint8Array([0x4f, 0x67, 0x67, 0x53]), {
        status: 200,
        headers: { "content-type": "audio/ogg" },
      });
    }
    if (req.url.startsWith("https://api.elevenlabs.io/v1/speech-to-text")) {
      // O download acima já rodou o clearTimeout DELE; o contador começa a
      // valer a partir daqui, que é o fetch cujo deadline está sob teste.
      clearsDesdeOFetchDoStt = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(ctrl) {
          // Segura o corpo por 10ms ANTES de entregar o primeiro byte. É a
          // janela que reproduz o host lento: o `fetch` já resolveu (os headers
          // chegaram) e o corpo ainda não foi consumido. Sem o atraso não dá pra
          // medir nada — o stream faz o primeiro `pull` sozinho, antes mesmo do
          // fetch resolver, e a foto sairia certa nos dois códigos.
          return new Promise<void>((resolve) => {
            setTimeout(() => {
              if (jaLimpouQuandoLeuOCorpo === null) {
                jaLimpouQuandoLeuOCorpo = clearsDesdeOFetchDoStt > 0;
              }
              ctrl.enqueue(new TextEncoder().encode(JSON.stringify({ text: "bom dia" })));
              ctrl.close();
              resolve();
            }, 10);
          });
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }
    return undefined;
  });

  try {
    const texto = await transcribeAudio("el-key", "https://audio.example.com/nota.ogg");
    assertEquals(texto, "bom dia");
    assertEquals(
      jaLimpouQuandoLeuOCorpo,
      false,
      "clearTimeout rodou ANTES da leitura do corpo — o corpo estava sendo lido sem deadline",
    );
  } finally {
    uninstall();
    globalThis.clearTimeout = realClearTimeout;
  }
});

Deno.test("transcribeMetaCloudAudio — credencial e tamanho são bloqueados", async (t) => {
  await t.step("token Meta ausente bloqueia antes de qualquer fetch", async () => {
    let fetched = false;
    const restore = installFetchMock(() => {
      fetched = true;
      return jsonResponse(200, {});
    });
    try {
      await expectVoiceError(
        () => transcribeMetaCloudAudio("el-key", "", "meta-media:audio-1"),
        "download",
        "access_token",
      );
      assertEquals(fetched, false);
    } finally {
      restore();
    }
  });

  await t.step("Content-Length acima de 20 MB é recusado sem chamar STT", async () => {
    let sttCalled = false;
    const restore = installFetchMock((req) => {
      if (req.pathname === "/v23.0/audio-1") {
        return jsonResponse(200, {
          url: "https://lookaside.fbsbx.com/media/audio-1",
          mime_type: "audio/ogg",
        });
      }
      if (new URL(req.url).hostname === "lookaside.fbsbx.com") {
        return new Response(new Uint8Array([1]), {
          status: 200,
          headers: {
            "content-type": "audio/ogg",
            "content-length": String(20 * 1024 * 1024 + 1),
          },
        });
      }
      if (new URL(req.url).hostname === "api.elevenlabs.io") sttCalled = true;
      return undefined;
    });
    try {
      await expectVoiceError(
        () => transcribeMetaCloudAudio("el-key", "meta-token", "meta-media:audio-1"),
        "download",
        "grande demais",
      );
      assertEquals(sttCalled, false);
    } finally {
      restore();
    }
  });
});

Deno.test("transcribeMetaCloudAudio — respostas inválidas são bloqueadas", async (t) => {
  await t.step("MIME não-áudio devolvido no download é recusado", async () => {
    const restore = installFetchMock((req) => {
      if (req.pathname === "/v23.0/audio-1") {
        return jsonResponse(200, {
          url: "https://lookaside.fbsbx.com/media/audio-1",
          mime_type: "audio/ogg",
        });
      }
      if (new URL(req.url).hostname === "lookaside.fbsbx.com") {
        return new Response("<html>erro</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return undefined;
    });
    try {
      await expectVoiceError(
        () => transcribeMetaCloudAudio("el-key", "meta-token", "meta-media:audio-1"),
        "download",
        "MIME de áudio inválido",
      );
    } finally {
      restore();
    }
  });

  await t.step("timeout/rejeição da Graph vira erro de download tipado", async () => {
    const restore = installFetchMock((req) => {
      if (new URL(req.url).hostname === "graph.facebook.com") {
        throw new DOMException("signal timed out", "AbortError");
      }
      return undefined;
    });
    try {
      await expectVoiceError(
        () => transcribeMetaCloudAudio("el-key", "meta-token", "meta-media:audio-1"),
        "download",
        "Falha ao resolver áudio na Meta",
      );
    } finally {
      restore();
    }
  });

  await t.step("transcript vazio é recusado como falha de transcrição", async () => {
    const restore = installFetchMock((req) => {
      if (req.pathname === "/v23.0/audio-1") {
        return jsonResponse(200, {
          url: "https://lookaside.fbsbx.com/media/audio-1",
          mime_type: "audio/ogg",
        });
      }
      if (new URL(req.url).hostname === "lookaside.fbsbx.com") {
        return new Response(new Uint8Array([0x4f, 0x67, 0x67, 0x53]), {
          status: 200,
          headers: { "content-type": "audio/ogg" },
        });
      }
      if (new URL(req.url).hostname === "api.elevenlabs.io") {
        return jsonResponse(200, { text: "  " });
      }
      return undefined;
    });
    try {
      await expectVoiceError(
        () => transcribeMetaCloudAudio("el-key", "meta-token", "meta-media:audio-1"),
        "transcribe",
        "Transcrição voltou vazia",
      );
    } finally {
      restore();
    }
  });
});

// -------------------- MIME genérico no áudio recebido --------------------
//
// Caso real de 2026-08-04: dois áudios de WhatsApp chegaram com
// `content-type: application/octet-stream` e a transcrição recusou os dois
// ("MIME de áudio inválido"), levando a conversa a handoff por
// transcription_failed. O cabeçalho era genérico, não errado — os bytes eram
// OGG de verdade.

function respostaDeAudio(bytes: number[], contentType: string): FetchMatcher {
  return (req) => {
    if (req.url.startsWith("https://audio.example.com/")) {
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: { "content-type": contentType },
      });
    }
    if (req.url.startsWith("https://api.elevenlabs.io/v1/speech-to-text")) {
      return jsonResponse(200, { text: "transcrito" });
    }
    return undefined;
  };
}

const OGG = [0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0, 0, 0, 0, 0];
const MP3_ID3 = [0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0, 0, 0];

Deno.test("transcribeAudio — MIME genérico não recusa áudio legítimo", async (t) => {
  await t.step("application/octet-stream com bytes OGG: transcreve", async () => {
    const uninstall = installFetchMock(respostaDeAudio(OGG, "application/octet-stream"));
    try {
      assertEquals(
        await transcribeAudio("el-key", "https://audio.example.com/nota.ogg"),
        "transcrito",
      );
    } finally {
      uninstall();
    }
  });

  await t.step("octet-stream com bytes MP3: transcreve", async () => {
    const uninstall = installFetchMock(respostaDeAudio(MP3_ID3, "application/octet-stream"));
    try {
      assertEquals(
        await transcribeAudio("el-key", "https://audio.example.com/nota.bin"),
        "transcrito",
      );
    } finally {
      uninstall();
    }
  });

  // A guarda NÃO foi removida: o que não é áudio continua recusado. Sem este
  // caso, "aceitar octet-stream" viraria "aceitar qualquer coisa".
  await t.step("octet-stream com bytes que não são áudio: recusa", async () => {
    const html = [0x3c, 0x21, 0x44, 0x4f, 0x43, 0x54, 0x59, 0x50, 0x45, 0x20, 0x68, 0x74];
    const uninstall = installFetchMock(respostaDeAudio(html, "application/octet-stream"));
    try {
      await expectVoiceError(
        () => transcribeAudio("el-key", "https://audio.example.com/pagina.bin"),
        "download",
        "MIME de áudio inválido",
      );
    } finally {
      uninstall();
    }
  });
});

// -------------------- Mídia cifrada do WhatsApp (Zappaz) --------------------
//
// Caso real de 2026-08-05: canal Zappaz (cliente WhatsApp não-oficial,
// protocolo Baileys) manda `audioMessage.url` apontando pra CDN nativa do
// WhatsApp (`mmg.whatsapp.net/.../*.enc`), servida com
// `content-type: application/octet-stream`. Os bytes NÃO são áudio com
// header estranho — são ciphertext AES-256-CBC (confirmado baixando a URL
// real de produção: 27434 bytes sem nenhuma assinatura de
// `sniffAudioMime`). #168 amplia a lista de assinaturas aceitas; não existe
// assinatura que reconheça ciphertext, então esse caso nunca foi resgatável
// por sniffing — precisa de decriptação HKDF+AES-CBC, fora do escopo deste
// fix. O que muda aqui é só a mensagem de erro: deixa de mentir "MIME
// inválido" (implica bug de parsing) e passa a nomear a causa real, pra não
// mascarar o gap de suporte.
Deno.test("transcribeAudio — mídia .enc da CDN do WhatsApp é recusada com causa nomeada", async (t) => {
  await t.step("mmg.whatsapp.net/*.enc: erro cita cifrado, não 'MIME inválido'", async () => {
    // Bytes sem qualquer assinatura reconhecida por sniffAudioMime — representativo
    // do ciphertext real (não precisa ser o ciphertext exato para o teste valer).
    const ciphertext = [0x36, 0x65, 0x48, 0x83, 0xbe, 0xb8, 0xeb, 0xfe, 0x53, 0x9a, 0x48, 0x14];
    const url =
      "https://mmg.whatsapp.net/v/t62.7114-24/audio.enc?ccb=11-4&oh=abc&oe=6A9952FA&mms3=true";
    const uninstall = installFetchMock((req) => {
      if (req.url === url) {
        return new Response(new Uint8Array(ciphertext), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      }
      return undefined;
    });
    try {
      let caught: unknown = null;
      try {
        await transcribeAudio("el-key", url);
      } catch (error) {
        caught = error;
      }
      assert(caught instanceof VoiceError, "esperava VoiceError");
      const err = caught as VoiceError;
      assertEquals(err.stage, "download");
      assertStringIncludes(err.message, "cifrado");
      assertStringIncludes(err.message, "whatsapp.net");
      // A garantia negativa que importa: não pode voltar a alegar "MIME
      // inválido" — essa frase é o sintoma do bug original (mensagem culpava
      // o header, escondia que o corpo é ciphertext).
      assert(
        !err.message.startsWith("MIME de áudio inválido"),
        `mensagem não deveria repetir o erro genérico de MIME: ${err.message}`,
      );
    } finally {
      uninstall();
    }
  });

  await t.step("host whatsapp.net sem .enc: continua tratado como MIME genérico", async () => {
    // Guarda de escopo: só o par (host whatsapp.net + path .enc) muda de
    // mensagem. Qualquer outra coisa nesse host cai no branch antigo.
    const bytes = [0x3c, 0x21, 0x44, 0x4f, 0x43, 0x54, 0x59, 0x50, 0x45];
    const url = "https://mmg.whatsapp.net/v/t62.7114-24/nao-e-enc.bin";
    const uninstall = installFetchMock((req) => {
      if (req.url === url) {
        return new Response(new Uint8Array(bytes), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      }
      return undefined;
    });
    try {
      await expectVoiceError(() => transcribeAudio("el-key", url), "download", "MIME de áudio inválido");
    } finally {
      uninstall();
    }
  });
});
