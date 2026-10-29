// poller.ts — busca na ElevenLabs o estado das Ligações IA em andamento e
// aplica pelo MESMO aplicador dos webhooks (apply_voice_call_event: ledger +
// transição atômica, status só avança, event_id duplicado não reaplica).
// Rodado pelo cron (voice-call-poller, a cada minuto). Sem ligação ativa = 0
// chamadas externas.
import type { VoiceEvent } from "./contract.ts";
import { conversationToEvents, ElevenLabsVoiceProvider } from "./elevenlabs.ts";
import { redactSecrets } from "../redact-secrets.ts";

export interface ActiveCall {
  id: string;
  tenant_id: string;
  provider_call_id: string;
}

export interface PollerDeps {
  listActiveCalls: () => Promise<ActiveCall[]>;
  loadApiKey: (tenantId: string) => Promise<string | null>;
  applyEvent: (event: VoiceEvent) => Promise<{ result: string; status?: string }>;
  fetchImpl?: ElevenLabsVoiceProvider;
}

export interface PollSummary {
  polled: number;
  applied: number;
  errors: string[];
}

export async function pollElevenLabsCalls(deps: PollerDeps): Promise<PollSummary> {
  const calls = await deps.listActiveCalls();
  const summary: PollSummary = { polled: 0, applied: 0, errors: [] };
  const keyByTenant = new Map<string, string | null>();

  for (const call of calls) {
    try {
      if (!keyByTenant.has(call.tenant_id)) {
        keyByTenant.set(call.tenant_id, await deps.loadApiKey(call.tenant_id));
      }
      const apiKey = keyByTenant.get(call.tenant_id);
      if (!apiKey) {
        summary.errors.push(`${call.id}: tenant sem api_key ElevenLabs`);
        continue;
      }
      const client = new ElevenLabsVoiceProvider({ apiKey, agentId: "", phoneNumberId: "" });
      const conv = await client.fetchConversation(call.provider_call_id);
      summary.polled++;
      if (!conv) continue;
      const events = conversationToEvents(conv, {
        callId: call.id,
        tenantId: call.tenant_id,
        conversationId: call.provider_call_id,
      });
      for (const event of events) {
        const r = await deps.applyEvent(event);
        if (r.result === "applied") summary.applied++;
      }
    } catch (err) {
      // Uma ligação com erro não derruba o lote.
      summary.errors.push(`${call.id}: ${redactSecrets(err)}`);
    }
  }
  return summary;
}
