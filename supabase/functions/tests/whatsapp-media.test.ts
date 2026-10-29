// Testes da decifragem de mídia do WhatsApp nativo (Baileys).
//
// A cifra é reproduzida AQUI, a partir da mesma derivação, em vez de guardar um
// `.enc` real de fixture: o arquivo real vem com áudio de uma pessoa e o link da
// CDN expira, então a fixture apodreceria e ainda carregaria conteúdo de lead.
// A prova contra o mundo real foi feita fora do repo (payload de produção de
// 2026-08-05 14:12: MAC confere, saída começa em "OggS", 26051 bytes iguais ao
// `fileLength` anunciado) e está registrada na PR.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import {
  decryptWhatsAppMedia,
  isEncryptedWhatsAppUrl,
  rehostEncryptedWhatsAppAudio,
  WhatsAppMediaError,
} from "../_shared/messaging/whatsapp-media.ts";
import {
  cifrarMidiaWhatsApp,
  MEDIA_KEY_BASE64,
  oggFalso,
} from "./_fixtures/whatsapp-media.ts";

const INFO_AUDIO = "WhatsApp Audio Keys";

async function expandir(mediaKey: Uint8Array<ArrayBuffer>, info: string) {
  const key = await crypto.subtle.importKey("raw", mediaKey, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(new ArrayBuffer(32)),
      info: new TextEncoder().encode(info),
    },
    key,
    112 * 8,
  );
  const e = new Uint8Array(bits);
  const fatiar = (i: number, f: number) => {
    const out = new Uint8Array(new ArrayBuffer(f - i));
    out.set(e.subarray(i, f));
    return out;
  };
  return { iv: fatiar(0, 16), cipherKey: fatiar(16, 48), macKey: fatiar(48, 80) };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(a.byteLength + b.byteLength));
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

function paraBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/** Cifra como o WhatsApp cifra: AES-256-CBC + 10 bytes de HMAC no fim. */
async function cifrar(
  plano: Uint8Array<ArrayBuffer>,
  mediaKey: Uint8Array<ArrayBuffer>,
  info = INFO_AUDIO,
) {
  const { iv, cipherKey, macKey } = await expandir(mediaKey, info);
  const aesKey = await crypto.subtle.importKey("raw", cipherKey, { name: "AES-CBC" }, false, [
    "encrypt",
  ]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-CBC", iv }, aesKey, plano),
  );
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    macKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const assinatura = new Uint8Array(
    await crypto.subtle.sign("HMAC", hmacKey, concat(iv, ciphertext)),
  );
  return concat(ciphertext, assinatura.subarray(0, 10));
}


const CHAVE = new Uint8Array(new ArrayBuffer(32)).map((_, i) => (i * 7 + 3) % 256);

Deno.test("decifra o áudio e devolve exatamente os bytes originais", async () => {
  const original = oggFalso();
  const cifrado = await cifrar(original, CHAVE);
  const saida = await decryptWhatsAppMedia(cifrado, paraBase64(CHAVE), "audio");
  assertEquals(saida.byteLength, original.byteLength);
  assertEquals(new TextDecoder().decode(saida.slice(0, 4)), "OggS");
  assert(saida.every((b, i) => b === original[i]), "conteúdo decifrado difere do original");
});

Deno.test("chave errada falha no MAC em vez de devolver lixo", async () => {
  // Sem a checagem de MAC este caso devolveria bytes aleatórios, que virariam
  // transcrição alucinada — falha silenciosa pior que erro.
  const cifrado = await cifrar(oggFalso(), CHAVE);
  const outraChave = new Uint8Array(new ArrayBuffer(32)).map((_, i) => (i * 13 + 1) % 256);
  const erro = await assertRejects(
    () => decryptWhatsAppMedia(cifrado, paraBase64(outraChave), "audio"),
    WhatsAppMediaError,
  );
  assert(erro.message.includes("MAC"), `mensagem inesperada: ${erro.message}`);
});

Deno.test("rótulo HKDF errado (imagem em vez de áudio) também falha no MAC", async () => {
  const cifrado = await cifrar(oggFalso(), CHAVE, "WhatsApp Image Keys");
  await assertRejects(
    () => decryptWhatsAppMedia(cifrado, paraBase64(CHAVE), "audio"),
    WhatsAppMediaError,
  );
});

Deno.test("arquivo adulterado no último byte não passa", async () => {
  const cifrado = await cifrar(oggFalso(), CHAVE);
  cifrado[cifrado.byteLength - 1] ^= 0xff;
  await assertRejects(
    () => decryptWhatsAppMedia(cifrado, paraBase64(CHAVE), "audio"),
    WhatsAppMediaError,
  );
});

Deno.test("mediaKey fora do tamanho é recusada antes de qualquer cripto", async () => {
  const cifrado = await cifrar(oggFalso(), CHAVE);
  const erro = await assertRejects(
    () => decryptWhatsAppMedia(cifrado, paraBase64(new Uint8Array(new ArrayBuffer(16))), "audio"),
    WhatsAppMediaError,
  );
  assert(erro.message.includes("32"), `mensagem inesperada: ${erro.message}`);
});

Deno.test("arquivo curto demais para carregar MAC é recusado", async () => {
  await assertRejects(
    () => decryptWhatsAppMedia(new Uint8Array(new ArrayBuffer(12)), paraBase64(CHAVE), "audio"),
    WhatsAppMediaError,
  );
});

Deno.test("isEncryptedWhatsAppUrl separa a CDN nativa do resto", () => {
  assert(isEncryptedWhatsAppUrl("https://mmg.whatsapp.net/v/t62/abc_123.enc?ccb=11-4&oe=6A99"));
  assert(isEncryptedWhatsAppUrl("https://whatsapp.net/x/y.enc"));
  // Storage nosso, já decifrado — não pode ser tratado como cifrado.
  assert(!isEncryptedWhatsAppUrl("https://projeto.supabase.co/storage/v1/object/sign/x.ogg"));
  // Sufixo parecido não vale: domínio precisa terminar em whatsapp.net.
  assert(!isEncryptedWhatsAppUrl("https://naowhatsapp.net.exemplo.com/a.enc"));
  assert(!isEncryptedWhatsAppUrl("https://mmg.whatsapp.net/v/t62/audio.ogg"));
  assert(!isEncryptedWhatsAppUrl("não é url"));
});

// -------------------- rehostEncryptedWhatsAppAudio --------------------
// A falha real de 2026-08-05 não foi na cripto: foi o Storage recusando o OGG
// porque o bucket só aceitava `audio/mpeg`. Nada nos testes pegava isso — a
// função inteira (download + upload + assinatura + telemetria) não tinha
// cobertura. Estes testes fecham o buraco com um `admin` de mentira.

interface AdminFalso {
  admin: SupabaseClient;
  uploads: Array<{ path: string; contentType: string; bytes: number }>;
  eventos: Array<Record<string, unknown>>;
}

function adminFalso(opts: { erroUpload?: string; erroSign?: string } = {}): AdminFalso {
  const uploads: AdminFalso["uploads"] = [];
  const eventos: AdminFalso["eventos"] = [];
  const admin = {
    storage: {
      from: (_bucket: string) => ({
        upload: (
          path: string,
          data: Uint8Array,
          o: { contentType: string },
        ) => {
          uploads.push({ path, contentType: o.contentType, bytes: data.byteLength });
          return Promise.resolve({
            error: opts.erroUpload ? { message: opts.erroUpload } : null,
          });
        },
        createSignedUrl: (path: string, _ttl: number) =>
          Promise.resolve(
            opts.erroSign
              ? { data: null, error: { message: opts.erroSign } }
              : {
                data: { signedUrl: `https://proj.supabase.co/storage/v1/object/sign/${path}?t=1` },
                error: null,
              },
          ),
      }),
    },
    from: (_table: string) => ({
      insert: (row: Record<string, unknown>) => {
        eventos.push(row);
        return Promise.resolve({ error: null });
      },
    }),
  } as unknown as SupabaseClient;
  return { admin, uploads, eventos };
}

const CDN_URL = "https://mmg.whatsapp.net/v/t62.7117-24/fixture_audio.enc?ccb=11-4";

function comFetch(handler: typeof fetch, fn: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  return fn().finally(() => {
    globalThis.fetch = real;
  });
}

function respostaCifrada(bytes: Uint8Array<ArrayBuffer>): Response {
  return new Response(bytes.buffer, {
    status: 200,
    headers: { "content-length": String(bytes.byteLength) },
  });
}

function estagios(eventos: Array<Record<string, unknown>>): string[] {
  return eventos.map((e) => String((e.context as { stage?: string } | undefined)?.stage ?? "?"));
}

Deno.test("rehost: decifra, sobe como audio/ogg e devolve link assinado", async () => {
  const original = oggFalso(3000);
  const cifrado = await cifrarMidiaWhatsApp(original);
  const { admin, uploads, eventos } = adminFalso();
  await comFetch(
    () => Promise.resolve(respostaCifrada(cifrado)),
    async () => {
      const url = await rehostEncryptedWhatsAppAudio(admin, {
        tenantId: "tenant-1",
        externalId: "3EB0ABC",
        url: CDN_URL,
        mediaKey: MEDIA_KEY_BASE64,
        mimetype: "audio/ogg; codecs=opus",
      });
      assert(url?.includes("/storage/v1/object/sign/"), `URL inesperada: ${url}`);
      assertEquals(uploads.length, 1);
      // O `; codecs=opus` PRECISA sair: é o content-type que a política do
      // bucket avalia, e foi exatamente por ele que o upload falhou em produção.
      assertEquals(uploads[0].contentType, "audio/ogg");
      assertEquals(uploads[0].bytes, original.byteLength);
      assertEquals(uploads[0].path, "inbound/tenant-1/3EB0ABC.ogg");
      assertEquals(estagios(eventos), ["ok"]);
    },
  );
});

Deno.test("rehost: bucket recusando o MIME devolve null com stage=upload", async () => {
  const cifrado = await cifrarMidiaWhatsApp(oggFalso(1000));
  const { admin, eventos } = adminFalso({ erroUpload: "mime type audio/ogg is not supported" });
  await comFetch(
    () => Promise.resolve(respostaCifrada(cifrado)),
    async () => {
      const url = await rehostEncryptedWhatsAppAudio(admin, {
        tenantId: "t", externalId: "e", url: CDN_URL, mediaKey: MEDIA_KEY_BASE64,
      });
      assertEquals(url, null);
      assertEquals(estagios(eventos), ["upload"]);
      assert(
        String(eventos[0].message).includes("mime type"),
        `mensagem do Storage precisa chegar no evento: ${eventos[0].message}`,
      );
    },
  );
});

Deno.test("rehost: falha ao assinar devolve null com stage=sign", async () => {
  const cifrado = await cifrarMidiaWhatsApp(oggFalso(1000));
  const { admin, eventos } = adminFalso({ erroSign: "object not found" });
  await comFetch(
    () => Promise.resolve(respostaCifrada(cifrado)),
    async () => {
      const url = await rehostEncryptedWhatsAppAudio(admin, {
        tenantId: "t", externalId: "e", url: CDN_URL, mediaKey: MEDIA_KEY_BASE64,
      });
      assertEquals(url, null);
      assertEquals(estagios(eventos), ["sign"]);
    },
  );
});

Deno.test("rehost: URL fora da CDN do WhatsApp nem chega a ser baixada", async () => {
  const { admin, eventos } = adminFalso();
  let baixou = false;
  await comFetch(
    () => {
      baixou = true;
      return Promise.resolve(new Response("nunca", { status: 200 }));
    },
    async () => {
      const url = await rehostEncryptedWhatsAppAudio(admin, {
        tenantId: "t",
        externalId: "e",
        url: "https://169.254.169.254/latest/meta-data/iam/",
        mediaKey: MEDIA_KEY_BASE64,
      });
      assertEquals(url, null);
      assertEquals(baixou, false, "SSRF: não pode nem tentar buscar URL fora da CDN");
      assertEquals(estagios(eventos), ["download"]);
    },
  );
});

Deno.test("rehost: timeout do download não é rotulado como falha de cripto", async () => {
  const { admin, eventos } = adminFalso();
  await comFetch(
    () => Promise.reject(new DOMException("Signal timed out.", "TimeoutError")),
    async () => {
      const url = await rehostEncryptedWhatsAppAudio(admin, {
        tenantId: "t", externalId: "e", url: CDN_URL, mediaKey: MEDIA_KEY_BASE64,
      });
      assertEquals(url, null);
      assertEquals(estagios(eventos), ["download_timeout"]);
    },
  );
});

Deno.test("rehost: chave errada falha como decrypt e não sobe nada", async () => {
  const cifrado = await cifrarMidiaWhatsApp(oggFalso(1000));
  const { admin, uploads, eventos } = adminFalso();
  const outraChave = btoa(String.fromCharCode(...new Uint8Array(new ArrayBuffer(32)).map((_, i) => i)));
  await comFetch(
    () => Promise.resolve(respostaCifrada(cifrado)),
    async () => {
      const url = await rehostEncryptedWhatsAppAudio(admin, {
        tenantId: "t", externalId: "e", url: CDN_URL, mediaKey: outraChave,
      });
      assertEquals(url, null);
      assertEquals(uploads.length, 0, "nada pode subir sem MAC válido");
      assertEquals(estagios(eventos), ["decrypt"]);
    },
  );
});
