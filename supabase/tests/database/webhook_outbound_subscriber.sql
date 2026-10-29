begin;
create extension if not exists pgtap;
select plan(5);

select is(
  (select count(*)::int from public.domain_event_subscriptions where subscriber_id = 'webhook.outbound'),
  1, 'existe exatamente uma assinatura webhook.outbound');
select ok(
  (select active from public.domain_event_subscriptions where subscriber_id = 'webhook.outbound'),
  'webhook.outbound esta ativa');
select is(
  (select event_types from public.domain_event_subscriptions where subscriber_id = 'webhook.outbound'),
  public.webhook_allowed_event_types(), 'event_types iguais a lista permitida');
select ok(
  not ((select event_types from public.domain_event_subscriptions where subscriber_id = 'webhook.outbound') @> array['webhook.test']),
  'webhook.test nao e assinado (nao passa pelo fan-out)');

-- Reaplica o seed: nao duplica.
insert into public.domain_event_subscriptions (subscriber_id, event_types, active, max_attempts)
values ('webhook.outbound', public.webhook_allowed_event_types(), true, 8)
on conflict (subscriber_id) do update
  set event_types = excluded.event_types, active = true,
      max_attempts = excluded.max_attempts, updated_at = now();
select is(
  (select count(*)::int from public.domain_event_subscriptions where subscriber_id = 'webhook.outbound'),
  1, 'upsert repetido nao duplica');

select * from finish();
rollback;
