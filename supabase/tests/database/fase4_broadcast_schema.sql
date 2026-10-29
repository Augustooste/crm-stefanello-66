-- Fase 4 (user story C) — broadcast/templates agendados: schema + RLS.
-- Roda contra o shadow DB local (supabase test db --local; pnpm test:db),
-- que reaplica todas as migrations do zero -- não toca a DB real do
-- Lovable. NÃO rodar aqui agora (decisão explícita: 4 agentes de schema em
-- paralelo compartilham a Postgres local; execução fica pro agente de
-- sincronização depois que os 4 grupos da Fase 4 terminarem).
begin;
create extension if not exists pgtap;

select plan(19);

-- =============================================================================
-- 1. Extensão de messaging_templates (Fase 3) -- colunas novas + regressão
-- =============================================================================
select has_column('public', 'messaging_templates', 'kind', 'messaging_templates.kind existe');
select has_column('public', 'messaging_templates', 'provider_template_name', 'messaging_templates.provider_template_name existe');

-- Fixture: 2 tenants via handle_new_user (trigger em auth.users).
insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin-a-broadcast@test.local'),
  ('44444444-4444-4444-4444-444444444444', 'admin-b-broadcast@test.local');

-- Regressão: insert sem channel_id e sem kind continua funcionando --
-- channel_id NÃO virou NOT NULL, kind assume o default 'freeform'.
insert into public.messaging_templates (tenant_id, name, body, created_by)
select tenant_id, 'tpl-a', 'corpo a', '33333333-3333-3333-3333-333333333333'
from public.profiles where id = '33333333-3333-3333-3333-333333333333';

select is(
  (select kind from public.messaging_templates where name = 'tpl-a'),
  'freeform',
  'kind assume default freeform quando não informado'
);
select ok(
  (select channel_id from public.messaging_templates where name = 'tpl-a') is null,
  'channel_id continua NULLABLE -- insert sem channel_id funciona (regressão: não virou NOT NULL)'
);

-- Check constraint: kind só aceita freeform/provider_approved.
-- pgTAP: throws_ok(sql, errcode, errmsg, description) — a forma de 3 args
-- (sql, texto5bytes, texto) resolve o 3º argumento como ERRMSG (comparado
-- literalmente contra SQLERRM), não como description. Usar a forma completa
-- de 4 args com errmsg=NULL para checar só o SQLSTATE (23514 =
-- check_violation) e dar a description certa no 4º parâmetro.
select throws_ok(
  $$insert into public.messaging_templates (tenant_id, name, body, kind)
    select tenant_id, 'tpl-invalid', 'corpo', 'nao_existe' from public.profiles
    where id = '33333333-3333-3333-3333-333333333333'$$,
  '23514',
  NULL,
  'kind fora de (freeform, provider_approved) é rejeitado pelo check constraint'
);

-- =============================================================================
-- 2. Tabelas novas + RLS habilitada (nunca FORCE -- convenção real do projeto)
-- =============================================================================
select has_table('public', 'template_schedules', 'tabela template_schedules existe');
select has_table('public', 'template_schedule_executions', 'tabela template_schedule_executions existe');

select ok(
  (select relrowsecurity from pg_class where oid = 'public.template_schedules'::regclass),
  'RLS habilitada em template_schedules'
);
select ok(
  not (select relforcerowsecurity from pg_class where oid = 'public.template_schedules'::regclass),
  'RLS NÃO forçada em template_schedules (convenção real do projeto)'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.template_schedule_executions'::regclass),
  'RLS habilitada em template_schedule_executions'
);
select ok(
  not (select relforcerowsecurity from pg_class where oid = 'public.template_schedule_executions'::regclass),
  'RLS NÃO forçada em template_schedule_executions (convenção real do projeto)'
);

select has_index('public', 'template_schedule_executions', 'tse_claimable_idx', 'índice parcial de claim do worker existe');

-- Nenhuma policy de INSERT/UPDATE para authenticated em
-- template_schedule_executions -- só o worker (service_role) escreve.
select is(
  (select count(*)::int from pg_policies
    where tablename = 'template_schedule_executions' and cmd = 'INSERT' and 'authenticated' = any(roles)),
  0,
  'nenhuma policy de INSERT para authenticated em template_schedule_executions'
);
select is(
  (select count(*)::int from pg_policies
    where tablename = 'template_schedule_executions' and cmd = 'UPDATE' and 'authenticated' = any(roles)),
  0,
  'nenhuma policy de UPDATE para authenticated em template_schedule_executions'
);

-- =============================================================================
-- 3. RLS comportamental: isolamento de tenant + UPDATE/DELETE só em 'pending'
-- =============================================================================
insert into public.template_schedules (tenant_id, template_id, scheduled_for, status)
select p.tenant_id, t.id, now() + interval '1 day', 'pending'
from public.profiles p
join public.messaging_templates t on t.tenant_id = p.tenant_id
where p.id = '33333333-3333-3333-3333-333333333333';

insert into public.messaging_templates (tenant_id, name, body, created_by)
select tenant_id, 'tpl-b', 'corpo b', '44444444-4444-4444-4444-444444444444'
from public.profiles where id = '44444444-4444-4444-4444-444444444444';

insert into public.template_schedules (tenant_id, template_id, scheduled_for, status)
select p.tenant_id, t.id, now() + interval '1 day', 'completed'
from public.profiles p
join public.messaging_templates t on t.tenant_id = p.tenant_id
where p.id = '44444444-4444-4444-4444-444444444444';

select set_config(
  'request.jwt.claims',
  json_build_object('sub', '33333333-3333-3333-3333-333333333333', 'role', 'authenticated')::text,
  false
);
set local role authenticated;

-- Isolamento: admin A só vê o próprio agendamento (tenant A), não o do
-- tenant B.
select is(
  (select count(*)::int from public.template_schedules),
  1,
  'admin A vê só 1 template_schedules (o próprio, não o do tenant B)'
);

-- UPDATE em agendamento 'pending' do próprio tenant funciona -- mantendo
-- status='pending' (USING e WITH CHECK exigem status='pending' na policy;
-- editar um campo qualquer sem tocar status passa em ambos).
update public.template_schedules set audience_filter = '{"tag": "vip"}'::jsonb
  where template_id in (
    select id from public.messaging_templates where name = 'tpl-a'
  );
select is(
  (select audience_filter from public.template_schedules ts
    join public.messaging_templates t on t.id = ts.template_id
    where t.name = 'tpl-a'),
  '{"tag": "vip"}'::jsonb,
  'UPDATE em agendamento pending do próprio tenant funciona (campo editável, status inalterado)'
);

-- UPDATE que tenta mudar o status pra fora de 'pending' é bloqueado pela
-- própria WITH CHECK da policy (RLS 42501, insufficient_privilege) -- essa
-- transição é reservada ao worker (service_role), nunca ao authenticated
-- direto (mesma lição aprendida na Fase 3: UPDATE direto bypassa a
-- auditoria/regra de negócio da transição de estado).
select throws_ok(
  $$update public.template_schedules set status = 'running'
    where template_id in (
      select id from public.messaging_templates where name = 'tpl-a'
    )$$,
  '42501',
  NULL,
  'UPDATE que muda status para fora de pending é bloqueado por RLS (WITH CHECK)'
);

reset role;

-- Fixture extra: agendamento 'completed' do tenant A (pra testar bloqueio de
-- UPDATE/DELETE quando o status não é mais 'pending').
insert into public.template_schedules (tenant_id, template_id, scheduled_for, status)
select p.tenant_id, t.id, now() - interval '1 day', 'completed'
from public.profiles p
join public.messaging_templates t on t.tenant_id = p.tenant_id
where p.id = '33333333-3333-3333-3333-333333333333' and t.name = 'tpl-a';

select set_config(
  'request.jwt.claims',
  json_build_object('sub', '33333333-3333-3333-3333-333333333333', 'role', 'authenticated')::text,
  false
);
set local role authenticated;

-- UPDATE direto num agendamento 'completed' não muda nada -- RLS filtra
-- pela condição status = 'pending' no USING/WITH CHECK, não lança exceção.
update public.template_schedules set sent_count = 999 where status = 'completed';
select is(
  (select sent_count from public.template_schedules where status = 'completed'),
  0,
  'UPDATE em agendamento completed não muda nada (policy só permite status=pending)'
);

-- DELETE direto num agendamento 'completed' também não afeta nada (mesma
-- condição status = 'pending' na policy de DELETE).
delete from public.template_schedules where status = 'completed';
select is(
  (select count(*)::int from public.template_schedules where status = 'completed'),
  1,
  'DELETE em agendamento completed não remove nada (policy só permite status=pending)'
);

reset role;

select * from finish();
rollback;
