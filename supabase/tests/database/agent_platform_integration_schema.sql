-- Contrato de banco da integração provedor de agentes (migration 20260731170000).
--
-- O que este teste protege: as quatro tabelas são SERVER-ONLY. Se alguém der
-- grant para authenticated (ou o Supabase criar a tabela já aberta, como
-- acontece por padrão), a auditoria e os vínculos de tenant passariam a ser
-- legíveis pelo cliente com o token do usuário — e o RLS sem policy deixaria
-- de ser a única barreira.
begin;
create extension if not exists pgtap;

select plan(38);

-- ---------------------------------------------------------------- estrutura
select has_table('public', 'agent_platform_agent_links', 'tabela de vínculo de agente existe');
select has_table('public', 'agent_platform_channel_links', 'tabela de vínculo de canal existe');
select has_table('public', 'agent_platform_audit_log', 'tabela de auditoria existe');
select has_table('public', 'agent_platform_training_events', 'tabela de callbacks de treinamento existe');

select has_column('public', 'agent_platform_agent_links', 'tenant_id', 'vínculo de agente tem tenant_id');
select has_column(
  'public', 'agent_platform_agent_links', 'platform_agent_id', 'vínculo de agente tem o id remoto'
);
select has_column(
  'public',
  'agent_platform_agent_links',
  'platform_workspace_id',
  'vínculo de agente guarda o workspace'
);
select has_column(
  'public', 'agent_platform_agent_links', 'last_sync_at', 'vínculo de agente registra última sincronia'
);
select has_column(
  'public', 'agent_platform_channel_links', 'channel_type', 'vínculo de canal guarda o tipo do canal'
);
select has_column(
  'public', 'agent_platform_channel_links', 'platform_agent_id', 'vínculo de canal aponta para o agente'
);
select has_column(
  'public', 'agent_platform_audit_log', 'correlation_id', 'auditoria tem correlation_id'
);
select has_column('public', 'agent_platform_audit_log', 'resource_type', 'auditoria tem resource_type');
select has_column('public', 'agent_platform_audit_log', 'action', 'auditoria tem action');
select has_column('public', 'agent_platform_training_events', 'dedupe_key', 'callback tem dedupe_key');

-- Auditoria NÃO pode ter coluna de payload/credencial (regra do escopo: nunca
-- registrar payload completo com token, header ou dado pessoal).
select hasnt_column(
  'public', 'agent_platform_audit_log', 'payload', 'auditoria não guarda payload'
);

-- --------------------------------------------------------------- unicidade
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.agent_platform_agent_links'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) like '%(tenant_id, platform_agent_id)%'
  ),
  'agente é único por tenant'
);
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.agent_platform_channel_links'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) like '%(tenant_id, platform_channel_id)%'
  ),
  'canal é único por tenant'
);
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.agent_platform_training_events'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) like '%(tenant_id, dedupe_key)%'
  ),
  'callback repetido é idempotente por (tenant_id, dedupe_key)'
);

-- --------------------------------------------------------------------- RLS
select ok(
  (select relrowsecurity from pg_class where oid = 'public.agent_platform_agent_links'::regclass),
  'RLS habilitado em agent_platform_agent_links'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.agent_platform_channel_links'::regclass),
  'RLS habilitado em agent_platform_channel_links'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.agent_platform_audit_log'::regclass),
  'RLS habilitado em agent_platform_audit_log'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.agent_platform_training_events'::regclass),
  'RLS habilitado em agent_platform_training_events'
);

-- Sem policy = nega por padrão. É intencional: quem lê/escreve é a edge
-- function com service_role.
select is(
  (
    select count(*)::integer
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'agent_platform_agent_links',
        'agent_platform_channel_links',
        'agent_platform_audit_log',
        'agent_platform_training_events'
      )
      and roles && array['authenticated', 'anon', 'public']::name[]
  ),
  0,
  'nenhuma policy para authenticated/anon nas tabelas do provedor de agentes'
);

-- ------------------------------------------------------------------ GRANTs
select table_privs_are(
  'public', 'agent_platform_agent_links', 'authenticated', array[]::text[],
  'authenticated não tem privilégio em agent_platform_agent_links'
);
select table_privs_are(
  'public', 'agent_platform_agent_links', 'anon', array[]::text[],
  'anon não tem privilégio em agent_platform_agent_links'
);
select table_privs_are(
  'public', 'agent_platform_channel_links', 'authenticated', array[]::text[],
  'authenticated não tem privilégio em agent_platform_channel_links'
);
select table_privs_are(
  'public', 'agent_platform_audit_log', 'authenticated', array[]::text[],
  'authenticated não tem privilégio em agent_platform_audit_log'
);
select table_privs_are(
  'public', 'agent_platform_training_events', 'authenticated', array[]::text[],
  'authenticated não tem privilégio em agent_platform_training_events'
);
-- As 4 tabelas conferem o conjunto EXATO de service_role, não só o do audit log:
-- o `alter default privileges` do Supabase entrega ALL em tabela nova, então sem
-- `revoke ... from service_role` na migration sobram TRUNCATE/REFERENCES/TRIGGER.
-- Asserção só no audit log deixaria as outras três drifta­rem em silêncio.
select table_privs_are(
  'public', 'agent_platform_audit_log', 'service_role', array['SELECT', 'INSERT'],
  'service_role só lê e insere auditoria (auditoria não se apaga)'
);
select table_privs_are(
  'public', 'agent_platform_agent_links', 'service_role',
  array['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  'service_role tem exatamente CRUD em agent_platform_agent_links (sem TRUNCATE)'
);
select table_privs_are(
  'public', 'agent_platform_channel_links', 'service_role',
  array['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  'service_role tem exatamente CRUD em agent_platform_channel_links (sem TRUNCATE)'
);
select table_privs_are(
  'public', 'agent_platform_training_events', 'service_role',
  array['SELECT', 'INSERT', 'UPDATE'],
  'service_role não apaga evento de treinamento (sem DELETE nem TRUNCATE)'
);
select table_privs_are(
  'public', 'agent_platform_audit_log', 'anon', array[]::text[],
  'anon não tem privilégio em agent_platform_audit_log'
);
select table_privs_are(
  'public', 'agent_platform_channel_links', 'anon', array[]::text[],
  'anon não tem privilégio em agent_platform_channel_links'
);
select table_privs_are(
  'public', 'agent_platform_training_events', 'anon', array[]::text[],
  'anon não tem privilégio em agent_platform_training_events'
);

-- ---------------------------------------------------------------- catálogo
-- OCULTA, não removida (2026-08-04): a linha continua no catálogo e volta com
-- um UPDATE quando a área estiver pronta. As duas asserções abaixo são o par
-- que prova isso — se alguém deletar a linha, a primeira falha; se alguém
-- religar sem virar `AGENTES_IA_HABILITADO`, a segunda falha e o card volta
-- sozinho na tela.
select is(
  (select count(*)::integer from public.integrations where slug = 'agent-platform'),
  1,
  'integração agent-platform continua no catálogo (oculta, não removida)'
);
select is(
  (select count(*)::integer from public.integrations where slug = 'agent-platform' and available),
  0,
  'integração agent-platform está indisponível — área oculta enquanto incompleta'
);
select ok(
  (
    select bool_and(key = any (array['api_token', 'workspace_id']))
    from public.integrations,
      jsonb_array_elements(required_secrets) as f(item),
      lateral (select item ->> 'key') as k(key)
    where slug = 'agent-platform'
  ),
  'agent-platform pede exatamente api_token e workspace_id'
);

select * from finish();
rollback;
