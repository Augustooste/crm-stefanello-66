begin;
create extension if not exists pgtap;

select plan(21);

select has_table('public', 'capability_catalog', 'capability_catalog existe');
select has_table('public', 'tenant_entitlements', 'tenant_entitlements existe');
select has_function('public', 'has_capability', array['text'], 'has_capability(text) existe');
select has_function('public', 'get_my_capabilities', array[]::text[], 'get_my_capabilities() existe');
select is((select count(*)::int from public.capability_catalog where legacy_plugin_slug is not null), 6, 'plugins legados estão mapeados');

insert into auth.users (id, email) values
  ('a1000000-0000-0000-0000-000000000001', 'entitlement-admin-a@test.local'),
  ('b1000000-0000-0000-0000-000000000001', 'entitlement-admin-b@test.local');

update public.tenants
set niche = 'buffet-eventos', business_profile = '{}'::jsonb
where id = (select tenant_id from public.profiles where id = 'a1000000-0000-0000-0000-000000000001');

select set_config('request.jwt.claims', json_build_object(
  'sub', 'a1000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, false);
set local role authenticated;

select ok(public.has_capability('calendar.agenda'), 'fallback legado mantém agenda default do nicho');
select is(public.has_capability('crm.companies'), false, 'capability sem grant/default falha fechada');
select is(public.has_capability('capability.inexistente'), false, 'capability desconhecida falha fechada');
select is((select count(*)::int from public.tenant_entitlements), 0, 'tenant A não vê entitlements inexistentes/de outro tenant');

select throws_ok(
  $$insert into public.tenant_entitlements (tenant_id, capability_key)
    select tenant_id, 'crm.companies' from public.profiles
    where id = 'a1000000-0000-0000-0000-000000000001'$$,
  'permission denied for table tenant_entitlements',
  'admin do tenant não pode conceder entitlement comercial'
);
reset role;

insert into public.tenant_entitlements (tenant_id, capability_key, enabled, source)
select tenant_id, 'calendar.agenda', false, 'test'
from public.profiles where id = 'a1000000-0000-0000-0000-000000000001';
insert into public.tenant_entitlements (tenant_id, capability_key, enabled, source)
select tenant_id, 'crm.companies', true, 'test'
from public.profiles where id = 'a1000000-0000-0000-0000-000000000001';
-- automation.nurture (não crm.catalog): capability_catalog não mapeia
-- automation.nurture a nenhum legacy_plugin_slug e ela não está no allowlist
-- "sempre ligado" de has_capability(), então sem entitlement explícito ela
-- fica fail-closed de verdade. crm.catalog tem legacy_plugin_slug='catalogo'
-- e o nicho 'buffet-eventos' do tenant A liga esse plugin por padrão (ver
-- 20260714150000_crm_products_v1.sql) -- usá-la aqui testaria o default do
-- nicho, não vazamento entre tenants.
insert into public.tenant_entitlements (tenant_id, capability_key, enabled, source)
select tenant_id, 'automation.nurture', true, 'test'
from public.profiles where id = 'b1000000-0000-0000-0000-000000000001';
insert into public.tenant_entitlements (tenant_id, capability_key, enabled, source, expires_at)
select tenant_id, 'integrations.meta_ads', true, 'test', now() - interval '1 minute'
from public.profiles where id = 'a1000000-0000-0000-0000-000000000001';

select set_config('request.jwt.claims', json_build_object(
  'sub', 'a1000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, false);
set local role authenticated;

select is(public.has_capability('calendar.agenda'), false, 'disable explícito vence default legado ativo');
select ok(public.has_capability('crm.companies'), 'grant explícito habilita capability');
select is(public.has_capability('automation.nurture'), false, 'grant de outro tenant não vaza');
select is(public.has_capability('integrations.meta_ads'), false, 'grant expirado não habilita capability');
select is((select count(*)::int from public.tenant_entitlements), 3, 'RLS mostra apenas as linhas do tenant A');
select is((select source from public.get_my_capabilities() where capability_key = 'crm.companies'), 'test', 'resolver lista fonte explícita');
select is((select source from public.get_my_capabilities() where capability_key = 'integrations.doutore'), 'legacy', 'resolver identifica fallback legado');
reset role;

select set_config('request.jwt.claims', json_build_object(
  'sub', 'b1000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, false);
set local role authenticated;
select is((select count(*)::int from public.tenant_entitlements), 1, 'tenant B vê somente seu entitlement');
select ok(public.has_capability('automation.nurture'), 'tenant B usa seu próprio grant');
reset role;

select set_config('request.jwt.claims', json_build_object(
  'sub', 'f1000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, false);
set local role authenticated;
select is(public.has_capability('crm.companies'), false, 'usuário sem profile falha fechado');
select is((select count(*)::int from public.get_my_capabilities()), 0, 'usuário sem profile não lista capabilities');
reset role;

select * from finish();
rollback;
