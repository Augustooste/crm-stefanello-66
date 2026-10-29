-- Reproduz a ACL de produção: authenticated sem USAGE no schema private.
-- create_simulator_channel() precisa funcionar assim, sem afrouxar a autorização.
begin;
select plan(4);

set session_replication_role = replica;
insert into public.tenants(id, name) values
 ('f5000000-0000-4000-8000-000000000001', 'Simulação ACL produção');
insert into auth.users(id, email) values
 ('f5000000-0000-4000-8000-000000000011', 'acl-admin@test.invalid'),
 ('f5000000-0000-4000-8000-000000000013', 'acl-membro@test.invalid');
insert into public.profiles(id, tenant_id, name, role) values
 ('f5000000-0000-4000-8000-000000000011', 'f5000000-0000-4000-8000-000000000001', 'Admin', 'admin'),
 ('f5000000-0000-4000-8000-000000000013', 'f5000000-0000-4000-8000-000000000001', 'Membro', 'agent');
insert into public.roles(tenant_id, role_key, name, is_system) values
 ('f5000000-0000-4000-8000-000000000001', 'admin', 'Admin', true),
 ('f5000000-0000-4000-8000-000000000001', 'agent', 'Membro', true);
insert into public.role_permissions(role_id, permission_id)
 select r.id, p.id from public.roles r cross join public.permissions p
 where r.tenant_id = 'f5000000-0000-4000-8000-000000000001' and r.role_key = 'admin';
insert into public.tenant_memberships(tenant_id, user_id, role_id, status)
 select p.tenant_id, p.id, r.id, 'active' from public.profiles p join public.roles r
 on r.tenant_id = p.tenant_id and r.role_key = p.role
 where p.id in ('f5000000-0000-4000-8000-000000000011', 'f5000000-0000-4000-8000-000000000013');
set session_replication_role = default;

revoke usage on schema private from authenticated;
select ok(not has_schema_privilege('authenticated', 'private', 'USAGE'), 'Teste reproduz a ACL de produção');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-8000-000000000011","role":"authenticated"}', true);
select lives_ok('select public.create_simulator_channel()', 'Admin cria canal sem USAGE em private');
select throws_ok(
  $$select set_config('request.jwt.claims', '{"sub":"f5000000-0000-4000-8000-000000000013","role":"authenticated"}', true); select public.create_simulator_channel()$$,
  '42501', null, 'Membro sem papel admin continua bloqueado');
reset role;

select is(
  (select count(*)::int from public.channels
    where tenant_id = 'f5000000-0000-4000-8000-000000000001' and provider_slug = 'simulator'),
  1, 'Exatamente um canal simulador no tenant');

select * from finish();
rollback;
