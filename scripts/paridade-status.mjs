#!/usr/bin/env node
/**
 * Relatório de paridade com o AceleraFlow, medido contra o backend REAL.
 *
 * Por que existe, se já há pgTAP: a suíte pgTAP roda no shadow DB local, que é
 * reconstruído a partir de supabase/migrations. Neste remix o schema veio
 * clonado, não das migrations do repositório — então só uma leitura do backend
 * hospedado diz o que de fato está lá. Este script faz essa leitura e escreve
 * docs/paridade-aceleraflow.md.
 *
 * Somente leitura: nenhuma consulta aqui escreve, cria ou altera nada.
 *
 * Uso: node scripts/paridade-status.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const SAIDA = "docs/paridade-aceleraflow.md";

if (!process.env.PGHOST) {
  console.error("PGHOST ausente: este script precisa das variáveis PG* do backend gerenciado.");
  process.exit(1);
}

/** Executa SQL e devolve as linhas como array de strings (formato -At). */
function q(sql) {
  const out = execFileSync("psql", ["-At", "-c", sql], { encoding: "utf8" });
  return out.split("\n").filter((l) => l.length > 0);
}

function um(sql) {
  return q(sql)[0] ?? "";
}

// ---------------------------------------------------------------------------
// Baseline do AceleraFlow (comparação de 2026-08-11).
// ---------------------------------------------------------------------------
const TABELAS_RESTAURADAS = [
  "domain_event_projections",
  "plan_catalog",
  "plan_capabilities",
  "subscriptions",
  "subscription_items",
  "usage_events",
  "usage_aggregates",
  "tenant_plugin_installations",
  "tenant_capability_quotas",
  "entitlement_audit_log",
  "capability_shadow_evaluations",
  "billing_webhook_events",
  "marketplace_engine_catalog",
  "marketplace_engine_capabilities",
  "marketplace_engine_dependencies",
  "tenant_marketplace_installations",
];

const GATILHOS = [
  ["contacts", "contacts_publish_created_event"],
  ["contacts", "contacts_publish_pipeline_updated_event"],
  ["contact_merge_log", "contact_merge_log_publish_event"],
  ["deal_stage_history", "deal_stage_history_publish_event"],
  ["messages", "messages_publish_domain_event"],
  ["activities", "activities_publish_completed_event"],
  ["appointments", "appointments_publish_pipeline_event"],
  ["lead_form_submissions", "lead_form_submissions_publish_pipeline_event"],
  ["tenant_integrations", "tenant_integrations_publish_connected_event"],
  ["domain_events", "domain_events_create_deliveries"],
];

const ASSINATURAS = ["kernel.projection", "kernel.observability", "pipeline.agent"];

const NICHOS = {
  "academia-studio": ["agenda", "catalogo"],
  "agencia-marketing": ["meta-ads", "catalogo"],
  "buffet-eventos": ["agenda", "catalogo"],
  "clinica-medica": ["agenda"],
  "clinica-odontologica": ["agenda", "doutore", "catalogo"],
  ecommerce: ["meta-ads", "catalogo"],
  "escola-cursos": ["agenda", "catalogo"],
  "expansao-franquias": ["agenda", "catalogo"],
  generico: [],
  "industria-encomenda": ["companies", "catalogo"],
  "servicos-b2b": ["companies", "catalogo"],
  "varejo-loja": ["meta-ads", "catalogo"],
};

const CATALOGOS = [
  ["Permissões", "permissions", 28],
  ["Capacidades", "capability_catalog", 20],
  ["Integrações", "integrations", 10],
  ["Modelos de nicho", "niche_templates", 12],
  ["Planos", "plan_catalog", 2],
  ["Engines do marketplace", "marketplace_engine_catalog", 8],
];

/** Allowlist de funções SECURITY DEFINER que podem ser chamadas por anon. */
const SECDEF_PUBLICAS = ["get_public_lead_form"];

const linhas = [];
let falhas = 0;
let alertas = 0;

function item(nome, esperado, encontrado, ok, severidade = "falha") {
  if (!ok) {
    if (severidade === "alerta") alertas++;
    else falhas++;
  }
  linhas.push(
    `| ${nome} | ${esperado} | ${encontrado} | ${ok ? "OK" : severidade === "alerta" ? "ALERTA" : "FALHA"} |`,
  );
}

// ---------------------------------------------------------------------------
// 1. Tabelas restauradas
// ---------------------------------------------------------------------------
const existentes = new Set(
  q(
    `select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')`,
  ),
);
const faltando = TABELAS_RESTAURADAS.filter((t) => !existentes.has(t));
item(
  "Tabelas restauradas (eventos, planos, direitos, marketplace)",
  `${TABELAS_RESTAURADAS.length} tabelas`,
  faltando.length ? `faltam: ${faltando.join(", ")}` : "todas presentes",
  faltando.length === 0,
);

// ---------------------------------------------------------------------------
// 2. RLS, políticas e permissões
// ---------------------------------------------------------------------------
const semRls = q(
  `select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and not c.relrowsecurity order by 1`,
);
item(
  "RLS habilitada em toda tabela de public",
  "0 tabelas sem RLS",
  semRls.length ? semRls.join(", ") : "0",
  semRls.length === 0,
);

const semPolitica = q(
  `select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and c.relrowsecurity and not exists (select 1 from pg_policies p where p.schemaname='public' and p.tablename=c.relname) order by 1`,
);
item(
  "Tabelas com RLS mas sem política (trancadas)",
  "0",
  semPolitica.length ? semPolitica.join(", ") : "0",
  semPolitica.length === 0,
);

const updateSemCheck = q(
  `select tablename||'.'||policyname from pg_policies where schemaname='public' and cmd='UPDATE' and with_check is null order by 1`,
);
item(
  "Políticas de UPDATE sem WITH CHECK",
  "0",
  updateSemCheck.length ? updateSemCheck.join(", ") : "0",
  updateSemCheck.length === 0,
);

const semGrantAuth = q(
  `select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and c.relname <> 'domain_event_subscriptions' and not has_table_privilege('authenticated', c.oid, 'SELECT') order by 1`,
);
item(
  "Tabelas sem GRANT de leitura para usuário autenticado",
  "0 (exceto domain_event_subscriptions, restrita de propósito)",
  semGrantAuth.length ? semGrantAuth.join(", ") : "0",
  semGrantAuth.length === 0,
);

// A trava real desta tabela é a política (só service_role). O GRANT residual
// para anon/authenticated não expõe linha nenhuma — por isso é alerta, não
// falha —, mas é resíduo do mesmo grant-geral apontado logo abaixo.
const subsSemPolitica =
  um(
    `select (exists (select 1 from pg_policies where schemaname='public' and tablename='domain_event_subscriptions' and roles::text <> '{service_role}'))::text`,
  ) === "true";
item(
  "domain_event_subscriptions restrita a service_role",
  "nenhuma política para anon/autenticado",
  subsSemPolitica ? "há política para outro papel" : "só service_role",
  !subsSemPolitica,
);

const subsGrantResidual =
  um(`select (has_table_privilege('anon','public.domain_event_subscriptions','SELECT'))::text`) ===
  "true";
item(
  "GRANT residual de leitura em domain_event_subscriptions para anônimo",
  "sem GRANT",
  subsGrantResidual ? "GRANT presente (sem política: 0 linhas legíveis)" : "sem GRANT",
  !subsGrantResidual,
  "alerta",
);

const integracoesLegiveis =
  um(
    `select (exists (select 1 from pg_policies where schemaname='public' and tablename='integrations' and cmd='SELECT'))::text`,
  ) === "true";
item(
  "Catálogo de integrações legível pelo app",
  "política de leitura presente",
  integracoesLegiveis ? "presente" : "ausente",
  integracoesLegiveis,
);

const segredosFechados =
  um(
    `select coalesce(string_agg(distinct roles::text, ','),'') from pg_policies where schemaname='public' and tablename='integration_secrets'`,
  ) === "{service_role}";
item(
  "Segredos de integração fora do alcance do cliente",
  "políticas só para service_role",
  segredosFechados ? "só service_role" : "há política para outro papel",
  segredosFechados,
);

const agentPlatformSemPolitica = q(
  `select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and c.relname like 'agent_platform_%' and not exists (select 1 from pg_policies p where p.schemaname='public' and p.tablename=c.relname) order by 1`,
);

item(
  "Tabelas agent_platform_* com política",
  "todas com política",
  agentPlatformSemPolitica.length ? agentPlatformSemPolitica.join(", ") : "todas com política",
  agentPlatformSemPolitica.length === 0,
);

// Fechado em 11/08/2026 pela migration de REVOKE. Vira FALHA (não mais alerta):
// nenhum caminho do app usa o papel anônimo, então qualquer GRANT aqui é
// regressão, não configuração legítima.
const anonDml = q(
  `select distinct c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join lateral aclexplode(c.relacl) a where n.nspname='public' and c.relkind in ('r','p') and a.grantee='anon'::regrole and a.privilege_type in ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE') order by 1`,
);
item(
  "GRANT de leitura/escrita para o papel anônimo",
  "0 tabelas",
  anonDml.length ? `${anonDml.length} tabelas` : "0",
  anonDml.length === 0,
);

// A torneira: default privileges de `postgres` (papel que roda as migrations).
// `supabase_admin` fica de fora — a plataforma recusa alterar o default dele.
const anonDefaults = q(
  `select distinct a.privilege_type from pg_default_acl d join pg_namespace n on n.oid=d.defaclnamespace cross join lateral aclexplode(d.defaclacl) a where n.nspname='public' and d.defaclrole='postgres'::regrole and d.defaclobjtype in ('r','S') and a.grantee='anon'::regrole order by 1`,
);
item(
  "Privilégios padrão para o papel anônimo em tabela nova",
  "nenhum",
  anonDefaults.length ? anonDefaults.join(", ") : "nenhum",
  anonDefaults.length === 0,
);

const secdefSemPath = q(
  `select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef and (p.proconfig is null or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')) order by 1`,
);
item(
  "Funções SECURITY DEFINER sem search_path fixo",
  "0",
  secdefSemPath.length ? secdefSemPath.join(", ") : "0",
  secdefSemPath.length === 0,
);

const secdefAnon = q(
  `select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef and has_function_privilege('anon', p.oid, 'EXECUTE') order by 1`,
).filter((f) => !SECDEF_PUBLICAS.includes(f));
item(
  "Funções SECURITY DEFINER executáveis por anônimo fora da allowlist",
  "0",
  secdefAnon.length ? secdefAnon.join(", ") : "0",
  secdefAnon.length === 0,
);

// ---------------------------------------------------------------------------
// 3. Gatilhos e assinaturas
// ---------------------------------------------------------------------------
const gatilhosVivos = new Set(
  q(
    `select c.relname||':'||t.tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal`,
  ),
);
const gatilhosFaltando = GATILHOS.filter(([t, g]) => !gatilhosVivos.has(`${t}:${g}`));
item(
  "Gatilhos de publicação de evento",
  `${GATILHOS.length} gatilhos`,
  gatilhosFaltando.length
    ? `faltam: ${gatilhosFaltando.map(([t, g]) => `${t}.${g}`).join(", ")}`
    : "todos presentes",
  gatilhosFaltando.length === 0,
);

const assinaturasVivas = new Set(
  q(`select subscriber_id from public.domain_event_subscriptions where active`),
);
const assinaturasFaltando = ASSINATURAS.filter((s) => !assinaturasVivas.has(s));
item(
  "Assinaturas de evento ativas (inclui pipeline.agent)",
  ASSINATURAS.join(", "),
  assinaturasFaltando.length ? `faltam: ${assinaturasFaltando.join(", ")}` : "todas ativas",
  assinaturasFaltando.length === 0,
);

// ---------------------------------------------------------------------------
// 4. Nichos e catálogos
// ---------------------------------------------------------------------------
const nichosVivos = Object.fromEntries(
  q(`select slug||'\t'||coalesce(plugins::text,'[]') from public.niche_templates`).map((l) => {
    const [slug, plugins] = l.split("\t");
    return [slug, JSON.parse(plugins)];
  }),
);
const nichosDivergentes = Object.entries(NICHOS).filter(([slug, esperado]) => {
  const atual = nichosVivos[slug];
  if (!atual) return true;
  return [...atual].sort().join(",") !== [...esperado].sort().join(",");
});
item(
  "Modelos de nicho com os plugins do baseline",
  "12 nichos conferindo",
  nichosDivergentes.length
    ? `divergem: ${nichosDivergentes.map(([s]) => s).join(", ")}`
    : "12 conferindo",
  nichosDivergentes.length === 0,
);

for (const [nome, tabela, minimo] of CATALOGOS) {
  const total = Number(um(`select count(*) from public.${tabela}`));
  item(`Catálogo — ${nome}`, `>= ${minimo}`, String(total), total >= minimo);
}

// ---------------------------------------------------------------------------
// Escrita do relatório
// ---------------------------------------------------------------------------
const agora = new Date().toISOString().slice(0, 16).replace("T", " ");
const veredito =
  falhas === 0 && alertas === 0
    ? "Backend em paridade com o baseline do AceleraFlow."
    : falhas === 0
      ? "Paridade estrutural completa; há alertas de endurecimento a decidir."
      : "Há divergências de paridade a corrigir.";

const doc = `# Paridade com o AceleraFlow — status do backend

Gerado por \`node scripts/paridade-status.mjs\` em ${agora} UTC, lendo o backend real
(somente leitura). Baseline: comparação de 2026-08-11.

**Placar:** ${linhas.length - falhas - alertas} OK · ${alertas} alerta(s) · ${falhas} falha(s)

**Veredito:** ${veredito}

| Item | Esperado | Encontrado | Situação |
| --- | --- | --- | --- |
${linhas.join("\n")}

## Como reexecutar

\`\`\`bash
node scripts/paridade-status.mjs      # este relatório, contra o backend real
pnpm test:db                          # mesmas regras como pgTAP, no banco local
pnpm test:e2e -- rbac-smoke           # smoke de papéis no navegador
\`\`\`

## Leitura das colunas

- **FALHA** — divergência de paridade ou regra de segurança quebrada; corrigir com migration própria.
- **ALERTA** — configuração mais frouxa que o baseline, sem exposição comprovada de dado
  (RLS ainda barra as linhas), mas que deve ser endurecida.
`;

mkdirSync(dirname(SAIDA), { recursive: true });
writeFileSync(SAIDA, doc);
console.log(doc);
console.log(`\nRelatório escrito em ${SAIDA}`);
process.exitCode = falhas > 0 ? 1 : 0;
