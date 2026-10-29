begin;
create extension if not exists pgtap;
select plan(24);

select has_table('public', 'tenant_plugin_installations', 'plugin installations existe');
select has_table('public', 'tenant_capability_quotas', 'quotas existe');
select has_table('public', 'entitlement_audit_log', 'audit trail existe');
select has_table('public', 'capability_shadow_evaluations', 'shadow telemetry existe');
select has_table('public', 'billing_webhook_events', 'webhook inbox existe');
select has_column('public', 'subscriptions', 'grace_until', 'subscriptions suporta grace period');

insert into auth.users (id, email) values
  ('a3000000-0000-0000-0000-000000000001', 'runtime-a@test.local'),
  ('b3000000-0000-0000-0000-000000000001', 'runtime-b@test.local');
update public.tenants set niche = 'buffet-eventos', business_profile = '{}'::jsonb
where id = (select tenant_id from public.profiles where id = 'a3000000-0000-0000-0000-000000000001');

select set_config('request.jwt.claims', json_build_object(
  'sub', 'a3000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, false);
set local role authenticated;
select ok((public.evaluate_capability('calendar.agenda', 'test:legacy') ->> 'allowed')::boolean,
  'runtime preserva fallback legado durante rollout');
select throws_ok(
  $$insert into public.tenant_plugin_installations
    (tenant_id, plugin_key, capability_key) select tenant_id, 'companies', 'crm.companies'
    from public.profiles where id = 'a3000000-0000-0000-0000-000000000001'$$,
  'permission denied for table tenant_plugin_installations',
  'tenant não instala plugin diretamente'
);
reset role;

select set_config('request.jwt.claims', '{"role":"service_role"}', false);
set local role service_role;
insert into public.tenant_entitlements (tenant_id, capability_key, enabled, source)
select tenant_id, 'crm.companies', true, 'test'
from public.profiles where id = 'a3000000-0000-0000-0000-000000000001';
insert into public.tenant_plugin_installations
  (tenant_id, plugin_key, capability_key, provisioning_status, health_status)
select tenant_id, 'companies', 'crm.companies', 'pending', 'unknown'
from public.profiles where id = 'a3000000-0000-0000-0000-000000000001';

select ok((private.runtime_capability_for_tenant(
  (select tenant_id from public.profiles where id = 'a3000000-0000-0000-0000-000000000001'),
  'crm.companies') ->> 'entitled')::boolean, 'direito comercial está ativo');
select is((private.runtime_capability_for_tenant(
  (select tenant_id from public.profiles where id = 'a3000000-0000-0000-0000-000000000001'),
  'crm.companies') ->> 'allowed')::boolean, false, 'plugin pendente bloqueia runtime apesar do entitlement');

update public.tenant_plugin_installations set provisioning_status = 'installed', health_status = 'healthy';
select ok((private.runtime_capability_for_tenant(
  (select tenant_id from public.profiles where id = 'a3000000-0000-0000-0000-000000000001'),
  'crm.companies') ->> 'allowed')::boolean, 'plugin instalado e saudável libera runtime');
select ok((select count(*) from public.entitlement_audit_log) >= 3, 'mudanças geram audit trail');

insert into public.tenant_capability_quotas
  (tenant_id, capability_key, meter_key, hard_limit, period, enforcement_mode)
select tenant_id, 'crm.companies', 'companies.operations', 2, 'calendar_month', 'hard'
from public.profiles where id = 'a3000000-0000-0000-0000-000000000001';
select is((public.consume_capability_usage(
  (select tenant_id from public.profiles where id = 'a3000000-0000-0000-0000-000000000001'),
  'crm.companies', 'companies.operations', 'runtime-use-1', 2) ->> 'quota_exceeded')::boolean,
  false, 'consumo dentro da quota é registrado');
select is((public.consume_capability_usage(
  (select tenant_id from public.profiles where id = 'a3000000-0000-0000-0000-000000000001'),
  'crm.companies', 'companies.operations', 'runtime-use-1', 2) ->> 'duplicate')::boolean,
  true, 'replay idempotente não consome quota novamente');
select throws_ok(
  $$select public.consume_capability_usage(
    (select tenant_id from public.profiles where id = 'a3000000-0000-0000-0000-000000000001'),
    'crm.companies', 'companies.operations', 'runtime-use-2', 1)$$,
  'P0001', 'quota exceeded', 'hard quota bloqueia excesso'
);

select is((public.claim_billing_webhook_event('sandbox', 'wh-1', 'subscription.updated', '{}') ->> 'duplicate')::boolean,
  false, 'primeiro webhook é aceito');
select is((public.claim_billing_webhook_event('sandbox', 'wh-1', 'subscription.updated', '{}') ->> 'duplicate')::boolean,
  true, 'replay de webhook é idempotente');
reset role;

-- Força divergência: legado agenda=true, entitlement explícito=false.
select set_config('request.jwt.claims', '{"role":"service_role"}', false);
set local role service_role;
insert into public.tenant_entitlements (tenant_id, capability_key, enabled, source)
select tenant_id, 'calendar.agenda', false, 'shadow-test'
from public.profiles where id = 'a3000000-0000-0000-0000-000000000001';
reset role;

select set_config('request.jwt.claims', json_build_object(
  'sub', 'a3000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, false);
set local role authenticated;
select is((public.evaluate_capability('calendar.agenda', 'test:divergence') ->> 'allowed')::boolean,
  false, 'entitlement explícito vence legado');
select ok((select divergence from public.capability_shadow_evaluations
  where operation = 'test:divergence'), 'divergência é registrada');
select is((select count(*)::int from public.entitlement_audit_log where tenant_id = private.get_user_tenant_id()),
  (select count(*)::int from public.entitlement_audit_log), 'admin A vê somente audit do próprio tenant');
select is((select count(*)::int from public.usage_events), 1, 'tenant A vê somente consumo próprio');
reset role;

select set_config('request.jwt.claims', json_build_object(
  'sub', 'b3000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, false);
set local role authenticated;
select is((select count(*)::int from public.entitlement_audit_log), 0, 'tenant B não vê audit do tenant A');
select is((select count(*)::int from public.tenant_plugin_installations), 0, 'tenant B não vê instalações do tenant A');
select is((select count(*)::int from public.usage_events), 0, 'tenant B não vê consumo do tenant A');
reset role;

select * from finish();
rollback;
