-- Fase 6 (Sub-feature 1) — appointments: schema + RLS + niche_templates
-- broadened read policy. Roda contra o shadow DB local (supabase test db
-- --local; pnpm test:db), que reaplica todas as migrations do zero -- não
-- toca a DB real do Lovable.
begin;
create extension if not exists pgtap;

select plan(15);

-- =============================================================================
-- 1. niche_templates read: broadened para authenticated geral (não mais
-- admin-only) -- pré-requisito desta sub-feature.
-- =============================================================================
select is(
  (select count(*)::int from pg_policies
    where tablename = 'niche_templates' and cmd = 'SELECT' and 'authenticated' = any(roles)),
  1,
  'niche_templates tem exatamente 1 policy de SELECT para authenticated'
);
select is(
  (select qual from pg_policies
    where tablename = 'niche_templates' and cmd = 'SELECT' and 'authenticated' = any(roles)),
  '(auth.uid() IS NOT NULL)',
  'niche_templates SELECT não exige mais is_admin() -- qualquer authenticated lê o catálogo'
);

-- =============================================================================
-- 2. appointments: tabela + colunas + RLS habilitada (nunca FORCE)
-- =============================================================================
select has_table('public', 'appointments', 'tabela appointments existe');
select has_column('public', 'appointments', 'tenant_id', 'appointments.tenant_id existe');
select has_column('public', 'appointments', 'contact_id', 'appointments.contact_id existe');
select has_column('public', 'appointments', 'modality', 'appointments.modality existe');
select has_column('public', 'appointments', 'status', 'appointments.status existe');
select has_column('public', 'appointments', 'external_ref', 'appointments.external_ref existe');

select ok(
  (select relrowsecurity from pg_class where oid = 'public.appointments'::regclass),
  'RLS habilitada em appointments'
);
select ok(
  not (select relforcerowsecurity from pg_class where oid = 'public.appointments'::regclass),
  'RLS NÃO forçada em appointments (convenção real do projeto)'
);

-- =============================================================================
-- 3. Check constraints: modality / status rejeitam valores fora do enum
-- =============================================================================
insert into auth.users (id, email) values
  ('55555555-5555-5555-5555-555555555555', 'admin-a-agenda@test.local'),
  ('66666666-6666-6666-6666-666666666666', 'admin-b-agenda@test.local');

select throws_ok(
  $$insert into public.appointments (tenant_id, title, date, time_start, modality)
    select tenant_id, 'compromisso inválido', current_date, '10:00', 'presencial-invalido'
    from public.profiles where id = '55555555-5555-5555-5555-555555555555'$$,
  '23514',
  NULL,
  'modality fora de (presencial, online) é rejeitado pelo check constraint'
);

select throws_ok(
  $$insert into public.appointments (tenant_id, title, date, time_start, status)
    select tenant_id, 'compromisso inválido', current_date, '10:00', 'status_invalido'
    from public.profiles where id = '55555555-5555-5555-5555-555555555555'$$,
  '23514',
  NULL,
  'status fora do enum é rejeitado pelo check constraint'
);

-- =============================================================================
-- 4. Índice de dedupe parcial: mesmo (tenant, external_source, external_ref)
-- conflita; múltiplos external_ref NULL convivem (arbiter parcial).
-- =============================================================================
insert into public.appointments (tenant_id, title, date, time_start, external_source, external_ref)
select tenant_id, 'sync feegow 1', current_date, '09:00', 'feegow', 'ext-1'
from public.profiles where id = '55555555-5555-5555-5555-555555555555';

select throws_ok(
  $$insert into public.appointments (tenant_id, title, date, time_start, external_source, external_ref)
    select tenant_id, 'sync feegow 1 duplicado', current_date, '09:00', 'feegow', 'ext-1'
    from public.profiles where id = '55555555-5555-5555-5555-555555555555'$$,
  '23505',
  NULL,
  'segundo insert com o mesmo (tenant, external_source, external_ref) conflita (dedupe)'
);

insert into public.appointments (tenant_id, title, date, time_start)
select tenant_id, 'nativo 1', current_date, '11:00'
from public.profiles where id = '55555555-5555-5555-5555-555555555555';
insert into public.appointments (tenant_id, title, date, time_start)
select tenant_id, 'nativo 2', current_date, '12:00'
from public.profiles where id = '55555555-5555-5555-5555-555555555555';

select is(
  (select count(*)::int from public.appointments where external_ref is null),
  2,
  'múltiplos compromissos nativos com external_ref NULL convivem (arbiter parcial não os alcança)'
);

-- =============================================================================
-- 5. RLS comportamental: isolamento por tenant
-- =============================================================================
insert into public.appointments (tenant_id, title, date, time_start)
select tenant_id, 'compromisso tenant b', current_date, '14:00'
from public.profiles where id = '66666666-6666-6666-6666-666666666666';

select set_config(
  'request.jwt.claims',
  json_build_object('sub', '55555555-5555-5555-5555-555555555555', 'role', 'authenticated')::text,
  false
);
set local role authenticated;

-- tenant A tem 3 linhas próprias (ext-1 + nativo 1 + nativo 2) -- a 4ª linha
-- inserida (compromisso tenant b) pertence ao tenant B e não deve aparecer.
select is(
  (select count(*)::int from public.appointments),
  3,
  'admin A só vê os 3 compromissos do próprio tenant, não o do tenant B'
);

reset role;

select * from finish();
rollback;
