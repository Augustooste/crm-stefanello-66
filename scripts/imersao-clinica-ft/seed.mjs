import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import {
  ANCHOR,
  buildDataset,
  changedFields,
  EXPECTED_TENANT_NAME,
  RUN_KEY,
  seedId,
  STAGE_CONFIG,
  STAGE_NAMES,
} from "./dataset.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CHANNEL_COLUMNS =
  "id,tenant_id,provider_slug,type,status,status_message,config,created_at,updated_at";
const PROD_HOST = "dpdtgddkvdgswndzuofv.supabase.co";

export function parseArguments(args = process.argv.slice(2)) {
  const allowed = new Set(["--apply", "--dry-run", "--bootstrap-local", "--with-ai-qualification"]);
  const invalid = args.find((arg) => !allowed.has(arg) && !arg.startsWith("--report="));
  if (invalid) throw new Error(`Argumento não reconhecido: ${invalid}`);
  if (args.includes("--apply") && args.includes("--dry-run"))
    throw new Error("Escolha --apply ou --dry-run, nunca ambos.");
  return {
    apply: args.includes("--apply"),
    bootstrap: args.includes("--bootstrap-local"),
    qualification: args.includes("--with-ai-qualification"),
    reportPath: args.find((arg) => arg.startsWith("--report="))?.slice(9),
  };
}

export async function createSession(options) {
  const target = process.env.SEED_TARGET;
  if (!["local", "prod"].includes(target))
    throw new Error("Defina SEED_TARGET=local ou SEED_TARGET=prod explicitamente.");
  if (target === "prod" && (options.bootstrap || options.qualification))
    throw new Error("Bootstrap e qualificação por IA são permitidos somente no stack local.");
  let env;
  if (target === "prod") env = parseEnv(await readFile(path.join(ROOT, ".env.local"), "utf8"));
  else {
    try {
      env = parseEnv(
        execFileSync("pnpm", ["exec", "supabase", "status", "-o", "env"], {
          cwd: ROOT,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
    } catch {
      throw new Error(
        "Não foi possível ler o status do stack local; nenhuma saída de credenciais será registrada.",
      );
    }
  }
  const url = target === "prod" ? env.VITE_SUPABASE_URL : env.API_URL;
  const key =
    target === "prod" ? env.VITE_SUPABASE_PUBLISHABLE_KEY : env.PUBLISHABLE_KEY || env.ANON_KEY;
  if (!url || !key) throw new Error("URL ou chave publicável ausente na configuração do alvo.");
  const parsed = new URL(url);
  if (target === "local" && !["127.0.0.1", "localhost"].includes(parsed.hostname))
    throw new Error("Alvo local não aponta para loopback.");
  if (target === "prod" && (parsed.hostname !== PROD_HOST || parsed.protocol !== "https:"))
    throw new Error("Produção não corresponde ao projeto AceleraFlow remix autorizado.");
  if (key.startsWith("sb_secret_")) throw new Error("Chave privilegiada não é permitida.");
  if (
    key.split(".").length === 3 &&
    JSON.parse(Buffer.from(key.split(".")[1], "base64url")).role !== "anon"
  )
    throw new Error("A chave de API precisa ser pública/anon, nunca service_role.");
  const credentials = parseEnv(
    await readFile(path.join(homedir(), ".config/aceleraflow-imersao/credentials.env"), "utf8"),
  );
  if (!credentials.CLINICA_FT_EMAIL || !credentials.CLINICA_FT_PASSWORD)
    throw new Error("Credenciais da Clínica FT ausentes no arquivo privado.");
  let token;
  let verified = false;
  const request = async (
    route,
    { method = "GET", body, query, auth = true, write = false } = {},
  ) => {
    if (write && (!options.apply || !verified))
      throw new Error("Escrita recusada: --apply e verificação de tenant são obrigatórios.");
    const endpoint = new URL(route, `${url}/`);
    if (query)
      Object.entries(query).forEach(([name, value]) =>
        endpoint.searchParams.set(name, String(value)),
      );
    const response = await fetch(endpoint, {
      method,
      headers: {
        apikey: key,
        ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(route.startsWith("functions/") ? 180000 : 30000),
    });
    const text = await response.text();
    let result;
    try {
      result = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`${route}: resposta inválida (HTTP ${response.status}).`);
    }
    if (!response.ok) {
      const error = new Error(
        `${route}: HTTP ${response.status}; código ${result?.error_code || result?.code || "não informado"}.`,
      );
      error.status = response.status;
      error.code = result?.error_code || result?.code;
      throw error;
    }
    return result;
  };
  const passwordBody = {
    email: credentials.CLINICA_FT_EMAIL,
    password: credentials.CLINICA_FT_PASSWORD,
  };
  let login;
  try {
    login = await request("auth/v1/token", {
      method: "POST",
      query: { grant_type: "password" },
      body: passwordBody,
      auth: false,
    });
  } catch (error) {
    if (
      !options.bootstrap ||
      !options.apply ||
      target !== "local" ||
      error.code !== "invalid_credentials"
    )
      throw error;
    await request("auth/v1/signup", {
      method: "POST",
      body: { ...passwordBody, data: { name: EXPECTED_TENANT_NAME } },
      auth: false,
    });
    login = await request("auth/v1/token", {
      method: "POST",
      query: { grant_type: "password" },
      body: passwordBody,
      auth: false,
    });
  }
  token = login.access_token;
  const select = async (table, query = {}) => {
    const rows = [];
    for (let offset = 0; ; offset += 500) {
      const page = await request(`rest/v1/${table}`, {
        query: {
          select: table === "channels" ? CHANNEL_COLUMNS : "*",
          ...query,
          limit: 500,
          offset,
        },
      });
      rows.push(...page);
      if (page.length < 500) return rows;
    }
  };
  const profiles = await select("profiles", {
    select: "id,tenant_id,name,role,disabled",
    id: `eq.${login.user.id}`,
  });
  const tenants = await select("tenants");
  if (profiles.length !== 1 || profiles[0].role !== "admin" || profiles[0].disabled)
    throw new Error("O usuário autenticado não tem perfil admin único e ativo.");
  if (
    tenants.length !== 1 ||
    tenants[0].id !== profiles[0].tenant_id ||
    tenants[0].name !== EXPECTED_TENANT_NAME
  )
    throw new Error(
      "Tenant inesperado: é obrigatório enxergar somente a Clínica FT com o nome exato.",
    );
  verified = true;
  const tenant = tenants[0];
  const session = {
    target,
    url,
    tenant,
    profile: profiles[0],
    options,
    select,
    request,
    rows: (table, query = {}) => select(table, { tenant_id: `eq.${tenant.id}`, ...query }),
    insert: (table, row) =>
      request(`rest/v1/${table}`, {
        method: "POST",
        body: row,
        query: { select: table === "channels" ? CHANNEL_COLUMNS : "*" },
        write: true,
      }),
    patch: (table, query, body) =>
      request(`rest/v1/${table}`, {
        method: "PATCH",
        body,
        query: { ...query, select: table === "channels" ? CHANNEL_COLUMNS : "*" },
        write: true,
      }),
    rpc: (name, body) => request(`rest/v1/rpc/${name}`, { method: "POST", body, write: true }),
  };
  if (options.bootstrap && options.apply) await bootstrapLocal(session);
  return session;
}

async function bootstrapLocal(session) {
  if (session.target !== "local") throw new Error("Bootstrap remoto recusado.");
  const { tenant } = session;
  const deals = await session.rows("deals", { select: "id" });
  if (tenant.niche === "clinica-odontologica") return;
  if (deals.length) throw new Error("Template não pode ser aplicado sobre negócios existentes.");
  const templates = await session.select("niche_templates", { slug: "eq.clinica-odontologica" });
  if (templates.length !== 1) throw new Error("Template odontológico não encontrado.");
  let boards = await session.rows("boards", { is_default: "eq.true" });
  if (!boards.length)
    boards = await session.insert("boards", {
      id: seedId(tenant.id, "boards", "odontologia"),
      tenant_id: tenant.id,
      name: "Atendimento odontológico",
      is_default: true,
    });
  if (boards.length !== 1) throw new Error("É obrigatório um único board padrão.");
  const template = templates[0];
  await session.rpc("apply_niche_template", {
    p_board_id: boards[0].id,
    p_niche_slug: template.slug,
    p_base_prompt: template.base_prompt,
    p_stages: template.stages,
    p_stage_prompts: template.stage_prompts,
  });
  await session.patch(
    "tenants",
    { id: `eq.${tenant.id}` },
    {
      ai_enabled: false,
      onboarded_at: ANCHOR,
      business_profile: {
        name: EXPECTED_TENANT_NAME,
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        locale: "pt-BR",
      },
    },
  );
  tenant.ai_enabled = false;
  tenant.niche = template.slug;
}

export async function loadContext(session) {
  const boards = await session.rows("boards", { is_default: "eq.true" });
  if (boards.length !== 1) throw new Error("É obrigatório exatamente um board padrão visível.");
  const rawStages = await session.select("board_stages", {
    board_id: `eq.${boards[0].id}`,
    order: "position.asc",
  });
  const stages = rawStages.map((stage) => ({
    ...stage,
    name:
      stage.name === "Triagem"
        ? "Em Atendimento"
        : stage.name === "Orçamento Enviado"
          ? "Proposta"
          : stage.name,
  }));
  if (
    stages.length !== STAGE_NAMES.length ||
    STAGE_NAMES.some((name) => stages.filter((stage) => stage.name === name).length !== 1)
  )
    throw new Error("O funil não corresponde aos sete estágios odontológicos esperados.");
  const integrations = await session.select("integrations", {
    select: "slug",
    slug: "in.(simulator,whatsapp-meta,meta-whatsapp,evolution,z-api,whatsapp-evolution)",
  });
  const slugs = integrations.map((integration) => integration.slug);
  const providerSlug =
    session.target === "local" && slugs.includes("simulator")
      ? "simulator"
      : slugs.find((slug) => slug !== "simulator");
  if (!providerSlug)
    throw new Error("Nenhum provider válido de demonstração foi encontrado no catálogo.");
  const statuses = await session.rows("contact_statuses", { slug: "eq.lead" });
  if (!statuses.length) throw new Error("Status lead ausente no catálogo do tenant.");
  return {
    tenantId: session.tenant.id,
    profileId: session.profile.id,
    boardId: boards[0].id,
    stages,
    rawStages,
    providerSlug,
  };
}

export function ownsRow(table, row, expected, dataset) {
  if (row.id !== expected.id) return false;
  if (expected.tenant_id && row.tenant_id !== expected.tenant_id) return false;
  if (table === "channels") return row.config?._demo_seed === RUN_KEY;
  if (["contacts", "deals"].includes(table)) return row.custom_fields?._demo_seed === RUN_KEY;
  if (table === "activities") return row.metadata?._demo_seed === RUN_KEY;
  if (table === "messages")
    return (
      row.external_id === expected.external_id && row.conversation_id === expected.conversation_id
    );
  if (table === "conversations")
    return (
      row.subject?.startsWith(`[${RUN_KEY}]`) &&
      row.channel_id === dataset.channels[0].id &&
      row.contact_id === expected.contact_id
    );
  if (["deal_followups", "nurture_sequences"].includes(table))
    return row.description?.startsWith(`[${RUN_KEY}]`);
  if (table === "nurture_steps")
    return (
      row.sequence_id === expected.sequence_id &&
      row.message_template.startsWith(`[Demonstração Clínica FT]`)
    );
  if (table === "custom_field_definitions")
    return (
      row.key === expected.key && row.entity === expected.entity && row.label === expected.label
    );
  return false;
}

export function datasetRows(session, table, dataset, query = {}) {
  if (table === "nurture_steps")
    return session.select(table, {
      sequence_id: `in.(${dataset.nurture_sequences.map((row) => row.id).join(",")})`,
      ...query,
    });
  return session.rows(table, query);
}

export function rowFilter(table, row) {
  return {
    id: `eq.${row.id}`,
    ...(table === "nurture_steps"
      ? { sequence_id: `eq.${row.sequence_id}` }
      : { tenant_id: `eq.${row.tenant_id}` }),
  };
}

export async function writeReport(report, reportPath) {
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (reportPath) await writeFile(reportPath, output, { mode: 0o600 });
  process.stdout.write(output);
}

async function configurePipeline(session, context, summary) {
  const configs = await session.rows("stage_ai_config");
  const transitions = await session.rows("stage_transitions", {
    board_id: `eq.${context.boardId}`,
  });
  const mutate = async (table, current, desired, query) => {
    const patch = current ? changedFields(current, desired) : desired;
    if (!Object.keys(patch).length) return;
    summary.configuracao.push({
      tabela: table,
      id: current?.id || desired.id,
      operacao: current ? "update" : "insert",
      campos: Object.keys(patch),
    });
    if (!session.options.apply) return;
    if (current) await session.patch(table, query, patch);
    else await session.insert(table, desired);
  };
  for (const raw of context.rawStages) {
    const stage = context.stages.find((item) => item.id === raw.id);
    await mutate(
      "board_stages",
      raw,
      { name: stage.name },
      { id: `eq.${raw.id}`, board_id: `eq.${context.boardId}` },
    );
  }
  for (let index = 0; index < STAGE_NAMES.length; index++) {
    const stage = context.stages.find((item) => item.name === STAGE_NAMES[index]);
    const current = configs.find((item) => item.stage_id === stage.id);
    const config = STAGE_CONFIG[index];
    const desired = {
      stage_goal: config.goal,
      advancement_criteria: config.criteria,
      entry_criteria: index === 0 ? [] : STAGE_CONFIG[index - 1].criteria,
    };
    if (current?.system_prompt)
      desired.system_prompt = current.system_prompt
        .replaceAll("Triagem", "Em Atendimento")
        .replaceAll("Orçamento Enviado", "Proposta");
    if (!current)
      Object.assign(desired, {
        id: seedId(context.tenantId, "stage_ai_config", stage.name),
        tenant_id: context.tenantId,
        stage_id: stage.id,
        enabled: index < 5,
        system_prompt: config.goal,
      });
    await mutate("stage_ai_config", current, desired, {
      stage_id: `eq.${stage.id}`,
      tenant_id: `eq.${context.tenantId}`,
    });
    if (index >= 5) continue;
    const to = context.stages.find((item) => item.name === STAGE_NAMES[index + 1]);
    const transition = transitions.find(
      (item) => item.from_stage_id === stage.id && item.to_stage_id === to.id,
    );
    const policy = {
      autonomy_mode: index === 4 ? "assisted" : "autonomous",
      min_confidence: 0.8,
      requires_human_approval: index === 4,
      enabled: true,
    };
    if (!transition)
      Object.assign(policy, {
        id: seedId(context.tenantId, "stage_transitions", `${stage.name}:${to.name}`),
        tenant_id: context.tenantId,
        board_id: context.boardId,
        from_stage_id: stage.id,
        to_stage_id: to.id,
      });
    await mutate("stage_transitions", transition, policy, {
      id: `eq.${transition?.id}`,
      tenant_id: `eq.${context.tenantId}`,
    });
  }
}

export async function telemetry(session) {
  const [jobs, deliveries, messages] = await Promise.all([
    session.rows("job_queue", { select: "id,job_type,status" }),
    session.rows("event_deliveries", { select: "id,subscriber_id,status,attempts" }),
    session.rows("messages", {
      select: "id,direction,external_id,send_attempts,audio_attempts,status",
    }),
  ]);
  const group = (rows, key) =>
    rows.reduce((counts, row) => ({ ...counts, [row[key]]: (counts[row[key]] || 0) + 1 }), {});
  return {
    jobs: jobs.length,
    jobs_por_tipo: group(jobs, "job_type"),
    deliveries: deliveries.length,
    deliveries_por_assinante: group(deliveries, "subscriber_id"),
    tentativas_envio: messages.reduce(
      (total, message) => total + message.send_attempts + message.audio_attempts,
      0,
    ),
    mensagens_fora_manifesto: messages.filter(
      (message) => !message.external_id?.startsWith(`demo:${RUN_KEY}:`),
    ).length,
  };
}

export async function runSeed(options = parseArguments()) {
  const session = await createSession(options);
  const context = await loadContext(session);
  const dataset = buildDataset(context);
  const summary = {
    alvo: session.target,
    modo: options.apply ? "apply" : "dry-run",
    tenant: { id: context.tenantId, nome: session.tenant.name, admin: true, tenants_visiveis: 1 },
    referencia: ANCHOR,
    provider: context.providerSlug,
    configuracao: [],
    entidades: {},
    rpcs: [],
    alertas: [
      "INSERT de mensagens gera deliveries internos de domínio; isso não é envio ao paciente.",
      "Mensagens sent e artefatos server-managed exigem limpeza privilegiada; cleanup nunca é automático.",
    ],
  };
  if (session.tenant.ai_enabled) {
    summary.alertas.push(
      "Aplicação bloqueada enquanto tenants.ai_enabled=true. Desative a IA deste tenant antes de importar; o seed não altera a política global.",
    );
    if (options.apply) throw new Error(summary.alertas.at(-1));
  }
  const before = await telemetry(session);
  await configurePipeline(session, context, summary);
  let probe;
  for (const [table, desiredRows] of Object.entries(dataset)) {
    const currentRows = await datasetRows(session, table, dataset);
    const currentById = new Map(currentRows.map((row) => [row.id, row]));
    const result = { insert: 0, update: 0, skip: 0, total_manifesto: desiredRows.length };
    summary.entidades[table] = result;
    for (const desired of desiredRows) {
      const current = currentById.get(desired.id);
      if (current && !ownsRow(table, current, desired, dataset))
        throw new Error(`Colisão fora do manifesto: ${table}/${desired.id}.`);
      const ignored = [
        "created_at",
        "updated_at",
        ...(table === "deals" && desired.id === seedId(context.tenantId, "deals", "mariana-lopes")
          ? ["stage_entered_at", "stage_id"]
          : []),
      ];
      const patch = current ? changedFields(current, desired, ignored) : desired;
      if (current && !Object.keys(patch).length) {
        result.skip++;
        continue;
      }
      if (table === "messages" && current)
        throw new Error(
          `Mensagem imutável diverge do manifesto: ${desired.id}. Não será sobrescrita.`,
        );
      if (table === "deals" && current && patch.stage_id)
        throw new Error(
          `Negócio mudou de estágio fora do seed: ${desired.id}. Nenhuma regressão automática será aplicada.`,
        );
      result[current ? "update" : "insert"]++;
      if (!options.apply) continue;
      if (current) await session.patch(table, rowFilter(table, desired), patch);
      else {
        const row =
          table === "deals" && desired.id === seedId(context.tenantId, "deals", "mariana-lopes")
            ? {
                ...desired,
                stage_id: context.stages.find((stage) => stage.name === "Em Atendimento").id,
              }
            : desired;
        const preMessage = table === "messages" && !probe ? await telemetry(session) : null;
        await session.insert(table, row);
        if (preMessage) {
          const afterMessage = await telemetry(session);
          probe = { antes: preMessage, depois: afterMessage, mensagem_id: row.id };
          if (
            afterMessage.jobs !== preMessage.jobs ||
            afterMessage.tentativas_envio !== preMessage.tentativas_envio
          )
            throw new Error(
              "A sonda de mensagem criou job ou tentativa de envio; importação interrompida.",
            );
        }
      }
    }
  }
  if (options.apply) {
    for (const desired of dataset.conversations) {
      const [current] = await session.rows("conversations", { id: `eq.${desired.id}` });
      const patch = changedFields(current, desired);
      if (!Object.keys(patch).length) continue;
      await session.patch(
        "conversations",
        { id: `eq.${desired.id}`, tenant_id: `eq.${context.tenantId}` },
        patch,
      );
      summary.entidades.conversations.update++;
    }
  }
  await advanceMariana(session, context, dataset, summary);
  await seedNurture(session, context, dataset, summary);
  let qualificationError;
  if (options.qualification) {
    try {
      await qualify(session, context, summary);
    } catch (error) {
      qualificationError = error;
      summary.qualificacao_erro = error.message;
    }
  }
  const after = await telemetry(session);
  summary.evidencia = {
    antes: before,
    depois: after,
    sonda_mensagem: probe || "Nenhuma mensagem nova: manifesto já presente ou dry-run.",
    jobs_criados: after.jobs - before.jobs,
    tentativas_envio_criadas: after.tentativas_envio - before.tentativas_envio,
    deliveries_internos_criados: after.deliveries - before.deliveries,
  };
  if (
    options.apply &&
    (after.jobs !== before.jobs || after.tentativas_envio !== before.tentativas_envio)
  )
    throw new Error(
      "Foram observados jobs ou tentativas de envio durante o seed; revise a execução.",
    );
  summary.contagens_medidas = {};
  for (const [table, rows] of Object.entries(dataset)) {
    const existing = await datasetRows(session, table, dataset, {
      select: "id",
      id: `in.(${rows.map((row) => row.id).join(",")})`,
    });
    summary.contagens_medidas[table] = existing.length;
  }
  const enrollments = await session.rows("nurture_enrollments", {
    sequence_id: `in.(${dataset.nurture_sequences.map((row) => row.id).join(",")})`,
    select: "id,status",
  });
  summary.contagens_medidas.nurture_enrollments = enrollments.length;
  summary.inscricoes_por_status = enrollments.reduce(
    (counts, row) => ({ ...counts, [row.status]: (counts[row.status] || 0) + 1 }),
    {},
  );
  if (options.qualification) {
    const snapshots = await session.rows("deal_qualification_snapshots", {
      select: "id,deal_id",
      deal_id: `in.(${["mariana-lopes", "henrique-dias", "isabela-melo"].map((key) => seedId(context.tenantId, "deals", key)).join(",")})`,
    });
    summary.contagens_medidas.deal_qualification_snapshots = snapshots.length;
  }
  summary.totais = {
    inserts:
      Object.values(summary.entidades).reduce((sum, row) => sum + row.insert, 0) +
      summary.configuracao.filter((item) => item.operacao === "insert").length,
    updates:
      Object.values(summary.entidades).reduce((sum, row) => sum + row.update, 0) +
      summary.configuracao.filter((item) => item.operacao === "update").length,
    rpcs: summary.rpcs.filter((item) => item.executar).length,
  };
  await writeReport(summary, options.reportPath);
  if (qualificationError) throw qualificationError;
  return summary;
}

async function advanceMariana(session, context, dataset, summary) {
  const dealId = seedId(context.tenantId, "deals", "mariana-lopes");
  const from = context.stages.find((stage) => stage.name === "Em Atendimento");
  const to = context.stages.find((stage) => stage.name === "Qualificado");
  const [deal] = await session.rows("deals", { id: `eq.${dealId}` });
  const history = await session.rows("deal_stage_transition_commands", {
    idempotency_key: `eq.${RUN_KEY}:mariana-qualificada`,
  });
  if (history.some((command) => command.status === "accepted")) {
    summary.rpcs.push({ nome: "transition_deal_stage", executar: false });
    return;
  }
  if (deal && deal.stage_id !== from.id)
    throw new Error(
      "Mariana saiu do estágio de origem sem o comando do seed; revisão manual necessária.",
    );
  summary.rpcs.push({
    nome: "transition_deal_stage",
    executar: true,
    ator: "human",
    motivo: "Critérios explícitos nas mensagens; sem fingir decisão de IA.",
  });
  if (!session.options.apply) return;
  const messages = dataset.messages.filter(
    (message) =>
      message.conversation_id === seedId(context.tenantId, "conversations", "mariana-lopes"),
  );
  const result = await session.rpc("transition_deal_stage", {
    p_deal_id: dealId,
    p_expected_stage_id: from.id,
    p_target_stage_id: to.id,
    p_actor_type: "human",
    p_actor_id: context.profileId,
    p_reason:
      "Recepção conferiu interesse, disponibilidade e autorização de retorno nas mensagens fictícias.",
    p_evidence: { _demo_seed: RUN_KEY, message_ids: messages.map((message) => message.id) },
    p_idempotency_key: `${RUN_KEY}:mariana-qualificada`,
  });
  if (!result.success) throw new Error(`Transição de Mariana recusada: ${result.status}.`);
}

async function seedNurture(session, context, dataset, summary) {
  const enrolled = await session.rows("nurture_enrollments");
  const activeManual = await session.rows("nurture_sequences", {
    trigger_type: "eq.manual",
    is_active: "eq.true",
  });
  summary.entidades.nurture_enrollments = { insert: 0, update: 0, skip: 0, total_manifesto: 3 };
  const contactKeys = ["joao-farias", "manuela-campos", "paulo-teixeira"];
  for (const [index, sequence] of dataset.nurture_sequences.entries()) {
    const contactId = seedId(context.tenantId, "contacts", contactKeys[index]);
    const matches = enrolled.filter(
      (row) => row.sequence_id === sequence.id && row.contact_id === contactId,
    );
    if (matches.length > 1)
      throw new Error(
        "Inscrições duplicadas para o par determinístico; revise antes de continuar.",
      );
    const existing = matches[0];
    if (existing) {
      if (existing.status === "active") {
        summary.entidades.nurture_enrollments.update++;
        summary.rpcs.push({
          nome: "set_nurture_enrollment_status",
          executar: true,
          status: "paused",
        });
        if (session.options.apply)
          await session.rpc("set_nurture_enrollment_status", {
            p_enrollment_id: existing.id,
            p_status: "paused",
          });
      } else summary.entidades.nurture_enrollments.skip++;
      continue;
    }
    if (
      activeManual.some(
        (sequence) => !dataset.nurture_sequences.some((desired) => desired.id === sequence.id),
      )
    )
      throw new Error(
        "Existe sequência manual ativa fora do manifesto; nenhuma inscrição será feita.",
      );
    summary.entidades.nurture_enrollments.insert++;
    summary.entidades.nurture_sequences.update += 2;
    summary.rpcs.push({
      nome: "enroll_manual_nurture_sequence",
      executar: true,
      sequence_id: sequence.id,
      contact_id: contactId,
    });
    summary.rpcs.push({ nome: "set_nurture_enrollment_status", executar: true, status: "paused" });
    if (!session.options.apply) continue;
    await session.patch("nurture_sequences", rowFilter("nurture_sequences", sequence), {
      trigger_type: "manual",
      is_active: true,
    });
    try {
      const inserted = await session.rpc("enroll_manual_nurture_sequence", {
        p_contact_id: contactId,
        p_appointment_at: new Date(Date.now() + 90 * 86400000).toISOString(),
      });
      if (!inserted) throw new Error("A RPC não criou a inscrição demonstrativa.");
      const rows = await session.rows("nurture_enrollments", {
        sequence_id: `eq.${sequence.id}`,
        contact_id: `eq.${contactId}`,
        status: "eq.active",
      });
      if (rows.length !== 1)
        throw new Error("A RPC não retornou uma inscrição única na sequência esperada.");
      await session.rpc("set_nurture_enrollment_status", {
        p_enrollment_id: rows[0].id,
        p_status: "paused",
      });
    } finally {
      await session.patch("nurture_sequences", rowFilter("nurture_sequences", sequence), {
        trigger_type: sequence.trigger_type,
        is_active: false,
      });
    }
  }
}

async function qualify(session, context, summary) {
  for (const key of ["mariana-lopes", "henrique-dias", "isabela-melo"]) {
    const dealId = seedId(context.tenantId, "deals", key);
    const snapshots = await session.rows("deal_qualification_snapshots", {
      deal_id: `eq.${dealId}`,
      select: "id",
    });
    summary.rpcs.push({
      nome: "ai-qualification",
      deal_id: dealId,
      executar: snapshots.length === 0,
    });
    if (snapshots.length || !session.options.apply) continue;
    const result = await session.request("functions/v1/ai-qualification", {
      method: "POST",
      body: { dealId },
      write: true,
    });
    if (!result?.snapshot) throw new Error(`Qualificação não concluída para ${key}.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSeed().catch((error) => {
    process.stderr.write(`Seed interrompido: ${error.message}\n`);
    process.exitCode = 1;
  });
}
