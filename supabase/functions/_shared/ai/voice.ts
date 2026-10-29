// voice.ts — transcrição (STT) e síntese (TTS) de áudio via ElevenLabs.
//
// Motivação: até 2026-07-27 a integração `elevenlabs` era só uma linha no
// catálogo (migration 20260707000000). A api_key era gravada em
// integration_secrets e NUNCA lida por nenhuma edge function, enquanto a UI
// afirmava "o assistente já pode gerar áudios". Este módulo é o consumidor que
// faltava.
//
// Contratos confirmados na doc oficial em 2026-07-27 (não de memória):
// - STT:  POST /v1/speech-to-text — multipart, `model_id` OBRIGATÓRIO
//         (enum scribe_v1|scribe_v2) + `file`; devolve JSON com `text`.
// - TTS:  POST /v1/text-to-speech/{voice_id} — JSON `{text, model_id}`,
//         `output_format` na query; devolve os BYTES do áudio, não JSON.
// Os dois autenticam pelo header `xi-api-key`.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { validatePublicHttpsUrl } from "../validate-http-url.ts";
import { isEncryptedWhatsAppUrl } from "../messaging/whatsapp-media.ts";
import { AI_TTS_TOTAL_BUDGET_MS } from "./execution-budget.ts";
import { reportAIFailure } from "./failure-log.ts";

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";
const META_GRAPH_BASE = "https://graph.facebook.com/v23.0";
const META_MEDIA_PREFIX = "meta-media:";
const META_MEDIA_DOWNLOAD_HOSTS = [
  "lookaside.fbsbx.com",
  "lookaside.facebook.com",
  "graph.facebook.com",
] as const;

/** Modelo de transcrição. `scribe_v2` existe, mas v1 é o estável documentado. */
const STT_MODEL_ID = "scribe_v1";
/** Default da própria API; multilingue cobre PT-BR sem `language_code`. */
const TTS_MODEL_ID = "eleven_multilingual_v2";
/**
 * MP3, não OGG. Os três canais com envio implementado aceitam `audio/mpeg`
 * (a Meta lista MP3 na tabela oficial; os dois exemplos da Z-API são MP3), e
 * o OGG da Meta exige codec Opus + mono — restrição que não temos como
 * garantir a partir da saída da ElevenLabs.
 *
 * 22.05kHz/32kbps: fala fica boa e o arquivo fica ~4x menor que 44.1/128. Isso
 * importa porque Z-API e Zappaz mandam o áudio em base64 DENTRO do corpo do
 * POST, e base64 ainda infla ~33% em cima do tamanho do arquivo.
 */
const TTS_OUTPUT_FORMAT = "mp3_22050_32";

/**
 * Teto do áudio que aceitamos baixar do provider. A API da ElevenLabs aceita
 * até 5GB, mas uma edge function não tem memória nem tempo pra isso — e a URL
 * vem de payload de webhook, ou seja, é atacante-influenciável.
 */
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
/**
 * Orçamento de tempo. A transcrição roda DENTRO do lock de conversa do
 * ai-respond. Download (10s) + STT (20s) = 30s de teto; esse total entra no
 * orçamento compartilhado de execution-budget.ts.
 */
const FETCH_TIMEOUT_MS = 10_000;
const STT_TIMEOUT_MS = 20_000;
/**
 * Síntese roda no caminho de RESPOSTA, não no de transcrição — então não soma
 * com os dois acima. Mas roda dentro do mesmo lock de conversa, e sem teto
 * seguraria o isolate até a plataforma matá-lo.
 */
/**
 * Teto de caracteres por síntese. Protege o saldo da conta ElevenLabs do
 * tenant: a cobrança é por caractere e a resposta da IA já tem cap de tokens,
 * mas um prompt injection poderia inflar a saída.
 */
export const TTS_MAX_CHARS = 2500;

export type VoiceStage = "download" | "transcribe" | "synthesize";

/** Erro tipado para o caller distinguir "não deu pra baixar" de "a API recusou". */
export class VoiceError extends Error {
  constructor(
    message: string,
    readonly stage: VoiceStage,
    readonly statusCode: number | null = null,
  ) {
    super(message);
    this.name = "VoiceError";
  }
}

/** MIME que o transcritor aceita. Só `audio/*` é áudio para efeito de contrato. */
function isAudioMime(mime: string): boolean {
  return mime.toLowerCase().startsWith("audio/");
}

/**
 * Descobre o formato pela ASSINATURA do arquivo, para o caso do provedor
 * declarar `application/octet-stream` numa nota de voz legítima.
 *
 * Cobre o que os canais de WhatsApp realmente entregam. Devolve null quando não
 * reconhece — e aí a recusa continua valendo, que é o ponto: isto amplia o que
 * é aceito, não remove a guarda.
 */
function sniffAudioMime(buf: ArrayBuffer): string | null {
  const b = new Uint8Array(buf.slice(0, 12));
  const ascii = (from: number, len: number) => String.fromCharCode(...b.subarray(from, from + len));

  if (ascii(0, 4) === "OggS") return "audio/ogg"; // Opus/Vorbis — o mais comum
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return "audio/wav";
  if (ascii(0, 3) === "ID3") return "audio/mpeg";
  if (ascii(4, 4) === "ftyp") return "audio/mp4"; // m4a/aac em contêiner MP4
  if (ascii(0, 5) === "#!AMR") return "audio/amr";
  // MP3 sem tag ID3: frame sync 0xFF seguido de 0xE0 nos 3 bits altos.
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return "audio/mpeg";
  return null;
}

/**
 * Reexporta o predicado de `messaging/whatsapp-media.ts` com o nome que esta
 * camada já usava. Havia duas implementações da mesma regra ("URL `.enc` da CDN
 * nativa do WhatsApp") — se divergissem, o webhook e o ai-respond passariam a
 * discordar sobre o mesmo áudio sem nenhum sinal.
 */
export const isEncryptedWhatsAppMediaUrl = isEncryptedWhatsAppUrl;

/** `AA BB CC ...` dos primeiros bytes, só para diagnóstico em mensagem de erro. */
function hexPreview(buf: ArrayBuffer, len = 8): string {
  return Array.from(new Uint8Array(buf.slice(0, len)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}

interface DownloadAudioOptions {
  authorization?: string;
  allowedHosts?: readonly string[];
  fallbackMime?: string;
}

export function isMetaMediaReference(value: string): boolean {
  return value.startsWith(META_MEDIA_PREFIX);
}

async function resolveMetaCloudMediaUrl(
  accessToken: string,
  mediaReference: string,
  phoneNumberId?: string,
): Promise<{ url: string; mime: string }> {
  const mediaId = mediaReference.slice(META_MEDIA_PREFIX.length).trim();
  if (!mediaId || !/^[A-Za-z0-9._-]+$/.test(mediaId)) {
    throw new VoiceError("Referência de mídia Meta inválida.", "download");
  }
  if (!accessToken.trim()) {
    throw new VoiceError("Meta Cloud sem access_token para baixar o áudio.", "download");
  }

  const endpoint = new URL(`${META_GRAPH_BASE}/${encodeURIComponent(mediaId)}`);
  const normalizedPhoneNumberId = String(phoneNumberId ?? "").replace(/\D/g, "");
  if (normalizedPhoneNumberId) {
    endpoint.searchParams.set("phone_number_id", normalizedPhoneNumberId);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      throw new VoiceError(
        `Meta recusou a resolução da mídia (HTTP ${response.status}).`,
        "download",
        response.status,
      );
    }
    const body = (await response.json().catch(() => null)) as
      | { url?: unknown; mime_type?: unknown }
      | null;
    const url = typeof body?.url === "string" ? body.url.trim() : "";
    if (!url) throw new VoiceError("Meta não devolveu URL para a mídia.", "download");
    const mime = typeof body?.mime_type === "string" && body.mime_type.startsWith("audio/")
      ? body.mime_type
      : "audio/ogg";
    return { url, mime };
  } catch (error) {
    if (error instanceof VoiceError) throw error;
    throw new VoiceError(
      `Falha ao resolver áudio na Meta: ${error instanceof Error ? error.message : "erro de rede"}`,
      "download",
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Baixa o áudio apontado por `audioUrl` com guarda de SSRF.
 *
 * `audioUrl` vem de `messages.media_url`, que por sua vez vem do payload do
 * webhook do provider — fronteira de confiança. Sem `validatePublicHttpsUrl`
 * um payload forjado faria a edge function (que roda com service_role) buscar
 * `http://169.254.169.254/...` e devolver o resultado para a ElevenLabs.
 * Mesmo guard já usado por integration-connect e evolution-client.
 *
 * RESIDUAL ACEITO — DNS rebinding (TOCTOU): `validatePublicHttpsUrl` resolve o
 * host, e o `fetch` abaixo resolve DE NOVO. Um domínio com TTL curto pode
 * devolver IP público na validação e privado no fetch. Não dá para fechar isso
 * aqui: o `fetch` do Deno não aceita IP pinado, e conectar ao IP com header
 * `Host` forjado exige um cliente HTTP próprio — custo alto para o que sobra
 * de risco. O que restringe o residual hoje:
 *   - `redirect: "error"` impede o pulo para host interno depois do handshake;
 *   - o egress da edge function não tem alvo interno útil;
 *   - o corpo baixado só vai para a ElevenLabs, que rejeita não-áudio, então
 *     não há canal de exfiltração de volta para o atacante.
 * Revisitar se algum dia a função passar a devolver o corpo baixado ao caller.
 */
async function downloadAudio(
  audioUrl: string,
  opts: DownloadAudioOptions = {},
): Promise<{ bytes: ArrayBuffer; mime: string }> {
  let parsed: URL;
  try {
    parsed = new URL(audioUrl);
  } catch {
    throw new VoiceError("URL de áudio recusada: inválida", "download");
  }
  if (opts.authorization) {
    if (!opts.allowedHosts?.includes(parsed.hostname)) {
      throw new VoiceError("Host de mídia autenticada não permitido.", "download");
    }
  }
  const urlCheck = await validatePublicHttpsUrl(audioUrl);
  if (!urlCheck.ok) {
    throw new VoiceError(`URL de áudio recusada: ${urlCheck.error ?? "inválida"}`, "download");
  }

  // O timer precisa cobrir o CORPO, não só os headers. `fetch` resolve assim que
  // os headers chegam; se o clearTimeout ficasse num finally logo após o fetch,
  // a leitura do corpo rodaria sem AbortSignal ativo e um host lento seguraria a
  // função até o wall-clock da plataforma. Isso não é só lentidão: o claim em
  // ai_processing_log (gates.ts) já foi gravado e não tem TTL nem delete, então
  // o isolate morto deixa a mensagem de áudio do cliente sem resposta para
  // sempre — sem handoff, sem rastro.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(audioUrl, {
        headers: opts.authorization ? { Authorization: opts.authorization } : undefined,
        signal: controller.signal,
        redirect: "error",
      });
    } catch (e) {
      throw new VoiceError(
        `Falha ao baixar o áudio: ${e instanceof Error ? e.message : "erro de rede"}`,
        "download",
      );
    }

    if (!res.ok) {
      throw new VoiceError(
        `Provider devolveu ${res.status} ao baixar o áudio.`,
        "download",
        res.status,
      );
    }

    // Content-Length é dica, não garantia — ausente em chunked, e mentível.
    // Serve só para recusar cedo o que já se declara grande demais.
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES) {
      throw new VoiceError(`Áudio grande demais (${declared} bytes).`, "download");
    }

    const buf = await readCapped(res, MAX_AUDIO_BYTES);
    if (buf.byteLength === 0) throw new VoiceError("Áudio vazio.", "download");

    const declaredMime = (res.headers.get("content-type") ?? opts.fallbackMime ?? "audio/ogg")
      .split(";")[0]
      .trim();
    // Provedor de WhatsApp entrega nota de voz como `application/octet-stream`
    // — genérico, não errado. Recusar pelo MIME declarado derrubava TODA
    // transcrição em produção (2026-08-04: "MIME de áudio inválido:
    // application/octet-stream", seguido de handoff por transcription_failed).
    //
    // Quando o cabeçalho não diz `audio/`, os bytes dizem: o formato real vem
    // da assinatura do arquivo. Se nem isso identificar áudio, aí sim é recusa
    // — a guarda continua existindo, só deixou de confiar em quem declara.
    const mime = isAudioMime(declaredMime) ? declaredMime : (sniffAudioMime(buf) ?? declaredMime);
    if (!isAudioMime(mime)) {
      // Caso nomeado: WhatsApp nativo (Zappaz e similares) entrega a mídia
      // ainda cifrada pelo protocolo Baileys — ver isEncryptedWhatsAppMediaUrl.
      // Falha igual (handoff continua acontecendo), mas o motivo registrado
      // deixa de mentir "MIME inválido" e vira "sabemos o que é, não
      // decodificamos ainda", pra não mascarar um gap de suporte como bug de
      // parsing.
      if (isEncryptedWhatsAppMediaUrl(audioUrl)) {
        throw new VoiceError(
          "Áudio do WhatsApp chegou cifrado (mídia .enc da CDN whatsapp.net, protocolo Baileys) — " +
            "este provedor não descriptografa antes de repassar e a transcrição ainda não suporta " +
            `esse formato. MIME declarado: ${declaredMime || "ausente"}, ${buf.byteLength} bytes, ` +
            `primeiros bytes ${hexPreview(buf)}.`,
          "download",
        );
      }
      throw new VoiceError(
        `MIME de áudio inválido: ${declaredMime || "ausente"} ` +
          `(${buf.byteLength} bytes, assinatura não reconhecida, primeiros bytes ${hexPreview(buf)}).`,
        "download",
      );
    }
    return { bytes: buf, mime };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Lê o corpo em stream, abortando ao passar de `max`.
 *
 * `res.arrayBuffer()` bufferiza TUDO antes de qualquer checagem de tamanho: com
 * `transfer-encoding: chunked` (sem content-length) um host hostil manda o que
 * quiser e estoura a memória do isolate antes de existir um `byteLength` para
 * comparar. Aqui o teto é aplicado durante a leitura.
 */
async function readCapped(res: Response, max: number): Promise<ArrayBuffer> {
  const reader = res.body?.getReader();
  if (!reader) return await res.arrayBuffer();

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new VoiceError(`Áudio grande demais (acima de ${max} bytes).`, "download");
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer as ArrayBuffer;
}

/**
 * Transcreve o áudio de `audioUrl`. Devolve o texto já trimado.
 *
 * `tag_audio_events` vai FALSE de propósito: o default da API é true e
 * injetaria "(laughter)", "(footsteps)" no meio da fala — que aqui vira input
 * de LLM, não legenda. `timestamps_granularity: none` corta payload que não
 * usamos.
 */
export async function transcribeAudio(
  apiKey: string,
  audioUrl: string,
  opts: { languageCode?: string } = {},
): Promise<string> {
  const { bytes, mime } = await downloadAudio(audioUrl);

  const form = new FormData();
  form.append("model_id", STT_MODEL_ID);
  form.append("file", new Blob([bytes], { type: mime }), "audio");
  form.append("tag_audio_events", "false");
  form.append("timestamps_granularity", "none");
  if (opts.languageCode) form.append("language_code", opts.languageCode);

  return await sendTranscription(apiKey, form);
}

async function sendTranscription(apiKey: string, form: FormData): Promise<string> {
  // O timer cobre o CORPO, não só os headers -- mesmo padrão de downloadAudio e
  // synthesizeSpeech. `fetch` resolve assim que os headers chegam; com o
  // clearTimeout num finally colado no fetch, tanto o `res.text()` do ramo de
  // erro quanto o `res.json()` do caminho feliz liam o corpo SEM AbortSignal
  // ativo, e um host que segura o corpo travava a função até o wall-clock da
  // plataforma. Isso queima o TTL de 90s do lock de conversa com o claim em
  // ai_processing_log (gates.ts) já gravado e sem TTL nem delete: o áudio
  // daquele lead nunca mais é reprocessado.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STT_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(`${ELEVENLABS_BASE}/speech-to-text`, {
        method: "POST",
        headers: { "xi-api-key": apiKey },
        body: form,
        signal: controller.signal,
      });
    } catch (e) {
      throw new VoiceError(
        `Falha na chamada de transcrição: ${e instanceof Error ? e.message : "erro de rede"}`,
        "transcribe",
      );
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new VoiceError(
        `ElevenLabs recusou a transcrição (HTTP ${res.status}).${
          detail ? ` ${detail.slice(0, 200)}` : ""
        }`,
        "transcribe",
        res.status,
      );
    }

    const data = (await res.json().catch(() => null)) as { text?: unknown } | null;
    const text = typeof data?.text === "string" ? data.text.trim() : "";
    if (!text) throw new VoiceError("Transcrição voltou vazia.", "transcribe", res.status);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export async function transcribeMetaCloudAudio(
  elevenLabsApiKey: string,
  metaAccessToken: string,
  mediaReference: string,
  opts: { languageCode?: string; phoneNumberId?: string } = {},
): Promise<string> {
  const media = await resolveMetaCloudMediaUrl(
    metaAccessToken,
    mediaReference,
    opts.phoneNumberId,
  );
  const { bytes, mime } = await downloadAudio(media.url, {
    authorization: `Bearer ${metaAccessToken}`,
    allowedHosts: META_MEDIA_DOWNLOAD_HOSTS,
    fallbackMime: media.mime,
  });

  const form = new FormData();
  form.append("model_id", STT_MODEL_ID);
  form.append("file", new Blob([bytes], { type: mime }), "audio");
  form.append("tag_audio_events", "false");
  form.append("timestamps_granularity", "none");
  if (opts.languageCode) form.append("language_code", opts.languageCode);

  return await sendTranscription(elevenLabsApiKey, form);
}

/**
 * A ElevenLabs devolve HTTP 402 (`payment_required`) cru e em inglês quando a
 * voz escolhida é da biblioteca da plataforma e exige plano pago — o texto
 * ia direto para reason_detail em channel_status_events sem tradução
 * (achado do plano de observabilidade, 2026-08-04; reincidência de
 * `erro-ingles-vaza-na-ui-de-integracoes` em caminho novo). Detecta pelo
 * `code` do corpo estruturado da própria ElevenLabs — NUNCA por substring da
 * mensagem em inglês, que muda sem aviso — e cai num PT-BR genérico para
 * qualquer outro 402 sem esse `code` específico.
 */
function describeElevenLabsPaymentError(status: number, bodyText: string): string | null {
  if (status !== 402) return null;
  let code: unknown;
  try {
    code = (JSON.parse(bodyText) as { detail?: { code?: unknown } } | null)?.detail?.code;
  } catch {
    code = undefined;
  }
  if (code === "paid_plan_required") {
    return "A voz escolhida é da biblioteca da ElevenLabs e exige plano pago. Escolha uma voz `premade` nas configurações de voz.";
  }
  return "A ElevenLabs recusou a síntese por restrição do plano da conta (HTTP 402). Verifique o plano da conta ou escolha uma voz `premade`.";
}

/**
 * Gera áudio a partir de `text`. Devolve os bytes e o MIME correspondente.
 *
 * Diferente do STT, esta resposta NÃO é JSON — é o arquivo. Ler com .json()
 * aqui devolveria lixo silenciosamente.
 */
export async function synthesizeSpeech(
  apiKey: string,
  voiceId: string,
  text: string,
  opts: { timeoutMs?: number; modelId?: string } = {},
): Promise<{ bytes: ArrayBuffer; mime: string }> {
  const clean = text.trim();
  if (!clean) throw new VoiceError("Texto vazio para sintetizar.", "synthesize");
  if (clean.length > TTS_MAX_CHARS) {
    throw new VoiceError(
      `Texto acima do teto de ${TTS_MAX_CHARS} caracteres (${clean.length}).`,
      "synthesize",
    );
  }

  const url = `${ELEVENLABS_BASE}/text-to-speech/${
    encodeURIComponent(voiceId)
  }?output_format=${TTS_OUTPUT_FORMAT}`;

  // Era o único dos três fetch deste módulo sem timeout, contrariando o
  // orçamento de tempo declarado no cabeçalho. A síntese roda DENTRO do lock de
  // conversa (finalizeAiReply acontece antes do releaseLock em ai-respond), e o
  // claim em ai_processing_log não tem TTL nem delete: ElevenLabs travada segura
  // o isolate até a plataforma matá-lo, e a mensagem fica sem resposta para
  // sempre. Como no download, o timer cobre também a leitura do corpo — o fetch
  // resolve nos headers, e os bytes do áudio vêm depois.
  const controller = new AbortController();
  const timeoutMs = Math.max(1, opts.timeoutMs ?? AI_TTS_TOTAL_BUDGET_MS);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "xi-api-key": apiKey, "content-type": "application/json" },
        // O modelo é escolhido pelo tenant na tela da integração; sem escolha,
        // cai no multilingue (cobre PT-BR sem `language_code`).
        body: JSON.stringify({
          text: clean,
          model_id: normalizeTtsModel(opts.modelId) ?? TTS_MODEL_ID,
        }),
        signal: controller.signal,
      });
    } catch (e) {
      throw new VoiceError(
        `Falha na chamada de síntese: ${e instanceof Error ? e.message : "erro de rede"}`,
        "synthesize",
      );
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const paymentMessage = describeElevenLabsPaymentError(res.status, detail);
      if (paymentMessage) {
        throw new VoiceError(paymentMessage, "synthesize", res.status);
      }
      throw new VoiceError(
        `ElevenLabs recusou a síntese (HTTP ${res.status}).${
          detail ? ` ${detail.slice(0, 200)}` : ""
        }`,
        "synthesize",
        res.status,
      );
    }

    const bytes = await readCapped(res, MAX_AUDIO_BYTES);
    if (bytes.byteLength === 0) {
      throw new VoiceError("Áudio sintetizado vazio.", "synthesize", res.status);
    }
    return { bytes, mime: "audio/mpeg" };
  } finally {
    clearTimeout(timer);
  }
}

/** `true` quando o MIME persistido em messages.media_type é de áudio. */
export function isAudioMedia(mediaType: string | null | undefined): boolean {
  return String(mediaType ?? "")
    .trim()
    .toLowerCase()
    .startsWith("audio/");
}

// -------------------- Preferência de voz do tenant --------------------

export type VoiceReplyMode = "off" | "on_audio" | "always";

export interface VoiceReplyPreference {
  mode: VoiceReplyMode;
  voiceId: string | null;
  /** Modelo TTS escolhido pelo tenant; `null` = usar o default do módulo. */
  modelId: string | null;
}

export type VoiceSynthesisConfiguration = Pick<VoiceReplyPreference, "voiceId" | "modelId">;

const VOICE_OFF: VoiceReplyPreference = { mode: "off", voiceId: null, modelId: null };

/**
 * Modelos TTS aceitos. Allowlist, não texto livre: `model_id` vai direto para a
 * API da ElevenLabs, e um valor inválido só falharia na hora de responder o
 * lead — tarde demais.
 */
export const TTS_MODELS = [
  "eleven_multilingual_v2",
  "eleven_turbo_v2_5",
  "eleven_turbo_v2",
  "eleven_flash_v2_5",
  "eleven_monolingual_v1",
] as const;

export function normalizeTtsModel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return (TTS_MODELS as readonly string[]).includes(v) ? v : null;
}

/**
 * Lê somente a voz usada para sintetizar áudio, sem aplicar a preferência de
 * resposta automática. O diagnóstico manual precisa conseguir testar uma voz
 * salva mesmo quando o tenant decidiu manter respostas automáticas em texto.
 */
export async function loadVoiceSynthesisConfiguration(
  admin: SupabaseClient,
  tenantId: string,
): Promise<VoiceSynthesisConfiguration> {
  const empty: VoiceSynthesisConfiguration = { voiceId: null, modelId: null };
  try {
    const { data, error } = await admin
      .from("ai_settings")
      .select("voice_id, voice_model")
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (error) {
      console.error(
        `[voice] falha ao ler configuração de síntese: tenant=${tenantId} code=${error.code ?? "?"} ${error.message}`,
      );
      return empty;
    }
    if (!data) return empty;
    const row = data as { voice_id?: unknown; voice_model?: unknown };
    return {
      voiceId: typeof row.voice_id === "string" && row.voice_id.trim() ? row.voice_id.trim() : null,
      modelId: normalizeTtsModel(row.voice_model),
    };
  } catch (e) {
    console.error(
      `[voice] exceção ao ler configuração de síntese: tenant=${tenantId} ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return empty;
  }
}

/**
 * Lê ai_settings.voice_reply_mode/voice_id (migration 20260727120000).
 *
 * TOLERANTE A FALHA DE PROPÓSITO: se as colunas ainda não existirem no banco
 * (migration versionada mas não aplicada), o PostgREST devolve 42703 e esta
 * função cai em "off" em vez de propagar. Assim o ai-respond continua
 * respondendo em texto num ambiente sem a migration, em vez de quebrar para
 * todo mundo. É o motivo de NÃO ter juntado estas colunas ao select de
 * ensureAiSettings, que está no caminho crítico.
 */
export async function loadVoiceReplyPreference(
  admin: SupabaseClient,
  tenantId: string,
): Promise<VoiceReplyPreference> {
  try {
    const { data, error } = await admin
      .from("ai_settings")
      .select("voice_reply_mode, voice_id, voice_model")
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (error) {
      // 42703 = coluna inexistente. É o ÚNICO erro que esta função tolera em
      // silêncio, porque é exatamente o cenário que ela existe para cobrir
      // (migration versionada e ainda não aplicada).
      if (error.code === "42703") {
        console.warn(
          `[voice] colunas de voz ausentes (migration não aplicada), respondendo em texto: tenant=${tenantId}`,
        );
        return VOICE_OFF;
      }
      // Qualquer outro erro — RLS, timeout, pool esgotado, 5xx do PostgREST —
      // não pode cair em VOICE_OFF calado: o tenant configurou "sempre em
      // áudio" e passaria a responder em texto para sempre, sem rastro em
      // console, ai_failure_logs ou system_events. Degrada para texto (a
      // resposta é mais importante que o formato), mas deixa registro.
      console.error(
        `[voice] falha ao ler preferência de voz: tenant=${tenantId} code=${
          error.code ?? "?"
        } ${error.message}`,
      );
      await reportAIFailure(admin, {
        tenantId,
        route: "ai-respond",
        errorCode: "UNKNOWN",
        errorMessage: `Falha ao ler preferência de voz: ${error.message}`,
        context: { phase: "voice_preference", pgCode: error.code ?? null },
      });
      return VOICE_OFF;
    }
    // Ausência de linha não é falha: tenant que nunca abriu Configurações.
    if (!data) return VOICE_OFF;
    const row = data as {
      voice_reply_mode?: unknown;
      voice_id?: unknown;
      voice_model?: unknown;
    };
    const mode = row.voice_reply_mode;
    if (mode !== "always" && mode !== "on_audio") return VOICE_OFF;
    const voiceId = typeof row.voice_id === "string" && row.voice_id.trim()
      ? row.voice_id.trim()
      : null;

    // Preferência salva não basta: a integração precisa estar CONECTADA agora.
    // Checagem depois do mode de propósito -- tenant sem voz configurada não
    // paga a query.
    if (!(await isElevenLabsActive(admin, tenantId))) return VOICE_OFF;
    return { mode, voiceId, modelId: normalizeTtsModel(row.voice_model) };
  } catch (e) {
    // catch vazio é proibido pelo CLAUDE.md; sem log, uma exceção aqui some.
    console.error(
      `[voice] exceção ao ler preferência de voz: tenant=${tenantId} ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return VOICE_OFF;
  }
}

/**
 * A integração `elevenlabs` do tenant está conectada AGORA?
 *
 * Sem esta checagem, desconectar não desligava o áudio: `disconnect` marca
 * `tenant_integrations.status='disabled'` e DEIXA a chave em
 * `integration_secrets` (só `forget` apaga), e `loadProviderSecrets` lê os
 * segredos direto, sem olhar o status. O tenant desconectava na UI, o
 * assistente continuava sintetizando e a conta ElevenLabs DELE continuava
 * sendo cobrada. Mesmo critério (`status='active'`) já usado por
 * messaging-send/index.ts e weekly-digest-generator/runner.ts.
 *
 * Integração não-ativa é estado ESPERADO, não falha: `console.info`, sem
 * reportAIFailure -- encher ai_failure_logs de "erro" para todo tenant que
 * desligou a voz de propósito só esconderia falha de verdade. Erro na própria
 * query é outra história: `console.error`, porque degradar calado foi
 * exatamente o bug fechado no commit 42bcd06.
 *
 * Os logs daqui dizem só o FATO (integração inativa / query falhou) e nunca a
 * consequência: cada caller degrada de um jeito. Na resposta (TTS) vira texto;
 * na entrada (STT, ai-respond/index.ts) vira handoff para humano -- escrever
 * "respondendo em texto" aqui mentiria no log de metade dos callers.
 */
export async function isElevenLabsActive(
  admin: SupabaseClient,
  tenantId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("tenant_integrations")
    .select("status")
    .eq("tenant_id", tenantId)
    .eq("slug", "elevenlabs")
    .maybeSingle();
  if (error) {
    console.error(
      `[voice] falha ao checar se a ElevenLabs está ativa (tratando como inativa): tenant=${tenantId} code=${error.code} ${error.message}`,
    );
    return false;
  }
  const status = (data as { status?: unknown } | null)?.status;
  if (status !== "active") {
    console.info(
      `[voice] integração ElevenLabs não está ativa (status=${
        String(status ?? "sem registro")
      }): tenant=${tenantId}`,
    );
    return false;
  }
  return true;
}

/**
 * Decide se ESTA resposta sai em áudio.
 *
 * `voiceId` ausente derruba para texto mesmo com o modo ligado: sem voz
 * escolhida não há o que sintetizar, e é o que a UI avisa em Configurações.
 */
export function shouldReplyWithAudio(
  pref: VoiceReplyPreference,
  inboundWasAudio: boolean,
): boolean {
  if (!pref.voiceId) return false;
  if (pref.mode === "always") return true;
  return pref.mode === "on_audio" && inboundWasAudio;
}
