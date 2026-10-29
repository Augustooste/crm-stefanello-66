// voice-catalog.ts — listagem das vozes da conta ElevenLabs.
//
// Contrato oficial (docs eleven-api): GET /v1/voices com header `xi-api-key`
// devolve `{ voices: [{ voice_id, name, category, description, preview_url,
// labels: { gender, accent, language, use_case, ... } }] }`.
//
// Só campos seguros atravessam para o frontend — a api_key nunca sai daqui.

const ELEVENLABS_VOICES_URL = "https://api.elevenlabs.io/v1/voices";
const LIST_TIMEOUT_MS = 15_000;

export type VoiceGender = "feminina" | "masculina" | "neutra";

export interface CatalogVoice {
  voice_id: string;
  name: string;
  gender: VoiceGender;
  accent: string | null;
  language: string | null;
  category: string | null;
  description: string | null;
  preview_url: string | null;
}

export interface ListVoicesResult {
  ok: boolean;
  voices?: CatalogVoice[];
  error?: string;
}

/** `labels.gender` vem em inglês e varia (female/male/non-binary/neutral). */
export function normalizeGender(raw: unknown): VoiceGender {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (v.startsWith("f") || v === "woman" || v === "feminina") return "feminina";
  if (v.startsWith("m") || v === "man" || v === "masculina") return "masculina";
  return "neutra";
}

function str(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length > 0 ? s : null;
}

/** Só aceitamos prévia servida por HTTPS da CDN da própria ElevenLabs. */
function safePreviewUrl(v: unknown): string | null {
  const raw = str(v);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    if (!/(^|\.)elevenlabs\.io$/.test(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function mapVoice(raw: unknown): CatalogVoice | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const id = str(v.voice_id);
  if (!id) return null;
  const labels = (v.labels && typeof v.labels === "object" ? v.labels : {}) as Record<
    string,
    unknown
  >;
  return {
    voice_id: id,
    name: str(v.name) ?? id,
    gender: normalizeGender(labels.gender),
    accent: str(labels.accent),
    language: str(labels.language) ?? str(labels.languages),
    category: str(v.category),
    description: str(v.description),
    preview_url: safePreviewUrl(v.preview_url),
  };
}

/**
 * Lê as vozes da conta. Nunca lança: erros viram `{ ok:false, error }` em
 * PT-BR, porque a resposta vai direto para um modal de admin leigo.
 */
export async function fetchElevenLabsVoices(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ListVoicesResult> {
  const key = apiKey.trim();
  if (!key) {
    return {
      ok: false,
      error: "ElevenLabs não está conectada. Salve a chave de API antes de escolher a voz.",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIST_TIMEOUT_MS);
  try {
    const r = await fetchImpl(ELEVENLABS_VOICES_URL, {
      headers: { "xi-api-key": key, accept: "application/json" },
      signal: controller.signal,
    });

    if (r.status === 401 || r.status === 403) {
      return {
        ok: false,
        error:
          "A ElevenLabs recusou a chave de API. Gere uma nova chave com permissão de Text to Speech e reconecte a integração.",
      };
    }
    if (r.status === 429) {
      return {
        ok: false,
        error: "A ElevenLabs limitou as requisições agora há pouco. Tente de novo em instantes.",
      };
    }
    if (!r.ok) {
      return {
        ok: false,
        error: `A ElevenLabs respondeu com erro ${r.status} ao listar as vozes. Tente de novo em instantes.`,
      };
    }

    const data = (await r.json().catch(() => null)) as { voices?: unknown } | null;
    const list = Array.isArray(data?.voices) ? data!.voices : [];
    const voices = list
      .map(mapVoice)
      .filter((v): v is CatalogVoice => v !== null)
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

    if (voices.length === 0) {
      return {
        ok: false,
        error:
          "Nenhuma voz encontrada nesta conta ElevenLabs. Adicione uma voz em Minhas Vozes e recarregue a lista.",
      };
    }
    return { ok: true, voices };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return {
      ok: false,
      error: aborted
        ? "A ElevenLabs demorou demais para responder. Tente recarregar a lista."
        : "Não foi possível falar com a ElevenLabs agora. Verifique a conexão e tente de novo.",
    };
  } finally {
    clearTimeout(timer);
  }
}
