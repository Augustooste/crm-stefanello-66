export type BillingWebhook = {
  id: string;
  type: string;
  occurredAt: string;
  customerRef?: string;
  subscriptionRef?: string;
  data: Record<string, unknown>;
};

export interface BillingGateway {
  readonly name: string;
  verifyAndParseWebhook(request: Request): Promise<BillingWebhook>;
}

export interface BillingWebhookStore {
  claim(provider: string, event: BillingWebhook): Promise<{ duplicate: boolean }>;
  markProcessed(provider: string, eventId: string): Promise<void>;
  markFailed(provider: string, eventId: string, error: string): Promise<void>;
}

export type BillingWebhookHandler = (event: BillingWebhook) => Promise<void>;

export async function processBillingWebhook(
  gateway: BillingGateway,
  store: BillingWebhookStore,
  request: Request,
  handler: BillingWebhookHandler,
): Promise<{ duplicate: boolean; eventId: string }> {
  const event = await gateway.verifyAndParseWebhook(request);
  if (!event.id || !event.type) throw new Error("Invalid normalized billing webhook");

  const claim = await store.claim(gateway.name, event);
  if (claim.duplicate) return { duplicate: true, eventId: event.id };

  try {
    await handler(event);
    await store.markProcessed(gateway.name, event.id);
    return { duplicate: false, eventId: event.id };
  } catch (error) {
    await store.markFailed(
      gateway.name,
      event.id,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}

/** Adapter determinístico para desenvolvimento e testes; não aceita secrets. */
export class SandboxBillingGateway implements BillingGateway {
  readonly name = "sandbox";

  async verifyAndParseWebhook(request: Request): Promise<BillingWebhook> {
    const payload = (await request.json()) as Partial<BillingWebhook>;
    if (!payload.id || !payload.type) throw new Error("Sandbox webhook requires id and type");
    return {
      id: payload.id,
      type: payload.type,
      occurredAt: payload.occurredAt ?? new Date(0).toISOString(),
      customerRef: payload.customerRef,
      subscriptionRef: payload.subscriptionRef,
      data: payload.data ?? {},
    };
  }
}
