// whatsapp-media.ts — decifra mídia do protocolo nativo do WhatsApp (Baileys).
//
// Clientes NÃO-oficiais (Zappaz e similares) repassam no webhook a URL crua da
// CDN do WhatsApp (`mmg.whatsapp.net/....enc`). O arquivo de lá é o ciphertext
// da criptografia ponta-a-ponta: `content-type: application/octet-stream`, sem
// assinatura de formato nenhuma. Foi o que deixou o canal Zappaz mudo para
// áudio — a transcrição recebia 26 KB de ruído e recusava.
//
// A chave vem no MESMO payload do webhook (`audioMessage.mediaKey`, 32 bytes em
// base64), então dá para decifrar sem pedir nada ao provedor — que, aliás, não
// tem endpoint de download de mídia (39 rotas no OpenAPI, nenhuma serve isso).
//
// Derivação (padrão do protocolo, igual ao que o Baileys faz):
//   expandido  = HKDF-SHA256(mediaKey, salt=32 zeros, info=<rótulo do tipo>, 112 bytes)
//   iv         = expandido[0..16]
//   cipherKey  = expandido[16..48]
//   macKey     = expandido[48..80]
//   ciphertext = arquivo SEM os últimos 10 bytes (esses 10 são o MAC)
//   plaintext  = AES-256-CBC(ciphertext, cipherKey, iv)
//
// O MAC é conferido, não ignorado: `HMAC-SHA256(macKey, iv || ciphertext)`
// truncado em 10 bytes. Sem essa checagem, chave errada não dá erro — dá lixo,
// e lixo vira transcrição alucinada em vez de falha visível.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { captureEdgeError } from "../telemetry.ts";
import { validatePublicHttpsUrl } from "../validate-http-url.ts";

/** Rótulo HKDF por tipo de mídia. Só áudio é usado hoje; os outros seguem em handoff. */
const MEDIA_INFO = {
  audio: "WhatsApp Audio Keys",
  image: "WhatsApp Image Keys",
  video: "WhatsApp Video Keys",
  document: "WhatsApp Document Keys",
} as const;

export type WhatsAppMediaKind = keyof typeof MEDIA_INFO;

export class WhatsAppMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhatsAppMediaError";
  }
}

/**
 * Alias para o `Uint8Array` respaldado por `ArrayBuffer` (e não por
 * `SharedArrayBuffer`), que é o que a WebCrypto aceita como `BufferSource` no
 * TypeScript do Deno 2.9.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

function alocar(tamanho: number): Bytes {
  return new Uint8Array(new ArrayBuffer(tamanho));
}

/** Fatia copiando para um buffer próprio — preserva o tipo `Bytes`. */
function fatiar(origem: Uint8Array, inicio: number, fim: number): Bytes {
  const out = alocar(fim - inicio);
  out.set(origem.subarray(inicio, fim));
  return out;
}

function base64ToBytes(value: string): Bytes {
  const binary = atob(value);
  const out = alocar(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Bytes {
  const out = alocar(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

/** Comparação byte a byte em tempo constante — o MAC é material de autenticação. */
function equalsConstantTime(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function expandMediaKey(
  mediaKey: Bytes,
  kind: WhatsAppMediaKind,
): Promise<{ iv: Bytes; cipherKey: Bytes; macKey: Bytes }> {
  const key = await crypto.subtle.importKey("raw", mediaKey, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: new TextEncoder().encode(MEDIA_INFO[kind]),
    },
    key,
    112 * 8,
  );
  const expanded = new Uint8Array(bits);
  return {
    iv: fatiar(expanded, 0, 16),
    cipherKey: fatiar(expanded, 16, 48),
    macKey: fatiar(expanded, 48, 80),
  };
}

/**
 * Decifra o conteúdo baixado da CDN do WhatsApp.
 *
 * Lança `WhatsAppMediaError` quando a chave não tem 32 bytes, quando o arquivo é
 * curto demais para carregar MAC ou quando o MAC não confere — nunca devolve
 * bytes que não foram autenticados.
 */
export async function decryptWhatsAppMedia(
  // `Uint8Array<ArrayBuffer>` e não `Uint8Array` solto: sem o genérico, o
  // TypeScript assume `ArrayBufferLike` (que inclui SharedArrayBuffer), a
  // WebCrypto recusa, e a saída seria copiar o buffer inteiro só para satisfazer
  // o tipo — em áudio de 16 MiB isso é cópia cara e inútil.
  encrypted: ArrayBuffer | Bytes,
  mediaKeyBase64: string,
  kind: WhatsAppMediaKind,
): Promise<Bytes> {
  let mediaKey: Bytes;
  try {
    mediaKey = base64ToBytes(mediaKeyBase64.trim());
  } catch {
    throw new WhatsAppMediaError("mediaKey não é base64 válido.");
  }
  if (mediaKey.byteLength !== 32) {
    throw new WhatsAppMediaError(`mediaKey com ${mediaKey.byteLength} bytes, esperado 32.`);
  }

  const bytes: Bytes = encrypted instanceof Uint8Array ? encrypted : new Uint8Array(encrypted);
  // 10 bytes de MAC + ciphertext não-vazio. Não é um bloco AES inteiro de
  // propósito: o que importa aqui é recusar cedo o que nem chega a ser mídia;
  // tamanho inválido de bloco quem recusa é o AES-CBC logo abaixo.
  if (bytes.byteLength <= 26) {
    throw new WhatsAppMediaError(`Arquivo cifrado curto demais (${bytes.byteLength} bytes).`);
  }

  const { iv, cipherKey, macKey } = await expandMediaKey(mediaKey, kind);
  // `subarray` é view, não cópia: a WebCrypto aceita view direto.
  const ciphertext = bytes.subarray(0, bytes.byteLength - 10);
  const mac = bytes.subarray(bytes.byteLength - 10);

  const hmacKey = await crypto.subtle.importKey(
    "raw",
    macKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, concat(iv, ciphertext)));
  if (!equalsConstantTime(signature.subarray(0, 10), mac)) {
    throw new WhatsAppMediaError("MAC não confere — chave errada ou arquivo corrompido.");
  }

  const aesKey = await crypto.subtle.importKey("raw", cipherKey, { name: "AES-CBC" }, false, [
    "decrypt",
  ]);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv }, aesKey, ciphertext));
  } catch (e) {
    throw new WhatsAppMediaError(
      `Falha ao decifrar: ${e instanceof Error ? e.message : "erro desconhecido"}.`,
    );
  }
}

/**
 * Teto do download da CDN. Alinhado ao `file_size_limit` do bucket `ai-audio`
 * (16 MiB): aceitar mais aqui só trocaria uma recusa barata, antes de baixar,
 * por uma cara, depois de baixar e decifrar.
 */
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;
/** A CDN do WhatsApp responde rápido ou não responde; este fetch roda no webhook. */
const FETCH_TIMEOUT_MS = 15_000;
/**
 * Validade do link assinado gravado em `messages.media_url`. Longo de propósito:
 * quem lê é o inbox (atendente abre a conversa semanas depois) e a transcrição
 * assíncrona. O objeto segue privado — o link é a capacidade, não o bucket.
 */
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 365;

/**
 * Lê o corpo em stream, abortando ao passar de `max` bytes.
 *
 * Existe para o teto valer mesmo sem `content-length` confiável: um host que
 * responde em chunks despejaria centenas de MB dentro do timeout e mataria o
 * isolate antes de qualquer checagem de tamanho.
 */
async function lerComTeto(res: Response, max: number): Promise<Bytes> {
  const reader = res.body?.getReader();
  if (!reader) {
    const inteiro = new Uint8Array(await res.arrayBuffer());
    if (inteiro.byteLength > max) throw new Error(`Áudio grande demais (acima de ${max} bytes).`);
    return inteiro;
  }
  const pedacos: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new Error(`Áudio grande demais (acima de ${max} bytes).`);
    }
    pedacos.push(value);
  }
  const out = alocar(total);
  let offset = 0;
  for (const p of pedacos) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

/**
 * Baixa da CDN, decifra e re-hospeda o áudio no bucket `ai-audio`, devolvendo um
 * link assinado que a transcrição e o inbox conseguem ler.
 *
 * Roda no webhook, não em `ai-respond`, por um motivo concreto: o link `.enc` da
 * CDN expira (`oe=` na query), e a transcrição acontece depois, de forma
 * assíncrona e com retry. Guardar a chave para decifrar mais tarde seria uma
 * corrida contra essa expiração; guardar os bytes decifrados não é.
 *
 * NUNCA lança: qualquer falha devolve null e o chamador mantém a URL original —
 * daí o caminho de degradação (responder pedindo texto) continua valendo, que é
 * o comportamento que já estava em produção.
 */
/**
 * Guarda no bucket `ai-audio` um áudio que já chegou decifrado, embutido em
 * base64 no próprio webhook (Evolution Go com `WEBHOOK_FILES=true`), e devolve
 * um link assinado.
 *
 * Existe porque nesse caso não há nada a decifrar nem CDN a consultar — mas o
 * restante do fluxo (inbox e transcrição) só sabe ler URL.
 *
 * NUNCA lança: falha devolve null e o chamador segue com o caminho degradado.
 */
export async function storeInboundAudioBase64(
  admin: SupabaseClient,
  params: {
    tenantId: string;
    externalId: string;
    base64: string;
    mimetype?: string;
  },
): Promise<string | null> {
  const { tenantId, externalId, base64 } = params;
  try {
    // Aceita tanto base64 cru quanto data URI (provedor varia).
    const payload = base64.includes(",") && base64.startsWith("data:")
      ? base64.slice(base64.indexOf(",") + 1)
      : base64;
    const bytes = base64ToBytes(payload);
    if (bytes.byteLength === 0) return null;
    if (bytes.byteLength > MAX_MEDIA_BYTES) {
      console.error(`[whatsapp-media] áudio embutido grande demais (${bytes.byteLength} bytes).`);
      return null;
    }
    const contentType = (params.mimetype ?? "audio/ogg").split(";")[0].trim() || "audio/ogg";
    const path = `inbound/${tenantId}/${externalId.replace(/[^A-Za-z0-9._-]/g, "_")}.ogg`;
    const { error: upErr } = await admin.storage.from("ai-audio").upload(path, bytes, {
      contentType,
      upsert: true,
    });
    if (upErr) {
      console.error("[whatsapp-media] Storage recusou o áudio embutido:", upErr.message);
      return null;
    }
    const { data, error: signErr } = await admin.storage
      .from("ai-audio")
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
    if (signErr || !data?.signedUrl) {
      console.error("[whatsapp-media] falha ao assinar áudio embutido:", signErr?.message);
      return null;
    }
    await captureEdgeError(admin, {
      severity: "info",
      source: "edge",
      operation: "messaging.whatsapp_media.rehost",
      tenantId,
      message: "Áudio embutido no webhook armazenado.",
      context: { stage: "ok_base64", external_id: externalId, bytes: bytes.byteLength, path },
    });
    return data.signedUrl;
  } catch (e) {
    console.error("[whatsapp-media] erro ao armazenar áudio embutido:", e);
    return null;
  }
}

export async function rehostEncryptedWhatsAppAudio(

  admin: SupabaseClient,
  params: {
    tenantId: string;
    externalId: string;
    url: string;
    mediaKey: string;
    mimetype?: string;
  },
): Promise<string | null> {
  const { tenantId, externalId, url, mediaKey } = params;
  // `console.warn` sozinho não serve: em 2026-08-05 o upload foi recusado pelo
  // `allowed_mime_types` do bucket, o áudio caiu no fallback e do lado de fora
  // isso era indistinguível de "não conseguimos decifrar" — nada no banco, o
  // diagnóstico teve que ser refeito na mão. Agora cada motivo de desistência
  // vira linha em system_events, com o motivo em `context.stage`.
  const desistir = async (
    stage: string,
    message: string,
    extra: Record<string, unknown> = {},
    causa?: unknown,
  ) => {
    console.warn(`[whatsapp-media] ${stage}`, { message, ...extra });
    // Degradação esperada (mídia que não dá para ler) é `warn`. Erro de
    // programação — um TypeError vindo do catch — é `error` e leva stack: sem
    // isso os dois caem no mesmo balde e o bug nunca sobe para alerta.
    const inesperado = causa !== undefined && !(causa instanceof WhatsAppMediaError);
    await captureEdgeError(admin, {
      severity: inesperado ? "error" : "warn",
      source: "edge",
      operation: "messaging.whatsapp_media.rehost",
      tenantId,
      message,
      stack: inesperado && causa instanceof Error ? (causa.stack ?? null) : null,
      context: { stage, external_id: externalId, ...extra },
    });
    return null;
  };
  try {
    // A URL vem de webhook externo — trate como entrada hostil, não como link da
    // CDN. Duas guardas, porque uma só não fecha: `isEncryptedWhatsAppUrl` prende
    // o destino ao domínio do WhatsApp, e `validatePublicHttpsUrl` (a mesma de
    // ai/voice.ts) barra IP privado/loopback/metadata caso o domínio um dia
    // resolva para dentro da rede.
    if (!isEncryptedWhatsAppUrl(url)) {
      return await desistir("download", "URL de mídia fora da CDN do WhatsApp.", {
        host: (() => {
          try {
            return new URL(url).hostname;
          } catch {
            return "url inválida";
          }
        })(),
      });
    }
    const urlCheck = await validatePublicHttpsUrl(url);
    if (!urlCheck.ok) {
      return await desistir("download", `URL de mídia recusada: ${urlCheck.error}`);
    }

    const res = await fetch(url, {
      // Sem isto, um 302 na resposta levaria este fetch — que roda com
      // service_role — para onde o redirecionamento mandar, anulando as duas
      // guardas acima.
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return await desistir("download", `CDN recusou o download (HTTP ${res.status}).`, {
        status: res.status,
      });
    }
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_MEDIA_BYTES) {
      return await desistir("download", `Áudio grande demais (${declared} bytes).`, { declared });
    }
    // `content-length` é dica, não garantia: some em `transfer-encoding: chunked`
    // e pode mentir. Por isso o teto real é aplicado DURANTE a leitura — com
    // `arrayBuffer()` o corpo inteiro entraria na memória do isolate antes de
    // existir um byteLength para comparar. Mesmo raciocínio de readCapped em
    // ai/voice.ts.
    let encrypted: Bytes;
    try {
      encrypted = await lerComTeto(res, MAX_MEDIA_BYTES);
    } catch (e) {
      return await desistir(
        "download",
        e instanceof Error ? e.message : "falha ao ler o corpo da resposta",
      );
    }

    const plain = await decryptWhatsAppMedia(encrypted, mediaKey, "audio");
    // `audio/ogg; codecs=opus` é o que o WhatsApp manda; guardamos sem o
    // parâmetro porque o Storage usa o content-type na resposta e a transcrição
    // só olha o prefixo `audio/`.
    const contentType = (params.mimetype ?? "audio/ogg").split(";")[0].trim() || "audio/ogg";
    // Nome derivado do external_id: reentrega do webhook regrava o MESMO objeto
    // (upsert) em vez de multiplicar arquivo por tentativa.
    const path = `inbound/${tenantId}/${externalId.replace(/[^A-Za-z0-9._-]/g, "_")}.ogg`;
    const { error: upErr } = await admin.storage.from("ai-audio").upload(path, plain, {
      contentType,
      upsert: true,
    });
    if (upErr) {
      // Motivo real da falha de 05/08: bucket com `allowed_mime_types` só de
      // `audio/mpeg` recusando o OGG. O content-type vai no contexto porque é
      // justamente ele que a política do bucket avalia.
      return await desistir("upload", `Storage recusou o áudio: ${upErr.message}`, {
        content_type: contentType,
        bytes: plain.byteLength,
      });
    }
    const { data, error: signErr } = await admin.storage
      .from("ai-audio")
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
    if (signErr || !data?.signedUrl) {
      return await desistir("sign", `Falha ao assinar a URL: ${signErr?.message ?? "sem URL"}`);
    }
    // Sucesso também registra. Sem isto, "zero warn de rehost" tanto significa
    // "está funcionando" quanto "o bundle não subiu e este caminho nunca rodou" —
    // ambiguidade que já custou uma triagem inteira neste projeto.
    await captureEdgeError(admin, {
      severity: "info",
      source: "edge",
      operation: "messaging.whatsapp_media.rehost",
      tenantId,
      message: "Áudio decifrado e re-hospedado.",
      context: { stage: "ok", external_id: externalId, bytes: plain.byteLength, path },
    });
    return data.signedUrl;
  } catch (e) {
    // Rotular tudo como "decrypt" era mentira útil para ninguém: erro de rede do
    // fetch e o TimeoutError do AbortSignal caem aqui e não têm nada a ver com
    // cripto — a triagem seguinte procuraria bug de chave onde há problema de
    // rede. Classificação pelo `name`, não pela mensagem, que muda por runtime.
    const stage = e instanceof WhatsAppMediaError
      ? "decrypt"
      : e instanceof Error && e.name === "TimeoutError"
      ? "download_timeout"
      : "unexpected";
    return await desistir(stage, e instanceof Error ? e.message : String(e), {}, e);
  }
}

/** Só a CDN nativa do WhatsApp entrega `.enc`; qualquer outra URL passa direto. */
export function isEncryptedWhatsAppUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return (
      (parsed.hostname === "whatsapp.net" || parsed.hostname.endsWith(".whatsapp.net")) &&
      parsed.pathname.toLowerCase().endsWith(".enc")
    );
  } catch {
    return false;
  }
}
