begin;
create extension if not exists pgtap;
select plan(32);

select has_table('public','domain_event_projections','projection idempotente existe');
select col_is_pk('public','domain_event_projections',array['event_id','subscriber_id'],'projection única por evento/consumer');
select has_function('public','claim_event_deliveries',array['text','integer','integer','text[]','text[]'],'claim subscriber-aware existe');
select has_function('public','replay_event_delivery',array['uuid','timestamptz'],'replay RPC existe');
select has_function('public','prune_domain_events',array['timestamptz','integer'],'retention RPC existe');
select ok(not has_function_privilege('authenticated','public.replay_event_delivery(uuid,timestamptz)','EXECUTE'),'replay é service-only');
select ok(not has_function_privilege('authenticated','public.prune_domain_events(timestamptz,integer)','EXECUTE'),'retention é service-only');
select is((select count(*)::int from public.domain_event_subscriptions where subscriber_id in('kernel.projection','kernel.observability') and active),2,'subscriptions first-party provisionadas');
select has_trigger('public','contacts','contacts_publish_created_event','publisher contact.created instalado');
select has_trigger('public','contact_merge_log','contact_merge_log_publish_event','publisher contact.merged instalado');
select has_trigger('public','deal_stage_history','deal_stage_history_publish_event','publisher deal.stage_changed instalado');
select has_trigger('public','messages','messages_publish_domain_event','publisher message domain instalado');
select has_trigger('public','tenant_integrations','tenant_integrations_publish_connected_event','publisher integration.connected instalado');

insert into auth.users(id,email) values('c1111111-1111-4111-8111-111111111111','events-runtime@test.local');
insert into public.contacts(id,tenant_id,name,status)
select 'c2222222-2222-4222-8222-222222222221',tenant_id,'Origem','contact' from public.profiles where id='c1111111-1111-4111-8111-111111111111';
insert into public.contacts(id,tenant_id,name,status)
select 'c2222222-2222-4222-8222-222222222222',tenant_id,'Destino','contact' from public.profiles where id='c1111111-1111-4111-8111-111111111111';
select is((select count(*)::int from public.domain_events where event_type='contact.created'),2,'contact.created publicado uma vez por contato');

insert into public.boards(id,tenant_id,name)
select 'c3333333-3333-4333-8333-333333333331',tenant_id,'Pipeline' from public.profiles where id='c1111111-1111-4111-8111-111111111111';
insert into public.board_stages(id,board_id,name,position) values
 ('c4444444-4444-4444-8444-444444444441','c3333333-3333-4333-8333-333333333331','Novo',0),
 ('c4444444-4444-4444-8444-444444444442','c3333333-3333-4333-8333-333333333331','Qualificado',1);
insert into public.deals(id,tenant_id,board_id,stage_id,contact_id,title)
select 'c5555555-5555-4555-8555-555555555551',tenant_id,'c3333333-3333-4333-8333-333333333331','c4444444-4444-4444-8444-444444444441','c2222222-2222-4222-8222-222222222221','Deal' from public.profiles where id='c1111111-1111-4111-8111-111111111111';
set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', 'c1111111-1111-4111-8111-111111111111',
    'role', 'authenticated'
  )::text,
  true
);
do $$
begin
  perform public.transition_deal_stage(
    'c5555555-5555-4555-8555-555555555551',
    'c4444444-4444-4444-8444-444444444441',
    'c4444444-4444-4444-8444-444444444442',
    'human',
    null,
    'Fixture de evento de domínio',
    '{"source":"domain_events_runtime"}',
    null,
    'domain-events-runtime:stage-change'
  );
end;
$$;
reset role;
select is((select count(*)::int from public.domain_events where event_type='deal.stage_changed'),1,'deal.stage_changed deriva do histórico transacional');

insert into public.contact_merge_log(tenant_id,source_contact_id,target_contact_id,merged_by,source_snapshot,records_moved)
select tenant_id,'c2222222-2222-4222-8222-222222222221','c2222222-2222-4222-8222-222222222222',id,'{}','{}' from public.profiles where id='c1111111-1111-4111-8111-111111111111';
select is((select count(*)::int from public.domain_events where event_type='contact.merged'),1,'contact.merged publicado pelo log transacional');

insert into public.channels(id,tenant_id,type,provider_slug)
select 'c6666666-6666-4666-8666-666666666661',tenant_id,'whatsapp','test' from public.profiles where id='c1111111-1111-4111-8111-111111111111';
insert into public.conversations(id,tenant_id,contact_id,channel_id)
select 'c7777777-7777-4777-8777-777777777771',tenant_id,'c2222222-2222-4222-8222-222222222222','c6666666-6666-4666-8666-666666666661' from public.profiles where id='c1111111-1111-4111-8111-111111111111';
insert into public.messages(id,tenant_id,conversation_id,direction,sender,content)
select 'c8888888-8888-4888-8888-888888888881',tenant_id,'c7777777-7777-4777-8777-777777777771','in','contact','entrada' from public.profiles where id='c1111111-1111-4111-8111-111111111111';
insert into public.messages(id,tenant_id,conversation_id,direction,sender,content)
select 'c8888888-8888-4888-8888-888888888882',tenant_id,'c7777777-7777-4777-8777-777777777771','out','agent','saída' from public.profiles where id='c1111111-1111-4111-8111-111111111111';
select is((select count(*)::int from public.domain_events where event_type='message.received'),1,'message.received preservado');
select is((select count(*)::int from public.domain_events where event_type='message.sent'),1,'message.sent publicado');

insert into public.integrations(slug,name,category) values('runtime-test','Runtime Test','crm');
insert into public.tenant_integrations(tenant_id,slug,status,connected_at)
select tenant_id,'runtime-test','active',now() from public.profiles where id='c1111111-1111-4111-8111-111111111111';
select is((select count(*)::int from public.domain_events where event_type='integration.connected'),1,'integration.connected publicado na transição ativa');
update public.tenant_integrations set last_check_at=now() where slug='runtime-test';
select is((select count(*)::int from public.domain_events where event_type='integration.connected'),1,'updates sem transição não duplicam integração');

select ok((select count(*) from public.event_deliveries)>=14,'fan-out criou deliveries first-party');
create temp table projection_claim as select * from public.claim_event_deliveries('projection-worker',1,60,null,array['kernel.projection']);
create temp table observation_claim as select * from public.claim_event_deliveries('observation-worker',1,60,null,array['kernel.observability']);
select is((select subscriber_id from projection_claim),'kernel.projection','claim filtra projection subscriber');
select is((select subscriber_id from observation_claim),'kernel.observability','claim concorrente filtra observability subscriber');
select is((select count(*)::int from projection_claim p join observation_claim o on p.delivery_id=o.delivery_id),0,'consumidores concorrentes não recebem mesma delivery');

select ok(public.ack_event_delivery((select delivery_id from projection_claim),'projection-worker'),'delivery confirmada pelo lease owner');
select ok(public.replay_event_delivery((select delivery_id from projection_claim),now()),'delivery entregue pode ser reprocessada');
select is((select status from public.event_deliveries where id=(select delivery_id from projection_claim)),'pending','replay volta para pending e limpa lease');
select is((select attempts from public.event_deliveries where id=(select delivery_id from projection_claim)),0,'replay zera tentativas');

-- Retention never deletes pending work; after completion it removes old event
-- and cascades deliveries/projections in a bounded batch.
insert into public.domain_events(tenant_id,event_type,aggregate_type,aggregate_id,idempotency_key,created_at,occurred_at)
select tenant_id,'runtime.retention_test','test',gen_random_uuid(),'runtime.retention:test',now()-interval '100 days',now()-interval '100 days' from public.profiles where id='c1111111-1111-4111-8111-111111111111';
select is(public.prune_domain_events(now()-interval '90 days',10),0,'retention preserva evento com deliveries pending');
update public.event_deliveries set status='delivered',delivered_at=now() where event_id=(select id from public.domain_events where idempotency_key='runtime.retention:test');
select is(public.prune_domain_events(now()-interval '90 days',10),1,'retention remove apenas evento terminal antigo');
select is((select count(*)::int from public.domain_events where idempotency_key='runtime.retention:test'),0,'evento podado foi removido');

select is((select count(*)::int from (select idempotency_key from public.domain_events group by idempotency_key having count(*)>1) duplicates),0,'idempotency keys permanecem únicas');
select * from finish();
rollback;
