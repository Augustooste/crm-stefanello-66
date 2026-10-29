// voice-catalog.test.ts — listagem de vozes da ElevenLabs (action list_voices).
import { assertEquals } from "jsr:@std/assert@1";
import { fetchElevenLabsVoices, normalizeGender } from "../_shared/ai/voice-catalog.ts";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.test("normalizeGender mapeia rótulos da ElevenLabs para PT-BR", () => {
  assertEquals(normalizeGender("female"), "feminina");
  assertEquals(normalizeGender("Male"), "masculina");
  assertEquals(normalizeGender("non-binary"), "neutra");
  assertEquals(normalizeGender(undefined), "neutra");
});

Deno.test("sem chave salva devolve erro amigável e não chama a API", async () => {
  let called = false;
  const res = await fetchElevenLabsVoices("   ", () => {
    called = true;
    return Promise.resolve(jsonRes(200, {}));
  });
  assertEquals(called, false);
  assertEquals(res.ok, false);
  assertEquals(res.error?.includes("não está conectada"), true);
});

Deno.test("401 da ElevenLabs vira instrução de gerar nova chave", async () => {
  const res = await fetchElevenLabsVoices("k", () => Promise.resolve(jsonRes(401, {})));
  assertEquals(res.ok, false);
  assertEquals(res.error?.includes("recusou a chave"), true);
});

Deno.test("resposta feliz normaliza, ordena e descarta prévia insegura", async () => {
  const res = await fetchElevenLabsVoices("k", (_url, init) => {
    const h = (init as { headers?: Record<string, string> } | undefined)?.headers ?? {};
    assertEquals(h["xi-api-key"], "k");
    return Promise.resolve(
      jsonRes(200, {
        voices: [
          {
            voice_id: "v2",
            name: "Sarah",
            category: "premade",
            preview_url: "http://evil.example.com/a.mp3",
            labels: { gender: "female", language: "pt", accent: "brazilian" },
          },
          {
            voice_id: "v1",
            name: "Bill",
            preview_url: "https://storage.elevenlabs.io/x.mp3",
            labels: { gender: "male" },
          },
          { name: "sem id" },
        ],
      }),
    );
  });

  assertEquals(res.ok, true);
  assertEquals(res.voices?.map((v) => v.voice_id), ["v1", "v2"]);
  assertEquals(res.voices?.[0].gender, "masculina");
  assertEquals(res.voices?.[0].preview_url, "https://storage.elevenlabs.io/x.mp3");
  assertEquals(res.voices?.[1].gender, "feminina");
  assertEquals(res.voices?.[1].language, "pt");
  // URL fora do domínio da ElevenLabs não vira <audio src>.
  assertEquals(res.voices?.[1].preview_url, null);
});

Deno.test("conta sem vozes devolve erro orientando cadastrar voz", async () => {
  const res = await fetchElevenLabsVoices("k", () => Promise.resolve(jsonRes(200, { voices: [] })));
  assertEquals(res.ok, false);
  assertEquals(res.error?.includes("Nenhuma voz encontrada"), true);
});
