-- Fase 4 (user story F) — weekly digest: schema + RLS.
-- Roda contra o shadow DB local (supabase test db --local; pnpm test:db),
-- que reaplica todas as migrations do zero -- não toca a DB real do
-- Lovable. NÃO rodar aqui agora (decisão explícita: agentes de schema em
-- paralelo compartilham a Postgres local; execução fica pro agente de
-- sincronização depois que todos os grupos da Fase 4 terminarem).
begin;
create extension if not exists pgtap;

select plan(22);

-- =============================================================================
-- 1. Tabelas + RLS habilitada (nunca FORCE -- convenção real do projeto)
-- =============================================================================
select has_table('public', 'weekly_report_recipients', 'tabela weekly_report_recipients existe');
select has_table('public', 'weekly_reports', 'tabela weekly_reports existe');
select has_table('public', 'weekly_report_deliveries', 'tabela weekly_report_deliveries existe');

select ok(
  (select relrowsecurity from pg_class where oid = 'public.weekly_report_recipients'::regclass),
  'RLS habilitada em weekly_report_recipients'
);
select ok(
  not (select relforcerowsecurity from pg_class where oid = 'public.weekly_report_recipients'::regclass),
  'RLS NÃO forçada em weekly_report_recipients (convenção real do projeto)'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.weekly_reports'::regclass),
  'RLS habilitada em weekly_reports'
);
select ok(
  not (select relforcerowsecurity from pg_class where oid = 'public.weekly_reports'::regclass),
  'RLS NÃO forçada em weekly_reports (convenção real do projeto)'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.weekly_report_deliveries'::regclass),
  'RLS habilitada em weekly_report_deliveries'
);
select ok(
  not (select relforcerowsecurity from pg_class where oid = 'public.weekly_report_deliveries'::regclass),
  'RLS NÃO forçada em weekly_report_deliveries (convenção real do projeto)'
);

-- Nenhuma policy de INSERT/UPDATE para authenticated em weekly_reports e
-- weekly_report_deliveries -- só o digest-generator (service_role) escreve.
select is(
  (select count(*)::int from pg_policies
    where tablename = 'weekly_reports' and cmd = 'INSERT' and 'authenticated' = any(roles)),
  0,
  'nenhuma policy de INSERT para authenticated em weekly_reports'
);
select is(
  (select count(*)::int from pg_policies
    where tablename = 'weekly_reports' and cmd = 'UPDATE' and 'authenticated' = any(roles)),
  0,
  'nenhuma policy de UPDATE para authenticated em weekly_reports'
);
select is(
  (select count(*)::int from pg_policies
    where tablename = 'weekly_report_deliveries' and cmd = 'INSERT' and 'authenticated' = any(roles)),
  0,
  'nenhuma policy de INSERT para authenticated em weekly_report_deliveries'
);
select is(
  (select count(*)::int from pg_policies
    where tablename = 'weekly_report_deliveries' and cmd = 'UPDATE' and 'authenticated' = any(roles)),
  0,
  'nenhuma policy de UPDATE para authenticated em weekly_report_deliveries'
);

-- =============================================================================
-- 2. Fixtures: 2 tenants via handle_new_user (trigger em auth.users).
-- =============================================================================
insert into auth.users (id, email) values
  ('55555555-5555-5555-5555-555555555555', 'admin-a-digest@test.local'),
  ('66666666-6666-6666-6666-666666666666', 'admin-b-digest@test.local');

-- Fixture: 1 destinatário por tenant.
insert into public.weekly_report_recipients (tenant_id, channel, address, name)
select tenant_id, 'email', 'gestor-a@test.local', 'Gestor A'
from public.profiles where id = '55555555-5555-5555-5555-555555555555';

insert into public.weekly_report_recipients (tenant_id, channel, address, name)
select tenant_id, 'email', 'gestor-b@test.local', 'Gestor B'
from public.profiles where id = '66666666-6666-6666-6666-666666666666';

-- Fixture: 1 relatório por tenant (mesma janela, tenants diferentes).
insert into public.weekly_reports (tenant_id, period_start, period_end, metrics)
select tenant_id, '2026-07-01T00:00:00Z'::timestamptz, '2026-07-07T23:59:59Z'::timestamptz, '{"deals_won": 3}'::jsonb
from public.profiles where id = '55555555-5555-5555-5555-555555555555';

insert into public.weekly_reports (tenant_id, period_start, period_end, metrics)
select tenant_id, '2026-07-01T00:00:00Z'::timestamptz, '2026-07-07T23:59:59Z'::timestamptz, '{"deals_won": 1}'::jsonb
from public.profiles where id = '66666666-6666-6666-6666-666666666666';

-- Fixture: 1 entrega por tenant (relatório + destinatário do próprio tenant).
insert into public.weekly_report_deliveries (report_id, recipient_id, channel, address)
select wr.id, rc.id, rc.channel, rc.address
from public.profiles p
join public.weekly_reports wr on wr.tenant_id = p.tenant_id
join public.weekly_report_recipients rc on rc.tenant_id = p.tenant_id
where p.id = '55555555-5555-5555-5555-555555555555';

insert into public.weekly_report_deliveries (report_id, recipient_id, channel, address)
select wr.id, rc.id, rc.channel, rc.address
from public.profiles p
join public.weekly_reports wr on wr.tenant_id = p.tenant_id
join public.weekly_report_recipients rc on rc.tenant_id = p.tenant_id
where p.id = '66666666-6666-6666-6666-666666666666';

-- =============================================================================
-- 3. Unique constraints -- teste comportamental (throws_ok, SQLSTATE 23505).
--    pgTAP: throws_ok(sql, errcode, errmsg, description) -- a forma de 3 args
--    (sql, texto5bytes, texto) resolve o 3º argumento como ERRMSG (comparado
--    literalmente contra SQLERRM), não como description. Usar a forma
--    completa de 4 args com errmsg=NULL para checar só o SQLSTATE
--    (23505 = unique_violation) e dar a description certa no 4º parâmetro
--    (mesmo padrão de fase4_broadcast_schema.sql).
-- =============================================================================
select throws_ok(
  $$insert into public.weekly_reports (tenant_id, period_start, period_end, metrics)
    select tenant_id, '2026-07-01T00:00:00Z'::timestamptz, '2026-07-07T23:59:59Z'::timestamptz, '{}'::jsonb
    from public.profiles where id = '55555555-5555-5555-5555-555555555555'$$,
  '23505',
  NULL,
  'unique(tenant_id, period_start, period_end) rejeita relatório duplicado da mesma janela'
);

select throws_ok(
  $$insert into public.weekly_report_deliveries (report_id, recipient_id, channel, address)
    select wr.id, rc.id, rc.channel, rc.address
    from public.profiles p
    join public.weekly_reports wr on wr.tenant_id = p.tenant_id
    join public.weekly_report_recipients rc on rc.tenant_id = p.tenant_id
    where p.id = '55555555-5555-5555-5555-555555555555'$$,
  '23505',
  NULL,
  'unique(report_id, recipient_id) rejeita entrega duplicada pro mesmo destinatário'
);

-- =============================================================================
-- 4. RLS comportamental: isolamento de tenant (SELECT) + admin all.
-- =============================================================================
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '55555555-5555-5555-5555-555555555555', 'role', 'authenticated')::text,
  false
);
set local role authenticated;

select is(
  (select count(*)::int from public.weekly_report_recipients),
  1,
  'admin A vê só 1 weekly_report_recipients (o próprio, não o do tenant B)'
);
select is(
  (select count(*)::int from public.weekly_reports),
  1,
  'admin A vê só 1 weekly_reports (o próprio, não o do tenant B)'
);
select is(
  (select count(*)::int from public.weekly_report_deliveries),
  1,
  'admin A vê só 1 weekly_report_deliveries (a própria, não a do tenant B)'
);

-- Admin (is_admin) consegue INSERT em weekly_report_recipients do próprio
-- tenant -- confirma que a policy "admin all" concede acesso, não só que o
-- não-admin é bloqueado.
insert into public.weekly_report_recipients (tenant_id, channel, address, name)
select tenant_id, 'whatsapp', '+5511999999999', 'Gestor A (WhatsApp)'
from public.profiles where id = '55555555-5555-5555-5555-555555555555';

select is(
  (select count(*)::int from public.weekly_report_recipients),
  2,
  'admin A consegue INSERT em weekly_report_recipients do próprio tenant (policy admin all)'
);

reset role;

-- =============================================================================
-- 5. Fixture: profile NÃO-ADMIN (role='agent') no MESMO tenant do admin A,
--    via invite -- a versão final de handle_new_user exige
--    raw_user_meta_data->>'invite_token' batendo com invites.token (mesmo
--    padrão de fase3_hitl_rls.sql).
-- =============================================================================
insert into public.invites (tenant_id, email, role, token)
select tenant_id, 'agent-a-digest@test.local', 'agent', 'test-invite-token-digest'
from public.profiles where id = '55555555-5555-5555-5555-555555555555';

insert into auth.users (id, email, raw_user_meta_data) values
  ('77777777-7777-7777-7777-777777777777', 'agent-a-digest@test.local', jsonb_build_object('invite_token', 'test-invite-token-digest'));

select is(
  (select role from public.profiles where id = '77777777-7777-7777-7777-777777777777'),
  'agent',
  'fixture: agent-a-digest vira profile role=agent (não-admin) via invite aceito'
);
select is(
  (select tenant_id from public.profiles where id = '77777777-7777-7777-7777-777777777777'),
  (select tenant_id from public.profiles where id = '55555555-5555-5555-5555-555555555555'),
  'fixture: agent-a-digest fica no MESMO tenant do admin A que convidou'
);

-- Não-admin (agent) é bloqueado de escrever em weekly_report_recipients --
-- policy "weekly_report_recipients admin all" exige is_admin().
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '77777777-7777-7777-7777-777777777777', 'role', 'authenticated')::text,
  false
);
set local role authenticated;

select throws_ok(
  $$
    insert into public.weekly_report_recipients (tenant_id, channel, address, name)
    select tenant_id, 'email', 'agent-attempt@test.local', 'Agent Attempt'
    from public.profiles where id = '77777777-7777-7777-7777-777777777777'
  $$,
  '42501',
  NULL,
  'não-admin (agent) é bloqueado de INSERT em weekly_report_recipients (RLS exige is_admin)'
);

reset role;

select * from finish();
rollback;
