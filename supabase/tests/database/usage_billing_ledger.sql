begin;
create extension if not exists pgtap;
select plan(21);

select has_table('public', 'plan_catalog', 'plan_catalog existe');
select has_table('public', 'plan_capabilities', 'plan_capabilities existe');
select has_table('public', 'subscriptions', 'subscriptions existe');
select has_table('public', 'subscription_items', 'subscription_items existe');
select has_table('public', 'usage_events', 'usage_events existe');
select has_table('public', 'usage_aggregates', 'usage_aggregates existe');

insert into auth.users (id, email) values
  ('a2000000-0000-0000-0000-000000000001', 'billing-a@test.local'),
  ('b2000000-0000-0000-0000-000000000001', 'billing-b@test.local');

select set_config('request.jwt.claims', json_build_object(
  'sub', 'a2000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, false);
set local role authenticated;
select throws_ok(
  $$select public.record_usage_event(
    (select tenant_id from public.profiles where id = 'a2000000-0000-0000-0000-000000000001'),
    'messaging.inbox', 'messages.sent', 'evt-authenticated')$$,
  'permission denied for function record_usage_event',
  'authenticated não registra consumo diretamente'
);
reset role;

select set_config('request.jwt.claims', '{"role":"service_role"}', false);
set local role service_role;

select is(
  (public.record_usage_event(
    (select tenant_id from public.profiles where id = 'a2000000-0000-0000-0000-000000000001'),
    'messaging.inbox', 'messages.sent', 'evt-1', 2, now(), 'test', '{}'::jsonb
  ) ->> 'duplicate')::boolean,
  false,
  'primeiro registro não é duplicado'
);
select is(
  (public.record_usage_event(
    (select tenant_id from public.profiles where id = 'a2000000-0000-0000-0000-000000000001'),
    'messaging.inbox', 'messages.sent', 'evt-1', 2, now(), 'test', '{}'::jsonb
  ) ->> 'duplicate')::boolean,
  true,
  'replay idêntico é idempotente'
);
select is((select count(*)::int from public.usage_events where idempotency_key = 'evt-1'), 1, 'ledger contém uma única linha');
select throws_ok(
  $$select public.record_usage_event(
    (select tenant_id from public.profiles where id = 'a2000000-0000-0000-0000-000000000001'),
    'messaging.inbox', 'messages.sent', 'evt-1', 3, now(), 'test', '{}'::jsonb)$$,
  '23505',
  'idempotency key reused with different payload',
  'colisão com payload diferente é rejeitada'
);

select public.record_usage_event(
  (select tenant_id from public.profiles where id = 'b2000000-0000-0000-0000-000000000001'),
  'messaging.inbox', 'messages.sent', 'evt-b', 5, now(), 'test', '{}'::jsonb
);
select is(public.refresh_usage_aggregates(
  (select tenant_id from public.profiles where id = 'a2000000-0000-0000-0000-000000000001'),
  date_trunc('month', now()), date_trunc('month', now()) + interval '1 month'), 1,
  'agregação cria um bucket'
);
select is((select quantity from public.usage_aggregates where meter_key = 'messages.sent'), 2.000000::numeric, 'agregado soma quantidade corretamente');

insert into public.subscriptions (tenant_id, plan_id, status, current_period_start, current_period_end)
select p.tenant_id, pc.id, 'active', now() - interval '1 day', now() + interval '29 days'
from public.profiles p cross join public.plan_catalog pc
where p.id = 'a2000000-0000-0000-0000-000000000001' and pc.plan_key = 'professional';
select ok(
  public.sync_subscription_entitlements((select id from public.subscriptions limit 1)) > 0,
  'assinatura ativa deriva entitlements'
);
select ok(exists(
  select 1 from public.tenant_entitlements
  where source like 'subscription:%' and capability_key = 'messaging.inbox' and enabled
), 'plano professional concede messaging.inbox');
reset role;

select set_config('request.jwt.claims', json_build_object(
  'sub', 'a2000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, false);
set local role authenticated;
select is((select count(*)::int from public.usage_events), 1, 'tenant A vê somente seu evento');
select is((select quantity from public.usage_events limit 1), 2.000000::numeric, 'tenant A vê seu consumo');
select is((select count(*)::int from public.subscriptions), 1, 'tenant A vê sua assinatura');
reset role;

select set_config('request.jwt.claims', json_build_object(
  'sub', 'b2000000-0000-0000-0000-000000000001', 'role', 'authenticated')::text, false);
set local role authenticated;
select is((select count(*)::int from public.usage_events), 1, 'tenant B vê somente seu evento');
select is((select quantity from public.usage_events limit 1), 5.000000::numeric, 'tenant B não vê quantidade do tenant A');
select is((select count(*)::int from public.subscriptions), 0, 'tenant B não vê assinatura do tenant A');
reset role;

select * from finish();
rollback;
