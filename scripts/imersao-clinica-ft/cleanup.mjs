import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDataset, RUN_KEY } from "./dataset.mjs";
import {
  createSession,
  datasetRows,
  loadContext,
  ownsRow,
  parseArguments,
  rowFilter,
  writeReport,
} from "./seed.mjs";

// Não permitir CASCADE/SET NULL sobre filhos que não foram removidos explicitamente.
const DEPENDENCIES = {
  activities: [
    ["conversations", "handoff_activity_id"],
    ["hitl_decisions", "activity_id"],
    ["hitl_handoff_sla_events", "activity_id"],
  ],
  messages: [
    ["ai_processing_log", "message_id"],
    ["communication_usage_events", "message_id"],
  ],
  nurture_sequences: [
    ["nurture_steps", "sequence_id"],
    ["nurture_enrollments", "sequence_id"],
  ],
  conversations: [
    ["messages", "conversation_id"],
    ["ai_conversation_summaries", "conversation_id"],
    ["ai_pending_stage_advances", "conversation_id"],
    ["ai_processing_log", "conversation_id"],
    ["hitl_handoff_sla_events", "conversation_id"],
  ],
  deals: [
    "activities",
    "ai_conversation_summaries",
    "ai_pending_stage_advances",
    "deal_followups",
    "deal_qualification_snapshots",
    "deal_stage_evaluations",
    "deal_stage_history",
    "deal_stage_transition_commands",
    "hitl_decisions",
    "nurture_enrollments",
    "voice_calls",
  ].map((table) => [table, "deal_id"]),
  contacts: [
    ...[
      "activities",
      "ai_conversation_summaries",
      "ai_lead_verdicts",
      "apify_enrichment_runs",
      "appointments",
      "contact_identities",
      "contact_notes",
      "conversations",
      "deal_followups",
      "deals",
      "hitl_decisions",
      "lead_form_submissions",
      "messaging_phone_suppressions",
      "nurture_enrollments",
      "template_schedule_executions",
      "voice_calls",
    ].map((table) => [table, "contact_id"]),
    ["contacts", "merged_into_id"],
  ],
  channels: [
    "channel_status_events",
    "conversations",
    "messaging_templates",
    "messaging_webhook_events",
    "nurture_sequences",
    "template_schedules",
  ].map((table) => [table, "channel_id"]),
};
const ORDER = [
  "deal_followups",
  "activities",
  "messages",
  "nurture_steps",
  "nurture_sequences",
  "conversations",
  "deals",
  "contacts",
  "channels",
  "custom_field_definitions",
];

export function deleteFilter(table, row) {
  const filters = rowFilter(table, row);
  if (table === "channels") filters["config->>_demo_seed"] = `eq.${RUN_KEY}`;
  else if (["contacts", "deals"].includes(table))
    filters["custom_fields->>_demo_seed"] = `eq.${RUN_KEY}`;
  else if (table === "activities") filters["metadata->>_demo_seed"] = `eq.${RUN_KEY}`;
  else if (table === "messages")
    Object.assign(filters, {
      external_id: `eq.${row.external_id}`,
      status: "eq.draft",
      conversation_id: `eq.${row.conversation_id}`,
    });
  else if (table === "conversations")
    Object.assign(filters, {
      subject: `eq.${row.subject}`,
      channel_id: `eq.${row.channel_id}`,
      contact_id: `eq.${row.contact_id}`,
    });
  else if (["deal_followups", "nurture_sequences"].includes(table))
    filters.description = `eq.${row.description}`;
  else if (table === "nurture_steps") filters.message_template = `eq.${row.message_template}`;
  else if (table === "custom_field_definitions")
    Object.assign(filters, {
      entity: `eq.${row.entity}`,
      key: `eq.${row.key}`,
      label: `eq.${row.label}`,
    });
  else throw new Error("Tabela fora do manifesto de limpeza.");
  return filters;
}

export async function runCleanup(options = parseArguments()) {
  if (options.bootstrap || options.qualification)
    throw new Error("Cleanup não aceita bootstrap nem qualificação.");
  const session = await createSession(options);
  const context = await loadContext(session);
  const dataset = buildDataset(context);
  const report = {
    alvo: session.target,
    modo: options.apply ? "apply" : "dry-run",
    tenant_id: context.tenantId,
    marcador: RUN_KEY,
    removiveis: [],
    removidos: [],
    bloqueados: [],
    ausentes: {},
    preservados: [
      "Board, estágios, stage_ai_config, transições e políticas existentes não são revertidos.",
      "Artefatos gerados pelo servidor não são apagados indiretamente por CASCADE.",
    ],
  };
  const plannedRemoval = new Set();
  for (const table of ORDER) {
    const expectedRows = dataset[table];
    const current = await datasetRows(session, table, dataset, {
      id: `in.(${expectedRows.map((row) => row.id).join(",")})`,
    });
    report.ausentes[table] = expectedRows.length - current.length;
    const children = [];
    for (const [child, column] of DEPENDENCIES[table] || []) {
      if (!current.length) break;
      try {
        const rows = await session.select(child, {
          select: `id,${column}`,
          [column]: `in.(${current.map((row) => row.id).join(",")})`,
          ...(child === "nurture_steps" ? {} : { tenant_id: `eq.${context.tenantId}` }),
        });
        children.push({ table: child, column, rows });
      } catch (error) {
        children.push({ table: child, column, inaccessible: error.message });
      }
    }
    for (const row of current) {
      const expected = expectedRows.find((item) => item.id === row.id);
      const entry = { tabela: table, id: row.id };
      if (!ownsRow(table, row, expected, dataset)) {
        report.bloqueados.push({
          ...entry,
          motivo: "UUID existente sem marcador/FK do manifesto; preservado.",
        });
        continue;
      }
      if (table === "messages" && row.status !== "draft") {
        report.bloqueados.push({
          ...entry,
          motivo: "RLS/trigger: apenas mensagens draft podem ser excluídas pelo admin.",
        });
        continue;
      }
      // Identidades e filas de extração têm IDs server-managed: contatos ficam para a revisão privilegiada.
      if (table === "contacts") {
        report.bloqueados.push({
          ...entry,
          motivo:
            "Contato possui identidades/possíveis filas server-managed; não apagar por cascata sob RLS.",
        });
        continue;
      }
      if (table === "custom_field_definitions") {
        // Uma definição pode estar em uso com qualquer valor; não removê-la enquanto existir contato.
        const remaining = await session.rows("contacts", { select: "id" });
        if (remaining.length) {
          report.bloqueados.push({
            ...entry,
            motivo:
              "Definição preservada enquanto houver contatos no tenant, inclusive fora do seed.",
          });
          continue;
        }
      }
      const blockers = children.filter(
        (child) =>
          child.inaccessible ||
          child.rows.some(
            (item) =>
              item[child.column] === row.id && !plannedRemoval.has(`${child.table}:${item.id}`),
          ),
      );
      if (blockers.length) {
        report.bloqueados.push({
          ...entry,
          motivo:
            "Filhos retidos ou não verificáveis; remoção poderia alterar dados fora do manifesto.",
          dependencias: blockers.map((child) => child.table),
        });
        continue;
      }
      report.removiveis.push(entry);
      if (options.apply) {
        try {
          const removed = await session.request(`rest/v1/${table}`, {
            method: "DELETE",
            query: {
              ...deleteFilter(table, row),
              ...(table === "channels" ? { select: "id" } : {}),
            },
            write: true,
          });
          if (!Array.isArray(removed) || removed.length !== 1 || removed[0].id !== row.id)
            throw new Error("DELETE não confirmou exatamente o UUID solicitado.");
          report.removidos.push(entry);
        } catch (error) {
          report.bloqueados.push({ ...entry, motivo: error.message });
          continue;
        }
      }
      plannedRemoval.add(`${table}:${row.id}`);
    }
  }
  const enrollmentRows = await session.rows("nurture_enrollments", {
    sequence_id: `in.(${dataset.nurture_sequences.map((row) => row.id).join(",")})`,
    select: "id,sequence_id,contact_id,status",
  });
  report.inscricoes_preservadas = enrollmentRows;
  report.resumo = {
    removiveis: report.removiveis.length,
    removidos: report.removidos.length,
    bloqueados: report.bloqueados.length,
    inscricoes_server_managed: enrollmentRows.length,
  };
  await writeReport(report, options.reportPath);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCleanup().catch((error) => {
    process.stderr.write(`Limpeza interrompida: ${error.message}\n`);
    process.exitCode = 1;
  });
}
