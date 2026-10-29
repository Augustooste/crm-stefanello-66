begin;
create extension if not exists pgtap;
select plan(26);

select has_table('public','membership_audit_log','audit de membership existe');
select has_function('public','list_my_workspaces','lista segura de workspaces existe');
select has_function('public','get_my_permissions','lista de permissões existe');
select has_function('public','switch_active_workspace',array['uuid'],'troca server-side existe');
select has_function('public','manage_tenant_membership',array['uuid','uuid','text'],'lifecycle RPC existe');
select ok((select prosecdef from pg_proc where oid='public.switch_active_workspace(uuid)'::regprocedure),'switch é security definer');
select ok(not has_function_privilege('anon','public.switch_active_workspace(uuid)','EXECUTE'),'anon não troca workspace');
select ok(has_function_privilege('authenticated','public.switch_active_workspace(uuid)','EXECUTE'),'authenticated pode pedir troca validada');
select is((select count(*)::int from public.permissions where permission_key in ('tenant.settings.manage','crm.contacts.read','messaging.inbox.read','integrations.manage')),4,'catálogo granular foi expandido');

insert into auth.users(id,email) values
 ('b1111111-1111-4111-8111-111111111111','complete-a@test.local'),
 ('b2222222-2222-4222-8222-222222222222','complete-b@test.local');

-- Cross-membership B in tenant A as agent.
insert into public.tenant_memberships(tenant_id,user_id,role_id)
select p.tenant_id,'b2222222-2222-4222-8222-222222222222',r.id
from public.profiles p join public.roles r on r.tenant_id=p.tenant_id and r.role_key='agent'
where p.id='b1111111-1111-4111-8111-111111111111';

insert into public.boards(id,tenant_id,name)
select 'b3333333-3333-4333-8333-333333333331',tenant_id,'Board A' from public.profiles where id='b1111111-1111-4111-8111-111111111111';
insert into public.boards(id,tenant_id,name)
select 'b3333333-3333-4333-8333-333333333332',tenant_id,'Board B' from public.profiles where id='b2222222-2222-4222-8222-222222222222';

set local role authenticated;
set local request.jwt.claims='{"sub":"b2222222-2222-4222-8222-222222222222","role":"authenticated"}';
select is((select count(*)::int from public.list_my_workspaces()),2,'usuário lista duas memberships ativas');
select ok(private.has_permission('tenant.settings.manage'),'admin no workspace primário tem permissão administrativa');
select ok(public.switch_active_workspace((select tenant_id from public.list_my_workspaces() where role_key='agent')),'membership válida permite switch');
reset role;
select is((select raw_app_meta_data->>'active_tenant_id' from auth.users where id='b2222222-2222-4222-8222-222222222222'),(select tenant_id::text from public.profiles where id='b1111111-1111-4111-8111-111111111111'),'switch persiste somente app_metadata server-side');
select is((select count(*)::int from public.membership_audit_log where action='workspace.switched'),1,'switch é auditado');

-- Simulate refreshed JWT. Existing board policy still calls legacy helper, now
-- delegated to active membership, proving the remaining policies migrate.
select set_config('request.jwt.claims',jsonb_build_object('sub','b2222222-2222-4222-8222-222222222222','role','authenticated','app_metadata',jsonb_build_object('active_tenant_id',(select tenant_id from public.profiles where id='b1111111-1111-4111-8111-111111111111')))::text,true);
set local role authenticated;
select is((select name from public.boards),'Board A','policy legada de boards acompanha tenant ativo');
select ok(not private.has_permission('tenant.settings.manage'),'agent não herda permissão admin no workspace selecionado');
select ok(private.has_permission('crm.contacts.write'),'agent recebe permissão operacional granular');
select throws_ok('select public.switch_active_workspace(''00000000-0000-4000-8000-000000000000''::uuid)','42501','active membership required','switch para tenant arbitrário é negado');
reset role;

-- Admin A manages member B. Last-manager protection is enforced before any
-- demotion/revocation, then promotion supplies a second manager.
set local request.jwt.claims='{"sub":"b1111111-1111-4111-8111-111111111111","role":"authenticated"}';
set local role authenticated;
select throws_ok(format('select public.manage_tenant_membership(%L,null,''revoked'')',(select id from public.tenant_memberships where user_id='b1111111-1111-4111-8111-111111111111' and tenant_id=private.get_active_tenant_id())),'23514','cannot revoke or demote last membership manager','último gestor não pode ser revogado');
select lives_ok(format('select public.manage_tenant_membership(%L,%L,null)',(select id from public.tenant_memberships where user_id='b2222222-2222-4222-8222-222222222222' and tenant_id=private.get_active_tenant_id()),(select id from public.roles where tenant_id=private.get_active_tenant_id() and role_key='admin')),'admin pode promover outro membro');
select is((select r.role_key from public.tenant_memberships m join public.roles r on r.id=m.role_id where m.user_id='b2222222-2222-4222-8222-222222222222' and m.tenant_id=private.get_active_tenant_id()),'admin','promoção altera role granular');
select lives_ok(format('select public.manage_tenant_membership(%L,null,''revoked'')',(select id from public.tenant_memberships where user_id='b2222222-2222-4222-8222-222222222222' and tenant_id=private.get_active_tenant_id())),'membership pode ser revogada com outro gestor ativo');
select is((select status from public.tenant_memberships where user_id='b2222222-2222-4222-8222-222222222222' and tenant_id=private.get_active_tenant_id()),'revoked','revogação persiste status');
select is((select count(*)::int from public.membership_audit_log where action in ('membership.role_changed','membership.revoked')),2,'mudanças de lifecycle são auditadas');
reset role;

-- Invite lifecycle remains compatible: signup trigger creates profile and the
-- additive profile trigger creates active membership in the invited tenant.
insert into public.invites(tenant_id,email,role,token,expires_at)
select tenant_id,'invited-complete@test.local','agent','rbac-complete-token',now()+interval '1 day'
from public.profiles where id='b1111111-1111-4111-8111-111111111111';
insert into auth.users(id,email,raw_user_meta_data) values
 ('b4444444-4444-4444-8444-444444444444','invited-complete@test.local','{"invite_token":"rbac-complete-token"}');
select is((select count(*)::int from public.tenant_memberships where user_id='b4444444-4444-4444-8444-444444444444' and status='active'),1,'convite aceito cria membership ativa');
select is((select r.role_key from public.tenant_memberships m join public.roles r on r.id=m.role_id where m.user_id='b4444444-4444-4444-8444-444444444444'),'agent','convite preserva papel agent');

select * from finish();
rollback;
