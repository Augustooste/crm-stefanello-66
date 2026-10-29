begin;
create extension if not exists pgtap;
select plan(44);

select ok(exists (
  select 1 from public.ai_feature_catalog
  where feature_key = 'pipeline_agent' and not default_enabled and toggle_authority = 'tenant_admin'
), 'agente nasce desligado e só o admin do tenant pode optar');
select ok(not has_function_privilege('authenticated', 'public.claim_event_deliveries(text,integer,integer,text[],text[])', 'EXECUTE'), 'authenticated não pode reclamar eventos');
select ok(not has_function_privilege('anon', 'public.claim_event_deliveries(text,integer,integer,text[],text[])', 'EXECUTE'), 'anon não pode reclamar eventos');
select ok(has_function_privilege('service_role', 'public.claim_event_deliveries(text,integer,integer,text[],text[])', 'EXECUTE'), 'assinatura e grant service_role preservados');

insert into auth.users(id, email) values
  ('f6100000-0000-4000-8000-000000000001', 'pipeline-opt-in@test.local'),
  ('f6100000-0000-4000-8000-000000000002', 'pipeline-sem-opt-in@test.local');
-- Fixture permite observar a falha do claim antes de a migration registrar o catálogo.
insert into public.ai_feature_catalog(feature_key, label, default_enabled, toggle_authority)
values ('pipeline_agent', 'Agente de pipeline', false, 'tenant_admin') on conflict do nothing;
insert into public.tenant_ai_features(tenant_id, feature_key, enabled)
select tenant_id, 'pipeline_agent', true from public.profiles where id = 'f6100000-0000-4000-8000-000000000001';

update public.domain_event_subscriptions
set event_types = array_append(event_types, 'pipeline.opt_in_test')
where subscriber_id in ('pipeline.agent', 'kernel.observability');

insert into public.domain_events(id, tenant_id, event_type, aggregate_type, aggregate_id, idempotency_key, created_at)
select 'f6110000-0000-4000-8000-000000000001', tenant_id, 'pipeline.opt_in_test', 'contact', gen_random_uuid(), 'pipeline-teste:antigo', now() - interval '1 day'
from public.profiles where id = 'f6100000-0000-4000-8000-000000000001';
insert into public.domain_events(id, tenant_id, event_type, aggregate_type, aggregate_id, idempotency_key, created_at)
select 'f6110000-0000-4000-8000-000000000002', tenant_id, 'pipeline.opt_in_test', 'contact', gen_random_uuid(), 'pipeline-teste:novo', clock_timestamp()
from public.profiles where id = 'f6100000-0000-4000-8000-000000000001';
insert into public.domain_events(id, tenant_id, event_type, aggregate_type, aggregate_id, idempotency_key)
select 'f6110000-0000-4000-8000-000000000003', tenant_id, 'pipeline.opt_in_test', 'contact', gen_random_uuid(), 'pipeline-teste:outro'
from public.profiles where id = 'f6100000-0000-4000-8000-000000000002';
insert into public.domain_events(id, tenant_id, event_type, aggregate_type, aggregate_id, idempotency_key)
select 'f6110000-0000-4000-8000-000000000004', tenant_id, 'pipeline.opt_in_test', 'contact', gen_random_uuid(), 'pipeline-teste:lease-outro'
from public.profiles where id = 'f6100000-0000-4000-8000-000000000002';

-- Backlog legado é fixture explícita: o fan-out atual já bloqueia essas entregas.
insert into public.event_deliveries(event_id, tenant_id, subscriber_id, max_attempts)
select e.id, e.tenant_id, s.subscriber_id, s.max_attempts
from public.domain_events e cross join public.domain_event_subscriptions s
where e.id in ('f6110000-0000-4000-8000-000000000001', 'f6110000-0000-4000-8000-000000000003', 'f6110000-0000-4000-8000-000000000004')
  and s.subscriber_id = 'pipeline.agent'
on conflict (event_id, subscriber_id) do nothing;
update public.event_deliveries set status = 'processing', attempts = max_attempts,
  locked_at = now() - interval '1 day', locked_by = 'worker-antigo'
where event_id = 'f6110000-0000-4000-8000-000000000004' and subscriber_id = 'pipeline.agent';

create temp table pipeline_claim as select * from public.claim_event_deliveries('pipeline-teste', 500, 60, array['pipeline.opt_in_test'], array['pipeline.agent']);
select results_eq($$select event_id from pipeline_claim$$, $$values ('f6110000-0000-4000-8000-000000000002'::uuid)$$, 'claim só recebe evento novo do tenant opt-in');
select is((select status || ':' || attempts from public.event_deliveries where event_id = 'f6110000-0000-4000-8000-000000000003' and subscriber_id = 'pipeline.agent'), 'pending:0', 'tenant sem opt-in continua intocado');
select is((select status || ':' || attempts from public.event_deliveries where event_id = 'f6110000-0000-4000-8000-000000000001' and subscriber_id = 'pipeline.agent'), 'pending:0', 'backlog anterior ao opt-in continua intocado');
select is((select status from public.event_deliveries where event_id = 'f6110000-0000-4000-8000-000000000004' and subscriber_id = 'pipeline.agent'), 'processing', 'limpeza de lease também respeita opt-in');
select ok(exists(select 1 from public.claim_event_deliveries('observador-teste', 500, 60, array['pipeline.opt_in_test'], array['kernel.observability']) where event_id = 'f6110000-0000-4000-8000-000000000003'), 'outros subscribers mantêm contrato sem filtro de feature');
select is((select count(*)::int from public.claim_event_deliveries('chamador-legado', 500, 60, array['pipeline.opt_in_test']) where subscriber_id = 'pipeline.agent'), 0, 'omitir filtro de subscriber não permite contornar opt-in');


select set_config('teste.outro_tenant', (select tenant_id::text from public.profiles where id = 'f6100000-0000-4000-8000-000000000002'), true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f6100000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select lives_ok($$update public.tenant_ai_features set enabled = true where feature_key = 'pipeline_agent'$$, 'admin pode ligar feature própria');
select throws_ok($$insert into public.tenant_ai_features(tenant_id,feature_key,enabled) values (current_setting('teste.outro_tenant')::uuid,'pipeline_agent',true)$$, '42501', null, 'admin não pode habilitar feature de outro tenant');
reset role;

insert into public.boards(id, tenant_id, name)
select 'f6120000-0000-4000-8000-000000000001', tenant_id, 'Teste autonomia' from public.profiles where id = 'f6100000-0000-4000-8000-000000000001';
insert into public.board_stages(id,board_id,name,position) values
  ('f6130000-0000-4000-8000-000000000001','f6120000-0000-4000-8000-000000000001','Origem',0),
  ('f6130000-0000-4000-8000-000000000002','f6120000-0000-4000-8000-000000000001','Destino',1);
insert into public.deals(id,tenant_id,board_id,stage_id,title,status)
select ('f6140000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid, tenant_id,
  'f6120000-0000-4000-8000-000000000001','f6130000-0000-4000-8000-000000000001','Teste ' || n,'open'
from public.profiles cross join generate_series(1,7) n where id = 'f6100000-0000-4000-8000-000000000001';
update public.stage_transitions set autonomy_mode = 'autonomous', min_confidence = 0.80,
  requires_human_approval = false, cooldown_minutes = 0
where board_id = 'f6120000-0000-4000-8000-000000000001';
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select is(public.transition_deal_stage('f6140000-0000-4000-8000-000000000001','f6130000-0000-4000-8000-000000000001','f6130000-0000-4000-8000-000000000002','ai',null,'Critérios cumpridos','{}',0.79,'teste-079')->>'status','queued','autonomous 0.79 solicita aprovação, não descarta');
select is((select confidence from public.ai_pending_stage_advances where deal_id = 'f6140000-0000-4000-8000-000000000001'),0.79::numeric,'fila preserva confiança abaixo do limiar');
select is((select stage_id from public.deals where id = 'f6140000-0000-4000-8000-000000000001'),'f6130000-0000-4000-8000-000000000001'::uuid,'abaixo do limiar não movimenta');
select is(public.transition_deal_stage('f6140000-0000-4000-8000-000000000002','f6130000-0000-4000-8000-000000000001','f6130000-0000-4000-8000-000000000002','ai',null,'Critérios cumpridos','{}',0.80,'teste-080')->>'status','accepted','autonomous 0.80 avança na borda inclusiva');
select ok(exists(select 1 from public.deal_stage_history where deal_id = 'f6140000-0000-4000-8000-000000000002' and actor_type = 'ai' and confidence = 0.80),'avanço real registra ator IA e confiança');
update public.stage_transitions set autonomy_mode = 'assisted' where board_id = 'f6120000-0000-4000-8000-000000000001';
select is(public.transition_deal_stage('f6140000-0000-4000-8000-000000000003','f6130000-0000-4000-8000-000000000001','f6130000-0000-4000-8000-000000000002','ai',null,'Critérios cumpridos','{}',0.79,'teste-assistido')->>'status','queued','assisted solicita aprovação mesmo abaixo do mínimo');
update public.stage_transitions set autonomy_mode = 'shadow' where board_id = 'f6120000-0000-4000-8000-000000000001';
select is(public.transition_deal_stage('f6140000-0000-4000-8000-000000000004','f6130000-0000-4000-8000-000000000001','f6130000-0000-4000-8000-000000000002','ai',null,'Critérios cumpridos','{}',0.79,'teste-shadow')->>'status','shadowed','shadow só registra, inclusive abaixo do mínimo');
select is((select count(*)::int from public.ai_pending_stage_advances where deal_id = 'f6140000-0000-4000-8000-000000000004'),0,'shadow não cria aprovação');
update public.stage_transitions set autonomy_mode = 'manual' where board_id = 'f6120000-0000-4000-8000-000000000001';
select is(public.transition_deal_stage('f6140000-0000-4000-8000-000000000005','f6130000-0000-4000-8000-000000000001','f6130000-0000-4000-8000-000000000002','ai',null,'Critérios cumpridos','{}',0.79,'teste-manual')->>'status','recommended','manual preserva recomendação sem efeito automático');
select is((select count(*)::int from public.ai_pending_stage_advances where deal_id = 'f6140000-0000-4000-8000-000000000005'),0,'manual não cria aprovação');
update public.stage_transitions set autonomy_mode = 'autonomous', requires_human_approval = true where board_id = 'f6120000-0000-4000-8000-000000000001';
select is(public.transition_deal_stage('f6140000-0000-4000-8000-000000000006','f6130000-0000-4000-8000-000000000001','f6130000-0000-4000-8000-000000000002','ai',null,'Critérios cumpridos','{}',0.99,'teste-aprovacao')->>'status','queued','aprovação explícita continua obrigatória');
update public.stage_transitions set requires_human_approval = false where board_id = 'f6120000-0000-4000-8000-000000000001';
select is(public.transition_deal_stage('f6140000-0000-4000-8000-000000000007','f6130000-0000-4000-8000-000000000001','f6130000-0000-4000-8000-000000000002','ai',null,'Sem confiança','{}',null,'teste-sem-confianca')->>'status','queued','confiança ausente exige aprovação');
select is((select count(*)::int from public.deals where board_id = 'f6120000-0000-4000-8000-000000000001' and stage_id = 'f6130000-0000-4000-8000-000000000002'),1,'só a decisão autonomous na borda move o card');
create temp table opt_in_original as
select tenant_id, enabled_at from public.tenant_ai_features
where feature_key = 'pipeline_agent'
  and tenant_id = (select tenant_id from public.profiles where id = 'f6100000-0000-4000-8000-000000000001');
select ok((select enabled_at is not null from opt_in_original), 'banco registra a data de opt-in');
update public.tenant_ai_features set enabled_at = '2000-01-01', config = '{"teste":true}'
where feature_key = 'pipeline_agent' and tenant_id in (select tenant_id from opt_in_original);
select is((select f.enabled_at from public.tenant_ai_features f join opt_in_original o using(tenant_id) where feature_key = 'pipeline_agent'), (select enabled_at from opt_in_original), 'editar config ou forjar timestamp não retroage opt-in');
update public.tenant_ai_features set enabled = false
where feature_key = 'pipeline_agent' and tenant_id in (select tenant_id from opt_in_original);
select ok((select f.enabled_at is null from public.tenant_ai_features f join opt_in_original o using(tenant_id) where feature_key = 'pipeline_agent'), 'desligar encerra janela de opt-in');
update public.tenant_ai_features set enabled = true
where feature_key = 'pipeline_agent' and tenant_id in (select tenant_id from opt_in_original);
select ok((select f.enabled_at > o.enabled_at from public.tenant_ai_features f join opt_in_original o using(tenant_id) where feature_key = 'pipeline_agent'), 'religar abre nova janela');
select is((select count(*)::int from public.claim_event_deliveries('novo-opt-in', 500, 60, array['pipeline.opt_in_test'], array['pipeline.agent'])), 0, 'religar não reprocessa eventos da janela anterior');

-- O enriquecimento compartilha o claim, mas tem uma janela de opt-in própria.
insert into public.ai_feature_catalog(feature_key, label, default_enabled, toggle_authority)
values ('contact_auto_enrichment', 'Enriquecimento de contatos', false, 'tenant_admin')
on conflict do nothing;
insert into public.tenant_ai_features(tenant_id, feature_key, enabled)
select tenant_id, 'contact_auto_enrichment', true from opt_in_original;
insert into public.domain_event_subscriptions(subscriber_id, event_types, active)
values ('contact.enrichment', array['pipeline.opt_in_test'], true)
on conflict (subscriber_id) do update
set event_types = array_append(public.domain_event_subscriptions.event_types, 'pipeline.opt_in_test'),
    active = true;
insert into public.domain_events(id, tenant_id, event_type, aggregate_type, aggregate_id, idempotency_key, created_at)
select 'f6110000-0000-4000-8000-000000000011', tenant_id, 'pipeline.opt_in_test', 'contact', gen_random_uuid(), 'enrichment-teste:novo', clock_timestamp()
from opt_in_original;
insert into public.domain_events(id, tenant_id, event_type, aggregate_type, aggregate_id, idempotency_key, created_at)
select 'f6110000-0000-4000-8000-000000000012', tenant_id, 'pipeline.opt_in_test', 'contact', gen_random_uuid(), 'enrichment-teste:antigo', now() - interval '1 day'
from opt_in_original;
insert into public.domain_events(id, tenant_id, event_type, aggregate_type, aggregate_id, idempotency_key)
select 'f6110000-0000-4000-8000-000000000013', tenant_id, 'pipeline.opt_in_test', 'contact', gen_random_uuid(), 'enrichment-teste:outro'
from public.profiles where id = 'f6100000-0000-4000-8000-000000000002';
insert into public.domain_events(id, tenant_id, event_type, aggregate_type, aggregate_id, idempotency_key)
select 'f6110000-0000-4000-8000-000000000014', tenant_id, 'pipeline.opt_in_test', 'contact', gen_random_uuid(), 'enrichment-teste:lease-outro'
from public.profiles where id = 'f6100000-0000-4000-8000-000000000002';
-- Preserva a prova de claim sobre backlog anterior ao guard de fan-out.
insert into public.event_deliveries(event_id, tenant_id, subscriber_id, max_attempts)
select e.id, e.tenant_id, s.subscriber_id, s.max_attempts
from public.domain_events e cross join public.domain_event_subscriptions s
where e.id in ('f6110000-0000-4000-8000-000000000012', 'f6110000-0000-4000-8000-000000000013', 'f6110000-0000-4000-8000-000000000014')
  and s.subscriber_id = 'contact.enrichment'
on conflict (event_id, subscriber_id) do nothing;
update public.event_deliveries set status = 'processing', attempts = max_attempts,
  locked_at = now() - interval '1 day', locked_by = 'worker-antigo'
where event_id = 'f6110000-0000-4000-8000-000000000014' and subscriber_id = 'contact.enrichment';
create temp table enrichment_claim as select * from public.claim_event_deliveries('enrichment-teste', 500, 60, array['pipeline.opt_in_test'], array['contact.enrichment']);
select results_eq($$select event_id from enrichment_claim$$, $$values ('f6110000-0000-4000-8000-000000000011'::uuid)$$, 'enriquecimento só recebe evento novo do próprio opt-in');
select is((select status || ':' || attempts from public.event_deliveries where event_id = 'f6110000-0000-4000-8000-000000000012' and subscriber_id = 'contact.enrichment'), 'pending:0', 'backlog de enriquecimento continua intocado');
select is((select status || ':' || attempts from public.event_deliveries where event_id = 'f6110000-0000-4000-8000-000000000013' and subscriber_id = 'contact.enrichment'), 'pending:0', 'enriquecimento sem opt-in continua intocado');
select is((select status from public.event_deliveries where event_id = 'f6110000-0000-4000-8000-000000000014' and subscriber_id = 'contact.enrichment'), 'processing', 'limpeza de lease de enriquecimento respeita opt-in');

-- A autorização precisa continuar válida depois do claim e durante o LLM.
insert into public.deals(id,tenant_id,board_id,stage_id,title,status)
select ('f6140000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid, tenant_id,
  'f6120000-0000-4000-8000-000000000001','f6130000-0000-4000-8000-000000000001','Revogação ' || n,'open'
from opt_in_original cross join generate_series(8,11) n;
update public.domain_event_subscriptions
set event_types = array_append(event_types, 'pipeline.revalidation_test')
where subscriber_id = 'pipeline.agent';
create temp table pipeline_window as
select jsonb_build_object('pipeline_agent_enabled_at', enabled_at) as snapshot
from public.tenant_ai_features
where feature_key = 'pipeline_agent' and tenant_id in (select tenant_id from opt_in_original);
insert into public.domain_events(id,tenant_id,event_type,aggregate_type,aggregate_id,idempotency_key,created_at)
select 'f6110000-0000-4000-8000-000000000021',tenant_id,'pipeline.revalidation_test','deal',
  'f6140000-0000-4000-8000-000000000008','pipeline-revalidation:off',clock_timestamp()
from opt_in_original;
insert into public.domain_events(id,tenant_id,event_type,aggregate_type,aggregate_id,idempotency_key,created_at)
select 'f6110000-0000-4000-8000-000000000022',tenant_id,'pipeline.revalidation_test','deal',
  'f6140000-0000-4000-8000-000000000009','pipeline-revalidation:renew',clock_timestamp()
from opt_in_original;
select is((select count(*)::int from public.claim_event_deliveries(
  'pipeline-revalidation',20,180,array['pipeline.revalidation_test'],array['pipeline.agent']
)),2,'lote já foi reclamado antes da revogação');
update public.tenant_ai_features set enabled = false
where feature_key = 'pipeline_agent' and tenant_id in (select tenant_id from opt_in_original);
select is(public.transition_deal_stage(
  'f6140000-0000-4000-8000-000000000008','f6130000-0000-4000-8000-000000000001',
  'f6130000-0000-4000-8000-000000000002','ai',null,'Avaliação em voo','{}',0.79,'pipeline-revalidation:off',
  p_prompt_snapshot := (select snapshot from pipeline_window),
  p_correlation_id := 'f6110000-0000-4000-8000-000000000021'
)->>'reason','pipeline_agent_opt_in_changed','opt-out após claim bloqueia resultado, inclusive aprovação de baixa confiança');
select is(public.transition_deal_stage(
  'f6140000-0000-4000-8000-000000000011','f6130000-0000-4000-8000-000000000001',
  'f6130000-0000-4000-8000-000000000002','ai',null,'IA conversacional sem domain event','{}',0.80,'pipeline-revalidation:conversacional'
)->>'status','accepted','IA conversacional sem origem no pipeline preserva comportamento');
update public.tenant_ai_features set enabled = true
where feature_key = 'pipeline_agent' and tenant_id in (select tenant_id from opt_in_original);
select is(public.transition_deal_stage(
  'f6140000-0000-4000-8000-000000000009','f6130000-0000-4000-8000-000000000001',
  'f6130000-0000-4000-8000-000000000002','ai',null,'Janela anterior','{}',0.80,'pipeline-revalidation:renew',
  p_prompt_snapshot := (select snapshot from pipeline_window),
  p_correlation_id := 'f6110000-0000-4000-8000-000000000022'
)->>'reason','pipeline_agent_opt_in_changed','religar não autoriza resultado da janela anterior');
update pipeline_window set snapshot = (
  select jsonb_build_object('pipeline_agent_enabled_at', enabled_at) from public.tenant_ai_features
  where feature_key = 'pipeline_agent' and tenant_id in (select tenant_id from opt_in_original)
);
select is(public.transition_deal_stage(
  'f6140000-0000-4000-8000-000000000009','f6130000-0000-4000-8000-000000000001',
  'f6130000-0000-4000-8000-000000000002','ai',null,'Evento antigo com stamp novo','{}',0.80,'pipeline-revalidation:stamp-forjado',
  p_prompt_snapshot := (select snapshot from pipeline_window),
  p_correlation_id := 'f6110000-0000-4000-8000-000000000022'
)->>'reason','pipeline_agent_opt_in_changed','stamp atual não autoriza evento anterior ao opt-in');
select is((select count(*)::int from public.deal_stage_history where deal_id in (
  'f6140000-0000-4000-8000-000000000008','f6140000-0000-4000-8000-000000000009'
)),0,'resultados revogados não movimentam os cards');
select is((select count(*)::int from public.ai_pending_stage_advances where deal_id in (
  'f6140000-0000-4000-8000-000000000008','f6140000-0000-4000-8000-000000000009'
)),0,'resultados revogados também não criam aprovações');
insert into public.domain_events(id,tenant_id,event_type,aggregate_type,aggregate_id,idempotency_key,created_at)
select 'f6110000-0000-4000-8000-000000000023',tenant_id,'pipeline.revalidation_test','deal',
  'f6140000-0000-4000-8000-000000000010','pipeline-revalidation:atual',clock_timestamp()
from opt_in_original;
select is(public.transition_deal_stage(
  'f6140000-0000-4000-8000-000000000010','f6130000-0000-4000-8000-000000000001',
  'f6130000-0000-4000-8000-000000000002','ai',null,'Worker antigo sem snapshot','{}',0.80,'pipeline-revalidation:sem-snapshot',
  p_correlation_id := 'f6110000-0000-4000-8000-000000000023'
)->>'reason','pipeline_agent_opt_in_changed','omitir snapshot não permite contornar autorização');
select is(public.transition_deal_stage(
  'f6140000-0000-4000-8000-000000000010','f6130000-0000-4000-8000-000000000001',
  'f6130000-0000-4000-8000-000000000002','ai',null,'Janela vigente','{}',0.80,'pipeline-revalidation:atual',
  p_prompt_snapshot := (select snapshot from pipeline_window),
  p_correlation_id := 'f6110000-0000-4000-8000-000000000023'
)->>'status','accepted','evento e avaliação da janela vigente continuam avançando');
select ok(exists(select 1 from public.deal_stage_history
  where deal_id='f6140000-0000-4000-8000-000000000010' and actor_type='ai'
    and correlation_id='f6110000-0000-4000-8000-000000000023'
),'controle positivo registra movimento genuíno na janela vigente');
select * from finish();
rollback;
