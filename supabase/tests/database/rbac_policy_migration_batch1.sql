begin;
create extension if not exists pgtap;
select plan(26);

select is((select count(*)::int from pg_policies where tablename in ('contacts','deals','activities','conversations','messages') and policyname like '%active tenant%'), 5, 'cinco policies migradas existem');
select is((select count(*)::int from pg_policies where tablename in ('contacts','deals','activities','conversations','messages') and policyname in ('contacts tenant all','deals tenant all','activities tenant all','conversations tenant all','messages tenant all')), 0, 'policies legadas do lote foram removidas');
select is((select count(*)::int from pg_policies where tablename in ('contacts','deals','activities','conversations','messages') and cmd='ALL' and 'authenticated'=any(roles)), 5, 'comportamento CRUD de admin/agent preservado');
select is((select count(*)::int from pg_policies where tablename in ('contacts','deals','activities','conversations','messages') and qual ilike '%get_active_tenant_id%'), 5, 'todas as policies validam tenant ativo');
select has_column('public','profiles','tenant_id','profiles.tenant_id não foi removido');

insert into auth.users (id,email) values
 ('91111111-1111-1111-1111-111111111111','policy-a@test.local'),
 ('92222222-2222-2222-2222-222222222222','policy-b@test.local');

-- Give each user an agent membership in the other tenant. This models future
-- workspace switching while their legacy profile remains unchanged.
insert into public.tenant_memberships(tenant_id,user_id,role_id)
select p.tenant_id, '92222222-2222-2222-2222-222222222222', r.id
from public.profiles p join public.roles r on r.tenant_id=p.tenant_id and r.role_key='agent'
where p.id='91111111-1111-1111-1111-111111111111';
insert into public.tenant_memberships(tenant_id,user_id,role_id)
select p.tenant_id, '91111111-1111-1111-1111-111111111111', r.id
from public.profiles p join public.roles r on r.tenant_id=p.tenant_id and r.role_key='agent'
where p.id='92222222-2222-2222-2222-222222222222';

-- One complete core-domain graph per tenant, seeded server-side.
insert into public.contacts(id,tenant_id,name,status)
select '93333333-3333-3333-3333-333333333331',tenant_id,'Contato A','contact' from public.profiles where id='91111111-1111-1111-1111-111111111111';
insert into public.contacts(id,tenant_id,name,status)
select '93333333-3333-3333-3333-333333333332',tenant_id,'Contato B','contact' from public.profiles where id='92222222-2222-2222-2222-222222222222';
insert into public.boards(id,tenant_id,name)
select '94444444-4444-4444-4444-444444444441',tenant_id,'Board A' from public.profiles where id='91111111-1111-1111-1111-111111111111';
insert into public.boards(id,tenant_id,name)
select '94444444-4444-4444-4444-444444444442',tenant_id,'Board B' from public.profiles where id='92222222-2222-2222-2222-222222222222';
insert into public.board_stages(id,board_id,name) values
 ('95555555-5555-5555-5555-555555555551','94444444-4444-4444-4444-444444444441','Novo'),
 ('95555555-5555-5555-5555-555555555552','94444444-4444-4444-4444-444444444442','Novo');
insert into public.deals(id,tenant_id,board_id,stage_id,contact_id,title)
select '96666666-6666-6666-6666-666666666661',tenant_id,'94444444-4444-4444-4444-444444444441','95555555-5555-5555-5555-555555555551','93333333-3333-3333-3333-333333333331','Deal A' from public.profiles where id='91111111-1111-1111-1111-111111111111';
insert into public.deals(id,tenant_id,board_id,stage_id,contact_id,title)
select '96666666-6666-6666-6666-666666666662',tenant_id,'94444444-4444-4444-4444-444444444442','95555555-5555-5555-5555-555555555552','93333333-3333-3333-3333-333333333332','Deal B' from public.profiles where id='92222222-2222-2222-2222-222222222222';
insert into public.activities(id,tenant_id,deal_id,contact_id,type,title)
select '97777777-7777-7777-7777-777777777771',tenant_id,'96666666-6666-6666-6666-666666666661','93333333-3333-3333-3333-333333333331','task','Atividade A' from public.profiles where id='91111111-1111-1111-1111-111111111111';
insert into public.activities(id,tenant_id,deal_id,contact_id,type,title)
select '97777777-7777-7777-7777-777777777772',tenant_id,'96666666-6666-6666-6666-666666666662','93333333-3333-3333-3333-333333333332','task','Atividade B' from public.profiles where id='92222222-2222-2222-2222-222222222222';
insert into public.channels(id,tenant_id,type,provider_slug)
select '98888888-8888-4888-8888-888888888881',tenant_id,'whatsapp','test-a' from public.profiles where id='91111111-1111-1111-1111-111111111111';
insert into public.channels(id,tenant_id,type,provider_slug)
select '98888888-8888-4888-8888-888888888882',tenant_id,'whatsapp','test-b' from public.profiles where id='92222222-2222-2222-2222-222222222222';
insert into public.conversations(id,tenant_id,contact_id,channel_id)
select '99999999-9999-4999-8999-999999999991',tenant_id,'93333333-3333-3333-3333-333333333331','98888888-8888-4888-8888-888888888881' from public.profiles where id='91111111-1111-1111-1111-111111111111';
insert into public.conversations(id,tenant_id,contact_id,channel_id)
select '99999999-9999-4999-8999-999999999992',tenant_id,'93333333-3333-3333-3333-333333333332','98888888-8888-4888-8888-888888888882' from public.profiles where id='92222222-2222-2222-2222-222222222222';
insert into public.messages(id,tenant_id,conversation_id,direction,sender,content)
select 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',tenant_id,'99999999-9999-4999-8999-999999999991','in','contact','A' from public.profiles where id='91111111-1111-1111-1111-111111111111';
insert into public.messages(id,tenant_id,conversation_id,direction,sender,content)
select 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',tenant_id,'99999999-9999-4999-8999-999999999992','in','contact','B' from public.profiles where id='92222222-2222-2222-2222-222222222222';

-- Default workspace: user A sees and can write only tenant A.
set local role authenticated;
set local request.jwt.claims='{"sub":"91111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is((select count(*)::int from public.contacts),1,'default tenant: contacts isolados');
select is((select count(*)::int from public.deals),1,'default tenant: deals isolados');
select is((select count(*)::int from public.activities),1,'default tenant: activities isoladas');
select is((select count(*)::int from public.conversations),1,'default tenant: conversations isoladas');
select is((select count(*)::int from public.messages),1,'default tenant: messages isoladas');
insert into public.contacts(tenant_id,name,status) values(private.get_active_tenant_id(),'Escrita A','contact');
select is((select count(*)::int from public.contacts),2,'admin mantém escrita no tenant ativo');
reset role;

-- Server-selected workspace B: same user switches through app_metadata and
-- sees only B because an active agent membership exists there.
select set_config('request.jwt.claims',jsonb_build_object('sub','91111111-1111-1111-1111-111111111111','role','authenticated','app_metadata',jsonb_build_object('active_tenant_id',(select tenant_id from public.profiles where id='92222222-2222-2222-2222-222222222222')))::text,true);
set local role authenticated;
select is((select name from public.contacts),'Contato B','tenant switching muda contacts');
select is((select title from public.deals),'Deal B','tenant switching muda deals');
select is((select title from public.activities),'Atividade B','tenant switching muda activities');
select is((select count(*)::int from public.conversations),1,'tenant switching muda conversations');
select is((select content from public.messages),'B','tenant switching muda messages');
insert into public.contacts(tenant_id,name,status) values(private.get_active_tenant_id(),'Escrita Agent B','contact');
select is((select count(*)::int from public.contacts),2,'agent mantém escrita equivalente no tenant ativo');
reset role;

-- Cross-tenant writes are denied even while switched.
set local role authenticated;
select throws_ok(format('insert into public.contacts(tenant_id,name,status) values(%L,''Intruso'',''contact'')',(select tenant_id from public.profiles where id='91111111-1111-1111-1111-111111111111')),'42501',null,'escrita cross-tenant é bloqueada');
reset role;

-- Revoking only tenant B immediately denies every migrated domain, despite a
-- still-valid JWT naming B. It deliberately does not fall back to profile A.
update public.tenant_memberships set status='revoked',revoked_at=now()
where user_id='91111111-1111-1111-1111-111111111111'
  and tenant_id=(select tenant_id from public.profiles where id='92222222-2222-2222-2222-222222222222');
set local role authenticated;
select is(private.get_active_tenant_id(),null::uuid,'membership revogada invalida tenant selecionado');
select is((select count(*)::int from public.contacts),0,'revogação bloqueia contacts');
select is((select count(*)::int from public.deals),0,'revogação bloqueia deals');
select is((select count(*)::int from public.activities),0,'revogação bloqueia activities');
select is((select count(*)::int from public.conversations),0,'revogação bloqueia conversations');
select is((select count(*)::int from public.messages),0,'revogação bloqueia messages');
reset role;

-- Removing app_metadata restores the validated legacy fallback to tenant A.
set local request.jwt.claims='{"sub":"91111111-1111-1111-1111-111111111111","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.contacts),2,'fallback legado continua válido após limpar tenant selecionado');
select is((select count(*)::int from public.messages),1,'fallback legado restaura mensagens do profile tenant');

select * from finish();
rollback;
