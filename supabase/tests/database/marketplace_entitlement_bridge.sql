begin;
create extension if not exists pgtap;
select plan(26);

select has_table('public', 'marketplace_engine_catalog', 'engine catalog existe');
select has_table('public', 'marketplace_engine_dependencies', 'dependency catalog existe');
select has_table('public', 'tenant_marketplace_installations', 'tenant installations existe');
select has_function('public', 'install_marketplace_engine', array['uuid','text','jsonb'], 'install RPC existe');
select is((select required_entitlement from public.marketplace_engine_catalog where engine_id = 'crm.products'),
  'crm.catalog', 'produto mapeia capability operacional ao entitlement comercial');

insert into auth.users (id, email) values
  ('a4000000-0000-0000-0000-000000000001', 'market-a@test.local'),
  ('b4000000-0000-0000-0000-000000000001', 'market-b@test.local');

select set_config('request.jwt.claims', json_build_object(
  'sub', 'a4000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, false);
set local role authenticated;
select throws_like(
  $$select public.install_marketplace_engine(
    (select tenant_id from public.profiles where id = 'a4000000-0000-0000-0000-000000000001'),
    'crm.companies', '{}')$$,
  'permission denied for function install_marketplace_engine',
  'tenant não instala engine diretamente'
);
reset role;

select set_config('request.jwt.claims', '{"role":"service_role"}', false);
set local role service_role;
select throws_like(
  $$select public.install_marketplace_engine(
    (select tenant_id from public.profiles where id = 'b4000000-0000-0000-0000-000000000001'),
    'crm.companies', '{}')$$,
  '%missing marketplace entitlements%', 'instalação sem entitlements falha fechada'
);

insert into public.tenant_entitlements (tenant_id, capability_key, enabled, source)
select tenant_id, capability_key, true, 'marketplace-test'
from public.profiles cross join (values ('crm.core'), ('crm.companies')) caps(capability_key)
where id = 'a4000000-0000-0000-0000-000000000001';

select is(public.install_marketplace_engine(
  (select tenant_id from public.profiles where id = 'a4000000-0000-0000-0000-000000000001'),
  'crm.companies', '{"mode":"sandbox"}'), 2, 'instala engine e dependência');
select is((select count(*)::int from public.tenant_marketplace_installations), 2,
  'duas instalações persistidas');
select is((select configuration ->> 'mode' from public.tenant_marketplace_installations where engine_id = 'crm.companies'),
  'sandbox', 'configuração pertence à instalação alvo');
select ok((select desired_enabled from public.tenant_marketplace_installations where engine_id = 'crm.companies'),
  'desired state é independente e ativo');
select ok(exists(select 1 from public.tenant_plugin_installations where plugin_key = 'companies' and provisioning_status = 'installed'),
  'bridge sincroniza runtime legado durante rollout');
select ok((select count(*) from public.entitlement_audit_log where entity_type = 'tenant_marketplace_installations') >= 2,
  'lifecycle gera audit trail');

select public.configure_marketplace_engine(
  (select tenant_id from public.profiles where id = 'a4000000-0000-0000-0000-000000000001'),
  'crm.companies', '{"region":"br"}');
select public.report_marketplace_engine_health(
  (select tenant_id from public.profiles where id = 'a4000000-0000-0000-0000-000000000001'),
  'crm.companies', 'healthy', 'ok');
select is((select configuration ->> 'region' from public.tenant_marketplace_installations where engine_id = 'crm.companies'),
  'br', 'configuração é atualizada separadamente');
select is((select health_status from public.tenant_marketplace_installations where engine_id = 'crm.companies'),
  'healthy', 'health é atualizado separadamente');

select throws_ok(
  $$select public.set_marketplace_engine_desired(
    (select tenant_id from public.profiles where id = 'a4000000-0000-0000-0000-000000000001'),
    'crm.core', false)$$,
  '55000', 'engine has enabled dependents', 'não desabilita dependência ainda utilizada'
);

select throws_ok(
  $$select public.uninstall_marketplace_engine(
    (select tenant_id from public.profiles where id = 'a4000000-0000-0000-0000-000000000001'), 'crm.core')$$,
  '55000', 'engine has installed dependents', 'não remove dependência ainda utilizada'
);
select lives_ok(
  $$select public.uninstall_marketplace_engine(
    (select tenant_id from public.profiles where id = 'a4000000-0000-0000-0000-000000000001'), 'crm.companies')$$,
  'remove engine folha com segurança'
);
select is((select lifecycle_status from public.tenant_marketplace_installations where engine_id = 'crm.companies'),
  'uninstalled', 'uninstall mantém registro auditável');

select public.install_marketplace_engine(
  (select tenant_id from public.profiles where id = 'a4000000-0000-0000-0000-000000000001'),
  'crm.companies', '{}');
select is(public.revoke_marketplace_entitlement(
  (select tenant_id from public.profiles where id = 'a4000000-0000-0000-0000-000000000001'),
  'crm.companies', 'test revoke'), 1, 'revoke desabilita engine afetada');
select is((select enabled from public.tenant_entitlements where capability_key = 'crm.companies'),
  false, 'revoke desabilita entitlement');
select is((select lifecycle_status from public.tenant_marketplace_installations where engine_id = 'crm.companies'),
  'disabled', 'revoke preserva instalação, mas bloqueia execução');
reset role;

select set_config('request.jwt.claims', json_build_object(
  'sub', 'a4000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, false);
set local role authenticated;
select is((select count(*)::int from public.tenant_marketplace_installations), 2,
  'tenant A vê somente suas instalações');
select is(public.has_capability('crm.companies'), false,
  'guard runtime reflete revoke imediatamente');
reset role;

select set_config('request.jwt.claims', json_build_object(
  'sub', 'b4000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, false);
set local role authenticated;
select is((select count(*)::int from public.tenant_marketplace_installations), 0,
  'tenant B não vê instalações do tenant A');
select is((select count(*)::int from public.entitlement_audit_log), 0,
  'tenant B não vê lifecycle audit do tenant A');
reset role;

select * from finish();
rollback;
