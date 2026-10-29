begin;
create extension if not exists pgtap;
select plan(12);

select has_table('public', 'communication_usage_events', 'usage ledger exists');
select has_column('public', 'communication_usage_events', 'tenant_id', 'ledger is tenant scoped');
select has_column('public', 'communication_usage_events', 'estimated_cost_micros', 'estimated cost exists');
select has_column('public', 'communication_usage_events', 'actual_cost_micros', 'actual reconciled cost exists');
select has_column('public', 'communication_usage_events', 'idempotency_key', 'idempotency key exists');
select has_index('public', 'communication_usage_events', 'communication_usage_idempotency_idx', 'idempotency index exists');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.communication_usage_events'::regclass),
  'RLS enabled on usage ledger'
);
select is(
  (select count(*)::int from pg_policies where tablename = 'communication_usage_events' and cmd = 'SELECT'),
  1,
  'one tenant select policy exists'
);
select has_column('public', 'messages', 'delivered_at', 'messages track delivered timestamp');
select has_column('public', 'messages', 'read_at', 'messages track read timestamp');
select has_column('public', 'messages', 'provider_status_at', 'messages track provider status timestamp');
select lives_ok(
  $$insert into public.channels (tenant_id, type, provider_slug, status)
    select id, 'push', 'push', 'pending' from public.tenants limit 1$$,
  'new channel types are accepted'
);

select * from finish();
rollback;

