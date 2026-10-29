import { assertEquals, assertRejects } from "jsr:@std/assert";
import {
  dealScope,
  endpointMatches,
  type FanOutClient,
  fanOutToEndpoints,
} from "../_shared/webhooks/fan-out.ts";
import { runDomainEventDispatcher } from "../domain-event-dispatcher/runner.ts";
import type { DomainEventDelivery } from "../_shared/domain-event-runner.ts";

type EndpointRow = {
  id: string;
  tenant_id: string;
  active: boolean;
  event_types: string[];
  board_ids: string[];
  stage_ids: string[];
};
type DeliveryRow = {
  tenant_id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
};

// Colunas reais (migrations 20261020120000 e 20261020160000): coluna fora daqui
// devolve 42703, como o PostgREST. Um mock que aceita qualquer coluna escondeu
// board_stages.tenant_id na v1.
const SCHEMA: Record<string, readonly string[]> = {
  webhook_endpoints: [
    "id",
    "tenant_id",
    "url",
    "description",
    "event_types",
    "vault_secret_id",
    "previous_vault_secret_id",
    "previous_secret_expires_at",
    "active",
    "disabled_reason",
    "created_by",
    "created_at",
    "updated_at",
    "board_ids",
    "stage_ids",
  ],
  webhook_deliveries: [
    "id",
    "tenant_id",
    "endpoint_id",
    "event_id",
    "event_type",
    "status",
    "attempts",
    "max_attempts",
    "available_at",
    "locked_at",
    "locked_by",
    "response_status",
    "response_excerpt",
    "last_error",
    "delivered_at",
    "created_at",
  ],
};

const noFilter = { board_ids: [], stage_ids: [] };
const ENDPOINTS: EndpointRow[] = [
  {
    id: "ep-a",
    tenant_id: "t1",
    active: true,
    event_types: ["deal.won"],
    ...noFilter,
  },
  {
    id: "ep-b",
    tenant_id: "t1",
    active: true,
    event_types: ["deal.won", "deal.lost"],
    ...noFilter,
  },
  {
    id: "ep-off",
    tenant_id: "t1",
    active: false,
    event_types: ["deal.won"],
    ...noFilter,
  },
  {
    id: "ep-other",
    tenant_id: "t2",
    active: true,
    event_types: ["deal.won"],
    ...noFilter,
  },
  {
    id: "ep-nosub",
    tenant_id: "t1",
    active: true,
    event_types: ["contact.created"],
    ...noFilter,
  },
];

function unknownColumn(
  table: string,
  columns: string[],
  schema: Record<string, readonly string[]>,
): string | null {
  const known = schema[table] ?? [];
  return columns.find((c) => !known.includes(c)) ?? null;
}

const missingColumn = (table: string, column: string) => ({
  data: null,
  error: {
    message: `column ${table}.${column} does not exist`,
    code: "42703",
  },
});

// Fake em memória: valida colunas contra SCHEMA, aplica os .eq() e o unique
// (endpoint_id, event_id).
function makeClient(
  endpoints: EndpointRow[] = ENDPOINTS,
  schema: Record<string, readonly string[]> = SCHEMA,
): { client: FanOutClient; deliveries: DeliveryRow[] } {
  const deliveries: DeliveryRow[] = [];
  const client: FanOutClient = {
    from: (table: string) => ({
      select: (columns: string) => {
        const filters: Record<string, unknown> = {};
        const selected = columns.split(",").map((c) => c.trim());
        const builder = {
          eq: (column: string, value: unknown) => {
            filters[column] = value;
            return builder;
          },
          then: ((onfulfilled, onrejected) => {
            const missing = unknownColumn(
              table,
              [...selected, ...Object.keys(filters)],
              schema,
            );
            const result = missing ? missingColumn(table, missing) : {
              data: table === "webhook_endpoints"
                ? endpoints
                  .filter((e) =>
                    Object.entries(filters).every(([k, v]) =>
                      (e as unknown as Record<string, unknown>)[k] === v
                    )
                  )
                  .map((e) =>
                    Object.fromEntries(
                      selected.map((c) => [
                        c,
                        (e as unknown as Record<string, unknown>)[c],
                      ]),
                    )
                  )
                : [],
              error: null,
            };
            return Promise.resolve(result).then(onfulfilled, onrejected);
          }) as PromiseLike<
            { data: unknown; error: { message: string } | null }
          >["then"],
        };
        return builder;
      },
      upsert: (input: Record<string, unknown>[]) => {
        const rows = input as unknown as DeliveryRow[];
        return {
          select: (columns: string) =>
            Promise.resolve().then(() => {
              const missing = unknownColumn(table, [
                ...columns.split(",").map((c) => c.trim()),
                ...input.flatMap((r) => Object.keys(r)),
              ], schema);
              if (missing) return missingColumn(table, missing);
              const inserted = rows.filter((r) =>
                !deliveries.some((d) =>
                  d.endpoint_id === r.endpoint_id && d.event_id === r.event_id
                )
              );
              deliveries.push(...inserted);
              return {
                data: inserted.map((r) => ({
                  id: `${r.endpoint_id}:${r.event_id}`,
                })),
                error: null,
              };
            }),
        };
      },
    }),
  };
  return { client, deliveries };
}

const delivery: DomainEventDelivery = {
  delivery_id: "d1",
  event_id: "e1",
  tenant_id: "t1",
  subscriber_id: "webhook.outbound",
  event_type: "deal.won",
  schema_version: 1,
  aggregate_type: "deal",
  aggregate_id: "a1",
  payload: {},
  metadata: {},
  occurred_at: new Date(0).toISOString(),
  attempts: 1,
  max_attempts: 8,
};

Deno.test("fan-out cria 1 entrega por endpoint ativo do tenant que assina o tipo", async () => {
  const { client, deliveries } = makeClient();
  assertEquals(await fanOutToEndpoints(client, delivery), { created: 2 });
  assertEquals(deliveries.map((d) => d.endpoint_id).sort(), ["ep-a", "ep-b"]);
  assertEquals(deliveries[0].tenant_id, "t1");
  assertEquals(deliveries[0].event_type, "deal.won");
});

Deno.test("fan-out reprocessando o mesmo evento nao cria entregas novas", async () => {
  const { client, deliveries } = makeClient();
  await fanOutToEndpoints(client, delivery);
  assertEquals(await fanOutToEndpoints(client, delivery), { created: 0 });
  assertEquals(deliveries.length, 2);
});

Deno.test("fan-out sem tenant_id nao cria nada e nao falha", async () => {
  const { client, deliveries } = makeClient();
  assertEquals(
    await fanOutToEndpoints(client, { ...delivery, tenant_id: null }),
    { created: 0 },
  );
  assertEquals(deliveries.length, 0);
});

Deno.test("dispatcher roteia webhook.outbound para o fan-out e mantem o projetor nos demais", async () => {
  const { client: fanOutClient, deliveries } = makeClient();
  const projected: string[] = [];
  const mk = (subscriber_id: string) => ({
    rpc: (name: string) =>
      Promise.resolve(
        name === "claim_event_deliveries"
          ? { data: [{ ...delivery, subscriber_id }], error: null }
          : { data: true, error: null },
      ),
    from: () => ({
      upsert: (row: Record<string, unknown>) => {
        projected.push(String(row.subscriber_id));
        return Promise.resolve({ error: null });
      },
    }),
  });
  const web = await runDomainEventDispatcher(
    mk("webhook.outbound"),
    "w1",
    50,
    fanOutClient,
  );
  assertEquals(web, { claimed: 1, delivered: 1, failed: 0 });
  assertEquals(deliveries.length, 2);
  assertEquals(projected, []);
  await runDomainEventDispatcher(
    mk("kernel.projection"),
    "w1",
    50,
    fanOutClient,
  );
  assertEquals(projected, ["kernel.projection"]);
  assertEquals(deliveries.length, 2);
});

Deno.test("assinante desconhecido continua lancando unsupported subscriber", async () => {
  const { createProjectionHandler } = await import(
    "../domain-event-dispatcher/runner.ts"
  );
  const handler = createProjectionHandler(
    {
      rpc: () => Promise.resolve({ data: null, error: null }),
      from: () => ({ upsert: () => Promise.resolve({ error: null }) }),
    },
    makeClient().client,
  );
  await assertRejects(
    () => handler({ ...delivery, subscriber_id: "third-party" }),
    Error,
    "unsupported subscriber third-party",
  );
});

// Cliente do dispatcher que registra as RPCs: prova que a falha do fan-out vira
// fail_event_delivery (retry/dead letter do outbox) e não ack silencioso.
function dispatcherClient() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc: (name: string, args: Record<string, unknown> = {}) => {
      calls.push({ name, args });
      return Promise.resolve(
        name === "claim_event_deliveries"
          ? { data: [{ ...delivery }], error: null }
          : { data: true, error: null },
      );
    },
    from: () => ({ upsert: () => Promise.resolve({ error: null }) }),
  };
  return { client, calls };
}

Deno.test("falha do fan-out vira falha registrada em fail_event_delivery", async () => {
  const { client, calls } = dispatcherClient();
  const broken: FanOutClient = {
    from: () => ({
      select: () => {
        const builder = {
          eq: () => builder,
          then:
            ((ok, bad) =>
              Promise.resolve({ data: null, error: { message: "db fora" } })
                .then(ok, bad)) as PromiseLike<
                { data: unknown; error: { message: string } }
              >["then"],
        };
        return builder;
      },
      upsert: () => ({
        select: () => Promise.resolve({ data: null, error: null }),
      }),
    }),
  };
  const result = await runDomainEventDispatcher(client, "w1", 50, broken);
  assertEquals(result, { claimed: 1, delivered: 0, failed: 1 });
  const names = calls.map((c) => c.name);
  assertEquals(names.includes("fail_event_delivery"), true);
  assertEquals(names.includes("ack_event_delivery"), false);
});

Deno.test("sem fanOutClient o evento webhook.outbound falha (não é confirmado)", async () => {
  const { client, calls } = dispatcherClient();
  const result = await runDomainEventDispatcher(client, "w1", 50);
  assertEquals(result, { claimed: 1, delivered: 0, failed: 1 });
  const names = calls.map((c) => c.name);
  assertEquals(names.includes("fail_event_delivery"), true);
  assertEquals(names.includes("ack_event_delivery"), false);
});

// ---------------------------------------------------------------------------
// v1.1: filtro por funil e etapa (vazio = todos; etapa de destino; só deal.*)
// ---------------------------------------------------------------------------
const FUNIL_A = "b-a";
const FUNIL_B = "b-b";
const PAGO = "s-pago";
const PROPOSTA = "s-proposta";

const wonIn = (boardId: unknown, stageId: unknown) => ({
  deal: { id: "d1", board_id: boardId, stage_id: stageId },
  contact: null,
});
const movedTo = (boardId: unknown, toStageId: unknown) => ({
  history_id: "h1",
  deal_id: "d1",
  from_stage_id: "s-x",
  to_stage_id: toStageId,
  ...(boardId === undefined ? {} : { board_id: boardId }),
});
const ep = (
  board_ids: string[],
  stage_ids: string[],
  event_types = [
    "deal.won",
    "deal.lost",
    "deal.stage_changed",
    "contact.created",
    "webhook.test",
  ],
) => ({ event_types, board_ids, stage_ids });

Deno.test("dealScope: deal.won/lost leem payload.deal; stage_changed le board_id e to_stage_id; outros null", () => {
  assertEquals(dealScope("deal.won", wonIn(FUNIL_A, PAGO)), {
    boardId: FUNIL_A,
    stageId: PAGO,
  });
  assertEquals(dealScope("deal.lost", wonIn(FUNIL_B, PROPOSTA)), {
    boardId: FUNIL_B,
    stageId: PROPOSTA,
  });
  assertEquals(dealScope("deal.stage_changed", movedTo(FUNIL_A, PAGO)), {
    boardId: FUNIL_A,
    stageId: PAGO,
  });
  assertEquals(dealScope("deal.stage_changed", movedTo(undefined, PAGO)), {
    boardId: null,
    stageId: PAGO,
  });
  assertEquals(dealScope("deal.won", { deal: { board_id: 7, stage_id: {} } }), {
    boardId: null,
    stageId: null,
  });
  assertEquals(dealScope("contact.created", { contact_id: "c1" }), null);
  assertEquals(dealScope("webhook.test", { test: true }), null);
});

Deno.test("endpointMatches sem filtro: deal.won de qualquer funil passa", () => {
  assertEquals(
    endpointMatches(ep([], []), "deal.won", wonIn(FUNIL_A, PAGO)),
    true,
  );
  assertEquals(
    endpointMatches(ep([], []), "deal.won", wonIn(FUNIL_B, PROPOSTA)),
    true,
  );
});

Deno.test("endpointMatches por etapa: so a etapa de destino escolhida", () => {
  const pago = ep([], [PAGO]);
  assertEquals(
    endpointMatches(pago, "deal.stage_changed", movedTo(FUNIL_A, PAGO)),
    true,
  );
  assertEquals(
    endpointMatches(pago, "deal.stage_changed", movedTo(FUNIL_A, PROPOSTA)),
    false,
  );
  assertEquals(endpointMatches(pago, "deal.won", wonIn(FUNIL_A, PAGO)), true);
});

Deno.test("endpointMatches por funil: evento de outro funil nao passa", () => {
  const a = ep([FUNIL_A], []);
  assertEquals(
    endpointMatches(a, "deal.lost", wonIn(FUNIL_B, PROPOSTA)),
    false,
  );
  assertEquals(endpointMatches(a, "deal.lost", wonIn(FUNIL_A, PROPOSTA)), true);
});

Deno.test("endpointMatches funil e etapa: exige os dois", () => {
  const both = ep([FUNIL_A], [PAGO]);
  assertEquals(endpointMatches(both, "deal.won", wonIn(FUNIL_A, PAGO)), true);
  assertEquals(
    endpointMatches(both, "deal.won", wonIn(FUNIL_A, PROPOSTA)),
    false,
  );
  assertEquals(endpointMatches(both, "deal.won", wonIn(FUNIL_B, PAGO)), false);
});

Deno.test("endpointMatches falha fechada: stage_changed antigo sem board_id nao passa com filtro de funil", () => {
  assertEquals(
    endpointMatches(
      ep([FUNIL_A], []),
      "deal.stage_changed",
      movedTo(undefined, PAGO),
    ),
    false,
  );
  // sem filtro de funil, o evento antigo segue entregue
  assertEquals(
    endpointMatches(ep([], []), "deal.stage_changed", movedTo(undefined, PAGO)),
    true,
  );
});

Deno.test("endpointMatches falha fechada: board_id ou stage_id que nao e string nao passa com filtro", () => {
  assertEquals(
    endpointMatches(ep([FUNIL_A], []), "deal.won", wonIn(42, PAGO)),
    false,
  );
  assertEquals(
    endpointMatches(
      ep([FUNIL_A], []),
      "deal.won",
      wonIn({ id: FUNIL_A }, PAGO),
    ),
    false,
  );
  assertEquals(
    endpointMatches(ep([], [PAGO]), "deal.won", wonIn(FUNIL_A, null)),
    false,
  );
  assertEquals(
    endpointMatches(ep([FUNIL_A], []), "deal.won", { deal: null }),
    false,
  );
});

Deno.test("endpointMatches: contact.created e webhook.test ignoram o filtro, mas respeitam event_types", () => {
  const filtered = ep([FUNIL_A], [PAGO]);
  assertEquals(
    endpointMatches(filtered, "contact.created", { contact_id: "c1" }),
    true,
  );
  assertEquals(endpointMatches(filtered, "webhook.test", { test: true }), true);
  assertEquals(
    endpointMatches(ep([FUNIL_A], [PAGO], ["deal.won"]), "contact.created", {}),
    false,
  );
});

Deno.test("endpointMatches falha fechada: linha sem arrays de filtro (coluna ausente) nao recebe evento de negocio", () => {
  const broken = { event_types: ["deal.won"] } as unknown as Parameters<
    typeof endpointMatches
  >[0];
  assertEquals(
    endpointMatches(broken, "deal.won", wonIn(FUNIL_A, PAGO)),
    false,
  );
});

Deno.test("fan-out aplica o filtro: so o endpoint da etapa Pago recebe; sem filtro recebe tudo", async () => {
  const endpoints: EndpointRow[] = [
    {
      id: "ep-pago",
      tenant_id: "t1",
      active: true,
      event_types: ["deal.stage_changed"],
      board_ids: [FUNIL_A],
      stage_ids: [PAGO],
    },
    {
      id: "ep-all",
      tenant_id: "t1",
      active: true,
      event_types: ["deal.stage_changed"],
      board_ids: [],
      stage_ids: [],
    },
    {
      id: "ep-b",
      tenant_id: "t1",
      active: true,
      event_types: ["deal.stage_changed"],
      board_ids: [FUNIL_B],
      stage_ids: [],
    },
  ];
  const { client, deliveries } = makeClient(endpoints);
  const evt = {
    ...delivery,
    event_type: "deal.stage_changed",
    payload: movedTo(FUNIL_A, PROPOSTA),
  };
  assertEquals(await fanOutToEndpoints(client, evt), { created: 1 });
  assertEquals(deliveries.map((d) => d.endpoint_id), ["ep-all"]);
  const toPago = { ...evt, event_id: "e2", payload: movedTo(FUNIL_A, PAGO) };
  assertEquals(await fanOutToEndpoints(client, toPago), { created: 2 });
  assertEquals(
    deliveries.filter((d) => d.event_id === "e2").map((d) => d.endpoint_id)
      .sort(),
    ["ep-all", "ep-pago"],
  );
});

Deno.test("fan-out com schema sem board_ids devolve 42703 e falha (nunca entrega a todos)", async () => {
  const oldSchema = {
    ...SCHEMA,
    webhook_endpoints: SCHEMA.webhook_endpoints.filter((c) =>
      c !== "board_ids"
    ),
  };
  const { client, deliveries } = makeClient(ENDPOINTS, oldSchema);
  await assertRejects(
    () => fanOutToEndpoints(client, delivery),
    Error,
    "webhook_endpoints.board_ids does not exist",
  );
  assertEquals(deliveries.length, 0);
});

Deno.test("fan-out com schema sem board_ids vira fail_event_delivery no dispatcher", async () => {
  const { client, calls } = dispatcherClient();
  const oldSchema = {
    ...SCHEMA,
    webhook_endpoints: SCHEMA.webhook_endpoints.filter((c) =>
      c !== "board_ids"
    ),
  };
  const result = await runDomainEventDispatcher(
    client,
    "w1",
    50,
    makeClient(ENDPOINTS, oldSchema).client,
  );
  assertEquals(result, { claimed: 1, delivered: 0, failed: 1 });
  assertEquals(calls.map((c) => c.name).includes("fail_event_delivery"), true);
});
