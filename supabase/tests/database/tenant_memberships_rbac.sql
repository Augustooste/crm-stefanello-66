begin;
create extension if not exists pgtap;
select plan(47);

select has_table('public', 'tenant_memberships', 'tenant_memberships existe');
select has_table('public', 'roles', 'roles existe');
select has_table('public', 'permissions', 'permissions existe');
select has_table('public', 'role_permissions', 'role_permissions existe');
select has_column('public', 'profiles', 'tenant_id', 'profiles.tenant_id preservado');
select has_column('public', 'profiles', 'role', 'profiles.role preservado');
select col_is_unique('public', 'tenant_memberships', array['tenant_id','user_id'], 'membership única por tenant/user');
select col_is_unique('public', 'roles', array['tenant_id','role_key'], 'role key única por tenant');
select col_is_pk('public', 'role_permissions', array['role_id','permission_id'], 'grant é idempotente por PK');
select has_index('public', 'tenant_memberships', 'tenant_memberships_user_active_idx', 'lookup de memberships ativas indexado');
select ok((select relrowsecurity from pg_class where oid='public.tenant_memberships'::regclass), 'RLS em memberships');
select ok((select relrowsecurity from pg_class where oid='public.roles'::regclass), 'RLS em roles');
select ok((select relrowsecurity from pg_class where oid='public.permissions'::regclass), 'RLS em permissions');
select ok((select relrowsecurity from pg_class where oid='public.role_permissions'::regclass), 'RLS em role_permissions');
select has_function('private', 'get_active_tenant_id', 'resolver de tenant ativo existe');
select has_function('private', 'is_active_tenant_member', 'helper de membership existe');
select has_function('private', 'has_permission', array['text'], 'helper de permissão existe');
select ok((select prosecdef from pg_proc where oid='private.get_active_tenant_id()'::regprocedure), 'resolver é SECURITY DEFINER');
select ok((select prosecdef from pg_proc where oid='private.has_permission(text)'::regprocedure), 'permission helper é SECURITY DEFINER');
select ok((select proconfig is not null from pg_proc where oid='private.has_permission(text)'::regprocedure), 'permission helper fixa search_path');
select ok(not has_function_privilege('anon','private.get_active_tenant_id()','EXECUTE'), 'anon não resolve tenant');
select ok(has_function_privilege('authenticated','private.get_active_tenant_id()','EXECUTE'), 'authenticated resolve tenant validado');
select ok(not has_function_privilege('anon','private.has_permission(text)','EXECUTE'), 'anon não consulta permission');
select is((select count(*)::int from pg_policies where tablename='tenant_memberships' and cmd in ('INSERT','UPDATE','DELETE') and 'authenticated'=any(roles)), 0, 'authenticated não muta memberships diretamente');
select has_trigger('public', 'profiles', 'profiles_sync_tenant_membership', 'profile mantém membership compatível');

-- Creating users exercises the unchanged handle_new_user flow. The additive
-- AFTER trigger must provision tenant roles and membership without changing it.
insert into auth.users (id, email) values
 ('81111111-1111-1111-1111-111111111111', 'rbac-a@test.local'),
 ('82222222-2222-2222-2222-222222222222', 'rbac-b@test.local');

select is((select count(*)::int from public.tenant_memberships where user_id='81111111-1111-1111-1111-111111111111'), 1, 'signup cria membership');
select is((select count(*)::int from public.roles r join public.profiles p on p.tenant_id=r.tenant_id where p.id='81111111-1111-1111-1111-111111111111'), 2, 'signup provisiona admin/agent');
select is((select r.role_key from public.tenant_memberships m join public.roles r on r.id=m.role_id where m.user_id='81111111-1111-1111-1111-111111111111'), 'admin', 'primeiro usuário preserva papel admin');
select is((select count(*)::int from public.role_permissions rp join public.roles r on r.id=rp.role_id join public.profiles p on p.tenant_id=r.tenant_id where p.id='81111111-1111-1111-1111-111111111111' and r.role_key='admin'), (select count(*)::int from public.permissions), 'admin recebe o catálogo de permissions completo (invariante, não número fixo)');

set local role authenticated;
set local request.jwt.claims = '{"sub":"81111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is(private.get_active_tenant_id(), (select tenant_id from public.profiles where id='81111111-1111-1111-1111-111111111111'), 'sem claim usa tenant legado validado');
select ok(private.is_active_tenant_member(), 'membership ativa reconhecida');
select ok(private.has_permission('tenant.members.manage'), 'admin tem permission explícita');
select ok(not private.has_permission('unknown.permission'), 'permission inexistente nega acesso');
select is((select count(*)::int from public.tenant_memberships), 1, 'admin vê membros apenas do tenant ativo');
select is((select count(*)::int from public.roles), 2, 'admin vê roles apenas do tenant ativo');
reset role;

-- A signed-looking but unauthorized active_tenant_id cannot select another
-- tenant. The membership validation denies it instead of trusting the claim.
select set_config('request.jwt.claims', jsonb_build_object(
  'sub','81111111-1111-1111-1111-111111111111','role','authenticated',
  'app_metadata',jsonb_build_object('active_tenant_id',(select tenant_id from public.profiles where id='82222222-2222-2222-2222-222222222222'))
)::text, true);
set local role authenticated;
select is(private.get_active_tenant_id(), null::uuid, 'claim de tenant sem membership é rejeitada');
select ok(not private.has_permission('tenant.members.read'), 'claim arbitrária não concede permission');
select is((select count(*)::int from public.roles), 0, 'claim arbitrária não expõe roles cross-tenant');
reset role;

-- Legacy profile role remains the compatibility source and synchronizes RBAC.
-- Isola a variável testada aqui (profiles_sync_tenant_membership) das guardas
-- de autorização em enforce_profile_immutable_fields (cobertas em outros
-- specs); sem sessão authenticated de admin aqui, a guarda sempre bloquearia
-- o UPDATE antes do trigger de sync sequer rodar. O trigger duplicado legado
-- profiles_enforce_immutable_fields foi dropado (migration 20260722130000);
-- resta trg_enforce_profile_immutable_fields, que desabilitamos aqui.
alter table public.profiles disable trigger trg_enforce_profile_immutable_fields;
update public.profiles set role='agent' where id='81111111-1111-1111-1111-111111111111';
alter table public.profiles enable trigger trg_enforce_profile_immutable_fields;
select is((select r.role_key from public.tenant_memberships m join public.roles r on r.id=m.role_id where m.user_id='81111111-1111-1111-1111-111111111111'), 'agent', 'mudança legada sincroniza role');
select set_config('request.jwt.claims','{"sub":"81111111-1111-1111-1111-111111111111","role":"authenticated"}',true);
set local role authenticated;
select ok(not private.has_permission('tenant.members.read'), 'agent sem grants é negado');
-- Movido pra cá (membership ainda ativa): private.get_user_tenant_id() delega
-- pra get_active_tenant_id(), que exige membership 'active' -- rodar esta
-- checagem DEPOIS da revogação abaixo sempre dá NULL (não é mais igual a
-- profiles.tenant_id), então precisa vir antes.
select is((select tenant_id from public.profiles where id='81111111-1111-1111-1111-111111111111'), private.get_user_tenant_id(), 'get_user_tenant_id legado preservado em contexto service (membership ainda ativa)');
reset role;

-- Revocation immediately invalidates the new resolver/helpers even with a
-- still-valid JWT. Legacy policies are intentionally not migrated in this PR.
update public.tenant_memberships set status='revoked', revoked_at=now()
where user_id='81111111-1111-1111-1111-111111111111';
set local role authenticated;
select is(private.get_active_tenant_id(), null::uuid, 'revogação invalida tenant ativo imediatamente');
select ok(not private.is_active_tenant_member(), 'revogação remove membership efetiva');
select ok(not private.has_permission('tenant.members.read'), 'revogação remove permissions imediatamente');
reset role;

-- Compatibility fields are unchanged by the revocation above (a raw UPDATE
-- on tenant_memberships, sem passar por manage_tenant_membership()): a coluna
-- legada profiles.tenant_id não é apagada/zerada, mesmo que o resolver
-- membership-aware (get_user_tenant_id/get_active_tenant_id) já retorne NULL
-- pra este usuário (provado acima em "revogação invalida tenant ativo").
select isnt((select tenant_id from public.profiles where id='81111111-1111-1111-1111-111111111111'), null, 'profiles.tenant_id (legado) não é apagado pela revogação da membership');
select is((select role from public.profiles where id='81111111-1111-1111-1111-111111111111'), 'agent', 'profile role legado permanece íntegro');

-- Check same-tenant FK: a role from tenant B cannot be assigned to tenant A.
select throws_ok(
  format('update public.tenant_memberships set role_id=%L where user_id=%L',
    (select r.id from public.roles r join public.profiles p on p.tenant_id=r.tenant_id where p.id='82222222-2222-2222-2222-222222222222' and r.role_key='agent'),
    '81111111-1111-1111-1111-111111111111'),
  '23503', null, 'role de outro tenant é rejeitada por FK composta'
);

select * from finish();
rollback;
