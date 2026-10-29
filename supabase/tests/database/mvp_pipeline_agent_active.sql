-- MVP: o Kanban só se move sozinho se a assinatura pipeline.agent estiver ativa
-- e se o gatilho de outbox criar a entrega para eventos message.received.
begin;
create extension if not exists pgtap;

select plan(3);

select ok(
  exists (
    select 1
    from public.domain_event_subscriptions
    where subscriber_id = 'pipeline.agent'
      and active
  ),
  'assinatura pipeline.agent está ativa'
);

select ok(
  exists (
    select 1
    from public.domain_event_subscriptions
    where subscriber_id = 'pipeline.agent'
      and active
      and (event_types @> array['message.received'] or event_types @> array['*']::text[])
  ),
  'pipeline.agent escuta message.received'
);

select ok(
  exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_proc p on p.oid = t.tgfoid
    where c.relname = 'domain_events'
      and p.proname = 'create_domain_event_deliveries'
      and not t.tgisinternal
  ),
  'gatilho de fan-out de entregas existe em domain_events'
);

select * from finish();
rollback;
