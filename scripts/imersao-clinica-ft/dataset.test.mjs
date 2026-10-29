import assert from "node:assert/strict";
import test from "node:test";
import { buildDataset, changedFields, seedId, uuidV5, STAGE_NAMES, RUN_KEY } from "./dataset.mjs";
import { ownsRow, parseArguments } from "./seed.mjs";
import { deleteFilter } from "./cleanup.mjs";

const tenantId = "b654e9d9-917c-411c-96f0-e60c1a925ab7";
const context = {
  tenantId,
  profileId: "a9461d23-2042-434e-9d67-d00bdb5162bd",
  boardId: "f53d08ac-d0e6-4119-aefb-5bc4f4e91f1d",
  stages: STAGE_NAMES.map((name, index) => ({
    name,
    id: seedId(tenantId, "board_stages", String(index)),
  })),
  providerSlug: "simulator",
};

test("UUID v5 corresponde ao vetor público do RFC 9562", () => {
  assert.equal(
    uuidV5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"),
    "2ed6657d-e927-568b-95e1-2665a8aea6a2",
  );
});

test("IDs não colidem entre tenants nem tabelas", () => {
  assert.equal(
    new Set([
      seedId(tenantId, "contacts", "mariana-lopes"),
      seedId(tenantId, "deals", "mariana-lopes"),
      seedId(context.profileId, "contacts", "mariana-lopes"),
    ]).size,
    3,
  );
});

test("compare-and-skip ignora ordem de JSON, timezone equivalente e carimbos do banco", () => {
  const desired = {
    custom_fields: { a: 1, b: ["x"] },
    scheduled_at: "2026-10-15T15:00:00.000Z",
    updated_at: "2026-10-01T15:00:00Z",
  };
  const current = {
    custom_fields: { b: ["x"], a: 1 },
    scheduled_at: "2026-10-15T12:00:00-03:00",
    updated_at: "2026-10-15T15:00:00Z",
    server_field: true,
  };
  assert.deepEqual(changedFields(current, desired), {});
});

test("handoff serializado pelo Postgres não provoca UPDATE a cada execução", () => {
  assert.deepEqual(
    changedFields(
      { awaiting_human_since: "2026-09-20T15:50:00+00:00" },
      { awaiting_human_since: "2026-09-20T15:50:00.000Z" },
    ),
    {},
  );
});

test("reaplicação preserva o início do handoff gerenciado pelo trigger", () => {
  const desired = buildDataset(context).conversations.find(
    (conversation) => conversation.awaiting_human,
  );
  const current = { ...desired, awaiting_human_since: "2026-10-15T17:57:09.077+00:00" };

  assert.deepEqual(changedFields(current, desired), {});
});

test("reabrir handoff não tenta retroagir o relógio de SLA do servidor", () => {
  const desired = buildDataset(context).conversations.find(
    (conversation) => conversation.awaiting_human,
  );
  const current = { ...desired, awaiting_human: false, awaiting_human_since: null };

  assert.deepEqual(changedFields(current, desired), { awaiting_human: true });
});

test("canal preserva diagnóstico do reconciliador sem ignorar conexão indevida", () => {
  const desired = buildDataset({ ...context, providerSlug: "evolution" }).channels[0];
  const current = {
    ...desired,
    status_message:
      "Canal Evolution sem configuração completa (api_url/instance_name/credenciais).",
  };

  assert.deepEqual(changedFields(current, desired), {});
  assert.deepEqual(changedFields({ ...current, status: "connected" }, desired), {
    status: "disconnected",
  });
});

test("compare-and-skip não oculta diferença real em conteúdo nem arrays", () => {
  assert.deepEqual(
    changedFields({ content: "antigo", tags: ["b", "a"] }, { content: "novo", tags: ["a", "b"] }),
    { content: "novo", tags: ["a", "b"] },
  );
});

test("dataset cobre mínimos, todos os estágios e fechamento coerente", () => {
  const dataset = buildDataset(context);
  assert.ok(
    dataset.contacts.length >= 25 &&
      dataset.conversations.length >= 20 &&
      dataset.messages.length >= 100 &&
      dataset.deals.length >= 20 &&
      dataset.activities.length >= 15 &&
      dataset.deal_followups.length >= 10,
  );
  assert.deepEqual(
    new Set(dataset.deals.map((deal) => deal.stage_id)),
    new Set(context.stages.map((stage) => stage.id)),
  );
  assert.ok(
    dataset.deals
      .filter((deal) => deal.status === "lost")
      .every((deal) => deal.lost_reason && deal.closed_at),
  );
  assert.ok(
    dataset.deals
      .filter((deal) => deal.status === "won")
      .every((deal) => deal.closed_at && !deal.lost_reason),
  );
});

test("dataset usa apenas contatos fictícios e manifesto marcado", () => {
  const dataset = buildDataset(context);
  assert.ok(
    dataset.contacts.every(
      (contact) =>
        /^\+55119000000\d{2}$/.test(contact.phone) &&
        contact.email.endsWith("@example.com") &&
        contact.custom_fields._demo_seed === RUN_KEY,
    ),
  );
  assert.ok(
    dataset.messages.every(
      (message) =>
        message.external_id.startsWith(`demo:${RUN_KEY}:`) && message.send_attempts === 0,
    ),
  );
});

test("mensagens têm FKs locais e contadores históricos exatos", () => {
  const dataset = buildDataset(context);
  assert.ok(
    dataset.messages.every((message) =>
      dataset.conversations.some((conversation) => conversation.id === message.conversation_id),
    ),
  );
  assert.ok(
    dataset.conversations.every(
      (conversation) =>
        conversation.last_message_at ===
        dataset.messages.filter((message) => message.conversation_id === conversation.id).at(-1)
          .created_at,
    ),
  );
});

test("Mariana tem preferências sustentadas pelas mensagens e negociação ainda aberta", () => {
  const dataset = buildDataset(context);
  const mariana = dataset.contacts.find((contact) => contact.name === "Mariana Lopes");
  const conversation = dataset.conversations.find((item) => item.contact_id === mariana.id);
  const transcript = dataset.messages
    .filter((message) => message.conversation_id === conversation.id)
    .map((message) => message.content)
    .join(" ");
  assert.ok(
    transcript.includes("terça ou quinta") &&
      transcript.includes("18h") &&
      transcript.includes("WhatsApp") &&
      transcript.includes("R$ 150"),
  );
  assert.equal(mariana.custom_fields.periodo_preferido, "Após 18h, terça ou quinta");
  assert.ok(mariana.ai_memory.preferences.includes("Contato pelo WhatsApp"));
  assert.equal(dataset.deals.find((deal) => deal.contact_id === mariana.id).status, "open");
});

test("confirmação por mudança de estágio não presume data nem avaliação realizada", () => {
  const dataset = buildDataset(context);
  const sequence = dataset.nurture_sequences.find((row) => row.trigger_type === "stage_change");
  const text = dataset.nurture_steps
    .filter((row) => row.sequence_id === sequence.id)
    .map((row) => row.message_template)
    .join(" ");

  assert.doesNotMatch(text, /\bhoje\b|avaliação tenha sido útil|pós-avaliação/iu);
});

test("recall de negócio ganho não afirma que o tratamento foi concluído", () => {
  const dataset = buildDataset(context);
  const sequence = dataset.nurture_sequences.find((row) => row.trigger_type === "periodic");
  const text = dataset.nurture_steps
    .filter((row) => row.sequence_id === sequence.id)
    .map((row) => row.message_template)
    .join(" ");

  assert.doesNotMatch(text, /finalizou seu tratamento|tratamento (?:finalizado|concluído)/iu);
});

test("dataset não depende do relógio nem de aleatoriedade", () => {
  assert.deepEqual(buildDataset(context), buildDataset(context));
});

test("marcador copiado não autoriza remover UUID ou tenant alheio", () => {
  const dataset = buildDataset(context);
  const expected = dataset.contacts[0];
  assert.equal(
    ownsRow("contacts", { ...expected, id: context.profileId }, expected, dataset),
    false,
  );
  assert.equal(
    ownsRow("contacts", { ...expected, tenant_id: context.profileId }, expected, dataset),
    false,
  );
  assert.equal(ownsRow("contacts", { ...expected, custom_fields: {} }, expected, dataset), false);
});

test("DELETE de mensagem exige tenant, UUID, external_id, conversa e draft atomicamente", () => {
  const row = buildDataset(context).messages[0];
  assert.deepEqual(deleteFilter("messages", row), {
    id: `eq.${row.id}`,
    tenant_id: `eq.${tenantId}`,
    conversation_id: `eq.${row.conversation_id}`,
    external_id: `eq.${row.external_id}`,
    status: "eq.draft",
  });
});

test("execução padrão não escreve e flags contraditórias falham", () => {
  assert.equal(parseArguments([]).apply, false);
  assert.throws(() => parseArguments(["--apply", "--dry-run"]), /nunca ambos/);
});
