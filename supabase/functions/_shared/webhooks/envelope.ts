// Envelope do payload entregue ao endpoint do cliente.
export const API_VERSION = "2026-10-20";

export interface WebhookEnvelope {
  id: string;
  type: string;
  api_version: string;
  created_at: string;
  tenant_id: string;
  data: unknown;
}

export interface EnvelopeSource {
  id: string;
  type: string;
  tenant_id: string;
  occurred_at: string;
  payload: unknown;
}

export function buildEnvelope(event: EnvelopeSource): WebhookEnvelope {
  return {
    id: event.id,
    type: event.type,
    api_version: API_VERSION,
    created_at: event.occurred_at,
    tenant_id: event.tenant_id,
    data: event.payload,
  };
}
