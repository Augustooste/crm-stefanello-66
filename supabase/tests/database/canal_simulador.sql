begin;
select plan(28);
select has_function('public', 'create_simulator_channel', array[]::text[], 'Criação de canal disponível');

set session_replication_role = replica;
insert into public.tenants(id, name) values
 ('f4000000-0000-4000-8000-000000000001', 'Simulação A'),
 ('f4000000-0000-4000-8000-000000000002', 'Simulação B');
insert into auth.users(id, email) values
 ('f4000000-0000-4000-8000-000000000011', 'simulator-admin-a@test.invalid'),
 ('f4000000-0000-4000-8000-000000000012', 'simulator-admin-b@test.invalid'),
 ('f4000000-0000-4000-8000-000000000013', 'simulator-member@test.invalid');
insert into public.profiles(id, tenant_id, name, role) values
 ('f4000000-0000-4000-8000-000000000011', 'f4000000-0000-4000-8000-000000000001', 'Admin A', 'admin'),
 ('f4000000-0000-4000-8000-000000000012', 'f4000000-0000-4000-8000-000000000002', 'Admin B', 'admin'),
 ('f4000000-0000-4000-8000-000000000013', 'f4000000-0000-4000-8000-000000000001', 'Membro A', 'agent');
insert into public.roles(tenant_id, role_key, name, is_system) values
 ('f4000000-0000-4000-8000-000000000001', 'admin', 'Admin', true),
 ('f4000000-0000-4000-8000-000000000001', 'agent', 'Membro', true),
 ('f4000000-0000-4000-8000-000000000002', 'admin', 'Admin', true);
insert into public.role_permissions(role_id,permission_id)
 select r.id,p.id from public.roles r cross join public.permissions p
 where r.tenant_id in ('f4000000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000002')
   and r.role_key='admin';
insert into public.contact_statuses(tenant_id,slug,label,color,sort_order) values
 ('f4000000-0000-4000-8000-000000000001','lead','Lead','#64748b',1),
 ('f4000000-0000-4000-8000-000000000002','lead','Lead','#64748b',1);
insert into public.tenant_memberships(tenant_id, user_id, role_id, status)
 select p.tenant_id, p.id, r.id, 'active' from public.profiles p join public.roles r
 on r.tenant_id=p.tenant_id and r.role_key=p.role
 where p.id in ('f4000000-0000-4000-8000-000000000011', 'f4000000-0000-4000-8000-000000000012', 'f4000000-0000-4000-8000-000000000013');
set session_replication_role = default;

select is((select default_enabled from public.ai_feature_catalog where feature_key='channel_simulator'), false, 'Simulador nasce desligado');
select ok(not has_function_privilege('anon', 'public.create_simulator_channel()', 'EXECUTE'), 'Anônimo não cria canal');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f4000000-0000-4000-8000-000000000011","role":"authenticated"}', true);
select lives_ok('select public.create_simulator_channel()', 'Admin ativa o próprio canal');
select lives_ok('select public.create_simulator_channel()', 'Criação é idempotente');
select is((select count(*)::int from public.channels where provider_slug='simulator'), 1, 'Só um canal de demonstração por tenant');
select is((select enabled from public.tenant_ai_features where feature_key='channel_simulator'), true, 'Criação é opt-in explícito');
select set_config('request.jwt.claims', '{"sub":"f4000000-0000-4000-8000-000000000012","role":"authenticated"}', true);
select lives_ok('select public.create_simulator_channel()', 'Outro admin cria canal isolado');
reset role;
insert into public.contacts(id, tenant_id, name) values
 ('f4000000-0000-4000-8000-000000000021','f4000000-0000-4000-8000-000000000001','Cliente simulado A'),
 ('f4000000-0000-4000-8000-000000000022','f4000000-0000-4000-8000-000000000002','Cliente simulado B');
insert into public.conversations(id, tenant_id, channel_id, contact_id)
 select 'f4000000-0000-4000-8000-000000000031', tenant_id, id, 'f4000000-0000-4000-8000-000000000021'
 from public.channels where tenant_id='f4000000-0000-4000-8000-000000000001' and provider_slug='simulator';
insert into public.conversations(id, tenant_id, channel_id, contact_id)
 select 'f4000000-0000-4000-8000-000000000032', tenant_id, id, 'f4000000-0000-4000-8000-000000000022'
 from public.channels where tenant_id='f4000000-0000-4000-8000-000000000002' and provider_slug='simulator';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f4000000-0000-4000-8000-000000000013","role":"authenticated"}', true);
select throws_ok('select public.create_simulator_channel()', '42501', null, 'Membro não cria canal');
select is((select count(*)::int from public.channels where tenant_id='f4000000-0000-4000-8000-000000000002'), 0, 'Membro não vê canal alheio');
select throws_ok($q$insert into public.messages(tenant_id,conversation_id,sender,direction,content)
 values('f4000000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000032','contact','in','Injeção')$q$,
 '42501', null, 'Mensagem com tenant próprio não pode apontar para conversa simulada alheia');
reset role;
insert into public.messages(id,tenant_id,conversation_id,sender,direction,content,status) values
 ('f4000000-0000-4000-8000-000000000041','f4000000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000031','ai','out','Resposta real de IA no transporte simulado','sent');
select is((select metadata->>'simulated' from public.messages where id='f4000000-0000-4000-8000-000000000041'),'true','Saída rotulada como simulação');
select ok((select delivered_at is not null and metadata->>'delivery'='simulator' from public.messages where id='f4000000-0000-4000-8000-000000000041'),'Entrega registrada só no simulador');
select ok((select bool_and(relrowsecurity) from pg_class where oid in ('public.channels'::regclass,'public.messages'::regclass,'public.tenant_ai_features'::regclass)), 'RLS permanece ativa');

select is((select public from storage.buckets where id='simulator-media'),false,'Mídia simulada usa bucket privado próprio');
select is((select file_size_limit from storage.buckets where id='simulator-media'),16777216::bigint,'Mídia simulada mantém limite de 16 MB');
select is((select allowed_mime_types from storage.buckets where id='simulator-media'),
  array['image/jpeg','image/png','image/webp','image/gif','audio/mpeg','audio/ogg','audio/mp4','audio/aac','audio/amr','audio/wav','audio/webm'],
  'Bucket do simulador aceita os formatos de imagem e áudio do endpoint');

create temp table simulator_paths as
select tenant_id,tenant_id::text||'/simulator/'||id::text||'/anexo.png' object_path
from public.channels where provider_slug='simulator'
  and tenant_id in ('f4000000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000002');
grant select on simulator_paths to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f4000000-0000-4000-8000-000000000011","role":"authenticated"}', true);
select lives_ok($q$insert into storage.objects(bucket_id,name)
  select 'simulator-media',object_path from simulator_paths where tenant_id='f4000000-0000-4000-8000-000000000001'$q$,
  'Tenant ativo envia anexo para o próprio canal');
select is((select count(*)::int from storage.objects where bucket_id='simulator-media'),1,'Tenant lê o próprio anexo');
select throws_ok($q$insert into storage.objects(bucket_id,name)
  select 'simulator-media',object_path from simulator_paths where tenant_id='f4000000-0000-4000-8000-000000000002'$q$,
  '42501',null,'Tenant não envia anexo para canal alheio');
select throws_ok($q$insert into storage.objects(bucket_id,name)
  values('simulator-media','f4000000-0000-4000-8000-000000000001/outro/anexo.png')$q$,
  '42501',null,'Upload exige prefixo simulator');
select throws_ok($q$insert into storage.objects(bucket_id,name)
  values('simulator-media','f4000000-0000-4000-8000-000000000001/simulator/f4000000-0000-4000-8000-000000000099/anexo.png')$q$,
  '42501',null,'Prefixo do tenant não permite inventar canal');
select set_config('request.jwt.claims', '{"sub":"f4000000-0000-4000-8000-000000000012","role":"authenticated"}', true);
select is((select count(*)::int from storage.objects where bucket_id='simulator-media'),0,'Outro tenant não lê anexo alheio');
reset role;

update public.tenant_ai_features set enabled=false
where tenant_id='f4000000-0000-4000-8000-000000000001' and feature_key='channel_simulator';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f4000000-0000-4000-8000-000000000011","role":"authenticated"}', true);
select is((select count(*)::int from storage.objects where bucket_id='simulator-media'),0,'Sem opt-in não lê anexo');
select throws_ok($q$insert into storage.objects(bucket_id,name)
  select 'simulator-media',object_path||'.desativado' from simulator_paths where tenant_id='f4000000-0000-4000-8000-000000000001'$q$,
  '42501',null,'Sem opt-in não envia anexo');
reset role;
update public.tenant_ai_features set enabled=true
where tenant_id='f4000000-0000-4000-8000-000000000001' and feature_key='channel_simulator';
update public.channels set status='disconnected'
where tenant_id='f4000000-0000-4000-8000-000000000001' and provider_slug='simulator';
set local role authenticated;
select is((select count(*)::int from storage.objects where bucket_id='simulator-media'),0,'Canal desconectado não permite ler anexo');
select throws_ok($q$insert into storage.objects(bucket_id,name)
  select 'simulator-media',object_path||'.desconectado' from simulator_paths where tenant_id='f4000000-0000-4000-8000-000000000001'$q$,
  '42501',null,'Canal desconectado não permite enviar anexo');
reset role;
set local role anon;
select is((select count(*)::int from storage.objects where bucket_id='simulator-media'),0,'Anônimo não lê mídia simulada');
reset role;
select * from finish();
rollback;
