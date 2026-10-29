begin;
create extension if not exists pgtap;
select plan(43);
select ok(exists(select 1 from public.ai_feature_catalog where feature_key = 'contact_auto_enrichment' and not default_enabled and toggle_authority = 'tenant_admin'), 'enriquecimento exige opt-in do admin');
select has_function('public', 'enqueue_contact_enrichment', array['uuid'], 'eventos alimentam a fila de contatos');
select has_function('public', 'claim_contact_enrichment', array[]::text[], 'claim atômico respeita debounce e janela');
select has_function('public', 'complete_contact_enrichment', array['uuid','uuid','jsonb','text'], 'aplicação atômica protege edições humanas');

insert into auth.users(id,email) values
  ('f5300000-0000-4000-8000-000000000001','ficha-a@test.invalid'),
  ('f5300000-0000-4000-8000-000000000002','ficha-b@test.invalid');
insert into public.tenant_ai_features(tenant_id,feature_key,enabled)
select tenant_id,'contact_auto_enrichment',true from public.profiles where id='f5300000-0000-4000-8000-000000000001';
insert into public.contacts(id,tenant_id,name)
select ('f5310000-0000-4000-8000-'||right(id::text,12))::uuid,tenant_id,'Cliente de teste' from public.profiles
where id in ('f5300000-0000-4000-8000-000000000001','f5300000-0000-4000-8000-000000000002');
insert into public.channels(id,tenant_id,provider_slug,type)
select ('f5320000-0000-4000-8000-'||right(id::text,12))::uuid,tenant_id,'simulator','simulator' from public.profiles
where id in ('f5300000-0000-4000-8000-000000000001','f5300000-0000-4000-8000-000000000002');
insert into public.conversations(id,tenant_id,contact_id,channel_id)
select ('f5330000-0000-4000-8000-'||right(id::text,12))::uuid,tenant_id,
 ('f5310000-0000-4000-8000-'||right(id::text,12))::uuid,('f5320000-0000-4000-8000-'||right(id::text,12))::uuid
from public.profiles where id in ('f5300000-0000-4000-8000-000000000001','f5300000-0000-4000-8000-000000000002');
insert into public.custom_field_definitions(tenant_id,entity,key,label,field_type)
select tenant_id,'contact','interesse','Interesse','text' from public.profiles where id='f5300000-0000-4000-8000-000000000001';

insert into public.messages(id,tenant_id,conversation_id,sender,direction,content,created_at)
select 'f5340000-0000-4000-8000-000000000001',tenant_id,'f5330000-0000-4000-8000-000000000001',
  'contact','in','Meu e-mail é ana@example.test, moro em Curitiba e quero implante.',clock_timestamp()
from public.profiles where id='f5300000-0000-4000-8000-000000000001';
insert into public.messages(id,tenant_id,conversation_id,sender,direction,content,created_at)
select 'f5340000-0000-4000-8000-000000000002',tenant_id,'f5330000-0000-4000-8000-000000000002',
  'contact','in','Não autorizei enriquecimento.',clock_timestamp()
from public.profiles where id='f5300000-0000-4000-8000-000000000002';
-- A transação do teste começou antes do opt-in; simula as transações seguintes do runtime.
update public.domain_events set created_at=clock_timestamp() where aggregate_id in ('f5340000-0000-4000-8000-000000000001','f5340000-0000-4000-8000-000000000002');
select is(public.enqueue_contact_enrichment((select id from public.domain_events where aggregate_id='f5340000-0000-4000-8000-000000000002')),false,'sem opt-in não enfileira');
select is(public.enqueue_contact_enrichment((select id from public.domain_events where aggregate_id='f5340000-0000-4000-8000-000000000001')),true,'mensagem opt-in enfileira');
select is(public.enqueue_contact_enrichment((select id from public.domain_events where aggregate_id='f5340000-0000-4000-8000-000000000001')),false,'evento repetido não altera debounce ou contador');
select is((select message_count from public.contact_extraction_queue where contact_id='f5310000-0000-4000-8000-000000000001'),1,'contador não duplica');
select is(public.claim_contact_enrichment(),null::jsonb,'não processa durante debounce');
insert into public.messages(id,tenant_id,conversation_id,sender,direction,content,created_at)
select ('f5340000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,tenant_id,'f5330000-0000-4000-8000-000000000001',
  'contact','in','Tenho interesse em implante.',clock_timestamp()
from public.profiles cross join generate_series(3,6) n where id='f5300000-0000-4000-8000-000000000001';
update public.domain_events set created_at=clock_timestamp() where aggregate_id::text like 'f5340000-%';
select public.enqueue_contact_enrichment(id) from public.domain_events where aggregate_id::text like 'f5340000-%' and aggregate_id not in ('f5340000-0000-4000-8000-000000000001','f5340000-0000-4000-8000-000000000002');
create temp table claimed as select public.claim_contact_enrichment() job;
select is((select jsonb_array_length(job->'messages') from claimed),5,'cinco mensagens liberam lote sem esperar debounce');
select is(public.claim_contact_enrichment(),null::jsonb,'worker concorrente não toma o mesmo contato');

update public.contacts set email='humano@example.test',custom_fields='{"interesse":"corrigido"}'
where id='f5310000-0000-4000-8000-000000000001';
update public.contacts set custom_fields='{}' where id='f5310000-0000-4000-8000-000000000001';
create temp table completed as select public.complete_contact_enrichment('f5310000-0000-4000-8000-000000000001',
  (job->>'lease_token')::uuid,
  jsonb_build_object('memory',jsonb_build_object('history_summary','Cliente procura implante.'),
    'summaries',jsonb_build_array(jsonb_build_object('conversation_id','f5330000-0000-4000-8000-000000000001','summary','Informou e-mail, cidade e interesse.')),
    'fields',jsonb_build_array(
      jsonb_build_object('field_name','email','field_type','native','value','ana@example.test','confidence',0.98,'source_message_ids',array['f5340000-0000-4000-8000-000000000001']),
      jsonb_build_object('field_name','address_city','field_type','native','value','Curitiba','confidence',0.97,'source_message_ids',array['f5340000-0000-4000-8000-000000000001']),
      jsonb_build_object('field_name','interesse','field_type','custom','value','implante','confidence',0.95,'source_message_ids',array['f5340000-0000-4000-8000-000000000001'])
    )), 'modelo-teste') result from claimed;
select is((select result->>'applied' from completed),'1','somente cidade vazia é aplicada');
select is((select result->>'ignored' from completed),'2','e-mail corrigido e campo apagado são ignorados');
select is((select email from public.contacts where id='f5310000-0000-4000-8000-000000000001'),'humano@example.test','edição humana posterior prevalece');
select is((select custom_fields from public.contacts where id='f5310000-0000-4000-8000-000000000001'),'{}'::jsonb,'limpeza humana posterior também é preservada');
select is((select count(*)::int from public.contact_field_extractions where contact_id='f5310000-0000-4000-8000-000000000001' and apply_reason='Campo editado após a mensagem-fonte'),2,'histórico registra motivo de ambas as proteções');
select is((select ai_memory->>'history_summary' from public.contacts where id='f5310000-0000-4000-8000-000000000001'),'Cliente procura implante.','memória consolidada gravada');
select is((select count(*)::int from public.ai_conversation_summaries where contact_id='f5310000-0000-4000-8000-000000000001'),1,'resumo gravado atomicamente');
select throws_ok($q$select public.complete_contact_enrichment('f5310000-0000-4000-8000-000000000001',(select (job->>'lease_token')::uuid from claimed),'{}','modelo-teste')$q$,'P0001','Lease de extração expirado','retry não duplica histórico ou memória');
select is(public.claim_contact_enrichment(),null::jsonb,'lote concluído não executa novamente');
insert into public.messages(id,tenant_id,conversation_id,sender,direction,content,created_at)
select 'f5340000-0000-4000-8000-000000000007',tenant_id,'f5330000-0000-4000-8000-000000000001',
  'contact','in','Nova informação.',clock_timestamp() from public.profiles where id='f5300000-0000-4000-8000-000000000001';
update public.domain_events set created_at=clock_timestamp() where aggregate_id='f5340000-0000-4000-8000-000000000007';
select public.enqueue_contact_enrichment(id) from public.domain_events where aggregate_id='f5340000-0000-4000-8000-000000000007';
update public.contact_extraction_queue set next_run_at=clock_timestamp()-interval '1 second' where contact_id='f5310000-0000-4000-8000-000000000001';
select is(public.claim_contact_enrichment(),null::jsonb,'mesmo com novo lote pronto a janela impede segunda execução');

-- Revogar e reativar durante o LLM não pode reaproveitar o lease anterior.
update public.contact_extraction_queue set last_started_at=clock_timestamp()-interval '3 minutes'
where contact_id='f5310000-0000-4000-8000-000000000001';
create temp table old_claim as select public.claim_contact_enrichment() job;
update public.tenant_ai_features set enabled=false where feature_key='contact_auto_enrichment'
  and tenant_id=(select tenant_id from public.profiles where id='f5300000-0000-4000-8000-000000000001');
update public.tenant_ai_features set enabled=true where feature_key='contact_auto_enrichment'
  and tenant_id=(select tenant_id from public.profiles where id='f5300000-0000-4000-8000-000000000001');
insert into public.messages(id,tenant_id,conversation_id,sender,direction,content,created_at)
select 'f5340000-0000-4000-8000-000000000008',tenant_id,'f5330000-0000-4000-8000-000000000001',
  'contact','in','Mensagem da nova autorização.',clock_timestamp() from public.profiles where id='f5300000-0000-4000-8000-000000000001';
update public.domain_events set created_at=clock_timestamp() where aggregate_id='f5340000-0000-4000-8000-000000000008';
select public.enqueue_contact_enrichment(id) from public.domain_events where aggregate_id='f5340000-0000-4000-8000-000000000008';
select is((select public.complete_contact_enrichment('f5310000-0000-4000-8000-000000000001',(job->>'lease_token')::uuid,
  '{"memory":{"history_summary":"Memória da autorização revogada"},"fields":[],"summaries":[]}','modelo-teste')->>'skipped' from old_claim),
  'feature_off','novo opt-in invalida resultado do LLM iniciado na autorização revogada');
select is((select ai_memory->>'history_summary' from public.contacts where id='f5310000-0000-4000-8000-000000000001'),
  'Cliente procura implante.','revogação impede gravação tardia da memória');

select ok(not has_table_privilege('authenticated','public.contact_field_extractions','INSERT,UPDATE,DELETE'),'membros não possuem escrita no histórico');
select ok(not has_function_privilege('authenticated','public.complete_contact_enrichment(uuid,uuid,jsonb,text)','EXECUTE'),'aplicação só aceita service_role');
select ok(has_table_privilege('service_role','public.contact_field_extractions','INSERT,UPDATE,DELETE'),'service_role pode gravar');
select ok(not has_table_privilege('authenticated','public.contact_extraction_queue','INSERT,UPDATE,DELETE'),'membros não alteram a fila do worker');
select ok(not has_table_privilege('authenticated','public.contact_enrichment_receipts','INSERT,UPDATE,DELETE'),'membros não alteram recibos de processamento');
select ok(not has_table_privilege('authenticated','public.contact_field_edit_versions','INSERT,UPDATE,DELETE'),'membros não forjam versões de edição');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"f5300000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select is((select count(*)::int from public.contact_field_extractions where contact_id='f5310000-0000-4000-8000-000000000001'),3,'membro ativo lê o histórico próprio');
select results_eq(
  $q$select origem from (
    select distinct 'fila'::text origem from public.contact_extraction_queue where contact_id='f5310000-0000-4000-8000-000000000001'
    union all select distinct 'recibos' from public.contact_enrichment_receipts where contact_id='f5310000-0000-4000-8000-000000000001'
    union all select distinct 'versoes' from public.contact_field_edit_versions where contact_id='f5310000-0000-4000-8000-000000000001'
  ) registros order by origem$q$,
  $q$values ('fila'::text),('recibos'),('versoes')$q$,
  'membro ativo lê fila, recibos e versões do próprio tenant'
);
select throws_ok($q$update public.contact_field_extractions set applied=true$q$,'42501',null,'membro não pode forjar aplicação');
select set_config('request.jwt.claims','{"sub":"f5300000-0000-4000-8000-000000000002","role":"authenticated"}',true);
select is((select count(*)::int from public.contact_field_extractions where contact_id='f5310000-0000-4000-8000-000000000001'),0,'outro tenant não lê histórico');
select is((select count(*)::int from (
  select contact_id from public.contact_extraction_queue where contact_id='f5310000-0000-4000-8000-000000000001'
  union all select contact_id from public.contact_enrichment_receipts where contact_id='f5310000-0000-4000-8000-000000000001'
  union all select contact_id from public.contact_field_edit_versions where contact_id='f5310000-0000-4000-8000-000000000001'
) registros),0,'outro tenant não lê fila, recibos ou versões');
reset role;
update public.tenant_memberships set status='revoked',revoked_at=clock_timestamp() where user_id='f5300000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"f5300000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select is((select count(*)::int from public.contact_field_extractions where contact_id='f5310000-0000-4000-8000-000000000001'),0,'membro revogado perde leitura');
select is((select count(*)::int from (
  select contact_id from public.contact_extraction_queue where contact_id='f5310000-0000-4000-8000-000000000001'
  union all select contact_id from public.contact_enrichment_receipts where contact_id='f5310000-0000-4000-8000-000000000001'
  union all select contact_id from public.contact_field_edit_versions where contact_id='f5310000-0000-4000-8000-000000000001'
) registros),0,'revogar membro remove leitura da fila, dos recibos e das versões');
reset role;
set local role anon;
select throws_ok($q$select * from public.contact_field_extractions$q$,'42501',null,'anônimo não lê histórico');
reset role;
select ok(exists(select 1 from private.scheduled_job_catalog() where jobname='contact-enrichment-dispatcher' and schedule='* * * * *'),'rotina está no catálogo');
select is((select count(*)::int from private.scheduled_job_catalog()),17,'quinze rotinas anteriores preservadas mais o worker de webhooks e a retenção de entrada');
select ok(not exists(select 1 from public.contact_extraction_queue where contact_id='f5310000-0000-4000-8000-000000000002'),'tenant desligado permanece sem fila');
select col_default_is('public','contact_extraction_queue','next_run_at','now()','schema parcial converge para o mesmo default da fila nova');
select ok(not exists(select 1 from pg_policies where schemaname='public' and tablename='contact_extraction_queue' and roles @> array['public']::name[]),'policy pública legada da fila foi removida');
select ok(not exists(select 1 from pg_constraint where conrelid='public.contact_field_extractions'::regclass and conname='contact_field_extractions_tenant_id_contact_id_field_name_s_key'),'histórico parcial usa a mesma chave de idempotência do schema novo');
select * from finish();
rollback;
