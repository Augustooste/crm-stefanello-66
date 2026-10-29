begin;
create extension if not exists pgtap;
select plan(26);

select has_trigger('public','tenant_entitlements','tenant_entitlements_publish_event','publisher entitlement instalado');
select has_trigger('public','subscriptions','subscriptions_publish_event','publisher subscription instalado');
select has_trigger('public','usage_events','usage_events_publish_quota_reached','publisher quota instalado');
select is((select count(*)::int from public.domain_event_subscriptions where subscriber_id='billing.audit' and active),1,'consumer billing.audit provisionado');
select ok((select event_types @> array['entitlement.changed','subscription.changed','usage.quota_reached'] from public.domain_event_subscriptions where subscriber_id='billing.audit'),'billing.audit assina os três contratos');
select ok((select event_types @> array['entitlement.changed','subscription.changed','usage.quota_reached'] from public.domain_event_subscriptions where subscriber_id='kernel.projection'),'projection conhece contratos billing');

insert into auth.users(id,email) values
 ('d1111111-1111-4111-8111-111111111111','ent-events-a@test.local'),
 ('d2222222-2222-4222-8222-222222222222','ent-events-b@test.local');
insert into public.plan_catalog(id,plan_key,name) values('d3333333-3333-4333-8333-333333333331','events_plan','Events Plan');

insert into public.tenant_entitlements(id,tenant_id,capability_key,enabled,source)
select 'd4444444-4444-4444-8444-444444444441',tenant_id,'crm.core',true,'manual:test' from public.profiles where id='d1111111-1111-4111-8111-111111111111';
insert into public.tenant_entitlements(id,tenant_id,capability_key,enabled,source)
select 'd4444444-4444-4444-8444-444444444442',tenant_id,'crm.core',true,'manual:test' from public.profiles where id='d2222222-2222-4222-8222-222222222222';
select is((select count(*)::int from public.domain_events where event_type='entitlement.changed'),2,'insert publica entitlement.changed por tenant');
update public.tenant_entitlements set enabled=false where id='d4444444-4444-4444-8444-444444444441';
select is((select count(*)::int from public.domain_events where event_type='entitlement.changed'),3,'mudança de estado publica nova versão factual');
select is((select count(distinct idempotency_key)::int from public.domain_events where event_type='entitlement.changed'),3,'entitlement events têm idempotência por estado');
select is((select min(schema_version) from public.domain_events where event_type='entitlement.changed'),1,'entitlement.changed usa schema v1');

insert into public.subscriptions(id,tenant_id,plan_id,status,current_period_start,current_period_end)
select 'd5555555-5555-4555-8555-555555555551',tenant_id,'d3333333-3333-4333-8333-333333333331','active',now(),now()+interval '30 days' from public.profiles where id='d1111111-1111-4111-8111-111111111111';
select is((select count(*)::int from public.domain_events where event_type='subscription.changed'),1,'criação publica subscription.changed');
update public.subscriptions set status='paused' where id='d5555555-5555-4555-8555-555555555551';
select is((select count(*)::int from public.domain_events where event_type='subscription.changed'),2,'status publica novo subscription.changed');
select is((select min(schema_version) from public.domain_events where event_type='subscription.changed'),1,'subscription.changed usa schema v1');

insert into public.tenant_capability_quotas(tenant_id,capability_key,meter_key,hard_limit,period,enforcement_mode,source)
select tenant_id,'crm.core','contacts.created',1,'calendar_day','soft','manual:test' from public.profiles where id='d1111111-1111-4111-8111-111111111111';
insert into public.usage_events(tenant_id,capability_key,meter_key,idempotency_key,quantity,source)
select tenant_id,'crm.core','contacts.created','usage-1',1,'test' from public.profiles where id='d1111111-1111-4111-8111-111111111111';
select is((select count(*)::int from public.domain_events where event_type='usage.quota_reached'),0,'atingir exatamente limite ainda não excede quota');
insert into public.usage_events(tenant_id,capability_key,meter_key,idempotency_key,quantity,source)
select tenant_id,'crm.core','contacts.created','usage-2',1,'test' from public.profiles where id='d1111111-1111-4111-8111-111111111111';
select is((select count(*)::int from public.domain_events where event_type='usage.quota_reached'),1,'primeiro crossing publica quota_reached');
insert into public.usage_events(tenant_id,capability_key,meter_key,idempotency_key,quantity,source)
select tenant_id,'crm.core','contacts.created','usage-3',1,'test' from public.profiles where id='d1111111-1111-4111-8111-111111111111';
select is((select count(*)::int from public.domain_events where event_type='usage.quota_reached'),1,'eventos seguintes no período não duplicam crossing');
select is((select schema_version from public.domain_events where event_type='usage.quota_reached'),1,'quota_reached usa schema v1');
select is((select payload->>'enforcement_mode' from public.domain_events where event_type='usage.quota_reached'),'soft','payload registra modo de enforcement');

select ok((select count(*) from public.event_deliveries d join public.domain_events e on e.id=d.event_id where d.subscriber_id='billing.audit' and e.event_type in('entitlement.changed','subscription.changed','usage.quota_reached'))>=6,'fan-out cria deliveries de audit');

-- Demonstrative idempotent audit consumer: replaying the same delivery cannot
-- create a second projection because of (event_id,subscriber_id).
insert into public.domain_event_projections(event_id,tenant_id,subscriber_id,event_type,aggregate_type,aggregate_id,schema_version)
select id,tenant_id,'billing.audit',event_type,aggregate_type,aggregate_id,schema_version from public.domain_events
where event_type='entitlement.changed' and tenant_id=(select tenant_id from public.profiles where id='d1111111-1111-4111-8111-111111111111') order by created_at limit 1;
insert into public.domain_event_projections(event_id,tenant_id,subscriber_id,event_type,aggregate_type,aggregate_id,schema_version)
select id,tenant_id,'billing.audit',event_type,aggregate_type,aggregate_id,schema_version from public.domain_events
where event_type='entitlement.changed' and tenant_id=(select tenant_id from public.profiles where id='d1111111-1111-4111-8111-111111111111') order by created_at limit 1
on conflict(event_id,subscriber_id) do nothing;
select is((select count(*)::int from public.domain_event_projections where subscriber_id='billing.audit'),1,'consumer audit é idempotente em replay');

update public.event_deliveries set status='delivered',delivered_at=now() where subscriber_id='billing.audit';
select ok(public.replay_event_delivery((select d.id from public.event_deliveries d join public.domain_events e on e.id=d.event_id where d.subscriber_id='billing.audit' and e.event_type='entitlement.changed' limit 1),now()),'delivery billing pode ser replayed');
create temp table billing_claim as select * from public.claim_event_deliveries('billing-worker',10,60,null,array['billing.audit']);
select is((select count(*)::int from billing_claim),1,'claim subscriber-aware retorna somente replay pendente');
select is((select subscriber_id from billing_claim),'billing.audit','replay preserva consumer correto');

-- Cross-tenant RLS on projections/audit receipts.
insert into public.domain_event_projections(event_id,tenant_id,subscriber_id,event_type,aggregate_type,aggregate_id,schema_version)
select id,tenant_id,'billing.audit',event_type,aggregate_type,aggregate_id,schema_version from public.domain_events
where event_type='entitlement.changed' and tenant_id=(select tenant_id from public.profiles where id='d2222222-2222-4222-8222-222222222222') order by created_at limit 1;
set local role authenticated;
set local request.jwt.claims='{"sub":"d1111111-1111-4111-8111-111111111111","role":"authenticated"}';
select is((select count(*)::int from public.domain_event_projections where subscriber_id='billing.audit'),1,'tenant A não lê projeção audit do tenant B');
select is((select count(*)::int from public.domain_events where event_type='entitlement.changed'),2,'tenant A não lê fatos do tenant B');
reset role;

select is((select count(*)::int from (select idempotency_key from public.domain_events group by idempotency_key having count(*)>1) d),0,'contratos mantêm idempotency global');
select * from finish();
rollback;
