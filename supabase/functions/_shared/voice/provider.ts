// provider.ts — porta entre o CRM e quem executa a ligação.
//
// O domínio (voice_calls, timeline, resultado) só conhece `VoiceProvider`.
// Implementações:
//   - HttpVoiceServiceProvider: fala o contrato v1 com o Voice Service externo
//     (que por sua vez usa Twilio, ElevenLabs ou outro -- decisão ainda aberta).
//   - MockVoiceProvider: simula created/ringing/answered/completed (ou falhas)
//     sem telefonar. Só ativo com VOICE_PROVIDER=mock explícito.
//   - ElevenLabsVoiceProvider (elevenlabs.ts): agente ElevenLabs ligando por
//     número Twilio importado; configurado por tenant (tenant_integrations).
// Nenhum SDK de provedor entra aqui.
import {
  CONTRACT_VERSION,
  type CreateCallRequest,
  SIGNATURE_HEADER,
  signPayload,
  TENANT_HEADER,
  TIMESTAMP_HEADER,
  type VoiceEvent,
} from "./contract.ts";
import { redactSecrets } from "../redact-secrets.ts";

export type CreateCallResult =
  | { kind: "accepted"; provider: string; providerCallId: string; simulation: boolean }
  /** O Voice Service disse que NÃO criou a ligação. Seguro marcar failed. */
  | { kind: "rejected"; error: string }
  /** Sem resposta (timeout/rede): a ligação PODE ter sido criada. Não reenviar. */
  | { kind: "uncertain"; error: string };

export type CancelCallResult = { ok: true } | { ok: false; error: string };

export interface VoiceProvider {
  readonly name: string;
  createCall(req: CreateCallRequest): Promise<CreateCallResult>;
  cancelCall(
    ref: { tenantId: string; callId: string; providerCallId: string },
  ): Promise<CancelCallResult>;
  getCall(
    ref: { tenantId: string; callId: string; providerCallId: string },
  ): Promise<{ status: string } | null>;
}

export const VOICE_REQUEST_TIMEOUT_MS = 10_000;

export class HttpVoiceServiceProvider implements VoiceProvider {
  readonly name = "voice-service";
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly timeoutMs = VOICE_REQUEST_TIMEOUT_MS,
  ) {}

  private async post(path: string, tenantId: string, payload: unknown): Promise<Response> {
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    return await fetch(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [TIMESTAMP_HEADER]: timestamp,
        [TENANT_HEADER]: tenantId,
        [SIGNATURE_HEADER]: await signPayload(this.secret, tenantId, timestamp, body),
      },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  async createCall(req: CreateCallRequest): Promise<CreateCallResult> {
    let res: Response;
    try {
      res = await this.post(`/${CONTRACT_VERSION}/calls`, req.tenant_id, req);
    } catch (err) {
      // Timeout ou queda depois de enviar: resultado desconhecido.
      return { kind: "uncertain", error: `Voice Service sem resposta: ${redactSecrets(err)}` };
    }
    if (!res.ok) {
      const text = redactSecrets(await res.text().catch(() => "")).slice(0, 300);
      // Contrato: 4xx e 503 = "não criei". Outros 5xx = incerto.
      if ((res.status >= 400 && res.status < 500) || res.status === 503) {
        return {
          kind: "rejected",
          error: `Voice Service recusou (HTTP ${res.status}). ${text}`.trim(),
        };
      }
      return { kind: "uncertain", error: `Voice Service HTTP ${res.status}. ${text}`.trim() };
    }
    const data = (await res.json().catch(() => null)) as
      | { provider?: unknown; provider_call_id?: unknown }
      | null;
    if (!data || typeof data.provider_call_id !== "string" || !data.provider_call_id) {
      return { kind: "uncertain", error: "Voice Service respondeu sem provider_call_id." };
    }
    return {
      kind: "accepted",
      provider: typeof data.provider === "string" && data.provider
        ? data.provider
        : "voice-service",
      providerCallId: data.provider_call_id,
      simulation: false,
    };
  }

  async cancelCall(
    ref: { tenantId: string; callId: string; providerCallId: string },
  ): Promise<CancelCallResult> {
    try {
      const res = await this.post(
        `/${CONTRACT_VERSION}/calls/${encodeURIComponent(ref.callId)}/cancel`,
        ref.tenantId,
        {
          call_id: ref.callId,
          tenant_id: ref.tenantId,
          provider_call_id: ref.providerCallId,
        },
      );
      return res.ok
        ? { ok: true }
        : { ok: false, error: `Voice Service HTTP ${res.status} ao cancelar.` };
    } catch (err) {
      return { ok: false, error: `Voice Service sem resposta ao cancelar: ${redactSecrets(err)}` };
    }
  }

  getCall(): Promise<{ status: string } | null> {
    // Reconciliação por consulta fica para quando houver Voice Service real;
    // hoje o estado chega só por evento assinado.
    return Promise.resolve(null);
  }
}

export type MockScenario = "completed" | "no_answer" | "busy" | "failed";

/** Simula a ligação inteira sem rede. Eventos seguem o mesmo contrato v1. */
export class MockVoiceProvider implements VoiceProvider {
  readonly name = "mock";
  constructor(private readonly scenario: MockScenario = "completed") {}

  createCall(req: CreateCallRequest): Promise<CreateCallResult> {
    return Promise.resolve({
      kind: "accepted",
      provider: "mock",
      providerCallId: `mock-${req.call_id}`,
      simulation: true,
    });
  }

  cancelCall(): Promise<CancelCallResult> {
    return Promise.resolve({ ok: true });
  }

  getCall(): Promise<{ status: string } | null> {
    return Promise.resolve(null);
  }

  /** Sequência de eventos que um Voice Service real mandaria para esta ligação. */
  simulateEvents(req: { call_id: string; tenant_id: string }, start = Date.now()): VoiceEvent[] {
    const base = {
      version: CONTRACT_VERSION,
      call_id: req.call_id,
      tenant_id: req.tenant_id,
      provider_call_id: `mock-${req.call_id}`,
    } as const;
    const at = (s: number) => new Date(start + s * 1000).toISOString();
    const ev = (
      n: number,
      type: VoiceEvent["type"],
      s: number,
      extra: Partial<VoiceEvent> = {},
    ): VoiceEvent => ({
      ...base,
      event_id: `mock-${req.call_id}-${n}`,
      type,
      occurred_at: at(s),
      ...extra,
    });
    const created = ev(1, "call.created", 0);
    const ringing = ev(2, "call.ringing", 2);
    if (this.scenario !== "completed") {
      return [
        created,
        ringing,
        ev(3, "call.failed", 30, {
          data: { reason: this.scenario, message: "[SIMULAÇÃO] ligação não completada." },
        }),
      ];
    }
    return [
      created,
      ringing,
      ev(3, "call.answered", 8),
      ev(4, "call.completed", 60, { data: { duration_seconds: 52, outcome: "interested" } }),
      ev(5, "call.transcript.updated", 61, {
        sequence: 1,
        data: {
          transcript: "[SIMULAÇÃO] Agente: Olá! Lead: Tenho interesse, pode me mandar a proposta.",
        },
      }),
      ev(6, "call.summary.ready", 62, {
        sequence: 1,
        data: {
          summary: "[SIMULAÇÃO] Lead demonstrou interesse e pediu proposta por WhatsApp.",
          outcome: "interested",
        },
      }),
    ];
  }
}

export type ProviderResolution =
  | { ok: true; provider: VoiceProvider }
  | { ok: false; error: string };

/**
 * Fail-closed: sem configuração, NÃO existe ligação. O mock só entra com
 * VOICE_PROVIDER=mock explícito -- nunca como fallback.
 */
export function resolveVoiceProvider(
  env: (name: string) => string | undefined,
): ProviderResolution {
  const mode = (env("VOICE_PROVIDER") ?? "").trim();
  if (mode === "mock") {
    const scenario = (env("VOICE_MOCK_SCENARIO") ?? "completed").trim() as MockScenario;
    const valid: MockScenario[] = ["completed", "no_answer", "busy", "failed"];
    return {
      ok: true,
      provider: new MockVoiceProvider(valid.includes(scenario) ? scenario : "completed"),
    };
  }
  if (mode === "voice-service") {
    const url = (env("VOICE_SERVICE_URL") ?? "").trim();
    const secret = (env("VOICE_SERVICE_SECRET") ?? "").trim();
    if (!url.startsWith("https://") || !secret) {
      return {
        ok: false,
        error: "Ligações IA não configuradas (VOICE_SERVICE_URL/VOICE_SERVICE_SECRET).",
      };
    }
    return { ok: true, provider: new HttpVoiceServiceProvider(url, secret) };
  }
  return { ok: false, error: "Ligações IA não configuradas." };
}

/** Configuração de voz do tenant (public.voice_call_settings + api_key). */
export interface TenantVoiceSettings {
  apiKey: string | null;
  agentId: string | null;
  phoneNumberId: string | null;
}

/**
 * Env global (VOICE_PROVIDER) continua sendo override de teste/mock. Sem ele,
 * o tenant usa ElevenLabs se tiver integração ativa, chave, agente e número
 * configurados. Qualquer peça faltando = não configurado (fail-closed).
 */
export async function resolveProviderForTenant(
  env: (name: string) => string | undefined,
  settings: TenantVoiceSettings | null,
): Promise<ProviderResolution> {
  if ((env("VOICE_PROVIDER") ?? "").trim()) return resolveVoiceProvider(env);
  if (!settings?.apiKey || !settings.agentId || !settings.phoneNumberId) {
    return {
      ok: false,
      error: "Ligações IA não configuradas: falta agente ou número ElevenLabs para esta empresa.",
    };
  }
  const { ElevenLabsVoiceProvider } = await import("./elevenlabs.ts");
  return {
    ok: true,
    provider: new ElevenLabsVoiceProvider({
      apiKey: settings.apiKey,
      agentId: settings.agentId,
      phoneNumberId: settings.phoneNumberId,
    }),
  };
}
